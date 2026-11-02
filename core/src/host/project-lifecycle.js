// Project relationships and explicit, non-destructive Owner closure.
import { createHash, randomBytes } from 'node:crypto'
import { ownEntry, setEntry } from './store.js'
import { roleOf } from '../shared/project-policy.js'

const endpoints = new Set(['project-repositories', 'project-repository-link', 'project-repository-unlink', 'project-close-request', 'project-close-prepare', 'project-close-confirm'])
const hash = value => createHash('sha256').update(value).digest('hex')
const fail = (message, code = 'bot/invalid') => Object.assign(new Error(message), { code })
const text = (value, name, max) => {
  if (typeof value !== 'string' || !value.trim() || [...value].length > max) throw fail(`${name} must contain 1–${max} characters`)
  return value.trim()
}
export function repositorySpec(value) {
  const repository = text(value?.repository, 'Repository', 200)
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || repository.split('/').some(part => part === '.' || part === '..')) throw fail('Repository must be owner/name')
  const defaultBranch = value.defaultBranch ?? 'main'
  if (typeof defaultBranch !== 'string' || !defaultBranch || defaultBranch.length > 120 || Array.from(defaultBranch).some(char => char.codePointAt(0) <= 32 || char.codePointAt(0) === 127 || '~^:?*[\\'.includes(char)) || defaultBranch.startsWith('-') || defaultBranch.startsWith('/') || defaultBranch.endsWith('/') || defaultBranch.endsWith('.') || defaultBranch.includes('..') || defaultBranch.includes('//') || defaultBranch.includes('@{') || defaultBranch.split('/').some(part => part.startsWith('.') || part.endsWith('.lock'))) throw fail('Invalid repository branch')
  return { repository, defaultBranch }
}

