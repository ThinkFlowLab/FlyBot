// Durable ownership: routing through a Bot or room never moves existing work.
import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { ownEntry, setEntry } from './store.js'

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const terminal = new Set(['accepted', 'cancelled', 'failed'])
const activeRun = new Set(['queued', 'running', 'pending', 'working', 'paused', 'legacy'])
const refuse = message => Object.assign(new Error(message), { code: 'bot/invalid' })

// Tables are read at call time: store refresh may replace them.
export function projectRepository(state) {
  return {
    get(id, { includeDeleted = false } = {}) {
      return ownEntry(state.projects, id) ?? (includeDeleted ? ownEntry(state.projectArchive ?? {}, id) : null) ?? null
    },
    list() { return Object.values(state.projects).filter(record) },
    archive(project) { setEntry(state.projectArchive, project.id, { ...project, status: 'deleted', deletedAt: Date.now() }) },
  }
}

export function createProjectDomain(rt) {
  const { state } = rt
  const repository = projectRepository(state)
  function normalize() {
    let changed = false
    for (const key of ['projectArchive', 'projectExecutions', 'projectWorkspaces']) {
      if (!record(state[key])) { state[key] = {}; changed = true }
    }
    return changed
  }
  normalize()
  const requireActive = id => {
    const project = repository.get(id)
    if (!project) throw refuse(`Unknown Project ${id}`)
    if (project.status !== 'active') throw refuse(`Project ${id} is archived`)
    return project
  }
  const taskCandidates = (task, seen = new Set()) => {
    if (seen.has(task)) return []
    seen.add(task)
    const roomId = task.origin?.roomId ?? (task.kind === 'group' ? task.roomId : undefined)
    const room = roomId ? ownEntry(state.rooms, roomId) : undefined
    const bot = ownEntry(state.bots, task.ownerBotId)
    const parent = ownEntry(state.tasks, task.reworkOf ?? task.parentId)
    return [...new Set([room?.projectId ?? bot?.projectId, ...(parent ? Object.hasOwn(parent, 'projectId') ? [parent.projectId] : taskCandidates(parent, seen) : []),
      task.runId ? ownEntry(state.projectRuns, task.runId) : undefined].filter(id => typeof id === 'string' && id !== ''))].sort()
  }
  function migrateLegacy() {
    let changed = normalize()
    if (rt.projectLifecycle?.migrate()) changed = true
    if (rt.personalAgents?.migrate()) changed = true
    for (const [id, projectId] of Object.entries(state.projectRuns)) {
      if (!ownEntry(state.projectExecutions, id)) {
        setEntry(state.projectExecutions, id, { id, projectId, status: 'legacy', source: 'legacy-binding' })
        changed = true
      }
    }
    for (const task of Object.values(state.tasks)) {
      if (!record(task) || Object.hasOwn(task, 'projectId')) continue
      const candidates = taskCandidates(task)
      const valid = candidates.length === 1 && repository.get(candidates[0], { includeDeleted: true })
      task.projectId = valid ? candidates[0] : null
      task.projectResolution = { reason: valid ? 'legacy-binding' : candidates.length > 1 ? 'ambiguous' : candidates.length ? 'missing-project' : 'unassigned', candidates }
      changed = true
    }
    return changed
  }
  // An explicit provider registration imports legacy run/task links, never a board read.
  function importRunRefs(refs) {
    let changed = false
    for (const ref of refs) {
      const task = ownEntry(state.tasks, ref.taskId)
      const projectId = ownEntry(state.projectRuns, ref.runId)
      if (!task?.projectResolution || !projectId) continue
      const resolution = task.projectResolution
      const candidates = [...new Set([...resolution.candidates, projectId])].sort()
      const runIds = [...new Set([...(resolution.runIds ?? []), ref.runId])].sort()
      if (JSON.stringify(candidates) === JSON.stringify(resolution.candidates) && JSON.stringify(runIds) === JSON.stringify(resolution.runIds)) continue
      const valid = candidates.length === 1 && repository.get(candidates[0], { includeDeleted: true })
      task.projectId = valid ? candidates[0] : null
      task.projectResolution = { reason: valid ? 'legacy-binding' : candidates.length > 1 ? 'ambiguous' : 'missing-project', candidates, runIds }
      const run = ownEntry(state.projectExecutions, ref.runId)
      if (run && !run.taskId) run.taskId = task.id
      changed = true
    }
    return changed
  }
  function validateTask(task, body = {}) {
    if (Object.hasOwn(body, 'projectId') && body.projectId !== task.projectId) throw refuse('Task projectId is immutable')
  }
  function stampTask(task, body = {}) {
    if (Object.hasOwn(task, 'projectId')) { validateTask(task, body); return task }
    const parent = ownEntry(state.tasks, task.reworkOf ?? task.parentId)
    const inherited = parent && Object.hasOwn(parent, 'projectId')
    const candidates = inherited ? (parent.projectId ? [parent.projectId] : []) : taskCandidates(task)
    const explicit = Object.hasOwn(body, 'projectId')
    if (!explicit && candidates.length > 1) throw refuse('Task has ambiguous Project context')
    const id = explicit ? body.projectId : candidates.length === 1 ? candidates[0] : null
    if (explicit && id !== null && candidates.some(candidate => candidate !== id)) throw refuse('Task Project conflicts with its execution context')
    if (id !== null) {
      const project = requireActive(id)
      if (explicit && project.ownerUserId && task.requesterId !== project.ownerUserId && !rt.projectRoleOf?.(project, task.requesterId)) throw refuse('Task requester is not a member of this Project')
    }
    task.projectId = id
    if (candidates.length > 1 && !explicit) task.projectResolution = { reason: 'ambiguous', candidates }
    return task
  }
  function executionContext(taskId, projectId) {
    const task = ownEntry(state.tasks, taskId)
    if (task && Object.hasOwn(task, 'projectId')) {
      if (projectId && projectId !== task.projectId) throw refuse('Run and Task must belong to the same Project')
      projectId = task.projectId
    }
    if (projectId) requireActive(projectId)
    return { projectId: projectId ?? null, ...(task ? { taskId: task.id } : {}) }
  }
  function memberRemovalProblem(memberId) {
    if (repository.list().some(project => project.ownerUserId === memberId || project.ownerUserIds?.includes(memberId))) return 'owns_projects'
    if (Object.values(state.tasks).some(task => task.requesterId === memberId && !terminal.has(task.status))) return 'unfinished_tasks'
    return null
  }
  function removeMembership(memberId) {
    for (const project of repository.list()) {
      if (!project.roles) continue
      project.roles.maintainers = (project.roles.maintainers ?? []).filter(id => id !== memberId)
      project.roles.members = (project.roles.members ?? []).filter(id => id !== memberId)
    }
  }
  function bindRun(id, projectId, details = {}) {
    const existing = ownEntry(state.projectExecutions, id)
    if (existing && existing.projectId !== projectId) throw refuse('Run projectId is immutable')
    const task = details.taskId ? ownEntry(state.tasks, details.taskId) : undefined
    if (details.taskId && !task) throw refuse('Unknown run Task')
    if (task && task.projectId !== projectId) throw refuse('Run and Task must belong to the same Project')
    const workspace = details.workspaceId ? ownEntry(state.projectWorkspaces, details.workspaceId) : undefined
    if (details.workspaceId && (!workspace || workspace.projectId !== projectId)) throw refuse('Run and Workspace must belong to the same Project')
    if (!existing) requireActive(projectId)
    if (existing?.attemptId && details.attemptId && existing.attemptId !== details.attemptId) throw refuse('Run Attempt is immutable')
    if (existing?.workflowId && details.workflowId && existing.workflowId !== details.workflowId) throw refuse('Run Workflow is immutable')
    if (existing?.taskId && details.taskId && existing.taskId !== details.taskId) throw refuse('Run Task is immutable')
    if (existing?.workspaceId && details.workspaceId && existing.workspaceId !== details.workspaceId) throw refuse('Run Workspace is immutable')
    const run = { ...existing, id, projectId,
      ...(details.taskId ? { taskId: details.taskId } : {}),
      ...(details.workspaceId ? { workspaceId: details.workspaceId } : {}),
      ...(details.workflowId ? { workflowId: details.workflowId } : {}),
      ...(details.attemptId ? { attemptId: details.attemptId } : {}),
      status: details.status ?? existing?.status ?? 'recorded', updatedAt: Date.now() }
    setEntry(state.projectExecutions, id, run)
    rt.projectDelivery?.runReported(run)
    rt.projectScheduler?.wake()
    return run
  }
  function createWorkspace(body) {
    requireActive(body.projectId)
    if (typeof body.path !== 'string' || !isAbsolute(body.path) || /[\u0000-\u001f]/.test(body.path)) throw refuse('Workspace path must be absolute')
    const workspace = { id: `workspace-${randomUUID()}`, projectId: body.projectId, path: body.path,
      kind: 'reference', status: 'registered', createdAt: Date.now() }
    setEntry(state.projectWorkspaces, workspace.id, workspace)
    return workspace
  }
  function assertDeletable(id) {
    if (Object.values(state.projectQueue ?? {}).some(entry => entry.projectId === id && ['waiting', 'starting'].includes(entry.status))) throw refuse('Project has queued delivery work')
    if (Object.values(state.projectAttempts ?? {}).some(attempt => attempt.projectId === id && ['preparing', 'running', 'waiting-acceptance'].includes(attempt.status))) throw refuse('Project has unfinished delivery Attempts')
    if (Object.values(state.tasks).some(task => task?.projectId === id && !terminal.has(task.status))) throw refuse('Project has unfinished Tasks')
    if (Object.values(state.projectExecutions).some(run => run.projectId === id && activeRun.has(run.status))) throw refuse('Project has active Runs')
  }
  function detail(id, actor) {
    const project = repository.get(id, { includeDeleted: true })
    if (!project) throw refuse('Unknown Project')
    return { project,
      tasks: Object.values(state.tasks).filter(task => task?.projectId === id && rt.taskVisible?.(task, actor)),
      runs: Object.values(state.projectExecutions).filter(run => run.projectId === id),
      workspaces: Object.values(state.projectWorkspaces).filter(workspace => workspace.projectId === id),
      migration: Object.values(state.tasks).filter(task => task?.projectResolution?.candidates?.includes(id) && task.projectId === null && rt.taskVisible?.(task, actor))
        .map(task => ({ taskId: task.id, ...task.projectResolution })),
    }
  }
  return { repository, importRunRefs, executionContext, memberRemovalProblem, removeMembership, migrateLegacy, stampTask, validateTask, bindRun, createWorkspace, assertDeletable, detail, requireActive }
}
