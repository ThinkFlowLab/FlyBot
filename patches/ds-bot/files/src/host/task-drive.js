// Unfinished conversation tasks wake the Bot that owns them (#1109). The board
// stays the one in tasks.js: this module only decides when an idle Session should
// continue the task track_tasks would name next. An own-chat task is a follow-up
// in that chat. A group subtask is a turn in that Bot's group Session (#1182):
// the reply is posted into the room when the turn ends, and the driver does not
// open a round of its own.
import { compareForWork } from '../shared/task-board.js'
import { formatRoomBoard } from './room-context.js'

// A no-op track_tasks call still bumps updatedAt. The hash leaves that stamp out,
// so a wake that did not move the board waits before the next one.
export const TASK_DRIVE_BACKOFF_MS = [30_000, 120_000, 600_000, 1_800_000]

// A decision whose comment nobody posts would otherwise wake its Bot on every backoff cycle, for
// ever: two wakes (the first, then one reminder), and after a day the record says `unconfirmed`
// instead of counting as work (#1172).
export const WRITE_BACK_WAKES = 2
export const WRITE_BACK_EXPIRY_MS = 24 * 60 * 60 * 1000

const DRIVING = new Set(['open', 'claimed', 'working'])

const fingerprint = (tasks) => tasks.map(task => [
  task.id,
  task.status,
  task.progress ?? 0,
  task.priority ?? 'normal',
  task.waitingFor ?? '',
  task.note ?? '',
  task.title ?? '',
  task.writeBack ? `${task.writeBack.state}:${task.writeBack.target}` : '',
].join('\u0000')).sort().join('\u0001')

const cueFor = (task) => {
  const title = String(task.title ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, 200)
  const priority = task.priority ?? 'normal'
  const post = task.writeBack?.state === 'pending'
    ? ` Then post the decision comment on ${task.writeBack.target} with your GitHub connector and record it with track_tasks postResult {task: '${task.id}', ok: true}, or ok: false with the error.`
    : ''
  const lead = `Continue ${task.id} [${priority}] ${title}. Do this task now. Update it with track_tasks as it moves. Stop when it is done or waiting on an answer. Do not invent other work`
  if (task.origin?.roomId) {
    return `${lead} or record a new plan. This card is already yours: start the work and do not wait for a confirmation. If you need an answer, ask that one question in your reply here, never in your own chat.${post}`
  }
  return `${lead} or start a group round.${post}`
}

const messageText = (message) => (Array.isArray(message?.content) ? message.content : []).map(block => block?.text ?? '').join('\n')

// An own-chat wake is role `task`. A group wake is a room turn (`taskDrive`), so
// the same inbox check has to see it or the next board write queues a second one.
const taskMessages = (agent) => [...(agent?.inbox?.nextTurn ?? []), ...(agent?.inbox?.nextStep ?? [])]
  .filter(message => message?.source?.role === 'task' || message?.source?.taskDrive === true)

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
    return Object.values(rt.state.tasks ?? {}).filter((task) => {
      if (task.ownerBotId !== botId || task.waitingFor === 'input') return false
      // A decision waiting to be posted is work even when the task is accepted: the Bot holds the
      // connector, so the comment goes out on its next turn (#1154). The reminder stops after two
      // wakes (#1172) — a Bot that never posts must not be woken for ever. The status path below is
      // not capped: the cap silences the reminder, never the task's own work.
      if (task.writeBack?.state === 'pending' && (task.writeBack.wakes ?? 0) < WRITE_BACK_WAKES) return true
      return task.source === 'conversation' && task.kind !== 'group' && DRIVING.has(task.status)
    })
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

  // Only a wake that actually left for a pending decision counts (#1172): a hold that never delivered
  // the reminder must not spend the Bot's two wakes. The count lives on the record so it survives a
  // restart, and the save is best effort — a lost count costs one reminder, never a turn.
  const noteWake = async (task) => {
    const back = task.writeBack
    if (back?.state !== 'pending') return
    task.writeBack = { ...back, wakes: (back.wakes ?? 0) + 1 }
    await rt.save().catch(error => rt.warn('ds-bot: the decision wake count was not saved: %s', error))
  }

  // A comment nobody posted stops being work after a day (#1172). The record turns `unconfirmed`
  // before the drive builds its list, so the same pass already stops counting it; the decision itself
  // stays recorded and the card says why the comment is missing. One save for the whole pass.
  const expireWriteBacks = async () => {
    let changed = false
    for (const task of Object.values(rt.state.tasks ?? {})) {
      const back = task.writeBack
      if (back?.state !== 'pending') continue
      const at = Number(back.at)
      if (!Number.isFinite(at) || clock.now() - at < WRITE_BACK_EXPIRY_MS) continue
      task.writeBack = { ...back, state: 'unconfirmed' }
      changed = true
    }
    if (changed) await rt.save().catch(error => rt.warn('ds-bot: the expired decision was not saved: %s', error))
    return changed
  }

  async function driveOnce() {
    await rt.load()
    await expireWriteBacks()
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
      const roomId = next.origin?.roomId
      try {
        // A group card is a room turn: the reply posts into the group when the
        // turn ends (turns.js, no waiter), so a question stays there (#1182).
        // noteWake counts only a wake that left, including this room turn (#1172).
        const board = roomId
          ? formatRoomBoard(rt.state.tasks, { roomId, nameOf: task => rt.botOf(task.ownerBotId)?.name })
          : ''
        await rt.deliver({
          toId: botId,
          sessionId,
          role: roomId ? 'room' : 'task',
          text: board ? `${cueFor(next)}\n\n${board}` : cueFor(next),
          ...(roomId ? { roomId, note: 'your task', taskDrive: true } : {}),
        })
        await noteWake(next)
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
    if (info?.role !== 'task' && info?.taskDrive !== true) return
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

  // A live Cordis context refuses `ctx.taskDrive = …` once the plugin fiber is
  // active (`cannot set property "taskDrive" without provide`). Same order as
  // provideFlyBot: provide, then reflect.provide, then set, then a plain write.
  const api = {
    get now() { return clock.now },
    set now(fn) { clock.now = fn },
    settled: () => tail,
    consider: () => consider(),
  }
  const provide = typeof ctx.provide === 'function' ? ctx.provide.bind(ctx) : typeof ctx.reflect?.provide === 'function' ? ctx.reflect.provide.bind(ctx.reflect) : undefined
  if (provide) {
    provide('taskDrive', api)
    return
  }
  if (typeof ctx.set === 'function') {
    try {
      ctx.set('taskDrive', api)
      return
    } catch { /* the key is refused: fall through to the plain property */ }
  }
  ctx.taskDrive = api
}
