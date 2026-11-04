import { roleGithubStatus } from './project-role-github.js'
import { projectMergePolicyStatus } from './project-merge-policy.js'
// Humans select pre-provisioned connections; models never supply keys or URLs.
import { ownEntry, setEntry } from './store.js'
import { githubCredentialBinding, githubIdentityMetadata } from './project-github-app.js'
import { resolveGithubIdentity } from './project-github.js'
const refused = message => Object.assign(new Error(message), { code: 'bot/forbidden' })
function provisioned(rt, project, id) {
  const value = ownEntry(rt.config.projectGithubConnections ?? {}, id)
  if (!value || value.enabled === false || !value.projectIds?.includes(project.id) || !value.repositories?.includes(project.repository)) throw refused('GitHub connection is not provisioned for this Project repository')
  return value
}
function selectedGithubSettings(rt, project) {
  const selection = ownEntry(project.githubConnections ?? {}, project.repository)
  if (!selection) return ownEntry(rt.config.projectRepositories ?? {}, project.repository)?.github
  if (!selection.connectionId) throw refused('Project GitHub connection is explicitly disabled')
  if (selection.effect && !rt.projectEffects?.intentCommitted(selection.effect)) throw refused('GitHub connection selection is not committed')
  const settings = provisioned(rt, project, selection.connectionId)
  if (githubCredentialBinding(settings, project.repository) !== selection.binding) throw refused('GitHub connection identity changed; human verification is required')
  return { ...settings, connectionId: selection.connectionId, connectionRevision: selection.revision }
}
export function projectGithubSettings(rt, project) {
  const settings = selectedGithubSettings(rt, project)
  if (rt.config.projectRepositories?.[project.repository]?.roleGithub?.enabled && settings?.credential !== 'github-app') throw refused('Role App mode requires explicit App automation; personal fallback is disabled')
  return settings
}
export function githubConfigurationStatus(settings) {
  return { configured: Boolean(settings?.credential === 'github-app' ? settings.appId && settings.installationId && settings.privateKeyFile : settings?.credential === 'gh-cli' && settings.configDir), provider: settings?.credential ?? null, login: settings?.login ?? null, appId: settings?.credential === 'github-app' ? settings.appId ?? null : null, installationId: settings?.credential === 'github-app' ? settings.installationId ?? null : null, verification: 'configuration-only; broker verifies current authorization per operation', recovery: 'Ask an authorized human to verify the selected connection; operator repairs keys/installations' }
}
export function projectGithubStatus(rt, project) {
  try { return { ...githubConfigurationStatus(projectGithubSettings(rt, project)), roleGithub: roleGithubStatus(rt, project), mergePolicy: projectMergePolicyStatus(rt.config.projectRepositories?.[project.repository], project.defaultBranch ?? 'main') } }
  catch { return { ...githubConfigurationStatus(null), verification: 'unavailable; selected connection disabled or changed' } }
}
export function createGithubConnections(rt, { identity = resolveGithubIdentity } = {}) {
  let tail = Promise.resolve()
  rt.projectEffects?.register('github.connection', { run: row => ({ revision: row.payload.revision }) }, { replace: true })
  async function endpoint(operation, body, actor) {
    const configure = operation === 'configure'
    if (configure && (actor.agentId || actor.personalAgentCredentialId || actor.watchGrantId || actor.chiefJobId || actor.consultationProxyAgentId)) throw refused('Only the signed-in human may select project GitHub credentials')
    const project = rt.requireProjectAccess(actor, body.projectId, configure ? 'configure' : 'read')
    const repository = body.repository ?? project.repository
    if (repository !== project.repository && !Object.values(rt.state.projectRepositories ?? {}).some(row => row.projectId === project.id && row.repository === repository)) throw refused('Repository is not associated with this Project')
    const scoped = { ...project, repository, defaultBranch: Object.values(rt.state.projectRepositories ?? {}).find(row => row.projectId === project.id && row.repository === repository)?.defaultBranch ?? project.defaultBranch }, previous = ownEntry(project.githubConnections ?? {}, repository)
    const view = () => {
      let status
      try { status = githubConfigurationStatus(projectGithubSettings(rt, scoped)) } catch { status = { ...githubConfigurationStatus(null), recovery: 'Selection disabled or changed; human must reselect a provisioned connection' } }
      return { roleGithub: roleGithubStatus(rt, scoped), mergePolicy: projectMergePolicyStatus(rt.config.projectRepositories?.[repository], scoped.defaultBranch ?? 'main'), repository, connectionId: previous?.connectionId ?? null, revision: previous?.revision ?? 0, verifiedAt: previous?.verifiedAt ?? null, identity: previous?.identity ?? null, ...status, options: Object.entries(rt.config.projectGithubConnections ?? {}).filter(([, row]) => row.enabled !== false && row.projectIds?.includes(project.id) && row.repositories?.includes(repository)).slice(0, 100).map(([id, row]) => ({ id, provider: row.credential, appId: row.appId ?? null, installationId: row.installationId ?? null, login: row.login ?? null })) }
    }
    if (!configure) return { connection: view() }
    if (body.expectedRevision !== (previous?.revision ?? 0) || body.connectionId !== null && (typeof body.connectionId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(body.connectionId))) throw Object.assign(Error('GitHub connection selection revision or ID is invalid'), { code: 'bot/conflict' })
    if (rt.validateHumanActor && !await rt.validateHumanActor(actor)) throw refused('Human session is unavailable')
    const settings = body.connectionId === null ? null : provisioned(rt, scoped, body.connectionId)
    const binding = settings ? githubCredentialBinding(settings, repository) : null
    const selected = settings ? await identity(settings, { repository, permissions: { contents: 'read' } }) : null
    const currentProject = rt.requireProjectAccess(actor, body.projectId, 'configure')
    if (repository !== currentProject.repository && !Object.values(rt.state.projectRepositories ?? {}).some(row => row.projectId === currentProject.id && row.repository === repository)) throw refused('Project repository association changed during verification')
    if (rt.validateHumanActor && !await rt.validateHumanActor(actor)) throw refused('Human session was revoked')
    if (settings && githubCredentialBinding(provisioned(rt, scoped, body.connectionId), repository) !== binding || ownEntry(project.githubConnections ?? {}, repository) !== previous) throw refused('GitHub connection changed during verification')
    const next = { connectionId: body.connectionId, revision: (previous?.revision ?? 0) + 1, binding, verifiedAt: Date.now(), selectedBy: actor.memberId, identity: selected ? githubIdentityMetadata(selected) : null }
    if (rt.projectEffects) next.effect = rt.projectEffects.stage({ kind: 'github.connection', key: `${repository}:${body.requestId}`, projectId: project.id, payload: { repository, revision: next.revision, initiatedBy: actor.memberId, identity: next.identity } })
    project.githubConnections ??= {}; setEntry(project.githubConnections, repository, next)
    try { await rt.save() } catch (error) { if (previous) setEntry(project.githubConnections, repository, previous); else delete project.githubConnections[repository]; throw error }
    return { connection: { ...view(), connectionId: next.connectionId, revision: next.revision, verifiedAt: next.verifiedAt, ...(settings ? githubConfigurationStatus(settings) : githubConfigurationStatus(null)), identity: next.identity } }
  }
  return { endpoint(operation, body, actor) { if (operation !== 'configure') return endpoint(operation, body, actor); const result = tail.then(() => endpoint(operation, body, actor)); tail = result.catch(() => {}); return result } }
}
