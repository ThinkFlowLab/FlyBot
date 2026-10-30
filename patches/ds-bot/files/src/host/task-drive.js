// Unfinished conversation tasks wake the Bot that owns them (#1109). The board
// stays the one in tasks.js: this module only decides when an idle Session should
// continue the task track_tasks would name next. Every wake, including a group
// subtask, is a follow-up in that Bot's own chat (#1205). The driver does not
// open a group Session and does not post the reply into the room. Assigning,
// progress, and the next assignee are board writes; chat is not the scheduler.
import { compareForQueue, compareForWork, occupiesSlot, sameRole } from '../shared/task-board.js'
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

// A queue item is offered, not owned: this cue names the item and the claim, never its note —
// the note is the body, and reading it is the turn's job, not the wake's (#1247).
const queueCueFor = (task) => {
  const title = String(task.title ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, 200)
  const priority = task.priority ?? 'normal'
  return `Take ${task.id} [${priority}] ${title} — queued for ${task.queueRole}. Claim it with track_tasks {claim: true, id: '${task.id}'}, then set its column to in-progress. Do not post a status in the group. Stop when it is done or waiting on an answer. Do not invent other work.`
}

// What the queue pass compares between passes: an item nobody claimed is still the same offer.
const queueFingerprint = (task) => (task === undefined ? '' : [
  task.id,
  task.status,
  task.priority ?? 'normal',
  task.claimedBy ?? '',
  task.retryAt ?? '',
  task.note ?? '',
  task.title ?? '',
].join('\u0000'))

const cueFor = (task) => {
  const title = String(task.title ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, 200)
  const priority = task.priority ?? 'normal'
  const post = task.writeBack?.state === 'pending'
    ? ` Then post the decision comment on ${task.writeBack.target} with your GitHub connector and record it with track_tasks postResult {task: '${task.id}', ok: true}, or ok: false with the error.`
    : ''
  const head = `Continue ${task.id} [${priority}] ${title}. Do this task now.`
  const stop = 'Stop when it is done or waiting on an answer. Do not invent other work'
  if (task.origin?.roomId) {
    return `${head} Taking it and moving it are board writes: set this card's column and progress with track_tasks, and do not post a status in the group. ${stop} or record a new plan. This card is already yours: set its column to in-progress and start the work, and do not wait for a confirmation. Update the note on the card as it moves. The group stays quiet. If a person has to decide, post one short question in the group; do not @ a Bot to hand the work on. Completing or updating this card wakes the next assignee.${post}`
  }
  return `${head} Set this card's column and progress with track_tasks as it moves. ${stop} or start a group round.${post}`
}

const messageText = (message) => (Array.isArray(message?.content) ? message.content : []).map(block => block?.text ?? '').join('\n')

