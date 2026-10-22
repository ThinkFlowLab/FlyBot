// Tree model over per-bot fields (all sync, namespaced to 'flybot-tree'). Fields used:
//   parent:   parent bot id (absent/null for the root)    (the tree edge)
//   treeRole: role description; 'root' marks the root      (marks a bot as a tree member)
// Self-organization (src/organize.js, #446) also keeps: lead { key, label } on a group lead,
// archived { at, reason, parent, treeRole, into? } on an archived Bot (out of the tree, never
// deleted), idle (since), activity { at, tools }, seenAt, mergedFrom, pinned (until, after an undo),
// organizing (placement pending), and on the root reorg { runs, dismissed, dailyAt } (the journal).
// The root is ds-bot's Main Bot (Chief, BotView.isMain), adopted with treeRole 'root'. A separate
// root bot is created only when the team has no Main Bot at all.
import { checkCreate } from './limits.js'
import { systemPrompt, withTreeBlock, hasTreeBlock } from './prompt.js'
import { forestOf } from './forest.js'
import { createOrganizer } from './organize.js'
import { createAllocator } from './allocate.js'
import { createLoadTracker, loadLine } from './load.js'
export { forestOf }

export const TREE_KEYS = new Set(['parent', 'treeRole'])
export const ROOT_ROLE = 'root'
const LEGACY_ROOT_ROLE = 'Top-level coordinator for everything.'
const ROOT_LABEL = 'Main bot and root of the tree'

