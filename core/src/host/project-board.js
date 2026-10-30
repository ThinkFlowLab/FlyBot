// One Project, one board read model (#1696). The core task record is the identity: a workflow
// run names the same id through `run.task.id` and never mints a second task, so a card a run
// consumed is one row that carries the run, not two views of the same work.
//
// #1767 adds the other half of the record beside the cards: the `decisions/*.md` files of the
// Project's working folder and the meetings that reached `decided`. It is the same read — the
// folder goes through `listProjectState`, which already hashes every file, and a decision file
// is listed with a name, a date and one title line, never its body.
//
// #1768 adds the queue beside those: the waiting cards of a role queue, the cards a claim holds
// (with its lease live or stalled) and the blocked cards, each with the line it already stores.
// They are derived from the same `state.tasks` pass as the rows, never a second store.
//
// Read-only by construction: it reads `state.tasks`, `state.meetings` and the Project bindings,
// asks each registered provider for the workflow refs of tasks that still exist, and returns the
// sections. It writes nothing, starts nothing and is not called unless someone asks for the board.
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { columnOf } from '../shared/task-board.js'
import { DECISIONS_DIR, listProjectState } from './project-state.js'

const text = value => (typeof value === 'string' ? value.trim() : '')

// The queue, the leases and the blocked cards are host truth the board never copied (#1768):
// a member's role queue is `queueRole` on an open card with no `claimedBy` (`tasks.js`), a lease is
// the one `tasks.js` writes, and a blocked card already stores the question it waits on. This read
// derives those three groups from those fields, oldest wait first, and writes nothing.
const ONE_LINE = 200
const oneLine = value => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, ONE_LINE) : '')
const stampOf = value => (Number.isFinite(value) ? value : null)

// Waiting: an open card a role may claim and no member has. `waitedMs` is measured from the card's
// own `createdAt`, so the board shows a duration a reader can check, not a guess.
export function waitingOf(task, now) {
  if (task === null || typeof task !== 'object') return null
  if (task.status !== 'open') return null
  const role = oneLine(task.queueRole)
  if (role === '' || text(task.claimedBy) !== '') return null
  const since = stampOf(task.createdAt)
  return { id: String(task.id), role, since, waitedMs: since === null ? null : Math.max(0, now - since) }
}

// In flight: the card a member holds. A live lease reads running; an expired one reads stalled —
// the card record is untouched either way, recovery stays `tasks.js`'s own path (#1720).
export function inflightOf(task) {
  if (task === null || typeof task !== 'object') return null
  if (task.status !== 'claimed' && task.status !== 'working') return null
  // The holder is the claim, not the assignee label: a card nobody claimed is waiting work, and
  // only the queue's own claim (or the lease that claim wrote) says a member holds it.
  const holder = oneLine(task.claimedBy) || oneLine(task.lease?.holder)
  if (holder === '') return null
  return { id: String(task.id), holder }
}

// Blocked: the reason is the card's own line, never a second copy.
export function blockedOf(task) {
  if (task === null || typeof task !== 'object' || task.status !== 'blocked') return null
  const reason = oneLine(task.inputRequest?.question) || oneLine(task.queueReason) || oneLine(task.title) || ''
  return { id: String(task.id), reason }
}

// A decision is read for its title line only: the head of the file is enough for a heading, and
// the body stays where it is. The bound also keeps a megabyte file from being read to answer one
// line; the hash the reader needs comes from `listProjectState`, not from this read.
const TITLE_BYTES = 4096
const TITLE_MAX = 200
const DECISIONS_MAX = 200
const MEETINGS_MAX = 100

const fileName = path => path.slice(path.lastIndexOf('/') + 1)
// The day a decision file records is the one in its name (`decisions/2026-10-30-x.md`), so two
// files of one day read as one day even when the folder was copied and their mtimes differ.
const dateOfName = (name) => {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(name)
  return match === null ? '' : match[1]
}

