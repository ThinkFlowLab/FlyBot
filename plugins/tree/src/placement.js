// Placement and repair (#446). Every local Bot that is not in the tree yet (core create_bot, the
// Bot list, an older install) is placed under the same limits create_child_bot obeys, so no create
// path goes past maxChildren or maxDepth. A full level never leaves a Bot outside the tree:
//   1. a level with room takes it;
//   2. else the best-matching Bot below that level takes it (shared name words, or the same short
//      role label), so related Bots end up as a lead with children;
//   3. else the level is consolidated: siblings that match each other move under their oldest
//      member (the lead) until there is room;
//   4. else it goes one level down, under the child with the fewest descendants (oldest first).
// An over-full parent (e.g. after a deletion) is repaired the same way. Nothing is ever deleted:
// Bots are only reparented, each move is logged, and the sidebar draws the same tree.
const GENERIC = new Set(['bot', 'bots', 'agent', 'agents', 'team', 'the', 'and', 'for', 'of', 'ai', 'main', 'new'])
const MAX_ROLE_LABEL = 24 // ds-bot role labels are 2-4 words; longer text is a description, not a label
const norm = s => String(s ?? '').trim().toLowerCase()

/** Match keys of a Bot: its name's words, plus its short role label. */
export function matchKeys({ name, role }) {
  const keys = new Set(norm(name).split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 2 && !GENERIC.has(w)))
  const label = norm(role)
  if (label && label.length <= MAX_ROLE_LABEL) keys.add(`role:${label}`)
  return keys
}
export function fitScore(a, b) {
  const kb = matchKeys(b)
  let n = 0
  for (const k of matchKeys(a)) if (kb.has(k)) n++
  return n
}