export function createTree(fb, { limits, rootName = 'Root', rootBotId, adoptExisting = true, warn = () => {}, classify, tidy, now = Date.now } = {}) {
  const listeners = new Set()
  const load = createLoadTracker({ now })

  function snapshot() {
    const nodes = {}
    for (const b of fb.listBots()) {
      const role = fb.getField(b.id, 'treeRole')
      const parent = fb.getField(b.id, 'parent')
      if (role === undefined && parent === undefined) continue
      nodes[b.id] = { id: b.id, name: b.name, role: role === ROOT_ROLE ? ROOT_LABEL : (role ?? ''), parent: parent ?? null, root: role === ROOT_ROLE }
    }
    return nodes
  }
  const childrenOf = (nodes, id) => Object.values(nodes).filter(n => n.parent === id)
  const depthOf = (nodes, id) => { let d = 0; for (let x = id, seen = new Set(); x && nodes[x] && !seen.has(x); x = nodes[x].parent) { seen.add(x); d++ } return d }
  // Height of the subtree rooted at id: 0 for a leaf. Two things make this walk safe and true: it recurses
  // on the child's id (it used to pass the node object, so `childrenOf` matched nothing and the height was
  // always 1), and a `seen` set ends it at a node already on the path, like `depthOf` — a corrupted
  // snapshot can make two Bots each other's parent, and without the set the walk dies on the stack (#677).
  const heightOf = (nodes, id, seen = new Set()) => {
    if (seen.has(id)) return 0
    seen.add(id)
    const kids = childrenOf(nodes, id)
    return kids.length ? 1 + Math.max(...kids.map(k => heightOf(nodes, k.id, seen))) : 0
  }
  const traceOf = (nodes, id) => { const p = []; for (let x = id; x && nodes[x] && p.length < 64; x = nodes[x].parent) p.unshift(nodes[x].name); return p.join(' → ') }

  const promptFor = (id, nodes = snapshot()) => {
    const n = nodes[id]
    return n && systemPrompt({ name: n.name, role: n.role, trace: traceOf(nodes, id), children: childrenOf(nodes, id), root: n.root, notes: [...notesFor(id, n), ...loadNotes(id, nodes)], limits })
  }
  const stamp = at => { const d = new Date(at); const p = v => String(v).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}` }
  // The Main Bot hears what the last reorganization did (the owner sees it in the tree view); a kept
  // Bot hears whose role it took over in a merge.
  function notesFor(id, n) {
    const notes = []
    if (n.root) {
      const last = organizer.overview().runs[0]
      if (last && !last.undone && now() - last.at < 7 * 24 * 60 * 60 * 1000) {
        const lines = last.summary ?? []
        notes.push(`Last ${last.trigger === 'team' ? '' : 'automatic '}tree reorganization (${stamp(last.at)}): ${lines.slice(0, 6).join('; ')}${lines.length > 6 ? `; and ${lines.length - 6} more` : ''}. The owner sees it in the tree view and can undo it there; tell them what moved if they ask about the team.`)
      }
    }
    const merged = fb.getField(id, 'mergedFrom')
    if (Array.isArray(merged) && merged.length) notes.push(`You took over the role of ${merged.map(m => m.name).join(', ')} (merged into you; the old Bot is archived with its own chat history).`)
    return notes
  }
  // The runtime load of a coordinator's direct children (#507), as one prompt line, so it can
  // send a new part to a free child instead of a busy one.
  function loadNotes(id, nodes) {
    const line = loadLine(childrenOf(nodes, id), childId => load.of(childId), childId => load.openFor(childId))
    return line === undefined ? [] : [line]
  }
  // Prompt injection: only the tree's marked block is replaced; other text (e.g. Chief's own) stays.
  const writeBlock = (id, block) => {
    const current = fb.getSystemPrompt(id)
    const next = withTreeBlock(current, block)
    if (next !== String(current ?? '').trim()) fb.setSystemPrompt(id, next)
  }
  const refreshPrompt = (id, nodes = snapshot()) => { if (nodes[id]) writeBlock(id, promptFor(id, nodes)) }
  // After a placement or repair any trace or child list may have changed; writeBlock skips unchanged prompts.
  const refreshAll = () => { const nodes = snapshot(); for (const id of Object.keys(nodes)) refreshPrompt(id, nodes) }
  const findRootId = () => { const nodes = snapshot(); return Object.values(nodes).find(n => n.root)?.id ?? Object.values(nodes).find(n => n.parent === null)?.id }
  const organizer = createOrganizer({ fb, limits, snapshot, childrenOf, depthOf, warn, refreshAll: () => refreshAll(), writeBlock: (id, block) => writeBlock(id, block), findRootId, now, classify, tidy })
  // Forward allocation (#447) on the organizer's shared primitives: find_bots, reuse, parent?, teams.
  const allocator = createAllocator({ fb, limits, snapshot, childrenOf, depthOf, traceOf, shared: organizer.shared, createUnder: (parentId, name, role) => createChildNow(parentId, name, role), withParentLock: (id, fn) => withParentLock(id, fn), refreshAll: () => refreshAll(), classify })

  // ---------------------------------------------------------------- root
  /** The Main Bot (Chief): config.rootBotId if it exists, else the Main Bot named 'Chief', else the first Main Bot. */
  function findChief() {
    const bots = fb.listBots()
    if (rootBotId) return bots.find(b => b.id === rootBotId)
    const mains = bots.filter(b => b.isMain === true)
    return mains.find(b => b.name === 'Chief') ?? mains[0]
  }
  const isLegacyRoot = (b, chiefId) => b.id !== chiefId && b.isMain !== true && fb.getField(b.id, 'parent') == null &&
    fb.getField(b.id, 'treeRole') !== undefined && (b.name === rootName || fb.getField(b.id, 'treeRole') === LEGACY_ROOT_ROLE)

  /** Earlier installs auto-created a separate 'Root': move its children to Chief, clear its tree fields and block. Never deletes it. Idempotent. */
  function migrateLegacyRoots(chiefId) {
    const moved = []
    for (const b of fb.listBots()) {
      if (!isLegacyRoot(b, chiefId)) continue
      for (const c of fb.listBots()) if (fb.getField(c.id, 'parent') === b.id) { fb.setField(c.id, 'parent', chiefId); moved.push(c.id) }
      fb.setField(b.id, 'parent', null)
      fb.setField(b.id, 'treeRole', null)
      fb.setField(b.id, 'retired', true) // out of the tree for good; adoption skips it
      const prompt = fb.getSystemPrompt(b.id)
      if (hasTreeBlock(prompt)) writeBlock(b.id, '')
      else if (/a bot in a recursive bot tree/.test(prompt)) fb.setSystemPrompt(b.id, '') // pre-block installs: the whole prompt was ours
    }
    return moved
  }

  /** Adopts Chief as the root (treeRole 'root', no bot created). Returns its id, or undefined while the team is not loaded. */
  function adoptChief() {
    const chief = findChief()
    if (!chief) return undefined
    if (fb.getField(chief.id, 'parent') !== undefined) fb.setField(chief.id, 'parent', null)
    if (fb.getField(chief.id, 'treeRole') !== ROOT_ROLE) fb.setField(chief.id, 'treeRole', ROOT_ROLE)
    migrateLegacyRoots(chief.id)
    if (adoptExisting) adoptUnattached(chief.id)
    // #452: restore 归档-* / Archive-* mis-renames; hide archived from the default sidebar.
    try { const r = organizer.repairArchiveNames(); if (r && typeof r.then === 'function') r.catch(error => warn('flybot-tree: archive-name repair failed:', error?.message ?? error)) } catch (error) { warn('flybot-tree: archive-name repair failed:', error?.message ?? error) }
    organizer.repair()
    refreshAll()
    return chief.id
  }

  /**
   * Every local bot with no tree fields (not retired, not archived) is placed in the tree by role
   * (organize.js): into the group that matches it, under the tree's limits; a full level is regrouped
   * under role leads first. A bot that fits no group anywhere stays outside (logged). Remote bots are
   * never in bot.list(). Bots are placed in list (creation) order.
   */
  function adoptUnattached(rootId) {
    const adopted = [], skipped = [], pending = []
    for (const b of fb.listBots()) {
      if (b.id === rootId || fb.isRemote?.(b.id)) continue
      if (fb.getField(b.id, 'retired') === true || fb.getField(b.id, 'archived') !== undefined) continue
      if (fb.getField(b.id, 'organizing') === true) {
        if (organizer.busy()) continue // being placed, or a lead being set up
        fb.setField(b.id, 'organizing', null) // left over from a stopped run: place it now
      }
      if (fb.getField(b.id, 'parent') !== undefined || fb.getField(b.id, 'treeRole') !== undefined) continue
      if (b.isMain === true && !rootBotId) continue // another Main Bot stays outside the tree
      const at = organizer.place(b, rootId)
      if (at instanceof Promise) pending.push(at)
      else if (at === undefined) skipped.push(b.name)
      else adopted.push(b.id)
    }
    if (adopted.length) refreshAll()
    return { adopted, skipped, pending }
  }

  /**
   * Synchronous nested view for UIs: [{ id, name, role, root, createdAt, children }], roots first,
   * siblings ordered by createdAt (then name). Bots whose parent is missing are listed at the top level.
   */
  function forest() { return forestOf(fb.listBots().map(b => ({ ...b, fields: { 'flybot-tree': { parent: fb.getField(b.id, 'parent'), treeRole: fb.getField(b.id, 'treeRole'), retired: fb.getField(b.id, 'retired') } } }))) }

  let rootTask
  /**
   * Idempotent; concurrent calls share one creation. Adopts Chief; creates a root bot only when the
   * team has bots but no Main Bot. With no bots listed yet (team not loaded) it resolves undefined.
   */
  function ensureRoot({ create = true } = {}) {
    const adopted = adoptChief()
    if (adopted) return Promise.resolve(adopted)
    if (rootBotId) return Promise.resolve(undefined) // configured root not there (yet)
    const existing = Object.values(snapshot()).find(n => n.root || n.parent === null)
    if (existing) return Promise.resolve(existing.id)
    if (!create || fb.listBots().length === 0) return Promise.resolve(undefined)
    rootTask ??= createRoot().finally(() => { rootTask = undefined })
    return rootTask
  }
  async function createRoot() {
    const prompt = systemPrompt({ name: rootName, role: ROOT_LABEL, trace: rootName, children: [], root: true, limits })
    return fb.createBot({ name: rootName, systemPrompt: withTreeBlock('', prompt), fields: { parent: null, treeRole: ROOT_ROLE } })
  }

  // createChild checks limits, then awaits createBot: serialize per parent so parallel calls
  // see each other's children (no maxChildren overflow, no duplicate-name siblings).
  const createLocks = new Map()
  function withParentLock(parentId, fn) {
    const prev = createLocks.get(parentId) ?? Promise.resolve()
    const run = prev.then(fn, fn)
    const tail = run.then(() => {}, () => {})
    createLocks.set(parentId, tail)
    tail.then(() => { if (createLocks.get(parentId) === tail) createLocks.delete(parentId) })
    return run
  }

  /** Creates a child directly under parentId (limits checked there, per-parent lock). The tool goes through allocator.createChild (reuse, parent?). */
  function createChild(parentId, name, roleDescription) {
    return withParentLock(parentId, () => createChildNow(parentId, name, roleDescription))
  }
  async function createChildNow(parentId, name, roleDescription) {
    const nodes = snapshot()
    const parent = nodes[parentId]
    if (!parent) throw new Error('this bot is not part of the tree')
    const clean = String(name ?? '').trim()
    const role = String(roleDescription ?? '').trim()
    const reason = checkCreate({ parentName: parent.name, parentDepth: depthOf(nodes, parentId), siblings: childrenOf(nodes, parentId), name: clean, limits })
    if (reason) throw new Error(reason)
    const prompt = systemPrompt({ name: clean, role, trace: `${traceOf(nodes, parentId)} → ${clean}`, children: [] })
    // createdBy is the parent Bot. Do not copy its grants: a child starts owner-private (#16).
    const id = await fb.createBot({ name: clean, systemPrompt: withTreeBlock('', prompt), fields: { parent: parentId, treeRole: role }, createdBy: parentId })
    refreshPrompt(parentId) // the parent now lists the new child
    return { id, name: clean, depth: depthOf(nodes, parentId) + 1 }
  }

  /** Resolves a bot by id or name (trimmed, case-insensitive). Throws when missing or ambiguous. */
  function findBotByName(ref) {
    const raw = String(ref ?? '').trim()
    if (!raw) throw new Error('bot name required')
    const byId = fb.listBots().find(b => b.id === raw)
    if (byId) return byId
    const clean = raw.toLowerCase()
    const hits = fb.listBots().filter(b => String(b.name ?? '').trim().toLowerCase() === clean)
    if (hits.length === 0) throw new Error(`no bot named "${raw}"`)
    if (hits.length > 1) throw new Error(`more than one bot is named "${raw}"`)
    return hits[0]
  }

  /**
   * Moves an existing bot (with its subtree) under a new parent — the model-facing counterpart of
   * deletion, which already re-attaches children upwards. Refused on a cycle, maxChildren overflow,
   * duplicate sibling name, or a subtree that would end deeper than maxDepth. The new parent, the old
   * parent and the moved subtree get a fresh prompt (their trace changed).
   */
  function moveBot(botRef, parentRef) {
    const nodes = snapshot()
    const bot = findBotByName(botRef)
    const parent = findBotByName(parentRef)
    if (!nodes[bot.id]) throw new Error(`${bot.name} is not part of the tree`)
    if (!nodes[parent.id]) throw new Error(`${parent.name} is not part of the tree`)
    if (bot.id === parent.id) throw new Error('a bot cannot be its own parent')
    const from = parentOf(bot.id) ?? null
    if (from === parent.id) throw new Error(`${bot.name} is already a child of ${parent.name}`)
    for (let at = parent.id, seen = new Set(); at != null && nodes[at] && !seen.has(at); at = nodes[at].parent) {
      seen.add(at)
      if (at === bot.id) throw new Error(`cannot move ${bot.name} under its own descendant ${parent.name}`)
    }
    const siblings = childrenOf(nodes, parent.id).filter(s => s.id !== bot.id)
    if (siblings.length >= limits.maxChildren) throw new Error(`limit reached: ${parent.name} already has ${siblings.length} children (maxChildren=${limits.maxChildren})`)
    if (siblings.some(s => String(s.name).trim().toLowerCase() === String(bot.name).trim().toLowerCase())) {
      throw new Error(`a child named "${bot.name}" already exists under ${parent.name}`)
    }
    const bottom = depthOf(nodes, parent.id) + 1 + heightOf(nodes, bot.id)
    if (bottom > limits.maxDepth) throw new Error(`limit reached: ${bot.name} would end at depth ${bottom} (maxDepth=${limits.maxDepth})`)
    fb.setField(bot.id, 'parent', parent.id)
    refreshAll()
    return { moved: bot.id, name: bot.name, from, to: parent.id }
  }

  // A tree member has treeRole (or parent; the root's parent is null/absent).
  const isMember = id => typeof id === 'string' && (fb.getField(id, 'treeRole') !== undefined || fb.getField(id, 'parent') !== undefined)
  const parentOf = id => fb.getField(id, 'parent') ?? null
  const isRoot = id => isMember(id) && (fb.getField(id, 'treeRole') === ROOT_ROLE || fb.getField(id, 'parent') == null)
  // The root of the tree a member is in (itself for a root); undefined for a non-member. A cycle stops at the walk's end.
  function rootOf(id) {
    if (!isMember(id)) return undefined
    const seen = new Set()
    let at = id
    while (!seen.has(at)) {
      seen.add(at)
      const parent = parentOf(at)
      if (parent == null || !isMember(parent)) return at
      at = parent
    }
    return at
  }
  function isTreeEdge(from, to) {
    const fromIn = isMember(from), toIn = isMember(to)
    return { fromIn, toIn, inTree: fromIn && toIn, allowed: fromIn && toIn && (parentOf(to) === from || parentOf(from) === to) }
  }

  const emit = change => { for (const fn of listeners) fn(change) }
  function onFieldChange(change) {
    if (!change || !TREE_KEYS.has(change.key)) return
    emit(change)
  }
  /**
   * After deletion: the removed bot's children re-attach to its parent (from the event's last record),
   * so no child is dropped. If that parent is now over maxChildren, organizer.repair() regroups its
   * children by role under a lead until it is back within the limit (#446). Every moved Bot and its
   * descendants get a fresh prompt (their trace no longer names the deleted bot).
   */
  function onBotRemoved({ botId, parent }) {
    if (parent === undefined) return // not a tree bot
    const up = parent ?? null
    for (const child of childrenOf(snapshot(), botId)) fb.setField(child.id, 'parent', up)
    organizer.repair()
    refreshAll()
    emit({ botId, key: 'removed' })
    // The deletion freed a slot: a Bot that stayed outside the tree only because a level was full
    // joins now, instead of waiting for the next startup (#635).
    const chief = findChief()
    if (!chief) return
    const { adopted, pending } = adoptUnattached(chief.id)
    for (const at of pending) at.catch(error => warn('flybot-tree: adoption after a deletion failed:', error?.message ?? error))
    if (adopted.length) refreshAll()
  }
  const subscribe = fn => { listeners.add(fn); return () => listeners.delete(fn) }

  const { tidy: tidyNow, maybeTidy, undo, dismiss, overview, noteActivity, idle: settled, repairArchiveNames } = organizer
  const { findBots, createChild: allocateChild, createTeam } = allocator
  const noteTurnStart = (id, turnId) => load.start(id, turnId)
  const noteTurnEnd = (id, turnId) => load.end(id, turnId)
  const loadOf = id => load.of(id)
  const openForOf = id => load.openFor(id)
  return { tidy: tidyNow, maybeTidy, undo, dismiss, overview, noteActivity, noteTurnStart, noteTurnEnd, loadOf, openForOf, refreshPrompt, parentOf, settled, repairArchiveNames, limits, forest, adoptUnattached, snapshot, childrenOf, depthOf, heightOf, traceOf, ensureRoot, adoptChief, findChief, migrateLegacyRoots, promptFor, createChild, allocateChild, createTeam, findBots, moveBot, findBotByName, isMember, isRoot, rootOf, isTreeEdge, onFieldChange, onBotRemoved, subscribe }
}
