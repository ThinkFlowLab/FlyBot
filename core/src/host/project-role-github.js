import { redactDeep } from './secrets.js'
// Role-scoped App grants reuse the original installation provider. No ambient fallback.
import { createHash } from 'node:crypto'
import { ownEntry } from './store.js'
import { resolveGithubIdentity } from './project-github.js'
import { githubCredentialBinding, githubIdentityMetadata } from './project-github-app.js'
import { requireExecutionAuthority } from './project-execution-authority.js'
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const refuse = message => Object.assign(new Error(message), { code: 'bot/github-role' })
const permissions = { developer: { contents: 'write', pull_requests: 'write' }, reviewer: { contents: 'read', pull_requests: 'write', checks: 'read', actions: 'read' }, tester: { contents: 'read', pull_requests: 'read', checks: 'write' }, chief: { contents: 'read', pull_requests: 'read', checks: 'read' } }
export function roleGithubSelection(rt, project, role, policyRole = role) {
  const config = ownEntry(rt.config.projectRepositories ?? {}, project.repository)?.roleGithub
  if (!config || config.enabled === false) return null
  if (config.enabled !== true || !Array.isArray(config.branches) || !config.branches.includes(project.defaultBranch ?? 'main') || !Number.isSafeInteger(config.revision) || config.revision < 1) throw refuse('Role GitHub mode needs an explicit current base branch and revision')
  if (config.downloadHosts !== undefined && (!Array.isArray(config.downloadHosts) || config.downloadHosts.length > 8 || config.downloadHosts.some(host => typeof host !== 'string' || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:githubusercontent\.com|blob\.core\.windows\.net)$/.test(host)))) throw refuse('Role download hosts must be exact approved GitHub storage hostnames')
  const slot = ownEntry(config.roles ?? {}, role) ?? ownEntry(config.roles ?? {}, policyRole)
  if (!slot && !['developer', 'reviewer'].includes(policyRole)) return null
  const connection = slot && ownEntry(rt.config.projectGithubConnections ?? {}, slot.connectionId)
  if (!permissions[policyRole] || !slot || !connection || connection.enabled === false || connection.credential !== 'github-app' || !connection.projectIds?.includes(project.id) || !connection.repositories?.includes(project.repository)) throw refuse('Role requires its explicitly provisioned GitHub App connection')
  const settings = { ...connection, connectionId: slot.connectionId, connectionRevision: config.revision }
  return { settings, metadata: { version: 'project-role-github/v1', projectId: project.id, repository: project.repository, role, policyRole, connectionId: slot.connectionId, revision: config.revision, binding: githubCredentialBinding(settings, project.repository), permissions: { ...permissions[policyRole] }, baseBranch: project.defaultBranch ?? 'main', downloadHosts: [...new Set(config.downloadHosts ?? [])] } }
}
export function roleGithubStatus(rt, project) {
  const config = ownEntry(rt.config.projectRepositories ?? {}, project.repository)?.roleGithub
  if (!config || config.enabled === false) return { enabled: false, roles: [] }
  const rows = Object.entries(config.roles ?? {}).slice(0, 32).map(([role]) => {
    try { const value = roleGithubSelection(rt, project, role, rt.projectAgents?.deliveryDefinitions(project.id).roles.find(row => row.role === role)?.policyRole ?? role); return { role, connectionId: value.metadata.connectionId, appId: value.settings.appId, installationId: value.settings.installationId, revision: value.metadata.revision, status: 'configured' } }
    catch { return { role, status: 'unavailable' } }
  })
  return { enabled: true, revision: config.revision, identityReuse: rows.some(row => row.role === 'developer' && row.appId && rows.some(other => other.role === 'reviewer' && row.appId === other.appId)), roles: rows, verification: 'configuration-only; each grant and observed artifact is independently verified' }
}
export function createRoleGithub(rt, { identity = resolveGithubIdentity, request = fetch } = {}) {
  const secrets = new Set(), bots = new Map()
  const projectOf = session => { const project = rt.readProject(session.projectId), attempt = rt.state.projectAttempts?.[session.attemptId]; return { ...project, repository: attempt?.requirement?.repository ?? project?.repository, defaultBranch: attempt?.repositoryBinding?.defaultBranch ?? project?.defaultBranch } }
  async function resolve(session) {
    const project = projectOf(session), selection = roleGithubSelection(rt, project, session.role, session.policyRole ?? session.role)
    if (!selection) return null
    const attempt = rt.state.projectAttempts?.[session.attemptId]
    const branch = attempt?.publicationBinding?.branch ?? attempt?.branch
    if (typeof branch !== 'string' || !/^flybot\/[A-Za-z0-9._/-]+$/.test(branch) || branch.includes('..')) throw refuse('Role GitHub needs the original controlled delivery branch')
    const value = await identity(selection.settings, { repository: project.repository, permissions: selection.metadata.permissions, request })
    if (value.provider !== 'github-app') throw refuse('Role GitHub cannot downgrade to personal credentials')
    if (secrets.size >= 256) secrets.delete(secrets.values().next().value)
    secrets.add(value.token)
    const botKey = `${value.appId}:${value.login}`
    let bot = bots.get(botKey)
    if (!bot) {
      const response = await request(`https://api.github.com/users/${encodeURIComponent(value.login)}`, { redirect: 'error', signal: AbortSignal.timeout(15000), headers: { authorization: `Bearer ${value.token}`, accept: 'application/vnd.github+json' } })
      if (!response.ok) throw refuse('App Bot Git author identity is unavailable')
      bot = await response.json()
      if (bot.type !== 'Bot' || bot.login?.toLowerCase() !== value.login.toLowerCase() || !Number.isSafeInteger(bot.id) || bot.id < 1) throw refuse('App Bot Git author identity does not match installation')
      if (bots.size >= 128) bots.delete(bots.keys().next().value)
      bots.set(botKey, bot)
    }
    const metadata = { ...selection.metadata, taskId: session.taskId, attemptId: session.attemptId, sessionKey: session.id, claimId: session.poolClaimId ?? null, claimGeneration: session.generation, resourceId: session.resourceLease?.resourceId ?? null, leaseId: session.resourceLease?.id ?? null, leaseGeneration: session.resourceLease?.generation ?? null, seedSha: attempt?.seedSha ?? attempt?.baseSha, candidateSha: (session.policyRole ?? session.role) === 'developer' ? null : attempt?.candidateSha ?? null, number: (session.policyRole ?? session.role) === 'developer' ? attempt?.publicationBinding?.number ?? null : attempt?.pr?.number ?? null, branch, identity: githubIdentityMetadata(value), author: { name: value.login, email: `${bot.id}+${value.login}@users.noreply.github.com` }, publicationMarker: `<!-- flybot-delivery:${session.projectId}:${session.taskId} -->` }
    if ((session.policyRole ?? session.role) === 'reviewer') metadata.publicationStatus = attempt?.pr?.number && attempt.pr.sha === attempt.candidateSha ? 'bound-current-candidate' : 'blocked-on-binding'
    if ((session.policyRole ?? session.role) === 'reviewer') metadata.reviewMarker = `<!-- flybot-review:${session.projectId}:${session.taskId}:${session.attemptId}:${session.id}:${attempt?.candidateSha} -->`
    metadata.sha256 = digest(metadata)
    return { token: value.token, expiresAt: value.expiresAt, metadata }
  }
  async function bind(session, worker) {
    if (!roleGithubSelection(rt, projectOf(session), session.role, session.policyRole ?? session.role)) return null
    if (!session.resourceLease) throw refuse('Role App access requires an explicit execution resource lease')
    const selected = await resolve(session)
    if (!selected) return null
    worker.githubAccess = { ...selected.metadata, status: 'bound', expiresAt: selected.expiresAt, renewing: true }
    await rt.save()
    return selected.metadata
  }
  async function issue(session, worker, expected) {
    await requireExecutionAuthority(rt, session)
    const registered = () => (rt.state.projectHarnessWorkers?.[worker?.id] ?? rt.state.projectNativeWorkers?.[worker?.id]) === worker
    if (!worker || !registered() || worker.status !== 'running' && worker.status !== 'bound' || worker.sessionKey !== session.id || worker.id !== session.botId || worker.role !== session.role || worker.leaseId !== session.resourceLease?.id || worker.resourceId !== session.resourceLease?.resourceId || worker.projectId !== session.projectId || worker.taskId !== session.taskId || worker.attemptId !== session.attemptId || worker.generation !== session.resourceLease?.generation || worker.githubAccess?.sha256 !== expected) throw refuse('Role credential execution binding is inactive or stale')
    const value = await resolve(session)
    await requireExecutionAuthority(rt, session)
    if (!registered() || !value || value.metadata.sha256 !== expected || worker.githubAccess.sha256 !== expected || !['running', 'bound'].includes(worker.status)) throw refuse('Role App connection or current execution changed')
    worker.githubAccess.expiresAt = value.expiresAt; worker.githubAccess.lastIssuedAt = Date.now()
    await rt.save()
    await requireExecutionAuthority(rt, session)
    const current = roleGithubSelection(rt, projectOf(session), session.role, session.policyRole ?? session.role)
    if (!registered() || !['running', 'bound'].includes(worker.status) || worker.githubAccess.sha256 !== expected || current?.metadata.binding !== value.metadata.binding || current.metadata.revision !== value.metadata.revision) throw refuse('Role grant was revoked while its audit was committing')
    return value
  }
  function redact(value) { return redactDeep(value, text => { for (const token of secrets) text = text.split(token).join('[REDACTED]'); return text.replace(/\b(?:ghs_|github_pat_)[A-Za-z0-9_.-]+/g, '[REDACTED]') }) }
  return { resolve, bind, issue, redact, status: project => roleGithubStatus(rt, project) }
}
