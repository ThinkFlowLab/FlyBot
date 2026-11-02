// Project-scoped human authorization. Instance-wide and private Bot APIs keep their own gates.
import { createHash, randomBytes } from 'node:crypto'
import { ownEntry, setEntry } from './store.js'
import { roleOf, rolesOf } from '../shared/project-policy.js'

const hash = value => createHash('sha256').update(value).digest('hex')
const refusal = message => Object.assign(new Error(message), { code: 'bot/forbidden' })
const management = new Set(['configure', 'run-control', 'accept'])
const terminal = new Set(['accepted', 'cancelled', 'failed'])

export function install(rt) {
  const { state, config } = rt
  rt.sharedProjectMode = () => config.projectWorkbench === true || Boolean(config.controlPlane?.origin)
  const projectOf = id => rt.projects.repository.get(String(id ?? ''), { includeDeleted: true })
  rt.projectCan = (actor, projectId, action = 'read', task) => {
    const project = projectOf(projectId)
    const role = actor?.memberId ? roleOf(project, actor.memberId) : null
    if (!project || !role) return false
    if (action === 'read') return true
    if (project.status === 'closed') return false
    if (project.status === 'deleted') return false
    if (action === 'manage' || action === 'roles') return role === 'owner'
    if (action === 'invite' || action === 'configure') return role === 'owner' || role === 'maintainer'
    if (action === 'create') return project.status === 'active'
    if (management.has(action)) return role === 'owner' || role === 'maintainer'
    if (action === 'task-write') return role === 'owner' || role === 'maintainer' || task?.requesterId === actor.memberId
    return false
  }
  rt.requireProjectAccess = (actor, id, action = 'read', task) => {
    if (!rt.projectCan(actor, id, action, task)) throw refusal(`Project access denied: ${action}`)
    return projectOf(id)
  }
  const invites = () => (state.projectInvites ??= {})
  const safeProject = (project, actor) => ({ id: project.id, name: project.name, repository: project.repository ?? null,
    description: project.description ?? '', goal: project.goal ?? '', scope: project.scope ?? '',
    repositories: rt.projectLifecycle.list(project.id).map(row => ({ ...row })),
    ...(project.closure ? { closure: { closedBy: project.closure.closedBy, closedAt: project.closure.closedAt, finalRecord: project.closure.finalRecord, unfinishedTasks: project.closure.unfinishedTasks } } : {}),
    defaultBranch: project.defaultBranch ?? 'main', workDir: project.workDir ?? null,
    status: project.status, createdAt: project.createdAt, updatedAt: project.updatedAt,
    role: roleOf(project, actor?.memberId), quota: project.quota ?? { maxConcurrent: 2 } })
  const activeRuns = id => Object.values(state.projectExecutions ?? {}).filter(run => run.projectId === id && ['running', 'queued', 'paused', 'working'].includes(run.status))
  function safeDetail(id, actor) {
    const detail = rt.projects.detail(id, actor)
    return { ...detail, project: safeProject(detail.project, actor), permissions: {
      create: rt.projectCan(actor, id, 'create'), configure: rt.projectCan(actor, id, 'configure'),
      manage: rt.projectCan(actor, id, 'manage'), accept: rt.projectCan(actor, id, 'accept'),
    } }
  }
  function scopedWorkflows(result, id) {
    const belongs = taskId => ownEntry(state.tasks, taskId)?.projectId === id
    return { ...result, workflows: (result?.workflows ?? []).filter(row => row.projectId === id).map(row => {
      const runs = (row.runs ?? []).filter(run => run.projectId === id)
      const queue = (row.queue ?? []).filter(task => belongs(task.id))
      const heldTasks = (row.heldTasks ?? []).filter(belongs)
      return { ...row, runs, run: row.run?.projectId === id ? row.run : null,
        history: (row.history ?? []).filter(run => run.projectId === id), queue,
        heldTasks, heldTaskCount: heldTasks.length, activeCount: runs.filter(run => run.status === 'running').length,
        queueDepth: queue.length, messages: [], preview: null }
    }) }
  }
  async function workflow(body, actor) {
    const id = String(body.projectId ?? '')
    const operation = body.operation ?? 'state'
    const actions = { state: 'read', templates: 'read', create: 'configure', graph: 'configure', concurrency: 'configure',
      'set-model': 'configure', 'step-timeout': 'configure', assign: 'create', pause: 'run-control', resume: 'run-control', reset: 'run-control', delete: 'configure' }
    if (!Object.hasOwn(actions, operation)) throw refusal('Unsupported Project Workflow operation')
    const project = rt.requireProjectAccess(actor, id, actions[operation])
    const snapshot = await rt.flybotEndpoint('workflow/state', {}, { actor })
    const item = body.workflowId ? snapshot.workflows?.find(row => row.id === body.workflowId) : null
    if (!['state', 'templates', 'create'].includes(operation) && (!item || item.projectId !== id)) throw refusal('Workflow belongs to another Project')
    const delivery = item && Object.values(state.projectAttempts ?? {}).find(attempt => attempt.workflowId === item.id)
    if (delivery && ['graph', 'concurrency', 'set-model', 'step-timeout', 'delete', 'reset'].includes(operation)) throw refusal('Delivery Workflow snapshots are immutable; start a new Attempt')
    if (delivery && operation === 'assign' && (!['preparing', 'running'].includes(delivery.status) || ownEntry(state.tasks, delivery.taskId)?.deliveryAttemptId !== delivery.id)) throw refusal('Delivery needs a new Attempt')
    if (body.runId && ![...(item?.runs ?? []), item?.run].some(run => run?.id === body.runId && run.projectId === id)) throw refusal('Run belongs to another Project')
    if (['create', 'graph'].includes(operation) && Array.isArray(body.nodes) && body.nodes.some(node => node.tools?.length)) throw refusal('Project connector credentials are not configured')
    let payload = { ...body, projectId: id, callerBotId: project.chief?.botId, authoredBy: project.chief?.botId }
    delete payload.operation
    if (operation === 'assign') {
      const task = ownEntry(state.tasks, String(body.taskId ?? ''))
      if (!task || task.projectId !== id) throw refusal('A Project Run needs a Task from this Project')
      rt.requireProjectAccess(actor, id, 'task-write', task)
      payload = { workflowId: item.id, taskId: task.id, title: task.title, brief: task.note ?? task.title, projectId: id, callerBotId: project.chief?.botId }
      const existing = activeRuns(id).find(run => run.taskId === task.id)
      if (existing) {
        if ([...(item.runs ?? []), item.run].some(run => run?.id === existing.id)) return { ...scopedWorkflows(snapshot, id), already: true }
        throw refusal('Task already has an active Run')
      }
      const quota = project.quota?.maxConcurrent ?? 2
      if (activeRuns(id).length >= quota) throw Object.assign(refusal('Project concurrency quota reached'), { code: 'bot/quota' })
    }
    rt.requireProjectAccess(actor, id, actions[operation])
    const result = operation === 'state' ? snapshot : await rt.flybotEndpoint(`workflow/${operation}`, payload, { actor })
    if (result?.ok === false) return result
    // create() uses the same graph service; attach ownership before it becomes usable for Run admission.
    if (operation === 'create') {
      const before = new Set((snapshot.workflows ?? []).map(row => row.id))
      const created = result.workflows?.find(row => !before.has(row.id))
      if (!created) throw refusal('Workflow creation produced no new definition')
      const saved = await rt.flybotEndpoint('workflow/graph', { workflowId: created.id, nodes: created.nodes, edges: created.edges, projectId: id, callerBotId: project.chief?.botId }, { actor })
      if (saved?.ok === false) return saved
      return scopedWorkflows(saved, id)
    }
    return scopedWorkflows(result, id)
  }
  let workflowTail = Promise.resolve()
  const serialWorkflow = (body, actor) => {
    const result = workflowTail.then(() => workflow(body, actor))
    workflowTail = result.then(() => {}, () => {})
    return result
  }
  rt.projectAccessEndpoint = async (endpoint, body = {}, actor) => {
    if (!rt.sharedProjectMode()) return undefined
    if (!actor?.memberId || !ownEntry(state.members, actor.memberId)) throw refusal('Sign in first')
    const development = await rt.projectDevelopment.endpoint(endpoint, body, actor)
    if (development !== undefined) return development
    if (endpoint === 'project-rooms' || endpoint.startsWith('project-room-') || endpoint === 'project-agent-stop') return rt.projectAgents.endpoint(endpoint, body, actor)
    if (endpoint === 'project-github-read') return rt.projectGithubRead(body, actor)
    if (endpoint === 'project-chief-question') return rt.projectAgents.chiefQuestion(body, actor)
    if (endpoint === 'project-credential-status') return rt.projectCredentials.endpoint(endpoint, body, actor)
    if (['project-agents', 'project-agent-message', 'project-agent-history', 'project-agent-memory-write', 'project-role-memory-write', 'project-agent-definition', 'project-knowledge-write'].includes(endpoint)) return rt.projectAgents.endpoint(endpoint, body, actor)
    if (['project-runtime-check', 'project-terminal-open', 'project-terminal-poll', 'project-terminal-input', 'project-terminal-resize', 'project-terminal-close'].includes(endpoint)) return rt.projectRuntimeSetup.endpoint(endpoint, body, actor)
    if (endpoint === 'project-resource-environment-check') {
      rt.requireProjectAccess(actor, body.projectId, 'configure')
      return rt.projectResources.probe(body.projectId, body.resourceId)
    }
    if (endpoint === 'projects') return { projects: rt.listProjects().filter(project => rt.projectCan(actor, project.id)).map(project => safeProject(project, actor)) }
    if (endpoint === 'project-create') return undefined
    if (endpoint === 'project-join') {
      const tokenHash = typeof body.token === 'string' ? hash(body.token) : ''
      const invitation = Object.values(invites()).find(row => row.tokenHash === tokenHash)
      if (!invitation || invitation.usedAt || invitation.revokedAt || invitation.expiresAt <= Date.now()) throw refusal('Project invitation is unavailable')
      const project = rt.readProject(invitation.projectId)
      if (!project || project.status !== 'active' || !rt.projectCan({ memberId: invitation.createdBy }, project.id, 'invite')) throw refusal('Project invitation is unavailable')
      if (roleOf(project, actor.memberId)) throw refusal('Already a Project member')
      project.roles ??= { maintainers: [], members: [] }
      project.roles.members = [...new Set([...(project.roles.members ?? []), actor.memberId])]
      invitation.usedAt = Date.now()
      invitation.memberId = actor.memberId
      await rt.save()
      return { project: safeProject(project, actor) }
    }
    if (endpoint === 'project-workflow') return serialWorkflow(body, actor)
    if (endpoint === 'project-bind') {
      if (body.kind === 'bot' && ownEntry(state.bots, String(body.id ?? ''))?.ownerId !== actor.memberId) throw refusal('Only the Bot owner may change its routing')
      if (body.kind === 'group') {
        const room = ownEntry(state.rooms, String(body.id ?? ''))
        if (!room || !(rt.roomOwnedBy?.(actor, room.id) || rt.canManageParticipants?.(room, actor))) throw refusal('Only the group manager may change its routing')
      }
    }
    const bound = ['project-bind', 'project-of'].includes(endpoint) ? rt.projectOfMember(body.kind, body.id) : null
    const id = String(body.projectId ?? bound?.id ?? body.id ?? '')
    const project = rt.requireProjectAccess(actor, id)
    if (endpoint === 'project-detail') {
      const result = safeDetail(id, actor)
      if (body.view !== 'summary') return result
      return { project: result.project, permissions: result.permissions, tasks: result.tasks.map(({ id, title, priority, status, requesterId, createdAt, collaboration }) => ({ id, title, priority, status, requesterId, createdAt, collaboration: collaboration ? { botId: collaboration.botId, status: collaboration.status } : undefined })) }
    }
    if (endpoint === 'project-of') return { project: safeProject(project, actor) }
    if (endpoint === 'project-read') return { project: safeProject(project, actor), canManage: rt.projectCan(actor, id, 'manage') }
    if (endpoint === 'project-members') {
      const roles = rolesOf(project)
      return { members: [...roles.owner.map(memberId => ({ memberId, role: 'owner' })), ...roles.maintainers.map(memberId => ({ memberId, role: 'maintainer' })), ...roles.members.map(memberId => ({ memberId, role: 'member' }))]
        .map(row => ({ ...row, displayName: ownEntry(state.members, row.memberId)?.displayName ?? row.memberId })) }
    }
    if (endpoint === 'project-invite') {
      rt.requireProjectAccess(actor, id, 'invite')
      if (project.status !== 'active') throw refusal('Project is archived')
      const token = randomBytes(32).toString('base64url')
      const invitation = { id: `project-invite-${randomBytes(8).toString('hex')}`, tokenHash: hash(token), projectId: id,
        createdBy: actor.memberId, expiresAt: Date.now() + 24 * 3600_000 }
      setEntry(invites(), invitation.id, invitation)
      await rt.save()
      return { token, expiresAt: invitation.expiresAt }
    }
    if (endpoint === 'project-member-remove' || endpoint === 'project-leave') {
      const memberId = endpoint === 'project-leave' ? actor.memberId : String(body.memberId ?? '')
      const targetRole = roleOf(project, memberId)
      if (!targetRole || targetRole === 'owner') throw refusal('Project owner cannot leave or be removed')
      if (memberId !== actor.memberId) {
        rt.requireProjectAccess(actor, id, targetRole === 'maintainer' ? 'manage' : 'invite')
      }
      project.roles.maintainers = (project.roles.maintainers ?? []).filter(value => value !== memberId)
      project.roles.members = (project.roles.members ?? []).filter(value => value !== memberId)
      for (const invitation of Object.values(invites())) if (invitation.projectId === id && invitation.createdBy === memberId && !invitation.usedAt) invitation.revokedAt = Date.now()
      rt.projectAgents?.revoke(id, memberId)
      rt.projectInputs?.revokeSource(id, memberId)
      await rt.projectRuntimeSetup?.revoke(null, id, memberId)
      rt.projectScheduler?.revalidate(id)
      // Accepted project work continues under project authority; removal revokes new requests immediately.
      await rt.save()
      return { removed: true, activeRuns: activeRuns(id).length,
        unfinishedTasks: Object.values(state.tasks).filter(task => task.projectId === id && task.requesterId === memberId && !terminal.has(task.status)).length }
    }
    if (endpoint === 'project-quota') {
      rt.requireProjectAccess(actor, id, 'configure')
      if (!Number.isInteger(body.maxConcurrent) || body.maxConcurrent < 1 || body.maxConcurrent > 32) throw refusal('Project concurrency is an integer from 1 to 32')
      project.quota = { maxConcurrent: body.maxConcurrent }
      await rt.save()
      return { quota: project.quota }
    }
    if (['project-memory', 'project-memory-write', 'project-team'].includes(endpoint) && actor.memberId !== project.ownerUserId) throw refusal('Only the primary owner may read legacy private Project content')
    const action = ['project-delete', 'project-archive', 'project-bind', 'project-role'].includes(endpoint) ? 'manage'
      : ['project-memory', 'project-memory-write', 'project-assistant-owner', 'project-team'].includes(endpoint) ? 'manage'
      : endpoint === 'project-workspace-create' ? 'configure' : 'read'
    rt.requireProjectAccess(actor, id, action)
    if (endpoint === 'project-role' && !ownEntry(state.members, String(body.memberId ?? ''))) throw refusal('Unknown human member')
    return undefined
  }
}
