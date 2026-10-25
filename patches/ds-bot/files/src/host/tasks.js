// Tasks (#54): a tracked request with a stable id and a small state machine, so
// responsibilities and completion are visible beyond chat text. Team mode stays
// disabled: this is the task-record foundation the later team gates build on
// (docs/subsystems/team.md) — in the single-human product every transition is the
// requester's; with member sessions only the requester's own may move their task,
// and the record carries server-derived authority, never body claims (#52 rule).
//
// Create is grant-aware: the requester need not own the Bot. A granted child (or a
// Bot in the named room the requester currently sits in) may take a task within
// its authority. Outgoing holds stay the owner's (#52 card). The board (#1058)
// also lets that Bot's owner set priority, progress, note and column; the other
// transitions stay the requester's.
//
// States: open → claimed → working → blocked ⇄ working → result-ready → accepted;
// A returned result may also be cancelled before acceptance. Cancelled and failed
// are terminal, and accepted is reachable only from result-ready. A cancelled or
// failed task never becomes accepted. Records keep pointers and a summary, not transcripts.
import { randomBytes } from 'node:crypto'
import { columnOf, compareForWork } from '../shared/task-board.js'
import { currentParticipants, deriveParticipants } from './room-membership.js'

const ACTIVE = new Set(['open', 'claimed', 'working', 'blocked'])
// result-ready still waits for the requester: prune must not evict it with terminals (#111).
const PROTECTED = new Set([...ACTIVE, 'result-ready'])
const TRANSITIONS = {
  open: ['claimed', 'cancelled', 'failed'],
  claimed: ['working', 'cancelled', 'failed'],
  working: ['blocked', 'result-ready', 'cancelled', 'failed'],
  blocked: ['working', 'cancelled', 'failed'],
  'result-ready': ['accepted', 'working', 'cancelled'],
  accepted: [],
  cancelled: [],
  failed: [],
}
const KEPT = 200

const stale = message => Object.assign(new Error(message), { code: 'bot/stale' })
const forbidden = message => Object.assign(new Error(message), { code: 'bot/forbidden' })
const invalid = message => Object.assign(new Error(message), { code: 'bot/invalid' })
const waitingForInput = task => task.status === 'blocked' && task.waitingFor === 'input'
const canLinkSend = task => task.status === 'working' || waitingForInput(task)
const PRIORITY = new Set(['urgent', 'high', 'normal', 'low'])
const WALK = ['open', 'claimed', 'working', 'result-ready', 'accepted']
const TERMINAL_MATCH = new Set(['accepted', 'cancelled', 'failed'])

