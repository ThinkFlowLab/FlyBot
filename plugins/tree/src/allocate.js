// Forward allocation (#447, owner decisions 2026-10-19 ~19:45 and 21:27 Asia/Shanghai): where a NEW
// Bot goes when a tree Bot asks for one. It puts each Bot in a sensible place once; the
// self-organization (src/organize.js, #446) stays the safety net for a level that is full, orphans
// and duplicates. Everything here uses organize.js's shared primitives (role profiles, homes, lead
// creation, moves, journal) and the same limits; there is no second implementation.
//
// - Reuse before create: a Bot with the same role anywhere in the caller's branch (for Chief, the
//   whole tree) is reused instead of a duplicate being made.
// - Placement: `parent` must be the caller or one of its descendants (a Bot manages only its own
//   downstream); limits are checked at that parent, under its per-parent lock. With no `parent`, a
//   marked group lead in the caller's branch whose group the new Bot belongs to takes it ("FlyBot
//   Docs" goes under "FlyBot Lead"), else the caller.
// - Teams: a project or group with several roles becomes a lead plus children, one slot under the
//   parent (Chief → FlyBot Lead → {Dev, Test, …}); an existing lead of that group is reused.
import { profileOf, keysOf, leadNameOf, canLead, sameRole, matchOf, norm } from './roles.js'
import { checkCreate, MAX_NAME_LENGTH } from './limits.js'

export const LEAD_SUFFIX = ' Lead'
export const MAX_TEAM_LENGTH = MAX_NAME_LENGTH - LEAD_SUFFIX.length
const MAX_FOUND = 30
const MAX_OVERVIEW = 100

