// Scoped connection credentials reuse human Project policy and existing watch grants.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { ownEntry, setEntry } from './store.js'
import { principalChecker } from './project-delegations.js'
import { WORKBENCH_ENDPOINTS } from './workbench-gateway.js'

const hash = value => createHash('sha256').update(value).digest('hex')
const refusal = (message, code = 'bot/forbidden') => Object.assign(new Error(message), { code })
const endpoints = new Set(['personal-agent-token-create', 'personal-agent-token-list', 'personal-agent-token-revoke', 'personal-agent-delegation-set', 'personal-agent-propose-task'])
const reads = new Set(['project-handoff-get', 'project-handoff-list', 'project-consultation-get', 'project-consultation-list', 'projects', 'project-read', 'project-detail', 'project-board', 'project-members', 'project-repositories', 'project-task-detail', 'project-attempt-log', 'project-task-pools', 'project-chief-state'])
const reserved = new Set(['project-agent-mode', 'project-agent-proposal-apply', 'project-agent-message', 'project-agent-history', 'project-agent-memory-write', 'project-agent-stop', 'project-delete', 'project-archive', 'project-close-prepare', 'project-close-confirm'])
const publicCredential = row => ({ version: row.version, id: row.id, agentId: row.agentId, projectIds: [...row.projectIds], createdAt: row.createdAt, expiresAt: row.expiresAt, status: row.status })
const bounded = (value, name, max) => {
  if (typeof value !== 'string' || !value.trim() || Array.from(value).length > max) throw refusal(`Invalid ${name}`, 'bot/invalid')
  return value.trim()
}

