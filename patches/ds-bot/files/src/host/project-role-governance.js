// Chief proposes; the current Maintainer/Owner decides. Definitions stay separate
// from member roles, personal agents, worker Sessions and execution initiative.
import { createHash, randomUUID } from 'node:crypto'
import { ownEntry, setEntry } from './store.js'
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const copy = value => structuredClone(value)
const fail = (message, code = 'bot/role-governance') => Object.assign(new Error(message), { code })
const roleKey = value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(value)
const requestKey = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value)
const bounded = (value, max, name) => { if (typeof value !== 'string' || !value.trim() || [...value].length > max) throw fail(`Invalid bounded ${name}`); return value.trim() }

export function createProjectRoleGovernance(rt, ports) {
  let tail = Promise.resolve()
  const serial = action => { const result = tail.then(action, action); tail = result.catch(() => {}); return result }
  const proposals = () => rt.state.projectRoleProposals ?? {}
  const previousSets = new Map()
  rt.projectEffects?.register('role.governance', { run: effect => ({ proposalId: effect.payload.proposalId ?? null, changeId: effect.payload.changeId ?? null, status: 'durable-role-record' }) })
  const committed = token => Boolean(token && rt.projectEffects?.intentCommitted(token))
  function visibleSet(projectId, current = ports.readDefinitionSet ? ports.readDefinitionSet(projectId) : ports.definitionSet(projectId)) {
    if (!current.changeEffect || committed(current.changeEffect)) return current
    const previous = previousSets.get(projectId)
    if (!previous) throw fail('Role definition change is not committed', 'bot/conflict')
    return previous
  }
  async function approver(actor, projectId) {
    if (rt.state.members?.[actor?.memberId]?.status === 'disabled') throw fail('Role approver is disabled', 'bot/forbidden')
    if (actor?.chiefJobId) throw fail('Chief cannot approve its own governance proposal', 'bot/forbidden')
    const carrier = actor?.agentId && ownEntry(rt.state.projectAgents ?? {}, actor.agentId)
    if (carrier?.visibility === 'public') throw fail('Public Chief cannot impersonate its approver', 'bot/forbidden')
    if (rt.validateHumanActor && !await rt.validateHumanActor(actor)) throw fail('Role approver is unavailable', 'bot/forbidden')
    rt.requireProjectAccess(actor, projectId, 'configure')
    rt.projects.requireActive(projectId)
    if (rt.readOnly?.() !== undefined) throw fail('Role governance is read-only', 'bot/read-only')
  }
  async function persist({ key, projectId, payload, apply, undo, definitionSet }) {
    let token
    try {
      token = rt.projectEffects?.stage({ kind: 'role.governance', key, projectId, payload })
      if (!token) throw fail('Role governance requires the durable Effects service')
      apply(token)
      if (definitionSet) definitionSet.changeEffect = token
      await rt.projectEffects.persist(token)
    } catch (error) {
      // A queued snapshot may already contain this legitimate staged change.
      // Settle that queue before undoing it, so a later commit cannot resurrect
      // an already-rolled-back approval. Readers use the previous committed set.
      await rt.savesSettled?.()
      if (token && committed(token)) return token
      if (!token || rt.projectEffects.discardUncommitted(token)) undo()
      throw error
    } finally { if (definitionSet) previousSets.delete(projectId) }
    return token
  }
  function metadata(row) {
    const decisionCommitted = !row.decision || committed(row.decision.effect)
    return { id: row.id, version: row.version, projectId: row.projectId, requestId: row.requestId, action: row.action, role: row.role, policyRole: row.definition?.policyRole ?? null,
      reason: row.reason, status: decisionCommitted ? row.status : 'decision-pending-commit', baseRevision: row.baseRevision, sha256: row.sha256, proposedBy: copy(row.proposedBy), createdAt: row.createdAt,
      decision: row.decision ? copy(row.decision) : null, committed: committed(row.effect), sourceRef: { endpoint: 'project-role-proposals', projectId: row.projectId, proposalId: row.id } }
  }
  async function propose(body, authority) {
    await ports.requireChief(authority)
    const projectId = authority.projectId
    rt.projects.requireActive(projectId)
    if (rt.readOnly?.() !== undefined || !requestKey(body.requestId) || !['add', 'update', 'remove'].includes(body.action) || !roleKey(body.role)) throw fail('Invalid role proposal')
    if (body.role === 'chief' && body.action === 'remove') throw fail('The resident Chief cannot be removed')
    const reason = bounded(body.reason, 4000, 'role change reason'), set = ports.definitionSet(projectId), revision = set.revision, existing = set.roles.find(row => row.role === body.role)
    const requestId = `role-proposal-${digest([projectId, 'chief', body.requestId])}`
    const intent = digest({ action: body.action, role: body.role, reason, fields: body.fields ?? {} })
    const prior = ownEntry(proposals(), requestId)
    if (prior) { if (prior.intent !== intent) throw fail('Role proposal requestId was reused', 'bot/conflict'); return { proposal: metadata(prior), already: true } }
    if (body.action === 'add' && existing || body.action !== 'add' && !existing) throw fail('Role existence changed before proposal')
    if (body.action === 'add' && set.roles.length >= 32) throw fail('Project role catalog is at capacity')
    const fields = body.fields ?? {}
    if (!fields || typeof fields !== 'object' || Array.isArray(fields) || Object.keys(fields).some(key => !['name', 'instructions', 'model', 'skills', 'memoryRefs', 'execution', 'policyRole', 'tools'].includes(key)) || body.action === 'remove' && Object.keys(fields).length) throw fail('Unsupported role proposal fields')
    const retired = ownEntry(rt.state.projectRetiredRoles ?? {}, `${projectId}:${body.role}`)
    const policyRole = fields.policyRole ?? existing?.policyRole ?? retired?.policyRole ?? (['chief', 'developer', 'tester', 'reviewer'].includes(body.role) ? body.role : 'developer')
    if (!['chief', 'developer', 'tester', 'reviewer'].includes(policyRole) || body.role !== 'chief' && policyRole === 'chief') throw fail('Only the resident Chief has Chief capabilities')
    const restored = retired ? Object.fromEntries(Object.entries(retired).filter(([key]) => !['projectId', 'retiredAt', 'retiredBy', 'revision', 'changeId'].includes(key))) : null
    const base = existing ?? restored ?? { ...ports.baseDefinition(projectId, policyRole), role: body.role, id: `${projectId}:${body.role}`, name: body.role, policyRole, memoryRefs: [] }
    const definition = body.action === 'remove' ? null : await ports.prepareDefinition(base, fields, projectId)
    await ports.requireChief(authority)
    if (ports.definitionSet(projectId).revision !== revision) throw fail('Role definitions changed during proposal', 'bot/conflict')
    const row = { id: requestId, version: 'project-role-proposal/v1', projectId, requestId: body.requestId, intent, action: body.action, role: body.role,
      definition: definition ? copy(definition) : null, reason, baseRevision: revision, proposedBy: { kind: 'chief', botId: `${projectId}:chief`, sourceId: authority.sourceId, initiatedBy: authority.memberId }, status: 'proposed', createdAt: Date.now() }
    row.sha256 = digest({ projectId, action: row.action, role: row.role, definition, reason, baseRevision: row.baseRevision })
    rt.state.projectRoleProposals ??= {}
    await persist({ key: `propose:${row.id}`, projectId, payload: { proposalId: row.id, sha256: row.sha256 },
      apply(token) { row.effect = token; setEntry(rt.state.projectRoleProposals, row.id, row) }, undo() { if (ownEntry(proposals(), row.id) === row) delete rt.state.projectRoleProposals[row.id] } })
    return { proposal: metadata(row), already: false }
  }
  async function decide(body, actor) {
    const projectId = body.projectId
    await approver(actor, projectId)
    const row = ownEntry(proposals(), body.proposalId)
    if (!row || row.projectId !== projectId || !committed(row.effect)) throw fail('Role proposal is unavailable in this Project', 'bot/forbidden')
    if (!requestKey(body.requestId) || !['approve', 'reject'].includes(body.decision) || body.expectedSha256 !== row.sha256) throw fail('Role approval requires the exact current proposal hash and stable requestId', 'bot/conflict')
    if (digest({ projectId, action: row.action, role: row.role, definition: row.definition, reason: row.reason, baseRevision: row.baseRevision }) !== row.sha256) throw fail('Role proposal content changed after publication', 'bot/conflict')
    if (row.status !== 'proposed') {
      if (row.decision?.requestId === body.requestId && row.decision.by === actor.memberId && row.decision.verdict === body.decision && committed(row.decision.effect)) return { proposal: metadata(row), definitions: copy(visibleSet(projectId)), already: true }
      throw fail('Role proposal was already decided', 'bot/conflict')
    }
    const set = ports.definitionSet(projectId), revision = set.revision
    let definition
    if (body.decision === 'approve') {
      if (revision !== row.baseRevision) throw fail('Role proposal is stale; ask Chief to rebase it', 'bot/conflict')
      if (row.definition) {
        definition = await ports.prepareDefinition(row.definition, {}, projectId)
        if (digest(definition) !== digest(row.definition)) throw fail('Proposed definition sources changed', 'bot/conflict')
      }
    }
    await approver(actor, projectId)
    if (set.revision !== revision || row.status !== 'proposed') throw fail('Role decision changed during approval', 'bot/conflict')
    const before = copy(set), original = copy(row), role = set.roles.find(item => item.role === row.role)
    const changeId = `role-change-${randomUUID()}`, previousRetired = ownEntry(rt.state.projectRetiredRoles ?? {}, `${projectId}:${row.role}`)
    previousSets.set(projectId, before)
    await persist({ key: `decision:${row.id}:${body.requestId}`, projectId, definitionSet: body.decision === 'approve' ? set : null,
      payload: { proposalId: row.id, changeId, verdict: body.decision, sha256: row.sha256, approvedBy: actor.memberId },
      apply(token) {
        row.status = body.decision === 'approve' ? 'approved' : 'rejected'
        row.decision = { requestId: body.requestId, verdict: body.decision, by: actor.memberId, ...(actor.agentId ? { actingAgentId: actor.agentId } : {}), at: Date.now(), effect: token }
        if (body.decision !== 'approve') return
        if (row.action === 'remove') {
          set.roles = set.roles.filter(item => item.role !== row.role)
          rt.state.projectRetiredRoles ??= {}
          setEntry(rt.state.projectRetiredRoles, `${projectId}:${row.role}`, { ...copy(role), projectId, retiredAt: Date.now(), retiredBy: actor.memberId, revision: revision + 1, changeId })
        } else if (role) Object.assign(role, copy(definition))
        else set.roles.push(copy(definition))
        ++set.revision
        rt.state.projectRoleChanges ??= {}
        setEntry(rt.state.projectRoleChanges, changeId, { id: changeId, projectId, proposalId: row.id, action: row.action, role: row.role, by: actor.memberId, fromRevision: revision, toRevision: set.revision, previous: role ? copy(original.action === 'remove' ? role : before.roles.find(item => item.role === row.role)) : null, next: definition ? copy(definition) : null, at: Date.now(), effect: token })
      }, undo() {
        setEntry(rt.state.projectAgentDefinitions, projectId, before)
        setEntry(rt.state.projectRoleProposals, row.id, original)
        if (rt.state.projectRoleChanges) delete rt.state.projectRoleChanges[changeId]
        if (previousRetired) setEntry(rt.state.projectRetiredRoles, `${projectId}:${row.role}`, previousRetired)
        else if (rt.state.projectRetiredRoles) delete rt.state.projectRetiredRoles[`${projectId}:${row.role}`]
      } })
    previousSets.delete(projectId)
    return { proposal: metadata(row), definitions: copy(visibleSet(projectId)), already: false }
  }
  async function update(body, actor) {
    await approver(actor, body.projectId)
    const set = ports.definitionSet(body.projectId), revision = set.revision, role = set.roles.find(row => row.role === body.role)
    if (!role) throw fail('Unknown public agent role')
    const next = await ports.prepareDefinition(role, body, body.projectId)
    await approver(actor, body.projectId)
    if (set.revision !== revision) throw fail('Role definitions changed during update', 'bot/conflict')
    const before = copy(set), id = `role-change-${randomUUID()}`
    previousSets.set(body.projectId, before)
    await persist({ key: `direct:${id}`, projectId: body.projectId, definitionSet: set, payload: { changeId: id, role: role.role, by: actor.memberId, sha256: digest(next) },
      apply(token) {
        Object.assign(role, next); ++set.revision
        rt.state.projectRoleChanges ??= {}
        setEntry(rt.state.projectRoleChanges, id, { id, projectId: body.projectId, role: role.role, action: 'update', by: actor.memberId, fromRevision: revision, toRevision: set.revision, previous: before.roles.find(row => row.role === role.role), next: copy(next), at: Date.now(), effect: token })
      }, undo() { setEntry(rt.state.projectAgentDefinitions, body.projectId, before); if (rt.state.projectRoleChanges) delete rt.state.projectRoleChanges[id] } })
    return { definitions: copy(visibleSet(body.projectId)) }
  }
  function list(body, actor) {
    rt.requireProjectAccess(actor, body.projectId)
    if (body.proposalId) {
      const row = ownEntry(proposals(), body.proposalId)
      if (!row || row.projectId !== body.projectId || !committed(row.effect)) throw fail('Role proposal is unavailable', 'bot/forbidden')
      return { proposal: metadata(row), definition: copy(row.definition) }
    }
    const limit = body.limit ?? 20
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw fail('Invalid role proposal page limit')
    const rows = Object.values(proposals()).filter(row => row.projectId === body.projectId && committed(row.effect)).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    const index = body.after === undefined ? -1 : rows.findIndex(row => row.id === body.after)
    if (body.after !== undefined && index < 0) throw fail('Role proposal cursor is unavailable')
    const page = rows.slice(index + 1, index + 1 + limit)
    return { proposals: page.map(metadata), next: index + 1 + page.length < rows.length ? page.at(-1).id : null }
  }
  function catalog(body, actor) {
    rt.requireProjectAccess(actor, body.projectId)
    const set = visibleSet(body.projectId)
    if (body.role) {
      const row = set.roles.find(row => row.role === body.role) ?? ownEntry(rt.state.projectRetiredRoles ?? {}, `${body.projectId}:${body.role}`)
      if (!row) throw fail('Role is unavailable in this Project')
      const text = JSON.stringify(row), offset = body.offset ?? 0, limit = body.limit ?? 8000, sha256 = digest(row)
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length || !Number.isSafeInteger(limit) || limit < 1 || limit > 16000 || body.expectedSha256 !== undefined && body.expectedSha256 !== sha256) throw fail('Role source changed or page is invalid', 'bot/conflict')
      const next = offset + limit
      return { projectId: body.projectId, revision: set.revision, sha256, text: text.slice(offset, next), nextOffset: next < text.length ? next : null }
    }
    return { projectId: body.projectId, revision: set.revision, roles: set.roles.map(row => ({ id: row.id, role: row.role, name: row.name, policyRole: row.policyRole ?? row.role, model: row.model, execution: copy(row.execution), sourceRef: { endpoint: 'project-roles', projectId: body.projectId, role: row.role } })) }
  }
  return { visibleSet, propose: (body, authority) => serial(() => propose(body, authority)), decide: (body, actor) => serial(() => decide(body, actor)), update: (body, actor) => serial(() => update(body, actor)), list, catalog }
}
