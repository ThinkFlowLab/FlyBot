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

export function priorityOf(task) {
  return PRIORITIES.includes(task?.priority) ? task.priority : 'normal'
}

export function progressOf(task) {
  const value = task?.progress
  if (typeof value !== 'number' || !Number.isFinite(value)) return columnOf(task) === 'done' && task?.status !== 'cancelled' && task?.status !== 'failed' ? 100 : 0
  return Math.max(0, Math.min(100, Math.round(value)))
}