export function install(rt) {
  const { state } = rt
  const principal = principalChecker(rt)
  const credentials = () => state.personalAgentCredentials ?? {}
  function current(actor) {
    const credential = ownEntry(credentials(), actor?.personalAgentCredentialId)
    const member = ownEntry(state.members, actor?.memberId)
    const agent = credential && rt.personalAgents.agentOf(credential.agentId)
    if (!credential || credential.version !== 'personal-agent-credential/v1' || !Number.isSafeInteger(credential.generation) || credential.generation < 1 || !Number.isSafeInteger(credential.expiresAt) || !Array.isArray(credential.projectIds) || credential.projectIds.some(id => typeof id !== 'string') || credential.status !== 'active' || credential.expiresAt <= Date.now() || credential.generation !== actor.personalAgentCredentialGeneration || credential.ownerId !== actor.memberId || credential.agentId !== actor.agentId || !member || member.status === 'disabled' || !agent || agent.status !== 'active' || agent.ownerId !== member.id || credential.subject !== (member.platform?.subject ?? member.id) || credential.issuer !== (member.platform?.issuer ?? 'local')) throw refusal('Personal-agent credential is unavailable')
    return { credential, member, agent }
  }
  function scope(actor, projectId) {
    const { credential, agent } = current(actor)
    const participation = rt.personalAgents.participationFor(agent.id, projectId)
    if (!credential.projectIds.includes(projectId) || !participation || participation.status !== 'active') throw refusal('Agent Project access denied')
    const grant = rt.projectDelegations.forAgent(participation.carrierId)
    if (grant) rt.projectDelegations.validateGrant({ memberId: actor.memberId, watchGrantId: grant.id, watchGeneration: grant.generation })
    return { credential, participation, grant }
  }
  const nativeAuthenticate = rt.authenticate
  rt.authenticate = async token => {
    if (typeof token !== 'string' || !token.startsWith('fba_')) return nativeAuthenticate(token)
    const match = /^fba_([a-f0-9-]{36})\.([A-Za-z0-9_-]{43})$/.exec(token)
    const credential = match && ownEntry(credentials(), match[1])
    if (!credential || !/^[a-f0-9]{64}$/.test(credential.tokenHash ?? '') || !timingSafeEqual(Buffer.from(hash(token)), Buffer.from(credential.tokenHash))) return null
    const actor = { memberId: credential.ownerId, agentId: credential.agentId, personalAgentCredentialId: credential.id, personalAgentCredentialGeneration: credential.generation }
    try {
      const { member } = current(actor)
      if (!await principal(member)) return null
      current(actor)
      return actor
    } catch { return null }
  }
  const nativeValidate = rt.validateHumanActor
  rt.validateHumanActor = async actor => {
    if (!actor?.personalAgentCredentialId) return nativeValidate(actor)
    try { const { member } = current(actor); if (!await principal(member)) return false; current(actor); return true }
    catch { return false }
  }
  const nativeCan = rt.projectCan
  rt.projectCan = (actor, projectId, action = 'read', task) => {
    if (!actor?.personalAgentCredentialId) return nativeCan(actor, projectId, action, task)
    try { const { grant } = scope(actor, projectId); return (action === 'read' || Boolean(grant)) && nativeCan(actor, projectId, action, task) }
    catch { return false }
  }
  const nativeAuthorize = rt.authorize
  rt.authorize = (actor, endpoint, body = {}) => {
    if (actor?.personalAgentCredentialId) {
      try {
        current(actor)
        if (['auth-whoami', 'auth-revoke', 'projects'].includes(endpoint)) return nativeAuthorize(actor, endpoint, body)
        if (['personal-agent-propose-task', 'project-close-request', 'project-consultation-ask', 'project-consultation-reply', 'project-chief-question'].includes(endpoint)) scope(actor, body.projectId)
        else if (reads.has(endpoint)) {
          const projectId = body.projectId ?? body.id ?? ownEntry(state.tasks, body.taskId)?.projectId ?? ownEntry(state.projectAttempts ?? {}, body.attemptId)?.projectId
          scope(actor, projectId)
        } else if (endpoint === 'project-agents' && body.view === 'summary') scope(actor, body.projectId)
        else if (endpoint === 'project-development' && (rt.projectDevelopment.isQuery(body) || body.kind === 'command' && ['consultation.ask', 'consultation.reply', 'inbox.claim', 'inbox.renew', 'inbox.complete', 'inbox.fail'].includes(body.name))) scope(actor, body.projectId)
        else {
          const projectId = body.projectId ?? ownEntry(state.tasks, body.id ?? body.taskId)?.projectId ?? ownEntry(state.projectAttempts ?? {}, body.attemptId)?.projectId ?? ownEntry(state.projectQueue ?? {}, body.queueId)?.projectId ?? body.id
          const { grant } = scope(actor, projectId)
          const nativeWrite = ['task-create', 'task-update', 'task-cancel', 'task-answer-input'].includes(endpoint) || endpoint.startsWith('project-') && WORKBENCH_ENDPOINTS.has(endpoint) && !reserved.has(endpoint) && endpoint !== 'project-development' && endpoint !== 'project-agents'
          const developmentWrite = endpoint === 'project-development' && body.kind === 'command' && !['agent.mode', 'proposal.publish', 'inbox.connection.configure', 'github.connection.configure'].includes(body.name)
          if (!grant || !nativeWrite && !developmentWrite) throw refusal('This agent operation requires authorized watch mode')
        }
      } catch (error) { return { ok: false, code: error.code ?? 'bot/forbidden', message: error.message } }
    }
    return nativeAuthorize(actor, endpoint, body)
  }
  const nativeRevoke = rt.revokeSession
  rt.revokeSession = async token => {
    if (typeof token !== 'string' || !token.startsWith('fba_')) return nativeRevoke(token)
    const actor = await rt.authenticate(token)
    if (!actor) return false
    const credential = current(actor).credential
    credential.status = 'revoked'; credential.generation++; credential.revokedAt = Date.now()
    await rt.save()
    return true
  }
  function ownAgent(id, actor) {
    const agent = rt.personalAgents.agentOf(id)
    if (!agent || agent.ownerId !== actor.memberId || agent.status !== 'active') throw refusal('Only the active personal-agent owner may configure it')
    return agent
  }
  function source(actor, projectId, { proposal = false } = {}) {
    const { credential, participation, grant } = scope(actor, projectId)
    if (!proposal && !grant) throw refusal('Watch delegation is required')
    return { agentId: credential.agentId, ownerId: actor.memberId, credentialId: credential.id, participationId: participation.id,
      ...(grant ? { delegationId: grant.id, delegationGeneration: grant.generation } : {}), authority: proposal ? 'proposal' : 'watch' }
  }
  let tail = Promise.resolve()
  async function handle(endpoint, body, actor) {
    if (endpoint === 'personal-agent-propose-task') {
      if (!actor?.personalAgentCredentialId || !await rt.validateHumanActor(actor)) throw refusal('Authenticated personal-agent connection is required')
      const origin = source(actor, body.projectId, { proposal: true })
      if (rt.requireProjectAccess(actor, body.projectId).status !== 'active') throw refusal('Project is closed to new work')
      const requestId = bounded(body.requestId, 'proposal request ID', 100)
      const fields = { title: bounded(body.title, 'task title', 300), criteria: bounded(body.criteria, 'acceptance criteria', 2000), projectTaskKind: body.projectTaskKind,
        ...(body.impact !== undefined ? { impact: bounded(body.impact, 'Project impact', 2000) } : {}),
        ...(body.scope !== undefined ? { scope: bounded(body.scope, 'Task scope', 2000) } : {}) }
      if (!['code', 'decision', 'release'].includes(fields.projectTaskKind)) throw refusal('An explicit impactful Task kind is required', 'bot/invalid')
      const requestKey = hash(`${origin.agentId}\n${body.projectId}\n${requestId}`)
      const existing = Object.values(state.projectAgentProposals ?? {}).find(row => row.requestKey === requestKey)
      if (existing) {
        if (JSON.stringify(existing.fields) !== JSON.stringify(fields)) throw refusal('Proposal request ID has another intent', 'bot/conflict')
        return { proposal: structuredClone(existing), already: true }
      }
      const proposal = { id: `proposal-${randomUUID()}`, projectId: body.projectId, memberId: actor.memberId, fields, requestKey, personalAgentSource: origin, createdAt: Date.now() }
      state.projectAgentProposals ??= {}
      setEntry(state.projectAgentProposals, proposal.id, proposal)
      try { await rt.save() } catch (error) { delete state.projectAgentProposals[proposal.id]; throw error }
      return { proposal: structuredClone(proposal), publishRequired: true }
    }
    if (!actor?.memberId || actor.agentId || actor.watchGrantId || actor.chiefJobId || !await rt.validateHumanActor(actor)) throw refusal('Only the signed-in user may configure personal-agent access')
    if (endpoint === 'personal-agent-token-revoke') {
      const credential = ownEntry(credentials(), body.credentialId)
      if (!credential || credential.ownerId !== actor.memberId) throw refusal('Credential access denied: only its owner may revoke it')
      credential.status = 'revoked'; credential.generation++; credential.revokedAt = Date.now()
      await rt.save()
      return { credential: publicCredential(credential) }
    }
    const agent = ownAgent(body.agentId, actor)
    if (endpoint === 'personal-agent-token-list') {
      const limit = body.limit ?? 50
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw refusal('Credential page limit must be 1–200', 'bot/invalid')
      const rows = Object.values(credentials()).filter(row => row.agentId === agent.id).sort((a, b) => a.id.localeCompare(b.id))
      const index = body.after === undefined ? -1 : rows.findIndex(row => row.id === body.after)
      if (body.after !== undefined && index === -1) throw refusal('Unknown credential cursor', 'bot/invalid')
      const page = rows.slice(index + 1, index + 1 + limit)
      return { credentials: page.map(publicCredential), next: index + 1 + limit < rows.length ? page.at(-1).id : null }
    }
    if (endpoint === 'personal-agent-delegation-set') {
      rt.requireProjectAccess(actor, body.projectId, body.mode === 'watch' ? 'create' : 'read')
      return rt.projectDelegations.mode({ projectId: body.projectId, personalAgentId: agent.id, mode: body.mode }, actor)
    }
    if (!Array.isArray(body.projectIds) || !body.projectIds.length || body.projectIds.some(id => typeof id !== 'string')) throw refusal('Explicit Project scopes are required', 'bot/invalid')
    const projectIds = [...new Set(body.projectIds)]
    for (const id of projectIds) {
      rt.requireProjectAccess(actor, id)
      if (rt.personalAgents.participationFor(agent.id, id)?.status !== 'active') throw refusal('Active agent participation is required')
    }
    const ttlSeconds = body.ttlSeconds ?? 7 * 24 * 3600
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 30 * 24 * 3600) throw refusal('Credential TTL must be 60–2592000 seconds', 'bot/invalid')
    const member = ownEntry(state.members, actor.memberId)
    const id = randomUUID(), token = `fba_${id}.${randomBytes(32).toString('base64url')}`
    const credential = { version: 'personal-agent-credential/v1', id, agentId: agent.id, ownerId: actor.memberId, projectIds, status: 'active', generation: 1, tokenHash: hash(token), createdAt: Date.now(), expiresAt: Date.now() + ttlSeconds * 1000, subject: member.platform?.subject ?? member.id, issuer: member.platform?.issuer ?? 'local' }
    state.personalAgentCredentials ??= {}
    setEntry(state.personalAgentCredentials, id, credential)
    try { await rt.save() } catch (error) { delete state.personalAgentCredentials[id]; throw error }
    return { token, credential: publicCredential(credential) }
  }
  rt.personalAgentAuth = { source, current, scope,
    endpoint(endpoint, body, actor) {
      if (!endpoints.has(endpoint)) return undefined
      if (endpoint !== 'personal-agent-token-list' && rt.readOnly?.() !== undefined) return Promise.reject(refusal('Personal-agent access storage is read-only', 'bot/read-only'))
      const run = tail.then(() => handle(endpoint, body, actor))
      tail = run.catch(() => {}) // A refusal must not prevent later independent requests.
      return run
    },
  }
}
