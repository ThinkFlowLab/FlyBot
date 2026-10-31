// One Project, one board read model (#1696). The core task record is the identity: a workflow
// run names the same id through `run.task.id` and never mints a second task, so a card a run
// consumed is one row that carries the run, not two views of the same work.
//
// #1767 adds the other half of the record beside the cards: the `decisions/*.md` files of the
// Project's working folder and the meetings that reached `decided`. It is the same read — the
// folder goes through `listProjectState`, which already hashes every file, and a decision file
// is listed with a name, a date and one title line, never its body. #1809 adds the second source:
// `decide` archives in the Session's working folder, so each decided meeting names the folder it
// wrote to (`decisionDir`) and the board reads that one file beside the Project folder.
//
// #1768 adds the queue beside those: the waiting cards of a role queue, the cards a claim holds
// (with its lease live or stalled) and the blocked cards, each with the line it already stores.
// They are derived from the same `state.tasks` pass as the rows, never a second store.
//
// Read-only by construction: it reads `state.tasks`, `state.meetings` and the Project bindings,
// asks each registered provider for the workflow refs of tasks that still exist, and returns the
// sections. It writes nothing, starts nothing and is not called unless someone asks for the board.
import { open, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { columnOf } from '../shared/task-board.js'
import { DECISIONS_DIR, listProjectState, sha256 } from './project-state.js'
import { advanceRefusal } from './meetings.js'
import { readMetrics } from './project-metrics.js'

// #1828: a Project's roles. The record stores only `roles: { maintainers, members }`; the owner
// is read from `ownerUserIds`, never stored twice, so the two cannot disagree. A record written
// before this slice carries no `roles` and derives to owner-only — no migration pass.
export const PROJECT_ROLE_RANKS = { member: 1, maintainer: 2, owner: 3 }
const roleList = value => (Array.isArray(value) ? [...new Set(value.map(id => text(id)).filter(id => id !== ''))] : [])
export function rolesOf(project) {
  const owner = roleList(project?.ownerUserIds)
  const primary = text(project?.ownerUserId)
  if (primary !== '' && !owner.includes(primary)) owner.unshift(primary)
  const stored = project?.roles !== null && typeof project?.roles === 'object' ? project.roles : {}
  const maintainers = roleList(stored.maintainers).filter(id => !owner.includes(id))
  const members = roleList(stored.members).filter(id => !owner.includes(id) && !maintainers.includes(id))
  return { owner, maintainers, members }
}
export function roleOf(project, memberId) {
  const id = text(memberId)
  if (id === '') return null
  const roles = rolesOf(project)
  if (roles.owner.includes(id)) return 'owner'
  if (roles.maintainers.includes(id)) return 'maintainer'
  if (roles.members.includes(id)) return 'member'
  return null
}
// The roles a caller may switch a target to: the current one is not repeated, and the Owner rank
// is never an assignment (transfer is a separate slice). A Member sees nothing, a Maintainer
// sees only Member, and an Owner acting on anyone else sees the two assignable ranks.
export function roleChoices(project, actorId, targetId = actorId) {
  const actor = roleOf(project, actorId)
  const self = text(targetId) === text(actorId)
  const target = self ? actor : roleOf(project, targetId)
  const choices = []
  // The Owner of a Project never drops its own rank here: the menu shows only the current item.
  if (self && actor === 'owner') return choices
  for (const role of ['maintainer', 'member']) {
    if (role === target) continue
    if (actor === 'owner') choices.push(role)
    else if (self && actor !== null && PROJECT_ROLE_RANKS[role] < PROJECT_ROLE_RANKS[actor]) choices.push(role)
  }
  return choices
}
// The policy Chief's matrix (2026-10-30) fixes, in one place the endpoint and the menu both read:
// only an Owner re-roles someone else, nobody promotes themselves, and a Project always keeps its
// Owner. Returns the next stored roles on success and a machine-readable reason on refusal; the
// caller's record is untouched either way.
export function changeRole(project, { actorId, targetId, role } = {}) {
  const actor = roleOf(project, actorId)
  const self = text(targetId) === '' || text(targetId) === text(actorId)
  const target = self ? text(actorId) : text(targetId)
  const wanted = text(role)
  const current = rolesOf(project)
  // #1838: a plain object answers for names it inherits, so `toString` used to read as a rank and
  // fall through to the demote path. Only an own key of the table is a role.
  if (!Object.hasOwn(PROJECT_ROLE_RANKS, wanted)) return { ok: false, reason: 'unknown-role' }
  if (wanted === 'owner') return { ok: false, reason: 'owner-not-assignable' }
  if (actor === null) return { ok: false, reason: 'not-owner' }
  if (self) {
    if (actor === 'owner') return { ok: false, reason: 'last-owner' }
    if (PROJECT_ROLE_RANKS[wanted] > PROJECT_ROLE_RANKS[actor]) return { ok: false, reason: 'cannot-self-promote' }
  } else if (actor !== 'owner') {
    return { ok: false, reason: 'not-owner' }
  } else if (current.owner.includes(target)) {
    return { ok: false, reason: 'last-owner' }
  }
  const maintainers = current.maintainers.filter(id => id !== target)
  const members = current.members.filter(id => id !== target)
  if (wanted === 'maintainer') maintainers.push(target)
  else members.push(target)
  return { ok: true, roles: { maintainers, members } }
}

const text = value => (typeof value === 'string' ? value.trim() : '')

// The queue, the leases and the blocked cards are host truth the board never copied (#1768):
// a member's role queue is `queueRole` on an open card with no `claimedBy` (`tasks.js`), a lease is
// the one `tasks.js` writes, and a blocked card already stores the question it waits on. This read
// derives those three groups from those fields, oldest wait first, and writes nothing.
// The column a finished card reads (#1855): the archive key, never a row.
const DONE_COLUMN = 'done'
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

// #1831: the level, the recipients and whether the card may advance, read off a meeting record.
// Exported so the read model and its unit test share one projection: a card cannot mean one
// thing on the board and another in the test.
export function decisionCardOf(meeting) {
  const level = ['ordinary', 'major', 'severe'].includes(text(meeting?.level)) ? text(meeting.level) : 'ordinary'
  const recipients = Array.isArray(meeting?.recipients)
    ? meeting.recipients.map(item => text(typeof item === 'string' ? item : item?.name)).filter(name => name !== '')
    : []
  // #1861: the board says who spoke for whom, so a proxy position reads as one. A participant with
  // no speaksFor is the person themselves; nothing is inferred.
  const participants = Array.isArray(meeting?.participants)
    ? meeting.participants
      .map(participant => ({
        name: text(participant?.name),
        speaksFor: text(participant?.speaksFor ?? participant?.position?.speaksFor) || null,
        stance: text(participant?.position?.stance) || null,
        silent: participant?.silent === true,
      }))
      .filter(participant => participant.name !== '')
    : []
  const refusal = advanceRefusal(meeting)
  return { level, recipients, participants, advance: refusal === undefined ? { allowed: true } : { allowed: false, reason: refusal } }
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

  // The file a decided meeting archived (#1809): read from the folder the record names, and only
  // that one file — two folder-less Projects share the team folder, so a folder read whole would
  // show each Project the other's decisions. A record written before this slice names no folder
  // and resolves through the Project folder exactly as it did.
  const archivedOf = async (meeting) => {
    const dir = text(meeting?.decisionDir)
    const path = text(meeting?.decisionFile)
    if (dir === '' || !path.startsWith(`${DECISIONS_DIR}/`) || !path.endsWith('.md')) return undefined
    try {
      const bytes = await readFile(join(dir, path))
      const info = await stat(join(dir, path))
      return { dir, path, bytes: bytes.length, sha256: sha256(bytes), mtime: new Date(info.mtimeMs).toISOString() }
    } catch {
      // Absent or unreadable is not a row: the meeting keeps its own record, with no path.
      return undefined
    }
  }

  const decisionsOf = async (project) => {
    const dir = folderOf(project)
    const folders = []
    const found = []
    if (dir !== '') {
      folders.push(dir)
      let state
      try {
        // The board's own read takes no repository gate (#1809): a decision file is the board's
        // artifact, and a Project folder is not a repository in a default install.
        state = await listProjectState(dir, { repository: false })
      } catch (error) {
        return { dir, files: [], reason: `unreadable: ${error?.message ?? String(error)}` }
      }
      if (state.ok !== true) return { dir, files: [], reason: state.reason }
      found.push(...state.files
        .filter(file => file.path.startsWith(`${DECISIONS_DIR}/`) && file.path.endsWith('.md'))
        .map(file => ({ ...file, dir })))
    }
    // The other source: the folder each decided meeting of this Project recorded, one file each.
    for (const meeting of Object.values(rt.state?.meetings ?? {})) {
      if (meeting === null || typeof meeting !== 'object' || meeting.status !== 'decided') continue
      if (!inProject(meeting, project)) continue
      const archivedDir = text(meeting.decisionDir)
      if (archivedDir !== '' && !folders.includes(archivedDir)) folders.push(archivedDir)
      const archived = await archivedOf(meeting)
      if (archived !== undefined) found.push(archived)
    }
    // One row per path — the client keys a row by path, and the Project folder was read first.
    const seen = new Set()
    const chosen = found
      .filter((file) => {
        if (seen.has(file.path)) return false
        seen.add(file.path)
        return true
      })
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .slice(0, DECISIONS_MAX)
    const files = []
    for (const file of chosen) {
      const name = fileName(file.path)
      files.push({
        path: file.path,
        name,
        date: dateOfName(name),
        title: await titleOf(file.dir, file.path),
        bytes: file.bytes,
        sha256: file.sha256,
        mtime: file.mtime,
      })
    }
    const reason = files.length > 0
      ? ''
      : folders.length === 0
        ? 'no working folder: this Project names none'
        : folders.length === 1
          ? `no decision file in ${join(folders[0], DECISIONS_DIR)}`
          : 'no decision file in any folder the record names'
    return { dir: dir === '' ? null : dir, files, reason }
  }

  // #1831: the card's level, who it is addressed to and whether it may advance ride on every
  // meeting row; the projection is the exported one, so the board and its test cannot disagree.
  const cardOf = decisionCardOf

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
          ...cardOf(meeting),
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
          ...cardOf(meeting),
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
  const projectBoard = async (projectId, actor, options = {}) => {
    const id = text(projectId)
    const empty = {
      rows: [],
      // #1855: the finished cards are the archive beside the rows, not rows of their own. A Project
      // that months of work already closed reads as the work in flight plus one count.
      done: [],
      waiting: [],
      inflight: [],
      blocked: [],
      counts: { waiting: 0, inflight: 0, blocked: 0, done: 0 },
      decisions: { dir: null, files: [], reason: 'no Project: nothing to read' },
      meetings: { decided: [], pending: [], reason: 'no Project: nothing to read' },
      metrics: { ok: false, reason: 'no Project: nothing to read', metrics: {}, running: [] },
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
        // #1831: "who is doing" is the claim, not the assignee label, and "who is speaking for
        // whom" is `speaksFor` — the Assistant writing for a user says so. Both are host truth
        // the client only prints; a card carrying neither reads exactly as it did.
        ...(text(task.claimedBy) !== '' ? { holder: text(task.claimedBy) } : {}),
        ...(text(task.speaksFor) !== '' ? { speaksFor: text(task.speaksFor) } : {}),
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
    // #1855: a card in the `done` column is a finished record, not work in flight — the archive
    // read keeps it (in the same row shape and order) under `done`, and `rows` carries the rest.
    // Only `done` leaves here: a rework, a blocked card and a waiting card are still rows, because
    // the board is where a reader looks for the work that is still somebody's.
    const done = rows.filter(row => row.column === DONE_COLUMN)
    const open = rows.filter(row => row.column !== DONE_COLUMN)
    // An unreadable store answers unknown (#1768): `0` would claim the queue is empty, and the
    // board must not turn "cannot read" into "nothing waiting".
    const queues = !readable
      ? { waiting: [], inflight: [], blocked: [], counts: { waiting: null, inflight: null, blocked: null, done: null } }
      : buildQueues(mine, done.length)
    const decisions = await decisionsOf(project)
    // #1829: the seven numbers ride on the same read as the rows, so the board and its header
    // cannot disagree, and a credential-less host answers `ok: false` (the client paints a dash).
    // #1848: the running table and the done-task median read `mine` — exactly the cards this
    // reader was allowed above — never the deployment's task table.
    const metrics = await readMetrics({
      repo: text(rt.githubRepo) || 'ThinkFlowLab/FlyBot',
      token: text(rt.secretValue?.('GITHUB_TOKEN')),
      fetchImpl: globalThis.fetch,
      timeZone: text(options.timeZone) || 'UTC',
      now: typeof rt.now === 'function' ? rt.now() : Date.now(),
      tasks: mine,
    })
    return { rows: open, done, ...queues, decisions, meetings: meetingsOf(project, decisions), metrics }
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
  // #1828: the endpoint the host calls for a role switch. It answers the policy's own decision;
  // the store is what persists the two assignable lists.
  rt.projectRole = (project, { actorId, targetId, role } = {}) => changeRole(project, { actorId, targetId, role })
  // The listing's own read (#1828): the caller's rank and the ranks they may switch to. Both are
  // the functions the endpoint uses, so the sidebar menu offers exactly what the host accepts.
  rt.projectRoleOf = (project, memberId) => roleOf(project, memberId)
  rt.projectRoleChoices = (project, memberId) => roleChoices(project, memberId)
  rt.projectBoard = projectBoard
  // The three groups are their own read over the same pass, for a caller that wants only the queue.
  rt.projectBoardQueues = async (projectId, actor) => {
    const board = await projectBoard(projectId, actor)
    return { waiting: board.waiting, inflight: board.inflight, blocked: board.blocked, counts: board.counts }
  }
}
