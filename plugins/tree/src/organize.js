// Self-organization of the tree (#446, owner decision 2026-10-19 21:27 Asia/Shanghai).
//
// - Placement: a Bot outside the tree (core create_bot, the Bot list, an older install) goes into
//   the group that matches its role: down through lead Bots whose group fits it (src/roles.js),
//   else under the root. Same maxChildren / maxDepth as create_child_bot.
// - A full level is regrouped by role: children with a shared group key (project word, domain,
//   shared role word, then broad area) move under a suitable existing member (the lead), or under a
//   new lead Bot with a clear role ("FlyBot Lead"). There is no "least-loaded child" fallback: a Bot
//   that fits no group at any level stays outside and a warning names it.
// - Daily tidy: the same grouping (project and domain groups only), duplicates merged (the old Bot
//   archived, never deleted), long-idle leaf Bots marked idle and archived after 30 days.
// - Every change is a journal action on the root ('reorg' field): the tree view shows the last run
//   and undoes it in one click. Nothing is ever deleted; an archived Bot keeps its chat and memory.
// - Grouping always MOVES (reparents) existing Bots. It never renames a Bot to 归档- / Archive- and
//   never recreates a same-role Bot to achieve a group (#452). Archive hides from the default sidebar.
import { profileOf, keysOf, kindOf, KIND_RANK, labelOf, leadNameOf, canLead, sameRole, norm, DOMAINS } from './roles.js'
import { systemPrompt, withTreeBlock, BLOCK_START } from './prompt.js'

const DAY = 24 * 60 * 60 * 1000
const DOMAIN_AREA = new Map(DOMAINS.map(d => [d.id, d.area]))
export const DEFAULT_TIDY = Object.freeze({ idleDays: 14, archiveIdleDays: 30, mergeGraceDays: 1, pinDays: 14, keepRuns: 5 })
/** Mis-archive rename prefix (Chief update_bot / manual): 归档-Name or Archive-Name. Reorg never writes this. */
export const ARCHIVE_NAME_RE = /^(?:归档|Archive)[-—–＿_\s]+/u
export const stripArchivePrefix = name => { const n = String(name ?? ''); return ARCHIVE_NAME_RE.test(n) ? n.replace(ARCHIVE_NAME_RE, '').trim() : n.trim() }
const ACTIVITY_WRITE_MS = 60 * 60 * 1000
const MAX_TOOLS = 8

/** Own prompt text without the tree's block: part of a Bot's description. */
const ownText = prompt => { const s = String(prompt ?? ''); const i = s.indexOf(BLOCK_START); return (i >= 0 ? s.slice(0, i) : s).trim() }

