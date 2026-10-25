// Unfinished conversation tasks wake the Bot that owns them (#1109). The board
// stays the one in tasks.js: this module only decides when an idle Session should
// continue the task track_tasks would name next. A wake is a follow-up in that
// Session, never a post into the group, so the driver does not open a round.
import { compareForWork } from '../shared/task-board.js'

// A no-op track_tasks call still bumps updatedAt. The hash leaves that stamp out,
// so a wake that did not move the board waits before the next one.
export const TASK_DRIVE_BACKOFF_MS = [30_000, 120_000, 600_000, 1_800_000]

const DRIVING = new Set(['open', 'claimed', 'working'])

const fingerprint = (tasks) => tasks.map(task => [
  task.id,
  task.status,
  task.progress ?? 0,
  task.priority ?? 'normal',
  task.waitingFor ?? '',
  task.note ?? '',
  task.title ?? '',
].join('\u0000')).sort().join('\u0001')

const cueFor = (task) => {
  const title = String(task.title ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, 200)
  const priority = task.priority ?? 'normal'
  return `Continue ${task.id} [${priority}] ${title}. Do this task now. Update it with track_tasks as it moves. Stop when it is done or waiting on an answer. Do not invent other work or start a group round.`
}

const messageText = (message) => (Array.isArray(message?.content) ? message.content : []).map(block => block?.text ?? '').join('\n')

const taskMessages = (agent) => [...(agent?.inbox?.nextTurn ?? []), ...(agent?.inbox?.nextStep ?? [])]
  .filter(message => message?.source?.role === 'task')

// The cue names one task. A later board write that makes a different task next
// replaces a wake that has not started; a note on the same task does not.
const namesTask = (message, taskId) => messageText(message).includes(`Continue ${taskId} `)

