// Directory and search over a memory panel view. The host already loaded the
// entries; this file only groups them into topics and filters them, so the
// panel can draw a real catalog without inventing pages or a graph.

export function memoryTopics(entries) {
  const map = new Map()
  for (const entry of entries ?? []) {
    const scope = entry.scope === 'team' ? 'team' : 'own'
    const topic = typeof entry.topic === 'string' && entry.topic.trim() !== '' ? entry.topic : null
    const key = `${scope}:${topic ?? ''}`
    const item = map.get(key)
    if (item) item.count += 1
    else map.set(key, { scope, topic, count: 1 })
  }
  return [...map.values()].sort((a, b) => {
    if (a.scope !== b.scope) return a.scope === 'own' ? -1 : 1
    if ((a.topic === null) !== (b.topic === null)) return a.topic === null ? -1 : 1
    return String(a.topic ?? '').localeCompare(String(b.topic ?? ''))
  })
}

export function memoryStats(entries) {
  const list = entries ?? []
  const topics = new Set()
  for (const entry of list) {
    if (typeof entry.topic === 'string' && entry.topic.trim() !== '') topics.add(`${entry.scope === 'team' ? 'team' : 'own'}:${entry.topic.trim()}`)
  }
  return { entries: list.length, topics: topics.size }
}

// Every whitespace-separated term must appear in the entry text, topic, or author.
export function filterMemoryEntries(entries, query) {
  const terms = String(query ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return [...(entries ?? [])]
  return (entries ?? []).filter((entry) => {
    const hay = `${entry.text ?? ''} ${entry.topic ?? ''} ${entry.by ?? ''}`.toLowerCase()
    return terms.every(term => hay.includes(term))
  })
}

export function topicKey(item) {
  if (!item) return ''
  return `${item.scope === 'team' ? 'team' : 'own'}:${item.topic ?? ''}`
}

export function sameTopic(a, b) {
  return Boolean(a) && Boolean(b) && topicKey(a) === topicKey(b)
}