// A wake is role `task` in the Bot's own chat, including a group card (#1205).
// A room turn left from an older driver (`taskDrive`) still counts, so a board
// write does not queue a second wake beside one that has not started.
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
      // An item with a role and no claimer belongs to the room, not to this Bot: the enqueuer
      // must not be woken for its own item (#1247). A claimed one names the member and is
      // driven above like any other card.
      if (task.queueRole && !task.claimedBy) return false
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

  // The wake always lands in the owner's own chat. A group card still has to
  // name a member of that room; a face-to-face room has no board.
  const ownsSession = (task, sessionId) => {
    const chat = rt.chatOf(task.ownerBotId)
    return chat === sessionId && !rt.roomOf(sessionId)
  }

  const sessionFor = (task) => {
    const roomId = task.origin?.roomId
    if (roomId) {
      const room = rt.roomOf(roomId)
      if (!room || room.origin === 'face-to-face') return undefined
      if (!(room.members ?? []).includes(task.ownerBotId)) return undefined
    }
    const id = rt.chatOf(task.ownerBotId)
    return id && !rt.roomOf(id) ? id : undefined
  }

  // `live` is cleared before the turn-end hook runs. The Agent's status can still
  // say running for that moment; a follow-up queues behind it, so status is not a gate.
  const busy = (sessionId) => rt.liveOf?.(sessionId)?.turn !== undefined

  // WIP = 1, the rule `claimQueued` enforces (#1247): a member already working a card cannot take a
  // queued item. A blocked card waits on a person, and a delivered card waits on its requester, so
  // neither counts (#1744) — waking that member would spend a turn on a refusal it should not get,
  // and leave the item behind a card that is no longer work. Same predicate, one board.
  const holdsCard = (botId) => Object.values(rt.state.tasks ?? {})
    .some(task => task.ownerBotId === botId && occupiesSlot(task))

  // A wake this Session already has: one the pass counted (`inflight`), or one still waiting in
  // the inbox — after a restart the count is gone and the message is not (#1247).
  const wakeWaiting = (sessionId, agent) => inflight.has(sessionId) || taskMessages(agent).length > 0

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
    const queued = job.queue !== undefined && (() => {
      const task = rt.state.tasks?.[job.queue]
      return Boolean(task && task.queueRole && !task.claimedBy && task.status === 'open')
    })()
    const still = !round && (drivingTasks(botId).some(task => ownsSession(task, sessionId)) || queued)
    if (still) return
    const agent = await rt.resolveAgent(sessionId).catch(() => undefined)
    if (!dropQueued(agent)) return
    inflight.delete(sessionId)
  }

  const noteMiss = (sessionId, fp, kind = 'work') => {
    const count = (misses.get(sessionId) ?? 0) + 1
    misses.set(sessionId, count)
    const delay = TASK_DRIVE_BACKOFF_MS[Math.min(count - 1, TASK_DRIVE_BACKOFF_MS.length - 1)]
    held.set(sessionId, { until: clock.now() + delay, fingerprint: fp, kind })
  }

  // Only the pass that set the hold may clear it: the queue pass and the work pass compare
  // different fingerprints, so without the kind each would wipe the other's wait (#1247).
  const clearMiss = (sessionId, kind) => {
    const hold = held.get(sessionId)
    if (kind !== undefined && hold !== undefined && hold.kind !== kind) return
    misses.delete(sessionId)
    held.delete(sessionId)
  }
  const heldFor = (sessionId, kind) => {
    const hold = held.get(sessionId)
    return hold !== undefined && hold.kind === kind ? hold : undefined
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
    // One pass wakes every owner, in that owner's own chat. A group assignment
    // starts each assignee there in the same drive and does not open a round.
    // One Bot still gets only the task compareForWork names next, and a Session
    // that already has a turn is left until that turn ends.
    for (const [botId, owned] of byBot) {
      const list = owned.slice().sort(compareForWork)
      const next = list[0]
      const sessionId = await sessionFor(next)
      if (!sessionId) continue
      if (inflight.get(sessionId)?.started) continue
      const fp = fingerprint(list)
      const hold = heldFor(sessionId, 'work')
      if (hold && hold.fingerprint !== fp) clearMiss(sessionId, 'work')
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
        // Own chat, even for a group card (#1205). The reply is not a room turn,
        // so it is not posted into the group when the turn ends. noteWake counts
        // only a wake that left (#1172). The board snapshot is the progress.
        const board = roomId
          ? formatRoomBoard(rt.state.tasks, { roomId, nameOf: task => rt.botOf(task.ownerBotId)?.name })
          : ''
        await rt.deliver({
          toId: botId,
          sessionId,
          role: 'task',
          text: board ? `${cueFor(next)}\n\n${board}` : cueFor(next),
        })
        await noteWake(next)
      } catch (error) {
        inflight.delete(sessionId)
        rt.warn('ds-bot: task drive could not wake %s: %s', botId, error)
      }
    }
    await offerQueue()
  }

  // The pull wake (#1247): an unclaimed item wakes one idle member of its role in that member's
  // own chat. One offer per room and role per pass — a queue of five must not start five turns —
  // and one member, so the item is pulled by one person instead of broadcast to the whole role.
  // The item's age is on the board; this pass adds no second presence block.
  async function offerQueue() {
    const byRoomRole = new Map()
    for (const task of Object.values(rt.state.tasks ?? {})) {
      if (!task?.queueRole || task.claimedBy || task.status !== 'open') continue
      const roomId = task.origin?.roomId
      const room = roomId ? rt.roomOf(roomId) : undefined
      if (!room || room.origin === 'face-to-face') continue
      if (Number.isFinite(task.retryAt) && task.retryAt > clock.now()) continue
      const key = `${roomId}\u0000${String(task.queueRole).toLowerCase()}`
      const list = byRoomRole.get(key) ?? []
      list.push(task)
      byRoomRole.set(key, list)
    }
    for (const list of byRoomRole.values()) {
      const item = list.slice().sort(compareForQueue)[0]
      const room = rt.roomOf(item.origin.roomId)
      const carriers = (room?.members ?? [])
        .filter(id => { const bot = rt.botOf(id); return Boolean(bot) && bot.remote === undefined && sameRole(bot.role, item.queueRole) })
      for (const botId of carriers) {
        const sessionId = rt.chatOf(botId)
        if (!sessionId || rt.roomOf(sessionId)) continue
        // A member that cannot claim is not the carrier: the offer moves down the role.
        if (holdsCard(botId)) continue
        if (busy(sessionId)) continue
        const fp = queueFingerprint(item)
        const hold = heldFor(sessionId, 'queue')
        if (hold && hold.fingerprint !== fp) clearMiss(sessionId, 'queue')
        else if (hold && clock.now() < hold.until) continue
        let agent
        try {
          agent = await rt.resolveAgent(sessionId)
        } catch (error) {
          rt.warn('ds-bot: task drive could not reach %s: %s', sessionId, error)
          continue
        }
        if (busy(sessionId)) continue
        // One Session, one task wake per pass (#1247): the work pass above may already have woken
        // this Session, and a wake may still wait in its inbox. A second `[Continue task]` in the
        // same turn contradicts the first, and the item is offered next pass instead.
        if (wakeWaiting(sessionId, agent)) continue
        inflight.set(sessionId, { fingerprint: fp, started: false, queue: item.id })
        try {
          await rt.deliver({ toId: botId, sessionId, role: 'task', text: queueCueFor(item) })
        } catch (error) {
          inflight.delete(sessionId)
          rt.warn('ds-bot: task drive could not offer %s to %s: %s', item.id, botId, error)
          // The cue did not leave, so this member is not the carrier: try the next one.
          continue
        }
        break
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
      const kind = job.queue !== undefined ? 'queue' : 'work'
      const fp = kind === 'queue' ? queueFingerprint(rt.state.tasks?.[job.queue]) : fingerprint(drivingTasks(rt.selfOf(sessionId)))
      if (fp === job.fingerprint) noteMiss(sessionId, fp, kind)
      else clearMiss(sessionId, kind)
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
