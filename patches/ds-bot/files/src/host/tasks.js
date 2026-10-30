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
import { columnOf, compareForQueue, compareForWork, occupiesSlot, sameRole } from '../shared/task-board.js'
import { retiredBot } from './store.js'
import { currentParticipants, deriveParticipants } from './room-membership.js'
import { cardNamesIssue } from '../shared/issue-ref.js'
import { ownEntry } from './store.js'

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
// A queue item names the role that may claim it (#1247). The label is the Bot's own role text
// (`roster.js`: free text, trimmed to 24 characters), never a group membership role.
const ROLE_MAX = 24
const QUEUE_RETRY_DEFAULT_SEC = 60
const QUEUE_RETRY_MAX_SEC = 7 * 24 * 60 * 60
// One queue per role, with a stated ceiling (#1729). The default lives here; a graph that knows
// how many workers a role runs overrides it on the card it enqueues, and a re-offer keeps it.
const ROLE_QUEUE_CAP = 8
const QUEUE_CAP_MAX = 64
// A claim runs in its own worker, and two claims never share one (#1729). Its state is a pair of
// maps the caller writes; nothing carries over from the previous claim's worker, and returning the
// card to the queue drops the worker so the next claimant starts clean.
const WORKERS_KEPT = 64
const readCap = (value) => {
    if (value === undefined || value === null || value === '') return undefined
    const cap = Number(value)
    if (!Number.isInteger(cap) || cap < 1 || cap > QUEUE_CAP_MAX) throw invalid(`A queue cap must be a whole number from 1 to ${QUEUE_CAP_MAX}`)
    return cap
}
const readRole = (value) => {
  if (value === undefined || value === null) return undefined
  const role = oneLine(value, ROLE_MAX)
  if (role === '') throw invalid('A queued item needs a role')
  return role
}
// A refusal is named, never a silent null (#1247): the code and the message both carry the
// reason, so the tool's own error text says which refusal it was.
const refuse = (code, message) => Object.assign(new Error(`${code}: ${message}`), { code: `bot/${code}` })
const WALK = ['open', 'claimed', 'working', 'result-ready', 'accepted']
const TERMINAL_MATCH = new Set(['accepted', 'cancelled', 'failed'])