export function createAllocator({ fb, limits, snapshot, childrenOf, depthOf, traceOf, shared, createUnder, withParentLock, refreshAll, classify }) {
  const { profile, subtreeOf, heightOf, fits, homesFor, createLead, markLead, move, begin, commit, exclusive } = shared
  const get = (id, key) => fb.getField(id, key)
  const profileFor = (name, role) => profileOf({ name, treeRole: role }, classify)

  function member(nodes, callerId) {
    if (!nodes[callerId]) throw new Error('this bot is not part of the tree')
  }
  /** The caller itself, or a descendant named by id or (unique) name. Anything else is refused. */
  function resolveParent(nodes, callerId, ref) {
    const r = typeof ref === 'string' ? ref.trim() : ''
    if (!r) return callerId
    const scope = subtreeOf(nodes, callerId)
    if (scope.includes(r)) return r
    const byName = scope.filter(id => norm(nodes[id].name) === norm(r))
    if (byName.length === 1) return byName[0]
    if (byName.length > 1) throw new Error(`more than one Bot in your branch is named "${r}"; pass the id of the one you mean (${byName.join(', ')})`)
    throw new Error(`parent must be you or one of your descendants; "${r}" is not in your branch (find_bots lists your branch)`)
  }
  // The caller's direct child on the way down to `id` (whom the caller delegates to); undefined for itself.
  function viaOf(nodes, callerId, id) {
    for (let at = id, seen = new Set(); at && nodes[at] && !seen.has(at); at = nodes[at].parent) {
      seen.add(at)
      if (nodes[at].parent === callerId) return nodes[at]
    }
    return undefined
  }
  function describe(nodes, callerId, id) {
    const n = nodes[id]
    const via = viaOf(nodes, callerId, id)
    const lead = get(id, 'lead')
    return {
      id, name: n.name, role: n.role, depth: depthOf(nodes, id), path: traceOf(nodes, id),
      parent: nodes[n.parent]?.name ?? null, children: childrenOf(nodes, id).length,
      ...(lead?.label ? { lead: lead.label } : {}), ...(via && via.id !== id ? { via: via.name } : {}),
    }
  }
  /** A Bot in the caller's branch (shallowest first) with the same role as the one asked for. */
  function sameRoleIn(nodes, callerId, name, role, except = new Set()) {
    const want = profileFor(name, role)
    for (const id of subtreeOf(nodes, callerId)) {
      if (id === callerId || except.has(id) || nodes[id].root) continue
      if (sameRole(want, profile(nodes, id))) return id
    }
    return undefined
  }
  const reuseNote = (d, name) => `A Bot with the role of "${name}" already exists: ${d.path}. Reuse it${d.via ? ` (delegate through ${d.via})` : ''} instead of creating a duplicate; nothing was created.`

  /**
   * find_bots: Bots in the caller's branch (Chief: the whole tree) with name, role, parent, depth
   * and path. With a query, only matches, best first (same role, name, role words, project, domain).
   */
  function findBots(callerId, query) {
    const nodes = snapshot()
    member(nodes, callerId)
    const ids = subtreeOf(nodes, callerId).filter(id => id !== callerId)
    const text = String(query ?? '').trim()
    const scope = nodes[callerId].root ? 'the whole tree' : `the branch under ${nodes[callerId].name}`
    if (!text) {
      const bots = ids.slice(0, MAX_OVERVIEW).map(id => describe(nodes, callerId, id))
      return { scope, bots, total: ids.length, ...(ids.length > MAX_OVERVIEW ? { truncated: true } : {}), limits }
    }
    const q = profileFor(text, '')
    const found = ids.map(id => ({ id, m: matchOf(q, profile(nodes, id), text) })).filter(x => x.m.score > 0)
      .sort((a, b) => (b.m.score - a.m.score) || (depthOf(nodes, a.id) - depthOf(nodes, b.id)))
    return { scope, query: text, bots: found.slice(0, MAX_FOUND).map(x => ({ ...describe(nodes, callerId, x.id), match: x.m.why })), total: found.length, limits }
  }

  /** Where create_child_bot puts a new Bot: { reused, note } or { parentId }. */
  function planChild(callerId, name, role, parentRef) {
    const nodes = snapshot()
    member(nodes, callerId)
    const parentId = resolveParent(nodes, callerId, parentRef)
    const clean = String(name ?? '').trim()
    const match = sameRoleIn(nodes, callerId, clean, role)
    if (match) { const d = describe(nodes, callerId, match); return { reused: d, note: reuseNote(d, clean) } }
    if (parentId !== callerId || (typeof parentRef === 'string' && parentRef.trim())) return { parentId }
    const x = { name: clean, height: 1, p: profileFor(clean, role) }
    const ok = at => !checkCreate({ parentName: nodes[at].name, parentDepth: depthOf(nodes, at), siblings: childrenOf(nodes, at), name: clean, limits })
    return { parentId: homesFor(nodes, callerId, x, { leadsOnly: true }).find(ok) ?? callerId }
  }

  /**
   * create_child_bot(name, role_description, parent?): reuse, or create under the planned parent
   * (its per-parent lock; limits checked there). Resolves { created } or { reused, note }.
   */
  async function createChild(callerId, name, role, parentRef) {
    for (let attempt = 0; ; attempt++) {
      const plan = planChild(callerId, name, role, parentRef)
      if (plan.reused) return plan
      const out = await withParentLock(plan.parentId, async () => {
        const again = planChild(callerId, name, role, parentRef)
        if (again.reused) return again
        // A parallel create filled the chosen lead: plan again outside this lock.
        if (again.parentId !== plan.parentId && attempt < 3) return { retry: true }
        const created = await createUnder(again.parentId, name, role)
        const nodes = snapshot()
        return { created: { ...created, parent: { id: again.parentId, name: nodes[again.parentId]?.name }, path: traceOf(nodes, created.id) } }
      })
      if (!out.retry) return out
    }
  }

  // ------------------------------------------------------------ teams
  const teamKey = label => keysOf(profileFor(label, ''))[0] ?? `project:${norm(label)}`
  /** An existing lead for the group in the caller's branch: marked for it, named for it, or coordinating it. Shallowest first. */
  function leadIn(nodes, callerId, key, label) {
    const ids = subtreeOf(nodes, callerId).filter(id => !nodes[id].root)
    const marked = ids.find(id => get(id, 'lead')?.key === key)
    if (marked) return marked
    const named = ids.find(id => [norm(label), norm(leadNameOf(label))].includes(norm(nodes[id].name)))
    if (named) return named
    return ids.find(id => canLead(profile(nodes, id), key, { lead: get(id, 'lead'), hasChildren: childrenOf(nodes, id).length > 0, names: [label] }))
  }
  /** A member is "Name: role" (the tool's form) or { name, role_description }. */
  const memberOf = m => {
    if (typeof m === 'string') { const i = m.indexOf(':'); return i > 0 ? { name: m.slice(0, i).trim(), role_description: m.slice(i + 1).trim() } : { name: m.trim(), role_description: '' } }
    return { name: typeof m?.name === 'string' ? m.name : '', role_description: typeof m?.role_description === 'string' ? m.role_description : '' }
  }
  function validateMembers(list, label) {
    if (!Array.isArray(list)) return 'members must be a list of "Name: role" entries'
    if (list.length < 2) return 'a team needs at least 2 members; for one Bot use create_child_bot'
    if (list.length > limits.maxChildren) return `a team has at most ${limits.maxChildren} members (maxChildren=${limits.maxChildren})`
    const seen = new Set()
    for (const m of list.map(memberOf)) {
      const name = m.name.trim(), role = m.role_description.trim()
      if (!name || !role) return `every member needs a name and a role, as "Name: role" (got "${name || '?'}")`
      if (name.length > MAX_NAME_LENGTH) return `member name must be at most ${MAX_NAME_LENGTH} characters: "${name}"`
      if (role.length > 1000) return `role_description must be at most 1000 characters (${name})`
      if (seen.has(norm(name))) return `two members are named "${name}"`
      if (norm(name) === norm(leadNameOf(label))) return `"${name}" is the lead's own name; list only the members`
      seen.add(norm(name))
    }
    return null
  }
  function planTeam(callerId, label, list, parentRef) {
    const nodes = snapshot()
    member(nodes, callerId)
    const parentId = resolveParent(nodes, callerId, parentRef)
    const key = teamKey(label)
    const leadId = leadIn(nodes, callerId, key, label)
    return { nodes, parentId, key, leadId }
  }

  /**
   * create_team(team, members, parent?): "<team> Lead" plus its members, one slot under the parent.
   * An existing lead of the group in the caller's branch is reused (and marked); members that
   * already exist with the same role are reused, and moved under the lead when they sit flat next
   * to it. Moves of existing Bots are journaled (one-click undo in the tree view).
   */
  async function createTeam(callerId, { team, members, parent }) {
    const label = String(team ?? '').trim()
    if (!label) throw new Error('team is required')
    if (label.length > MAX_TEAM_LENGTH) throw new Error(`team must be at most ${MAX_TEAM_LENGTH} characters (the lead is named "<team> Lead")`)
    const bad = validateMembers(members, label)
    if (bad) throw new Error(bad)
    const list = members.map(memberOf).map(m => ({ name: m.name.trim(), role: m.role_description.trim() }))
    for (let attempt = 0; ; attempt++) {
      const first = planTeam(callerId, label, list, parent)
      const lockKey = first.leadId ?? first.parentId
      const out = await withParentLock(lockKey, () => exclusive(async () => {
        const plan = planTeam(callerId, label, list, parent)
        if ((plan.leadId ?? plan.parentId) !== lockKey && attempt < 3) return { retry: true }
        return buildTeam(callerId, label, list, plan)
      }))
      if (!out.retry) return out
    }
  }
  async function buildTeam(callerId, label, list, { parentId, key, leadId: existingLead }) {
    let nodes = snapshot()
    const run = begin('team')
    const done = list.map(m => ({ name: m.name, role: m.role }))
    // Reuse: the same role already in the caller's branch (never the lead itself).
    const taken = new Set(existingLead ? [existingLead] : [])
    for (const d of done) {
      const id = sameRoleIn(nodes, callerId, d.name, d.role, taken)
      if (id) { d.reusedId = id; taken.add(id) }
    }
    let leadId = existingLead
    const home = leadId ? nodes[leadId].parent : parentId
    // A reused member flat next to the lead (or at the parent, for a new lead) joins the lead.
    const flat = done.filter(d => d.reusedId && nodes[d.reusedId].parent === home && home !== null)
    if (leadId) markLead(run, leadId, key, label)
    else {
      const depth = depthOf(nodes, parentId)
      const movers = flat.filter(d => depth + 1 + heightOf(nodes, d.reusedId) <= limits.maxDepth).map(d => ({ id: d.reusedId, name: nodes[d.reusedId].name }))
      const leadName = leadNameOf(label)
      if (depth + 2 > limits.maxDepth) throw new Error(`limit reached: a team under ${nodes[parentId].name} would put its members at depth ${depth + 2} (maxDepth=${limits.maxDepth})`)
      if (!movers.length) {
        const reason = checkCreate({ parentName: nodes[parentId].name, parentDepth: depth, siblings: childrenOf(nodes, parentId), name: leadName, limits })
        if (reason) throw new Error(`${reason}. Pass a parent in your branch with room (find_bots), or the tree regroups this level by role on its own`)
      }
      leadId = await createLead(run, parentId, { key, label, movers, memberNames: done.map(d => d.name) })
      if (!leadId) throw new Error('the parent left the tree while the team was being set up')
      for (const m of movers) done.find(d => d.reusedId === m.id).moved = true
    }
    nodes = snapshot()
    if (existingLead) {
      for (const d of flat) {
        if (d.reusedId === leadId || !fits(nodes, leadId, { id: d.reusedId, name: nodes[d.reusedId].name, height: heightOf(nodes, d.reusedId) })) continue
        move(run, d.reusedId, leadId); d.moved = true
        nodes = snapshot()
      }
    }
    for (const d of done) {
      if (d.reusedId) continue
      try {
        const c = await createUnder(leadId, d.name, d.role)
        d.createdId = c.id
        run.actions.push({ op: 'place', bot: c.id, name: d.name, to: leadId, toName: snapshot()[leadId]?.name })
      } catch (error) { d.error = error instanceof Error ? error.message : String(error) }
    }
    // Only a run that changed existing Bots is a reorganization (journaled, undoable); a fresh team is a plain create.
    if (run.actions.some(a => a.op === 'move' || a.op === 'mark-lead')) commit(run)
    refreshAll()
    nodes = snapshot()
    const lead = { id: leadId, name: nodes[leadId].name, path: traceOf(nodes, leadId), ...(existingLead ? { reused: true } : { created: true }) }
    const out = done.map(d => {
      const id = d.createdId ?? d.reusedId
      if (!id) return { name: d.name, error: d.error }
      return { id, name: nodes[id]?.name ?? d.name, path: traceOf(nodes, id), ...(d.createdId ? { created: true } : { reused: true }), ...(d.moved ? { moved: true } : {}) }
    })
    const names = out.filter(m => !m.error && nodes[m.id]?.parent === leadId).map(m => m.name)
    const notes = [`Team: ${lead.path} → {${names.join(', ')}}. Delegate ${label} work to ${lead.name}; it hands each part to the member that fits.`]
    const elsewhere = out.filter(m => m.reused && !m.error && nodes[m.id]?.parent !== leadId)
    if (elsewhere.length) notes.push(`Reused where they are: ${elsewhere.map(m => m.path).join('; ')}.`)
    const failed = out.filter(m => m.error)
    if (failed.length) notes.push(`Not created: ${failed.map(m => `${m.name} (${m.error})`).join('; ')}.`)
    return { team: { lead, members: out }, note: notes.join(' ') }
  }

  return { findBots, planChild, createChild, createTeam, resolveParent }
}
