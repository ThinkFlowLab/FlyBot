// Tasks (#54): a tracked request with a stable id and a small state machine, so
// responsibilities and completion are visible beyond chat text. Team mode stays
// disabled: this is the task-record foundation the later team gates build on
// (docs/subsystems/team.md) — in the single-human product every transition is the
// requester's; with member sessions only the requester's own may move their task,
// and the record carries server-derived authority, never body claims (#52 rule).
//
// Create is grant-aware: the requester need not own the Bot. A granted child (or a
// Bot in the named room the requester currently sits in) may take a task within
// its authority. Outgoing holds stay the owner's (#52 card).
//
// States: open → claimed → working → blocked ⇄ working → result-ready → accepted;
// A returned result may also be cancelled before acceptance. Cancelled and failed
// are terminal, and accepted is reachable only from result-ready. A cancelled or
// failed task never becomes accepted. Records keep pointers and a summary, not transcripts.
import { randomBytes } from 'node:crypto'
import { currentParticipants } from './room-membership.js'

const ACTIVE = new Set(['open', 'claimed', 'working', 'blocked'])
// result-ready still waits for the requester: prune must not evict it with terminals (#111).
const PROTECTED = new Set([...ACTIVE, 'result-ready'])
const TRANSITIONS = {
  open: ['claimed', 'cancelled', 'failed'],
  claimed: ['working', 'cancelled', 'failed'],
  working: ['blocked', 'result-ready', 'cancelled', 'failed'],
  blocked: ['working', 'cancelled', 'failed'],
  'result-ready': ['accepted', 'cancelled'],
  accepted: [],
  cancelled: [],
  failed: [],
}
const KEPT = 200

const stale = message => Object.assign(new Error(message), { code: 'bot/stale' })
const forbidden = message => Object.assign(new Error(message), { code: 'bot/forbidden' })

