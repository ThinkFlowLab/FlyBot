// Memory recall beyond exact words (#477). The stored files stay the only source of
// truth: everything here is derived from them and can be rebuilt by reading them again.
//
// Two additions over the exact-substring `recall` in memory.js:
//   - Hybrid ranking: a sparse TF-IDF vector per entry over word tokens, CJK
//     uni/bi-grams and word character trigrams, scored against the query by cosine.
//     It finds an entry whose wording differs from the query ("flights" for
//     "fly", "window seat" for "seats by the window characters") without a model
//     and without a dependency; it is derived, offline and deterministic.
//   - A small graph over what memory already links: `[[topic]]` references and the
//     `by:` metadata name Bots. It answers "what else is near this topic / who wrote
//     what" by walking those edges.
//
// Nothing here reads or writes a file. memory.js feeds it entries it already loaded.

// ---------------------------------------------------------------------------
// Tokenization and vectors.

const WORD = /[a-z0-9]+/g
const CJK = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]+/g
const TRIGRAM_WORD_MIN = 4
const WORD_WEIGHT = 1
const CJK_RUN_WEIGHT = 0.7
const CJK_PAIR_WEIGHT = 1
const TRIGRAM_WEIGHT = 0.35

/**
 * Weighted terms of one text: Latin words (weight 1), a character trigram of every
 * word of 4+ letters (weight 0.35, so a shared stem counts without matching every
 * substring), and for CJK runs each unigram (0.7) and bigram (1).
 */
export function termsOf(text) {
  const lower = String(text ?? '').toLowerCase()
  const terms = new Map()
  const add = (term, weight) => terms.set(term, (terms.get(term) ?? 0) + weight)
  for (const [word] of lower.matchAll(WORD)) {
    if (word.length < 2) continue
    add(word, WORD_WEIGHT)
    if (word.length >= TRIGRAM_WORD_MIN) {
      for (let at = 0; at + 3 <= word.length; at += 1) add(`#${word.slice(at, at + 3)}`, TRIGRAM_WEIGHT)
    }
  }
  for (const [run] of lower.matchAll(CJK)) {
    for (let at = 0; at < run.length; at += 1) {
      add(run[at], CJK_RUN_WEIGHT)
      if (at + 1 < run.length) add(run.slice(at, at + 2), CJK_PAIR_WEIGHT)
    }
  }
  return terms
}

/**
 * A sparse index over entries. `docs` is [{ key, text, ...rest }]; `rest` is carried
 * back with each hit, so a caller keeps the entry, its file and its scope. IDF uses
 * document frequency across the given entries, so two entries sharing a rare word
 * score higher than two sharing "the".
 */
export function buildIndex(docs) {
  const prepared = docs.map(doc => ({ key: doc.key, doc, terms: termsOf(doc.ref ?? doc.text) }))
  const df = new Map()
  for (const item of prepared) for (const term of item.terms.keys()) df.set(term, (df.get(term) ?? 0) + 1)
  const total = Math.max(1, prepared.length)
  const idf = term => Math.log((total + 1) / ((df.get(term) ?? 0) + 1)) + 1
  const vectors = prepared.map((item) => {
    const vec = new Map()
    let norm = 0
    for (const [term, weight] of item.terms) {
      const value = weight * idf(term)
      vec.set(term, value)
      norm += value * value
    }
    return { key: item.key, doc: item.doc, vec, norm: Math.sqrt(norm) || 1 }
  })
  return { vectors, idf, size: total }
}

/**
 * Entries ranked by cosine similarity to `text`, best first. Only entries with a
 * positive score are returned; `k` bounds the list.
 */
