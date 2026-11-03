// Persistent user delegation is distinct from browser sessions and model role labels.
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { ownEntry, setEntry } from './store.js'
const refuse = message => Object.assign(new Error(message), { code: 'bot/delegation' })
export function principalChecker(rt, { run } = {}) {
  return async member => {
    if (!member?.platform) return Boolean(member && member.status !== 'disabled')
    const argv = rt.config.controlPlane?.principalCheckCommand
    if (!Array.isArray(argv) || !argv.length || argv.some(value => typeof value !== 'string' || !value || value.length > 1000) || !argv[0].startsWith('/')) throw refuse('Persistent watch requires an operator-configured platform principal checker')
    const nonce = randomUUID(), payload = JSON.stringify({ version: 'platform-principal/v1', subject: member.platform.subject, nonce })
    const output = run ? await run(argv, payload) : await new Promise((resolve, reject) => {
      const child = execFile(argv[0], argv.slice(1), { timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 8192, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8' } }, (error, stdout) => error ? reject(refuse('Platform principal checker is unavailable')) : resolve(stdout))
      child.stdin.on('error', () => {})
      child.stdin.end(payload)
    })
    let result
    try { result = JSON.parse(output) } catch { throw refuse('Platform principal checker returned invalid evidence') }
    return result.version === 'platform-principal/v1' && result.nonce === nonce && result.subject === member.platform.subject && result.status === 'active'
  }
}
export function createProjectDelegations(rt, { principal = principalChecker(rt) } = {}) {
  const grants = () => (rt.state.projectAgentGrants ??= {})
  const forAgent = id => Object.values(grants()).find(row => row.agentId === id && row.status === 'active')
  function validateGrant(actor) {
    const grant = ownEntry(grants(), actor?.watchGrantId)
    const member = ownEntry(rt.state.members, actor?.memberId)
    if (!grant || grant.status !== 'active' || grant.memberId !== actor.memberId || actor.agentId && actor.agentId !== grant.agentId || grant.generation !== actor.watchGeneration || !member || member.status === 'disabled' || grant.subject !== (member.platform?.subject ?? member.id) || grant.issuer !== (member.platform?.issuer ?? 'local')) throw refuse('Watch delegation has been revoked or its principal changed')
    const carrier = ownEntry(rt.state.projectAgents ?? {}, grant.agentId)
    if (carrier) rt.personalAgents?.requireParticipation(carrier)
    return grant
  }
  async function validateActor(actor) {
    const grant = validateGrant(actor), member = ownEntry(rt.state.members, actor.memberId)
    if (!await principal(member)) { grant.status = 'revoked'; grant.revokedAt = Date.now(); ++grant.generation; await rt.save(); throw refuse('Delegated human account is unavailable or disabled') }
    validateGrant(actor)
    rt.requireProjectAccess(actor, grant.projectId)
    return true
  }
  async function actorFor(agentId) {
    const grant = forAgent(agentId)
    if (!grant) return null
    const actor = { memberId: grant.memberId, agentId: grant.agentId, watchGrantId: grant.id, watchGeneration: grant.generation }
    await validateActor(actor)
    return actor
  }
  async function mode(body, actor) {
    if (actor.watchGrantId || actor.agentId || actor.chiefJobId) throw refuse('Only the signed-in human can change their delegation mode')
    const projectId = String(body.projectId ?? '')
    rt.requireProjectAccess(actor, projectId)
    if (!['safe', 'watch'].includes(body.mode)) throw refuse('Agent mode must be safe or watch')
    const participation = body.personalAgentId ? rt.personalAgents.participationFor(body.personalAgentId, projectId) : null
    if (body.personalAgentId && (!participation || participation.ownerId !== actor.memberId || participation.status !== 'active' || rt.personalAgents.agentOf(body.personalAgentId)?.status !== 'active')) throw refuse('Active personal-agent participation is required')
    const agentId = participation?.carrierId ?? rt.projectAgents.privateIdentity(projectId, actor.memberId)
    const old = forAgent(agentId)
    if (body.mode === 'watch') {
      const member = ownEntry(rt.state.members, actor.memberId)
      if (!await principal(member)) throw refuse('Delegated human account is unavailable or disabled')
      rt.requireProjectAccess(actor, projectId)
      if (old) return { mode: 'watch', grant: publicGrant(old), already: true }
      const grant = { id: `agent-grant-${randomUUID()}`, agentId, projectId, memberId: actor.memberId, issuer: member.platform?.issuer ?? 'local', subject: member.platform?.subject ?? member.id, generation: 1, status: 'active', createdAt: Date.now() }
      setEntry(grants(), grant.id, grant)
      await rt.save()
      return { mode: 'watch', grant: publicGrant(grant) }
    }
    if (old) { old.status = 'revoked'; old.revokedAt = Date.now(); ++old.generation; rt.projectAgents.revokeWatchGrant?.(old.id) }
    await rt.save()
    return { mode: 'safe', grant: null }
  }
  function publicGrant(grant) { return { id: grant.id, projectId: grant.projectId, memberId: grant.memberId, generation: grant.generation, status: grant.status, createdAt: grant.createdAt } }
  function view(agentId) { const grant = forAgent(agentId); return { mode: grant ? 'watch' : 'safe', grant: grant ? publicGrant(grant) : null } }
  async function human(actor) {
    if (actor?.chiefJobId) return rt.projectChiefControl.validateActor(actor)
    if (actor?.watchGrantId) return validateActor(actor)
    return !rt.platformIdentityEnabled || Boolean(await rt.validatePlatformActor(actor))
  }
  function revoke(projectId, memberId) {
    for (const grant of Object.values(grants())) if (grant.projectId === projectId && grant.memberId === memberId && grant.status === 'active') { grant.status = 'revoked'; grant.revokedAt = Date.now(); ++grant.generation }
  }
  async function background(memberId, sessionId) {
    const member = ownEntry(rt.state.members, memberId)
    if (!member || member.status === 'disabled') throw refuse('Execution principal is unavailable')
    if (member.platform && !rt.config.controlPlane?.principalCheckCommand) {
      if (!sessionId || !await rt.validatePlatformActor({ memberId, sessionId })) throw refuse('Background execution requires a current principal check or live initiating session')
    } else if (!await principal(member)) throw refuse('Execution principal is unavailable or disabled')
    return true
  }
  return { mode, actorFor, revoke, background, validateGrant, validateActor, human, view, forAgent }
}
export function install(rt) {
  rt.projectDelegations = createProjectDelegations(rt)
  rt.validateHumanActor = actor => rt.projectDelegations.human(actor)
  const requireAccess = rt.requireProjectAccess
  rt.requireProjectAccess = (actor, projectId, ...args) => {
    if (actor?.chiefJobId) rt.projectChiefControl.requireJobActor(actor, projectId)
    if (actor?.watchGrantId) {
      const grant = rt.projectDelegations.validateGrant(actor)
      if (grant.projectId !== projectId) throw refuse('Watch delegation belongs to another Project')
    }
    return requireAccess(actor, projectId, ...args)
  }
}
