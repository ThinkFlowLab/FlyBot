// Task-card identity for the per-Bot board. The key is `task:<id>`, which the client's
// BoardCard puts on `data-key`. Nothing here fetches, writes or reads a clock.

export function taskCardKey(id) {
  const text = String(id ?? '').trim()
  return text === '' ? null : `task:${text}`
}

// A task record (`src/host/tasks.js`) as a card. The record's own fields stay on the record:
// the card carries what it draws, and the view reads the rest from the task it was built from.
export function taskCard(task) {
  const key = taskCardKey(task?.id)
  if (key === null) return null
  return {
    source: 'task',
    key,
    id: String(task.id),
    title: String(task.title ?? ''),
  }
}
