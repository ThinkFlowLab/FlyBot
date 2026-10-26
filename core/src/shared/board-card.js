// One card behind two boards (#1265, step 1). The delivery board reads GitHub, the task board
// reads FlyBot's task records; on screen they are the same object, so a card says which side it
// came from and carries a key that is unique across both.
//
// A repository card is keyed by `owner/name#number`, not by kind: one issue is one card whether the
// row arrived as an issue or as the pull request that closes it, which is what lets step 3 hang a
// FlyBot record under the issue it belongs to. A task keeps its own id under `task:`. Nothing here
// fetches, writes or reads a clock.

export const CARD_SOURCES = ['github', 'task']

export function githubCardKey(repo, number) {
  const name = typeof repo === 'string' ? repo.trim() : ''
  const value = Number(number)
  if (name === '' || !Number.isInteger(value) || value <= 0) return null
  return `${name}#${value}`
}

export function taskCardKey(id) {
  const text = String(id ?? '').trim()
  return text === '' ? null : `task:${text}`
}

const repoOf = (repo) => (typeof repo === 'string' && repo.trim() !== '' ? repo.trim() : null)

// A delivery-board row (`cardOf` in src/host/delivery-board.js) as a card. Without a repository
// there is no cross-repository identity, so the key falls back to the row's kind and number
// instead of implying one.
export function githubCard(row, repo) {
  const number = Number(row?.number)
  if (!Number.isInteger(number) || number <= 0) return null
  const name = repoOf(repo)
  return {
    source: 'github',
    key: githubCardKey(name, number) ?? `github:${row.kind ?? 'item'}:${number}`,
    repo: name,
    number,
    kind: row.kind ?? null,
    title: String(row.title ?? ''),
    badge: row.badge ?? null,
    labels: Array.isArray(row.labels) ? row.labels.slice() : [],
    owner: row.owner ?? null,
    ownerKind: row.ownerKind ?? null,
    linked: row.linked ?? null,
    sha: row.sha ?? null,
    url: row.url ?? null,
  }
}

// A task record (`src/host/tasks.js`) as a card. The record's own fields stay on the record: the
// card carries what it draws, and the view reads the rest from the task it was built from.
export function taskCard(task) {
  const key = taskCardKey(task?.id)
  if (key === null) return null
  return {
    source: 'task',
    key,
    id: String(task.id),
    repo: repoOf(task.repo),
    number: null,
    kind: 'task',
    title: String(task.title ?? ''),
    badge: null,
    labels: [],
    owner: null,
    ownerKind: null,
    linked: null,
    sha: null,
    url: null,
  }
}

// Two cards are the same card when they answer the same key, which is the identity step 3 hangs a
// task record on. Kept here so both sides dedupe the same way.
export function sameCard(a, b) {
  return Boolean(a?.key) && a.key === b?.key
}