const ARCHIVE_LIMIT_MAX = 200
const readArchiveLimit = (value) => {
  if (value === undefined || value === null) return undefined
  // A number, not something that coerces into one: `true` is not "the first card", and "20" is a
  // wrong request a reader should see refused rather than quietly honoured.
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw invalid('A task list limit must be a whole number of at least 1')
  }
  return Math.min(value, ARCHIVE_LIMIT_MAX)
}
// Newest work first for the bounded archive: a card finished a minute ago has an old `createdAt`
// and a fresh `updatedAt`, and it is the one a member is looking for (#1252).
const newestFirst = (a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || (b.createdAt ?? 0) - (a.createdAt ?? 0)

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
// Where a decision is written back (#1154): an issue or pull request the task came from. The pointer
// is optional — a task without one keeps its decision on its own record, exactly as before — and it is
// normalised so a `pull/12` link and `owner/repo#12` name the same place.
const TARGET_FORMS = [
  /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/(?:issues|pull)\/(\d+)\/?$/i,
  /^([\w.-]+)\/([\w.-]+)#(\d+)$/,
]
const readTarget = (value) => {
  if (value === undefined || value === null || String(value).trim() === '') return undefined
  const text = oneLine(value, 300)
  for (const form of TARGET_FORMS) {
    const match = text.match(form)
    if (match === null) continue
    const [, owner, repo, number] = match
    return { owner, repo, number: Number(number), href: `https://github.com/${owner}/${repo}/issues/${Number(number)}` }
  }
  throw invalid('A target is a GitHub issue or pull request: https://github.com/owner/repo/issues/12 or owner/repo#12')
}
const WRITE_BACK_SUMMARY = 1500
// The line `review-gate.mjs` reads as author attribution (#627); a decision comment is not a
// conclusion, so no line of it may look like one, not even one quoted from a note or a summary.
const WRITER_LINE = /^\s*Written[- ]by\s*:/i
const withoutWriterLines = value => String(value ?? '').split(/\r?\n/).filter(line => !WRITER_LINE.test(line)).join('\n')
// The comment a decision posts. It records a task decision, so it must not read like a review
// verdict: no `Verdict:` line, no PASS/INC, and its decision line is `Decision by:` — the decision and
// the review attribution are two fields, never one name for both (#1154, #1172).
const writeBackBody = (task, status, note, decider) => {
  const lines = [status === 'accepted' ? `Accepted: ${oneLine(task.title, 200)}` : `Sent back: ${oneLine(withoutWriterLines(note), 500)}`]
  const summary = oneLine(withoutWriterLines(task.result?.summary ?? ''), WRITE_BACK_SUMMARY)
  if (summary !== '') lines.push('', summary)
  lines.push('', `Decided in FlyBot by ${decider}.`, '', `Decision by: ${decider}`)
  return lines.join('\n')
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
  // A workflow run names a board task, never a second one (#1696). Core never reads
  // `workflows.json`, so the workflow plugin registers its run refs here and the host only
  // reads them back as `{ taskId, runId, nodeId? }`, one per claimed card. `hasTask` lets the
  // plugin drop a run whose card is gone without ever touching `state.tasks`.
  const projectProviders = new Set()
  rt.onProjectProvider = (fn) => {
    if (typeof fn !== 'function') return () => {}
    projectProviders.add(fn)
    return () => { projectProviders.delete(fn) }
  }
  rt.projectRunRefs = ({ hasTask } = {}) => {
    const exists = typeof hasTask === 'function' ? hasTask : taskId => ownEntry(store(), String(taskId ?? '')) !== undefined
    const refs = []
    const seen = new Set()
    for (const fn of [...projectProviders]) {
      let rows
      try {
        rows = fn({ hasTask: exists })
      } catch (error) {
        rt.warn?.('ds-bot: a project provider failed: %s', error)
        continue
      }
      for (const row of Array.isArray(rows) ? rows : []) {
        const taskId = typeof row?.taskId === 'string' ? row.taskId.trim() : ''
        const runId = typeof row?.runId === 'string' ? row.runId.trim() : ''
        if (taskId === '' || runId === '' || seen.has(taskId)) continue
        seen.add(taskId)
        const nodeId = typeof row?.nodeId === 'string' && row.nodeId.trim() !== '' ? row.nodeId.trim() : undefined
        refs.push({ taskId, runId, ...(nodeId === undefined ? {} : { nodeId }) })
      }
    }
    return refs
  }
  // The requester is the human whose task this is: the signed-in actor, or the one
  // owner of a host nobody has signed in on. Derived, never a body claim.
  const requesterOf = actor => actor?.memberId ?? Object.keys(state.members ?? {})[0] ?? null
  const mayAct = (task, actor) => {
    if (!rt.authzEnforced?.()) return true
    return actor !== null && actor !== undefined && task.requesterId === actor.memberId
  }
  const find = id => ownEntry(store(), String(id ?? ''))
  // Only the record's own requesters may move their tasks; the responsible Bot is
  // checked at create time (owner, grant, or shared-room membership).
  const requireRequester = (task, actor) => {
    if (!mayAct(task, actor)) throw forbidden('Only the requester may move their task')
  }

  // A decision on a task that names an issue or PR leaves one comment waiting for the Bot that owns
  // the task: the Bot holds the connector and the one identity, the host holds no token (#1154). The
  // body is composed here so the card and the comment cannot disagree about what was decided.
  const decideName = actor => oneLine(actor?.displayName || actor?.memberId || 'the owner', 200)
  const requestWriteBack = (task, status, note, actor) => {
    if (task.target === undefined) return
    const decider = decideName(actor)
    task.writeBack = {
      target: task.target.href,
      at: task.updatedAt,
      state: 'pending',
      body: writeBackBody(task, status, note, decider),
    }
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
  // One visibility rule for a card row (#1723): the requester, the owner of the Bot (or an
  // ancestor), or a group admin of the card's room. It is the rule `tasks` answers with, and it
  // is exported so the Project board cannot paint a card the same actor would be refused there.
  const taskVisible = (task, actor) => {
    if (mayAct(task, actor) || ancestorOwned(actor, task.ownerBotId)) return true
    const roomId = typeof task?.origin?.roomId === 'string' ? task.origin.roomId : ''
    return roomId !== '' && roomAdmin(actor, state.rooms?.[roomId])
  }
  rt.taskVisible = taskVisible
  const view = (task) => {
    const parent = task.parentId ? store()[task.parentId] : undefined
    // `claimCue` is the board's own memory of the line it posted (#1253); no reader of a card needs
    // the seq and text of its last claim line, so the view leaves it out.
    const { claimCue, ...row } = task
    return {
      ...row,
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
    if (target === 'accepted') {
      settleOverall(task)
      closeRework(task, actor)
    }
    return true
  }

  // #1252: a group whose last child finishes otherwise leaves its overall card working forever,
  // so the room board keeps a card nobody can close. When every child has ended, the overall card
  // completes: `accepted` if each child was accepted or cancelled, `failed` if any child failed —
  // a failed part is not hidden behind a green overall card. Both go through `transition` /
  // `applyColumn`, the same writes a person's own move makes, so history and actors stay honest.
  function settleOverall(child) {
    const parent = child?.parentId ? store()[child.parentId] : undefined
    if (parent === undefined || parent.kind !== 'group' || !openTask(parent)) return false
    if (!['open', 'claimed', 'working'].includes(parent.status)) return false
    const children = Object.values(store()).filter(task => task.parentId === parent.id)
    if (children.length === 0 || children.some(task => !TERMINAL_MATCH.has(task.status))) return false
    if (children.some(task => task.status === 'failed')) {
      transition(parent, 'failed', null, { why: 'a part of this group failed' })
      return true
    }
    const moved = applyColumn(parent, 'done', null, 'last child completed')
    if (moved) parent.progress = 100
    return moved
  }

  // ---------------------------------------------------------------- the typed contract (#1720)
  // Five additive fields, none of which changes an existing one: `taskClass` (the typed kind,
  // beside the group-card `kind`), `reworkOf` (a rework child's link to the card it reworks,
  // beside the part-of-overall `parentId`), `handoff`, `evidence` and `lease`. Every one is
  // validated by name — a refusal names the field, never a silently dropped value.
  const TASK_CLASSES = ['work', 'rework', 'release', 'triage', 'meeting']
  const HANDOFF_REASON_MAX = 300
  const EVIDENCE_MAX = 8
  const LEASE_TTL_SEC = 30 * 60
  // A role is known when a Bot carries it; `requester` is the human side of a handoff, which no
  // Bot record names. Anything else is refused with the role quoted back (#1720).
  const RESERVED_ROLES = new Set(['requester'])
  const knownRole = role => RESERVED_ROLES.has(role) || Object.values(state.bots ?? {}).some(bot => Boolean(bot?.role) && sameRole(bot.role, role))
  const boundedLine = (value, max, name) => {
    const text = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
    if (text.length > max) throw invalid(`${name} is at most ${max} characters`)
    return text
  }
  const readTaskClass = (value) => {
    if (value === undefined || value === null || value === '') return undefined
    const taskClass = String(value)
    if (!TASK_CLASSES.includes(taskClass)) throw invalid(`taskClass must be one of ${TASK_CLASSES.join(', ')}`)
    return taskClass
  }
  const readReworkOf = (value) => {
    if (value === undefined || value === null || String(value).trim() === '') return undefined
    const id = boundedLine(value, 80, 'reworkOf')
    if (find(id) === undefined) throw invalid(`reworkOf names no task: ${id}`)
    return id
  }
  const readStampOf = (value, name) => {
    if (typeof value === 'number' && Number.isFinite(value)) return value
    const parsed = typeof value === 'string' && value.trim() !== '' ? Date.parse(value) : Number.NaN
    if (!Number.isFinite(parsed)) throw invalid(`${name} must be a time (milliseconds or an ISO date)`)
    return parsed
  }
  const readHandoff = (value) => {
    if (value === undefined || value === null) return undefined
    if (typeof value !== 'object' || Array.isArray(value)) throw invalid('handoff must be an object with from, to, at and reason')
    const from = boundedLine(value.from, ROLE_MAX, 'handoff.from')
    const to = boundedLine(value.to, ROLE_MAX, 'handoff.to')
    if (from === '') throw invalid('handoff needs the role it came from (from)')
    if (to === '') throw invalid('handoff needs the role it goes to (to)')
    if (!knownRole(from)) throw refuse('unknown-role', `handoff.from names the role "${from}", which no Bot carries`)
    if (!knownRole(to)) throw refuse('unknown-role', `handoff.to names the role "${to}", which no Bot carries`)
    const reason = boundedLine(value.reason, HANDOFF_REASON_MAX, 'handoff.reason')
    const at = value.at === undefined || value.at === null ? stamp() : readStampOf(value.at, 'handoff.at')
    return { from, to, at, reason }
  }
  const readEvidence = (value) => {
    if (value === undefined || value === null) return undefined
    if (!Array.isArray(value)) throw invalid('evidence must be a list of at most 8 entries of { sha, pr, check, at }')
    if (value.length > EVIDENCE_MAX) throw invalid(`evidence carries at most ${EVIDENCE_MAX} entries`)
    return value.map((entry) => {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw invalid('each evidence entry is an object of { sha, pr, check, at }')
      const sha = boundedLine(entry.sha, 64, 'evidence.sha')
      const check = boundedLine(entry.check, 200, 'evidence.check')
      let pr
      if (entry.pr !== undefined && entry.pr !== null && entry.pr !== '') {
        pr = typeof entry.pr === 'number' ? entry.pr : Number(entry.pr)
        if (!Number.isInteger(pr) || pr < 1) throw invalid('evidence.pr must be a pull request number')
      }
      const at = entry.at === undefined || entry.at === null ? undefined : readStampOf(entry.at, 'evidence.at')
      if (sha === '' && pr === undefined && check === '' && at === undefined) throw invalid('an evidence entry needs a sha, a pr, a check or an at')
      return { sha, ...(pr === undefined ? {} : { pr }), check, ...(at === undefined ? {} : { at }) }
    })
  }
  const readLease = (value) => {
    if (value === undefined || value === null) return undefined
    if (typeof value !== 'object' || Array.isArray(value)) throw invalid('lease must be an object with holder, takenAt and expiresAt')
    const holder = boundedLine(value.holder, 200, 'lease.holder')
    if (holder === '') throw invalid('lease needs a holder')
    const takenAt = readStampOf(value.takenAt, 'lease.takenAt')
    const expiresAt = readStampOf(value.expiresAt, 'lease.expiresAt')
    if (expiresAt <= takenAt) throw invalid('lease.expiresAt must be after lease.takenAt')
    return { holder, takenAt, expiresAt }
  }
  // One write path for the five fields (#1720): the tool, the conversation path and the HTTP
  // endpoints all reach it, so a refusal is the same refusal wherever the value came from. The
  // reads happen before any assignment, so a refused write leaves the card exactly as it was.
  function writeContract(task, body = {}) {
    const taskClass = readTaskClass(body.taskClass)
    const reworkOf = readReworkOf(body.reworkOf)
    const handoff = readHandoff(body.handoff)
    const evidence = readEvidence(body.evidence)
    const clearingLease = body.lease === null
    const lease = readLease(body.lease)
    if (taskClass !== undefined) task.taskClass = taskClass
    if (reworkOf !== undefined) task.reworkOf = reworkOf
    if (handoff !== undefined) task.handoff = handoff
    if (handoff !== undefined) routeToPool(task, handoff)
    if (evidence !== undefined) task.evidence = evidence
    if (clearingLease) delete task.lease
    if (lease !== undefined) task.lease = lease
    return { taskClass, reworkOf, handoff, evidence, lease }
  }
  // The route on the card (#1775): `handoff.to` names the role that owns the next step, so it is
  // the card's pool. Recording the handoff starts the card in that pool; recording it on a card a
  // member is holding hands the card on in the same write, so the producer lets go of it and the
  // target role can take it with no dispatch from a supervisor.
  function routeToPool(task, handoff) {
    const held = task.claimedBy !== undefined || task.status === 'claimed' || task.status === 'working' || task.status === 'blocked'
    task.queueRole = handoff.to
    if (held) requeue(task, `handoff to ${handoff.to}`, 0, 'handed on')
    else if (task.queueBy === undefined) task.queueBy = task.ownerBotId
    return task.queueRole
  }
  // The typed contract on a card that is created here rather than written by a caller.
  const defaultContract = (task) => {
    task.taskClass = 'work'
    return task
  }
  // ---------------------------------------------------------------- isolated workers (#1729)
  const workers = new Map()
  function newWorker() {
    const id = `worker-${randomBytes(6).toString('hex')}`
    workers.set(id, { id, files: new Map(), vars: new Map(), claimedAt: Date.now() })
    while (workers.size > WORKERS_KEPT) workers.delete(workers.keys().next().value)
    return id
  }
  const dropWorker = (workerId) => { if (typeof workerId === 'string') workers.delete(workerId) }
  // The worker of one claim, or nothing: a caller reaches its own claim's maps only.
  rt.taskWorkerState = (workerId) => {
    const worker = workers.get(String(workerId ?? ''))
    return worker === undefined ? undefined : { id: worker.id, files: worker.files, vars: worker.vars, claimedAt: worker.claimedAt }
  }
  // Measured deliveries from the rows themselves (#1729): no second store, the numbers are a
  // read of the cards. `roles` counts per role, `runs` per run id a card carries.
  rt.taskCounters = function taskCounters(query = {}) {
    const roleOf = (task) => {
      const role = oneLine(task?.queueRole ?? '', ROLE_MAX)
      if (role !== '') return role
      return oneLine(botRecord(task?.ownerBotId)?.role ?? '', ROLE_MAX)
    }
    const init = () => ({ queued: 0, claimed: 0, working: 0, blocked: 0, accepted: 0, failed: 0, cancelled: 0, deliveries: 0, workerSeconds: 0 })
    const roles = {}
    const runs = {}
    const wanted = oneLine(query?.role ?? '', ROLE_MAX)
    const wantedRun = query?.run === undefined || query?.run === null ? '' : String(query.run)
    const all = Object.values(store())
    // A rework chain is one accepted delivery (#1730): an accepted parent and the `rework` child
    // that resolved it are two records of the same delivery. The child still counts in
    // `accepted`; `deliveries` counts the chain once, at its accepted parent. A child whose
    // parent never landed is a delivery of its own — there is no chain to fold it into.
    const acceptedIds = new Set(all.filter(task => task?.status === 'accepted').map(task => task.id))
    const countsAsDelivery = task => task.taskClass !== 'rework' || !acceptedIds.has(task.reworkOf)
    for (const task of all) {
      const role = roleOf(task)
      const run = String(task?.origin?.runId ?? task?.runId ?? '')
      if (wanted !== '' && role !== wanted) continue
      if (wantedRun !== '' && run !== wantedRun) continue
      const bucket = (map, key) => (map[key] ??= init())
      const row = bucket(roles, role || 'unassigned')
      if (row[task.status] !== undefined) row[task.status] += 1
      if (task.status === 'accepted') {
        if (countsAsDelivery(task)) row.deliveries += 1
        const lease = leaseOf(task)
        if (lease !== undefined && Number.isFinite(lease.takenAt)) row.workerSeconds += Math.max(0, Math.round((task.updatedAt - lease.takenAt) / 1000))
      }
      if (run !== '') {
        const runRow = bucket(runs, run)
        if (runRow[task.status] !== undefined) runRow[task.status] += 1
        if (task.status === 'accepted' && countsAsDelivery(task)) runRow.deliveries += 1
      }
    }
    return { roles, runs }
  }
  // One audit block from the typed rows (#1730). A projection, not a store: every line is read
  // from fields the write path already validated, so rendering the same rows twice is the same
  // text. A record stored before the slice carries none of the fields and answers the empty
  // string — an audit of nothing is not an error.
  const isoStamp = at => (Number.isFinite(at) ? new Date(at).toISOString() : '')
  const auditLine = (task) => {
    const lines = []
    const handoff = task.handoff !== null && typeof task.handoff === 'object' ? task.handoff : undefined
    if (handoff !== undefined && handoff.from && handoff.to) {
      const reason = typeof handoff.reason === 'string' && handoff.reason !== '' ? `: ${handoff.reason}` : ''
      lines.push(`handoff ${handoff.from} -> ${handoff.to}${reason} @ ${isoStamp(handoff.at)}`)
    }
    if (Array.isArray(task.evidence)) {
      for (const entry of task.evidence) {
        if (entry === null || typeof entry !== 'object') continue
        const parts = []
        if (entry.sha) parts.push(String(entry.sha))
        if (typeof entry.pr === 'number') parts.push(`pr #${entry.pr}`)
        if (entry.check) parts.push(String(entry.check))
        const at = isoStamp(entry.at)
        if (at !== '') parts.push(`@ ${at}`)
        if (parts.length > 0) lines.push(`evidence ${parts.join(' ')}`)
      }
    }
    const chain = []
    const seen = new Set()
    let cursor = task
    while (cursor !== undefined && cursor !== null && !seen.has(cursor.id)) {
      seen.add(cursor.id)
      chain.push(cursor.id)
      cursor = typeof cursor.reworkOf === 'string' && cursor.reworkOf !== '' ? find(cursor.reworkOf) : undefined
    }
    if (chain.length > 1) lines.push(`rework chain ${chain.reverse().join(' -> ')}`)
    const lease = leaseOf(task)
    if (lease !== undefined) {
      lines.push(`lease ${holderName(lease.holder)} @ ${isoStamp(lease.takenAt)} -> ${isoStamp(lease.expiresAt)}`)
    }
    return lines
  }
  rt.taskAudit = function taskAudit(id) {
    const task = find(String(id ?? ''))
    return task === undefined ? '' : auditLine(task).join('\n')
  }
  // The workflow plugin reads a card's lease through the host (#1729), never a copy of its own.
  rt.taskLease = function taskLease(id) {
    const task = find(String(id ?? ''))
    if (task === undefined) return undefined
    const lease = leaseOf(task)
    if (lease === undefined) return undefined
    const now = Date.now()
    return { ...lease, live: lease.expiresAt > now, heldBy: holderName(lease.holder) }
  }
  const leaseOf = task => (task?.lease !== null && typeof task?.lease === 'object' ? task.lease : undefined)
  const leaseLive = (task, now = Date.now()) => {
    const lease = leaseOf(task)
    return lease !== undefined && Number.isFinite(lease.expiresAt) && lease.expiresAt > now
  }
  const holderName = id => botRecord(id)?.name ?? String(id ?? '')
  // An expired lease returns a queued card to the queue (#1720): the member holding it is gone
  // or stalled, so the item is offered again instead of staying claimed for ever. A card that
  // is not a queued item keeps its status; only the dead lease is dropped.
  function expireLeases(now = Date.now()) {
    let expired = 0
    for (const task of Object.values(store())) {
      const lease = leaseOf(task)
      if (lease === undefined || !Number.isFinite(lease.expiresAt) || lease.expiresAt > now) continue
      // Read once and clear before the requeue: a second read in the same tick sees no lease, so
      // two expired reads return the card once, not twice (#1729). The recovery is recorded on the
      // card itself, and the dead worker is dropped so the next claim starts with no state of it.
      const heldBy = holderName(lease.holder)
      delete task.lease
      dropWorker(task.worker)
      delete task.worker
      if (!task.queueRole || (task.status !== 'claimed' && task.status !== 'working')) continue
      const entry = { check: `lease expired (held by ${heldBy})`, at: now }
      task.evidence = [...(Array.isArray(task.evidence) ? task.evidence : []), entry].slice(-EVIDENCE_MAX)
      requeue(task, 'lease expired', 0)
      expired += 1
    }
    return expired
  }
  // The one owner of lease recovery (#1729): a read here is the same read the claim path makes,
  // so a restart and a claim cannot both return the same expired card.
  rt.taskExpireLeases = async (now = Date.now()) => {
    const expired = expireLeases(now)
    if (expired > 0) await save()
    return expired
  }
  // A rejection is a handover, not a status flip (#1720): the original's `handoff` names the
  // roles, and the rework is one child card linked by `reworkOf` — never `parentId`, which
  // means "part of an overall card" and must never make `settleOverall` fire. A replay of the
  // same rejection reuses the child that is still open instead of creating a second one.
  function openRework(original, note, by = 'requester') {
    const reason = boundedLine(note, HANDOFF_REASON_MAX, 'handoff.reason')
    // A worker-side return names the role that produced the card (#1775); the requester's own
    // send-back stays the owner's role, exactly as before.
    const to = by === 'requester'
      ? oneLine(botRecord(original.ownerBotId)?.role ?? '', ROLE_MAX) || 'requester'
      : oneLine(original.handoff?.from ?? '', ROLE_MAX)
    const from = by
    const at = stamp()
    original.handoff = { from, to, at, reason }
    const existing = Object.values(store()).find(task => task.reworkOf === original.id && openTask(task))
    if (existing !== undefined) {
      existing.handoff = { from, to, at, reason }
      if (by !== 'requester') existing.queueRole = to
      existing.actors = [...(existing.actors ?? []), { status: existing.status, at, by: 'rework replayed' }]
      existing.updatedAt = at
      return existing
    }
    const child = {
      id: `task-${randomBytes(8).toString('hex')}`,
      status: 'open',
      taskClass: 'rework',
      reworkOf: original.id,
      createdAt: at,
      updatedAt: at,
      requesterId: original.requesterId ?? null,
      ownerBotId: original.ownerBotId,
      title: oneLine(`${original.title} (rework)`, 300),
      note: reason,
      source: 'rework',
      handoff: { from, to, at, reason },
      ...(by === 'requester' ? {} : { queueRole: to, queueBy: original.queueBy ?? original.ownerBotId }),
      origin: { ...(original.origin ?? {}) },
      actors: [{ status: 'open', at, by: 'rework opened' }],
    }
    store()[child.id] = child
    return child
  }
  // The one write that returns the original to `result-ready` (#1720): it runs where a task is
  // accepted, and the guard is the original still being `working`, so accepting a rework child
  // twice moves the original once and a replay after a restart is a no-op.
  function closeRework(child, actor) {
    if (child?.taskClass !== 'rework' || typeof child.reworkOf !== 'string') return false
    const original = find(child.reworkOf)
    if (original === undefined || original.status !== 'working') return false
    transition(original, 'result-ready', actor, { by: 'rework accepted' })
    original.result = { kind: 'summary', summary: 'Rework accepted' }
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
    if (body.target !== undefined) {
      const target = readTarget(body.target)
      if (target === undefined) delete task.target
      else task.target = target
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
  // One planner per room (#1182). A picked task lead wins, including when the
  // admin (often the Chief) is not in the room. With none picked, the admin plans.
  // Another Main Bot does not: two planners is how the board gets two plans.
  const seatedBot = (room, id) => {
    if (!room || !id || !(room.members ?? []).includes(id)) return false
    const bot = botRecord(id)
    return Boolean(bot && bot.remote === undefined)
  }
  rt.taskLeadOf = (room) => {
    if (!room || room.origin === 'face-to-face') return undefined
    if (seatedBot(room, room.taskLead)) return room.taskLead
    if (seatedBot(room, room.admin)) return room.admin
    const person = liveParticipants(room).find(entry => entry.kind === 'bot' && !entry.remote && entry.role === 'admin' && seatedBot(room, entry.id))
    return person?.id
  }
  const plansRoom = (botId, room) => Boolean(botId) && rt.taskLeadOf(room) === botId
  const planDenied = (room, action) => {
    const picked = room?.taskLead && rt.taskLeadOf(room) === room.taskLead
    throw forbidden(`Only the ${picked ? "room's task lead" : 'group admin'} can ${action}`)
  }
  const memberBot = (room, name) => {
    const wanted = String(name).trim()
    const ids = liveParticipants(room).filter(person => person.kind === 'bot' && !person.remote).map(person => person.id)
    const matches = [...new Set(ids)].map(id => botRecord(id)).filter(candidate => candidate && !retiredBot(candidate) && candidate.name === wanted)
    if (matches.length !== 1) throw invalid(`No single Bot named "${wanted.slice(0, 80)}" in this group`)
    return matches[0]
  }
  const isOverall = (task, roomId) => task?.kind === 'group' && task.origin?.roomId === roomId && openTask(task)
  // ---------------------------------------------------------------- the pull queue (#1247)
  // An item belongs to the room, not to a Bot: `queueRole` names who may claim it, `queueBy` is
  // the lead that enqueued it, and `claimedBy` names the member that took it. `ownerBotId` stays
  // the enqueuer until a claim, so every existing reader (owns, mayAct, prune, view) keeps
  // working; task-drive skips an item that has a role and no claimer, so the enqueuer is not
  // woken for its own item.
  const unclaimed = task => Boolean(task?.queueRole) && !task?.claimedBy
  const roleCarriers = (room, role) => liveParticipants(room)
    .filter(person => person.kind === 'bot' && !person.remote)
    .map(person => botRecord(person.id))
    .filter(bot => Boolean(bot) && sameRole(bot.role, role))
  // blocked → open is the queue's own edge: a member that cannot finish returns the item, and
  // no other path sends a card back to the queue, so the edge is not on TRANSITIONS.
  function requeue(task, reason, retryInSec, by = 'returned to the queue') {
    dropWorker(task.worker)
    delete task.worker
    delete task.waitingFor
    delete task.inputRequest
    delete task.inputApprovalIds
    delete task.approvalId
    delete task.claimedBy
    delete task.lease
    task.status = 'open'
    task.ownerBotId = task.queueBy ?? task.ownerBotId
    task.progress = 0
    task.retryAt = Date.now() + retryInSec * 1000
    task.queueReason = reason
    record(task, null, { by, retryInSec })
  }
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

  // The Bot reports how the comment a decision asked for went (#1154). One report per decision, no
  // retry loop: a failure keeps its one line on the task so the card can name it, and the decision
  // itself is already recorded and stays recorded. A record the drive has given up on is still taken
  // (#1172): a comment posted on a later turn must not keep the card saying it could not be confirmed.
  rt.recordTaskPostResult = async function recordTaskPostResult(botId, result) {
    const body = result ?? {}
    const task = find(body.task ?? body.id)
    if (task === undefined) throw stale(`no task ${String(body.task ?? body.id ?? '')}`)
    if (task.ownerBotId !== botId) throw forbidden('Only the Bot that owns this task reports its comment')
    const waiting = task.writeBack?.state
    if (waiting !== 'pending' && waiting !== 'unconfirmed') throw stale('This task has no comment waiting to be posted')
    const ok = body.ok === true
    const error = oneLine(body.error, 300)
    if (!ok && error === '') throw invalid('A comment that failed needs its reason')
    task.writeBack = { ...task.writeBack, state: ok ? 'posted' : 'failed', ...(ok ? {} : { error }) }
    task.updatedAt = stamp()
    await save()
    return view(task)
  }

  // #1253: taking a card in a room is public — one line in that member's voice, logged in the room
  // and opening no round (`groups.js` `postClaimLine`). A card outside a room, a progress tick on a
  // card the member already holds, and an identical line at the same card stay quiet.
  const announceClaim = (task) => {
    if (!task.origin?.roomId) return
    if (task.status !== 'claimed' && task.status !== 'working') return
    try {
      rt.postClaimLine?.(task)
    } catch (error) {
      rt.warn('ds-bot: the claim line for %s was not posted: %s', task.id, error)
    }
  }

  // #1254: the room's task lead naming one member with an issue id and an imperative is an assign,
  // not a round (`groups.js` `dispatchOf`). The card that member already holds for that issue is
  // updated; otherwise one is opened, owned by that member and still `open` — the host assigns, and
  // the member claims on its own turn, where #1253's claim line is posted in its own voice. The save
  // drives the wake into that member's own chat (#1205), so the room opens no part.
  rt.assignFromDispatch = async function assignFromDispatch({ roomId, botId, issue, title, note, by } = {}) {
    const room = state.rooms?.[String(roomId ?? '')]
    if (!room || room.origin === 'face-to-face') return undefined
    const bot = botRecord(botId)
    if (!bot || bot.remote !== undefined) return undefined
    if (!(room.members ?? []).includes(bot.id)) return undefined
    const text = oneLine(note ?? title, 300)
    if (text === '') return undefined
    const at = stamp()
    const open = Object.values(store()).filter(task =>
      sameRoom(task, room.id) && task.ownerBotId === bot.id && task.kind !== 'group'
      && openTask(task))
    const held = issue === undefined || issue === null || String(issue).trim() === ''
      ? undefined
      : open.filter(task => cardNamesIssue(task, issue)).sort(newestFirst)[0]
    if (held) {
      held.note = text
      // Both paths below append to `actors`, and `record()` pushes without a guard, so a card
      // stored before the field existed would throw after the note moved and before the save
      // (#1254).
      held.actors ??= []
      // A card the drive does not read is restarted through an edge the state machine already has
      // (`result-ready → working`, `blocked → working`): rewriting the note alone saved a card that
      // `task-drive` never wakes for, so the member never saw the dispatch. A blocked card is reused
      // for the same reason one issue is one card — the dispatch answers the wait, it never adds a
      // second card beside it (#1254).
      if (held.status === 'result-ready' || held.status === 'blocked') {
        transition(held, 'working', null, { by: 'dispatch', ...(by ? { botId: by } : {}) })
      } else {
        held.updatedAt = at
        // A stored card may predate `actors`: the append starts the list instead of throwing after the
        // note already moved, which `groups.js` swallowed and left a half-written card (#1254).
        held.actors = [...(held.actors ?? []), { status: held.status, at, by: 'dispatch', ...(by ? { botId: by } : {}) }]
      }
      await save()
      return view(held)
    }
    const task = {
      id: `task-${randomBytes(8).toString('hex')}`,
      status: 'open',
      createdAt: at,
      updatedAt: at,
      requesterId: bot.ownerId ?? null,
      ownerBotId: bot.id,
      title: oneLine(title ?? text, 300),
      note: text,
      source: 'conversation',
      origin: { roomId: room.id },
      actors: [{ status: 'open', at, by: 'dispatch', ...(by ? { botId: by } : {}) }],
    }
    defaultContract(task)
    store()[task.id] = task
    await save()
    return view(task)
  }

  // A member claims from the room's queue (#1247). The claim is a board write: it sets the
  // owner and moves the card to claimed, so the delivery view and the room board read the same
  // card with no second row.
  async function claimQueued(botId, body, roomId) {
    const room = resolveRoom(botId, body.group, roomId)
    const entry = room ? state.rooms?.[room] : undefined
    // A handoff card waits in its role's pool, not in a room (#1775): a member of the role takes it
    // from its own chat, so a chain handed from one role to the next needs no group and no dispatch.
    if (!entry) return claimHandoff(botId, body)
    if (expireLeases() > 0) await rt.save()
    const myRole = oneLine(botRecord(botId)?.role ?? '', ROLE_MAX)
    if (myRole === '') throw refuse('not-in-role', 'this Bot has no role to claim with')
    // WIP = 1: one card the member is still working fills its slot. A blocked card waits on a
    // person and a delivered card waits on its requester, so neither counts (#1247, #1744).
    const holding = Object.values(store())
      .filter(task => task.ownerBotId === botId && occupiesSlot(task))
    if (holding.length > 0) return { item: null, reason: 'wip', held: holding.sort(compareForWork)[0].id }
    const now = Date.now()
    const offered = task => !(Number.isFinite(task.retryAt) && task.retryAt > now)
    const wantedId = body.id !== undefined && body.id !== null && String(body.id) !== '' ? String(body.id) : undefined
    let pick
    if (wantedId !== undefined) {
      pick = find(wantedId)
      if (pick === undefined) throw stale(`no task ${wantedId}`)
      if (!unclaimed(pick) || pick.origin?.roomId !== entry.id) {
        if (leaseLive(pick)) {
          throw refuse('lease-held', `task ${pick.id} is held by ${holderName(pick.lease.holder)} until ${new Date(pick.lease.expiresAt).toISOString()}`)
        }
        throw stale(`no queued item ${wantedId} in this group`)
      }
      if (!sameRole(pick.queueRole, myRole)) throw refuse('not-in-role', `that item is queued for ${pick.queueRole}, and this Bot is ${myRole}`)
      if (!offered(pick)) return { item: null, reason: 'waiting' }
    } else {
      pick = Object.values(store())
        .filter(task => unclaimed(task) && task.status === 'open' && task.origin?.roomId === entry.id && sameRole(task.queueRole, myRole) && offered(task))
        .sort(compareForQueue)[0]
    }
    if (pick === undefined) return { item: null, reason: 'empty' }
    // Pick and write are two steps: the tool's own load and the save both yield, so a second
    // member can pick the same item inside the first claim's stack. The item is read again
    // after the yield and only one still open is taken — compare-and-set, not a read (#1247).
    await rt.load()
    const live = find(pick.id)
    if (live === undefined || live.status !== 'open' || live.claimedBy !== undefined) return { item: null, reason: 'taken' }
    live.claimedBy = botId
    live.ownerBotId = botId
    delete live.retryAt
    delete live.queueReason
    const claimedAt = Date.now()
    live.lease = { holder: botId, takenAt: claimedAt, expiresAt: claimedAt + LEASE_TTL_SEC * 1000 }
    // Every claim gets a worker nobody else has started (#1729).
    live.worker = newWorker()
    transition(live, 'claimed', null, { by: 'claimed from the queue' })
    announceClaim(live)
    await save()
    return { item: view(live) }
  }

  // The role's own pool (#1775): a card whose `handoff.to` names this member's role is offered to
  // it and to nobody else, and the same compare-and-set gives one member one card. A card with no
  // room is not offered to a supervisor: the target role takes it, and an idle member wakes for it.
  async function claimHandoff(botId, body) {
    if (expireLeases() > 0) await rt.save()
    const myRole = oneLine(botRecord(botId)?.role ?? '', ROLE_MAX)
    if (myRole === '') throw refuse('not-in-role', 'this Bot has no role to claim with')
    const holding = Object.values(store()).filter(task => task.ownerBotId === botId && occupiesSlot(task))
    if (holding.length > 0) return { item: null, reason: 'wip', held: holding.sort(compareForWork)[0].id }
    const now = Date.now()
    const inPool = (task) => {
      if (task?.status !== 'open' || task.claimedBy !== undefined) return false
      if (!sameRole(task.handoff?.to, myRole)) return false
      return !(Number.isFinite(task.retryAt) && task.retryAt > now)
    }
    const wantedId = body.id !== undefined && body.id !== null && String(body.id) !== '' ? String(body.id) : undefined
    let pick
    if (wantedId !== undefined) {
      pick = find(wantedId)
      if (pick === undefined) throw stale(`no task ${wantedId}`)
      if (!inPool(pick)) throw stale(`no card for ${myRole} in the handoff pool`)
    } else {
      pick = Object.values(store()).filter(inPool).sort(compareForQueue)[0]
    }
    if (pick === undefined) return { item: null, reason: 'empty' }
    await rt.load()
    const live = find(pick.id)
    if (live === undefined || live.status !== 'open' || live.claimedBy !== undefined) return { item: null, reason: 'taken' }
    live.claimedBy = botId
    live.ownerBotId = botId
    delete live.retryAt
    delete live.queueReason
    const claimedAt = Date.now()
    live.lease = { holder: botId, takenAt: claimedAt, expiresAt: claimedAt + LEASE_TTL_SEC * 1000 }
    live.worker = newWorker()
    transition(live, 'claimed', null, { by: 'claimed from the handoff pool' })
    announceClaim(live)
    await save()
    return { item: view(live) }
  }

  // The target role's admission comes back as a rework card (#1775): the member holding the card
  // returns it to the role that produced it (`handoff.from`), and the producer takes it from its
  // own pool. The child is linked by `reworkOf`, never `parentId`, and the original stays `working`
  // until the rework is accepted (`closeRework`).
  async function returnToProducer(botId, spec) {
    const task = find(spec?.task ?? spec?.id)
    if (task === undefined) throw stale(`no task ${String(spec?.task ?? spec?.id ?? '')}`)
    if (task.claimedBy !== botId) throw forbidden('Only the member that claimed this card may return it to its producer')
    const myRole = oneLine(botRecord(botId)?.role ?? '', ROLE_MAX)
    if (!sameRole(task.handoff?.to, myRole)) throw refuse('not-in-role', `card ${task.id} is in the ${task.handoff?.to ?? 'unknown'} pool, not ${myRole}`)
    const reason = readOptionalLine(spec?.reason, 'A reason')
    if (reason === undefined) throw invalid('Returning a card to its producer needs a one-line reason')
    const producer = oneLine(task.handoff?.from ?? '', ROLE_MAX)
    if (producer === '' || producer === 'requester') throw refuse('no-producer', `card ${task.id} carries no producer role to return it to`)
    const child = openRework(task, reason, myRole)
    await save()
    return view(child)
  }

  // A member that cannot finish returns the item with one line of why; it is not offered
  // again before `retryAt` (#1247).
  async function releaseQueued(botId, spec) {
    const task = find(spec?.task ?? spec?.id)
    if (task === undefined) throw stale(`no task ${String(spec?.task ?? spec?.id ?? '')}`)
    if (task.claimedBy !== botId) throw forbidden('Only the member that claimed this item may return it')
    if (task.status !== 'claimed' && task.status !== 'working' && task.status !== 'blocked') {
      throw stale(`a task that is ${task.status} cannot return to the queue`)
    }
    const reason = readOptionalLine(spec?.reason, 'A reason')
    if (reason === undefined) throw invalid('Returning an item to the queue needs a one-line reason')
    const raw = spec?.retryInSec
    const seconds = raw === undefined || raw === null || raw === '' ? QUEUE_RETRY_DEFAULT_SEC : Number(raw)
    if (!Number.isInteger(seconds) || seconds < 0 || seconds > QUEUE_RETRY_MAX_SEC) {
      throw invalid(`retryInSec must be a whole number of seconds from 0 to ${QUEUE_RETRY_MAX_SEC}`)
    }
    requeue(task, reason, seconds)
    await save()
    return view(task)
  }

  // The Bot's own list, written from the conversation. The caller is the Bot.
  // The requester of a task is that task's Bot's owner, so a group admin who
  // does not own the Bot can plan a subtask and still cannot move the card.
  rt.trackBotTasks = async function trackBotTasks(botId, body, origin = {}) {
    const bot = botRecord(botId)
    if (!bot || bot.remote !== undefined) throw forbidden('No such Bot')
    // Both come before the read path: a claim arrives with `tasks` omitted, so reading first
    // would return the list instead of the item (#1247).
    if (body?.release !== undefined) return releaseQueued(botId, body.release)
    if (body?.rework !== undefined) return returnToProducer(botId, body.rework)
    if (body?.claim === true) return claimQueued(botId, body, origin.roomId)
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
      defaultContract(task)
      store()[task.id] = task
      return task
    }
    const saved = []
    const kinds = []
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
      if (overall && !plansRoom(botId, room)) planDenied(room, 'record the overall task')
      if (assigneeName && !plansRoom(botId, room)) planDenied(room, 'assign a subtask')
      // A queued item names a role instead of an assignee (#1247). Only the room's lead
      // enqueues, and an item whose role no live member carries is refused here: left open it
      // would sit for ever and the age on the board would name a wait nobody can take.
      const queue = item.queue === true
      const role = readRole(item.role)
      if (queue && !room) throw invalid('A queued item needs a group')
      if (queue && room?.origin === 'face-to-face') throw invalid('A face-to-face room has no group task board')
      if (queue && overall) throw invalid('A queued item is not the overall task')
      if (queue && assigneeName) throw invalid('A queued item has no assignee; a member claims it from the queue')
      if (queue && !plansRoom(botId, room)) planDenied(room, 'enqueue work')
      if (queue && role === undefined) throw invalid('A queued item needs a role')
      if (!queue && role !== undefined) throw invalid('role belongs to a queued item; pass queue: true with it')
      if (queue && roleCarriers(room, role).length === 0) throw refuse('no-member-with-role', `no member of this group has the role ${role}`)
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
          // A member still records its own room card, parented or not. Dividing
          // the board (overall, or assignee) is refused above (#1182).
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
        if (queue) {
          if (task.claimedBy) throw invalid('That queued item is already claimed; enqueue a new one')
          // A graph may state the role's ceiling; otherwise the one constant does (#1729). The
          // count leaves this card out, so re-offering a queued item keeps its id and is never
          // refused for the place it already holds.
          const cap = readCap(item.cap) ?? (Number.isInteger(task.queueCap) ? task.queueCap : ROLE_QUEUE_CAP)
          const queued = Object.values(store()).filter(other => other.id !== task.id
            && other.origin?.roomId === roomId && unclaimed(other) && other.status === 'open'
            && other.queueRole && sameRole(other.queueRole, role))
          if (queued.length >= cap) throw refuse('queue-full', `the ${role} queue already holds ${queued.length} items, its cap is ${cap}`)
          task.queueRole = role
          task.queueBy = botId
          task.queueCap = cap
          delete task.retryAt
          delete task.queueReason
        }
        if (!answer && waitingForInput(task) && (column !== undefined || item.progress !== undefined)) {
          throw stale('This task is waiting on an answer. Ask, then pass answer with what was said.')
        }
        if (title && task.title !== title) task.title = title
        // A refused value must not leave a half-created card behind: the writer validates before
        // it assigns, and a new row it refuses is removed again (#1720).
        try {
          writeContract(task, item)
        } catch (error) {
          if (isNew) delete store()[task.id]
          throw error
        }
        const { progress } = applyFields(task, item)
        if (!task.source) task.source = 'conversation'
        const before = task.updatedAt
        // #1253: only the move out of the queue/not-started is a claim, so the progress ticks that
        // follow it on the same card never reach the room.
        const wasOpen = task.status === 'open'
        if (answer) resumeFromAnswer(task, answer)
        const moved = applyColumn(task, column, null, 'conversation')
        if (column === 'done' && progress === undefined) task.progress = 100
        if (ask) {
          if (task.ownerBotId !== botId) throw forbidden('Only that Bot can mark its task waiting')
          blockForInput(task, ask)
        } else if (!answer && !isNew && !moved && task.updatedAt === before) record(task, null, { by: 'conversation' })
        // Assigning claims the card. The assignee starts the work; nobody confirms first (#1182).
        if (isNew && parent && task.ownerBotId !== botId && task.status === 'open') transition(task, 'claimed', null, { by: 'assigned' })
        if (wasOpen && (task.status === 'claimed' || task.status === 'working')) announceClaim(task)
      }
      if (task.title) batch.set(task.title, task)
      batch.set(task.id, task)
      saved.push(task)
      kinds.push(isNew ? 'create' : 'update')
    }
    prune()
    await save()
    // The conversation path is a board write like task-create and task-update, so a plugin
    // has to see it: a card a Bot records itself with `workflow:<id>` starts nothing
    // otherwise (#1462). Routing after the save also keeps a routed owner visible.
    for (let at = 0; at < saved.length; at += 1) await routeOpenTask(saved[at], kinds[at])
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
          settleOverall(task)
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
      // A rejection is one of the doors a child ends through, so the overall card settles here too.
      settleOverall(task)
    }
    return save()
  }
  // The responsible Bot is gone: its open tasks fail (they are never silently dropped).
  rt.taskBotDeleted = (botId, why = 'the responsible Bot was deleted') => {
    for (const task of Object.values(store())) {
      if (!ACTIVE.has(task.status) || (task.ownerBotId !== botId && task.workBotId !== botId)) continue
      transition(task, 'failed', null, { why })
      // Deletion is another door a child ends through; its overall card must not stay working.
      settleOverall(task)
    }
    return save()
  }

  // A plugin may claim an open card for a local Bot (#1318). The second save
  // does not ask again, so a listener cannot re-enter this write.
  async function routeOpenTask(task, kind) {
    if (typeof rt.onTaskWrite !== 'function') return
    let route
    try {
      route = await rt.onTaskWrite(view(task), kind)
    } catch (error) {
      rt.warn?.('ds-bot: task route failed: %s', error)
      return
    }
    const next = typeof route?.ownerBotId === 'string' ? route.ownerBotId : ''
    if (next === '' || next === task.ownerBotId) return
    const bot = botRecord(next)
    if (bot === undefined || bot.remote !== undefined || retiredBot(bot)) return
    task.ownerBotId = next
    record(task, null, { by: 'routed' })
    await save()
  }

  // What `task-create` decides, without the write: a caller that must know before it creates
  // anything (a meeting pre-flights every produced task) gets this endpoint's own refusal from the
  // endpoint's own gate, so the answer and the write cannot disagree.
  const assertCreate = (body, actor) => {
    const bot = state.bots?.[String(body?.botId ?? '')]
    // The same gate the endpoint had, plus retirement (#1709): a retired Bot takes no new card,
    // whether it arrives from task-create or a pre-flight.
    if (bot === undefined || bot.remote !== undefined || retiredBot(bot)) throw forbidden('No such Bot')
    const roomId = body?.roomId ? String(body.roomId) : undefined
    if (!mayCreateOn(bot, actor, roomId)) throw forbidden('You cannot assign a task to that Bot')
    return bot
  }
  rt.taskCanCreate = assertCreate

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
        // #1252: the board lists active work; the archive is the same read with a flag, so a
        // group that has finished hundreds of cards does not ship them on every poll. A caller
        // that asks for a bounded archive gets the newest rows; without `limit` every row stays
        // readable, because a lookup by id must still find a card outside the newest page.
        const archived = body.archive === true
        const limit = archived ? readArchiveLimit(body.limit) : undefined
        if (limit !== undefined) {
          // The page exists for the Done column, so its budget is spent on finished rows only: a
          // busy room's freshly updated working cards must not push the finished ones off it.
          const settled = rows.filter(task => !openTask(task)).sort(newestFirst).slice(0, limit)
          return settled.map(view)
        }
        const shown = archived ? rows : rows.filter(openTask)
        return shown.sort((a, b) => a.createdAt - b.createdAt).map(view)
      }
      case 'task-create': {
        const botId = String(body.botId ?? '')
        assertCreate(body, actor)
        const roomId = body.roomId ? String(body.roomId) : undefined
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
        defaultContract(task)
        writeContract(task, body)
        const { progress } = applyFields(task, body)
        const column = readColumn(body.column)
        applyColumn(task, column, actor)
        if (column === 'done' && progress === undefined) task.progress = 100
        store()[task.id] = task
        prune()
        await save()
        await routeOpenTask(task, 'create')
        return view(task)
      }
      case 'task-update': {
        const task = find(body.id)
        if (task === undefined) throw stale(`no task ${String(body.id ?? '')}`)
        if (!mayUpdate(task, actor)) throw forbidden('Only the requester or the Bot\'s owner may update this task')
        writeContract(task, body)
        const { progress } = applyFields(task, body)
        const column = readColumn(body.column)
        const before = task.updatedAt
        const moved = applyColumn(task, column, actor)
        if (column === 'done' && progress === undefined) task.progress = 100
        if (!moved && task.updatedAt === before) record(task, actor, { by: 'updated' })
        await save()
        await routeOpenTask(task, 'update')
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
        settleOverall(task)
        closeRework(task, actor)
        requestWriteBack(task, 'accepted', undefined, actor)
        await save()
        return view(task)
      }
      case 'task-send-back': {
        const task = find(body.id)
        if (task === undefined) throw stale(`no task ${String(body.id ?? '')}`)
        requireRequester(task, actor)
        if (task.status !== 'result-ready') throw stale('Only a result waiting for the requester can be sent back')
        // Sending back opens a rework card on the same owner, so a retired Bot would get a
        // fresh card through this door (#1709). Refused before any write: no card is born.
        if (retiredBot(botRecord(task.ownerBotId))) throw forbidden('No such Bot')
        const note = oneLine(body.note, 500)
        if (note === '') throw invalid('Send back needs a note for the Bot')
        transition(task, 'working', actor, { by: 'sent back' })
        task.followUp = { note, at: task.updatedAt }
        openRework(task, note)
        requestWriteBack(task, 'working', note, actor)
        await save()
        return view(task)
      }
      case 'task-cancel': {
        const task = find(body.id)
        if (task === undefined) throw stale(`no task ${String(body.id ?? '')}`)
        requireRequester(task, actor)
        transition(task, 'cancelled', actor)
        settleOverall(task)
        await save()
        return view(task)
      }
      default:
        throw Object.assign(new Error(`Unknown task endpoint ${endpoint}`), { code: 'bot/not-found' })
    }
  }
  return rt
}
