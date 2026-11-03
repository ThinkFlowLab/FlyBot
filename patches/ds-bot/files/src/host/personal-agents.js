// User-owned identities are independent of their Project conversation carriers.
import { createHash, randomUUID } from 'node:crypto'
import { ownEntry, setEntry } from './store.js'

const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 32)
const failure = (message, code = 'bot/forbidden') => Object.assign(new Error(message), { code })
const endpoints = new Set(['personal-agent-create', 'personal-agent-read', 'personal-agent-list', 'personal-agent-join', 'personal-agent-default', 'personal-agent-participations', 'personal-agent-leave', 'personal-agent-retire', 'personal-agent-history'])
const legacyId = (projectId, ownerId) => `private-${hash(`${projectId}\n${ownerId}`)}`
const slot = (projectId, ownerId) => `${projectId}\n${ownerId}`
const bounded = (value, name, max = 120) => {
  if (typeof value !== 'string' || !value.trim() || Array.from(value).length > max) throw failure(`Invalid ${name}`, 'bot/invalid')
  return value.trim()
}

export function install(rt) {
  const { state } = rt
  const agents = () => state.personalAgents ?? {}
  const participations = () => state.personalAgentParticipations ?? {}
  const defaults = () => state.personalAgentDefaults ?? {}
  function tables() {
    for (const key of ['personalAgents', 'personalAgentParticipations', 'personalAgentDefaults']) state[key] ??= {}
  }
  const agentOf = id => ownEntry(agents(), id)
  function owned(id, ownerId) {
    const agent = agentOf(String(id ?? ''))
    if (!agent || agent.ownerId !== ownerId) throw failure('Personal agent access denied: only its owner may use it')
    return agent
  }
  function defaultAgent(ownerId) {
    tables()
    const id = `personal-agent-${hash(ownerId)}`
    let agent = agentOf(id)
    if (!agent) {
      agent = { id, ownerId, name: 'Personal agent', kind: 'internal', status: 'active', createdAt: Date.now(), memoryScopeId: id }
      setEntry(state.personalAgents, id, agent)
    }
    if (agent.status !== 'active') throw failure('Default personal agent is retired; select an active agent')
    return agent
  }
  function defaultParticipation(projectId, ownerId) {
    const row = ownEntry(participations(), ownEntry(defaults(), slot(projectId, ownerId)))
    return row?.status === 'active' && agentOf(row.agentId)?.status === 'active' ? row : null
  }
  function join(agent, projectId, { carrierId } = {}) {
    if (agent.status !== 'active') throw failure('Personal agent is retired')
    tables()
    const id = `participation-${hash(`${agent.id}\n${projectId}`)}`
    let row = ownEntry(state.personalAgentParticipations, id)
    if (row) { row.status = 'active'; return row }
    const old = legacyId(projectId, agent.ownerId)
    const oldTaken = Object.values(participations()).some(item => item.carrierId === old)
    row = { id, agentId: agent.id, ownerId: agent.ownerId, projectId, status: 'active', createdAt: Date.now(),
      carrierId: carrierId ?? (!oldTaken ? old : `private-${hash(id)}`), contextScopeId: id }
    setEntry(state.personalAgentParticipations, id, row)
    if (!ownEntry(defaults(), slot(projectId, agent.ownerId))) setEntry(state.personalAgentDefaults, slot(projectId, agent.ownerId), id)
    return row
  }
  function ensure(projectId, ownerId) {
    const current = defaultParticipation(projectId, ownerId)
    if (current) return current
    if (ownEntry(defaults(), slot(projectId, ownerId))) throw failure('Personal agent participation ended; explicitly rejoin or select another agent')
    return join(defaultAgent(ownerId), projectId)
  }
  function migrate() {
    const missing = !state.personalAgents || !state.personalAgentParticipations || !state.personalAgentDefaults
    tables()
    let changed = missing
    for (const old of Object.values(state.projectAgents ?? {})) {
      if (old.visibility !== 'private' || !ownEntry(state.members, old.memberId) || !old.projectId || old.personalAgentId) continue
      const row = join(defaultAgent(old.memberId), old.projectId, { carrierId: old.id })
      row.status = old.status === 'retired' ? 'retired' : 'active'
      old.personalAgentId = row.agentId
      old.participationId = row.id
      changed = true
    }
    return changed
  }
  function requireParticipation(carrier) {
    if (!carrier?.participationId) return // Pre-migration test/legacy carriers remain isolated.
    const row = ownEntry(participations(), carrier.participationId)
    const agent = row && agentOf(row.agentId)
    if (!row || row.status !== 'active' || !agent || agent.status !== 'active' || row.agentId !== carrier.personalAgentId || row.ownerId !== carrier.memberId || row.projectId !== carrier.projectId || row.carrierId !== carrier.id) throw failure('Personal agent participation is unavailable')
  }
  let tail = Promise.resolve()
  async function handle(endpoint, body, actor) {
    const ownerId = actor?.memberId
    if (!ownerId || !ownEntry(state.members, ownerId) || ownEntry(state.members, ownerId).status === 'disabled' || actor.agentId || actor.watchGrantId || actor.chiefJobId) throw failure('A current user session is required')
    if (!await rt.validateHumanActor(actor) || ownEntry(state.members, ownerId)?.status === 'disabled') throw failure('Current user session is unavailable')
    const read = ['personal-agent-read', 'personal-agent-list', 'personal-agent-participations', 'personal-agent-history'].includes(endpoint)
    if (!read && rt.readOnly?.() !== undefined) throw failure('Personal agent storage is read-only', 'bot/read-only')
    if (endpoint === 'personal-agent-list' || endpoint === 'personal-agent-participations') {
      const limit = body.limit ?? 50
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw failure('Limit must be 1–200', 'bot/invalid')
      const rows = Object.values(endpoint === 'personal-agent-list' ? agents() : participations()).filter(row => row.ownerId === ownerId).sort((a, b) => a.id.localeCompare(b.id))
      const index = body.after === undefined ? -1 : rows.findIndex(row => row.id === body.after)
      if (body.after !== undefined && index === -1) throw failure('Unknown personal-agent cursor', 'bot/invalid')
      const page = rows.slice(index + 1, index + 1 + limit)
      return { [endpoint === 'personal-agent-list' ? 'agents' : 'participations']: structuredClone(page), next: index + 1 + limit < rows.length ? page.at(-1).id : null }
    }
    if (endpoint === 'personal-agent-create') {
      const name = bounded(body.name, 'agent name')
      const kind = body.kind ?? 'internal'
      if (!['internal', 'external'].includes(kind)) throw failure('Invalid personal agent kind', 'bot/invalid')
      let connection
      if (kind === 'external') {
        const provider = bounded(body.provider, 'external provider')
        let url
        try { url = new URL(body.endpoint) } catch { throw failure('Invalid external endpoint', 'bot/invalid') }
        if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw failure('External endpoint must be HTTPS without credentials, query or fragment', 'bot/invalid')
        connection = { provider, endpoint: url.href, protocol: 'flybot-agent/v1', status: 'unverified' }
      }
      const id = `personal-agent-${randomUUID()}`
      const agent = { id, ownerId, name, kind, status: 'active', createdAt: Date.now(), memoryScopeId: id, ...(connection ? { connection } : {}) }
      tables()
      setEntry(state.personalAgents, id, agent)
      try { await rt.save() } catch (error) { delete state.personalAgents[id]; throw error }
      return { agent: structuredClone(agent) }
    }
    const agent = owned(body.agentId, ownerId)
    if (endpoint === 'personal-agent-read') return { agent: structuredClone(agent) }
    if (endpoint === 'personal-agent-history') {
      const row = Object.values(participations()).find(item => item.agentId === agent.id && item.projectId === body.projectId)
      if (!row) throw failure('Unknown personal agent participation')
      const limit = body.limit ?? 50, offset = body.offset ?? 0
      if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) throw failure('Invalid private history page', 'bot/invalid')
      const items = ownEntry(state.projectAgentTranscripts ?? {}, row.carrierId) ?? []
      return { agentId: agent.id, participationId: row.id, items: structuredClone(items.slice(offset, offset + limit)), nextOffset: offset + limit < items.length ? offset + limit : null }
    }
    const prior = structuredClone({ agents: agents(), participations: participations(), defaults: defaults(), grants: state.projectAgentGrants ?? {} })
    if (endpoint === 'personal-agent-retire') {
      agent.status = 'retired'
      agent.retiredAt = Date.now()
      for (const row of Object.values(participations())) if (row.agentId === agent.id) row.status = 'retired'
    } else {
      const project = rt.requireProjectAccess(actor, body.projectId, endpoint === 'personal-agent-leave' ? 'read' : 'create')
      if (endpoint === 'personal-agent-join') join(agent, project.id)
      else {
        const row = Object.values(participations()).find(item => item.agentId === agent.id && item.projectId === project.id)
        if (!row || row.status !== 'active' || agent.status !== 'active') throw failure('Active participation is required')
        if (endpoint === 'personal-agent-default') setEntry(state.personalAgentDefaults, slot(project.id, ownerId), row.id)
        else row.status = 'left'
      }
    }
    const revoked = []
    if (endpoint === 'personal-agent-leave' || endpoint === 'personal-agent-retire') {
      const carriers = new Set(Object.values(participations()).filter(row => row.agentId === agent.id && row.status !== 'active').map(row => row.carrierId))
      for (const grant of Object.values(state.projectAgentGrants ?? {})) {
        if (grant.status === 'active' && carriers.has(grant.agentId)) {
          grant.status = 'revoked'; grant.revokedAt = Date.now(); grant.generation++
          revoked.push(grant.id)
        }
      }
    }
    // Roll back only records changed by this operation, and never overwrite a
    // concurrent revocation or another identity created by a native carrier.
    const changes = []
    for (const [key, table] of [['agents', 'personalAgents'], ['participations', 'personalAgentParticipations'], ['defaults', 'personalAgentDefaults'], ['grants', 'projectAgentGrants']]) {
      for (const id of new Set([...Object.keys(prior[key]), ...Object.keys(state[table] ?? {})])) {
        const before = ownEntry(prior[key], id), after = ownEntry(state[table] ?? {}, id)
        if (JSON.stringify(before) !== JSON.stringify(after)) changes.push({ table, id, before, expected: JSON.stringify(after) })
      }
    }
    try { await rt.save() }
    catch (error) {
      for (const change of changes) {
        if (JSON.stringify(ownEntry(state[change.table] ?? {}, change.id)) !== change.expected) continue
        if (change.before === undefined) delete state[change.table][change.id]
        else setEntry(state[change.table], change.id, change.before)
      }
      throw error
    }
    for (const id of revoked) rt.projectAgents.revokeWatchGrant(id)
    if (endpoint === 'personal-agent-retire') return { agent: structuredClone(agent) }
    const row = Object.values(participations()).find(item => item.agentId === agent.id && item.projectId === body.projectId)
    return { participation: structuredClone(row), agent: structuredClone(agent) }
  }
  rt.personalAgents = { migrate, ensure, agentOf, defaultParticipation, requireParticipation,
    participationFor: (agentId, projectId) => Object.values(participations()).find(row => row.agentId === agentId && row.projectId === projectId),
    carrierId: (projectId, ownerId) => defaultParticipation(projectId, ownerId)?.carrierId ?? legacyId(projectId, ownerId),
    endpoint(endpoint, body, actor) {
      if (!endpoints.has(endpoint)) return undefined
      const run = tail.then(() => handle(endpoint, body, actor))
      tail = run.catch(() => {}) // A rejected command must not poison the next one.
      return run
    },
  }
}
