// Board columns for the task records in src/host/tasks.js (#1058).
// The state machine stays the record. A column is how the board reads it.
// result-ready still waits for acceptance, so it stays In progress.

export const COLUMNS = ['not-started', 'in-progress', 'done']
export const PRIORITIES = ['urgent', 'high', 'normal', 'low']

const COLUMN_OF = {
  open: 'not-started',
  claimed: 'not-started',
  working: 'in-progress',
  blocked: 'in-progress',
  'result-ready': 'in-progress',
  accepted: 'done',
  cancelled: 'done',
  failed: 'done',
}

export function columnOf(task) {
  return COLUMN_OF[task?.status] ?? 'not-started'
}

// WIP = 1 (#1247) counts the work the member is still doing: a claimed or working card fills its
// one slot. A blocked card waits on a person, and a delivered card waits on its requester (#1744),
// so neither counts — one unanswered question or one undecided delivery must not freeze the member
// out of the queue. The column reading above is unchanged: such a card still shows In progress.
export function occupiesSlot(task) {
  return task?.status === 'claimed' || task?.status === 'working'
}

export function priorityOf(task) {
  return PRIORITIES.includes(task?.priority) ? task.priority : 'normal'
}

const PRIORITY_RANK = { urgent: 0, high: 1, normal: 2, low: 3 }

function workBucket(task) {
  if (task?.status === 'open' || task?.status === 'claimed' || task?.status === 'working') return 0
  if (task?.status === 'blocked' || task?.status === 'result-ready') return 1
  return 2
}

// What to continue next (#1099): unfinished before finished, higher priority
// before lower, and an in-progress task before one that has not started.
export function compareForWork(a, b) {
  const byBucket = workBucket(a) - workBucket(b)
  if (byBucket !== 0) return byBucket
  const byPriority = (PRIORITY_RANK[priorityOf(a)] ?? 2) - (PRIORITY_RANK[priorityOf(b)] ?? 2)
  if (byPriority !== 0) return byPriority
  const byWorking = (a?.status === 'working' ? 0 : 1) - (b?.status === 'working' ? 0 : 1)
  if (byWorking !== 0) return byWorking
  return (b?.updatedAt ?? 0) - (a?.updatedAt ?? 0)
}

// A role label, matched the way a person reads it (#1247): free text, trimmed, case-insensitive.
// The label is not a membership role (`admin` / `member`), so nothing here reads that field.
export function sameRole(a, b) {
  const left = String(a ?? '').trim().toLowerCase()
  const right = String(b ?? '').trim().toLowerCase()
  return left !== '' && left === right
}

// Queue order (#1247): the highest priority first, then the item that has waited longest.
// compareForWork cannot be reused — its tiebreak is newest first (`task-board.js`), which
// starves the oldest item and would make the "oldest wait" on the board a lie.
export function compareForQueue(a, b) {
  const byPriority = (PRIORITY_RANK[priorityOf(a)] ?? 2) - (PRIORITY_RANK[priorityOf(b)] ?? 2)
  if (byPriority !== 0) return byPriority
  return (a?.createdAt ?? 0) - (b?.createdAt ?? 0)
}

export function progressOf(task) {
  const value = task?.progress
  if (typeof value !== 'number' || !Number.isFinite(value)) return columnOf(task) === 'done' && task?.status !== 'cancelled' && task?.status !== 'failed' ? 100 : 0
  return Math.max(0, Math.min(100, Math.round(value)))
}