const readPriority = (value) => {
  if (value === undefined || value === null || value === '') return undefined
  const priority = String(value)
  if (!PRIORITY.has(priority)) throw invalid('Priority must be urgent, high, normal or low')
  return priority
}
const readProgress = (value) => {
  if (value === undefined || value === null || value === '') return undefined
  const progress = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(progress) || progress < 0 || progress > 100) throw invalid('Progress must be a whole number from 0 to 100')
  return progress
}
const oneLine = (value, max) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
const readTitle = value => oneLine(value, 300)
// Evidence a result carries (#401): links only, http(s), a handful, so a card can point at the diff, the
// file or the test run without the record becoming a transcript.
const LINKS_MAX = 5
const readLinks = (value) => {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw invalid('Result links must be a list')
  const links = []
  for (const item of value) {
    const link = oneLine(item, 300)
    if (!/^https?:\/\//i.test(link) || links.includes(link)) continue
    links.push(link)
    if (links.length === LINKS_MAX) break
  }
  return links
}
const readNote = (value) => {
  if (value === undefined || value === null) return undefined
  return oneLine(value, 300)
}
const readOptionalLine = (value, name) => {
  if (value === undefined || value === null || String(value).trim() === '') return undefined
  const text = oneLine(value, 300)
  if (!text) throw invalid(`${name} needs text`)
  return text
}
const readColumn = (value) => {
  if (value === undefined || value === null || value === '') return undefined
  const column = String(value)
  if (column !== 'not-started' && column !== 'in-progress' && column !== 'done') throw invalid('Column must be not-started, in-progress or done')
  return column
}
const selectedInput = (value, name) => {
  if (typeof value !== 'string' || !value.trim() || value.length > 2000) throw invalid(`${name} must contain 1–2000 characters`)
  return value
}

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

  // `updatedAt` orders tasks — the latest working task a send is bound to (#111) and the order
  // prune drops them in. Two transitions in one millisecond must still order, so the stamp is
  // strictly increasing: never below the previous stamp even when the clock has not moved (#549).
  let lastStamp = 0
  const stamp = () => (lastStamp = Math.max(lastStamp + 1, Date.now()))

  function record(task, actor, extra) {
    task.updatedAt = stamp()
    task.actors.push({ status: task.status, at: task.updatedAt, ...(actor?.memberId ? { memberId: actor.memberId } : {}), ...extra })
  }
  function transition(task, to, actor, extra) {
    if (!TRANSITIONS[task.status]?.includes(to)) throw stale(`a task that is ${task.status} cannot become ${to}`)
    if (waitingForInput(task) && to !== 'blocked') {
      delete task.waitingFor
      delete task.inputApprovalIds
      delete task.approvalId
    }
    task.status = to
    record(task, actor, extra)
  }

  const prune = () => {
    const all = Object.values(store())
    const droppable = all.filter(task => !PROTECTED.has(task.status)).sort((a, b) => a.updatedAt - b.updatedAt)
    for (const task of droppable.slice(0, Math.max(0, all.length - KEPT))) delete store()[task.id]
  }
  // A board write is what makes unfinished work visible. The driver wakes an idle
  // Session after the save, and a failure there must not fail the write itself.
  const save = async () => {
    await rt.save()
    await rt.considerTaskDrive?.()
  }

  const botRecord = id => state.bots?.[id]
  // The human who owns this Bot. With no signed-in member the single-human product
  // may see every local Bot, the same way the rest of the task API does.
  const owns = (actor, botId) => {
    const bot = botRecord(botId)
    if (!bot || bot.remote !== undefined) return false
    if (!rt.authzEnforced?.()) return true
    return Boolean(actor?.memberId && bot.ownerId === actor.memberId)
  }
  // Walk createdBy. Owning the Bot, or any ancestor, is enough to read its tasks.
  const ancestorOwned = (actor, botId) => {
    const seen = new Set()
    let id = botId
    while (id && !seen.has(id)) {
      seen.add(id)
      if (owns(actor, id)) return true
      id = botRecord(id)?.createdBy
    }
    return false
  }
  // A room written before participants existed still has members and an admin.
  // Listing must see those Bots; an empty participants field is not that shape.
  const liveParticipants = (room) => {
    if (!room) return []
    const list = Array.isArray(room.participants) ? room.participants : deriveParticipants(room, state)
    return list.filter(person => person.leftSeq === undefined)
  }
  // A group admin is a current human participant with that role, or the owner of
  // the Bot that administers the group. Membership alone is not enough.
  const roomAdmin = (actor, room) => {
    if (!room || !actor?.memberId) return false
    const me = liveParticipants(room).find(p => p.kind === 'human' && p.id === actor.memberId)
    if (me?.role === 'admin') return true
    return owns(actor, room.admin)
  }
  const mayUpdate = (task, actor) => {
    if (!rt.authzEnforced?.()) return true
    return mayAct(task, actor) || owns(actor, task.ownerBotId)
  }
  const view = (task) => {
    const parent = task.parentId ? store()[task.parentId] : undefined
    return {
      ...task,
      actors: [...task.actors ?? []],
      ...(botRecord(task.ownerBotId)?.name ? { ownerBotName: botRecord(task.ownerBotId).name } : {}),
      ...(parent?.title ? { parentTitle: parent.title } : {}),
    }
  }

  // Move a card along the existing states. Not started is open/claimed, In progress
  // is working (or blocked / result-ready), Done is accepted. Reverse moves and a
  // blocked wait are refused: the wait has its own resume.
  function applyColumn(task, column, actor, by) {
    if (!column || columnOf(task) === column) return false
    if (task.status === 'blocked') throw stale('A blocked task stays put until its wait is cleared')
    if (task.status === 'cancelled' || task.status === 'failed') throw stale(`a task that is ${task.status} cannot become ${column}`)
    if (column === 'not-started') throw stale('a task that is in progress or done cannot move back to not started')
    const target = column === 'in-progress' ? 'working' : 'accepted'
    const from = WALK.indexOf(task.status)
    const goal = WALK.indexOf(target)
    if (from < 0 || goal < 0 || from > goal) throw stale(`a task that is ${task.status} cannot become ${column}`)
    const extra = by ? { by } : undefined
    for (let i = from + 1; i <= goal; i++) {
      const next = WALK[i]
      transition(task, next, actor, extra)
      if (next === 'result-ready') task.result = { kind: 'summary', summary: (task.note || 'Completed').slice(0, 2000) }
    }
    return true
  }

  function applyFields(task, body) {
    const title = body.title !== undefined ? readTitle(body.title) : undefined
    if (title !== undefined) {
      if (title === '') throw invalid('A task needs a title')
      task.title = title
    }
    const priority = readPriority(body.priority)
    if (priority !== undefined) task.priority = priority
    const progress = readProgress(body.progress)
    if (progress !== undefined) task.progress = progress
    if (body.note !== undefined) {
      const note = readNote(body.note)
      if (note) task.note = note
      else delete task.note
    }
    return { priority, progress }
  }

  const roomByName = (botId, name) => {
    const rooms = Object.values(state.rooms ?? {}).filter(room => Array.isArray(room.members) && room.members.includes(botId) && room.name === name)
    if (rooms.length !== 1) throw invalid(`No single group named "${name.slice(0, 80)}" that you are in`)
    return rooms[0].id
  }
  const resolveRoom = (botId, group, fallback) => {
    if (group === undefined || group === null || String(group).trim() === '') return fallback || undefined
    return roomByName(botId, String(group).trim())
  }
  const sameRoom = (task, roomId) => (task.origin?.roomId ?? undefined) === roomId
  const openTask = (task) => !TERMINAL_MATCH.has(task.status)
  const matchTitle = (botId, title, roomId) => {
    const found = Object.values(store()).filter(task => task.ownerBotId === botId && task.kind !== 'group' && task.title === title && openTask(task) && sameRoom(task, roomId))
    if (found.length > 1) throw invalid(`Two open tasks are named "${title}". Pass an id.`)
    return found[0]
  }
  const matchChild = (botId, title, roomId, parentId) => {
    const found = Object.values(store()).filter(task => task.ownerBotId === botId && task.kind !== 'group' && task.title === title && task.parentId === parentId && openTask(task) && sameRoom(task, roomId))
    if (found.length > 1) throw invalid(`Two open tasks are named "${title}". Pass an id.`)
    return found[0]
  }
  const openOverall = (roomId) => Object.values(store())
    .filter(task => task.kind === 'group' && task.origin?.roomId === roomId && openTask(task))
    .sort((a, b) => b.updatedAt - a.updatedAt)[0]
  const listed = (botId) => Object.values(store()).filter(task => task.ownerBotId === botId).sort(compareForWork).slice(0, 40).map(view)
  // The room admin, or a Main Bot that sits in the group, plans the overall task.
  const plansRoom = (botId, room) => {
    if (!room || !botId) return false
    if (room.admin === botId) return true
    if (rt.isMain?.(botId) && (room.members ?? []).includes(botId)) return true
    return liveParticipants(room).some(person => person.kind === 'bot' && !person.remote && person.id === botId && person.role === 'admin')
  }
  const memberBot = (room, name) => {
    const wanted = String(name).trim()
    const ids = liveParticipants(room).filter(person => person.kind === 'bot' && !person.remote).map(person => person.id)
    const matches = [...new Set(ids)].map(id => botRecord(id)).filter(candidate => candidate && candidate.name === wanted)
    if (matches.length !== 1) throw invalid(`No single Bot named "${wanted.slice(0, 80)}" in this group`)
    return matches[0]
  }
  const isOverall = (task, roomId) => task?.kind === 'group' && task.origin?.roomId === roomId && openTask(task)
  const resolveParent = (roomId, ref, batch) => {
    const text = String(ref).trim()
    const direct = [find(text), batch.get(text)].find(task => isOverall(task, roomId))
    if (direct) return direct
    const byTitle = Object.values(store()).find(task => isOverall(task, roomId) && task.title === text)
    if (byTitle) return byTitle
    throw invalid(`No overall task "${text.slice(0, 80)}" in this group`)
  }
  // A question parks the task on the same input wait the board already shows.
  // The owner sees it in the inbox; the tool tells the Bot to ask as well.
  function blockForInput(task, question) {
    if (TERMINAL_MATCH.has(task.status) || task.status === 'result-ready') throw stale('A finished task cannot wait on a question')
    if (task.status === 'blocked' && !waitingForInput(task)) throw stale('A blocked task stays put until its wait is cleared')
    if (waitingForInput(task)) {
      task.inputRequest = { ...task.inputRequest, question }
      record(task, null, { by: 'conversation' })
      return
    }
    if (task.status !== 'working') applyColumn(task, 'in-progress', null, 'conversation')
    const questionId = `input-${randomBytes(8).toString('hex')}`
    transition(task, 'blocked', null, { questionId, by: 'input requested' })
    task.waitingFor = 'input'
    task.inputRequest = { id: questionId, question, requestedAt: task.updatedAt }
  }
  function resumeFromAnswer(task, answer) {
    if (!waitingForInput(task)) throw stale('This task is not waiting on an answer')
    if (task.approvalId || task.inputApprovalIds?.length) throw stale('Approval is still required before resuming')
    transition(task, 'working', null, { questionId: task.inputRequest?.id, by: 'input answered' })
    task.inputRequest = { ...task.inputRequest, answer, answeredAt: task.updatedAt }
  }

  // The Bot's own list, written from the conversation. The caller is the Bot.
  // The requester of a task is that task's Bot's owner, so a group admin who
  // does not own the Bot can plan a subtask and still cannot move the card.
  rt.trackBotTasks = async function trackBotTasks(botId, body, origin = {}) {
    const bot = botRecord(botId)
    if (!bot || bot.remote !== undefined) throw forbidden('No such Bot')
    const items = body?.tasks
    if (items === undefined) return listed(botId)
    if (!Array.isArray(items)) throw invalid('tasks must be a list')
    if (items.length > 20) throw invalid('Track at most 20 tasks at once')
    const makeTask = (ownerBot, title, roomId) => {
      const at = stamp()
      const actor = ownerBot.ownerId ? { memberId: ownerBot.ownerId } : null
      const task = {
        id: `task-${randomBytes(8).toString('hex')}`,
        status: 'open',
        createdAt: at,
        updatedAt: at,
        requesterId: ownerBot.ownerId ?? null,
        ownerBotId: ownerBot.id,
        title,
        source: 'conversation',
        origin: { ...(roomId ? { roomId } : {}), ...(origin.sessionId ? { sessionId: String(origin.sessionId) } : {}) },
        actors: [{ status: 'open', at, by: 'conversation', ...(actor?.memberId ? { memberId: actor.memberId } : {}) }],
      }
      store()[task.id] = task
      return task
    }
    const saved = []
    const batch = new Map()
    for (const item of items) {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) throw invalid('Each task must be an object')
      const column = readColumn(item.column)
      const title = item.title !== undefined ? readTitle(item.title) : undefined
      const ask = readOptionalLine(item.ask, 'A question')
      const answer = readOptionalLine(item.answer, 'An answer')
      const overall = item.overall === true
      const assigneeName = item.assignee === undefined || item.assignee === null ? '' : String(item.assignee).trim()
      const parentRef = item.parent === undefined || item.parent === null ? '' : String(item.parent).trim()
      if (ask && column === 'done') throw invalid('A task that needs an answer cannot be done')
      const roomId = resolveRoom(botId, item.group, origin.roomId)
      const room = roomId ? state.rooms?.[roomId] : undefined
      if ((overall || assigneeName || parentRef) && !room) throw invalid('A group task needs a group')
      if (room?.origin === 'face-to-face' && (overall || assigneeName || parentRef)) throw invalid('A face-to-face room has no group task board')
      if (overall && assigneeName) throw invalid('The overall task is the group\'s, not a subtask')
      if (overall && parentRef) throw invalid('The overall task has no parent')
      if (overall && !plansRoom(botId, room)) throw forbidden('Only the group admin can record the overall task')
      if (assigneeName && !plansRoom(botId, room)) throw forbidden('Only the group admin can assign a subtask')
      let ownerBot = bot
      if (assigneeName) {
        ownerBot = memberBot(room, assigneeName)
        if (ownerBot.id !== botId && !parentRef) throw invalid('A subtask needs the overall task (parent)')
      }
      const parent = parentRef ? resolveParent(roomId, parentRef, batch) : undefined
      let task
      let isNew = false
      let frozen = false
      const givenId = item.id !== undefined && item.id !== null && String(item.id) !== ''
      if (givenId) {
        task = find(item.id)
        if (!task || task.ownerBotId !== botId) throw forbidden('That task is not yours')
        if (overall && task.kind !== 'group') throw invalid('That task is not the overall task')
      } else if (overall) {
        task = openOverall(roomId)
        if (task && task.ownerBotId !== botId) throw forbidden('That overall task belongs to another Bot')
        if (!task) {
          if (!title) throw invalid('A new task needs a title')
          isNew = true
          task = makeTask(bot, title, roomId)
          task.kind = 'group'
        }
      } else if (ownerBot.id !== botId) {
        if (!title) throw invalid('A new task needs a title')
        task = matchChild(ownerBot.id, title, roomId, parent.id)
        if (task) frozen = true
        else {
          isNew = true
          task = makeTask(ownerBot, title, roomId)
          task.parentId = parent.id
        }
      } else {
        if (!title) throw invalid('A new task needs a title')
        task = matchTitle(botId, title, roomId)
        if (!task) {
          isNew = true
          task = makeTask(bot, title, roomId)
        }
      }
      if (!frozen) {
        if (parent && task.kind !== 'group') {
          task.parentId = parent.id
          task.origin = { ...task.origin, roomId: parent.origin?.roomId ?? roomId }
        }
        if (overall) task.kind = 'group'
        if (!answer && waitingForInput(task) && (column !== undefined || item.progress !== undefined)) {
          throw stale('This task is waiting on an answer. Ask, then pass answer with what was said.')
        }
        if (title && task.title !== title) task.title = title
        const { progress } = applyFields(task, item)
        if (!task.source) task.source = 'conversation'
        const before = task.updatedAt
        if (answer) resumeFromAnswer(task, answer)
        const moved = applyColumn(task, column, null, 'conversation')
        if (column === 'done' && progress === undefined) task.progress = 100
        if (ask) {
          if (task.ownerBotId !== botId) throw forbidden('Only that Bot can mark its task waiting')
          blockForInput(task, ask)
        } else if (!answer && !isNew && !moved && task.updatedAt === before) record(task, null, { by: 'conversation' })
      }
      if (task.title) batch.set(task.title, task)
      batch.set(task.id, task)
      saved.push(task)
    }
    prune()
    await save()
    return saved.map(view)
  }

  // ---------------------------------------------------------------- host hooks
  // Name the working task a send belongs to so a hold can block that one (#111).
  // Prefer an already-stamped `meta.taskId`; else the Bot's only working task;
  // else the one whose origin matches this send's session/room; else the most
  // recently started. An explicit id also links a task waiting for input; do not
  // infer that binding from an unrelated Bot conversation. workBotId waits on #55.
  rt.taskIdForSend = (msg) => {
    const from = msg?.from
    if (typeof from !== 'string') return undefined
    const ofSender = task => task.ownerBotId === from || task.workBotId === from
    const given = typeof msg?.meta?.taskId === 'string' ? msg.meta.taskId : undefined
    if (given) {
      const named = store()[given]
      if (named && canLinkSend(named) && ofSender(named)) return given
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
    const targets = named && canLinkSend(named) && ofSender(named)
      ? [named]
      : working.length === 1 ? working : []
    for (const task of targets) {
      if (waitingForInput(task)) {
        task.inputApprovalIds = [...new Set([...(task.inputApprovalIds ?? []), approval.id])]
        task.approvalId = task.inputApprovalIds[0]
        record(task, null, { approvalId: approval.id, by: 'approval while awaiting input' })
        continue
      }
      task.approvalId = approval.id
      transition(task, 'blocked', null, { approvalId: approval.id })
    }
    return save()
  }
  // The owner's decision on that approval resumes the task — or, on reject, ends it.
  rt.taskDecided = (approval, decision) => {
    for (const task of Object.values(store())) {
      if (waitingForInput(task) && task.inputApprovalIds?.includes(approval.id)) {
        if (decision !== 'approve') {
          transition(task, 'cancelled', { memberId: approval.ownerId }, { approvalId: approval.id, by: 'owner decision' })
          continue
        }
        task.inputApprovalIds = task.inputApprovalIds.filter(id => id !== approval.id)
        if (task.inputApprovalIds.length) task.approvalId = task.inputApprovalIds[0]
        else delete task.approvalId
        record(task, { memberId: approval.ownerId }, { approvalId: approval.id, by: 'approved; input still required' })
        continue
      }
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
      case 'tasks': {
        const botId = body.botId ? String(body.botId) : ''
        const roomId = body.roomId ? String(body.roomId) : ''
        const all = Object.values(store())
        let rows
        if (roomId) {
          const room = state.rooms?.[roomId]
          if (room === undefined) throw forbidden('No such group')
          if (rt.authzEnforced?.() && !roomAdmin(actor, room)) throw forbidden('Only a group admin can see that group\'s tasks')
          const members = new Set(liveParticipants(room).filter(p => p.kind === 'bot' && !p.remote).map(p => p.id))
          rows = all.filter(task => task.origin?.roomId === roomId && members.has(task.ownerBotId))
        } else if (botId) {
          const bot = botRecord(botId)
          if (bot === undefined || bot.remote !== undefined) throw forbidden('No such Bot')
          const seesBot = ancestorOwned(actor, botId)
          rows = all.filter(task => task.ownerBotId === botId && (seesBot || mayAct(task, actor)))
          if (rt.authzEnforced?.() && !seesBot && rows.length === 0) throw forbidden('You cannot see that Bot\'s tasks')
        } else {
          // Ownership and the tree. Group tasks of someone else's Bot stay behind
          // the room query, so a plain list never becomes a group-admin view.
          rows = all.filter(task => mayAct(task, actor) || ancestorOwned(actor, task.ownerBotId))
        }
        return rows.sort((a, b) => a.createdAt - b.createdAt).map(view)
      }
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
          createdAt: stamp(),
          updatedAt: stamp(),
          requesterId,
          ownerBotId: botId,
          // workBotId is the specialist on the exchange; assigned with #55 wiring (#111).
          title: readTitle(body.title),
          ...(typeof body.criteria === 'string' && body.criteria.trim() !== '' ? { criteria: body.criteria.slice(0, 2000) } : {}),
          origin: { ...(roomId ? { roomId } : {}), ...(body.sessionId ? { sessionId: String(body.sessionId) } : {}) },
          actors: [{ status: 'open', at: stamp(), ...(actor?.memberId ? { memberId: actor.memberId } : {}) }],
        }
        const { progress } = applyFields(task, body)
        const column = readColumn(body.column)
        applyColumn(task, column, actor)
        if (column === 'done' && progress === undefined) task.progress = 100
        store()[task.id] = task
        prune()
        await save()
        return view(task)
      }
      case 'task-update': {
        const task = find(body.id)
        if (task === undefined) throw stale(`no task ${String(body.id ?? '')}`)
        if (!mayUpdate(task, actor)) throw forbidden('Only the requester or the Bot\'s owner may update this task')
        const { progress } = applyFields(task, body)
        const column = readColumn(body.column)
        const before = task.updatedAt
        const moved = applyColumn(task, column, actor)
        if (column === 'done' && progress === undefined) task.progress = 100
        if (!moved && task.updatedAt === before) record(task, actor, { by: 'updated' })
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
        if (task.status !== 'claimed') throw stale('Only a claimed task can start; blocked tasks must clear their input or approval wait')
        transition(task, 'working', actor)
        await save()
        return view(task)
      }
      case 'task-return': {
        const task = find(body.id)
        if (task === undefined) throw stale(`no task ${String(body.id ?? '')}`)
        requireRequester(task, actor)
        // Read the evidence before the transition so a malformed write leaves the task where it is.
        const links = readLinks(body.links)
        transition(task, 'result-ready', actor)
        task.result = { kind: 'summary', summary: String(body.summary ?? '').slice(0, 2000), ...(links.length ? { links } : {}) }
        await save()
        return view(task)
      }
      case 'task-wait-input': {
        const task = find(body.id)
        if (task === undefined) throw stale(`no task ${String(body.id ?? '')}`)
        requireRequester(task, actor)
        if (task.status !== 'working' || task.approvalId) throw stale('Only a working task without an approval wait may request input')
        const question = selectedInput(body.question, 'Question')
        const questionId = `input-${randomBytes(8).toString('hex')}`
        transition(task, 'blocked', actor, { questionId, by: 'input requested' })
        task.waitingFor = 'input'
        task.inputRequest = { id: questionId, question, requestedAt: task.updatedAt }
        await save()
        return view(task)
      }
      case 'task-answer-input': {
        const task = find(body.id)
        if (task === undefined) throw stale(`no task ${String(body.id ?? '')}`)
        requireRequester(task, actor)
        if (!waitingForInput(task) || typeof body.questionId !== 'string' || body.questionId !== task.inputRequest?.id) throw stale('This is not the current input request')
        if (task.approvalId || task.inputApprovalIds?.length) throw stale('Approval is still required before resuming')
        const answer = selectedInput(body.answer, 'Answer')
        transition(task, 'working', actor, { questionId: body.questionId, by: 'input answered' })
        task.inputRequest = { ...task.inputRequest, answer, answeredAt: task.updatedAt }
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
      case 'task-send-back': {
        const task = find(body.id)
        if (task === undefined) throw stale(`no task ${String(body.id ?? '')}`)
        requireRequester(task, actor)
        if (task.status !== 'result-ready') throw stale('Only a result waiting for the requester can be sent back')
        const note = oneLine(body.note, 500)
        if (note === '') throw invalid('Send back needs a note for the Bot')
        transition(task, 'working', actor, { by: 'sent back' })
        task.followUp = { note, at: task.updatedAt }
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