async function titleOf(dir, path) {
  let handle
  try {
    handle = await open(join(dir, path), 'r')
    const buffer = Buffer.alloc(TITLE_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, TITLE_BYTES, 0)
    for (const raw of buffer.subarray(0, bytesRead).toString('utf8').split(/\r?\n/)) {
      const line = raw.trim()
      if (line === '') continue
      return line.replace(/^#+\s*/, '').slice(0, TITLE_MAX)
    }
    return ''
  } catch {
    // A file that vanished between the listing and this read answers no title rather than a
    // failed board: the row itself is the other read's.
    return ''
  } finally {
    // Whichever way the read ended, the handle is closed and nothing is left to close.
    if (handle !== undefined) await handle.close().catch(() => { /* nothing left to close */ })
  }
}

// The board a card belongs to. A group card names its room; a Bot card names its owner. A card
// with neither (a run-only card) has no board and resolves through the run's own binding.
const boardOf = (task) => {
  const roomId = text(task?.origin?.roomId)
  if (task?.kind === 'group' && roomId !== '') return { kind: 'group', id: roomId }
  const botId = text(task?.ownerBotId)
  if (botId !== '') return { kind: 'bot', id: botId }
  return null
}

export function install(rt) {
  // The folder a Project's decisions live in. A Project names one itself, and when it names none
  // the folder is the one its members work in — the same folder a meeting resolves through
  // `workDirFor` before it archives a decision, so the reader and the writer look in one place.
  const folderOf = (project) => {
    const own = text(project?.workDir)
    if (own !== '') return own
    for (const room of Object.values(rt.state?.rooms ?? {})) {
      if (room === null || typeof room !== 'object') continue
      const dir = text(room.workDir)
      if (dir !== '' && rt.projectOfMember?.('group', room.id)?.id === project?.id) return dir
    }
    for (const bot of Object.values(rt.state?.bots ?? {})) {
      if (bot === null || typeof bot !== 'object') continue
      const dir = text(bot.workDir)
      if (dir !== '' && rt.projectOfMember?.('bot', bot.id)?.id === project?.id) return dir
    }
    return ''
  }

  const decisionsOf = async (project) => {
    const dir = folderOf(project)
    if (dir === '') return { dir: null, files: [], reason: 'no working folder: this Project names none' }
    let state
    try {
      state = await listProjectState(dir)
    } catch (error) {
      return { dir, files: [], reason: `unreadable: ${error?.message ?? String(error)}` }
    }
    if (state.ok !== true) return { dir, files: [], reason: state.reason }
    const found = state.files
      .filter(file => file.path.startsWith(`${DECISIONS_DIR}/`) && file.path.endsWith('.md'))
      .slice(0, DECISIONS_MAX)
    const files = []
    for (const file of found) {
      const name = fileName(file.path)
      files.push({
        path: file.path,
        name,
        date: dateOfName(name),
        title: await titleOf(dir, file.path),
        bytes: file.bytes,
        sha256: file.sha256,
        mtime: file.mtime,
      })
    }
    return { dir, files, reason: files.length === 0 ? `no decision file in ${join(dir, DECISIONS_DIR)}` : '' }
  }

  // A meeting names the Project it belongs to by id or by name (the tool's `project` argument is
  // free text), so both forms resolve here rather than one being silently dropped.
  const inProject = (meeting, project) => {
    const named = text(meeting?.project).toLowerCase()
    if (named === '') return false
    return [text(project?.id), text(project?.name)]
      .filter(value => value !== '')
      .some(value => value.toLowerCase() === named)
  }

  const meetingsOf = (project, decisions) => {
    const known = new Map(decisions.files.map(file => [file.path, file]))
    const mine = Object.values(rt.state?.meetings ?? {})
      .filter(meeting => meeting !== null && typeof meeting === 'object' && inProject(meeting, project))
      .sort((a, b) => (b.decidedAt ?? b.updatedAt ?? 0) - (a.decidedAt ?? a.updatedAt ?? 0) || String(a.id).localeCompare(String(b.id)))
    const decided = []
    const pending = []
    for (const meeting of mine) {
      const id = text(meeting.id)
      const question = text(meeting.question ?? meeting.title)
      if (meeting.status === 'decided') {
        // A decided meeting is the decision's record, not the file's: the file may have been
        // deleted or copied away, and the meeting still says what was decided. `path` is empty
        // exactly then, and the reader can see the file the record names is gone.
        const named = text(meeting.decisionFile)
        const file = known.get(named)
        decided.push({
          id,
          date: text(meeting.decidedAt) !== '' ? new Date(meeting.decidedAt).toISOString().slice(0, 10) : '',
          question,
          owner: text(meeting.owner) || null,
          path: file === undefined ? '' : file.path,
          ...(file === undefined ? {} : { sha256: file.sha256 }),
        })
        continue
      }
      // Only a decided meeting is a decision. A meeting still open, deliberating or blocked is
      // listed beside those, with the state it is in, so nobody reads a question as an outcome.
      if (meeting.status === 'open' || meeting.status === 'deliberating' || meeting.status === 'blocked') {
        pending.push({
          id,
          date: text(meeting.createdAt) !== '' ? new Date(meeting.createdAt).toISOString().slice(0, 10) : '',
          question,
          status: meeting.status,
          ...(meeting.status === 'blocked' && text(meeting.blockingQuestion) !== '' ? { blockingQuestion: text(meeting.blockingQuestion) } : {}),
        })
      }
    }
    return {
      decided: decided.slice(0, MEETINGS_MAX),
      pending: pending.slice(0, MEETINGS_MAX),
      reason: mine.length === 0 ? 'no meeting of this Project is recorded' : '',
    }
  }

  // One board: the task rows, then the decisions and meetings that read beside them. An unknown
  // Project and a Project with nothing under it both answer empty sections: reading a board is
  // not a reason to throw.
  const projectBoard = async (projectId, actor) => {
    const id = text(projectId)
    const empty = {
      rows: [],
      waiting: [],
      inflight: [],
      blocked: [],
      counts: { waiting: 0, inflight: 0, blocked: 0, done: 0 },
      decisions: { dir: null, files: [], reason: 'no Project: nothing to read' },
      meetings: { decided: [], pending: [], reason: 'no Project: nothing to read' },
    }
    if (id === '') return empty
    const project = rt.readProject?.(id)
    if (!project) return empty
    // A store that cannot be read is not an empty store (#1768): `null` keeps the two apart.
    const tasks = rt.state?.tasks
    const readable = tasks !== null && typeof tasks === 'object'
    const refs = new Map()
    for (const ref of rt.projectRunRefs?.({ hasTask: taskId => Object.hasOwn(tasks ?? {}, taskId) }) ?? []) {
      refs.set(ref.taskId, ref)
    }
    // #1723: a row is painted only when the caller could open that card through `tasks`. The
    // predicate lives in tasks.js (`rt.taskVisible`); a host that has not installed it shows
    // nothing, because an unreadable rule is not a reason to widen a board.
    const visible = typeof rt.taskVisible === 'function' ? rt.taskVisible : () => false
    const rows = []
    const mine = []
    for (const task of readable ? Object.values(tasks) : []) {
      if (task === null || typeof task !== 'object') continue
      if (!visible(task, actor)) continue
      const board = boardOf(task)
      // The Project of the card's own board. A card that has a board already belongs somewhere; a
      // board whose member is unbound names no Project, and only then may a run carry the card.
      const ownProject = board === null ? null : rt.projectOfMember?.(board.kind, board.id)
      const ref = refs.get(task.id)
      const runProject = ref === undefined ? null : rt.projectOfMember?.('run', ref.runId)
      // The card's own board wins, and it is read whether or not it names this Project: a card
      // bound elsewhere is not borrowed through the run that happened to consume it. The run
      // carries only a card with no Project of its own, and it lends its id only to this board
      // — #1713: both halves let the far Project's run put its card here and its id on our row.
      const source = ownProject !== null
        ? ownProject.id === id ? board.kind : null
        : runProject?.id === id ? 'workflow' : null
      if (source === null) continue
      mine.push(task)
      const fromRun = ref !== undefined && (runProject === null || runProject.id === id)
      const audit = typeof rt.taskAudit === 'function' ? rt.taskAudit(task.id) : ''
      rows.push({
        id: task.id,
        source,
        column: columnOf(task),
        assignee: task.assignee ?? null,
        updatedAt: task.updatedAt ?? task.createdAt ?? null,
        // The typed contract (#1720) is read from the same row, not a second copy: a board that
        // shows a rework or a held lease shows what the task store wrote. A record stored before
        // the slice carries none of the keys and reads back exactly as it did.
        ...(task.taskClass ? { taskClass: task.taskClass } : {}),
        ...(task.reworkOf ? { reworkOf: task.reworkOf } : {}),
        ...(task.handoff && typeof task.handoff === 'object' ? { handoff: task.handoff } : {}),
        ...(Array.isArray(task.evidence) ? { evidence: task.evidence } : {}),
        ...(task.lease && typeof task.lease === 'object' ? { lease: task.lease } : {}),
        // The same projection the task store renders (#1730): one text block a card detail can
        // show, with nothing written back. A pre-slice card answers the empty string and the row
        // carries no `audit` key at all.
        ...(audit !== '' ? { audit } : {}),
        ...(fromRun ? { runId: ref.runId, ...(ref.nodeId ? { nodeId: ref.nodeId } : {}) } : {}),
      })
    }
    const done = rows.filter(row => row.column === 'done').length
    // An unreadable store answers unknown (#1768): `0` would claim the queue is empty, and the
    // board must not turn "cannot read" into "nothing waiting".
    const queues = !readable
      ? { waiting: [], inflight: [], blocked: [], counts: { waiting: null, inflight: null, blocked: null, done: null } }
      : buildQueues(mine, done)
    const decisions = await decisionsOf(project)
    return { rows, ...queues, decisions, meetings: meetingsOf(project, decisions) }
  }
  const buildQueues = (mine, done) => {
    const now = typeof rt.now === 'function' ? rt.now() : Date.now()
    const waiting = []
    const inflight = []
    const blocked = []
    for (const task of mine) {
      const wait = waitingOf(task, now)
      if (wait !== null) waiting.push(wait)
      const flight = inflightOf(task)
      if (flight !== null) {
        const lease = task.lease !== null && typeof task.lease === 'object' ? task.lease : null
        const live = lease !== null && Number.isFinite(lease.expiresAt) && lease.expiresAt > now
        inflight.push({ ...flight, lease: lease === null ? 'none' : live ? 'live' : 'expired', stalled: lease !== null && !live })
      }
      const block = blockedOf(task)
      if (block !== null) blocked.push(block)
    }
    // Oldest wait first: the card that has waited longest is the one a person wants next.
    waiting.sort((a, b) => (a.since ?? Infinity) - (b.since ?? Infinity) || a.id.localeCompare(b.id))
    return { waiting, inflight, blocked, counts: { waiting: waiting.length, inflight: inflight.length, blocked: blocked.length, done } }
  }
  rt.projectBoard = projectBoard
  // The three groups are their own read over the same pass, for a caller that wants only the queue.
  rt.projectBoardQueues = async (projectId, actor) => {
    const board = await projectBoard(projectId, actor)
    return { waiting: board.waiting, inflight: board.inflight, blocked: board.blocked, counts: board.counts }
  }
}