export function install(rt) {
  const { state } = rt
  const list = projectId => Object.values(state.projectRepositories ?? {}).filter(row => row.projectId === projectId)
  const put = (project, spec) => {
    state.projectRepositories ??= {}
    const id = `repository-${hash(`${project.id}\0${spec.repository}`)}`
    const existing = ownEntry(state.projectRepositories, id)
    if (existing) {
      if (existing.defaultBranch !== spec.defaultBranch) throw fail('Repository association already has another branch', 'bot/conflict')
      return existing
    }
    const row = { id, projectId: project.id, ...spec, createdAt: Date.now() }
    setEntry(state.projectRepositories, id, row)
    return row
  }
  function migrate() {
    let changed = false
    if (!state.projectRepositories) { state.projectRepositories = {}; changed = true }
    for (const project of Object.values(state.projects)) {
      if (project.repositoriesVersion === 1) continue
      if (project.repository) put(project, repositorySpec(project))
      project.repositoriesVersion = 1
      changed = true
    }
    return changed
  }
  function register(project, specs) {
    const values = specs === undefined ? (project.repository ? [repositorySpec(project)] : []) : specs.map(repositorySpec)
    for (const spec of values) put(project, spec)
    project.repositoriesVersion = 1
  }
  const basis = project => hash(JSON.stringify({ id: project.id, status: project.status, name: project.name, goal: project.goal, scope: project.scope,
    ownerUserId: project.ownerUserId, ownerUserIds: project.ownerUserIds, roles: project.roles, repository: project.repository,
    description: project.description, defaultBranch: project.defaultBranch, repositories: list(project.id) }))
  const publicProject = project => {
    const view = { ...project }
    delete view.closeConfirmation
    if (view.closure) { view.closure = { ...view.closure }; delete view.closure.confirmationHash }
    return view
  }
  let tail = Promise.resolve()
  async function handle(endpoint, body, actor) {
    const id = String(body.projectId ?? body.id ?? '')
    const project = ownEntry(state.projects, id)
    if (!project) throw fail('Unknown Project', 'bot/not-found')
    // Never use a body memberId, Bot label or implicit first-member fallback.
    if (!actor?.memberId || !ownEntry(state.members, actor.memberId) || ownEntry(state.members, actor.memberId).status === 'disabled' || !roleOf(project, actor.memberId)) throw fail('Project access denied', 'bot/forbidden')
    rt.requireProjectAccess(actor, id)
    if (endpoint !== 'project-repositories' && rt.readOnly?.() !== undefined) throw fail('Project state is read-only', 'bot/read-only')
    if (endpoint !== 'project-repositories' && !await rt.validateHumanActor(actor)) throw fail('Current principal is unavailable', 'bot/forbidden')
    rt.requireProjectAccess(actor, id)
    if (endpoint !== 'project-repositories' && rt.readOnly?.() !== undefined) throw fail('Project state is read-only', 'bot/read-only')
    if (ownEntry(state.projects, id) !== project) throw fail('Project changed during principal validation', 'bot/conflict')
    if (ownEntry(state.members, actor.memberId)?.status === 'disabled') throw fail('Current principal is unavailable', 'bot/forbidden')
    const role = roleOf(project, actor.memberId)
    if (endpoint === 'project-repositories') return { repositories: list(id).map(row => ({ ...row })) }
    if (endpoint === 'project-close-confirm' && project.status === 'closed') {
      if (role !== 'owner' || actor.agentId || actor.chiefJobId || actor.watchGrantId || actor.memberId !== project.closure.closedBy || typeof body.confirmationToken !== 'string' || hash(body.confirmationToken) !== project.closure.confirmationHash) throw fail('Owner confirmation required', 'bot/forbidden')
      return { project: publicProject(project), already: true }
    }
    if (project.status !== 'active') throw fail('Project is not active', 'bot/conflict')
    if (endpoint.startsWith('project-repository-')) {
      if (!['owner', 'maintainer'].includes(role)) throw fail('Project access denied: configure', 'bot/forbidden')
      const spec = repositorySpec(body)
      const prior = structuredClone(state.projectRepositories)
      const previous = { updatedAt: project.updatedAt, repository: project.repository, defaultBranch: project.defaultBranch }
      if (endpoint === 'project-repository-link') put(project, spec)
      else {
        // Keep existing work on its legacy target until task-scoped selection is available.
        if (project.repository === spec.repository && Object.values(state.tasks).some(task => task.projectId === id && !['accepted', 'cancelled'].includes(task.status))) throw fail('Repository is selected by unfinished work', 'bot/conflict')
        const row = list(id).find(item => item.repository === spec.repository)
        if (row) delete state.projectRepositories[row.id]
        if (project.repository === spec.repository) {
          const next = list(id)[0]
          project.repository = next?.repository ?? null
          project.defaultBranch = next?.defaultBranch ?? 'main'
        }
      }
      project.updatedAt = Date.now()
      try { await rt.save() }
      catch (error) { state.projectRepositories = prior; Object.assign(project, previous); throw error }
      return { repositories: list(id).map(row => ({ ...row })) }
    }
    if (endpoint === 'project-close-request') {
      if (!['owner', 'maintainer'].includes(role)) throw fail('Project access denied: suggest closure', 'bot/forbidden')
      const request = { id: `close-request-${randomBytes(16).toString('hex')}`, projectId: id, requestedBy: actor.memberId, reason: text(body.reason, 'Closure reason', 4000), createdAt: Date.now() }
      project.closeRequests ??= []
      project.closeRequests.push(request)
      try { await rt.save() }
      catch (error) { project.closeRequests.pop(); throw error }
      return { request }
    }
    if (role !== 'owner' || actor.agentId || actor.chiefJobId || actor.watchGrantId) throw fail('Only the Project owner personally may confirm closure', 'bot/forbidden')
    if (endpoint === 'project-close-prepare') {
      const finalRecord = text(body.finalRecord, 'Final record', 12000)
      const confirmationToken = randomBytes(32).toString('base64url')
      const previous = project.closeConfirmation
      const confirmation = { tokenHash: hash(confirmationToken), ownerId: actor.memberId, finalRecord, basis: basis(project), expiresAt: Date.now() + 15 * 60_000 }
      project.closeConfirmation = confirmation
      try { await rt.save() }
      catch (error) { if (previous) project.closeConfirmation = previous; else delete project.closeConfirmation; throw error }
      return { projectId: id, confirmationToken, expiresAt: confirmation.expiresAt, finalRecord }
    }
    const confirmation = project.closeConfirmation
    if (!confirmation || typeof body.confirmationToken !== 'string' || confirmation.ownerId !== actor.memberId || confirmation.tokenHash !== hash(body.confirmationToken) || confirmation.expiresAt <= Date.now() || confirmation.basis !== basis(project)) throw fail('Closure confirmation is expired or conflicts with current Project state', 'bot/conflict')
    const unfinishedTasks = Object.values(state.tasks).filter(task => task.projectId === id && !['accepted', 'cancelled'].includes(task.status)).map(task => ({ id: task.id, title: task.title, status: task.status }))
    const previous = { status: project.status, updatedAt: project.updatedAt, closure: project.closure }
    project.status = 'closed'
    project.updatedAt = Date.now()
    project.closure = { closedBy: actor.memberId, closedAt: project.updatedAt, finalRecord: confirmation.finalRecord, unfinishedTasks, confirmationHash: confirmation.tokenHash }
    delete project.closeConfirmation
    try { await rt.save() }
    catch (error) { Object.assign(project, previous); project.closeConfirmation = confirmation; if (!previous.closure) delete project.closure; throw error }
    // Closing is not deletion and does not claim that still-running processes have exited.
    rt.projectScheduler?.revalidate(id)
    return { project: publicProject(project) }
  }
  rt.projectLifecycle = { migrate, register, list,
    endpoint(endpoint, body, actor) {
      if (!endpoints.has(endpoint)) return undefined
      const run = tail.then(() => handle(endpoint, body, actor))
      tail = run.catch(() => {}) // Keep later independent commands usable after a refusal.
      return run
    },
  }
}