export function install(rt) {
  const { ctx } = rt
  /** @type {Map<string, {fingerprint: string, started: boolean}>} */
  const inflight = new Map()
  /** @type {Map<string, {until: number, fingerprint: string}>} */
  const held = new Map()
  /** @type {Map<string, number>} */
  const misses = new Map()
  const clock = { now: () => Date.now() }
  let tail = Promise.resolve()

  const drivingTasks = (botId) => {
    if (!botId) return []
    const bot = rt.botOf(botId)
    if (!bot || bot.remote !== undefined) return []
    return Object.values(rt.state.tasks ?? {}).filter(task =>
      task.ownerBotId === botId
      && task.source === 'conversation'
      && task.kind !== 'group'
      && task.waitingFor !== 'input'
      && DRIVING.has(task.status))
  }

  const roundLive = (roomId) => {
    for (const round of rt.roomProgress?.values() ?? []) {
      if (round?.roomId === roomId) return true
    }
    return false
  }

  const ownsSession = (task, sessionId) => {
    const roomId = task.origin?.roomId
    if (!roomId) return rt.chatOf(task.ownerBotId) === sessionId
    return rt.roomOf(roomId)?.sessions?.[task.ownerBotId] === sessionId
  }

  // The group Session when this Bot already has one there, or a new one when the
  // subtask is the first thing it does in that group. A live round waits: the
  // driver must not add a member turn beside the round.
  const sessionFor = async (task) => {
    const roomId = task.origin?.roomId
    if (!roomId) {
      const id = rt.chatOf(task.ownerBotId)
      return id && !rt.roomOf(id) ? id : undefined
    }
    const room = rt.roomOf(roomId)
    if (!room || room.origin === 'face-to-face') return undefined
    if (!(room.members ?? []).includes(task.ownerBotId)) return undefined
    if (roundLive(room.id)) return undefined
    const existing = room.sessions?.[task.ownerBotId]
    if (existing) return existing
    if (typeof rt.memberSession !== 'function') return undefined
    try {
      return await rt.memberSession(room, task.ownerBotId)
    } catch (error) {
      rt.warn('ds-bot: task drive could not open a group session for %s: %s', task.ownerBotId, error)
      return undefined
    }
  }

  // `live` is cleared before the turn-end hook runs. The Agent's status can still
  // say running for that moment; a follow-up queues behind it, so status is not a gate.
  const busy = (sessionId) => rt.liveOf?.(sessionId)?.turn !== undefined

  const dropQueued = (agent) => {
    let kept = false
    for (const message of taskMessages(agent)) {
      if (message.id !== undefined && agent.inbox.remove?.(message.id)) continue
      kept = true
    }
    return !kept
  }

  // A queued wake whose task is gone, or whose group is in a round, is pulled
  // back before it can start. A wake that already started is left to finish.
  const releaseStale = async (sessionId) => {
    const job = inflight.get(sessionId)
    if (!job || job.started) return
    const owner = rt.groupOwners.get(sessionId)
    const botId = owner?.botId ?? rt.selfOf(sessionId)
    const round = owner !== undefined && roundLive(owner.roomId)
    const still = !round && drivingTasks(botId).some(task => ownsSession(task, sessionId))
    if (still) return
    const agent = await rt.resolveAgent(sessionId).catch(() => undefined)
    if (!dropQueued(agent)) return
    inflight.delete(sessionId)
  }

  const noteMiss = (sessionId, fp) => {
    const count = (misses.get(sessionId) ?? 0) + 1
    misses.set(sessionId, count)
    const delay = TASK_DRIVE_BACKOFF_MS[Math.min(count - 1, TASK_DRIVE_BACKOFF_MS.length - 1)]
    held.set(sessionId, { until: clock.now() + delay, fingerprint: fp })
  }

  const clearMiss = (sessionId) => {
    misses.delete(sessionId)
    held.delete(sessionId)
  }

  async function driveOnce() {
    await rt.load()
    const sessions = Array.from(inflight.keys())
    for (const sessionId of sessions) await releaseStale(sessionId)
    const byBot = new Map()
    for (const task of Object.values(rt.state.tasks ?? {})) {
      const list = drivingTasks(task.ownerBotId)
      if (!list.includes(task)) continue
      byBot.set(task.ownerBotId, list)
    }
    // One pass wakes every owner. A group assignment starts each member's own
    // subtask in that same drive, in that member's Session. One Bot still gets
    // only the task compareForWork names next, and a Session that already has
    // a turn is left until that turn ends.
    for (const [botId, owned] of byBot) {
      const list = owned.slice().sort(compareForWork)
      const next = list[0]
      const sessionId = await sessionFor(next)
      if (!sessionId) continue
      if (inflight.get(sessionId)?.started) continue
      const fp = fingerprint(list)
      const hold = held.get(sessionId)
      if (hold && hold.fingerprint !== fp) clearMiss(sessionId)
      else if (hold && clock.now() < hold.until) continue
      let agent
      try {
        agent = await rt.resolveAgent(sessionId)
      } catch (error) {
        rt.warn('ds-bot: task drive could not reach %s: %s', sessionId, error)
        continue
      }
      if (busy(sessionId)) continue
      const pending = taskMessages(agent)
      // The same task is already queued: keep that one wake and remember the
      // board as it is now, so a note written before the turn is not progress.
      if (pending.some(message => namesTask(message, next.id))) {
        inflight.set(sessionId, { fingerprint: fp, started: false })
        continue
      }
      if (pending.length > 0 && !dropQueued(agent)) {
        inflight.set(sessionId, { fingerprint: fp, started: false })
        continue
      }
      inflight.set(sessionId, { fingerprint: fp, started: false })
      try {
        await rt.deliver({ toId: botId, sessionId, role: 'task', text: cueFor(next) })
      } catch (error) {
        inflight.delete(sessionId)
        rt.warn('ds-bot: task drive could not wake %s: %s', botId, error)
      }
    }
  }

  function consider() {
    const run = tail.then(() => driveOnce()).catch(error => {
      rt.warn('ds-bot: task drive failed: %s', error)
    })
    tail = run
    return run
  }

  rt.considerTaskDrive = consider
  rt.noteTaskDriveTrigger = (sessionId, info) => {
    if (info?.role !== 'task') return
    const job = inflight.get(sessionId)
    if (job) job.started = true
  }
  rt.noteTaskDriveTurnEnded = (sessionId, { retry = false } = {}) => {
    const job = inflight.get(sessionId)
    if (retry && job?.started) return undefined
    if (job?.started) {
      inflight.delete(sessionId)
      const fp = fingerprint(drivingTasks(rt.selfOf(sessionId)))
      if (fp === job.fingerprint) noteMiss(sessionId, fp)
      else clearMiss(sessionId)
    }
    return consider()
  }

  // A person speaking in the Session ends a no-progress wait. The turn that is
  // starting does the talking; the next idle moment can continue the board.
  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'user/message') return
    if (event.data?.source?.kind === 'user') clearMiss(session?.id)
  })

  ctx.taskDrive = {
    get now() { return clock.now },
    set now(fn) { clock.now = fn },
    settled: () => tail,
    consider: () => consider(),
  }
}