export function install(rt) {
  const { state } = rt
  state.tasks ??= {}

  const store = () => {
    state.tasks ??= {}
    return state.tasks
  }
  // The requester is the human whose task this is: the signed-in actor, or the one
  // owner of a host nobody has signed in on. Derived, never a body claim.
  const requesterOf = actor => actor?.memberId ?? Object.keys(state.members ?? {})[0] ?? null
  const mayAct = (task, actor) => {
    if (!rt.authzEnforced?.()) return true
    return actor !== null && actor !== undefined && task.requesterId === actor.memberId
  }
  const find = id => store()[String(id ?? '')]
  // Only the record's own requesters may move their tasks; the responsible Bot is
  // checked at create time (owner, grant, or shared-room membership).
  const requireRequester = (task, actor) => {
    if (!mayAct(task, actor)) throw forbidden('Only the requester may move their task')
  }

  // Owner, a matching grant, or a current human in the named room with that Bot.
  const mayCreateOn = (bot, actor, roomId) => {
    if (!rt.authzEnforced?.()) return true
    const requesterId = actor?.memberId
    if (!requesterId) return false
    if (bot.ownerId === requesterId) return true
    if (rt.hasGrant?.(bot.id, requesterId, roomId) || rt.hasGrant?.(bot.id, requesterId)) return true
    if (!roomId) return false
    const room = state.rooms?.[String(roomId)]
    if (room === undefined) return false
    const live = currentParticipants(room)
    return live.some(p => p.kind === 'human' && p.id === requesterId)
      && live.some(p => p.kind === 'bot' && !p.remote && p.id === bot.id)
  }

  function transition(task, to, actor, extra) {
    if (!TRANSITIONS[task.status]?.includes(to)) throw stale(`a task that is ${task.status} cannot become ${to}`)
    task.status = to
    task.updatedAt = Date.now()
    task.actors.push({ status: to, at: task.updatedAt, ...(actor?.memberId ? { memberId: actor.memberId } : {}), ...extra })
  }

  const view = task => ({ ...task, actors: [...task.actors ?? []] })
  const prune = () => {
    const all = Object.values(store())
    const droppable = all.filter(task => !PROTECTED.has(task.status)).sort((a, b) => a.updatedAt - b.updatedAt)
    for (const task of droppable.slice(0, Math.max(0, all.length - KEPT))) delete store()[task.id]
  }
  const save = () => rt.save()

  // ---------------------------------------------------------------- host hooks
  // Name the working task a send belongs to so a hold can block that one (#111).
  // Prefer an already-stamped `meta.taskId`; else the Bot's only working task;
  // else the one whose origin matches this send's session/room; else the most
  // recently started. Clarification / workBotId still wait on #55.
  rt.taskIdForSend = (msg) => {
    const from = msg?.from
    if (typeof from !== 'string') return undefined
    const ofSender = task => task.ownerBotId === from || task.workBotId === from
    const given = typeof msg?.meta?.taskId === 'string' ? msg.meta.taskId : undefined
    if (given) {
      const named = store()[given]
      if (named && named.status === 'working' && ofSender(named)) return given
    }
    const working = Object.values(store()).filter(task => task.status === 'working' && ofSender(task))
    if (working.length === 0) return undefined
    if (working.length === 1) return working[0].id
    const sessionId = typeof msg?.meta?.sessionId === 'string' ? msg.meta.sessionId : undefined
    const roomId = typeof msg?.meta?.roomId === 'string' ? msg.meta.roomId : rt.roomOf?.(sessionId)?.id
    const matched = working.filter(task =>
      (roomId && task.origin?.roomId === roomId) || (sessionId && task.origin?.sessionId === sessionId))
    if (matched.length === 1) return matched[0].id
    return [...(matched.length ? matched : working)].sort((a, b) => b.updatedAt - a.updatedAt)[0].id
  }

  // A consequential send from the responsible Bot was held (#52 card): the task
  // blocks on that approval until the owner decides. Link one task, not every
  // working task of that Bot: `meta.taskId` names it, else the Bot's only working
  // task (several without a name stay working — they are not this send's) (#111).
  rt.taskHeld = (msg, approval) => {
    const namedId = typeof msg?.meta?.taskId === 'string' ? msg.meta.taskId : undefined
    const named = namedId ? store()[namedId] : undefined
    const ofSender = task => task.ownerBotId === msg.from || task.workBotId === msg.from
    const working = Object.values(store()).filter(task => task.status === 'working' && ofSender(task))
    const targets = named && named.status === 'working' && ofSender(named)
      ? [named]
      : working.length === 1 ? working : []
    for (const task of targets) {
      task.approvalId = approval.id
      transition(task, 'blocked', null, { approvalId: approval.id })
    }
    return save()
  }
  // The owner's decision on that approval resumes the task — or, on reject, ends it.
  rt.taskDecided = (approval, decision) => {
    for (const task of Object.values(store())) {
      if (task.status !== 'blocked' || task.approvalId !== approval.id) continue
      delete task.approvalId
      transition(task, decision === 'approve' ? 'working' : 'cancelled', { memberId: approval.ownerId }, { by: 'owner decision' })
    }
    return save()
  }
  // The responsible Bot is gone: its open tasks fail (they are never silently dropped).
  rt.taskBotDeleted = botId => {
    for (const task of Object.values(store())) {
      if (!ACTIVE.has(task.status) || (task.ownerBotId !== botId && task.workBotId !== botId)) continue
      transition(task, 'failed', null, { why: 'the responsible Bot was deleted' })
    }
    return save()
  }

  // ---------------------------------------------------------------- channel API
  rt.taskEndpoint = async function taskEndpoint(endpoint, body, actor) {
    switch (endpoint) {
      case 'tasks':
        return Object.values(store())
          .filter(task => mayAct(task, actor))
          .sort((a, b) => a.createdAt - b.createdAt)
          .map(view)
      case 'task-create': {
        const botId = String(body.botId ?? '')
        const bot = state.bots?.[botId]
        if (bot === undefined || bot.remote !== undefined) throw forbidden('No such Bot')
        const roomId = body.roomId ? String(body.roomId) : undefined
        if (!mayCreateOn(bot, actor, roomId)) throw forbidden('You cannot assign a task to that Bot')
        const requesterId = requesterOf(actor)
        const task = {
          id: `task-${randomBytes(8).toString('hex')}`,
          status: 'open',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          requesterId,
          ownerBotId: botId,
          // workBotId is the specialist on the exchange; assigned with #55 wiring (#111).
          title: String(body.title ?? '').slice(0, 300),
          ...(typeof body.criteria === 'string' && body.criteria.trim() !== '' ? { criteria: body.criteria.slice(0, 2000) } : {}),
          origin: { ...(roomId ? { roomId } : {}), ...(body.sessionId ? { sessionId: String(body.sessionId) } : {}) },
          actors: [{ status: 'open', at: Date.now(), ...(actor?.memberId ? { memberId: actor.memberId } : {}) }],
        }
        store()[task.id] = task
        prune()
        await save()
        return view(task)
      }
      case 'task-accept': {
        const task = find(body.id)
        if (task === undefined) throw stale(`no task ${String(body.id ?? '')}`)
        requireRequester(task, actor)
        transition(task, 'claimed', actor)
        await save()
        return view(task)
      }
      case 'task-start': {
        const task = find(body.id)
        if (task === undefined) throw stale(`no task ${String(body.id ?? '')}`)
        requireRequester(task, actor)
        transition(task, 'working', actor)
        await save()
        return view(task)
      }
      case 'task-return': {
        const task = find(body.id)
        if (task === undefined) throw stale(`no task ${String(body.id ?? '')}`)
        requireRequester(task, actor)
        transition(task, 'result-ready', actor)
        task.result = { kind: 'summary', summary: String(body.summary ?? '').slice(0, 2000) }
        await save()
        return view(task)
      }
      case 'task-accept-result': {
        const task = find(body.id)
        if (task === undefined) throw stale(`no task ${String(body.id ?? '')}`)
        requireRequester(task, actor)
        transition(task, 'accepted', actor)
        await save()
        return view(task)
      }
      case 'task-cancel': {
        const task = find(body.id)
        if (task === undefined) throw stale(`no task ${String(body.id ?? '')}`)
        requireRequester(task, actor)
        transition(task, 'cancelled', actor)
        await save()
        return view(task)
      }
      default:
        throw Object.assign(new Error(`Unknown task endpoint ${endpoint}`), { code: 'bot/not-found' })
    }
  }
  return rt
}