export function searchIndex(index, text, { k = 10 } = {}) {
  const terms = termsOf(text)
  if (terms.size === 0) return []
  let qnorm = 0
  const query = new Map()
  for (const [term, weight] of terms) {
    const value = weight * index.idf(term)
    query.set(term, value)
    qnorm += value * value
  }
  qnorm = Math.sqrt(qnorm) || 1
  const scored = []
  for (const vector of index.vectors) {
    let dot = 0
    for (const [term, value] of query) {
      const other = vector.vec.get(term)
      if (other !== undefined) dot += value * other
    }
    if (dot > 0) scored.push({ doc: vector.doc, score: dot / (qnorm * vector.norm) })
  }
  scored.sort((a, b) => b.score - a.score || String(a.doc.key).localeCompare(String(b.doc.key)))
  return scored.slice(0, Math.max(0, k))
}

// ---------------------------------------------------------------------------
// The graph of what memory links: [[topic]] references and `by:` writers.

const LINK = /\[\[([^\]]+)\]\]/g

const nodeId = (kind, name) => `${kind}:${String(name).trim().toLowerCase()}`
export const topicNode = topic => ({ kind: 'topic', name: String(topic) })
export const botNode = name => ({ kind: 'bot', name: String(name) })

/**
 * Builds nodes and directed edges from loaded files. `files` is [{ topic, entries }]
 * where `entries` is [{ text, meta }]; a file with no topic is the MEMORY.md entry
 * point and is named "memory". An entry in a topic that links [[other]] adds topic →
 * topic; an entry whose meta names `by:` adds the file's topic (or "memory") → bot.
 */
export function buildGraph(files) {
  const nodes = new Map()
  const edges = []
  const seenEdge = new Set()
  const touch = (node) => {
    const id = nodeId(node.kind, node.name)
    if (!nodes.has(id)) nodes.set(id, { id, kind: node.kind, name: String(node.name) })
    return id
  }
  const addEdge = (from, to, kind) => {
    if (from === to) return
    const key = `${from}->${to}:${kind}`
    if (seenEdge.has(key)) return
    seenEdge.add(key)
    edges.push({ from, to, kind })
  }
  for (const file of files) {
    const topic = file.topic === undefined ? 'memory' : String(file.topic)
    const fromId = touch(topicNode(topic))
    for (const entry of file.entries ?? []) {
      for (const [, link] of String(entry.text ?? '').matchAll(LINK)) {
        const to = link.trim()
        if (to === '') continue
        addEdge(fromId, touch(topicNode(to)), 'link')
      }
      const by = entry.meta?.by
      if (typeof by === 'string' && by.trim() !== '') addEdge(fromId, touch(botNode(by.trim())), 'by')
    }
  }
  return { nodes, edges, has: node => nodes.has(nodeId(node.kind, node.name)), id: node => nodeId(node.kind, node.name) }
}

/**
 * Nodes `hops` steps from `start` (default 1), with the edge that reached each. The
 * walk is undirected: a Bot that wrote a topic and a topic a Bot wrote are both
 * neighbours, which is what "what is near this" means to a reader.
 */
export function relatedOf(graph, start, { hops = 1, max = 40 } = {}) {
  const from = graph.id(start)
  if (!graph.nodes.has(from)) return { start: null, neighbours: [] }
  const adjacency = new Map()
  for (const edge of graph.edges) {
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, [])
    if (!adjacency.has(edge.to)) adjacency.set(edge.to, [])
    adjacency.get(edge.from).push({ id: edge.to, kind: edge.kind })
    adjacency.get(edge.to).push({ id: edge.from, kind: edge.kind })
  }
  const best = new Map()
  let frontier = [from]
  const reached = new Set([from])
  for (let step = 1; step <= Math.max(1, hops); step += 1) {
    const next = []
    for (const id of frontier) {
      for (const link of adjacency.get(id) ?? []) {
        if (reached.has(link.id)) continue
        reached.add(link.id)
        best.set(link.id, { distance: step, via: link.kind })
        next.push(link.id)
      }
    }
    frontier = next
    if (frontier.length === 0) break
  }
  const neighbours = [...best.entries()]
    .map(([id, info]) => ({ ...graph.nodes.get(id), distance: info.distance, via: info.via }))
    .sort((a, b) => a.distance - b.distance || a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name))
    .slice(0, max)
  return { start: graph.nodes.get(from), neighbours }
}