export function createPlacement({ fb, limits, snapshot, childrenOf, depthOf, warn }) {
  // Breadth first, siblings in creation order: shallower and older Bots come first.
  const subtreeOf = (nodes, id) => {
    const out = [], queue = [id], seen = new Set()
    while (queue.length) {
      const x = queue.shift()
      if (seen.has(x) || !nodes[x]) continue
      seen.add(x); out.push(x)
      for (const c of childrenOf(nodes, x)) queue.push(c.id)
    }
    return out
  }
  const heightOf = (nodes, id) => {
    let h = 0
    const walk = (x, d, seen) => { if (seen.has(x)) return; seen.add(x); h = Math.max(h, d); for (const c of childrenOf(nodes, x)) walk(c.id, d + 1, seen) }
    walk(id, 1, new Set())
    return h
  }
  // x = { id, name, role, height }: the Bot to place, with the height of its own subtree.
  const canHost = (nodes, hostId, x) => {
    const kids = childrenOf(nodes, hostId).filter(c => c.id !== x.id)
    return hostId !== x.id && kids.length < limits.maxChildren && depthOf(nodes, hostId) + x.height <= limits.maxDepth &&
      !kids.some(c => norm(c.name) === norm(x.name)) // never two siblings with one name (checkCreate's rule)
  }
  const describe = (nodes, id) => ({ id, name: nodes[id].name, role: nodes[id].role, height: heightOf(nodes, id) })

  /** The best-matching Bot below parentId (not parentId itself, not x's own subtree) that can take x. */
  function bestMatch(nodes, parentId, x) {
    const own = new Set(nodes[x.id] ? subtreeOf(nodes, x.id) : [])
    let best, bestScore = 0, bestDepth = Infinity
    for (const id of subtreeOf(nodes, parentId)) {
      if (id === parentId || own.has(id)) continue
      const score = fitScore(x, nodes[id]), depth = depthOf(nodes, id)
      if (score > bestScore || (score > 0 && score === bestScore && depth < bestDepth)) {
        if (!canHost(nodes, id, x)) continue
        best = id; bestScore = score; bestDepth = depth
      }
    }
    return best
  }
  /** One level down: the child of parentId with the fewest descendants (oldest first) that can take x, recursively. */
  function levelDown(nodes, parentId, x) {
    const kids = childrenOf(nodes, parentId).filter(c => c.id !== x.id)
      .map((c, i) => ({ id: c.id, size: subtreeOf(nodes, c.id).length, i }))
      .sort((a, b) => (a.size - b.size) || (a.i - b.i))
    for (const k of kids) if (canHost(nodes, k.id, x)) return k.id
    for (const k of kids) { const deeper = levelDown(nodes, k.id, x); if (deeper) return deeper }
    return undefined
  }

  const move = (id, parentId, why) => {
    const nodes = snapshot()
    fb.setField(id, 'parent', parentId)
    warn(`flybot-tree: moved ${nodes[id]?.name ?? fb.getBot?.(id)?.name ?? id} under ${nodes[parentId]?.name ?? parentId} (${why})`)
  }

  /** Moves matching children of parentId under their oldest member until it has at most `target` children. */
  function consolidate(parentId, target) {
    for (let guard = 0; guard < 64; guard++) {
      const nodes = snapshot()
      const kids = childrenOf(nodes, parentId)
      if (kids.length <= target) return true
      const groups = new Map()
      for (const c of kids) for (const k of matchKeys(c)) { if (!groups.has(k)) groups.set(k, []); groups.get(k).push(c) }
      const ordered = [...groups.values()].filter(g => g.length > 1).sort((a, b) => b.length - a.length)
      let moved = false
      for (const group of ordered) {
        for (const lead of group) {
          const x = [...group].reverse().find(c => c.id !== lead.id && canHost(nodes, lead.id, describe(nodes, c.id)))
          if (!x) continue
          move(x.id, lead.id, `${nodes[parentId].name} was over maxChildren=${limits.maxChildren}; grouped with ${lead.name}`)
          moved = true
          break
        }
        if (moved) break
      }
      if (!moved) return false
    }
    return childrenOf(snapshot(), parentId).length <= target
  }

  /** Where x goes when it should be under parentId: parentId itself, or a Bot below it. undefined when the whole subtree is full. */
  function homeFor(parentId, x) {
    let nodes = snapshot()
    if (canHost(nodes, parentId, x)) return { id: parentId }
    const match = bestMatch(nodes, parentId, x)
    if (match) return { id: match, why: `closest match for ${x.name}` }
    if (consolidate(parentId, limits.maxChildren - 1)) {
      nodes = snapshot()
      if (canHost(nodes, parentId, x)) return { id: parentId }
    }
    nodes = snapshot()
    const down = levelDown(nodes, parentId, x)
    return down ? { id: down, why: `${nodes[parentId].name} is full (maxChildren=${limits.maxChildren}); no closer match` } : undefined
  }

  /** Places a Bot that is not in the tree yet. Returns the new parent id, or undefined if nothing can take it. */
  function place(bot, rootId) {
    const role = String(bot.role ?? '').trim()
    const home = homeFor(rootId, { id: bot.id, name: bot.name, role, height: 1 })
    if (!home) return undefined
    fb.setField(bot.id, 'treeRole', role)
    fb.setField(bot.id, 'parent', home.id)
    if (home.why) warn(`flybot-tree: placed ${bot.name} under ${snapshot()[home.id].name} (${home.why})`)
    return home.id
  }

  /** Brings every over-full parent back to maxChildren by reparenting its newest children. Returns true if anything moved. */
  function repair() {
    let changed = false
    for (let guard = 0; guard < 256; guard++) {
      const nodes = snapshot()
      const over = Object.keys(nodes).find(id => childrenOf(nodes, id).length > limits.maxChildren)
      if (!over) return changed
      if (consolidate(over, limits.maxChildren)) { changed = true; continue }
      const now = snapshot()
      const kids = childrenOf(now, over)
      const x = describe(now, kids[kids.length - 1].id)
      const home = bestMatch(now, over, x) ?? levelDown(now, over, x)
      if (!home) { warn(`flybot-tree: ${now[over].name} has ${kids.length} children (maxChildren=${limits.maxChildren}) and no Bot below it can take more; kept all`); return changed }
      move(x.id, home, `${now[over].name} was over maxChildren=${limits.maxChildren}`)
      changed = true
    }
    return changed
  }

  return { place, repair }
}