export function createOrganizer({ fb, limits, snapshot, childrenOf, depthOf, warn, refreshAll, writeBlock, findRootId, now = Date.now, classify, tidy: tidyConfig = {} }) {
  const cfg = { ...DEFAULT_TIDY, ...Object.fromEntries(Object.entries(tidyConfig).filter(([, v]) => Number.isFinite(v) && v >= 0)) }
  const get = (id, key) => fb.getField(id, key)
  const set = (id, key, value) => fb.setField(id, key, value)
  // Hide / unhide in the core sidebar (bot.hidden). Optional on older hosts without bot.update.
  const hideBot = (id, hidden) => {
    if (typeof fb.updateBot !== 'function') return
    try {
      const out = fb.updateBot(id, { hidden: Boolean(hidden) })
      if (out && typeof out.then === 'function') out.catch(error => warn('flybot-tree: could not set hidden:', error?.message ?? error))
    } catch (error) { warn('flybot-tree: could not set hidden:', error?.message ?? error) }
  }
  const renameBot = (id, name) => {
    if (typeof fb.updateBot !== 'function') return Promise.reject(new Error('bot.update is unavailable'))
    return Promise.resolve(fb.updateBot(id, { name }))
  }

  // ------------------------------------------------------------ profiles
  const infoOf = (nodes, id, extra = {}) => {
    const bot = fb.getBot(id) ?? {}
    const lead = get(id, 'lead')
    // A lead's role text lists its members; its group label says what it is.
    const treeRole = lead?.label ? `${lead.label} lead` : nodes[id] && !nodes[id].root ? nodes[id].role : (extra.treeRole ?? '')
    return { id, name: nodes[id]?.name ?? bot.name ?? extra.name, role: bot.role, treeRole, prompt: lead ? '' : ownText(bot.systemPrompt), tools: get(id, 'activity')?.tools ?? [] }
  }
  const profile = (nodes, id, extra) => {
    const p = profileOf(infoOf(nodes, id, extra), classify)
    // A lead is what its group is: "Life Lead" is life, "FlyBot Lead" is the FlyBot project.
    const lead = get(id, 'lead')
    if (lead?.key) {
      const [kind, value] = [kindOf(lead.key), lead.key.slice(lead.key.indexOf(':') + 1)]
      if (kind === 'domain') { p.domain = value; p.area = DOMAIN_AREA.get(value) ?? p.area }
      if (kind === 'area') p.area = value
      if (kind === 'project' && !p.projects.includes(value)) p.projects = [value, ...p.projects]
    }
    return p
  }
  const subtreeOf = (nodes, id) => {
    const out = [], queue = [id], seen = new Set()
    while (queue.length) { const x = queue.shift(); if (seen.has(x) || !nodes[x]) continue; seen.add(x); out.push(x); for (const c of childrenOf(nodes, x)) queue.push(c.id) }
    return out
  }
  const heightOf = (nodes, id) => {
    let h = 0
    const walk = (x, d, seen) => { if (seen.has(x)) return; seen.add(x); h = Math.max(h, d); for (const c of childrenOf(nodes, x)) walk(c.id, d + 1, seen) }
    walk(id, 1, new Set())
    return h
  }
  /**
   * Keys that say nothing at this level: the groups of the parent and every lead above it (all of
   * "Dev Lead"'s Bots are dev; no second "Dev Lead" inside it). Under a lead, broad areas no longer
   * group either: they are only for the top levels.
   */
  const ignoredAt = (nodes, parentId) => {
    const out = new Set()
    let underLead = false
    for (let at = parentId, seen = new Set(); at && nodes[at] && !seen.has(at); at = nodes[at].parent) {
      seen.add(at)
      const lead = get(at, 'lead')
      if (lead?.key) { out.add(lead.key); underLead = true }
      if (!nodes[at].root) for (const k of keysOf(profile(nodes, at))) if (kindOf(k) === 'project' || kindOf(k) === 'word' || (at === parentId && kindOf(k) === 'domain' && lead)) out.add(k)
    }
    if (underLead) for (const area of ['work', 'life', 'other']) out.add(`area:${area}`)
    return out
  }
  const hostsName = (nodes, hostId, name, exceptId) => childrenOf(nodes, hostId).some(c => c.id !== exceptId && norm(c.name) === norm(name))
  const fits = (nodes, hostId, x, extra = 0) => {
    const kids = childrenOf(nodes, hostId).filter(c => c.id !== x.id)
    return hostId !== x.id && kids.length + extra < limits.maxChildren && depthOf(nodes, hostId) + x.height <= limits.maxDepth && !hostsName(nodes, hostId, x.name, x.id)
  }

  // ------------------------------------------------------------ journal (root field 'reorg')
  const rootId = () => findRootId()
  const readLog = () => { const r = rootId(); return (r && get(r, 'reorg')) || { runs: [] } }
  const writeLog = log => { const r = rootId(); if (r) set(r, 'reorg', log) }
  let seq = 0
  const begin = trigger => ({ id: `${now().toString(36)}-${(++seq).toString(36)}`, at: now(), trigger, actions: [] })
  const describeAction = a => {
    switch (a.op) {
      case 'move': return `moved ${a.name} from ${a.fromName} to ${a.toName}`
      case 'lead': return `created ${a.name} under ${a.parentName} to lead the ${a.label} group`
      case 'place': return `placed new ${a.name} under ${a.toName}`
      case 'merge': return `merged ${a.name} into ${a.intoName}`
      case 'archive': return a.reason === 'merged' ? `archived ${a.name} (merged into ${a.intoName})` : `archived ${a.name} (${a.reason})`
      case 'idle': return `marked ${a.name} idle`
      case 'mark-lead': return `made ${a.name} the lead of the ${a.label} group`
      case 'repair-name': return a.toName ? `restored name ${a.toName} (was ${a.name})` : `hid mis-archived ${a.name}`
      default: return a.op
    }
  }
  function commit(run) {
    if (!run.actions.length) return undefined
    run.summary = run.actions.filter(a => a.op !== 'archive' || a.reason !== 'merged').map(describeAction)
    for (const line of run.summary) warn(`flybot-tree: reorganized (${run.trigger}): ${line}`)
    const log = readLog()
    writeLog({ ...log, runs: [run, ...(log.runs ?? [])].slice(0, cfg.keepRuns) })
    return run
  }

  // ------------------------------------------------------------ primitives (each records an action)
  function move(run, id, toId) {
    const nodes = snapshot()
    const from = nodes[id]?.parent ?? null
    if (from === toId) return
    set(id, 'parent', toId)
    run.actions.push({ op: 'move', bot: id, name: nodes[id]?.name ?? id, from, fromName: nodes[from]?.name ?? '', to: toId, toName: nodes[toId]?.name ?? toId })
  }
  function archive(run, id, reason, extra = {}) {
    const nodes = snapshot()
    const n = nodes[id]
    if (!n || n.root || childrenOf(nodes, id).length) return false
    const record = { at: now(), reason, parent: n.parent, treeRole: n.role, run: run.id, ...extra }
    set(id, 'archived', record)
    set(id, 'parent', null); set(id, 'treeRole', null); set(id, 'idle', null)
    writeBlock(id, '')
    hideBot(id, true) // out of the default Bot list (#452); search still finds it when un-hidden
    run.actions.push({ op: 'archive', bot: id, name: n.name, reason, parent: n.parent, treeRole: n.role, ...(extra.into ? { into: extra.into, intoName: extra.intoName } : {}) })
    return true
  }
  /**
   * A new lead Bot with a clear role, set up under parentId with its members: resolves its id. Never an
   * empty placeholder. The members move under it before it joins parentId, so parentId never goes
   * over maxChildren, not even for a moment.
   */
  async function createLead(run, parentId, plan) {
    const memberNames = plan.memberNames ?? plan.movers.map(m => m.name)
    let nodes = snapshot()
    let name = leadNameOf(plan.label)
    for (let i = 2; hostsName(nodes, parentId, name) || memberNames.some(m => norm(m) === norm(name)); i++) name = `${leadNameOf(plan.label)} ${i}`
    const role = `Lead of the ${plan.label} group: coordinates ${memberNames.join(', ')}. Hand each ${plan.label} task to the member whose role fits and combine their answers.`
    const prompt = systemPrompt({ name, role, trace: name, children: [] })
    // 'organizing' keeps placement off this Bot while it is being set up (bot.created fires inside create).
    const id = await fb.createBot({ name, systemPrompt: withTreeBlock('', prompt), fields: { organizing: true, lead: { key: plan.key, label: plan.label } }, createdBy: parentId })
    nodes = snapshot()
    if (!nodes[parentId]) { set(id, 'organizing', null); return undefined }
    run.actions.push({ op: 'lead', bot: id, name, key: plan.key, label: plan.label, parent: parentId, parentName: nodes[parentId].name })
    for (const m of plan.movers) {
      if (m.incoming || nodes[m.id]?.parent !== parentId) continue
      set(m.id, 'parent', id)
      run.actions.push({ op: 'move', bot: m.id, name: m.name, from: parentId, fromName: nodes[parentId].name, to: id, toName: name })
    }
    set(id, 'treeRole', role); set(id, 'parent', parentId); set(id, 'seenAt', now()); set(id, 'organizing', null)
    return id
  }

  // ------------------------------------------------------------ grouping plans
  /**
   * The best role group at parentId's level: { key, label, members, leadId? (existing), movers }.
   * `incoming` = a Bot being placed (not in the tree yet). mode 'full' allows every key kind and
   * pairs; 'daily' only project / domain groups of 3+ (or 2+ with an existing lead).
   */
  function planLevel(nodes, parentId, { incoming, mode = 'full', skip = new Set() } = {}) {
    const ignored = ignoredAt(nodes, parentId)
    const parentDepth = depthOf(nodes, parentId)
    const members = childrenOf(nodes, parentId).map(c => ({ id: c.id, name: c.name, height: heightOf(nodes, c.id), p: profile(nodes, c.id), kids: childrenOf(nodes, c.id).length, pinned: (get(c.id, 'pinned') ?? 0) > now() }))
      .filter(m => !skip.has(m.id))
    if (incoming) members.push({ ...incoming, kids: 0, incoming: true })
    const groups = new Map()
    for (const m of members) for (const k of keysOf(m.p)) {
      if (ignored.has(k)) continue
      if (mode === 'daily' && (m.pinned || !['project', 'domain'].includes(kindOf(k)))) continue
      if (!groups.has(k)) groups.set(k, []); groups.get(k).push(m)
    }
    const plans = []
    for (const [key, list] of groups) {
      if (list.length < 2) continue
      const names = list.map(m => m.name)
      const label = labelOf(key, names)
      const leads = list.filter(m => !m.incoming && canLead(m.p, key, { lead: get(m.id, 'lead'), hasChildren: m.kids > 0, names }))
        .sort((a, b) => (Number(get(b.id, 'lead')?.key === key) - Number(get(a.id, 'lead')?.key === key)) || (b.kids - a.kids))
      const lead = leads[0]
      if (mode === 'daily' && !lead && (list.length < 3 || list.length === members.length)) continue // a group of the whole level adds a level and nothing else
      let movers = list.filter(m => m !== lead)
      if (lead) {
        // Existing lead: only members that fit under it (room, depth, no same-name sibling).
        const room = limits.maxChildren - lead.kids
        movers = movers.filter(m => parentDepth + 1 + m.height <= limits.maxDepth && !childrenOf(nodes, lead.id).some(c => norm(c.name) === norm(m.name)))
        const seen = new Set(); movers = movers.filter(m => !seen.has(norm(m.name)) && seen.add(norm(m.name))).slice(0, Math.max(0, room))
        if (!movers.length) continue
      } else {
        movers = movers.filter(m => parentDepth + 2 + m.height - 1 <= limits.maxDepth)
        const seen = new Set(); movers = movers.filter(m => !seen.has(norm(m.name)) && seen.add(norm(m.name))).slice(0, limits.maxChildren)
        if (movers.length < 2) continue
      }
      const freed = lead ? movers.filter(m => !m.incoming).length : movers.filter(m => !m.incoming).length - 1
      const takesIncoming = movers.some(m => m.incoming)
      plans.push({ key, label, lead: lead?.id, movers, freed, takesIncoming, rank: KIND_RANK[kindOf(key)] ?? 9 })
    }
    // Most specific role group first; among equals, the one the newcomer belongs to.
    plans.sort((a, b) => (a.rank - b.rank) || (Number(b.takesIncoming) - Number(a.takesIncoming)) || (Number(Boolean(b.lead)) - Number(Boolean(a.lead))) || (b.movers.length - a.movers.length) || a.key.localeCompare(b.key))
    // A full level must gain room (for the newcomer, or down to maxChildren).
    return plans.find(p => mode === 'daily' || p.freed >= 1 || p.takesIncoming)
  }

  /** Marks an existing member as the lead of group `key` (journaled once). */
  function markLead(run, leadId, key, label) {
    if (get(leadId, 'lead')) return
    set(leadId, 'lead', { key, label })
    run.actions.push({ op: 'mark-lead', bot: leadId, name: snapshot()[leadId]?.name ?? leadId, key, label })
  }
  /** Runs a plan; resolves the lead id. Sync (returns the id) when the lead exists, else a Promise. */
  function runPlan(run, parentId, plan) {
    if (!plan.lead) return createLead(run, parentId, plan)
    const leadId = plan.lead
    markLead(run, leadId, plan.key, plan.label)
    for (const m of plan.movers) {
      const now2 = snapshot()
      if (!m.incoming && now2[m.id]?.parent === parentId && fits(now2, leadId, { id: m.id, name: m.name, height: heightOf(now2, m.id) })) move(run, m.id, leadId)
    }
    return leadId
  }

  // ------------------------------------------------------------ placement
  /** The lead groups strictly between `root` and `id` (exclusive of both). */
  const groupsAbove = (nodes, root, id) => {
    const out = []
    for (let at = nodes[id]?.parent, seen = new Set(); at && at !== root && nodes[at] && !seen.has(at); at = nodes[at].parent) { seen.add(at); const k = get(at, 'lead')?.key; if (k) out.push(k) }
    return out
  }
  /**
   * Where a new Bot may go, best first: its namesake, then every tree Bot that leads a group it
   * belongs to (most specific group first, then the shallower lead), then the root. A broad area is
   * joined only through a lead made for it ("Work Lead"); a shared word never makes a lead.
   */
  function homesFor(nodes, root, x, { leadsOnly = false } = {}) {
    const keys = keysOf(x.p)
    const found = []
    for (const id of subtreeOf(nodes, root)) {
      if (id === root) continue
      if (norm(nodes[id].name) === norm(x.name)) { if (!leadsOnly) found.push({ id, rank: -1, depth: depthOf(nodes, id) }); continue } // the daily tidy merges them
      const lead = get(id, 'lead'), hasChildren = childrenOf(nodes, id).length > 0
      const ignored = ignoredAt(nodes, nodes[id].parent)
      let rank = Infinity
      // #447 forward placement: only a marked group lead takes a new Bot, never one that could lead that
      // group itself, and only down a path of groups it belongs to (no dev Bot inside "FlyBot Lead"'s Dev Lead unless it is FlyBot's).
      if (leadsOnly) {
        if (lead?.key && keys.includes(lead.key) && !canLead(x.p, lead.key, { names: [x.name] }) && groupsAbove(nodes, root, id).every(k => keys.includes(k))) found.push({ id, rank: KIND_RANK[kindOf(lead.key)] ?? 9, depth: depthOf(nodes, id) })
        continue
      }
      for (const k of keys) {
        if (ignored.has(k) && lead?.key !== k) continue
        if (kindOf(k) === 'word' || (kindOf(k) === 'area' && lead?.key !== k)) continue
        if (canLead(profile(nodes, id), k, { lead, hasChildren, names: [nodes[id].name, x.name] })) rank = Math.min(rank, KIND_RANK[kindOf(k)] ?? 9)
      }
      if (rank < Infinity) found.push({ id, rank, depth: depthOf(nodes, id) })
    }
    found.sort((a, b) => (a.rank - b.rank) || (a.depth - b.depth))
    return [...found.map(h => h.id), root]
  }

  /** In a lead whose group x belongs to: the member closest to x's role (shared words, then same domain; oldest first) that can take it. */
  function closestMember(nodes, leadId, x) {
    const lead = get(leadId, 'lead')
    if (!lead?.key || !keysOf(x.p).includes(lead.key)) return undefined
    const terms = new Set(x.p.terms)
    // A broad area ("Work") is not a role: there the member must share a word or the domain.
    let best, bestScore = kindOf(lead.key) === 'area' ? 0 : -1
    for (const c of childrenOf(nodes, leadId)) {
      const p = profile(nodes, c.id)
      const score = p.terms.filter(t => terms.has(t)).length * 2 + (p.domain && p.domain === x.p.domain ? 1 : 0)
      if (score > bestScore && fits(nodes, c.id, x)) { best = c.id; bestScore = score }
    }
    return best
  }

  let queue = Promise.resolve()
  let pending = 0
  const enqueue = job => {
    pending++
    const run = queue.then(job).catch(error => warn('flybot-tree: reorganization failed:', error?.message ?? error)).finally(() => { pending-- })
    queue = run
    return run
  }
  const placeAt = (id, parentId, role) => { set(id, 'treeRole', role); set(id, 'parent', parentId); set(id, 'seenAt', get(id, 'seenAt') ?? now()) }

  /**
   * Places a Bot that is not in the tree yet. Sync when it can (room, or an existing lead): returns
   * the parent id. When a new lead must be made first, or another reorganization is still running,
   * the Bot is marked 'organizing' and placed when that finishes: returns a Promise of the parent id.
   * undefined when no level can take it (logged; it is tried again on the next attempt).
   */
  function place(bot, root) {
    const role = String(bot.role ?? '').trim()
    const ASYNC = Symbol('async')
    const attempt = allowAsync => {
      const nodes = snapshot()
      if (!nodes[root]) return undefined
      const x = { id: bot.id, name: bot.name, height: 1, p: profileOf({ id: bot.id, name: bot.name, role: bot.role, treeRole: role, prompt: ownText(fb.getBot(bot.id)?.systemPrompt), tools: get(bot.id, 'activity')?.tools ?? [] }, classify) }
      for (const at of homesFor(nodes, root, x)) {
        if (fits(nodes, at, x)) {
          placeAt(bot.id, at, role)
          if (at !== root) warn(`flybot-tree: placed ${bot.name} under ${nodes[at].name} (its role group)`)
          return at
        }
        const plan = planLevel(nodes, at, { incoming: x })
        if (!plan) {
          // Inside a full lead of its own group, every member is related: the closest one takes it.
          const near = closestMember(nodes, at, x)
          if (near) { placeAt(bot.id, near, role); warn(`flybot-tree: placed ${bot.name} under ${nodes[near].name} (closest role in the full ${get(at, 'lead').label} group)`); return near }
          continue
        }
        if (!plan.lead && !allowAsync) return ASYNC
        const run = begin('full')
        const finish = leadId => {
          const later = snapshot()
          const target = plan.takesIncoming && leadId && fits(later, leadId, x) ? leadId : fits(later, at, x) ? at : undefined
          if (target) {
            placeAt(bot.id, target, role)
            run.actions.push({ op: 'place', bot: bot.id, name: bot.name, to: target, toName: later[target].name })
          }
          commit(run)
          return target
        }
        const lead = runPlan(run, at, plan)
        return lead instanceof Promise ? lead.then(finish) : finish(lead)
      }
      warn(`flybot-tree: ${bot.name} fits no role group and every level that matches it is at maxChildren=${limits.maxChildren} or maxDepth=${limits.maxDepth}; left outside the tree`)
      return undefined
    }
    if (pending === 0) {
      const result = attempt(false)
      if (result !== ASYNC) return result
    }
    // 'organizing' keeps every other placement attempt off this Bot until its own turn in the queue.
    set(bot.id, 'organizing', true)
    return enqueue(async () => {
      try {
        if (!fb.getBot(bot.id) || get(bot.id, 'parent') !== undefined || get(bot.id, 'archived') !== undefined) return get(bot.id, 'parent')
        return await attempt(true)
      } finally {
        if (fb.getBot(bot.id)) set(bot.id, 'organizing', null)
        refreshAll()
      }
    })
  }

  /**
   * Brings every over-full parent (e.g. after a deletion) back to maxChildren by role groups. Groups
   * with an existing lead are done at once; one that needs a new lead runs in the queue.
   */
  function repair() {
    const overFull = nodes => Object.keys(nodes).find(id => childrenOf(nodes, id).length > limits.maxChildren)
    if (pending === 0) reattachOrphans()
    if (pending === 0) {
      for (let guard = 0; guard < 64; guard++) {
        const nodes = snapshot()
        const over = overFull(nodes)
        if (!over) return undefined
        const plan = planLevel(nodes, over)
        if (!plan) { warn(`flybot-tree: ${nodes[over].name} has ${childrenOf(nodes, over).length} children (maxChildren=${limits.maxChildren}) and no role group can take any of them; kept all`); return undefined }
        if (!plan.lead) break
        const run = begin('repair')
        runPlan(run, over, plan)
        commit(run)
        if (!run.actions.length) return undefined
      }
    }
    if (!overFull(snapshot())) return undefined
    return enqueue(async () => { await repairInline(); refreshAll() })
  }

  /**
   * Orphans (#447): a member whose parent is no longer in the tree (deleted while the plugin was off,
   * archived, or never there) is never left outside for good. It moves, with its subtree, to the
   * home its role points to (its group's lead, else the root) where it fits; a journaled move.
   * One that fits nowhere yet is tried again on the next pass and keeps its subtree.
   */
  function reattachOrphans() {
    const root = rootId()
    let nodes = snapshot()
    if (!root || !nodes[root]) return
    const orphans = Object.values(nodes).filter(n => !n.root && n.id !== root && n.parent !== null && !nodes[n.parent])
    if (!orphans.length) return
    const run = begin('repair')
    for (const o of orphans) {
      nodes = snapshot()
      const x = { id: o.id, name: o.name, height: heightOf(nodes, o.id), p: profile(nodes, o.id) }
      const home = homesFor(nodes, root, x).find(at => !subtreeOf(nodes, o.id).includes(at) && fits(nodes, at, x))
      if (!home) { warn(`flybot-tree: ${o.name} lost its parent and no level that fits its role has room yet; tried again on the next pass`); continue }
      const from = o.parent
      set(o.id, 'parent', home)
      run.actions.push({ op: 'move', bot: o.id, name: o.name, from, fromName: fb.getBot(from)?.name ?? 'a removed Bot', to: home, toName: nodes[home].name })
    }
    commit(run)
    if (run.actions.length) refreshAll()
  }

  // ------------------------------------------------------------ daily tidy
  const isGranted = id => fb.hasAnyGrant?.(id) === true
  const lastActive = id => get(id, 'activity')?.at ?? get(id, 'seenAt')
  async function tidyNow() {
    const run = begin('daily')
    const t = now()
    // 1. Idle leaf Bots: marked idle, archived after archiveIdleDays.
    let nodes = snapshot()
    for (const id of Object.keys(nodes)) if (get(id, 'seenAt') === undefined) set(id, 'seenAt', t)
    for (const id of Object.keys(nodes)) {
      const n = nodes[id]
      if (n.root || childrenOf(nodes, id).length || isGranted(id)) continue
      if ((get(id, 'pinned') ?? 0) > t) continue
      const last = lastActive(id)
      const idle = get(id, 'idle')
      if (idle === undefined && t - last >= cfg.idleDays * DAY) { set(id, 'idle', t); run.actions.push({ op: 'idle', bot: id, name: n.name }) }
      else if (idle !== undefined && t - idle >= cfg.archiveIdleDays * DAY) archive(run, id, 'idle')
    }
    // 2. Duplicates: the newer of two Bots with the same role is merged into the older one.
    nodes = snapshot()
    const ids = Object.keys(nodes).filter(id => !nodes[id].root && !isGranted(id) && (get(id, 'pinned') ?? 0) <= t && t - (get(id, 'seenAt') ?? t) >= cfg.mergeGraceDays * DAY)
    const profiles = new Map(ids.map(id => [id, profile(nodes, id)]))
    const merged = new Set()
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const [a, b] = [ids[i], ids[j]]
        if (merged.has(a) || merged.has(b) || !sameRole(profiles.get(a), profiles.get(b))) continue
        nodes = snapshot()
        // Keep the one with more children, else the older (list order).
        const [keep, dup] = childrenOf(nodes, b).length > childrenOf(nodes, a).length ? [b, a] : [a, b]
        const kids = childrenOf(nodes, dup)
        if (subtreeOf(nodes, dup).includes(keep)) continue
        if (childrenOf(nodes, keep).length + kids.length > limits.maxChildren || kids.some(c => hostsName(nodes, keep, c.name, c.id) || depthOf(nodes, keep) + heightOf(nodes, c.id) > limits.maxDepth)) continue
        for (const c of kids) move(run, c.id, keep)
        run.actions.push({ op: 'merge', bot: dup, name: nodes[dup].name, into: keep, intoName: nodes[keep].name })
        if (archive(run, dup, 'merged', { into: keep, intoName: nodes[keep].name })) {
          set(keep, 'mergedFrom', [...(get(keep, 'mergedFrom') ?? []), { id: dup, name: nodes[dup].name, at: t }].slice(-10))
          merged.add(dup)
        }
      }
    }
    // 3. Role groups on every level (project and domain groups; a full level also by area).
    for (let guard = 0; guard < 64; guard++) {
      nodes = snapshot()
      let did = false
      for (const id of Object.keys(nodes)) {
        const plan = planLevel(nodes, id, { mode: 'daily' })
        if (!plan) continue
        const before = run.actions.length
        await runPlan(run, id, plan)
        if (run.actions.length > before) { did = true; break }
      }
      if (!did) break
    }
    const log = readLog()
    writeLog({ ...log, dailyAt: t })
    commit(run)
    return run.actions.length ? run : undefined
  }
  const tidy = () => enqueue(async () => { const r = await tidyNow(); await repairInline(); refreshAll(); return r })
  async function repairInline() {
    for (let guard = 0; guard < 64; guard++) {
      const nodes = snapshot()
      const over = Object.keys(nodes).find(id => childrenOf(nodes, id).length > limits.maxChildren)
      if (!over) return
      const plan = planLevel(nodes, over)
      if (!plan) { warn(`flybot-tree: ${nodes[over].name} has ${childrenOf(nodes, over).length} children (maxChildren=${limits.maxChildren}) and no role group can take any of them; kept all`); return }
      const run = begin('repair')
      await runPlan(run, over, plan)
      commit(run)
      if (!run.actions.length) return
    }
  }
  /** Runs the tidy when the last one is a day old (the first check after install only records the time). */
  function maybeTidy() {
    const r = rootId()
    if (!r) return undefined
    const log = readLog()
    if (log.dailyAt === undefined) { writeLog({ ...log, dailyAt: now() }); return undefined }
    if (now() - log.dailyAt < DAY) return undefined
    return tidy()
  }

  // ------------------------------------------------------------ activity (for idle and roles)
  const lastWrite = new Map()
  function noteActivity(botId, toolName) {
    if (typeof botId !== 'string' || !fb.getBot(botId)) return
    if (get(botId, 'idle') !== undefined) set(botId, 'idle', null)
    const prev = get(botId, 'activity') ?? { tools: [] }
    const tool = typeof toolName === 'string' ? toolName.trim().slice(0, 40) : ''
    const tools = tool && !prev.tools?.includes(tool) ? [tool, ...(prev.tools ?? [])].slice(0, MAX_TOOLS) : prev.tools ?? []
    const t = now()
    if (tools === prev.tools && t - (lastWrite.get(botId) ?? prev.at ?? 0) < ACTIVITY_WRITE_MS) return
    lastWrite.set(botId, t)
    set(botId, 'activity', { at: t, tools })
  }


  // ------------------------------------------------------------ repair mis-named 归档-* / Archive-* (#452)
  /**
   * One-shot / idempotent: Bots renamed to 归档-X or Archive-X (never written by this plugin) are
   * restored. If X is free, rename back to X and unhide. If X already exists, keep X, set archived
   * on the prefixed Bot when it is a leaf, and hide it from the default sidebar. Grouping never
   * uses this path; it only MOVEs.
   */
  async function repairArchiveNames() {
    const run = begin('repair-names')
    const bots = fb.listBots().filter(b => b && b.isMain !== true && !fb.isRemote?.(b.id))
    for (const b of bots) {
      if (!ARCHIVE_NAME_RE.test(b.name)) continue
      const bare = stripArchivePrefix(b.name)
      if (!bare) continue
      const clash = bots.find(o => o.id !== b.id && norm(o.name) === norm(bare))
      if (!clash) {
        try {
          await renameBot(b.id, bare)
          hideBot(b.id, false)
          run.actions.push({ op: 'repair-name', bot: b.id, name: b.name, toName: bare })
        } catch (error) { warn(`flybot-tree: could not restore name of ${b.name}:`, error?.message ?? error) }
        continue
      }
      // Duplicate of a live Bot with the bare name: archive (if leaf) and hide the prefixed one.
      if (get(b.id, 'archived') === undefined) {
        const nodes = snapshot()
        if (nodes[b.id] && !childrenOf(nodes, b.id).length && !nodes[b.id].root) archive(run, b.id, 'prefix-duplicate')
        else {
          set(b.id, 'archived', { at: now(), reason: 'prefix-duplicate', parent: nodes[b.id]?.parent ?? null, treeRole: nodes[b.id]?.role ?? '', run: run.id })
          if (nodes[b.id]) { set(b.id, 'parent', null); set(b.id, 'treeRole', null); writeBlock(b.id, '') }
          hideBot(b.id, true)
          run.actions.push({ op: 'repair-name', bot: b.id, name: b.name, into: clash.id, intoName: clash.name })
        }
      } else hideBot(b.id, true)
    }
    // Hide every Bot that already has archived set (older installs before hide-on-archive).
    for (const b of fb.listBots()) {
      if (b.isMain === true || fb.isRemote?.(b.id)) continue
      if (get(b.id, 'archived') !== undefined) hideBot(b.id, true)
    }
    return commit(run)
  }

  // ------------------------------------------------------------ undo
  /** Undoes the last reorganization (only the newest run that is not undone yet). */
  function undo(runId) {
    const log = readLog()
    const run = (log.runs ?? [])[0]
    if (!run || (runId && run.id !== runId)) return { error: 'only the last reorganization can be undone' }
    if (run.undone) return { error: 'already undone' }
    const kept = [], restored = []
    const pin = id => set(id, 'pinned', now() + cfg.pinDays * DAY)
    const leads = []
    for (const a of [...run.actions].reverse()) {
      const nodes = snapshot()
      const name = a.name
      if (a.op === 'move') {
        if (!nodes[a.bot] || !nodes[a.from]) { kept.push(`${name}: its old parent is gone`); continue }
        if (nodes[a.bot].parent !== a.to) { kept.push(`${name}: moved again since`); continue }
        if (!fits(nodes, a.from, { id: a.bot, name, height: heightOf(nodes, a.bot) })) { kept.push(`${name}: ${nodes[a.from].name} is full`); continue }
        set(a.bot, 'parent', a.from); pin(a.bot); restored.push(`${name} back under ${nodes[a.from].name}`)
      } else if (a.op === 'archive') {
        const rec = get(a.bot, 'archived')
        if (!fb.getBot(a.bot) || !rec) { kept.push(`${name}: no longer archived`); continue }
        const home = nodes[rec.parent] && fits(nodes, rec.parent, { id: a.bot, name, height: 1 }) ? rec.parent : undefined
        if (!home) { kept.push(`${name}: stays archived (${nodes[rec.parent]?.name ?? 'its old parent'} is full or gone)`); continue }
        set(a.bot, 'archived', null); set(a.bot, 'treeRole', rec.treeRole ?? ''); set(a.bot, 'parent', home); pin(a.bot)
        hideBot(a.bot, false)
        if (rec.into) set(rec.into, 'mergedFrom', (get(rec.into, 'mergedFrom') ?? []).filter(m => m.id !== a.bot))
        restored.push(`${name} back in the tree under ${nodes[home].name}`)
      } else if (a.op === 'idle') {
        if (get(a.bot, 'idle') !== undefined) { set(a.bot, 'idle', null); pin(a.bot); restored.push(`${name} no longer idle`) }
      } else if (a.op === 'mark-lead') {
        if (get(a.bot, 'lead')?.key === a.key) { set(a.bot, 'lead', null); restored.push(`${name} no longer marked as the ${a.label} lead`) }
      } else if (a.op === 'lead') leads.push(a)
      else if (a.op === 'place') kept.push(`${name}: new Bot stays under ${a.toName}`)
    }
    // A lead this run created is archived (not deleted) once it has no children left.
    for (const a of leads) {
      const nodes = snapshot()
      if (!nodes[a.bot]) continue
      if (childrenOf(nodes, a.bot).length) { kept.push(`${a.name}: still leads ${childrenOf(nodes, a.bot).map(c => c.name).join(', ')}`); continue }
      const tmp = { id: `${run.id}-undo`, actions: [] }
      if (archive(tmp, a.bot, 'undo')) restored.push(`${a.name} archived`)
    }
    const at = now()
    writeLog({ ...readLog(), runs: (readLog().runs ?? []).map(r => (r.id === run.id ? { ...r, undone: { at, restored, kept } } : r)) })
    warn(`flybot-tree: undid reorganization ${run.id}: ${restored.join('; ') || 'nothing restored'}${kept.length ? `; kept: ${kept.join('; ')}` : ''}`)
    refreshAll()
    return { undone: run.id, restored, kept }
  }
  function dismiss(runId) {
    const log = readLog()
    if (!(log.runs ?? []).some(r => r.id === runId)) return { error: 'unknown reorganization' }
    writeLog({ ...log, dismissed: runId })
    return { dismissed: runId }
  }
  const overview = () => { const log = readLog(); return { runs: log.runs ?? [], dismissed: log.dismissed ?? null, dailyAt: log.dailyAt ?? null } }
  const idle = () => pending === 0 ? Promise.resolve() : queue.then(() => idle())

  const busy = () => pending > 0
  /**
   * Runs `job` in the reorganization queue (one at a time with placement, repair and tidy; a lead
   * being set up there is not re-placed by adoption). Resolves the job's value, rejects with its error.
   */
  const exclusive = job => new Promise((resolve, reject) => { enqueue(async () => { try { resolve(await job()) } catch (error) { reject(error) } }) })
  // The shared primitives explicit allocation (#447, src/allocate.js) is built on: the same role
  // profiles, homes, limit checks, lead creation, moves and journal as the self-organization.
  const shared = { profile, subtreeOf, heightOf, fits, homesFor, createLead, markLead, move, begin, commit, exclusive }
  return { busy, place, repair, tidy, maybeTidy, undo, dismiss, overview, noteActivity, idle, planLevel, describeAction, repairArchiveNames, shared }
}
