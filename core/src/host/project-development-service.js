// One application boundary over existing Project services; no second executor/store.
import { ownEntry } from './store.js'
import { createHash } from 'node:crypto'
import { inspectionFacts } from './project-chief-control.js'
import { EFFECT_PROTOCOL } from './project-effects.js'

export const DEVELOPMENT_PROTOCOL = 'project-development/v1'
const failure = (message, code = 'bot/invalid') => Object.assign(new Error(message), { code })
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const stableId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value)
const sameTask = (row, task) => Boolean(row && row.projectId === task.projectId && row.taskId === task.id)
const roles = new Set(['chief', 'developer', 'tester', 'reviewer'])
const operations = Object.freeze({
  'consultation.reply': 'project-consultation-reply', 'consultation.ask': 'project-consultation-ask', 'consultation.get': 'project-consultation-get', 'consultation.list': 'project-consultation-list',
  'handoff.get': 'project-handoff-get', 'handoff.list': 'project-handoff-list',
  'task.run': 'project-task-run', 'task.detail': 'project-task-detail',
  'task.accept': 'project-task-accept', 'task.reject': 'project-task-reject',
  'attempt.stop': 'project-attempt-stop', 'attempt.cleanup': 'project-attempt-cleanup',
  'attempt.integration-state': 'project-attempt-integration-state', 'attempt.integration-bind': 'project-attempt-integration-bind',
  'attempt.publication-retry': 'project-attempt-publication-retry', 'attempt.log': 'project-attempt-log',
  'queue.cancel': 'project-queue-cancel', 'queue.retry': 'project-queue-retry',
  'chief.inspect': 'project-chief-inspect', 'chief.configure': 'project-chief-configure', 'chief.state': 'project-chief-state',
  'schedule.configure': 'project-scheduled-task', 'agent.mode': 'project-agent-mode',
  'proposal.publish': 'project-agent-proposal-apply', 'execution.input': 'project-execution-input',
  'inputs': 'project-task-inputs', 'input.publish': 'project-task-input',
  'sources': 'project-sources', 'source.subscribe': 'project-source-subscribe', 'source.disable': 'project-source-disable', 'source.poll': 'project-source-poll',
  'execution.boundary': 'project-execution-boundary',
  'pools': 'project-task-pools', 'effect.retry': 'project-effect-retry', 'comment.publish': 'project-github-comment',
})
const queries = new Set(['consultation.get', 'consultation.list', 'handoff.get', 'handoff.list', 'tasks', 'task', 'task.detail', 'inputs', 'sources', 'execution.boundary', 'effects', 'attempt.context', 'attempt.integration-state', 'attempt.log', 'chief.state', 'pools'])
const legacy = new Set(Object.values(operations))
const readEndpoints = new Set([...queries].map(name => operations[name]).filter(Boolean))
export const developmentQuery = body => record(body) && body.version === DEVELOPMENT_PROTOCOL && body.kind === 'query' && queries.has(body.name)

export function taskView(state, task, { activity = {} } = {}) {
  const c = task.collaboration
  const candidate = ownEntry(state.projectAttempts ?? {}, task.deliveryAttemptId)
  const attempt = sameTask(candidate, task) ? candidate : null
  const queue = Object.values(state.projectQueue ?? {}).filter(row => sameTask(row, task) && ['waiting', 'starting', 'blocked'].includes(row.status)).sort((a, b) => (b.enqueuedAt ?? 0) - (a.enqueuedAt ?? 0)).at(0)
  const claim = c?.claim
  const worker = ownEntry(state.projectHarnessWorkers ?? {}, claim?.workerId)
  const sdk = sameTask(worker, task) || worker && attempt && worker.projectId === task.projectId && worker.attemptId === attempt.id ? worker : null
  const native = ownEntry(state.bots ?? {}, claim?.workerId)
  const nativeActive = native?.projectId === task.projectId && (!attempt || native.attemptId === attempt.id) && activity[claim?.workerId]
  const execution = attempt?.runId ? ownEntry(state.projectExecutions ?? {}, attempt.runId) : null
  const run = sameTask(execution, task) ? execution : null
  const currentRole = (state.projectAgentDefinitions?.[task.projectId]?.roles ?? []).find(row => row.id === c?.botId)?.role ?? (c?.botId?.startsWith(`${task.projectId}:`) && roles.has(c.botId.slice(task.projectId.length + 1)) ? c.botId.slice(task.projectId.length + 1) : null)
  let phase = 'published', waitingFor = null, reason = null
  if (task.status === 'accepted') phase = 'accepted'
  else if (task.status === 'cancelled' || c?.status === 'cancelled' || attempt?.status === 'cancelled') phase = 'cancelled'
  else if (attempt?.cancelRequested || c?.status === 'stopping') { phase = 'stopping'; waitingFor = 'worker-exit' }
  else if (task.chiefQuestion) { phase = 'awaiting-owner'; waitingFor = task.chiefQuestion.recipient?.kind === 'personal-agent' ? 'personal-agent' : 'owner'; reason = task.chiefQuestion.reason }
  else if (['arbitration', 'chief-working'].includes(c?.status)) { phase = 'awaiting-chief'; waitingFor = 'chief' }
  else if (c?.status === 'blocked' || queue?.status === 'blocked') { phase = 'blocked'; reason = c?.block?.reason ?? queue?.reason ?? null }
  else if (queue) { phase = queue.status === 'starting' ? 'starting' : 'queued'; waitingFor = queue.reason ? 'resource' : 'capacity'; reason = queue.reason ?? null }
  else if (c?.status === 'queued') { phase = 'queued'; waitingFor = 'role' }
  else if (c?.status === 'claimed') {
    if (sdk?.status === 'waiting-input') { phase = 'awaiting-input'; waitingFor = 'owner' }
    else if (claim?.status === 'active' && (sdk?.status === 'running' || !sdk && nativeActive)) phase = 'running'
    else { phase = 'starting'; waitingFor = 'execution' }
  }
  else if (attempt?.status === 'waiting-acceptance') { phase = 'awaiting-acceptance'; waitingFor = 'owner' }
  else if (['failed', 'interrupted'].includes(attempt?.status) || task.status === 'failed') { phase = 'failed'; reason = attempt?.failure?.message ?? null }
  else if (run?.status === 'paused') { phase = 'paused'; waitingFor = 'owner' }
  else if (['preparing', 'running'].includes(attempt?.status)) { phase = attempt.status === 'preparing' ? 'starting' : 'running' }
  const sha = attempt?.candidateSha ?? null
  const pendingEffects = Object.values(state.projectEffects ?? {}).filter(row => row.version === EFFECT_PROTOCOL && sameTask(row, task) && ['pending', 'running', 'failed'].includes(row.status))
  const publication = pendingEffects.find(row => row.kind === 'github.publish' && row.payload.attemptId === attempt?.id && row.payload.candidateSha === sha)
  if (publication && ['blocked', 'failed'].includes(phase) && ['pending', 'running'].includes(publication.status)) {
    phase = 'publishing'; waitingFor = publication.waitingFor ?? 'external'; reason = publication.error ?? 'Reconciling the existing candidate publication'
  }
  const tests = attempt?.evidence?.tests, review = attempt?.evidence?.review
  const progress = inspectionFacts(state, { ...task, collaboration: c ? { ...c, history: c.history ?? [] } : undefined, ...(attempt ? {} : { deliveryAttemptId: null }) }, { maxHandoffsWithoutProgress: Infinity, longExecutionMs: Infinity, missingHeartbeatMs: Infinity, longWaitMs: Infinity })
  return { version: DEVELOPMENT_PROTOCOL, projectId: task.projectId, taskId: task.id, publication: 'published', phase, waitingFor, reason,
    botId: c?.botId ?? null, currentRole, generation: c?.generation ?? null, attemptId: attempt?.id ?? null,
    executionId: claim?.id ?? run?.id ?? null, workerId: claim?.workerId ?? null, queueId: queue?.id ?? null, candidateSha: sha,
    executionGeneration: sdk?.generation ?? null, inputRequestId: sdk?.pending?.id ?? null,
    lastMeaningfulProgress: progress.lastMeaningfulProgressAt === null ? null : { at: progress.lastMeaningfulProgressAt, evidence: progress.progressEvidence },
    evidence: { tests: tests ? { sha: tests.sha, sha256: tests.sha256, passed: tests.passed === true, current: Boolean(sha && tests.sha === sha) } : null,
      review: review ? { sha: review.sha, verdict: review.verdict, current: Boolean(sha && review.sha === sha) } : null },
    inputs: Object.values(state.projectTaskInputs ?? {}).filter(row => sameTask(row, task) && row.version === 'project-task-input/v1' && row.kind !== 'handoff' && row.status === 'accepted').slice(0, 20).map(row => ({ id: row.id, sha256: row.sha256, createdAt: row.createdAt, deliveries: row.deliveries.length, readConfirmed: row.deliveries.some(d => Boolean(d.readAt)) })),
    effects: pendingEffects.map(({ id, kind, status, failures, dueAt, error, waitingFor }) => ({ id, kind, status, failures, dueAt, error: error ?? null, waitingFor: waitingFor ?? null })), nextActions: [] }
}

export function createDevelopmentService(rt) {
  function access(actor) {
    if (!rt.sharedProjectMode?.() || !actor?.memberId || !ownEntry(rt.state.members ?? {}, actor.memberId)) throw failure('Sign in to the Project service', 'bot/unauthorized')
  }
  function checkedTask(id, projectId, actor) {
    const task = ownEntry(rt.state.tasks, String(id ?? ''))
    if (!task?.projectId || projectId && task.projectId !== projectId) throw failure('Task is unavailable in this Project', 'bot/forbidden')
    rt.requireProjectAccess(actor, task.projectId)
    return task
  }
  function view(task, actor) {
    rt.requireProjectAccess(actor, task.projectId)
    const result = taskView(rt.state, task, { activity: rt.activityView?.() ?? {} })
    const allowed = action => rt.projectCan(actor, task.projectId, action, task)
    if (result.phase === 'published' || result.phase === 'failed') { if (allowed('create') && allowed('task-write')) result.nextActions.push('task.run') }
    if (result.queueId && ['queued', 'blocked'].includes(result.phase) && allowed('task-write')) result.nextActions.push('queue.cancel')
    if (result.queueId && result.phase === 'blocked' && allowed('run-control')) result.nextActions.push('queue.retry')
    if (result.attemptId && ['running', 'starting', 'awaiting-input', 'paused'].includes(result.phase) && allowed('run-control')) result.nextActions.push('attempt.stop')
    const pending = ownEntry(rt.state.projectHarnessWorkers ?? {}, result.workerId)?.pending
    if (result.phase === 'awaiting-input' && allowed('task-write') && (pending?.kind !== 'permission' || allowed('configure'))) result.nextActions.push('execution.input')
    if (result.phase === 'awaiting-acceptance' && allowed('accept')) result.nextActions.push('task.accept', 'task.reject')
    if (result.effects.some(row => row.status === 'failed') && allowed('configure')) result.nextActions.push('effect.retry')
    if (!['accepted', 'cancelled'].includes(result.phase) && allowed('configure')) result.nextActions.push('chief.inspect')
    return result
  }
  function attemptView(attempt) {
    const policy = row => row ? { version: row.version, role: row.role, commit: row.commit, profile: row.profile, sha256: row.sha256 } : null
    const session = row => {
      const { context, policy: rules, ...rest } = row
      return { ...rest, policy: policy(rules), context: context ? { version: context.version, sha256: context.sha256, archiveSha256: context.archiveSha256, ...(context.budget ? { budget: context.budget, usage: context.usage } : {}) } : null }
    }
    const { roleSessions, roleSessionHistory, rolePolicies, ...rest } = attempt
    return structuredClone({ ...rest,
      ...(roleSessions ? { roleSessions: Object.fromEntries(Object.entries(roleSessions).map(([key, row]) => [key, session(row)])) } : {}),
      ...(roleSessionHistory ? { roleSessionHistory: roleSessionHistory.map(session) } : {}),
      ...(rolePolicies ? { rolePolicies: Object.fromEntries(Object.entries(rolePolicies).map(([key, row]) => [key, policy(row)])) } : {}),
      contextRef: { query: 'attempt.context', attemptId: attempt.id, sections: ['roleSessions', 'roleSessionHistory', 'rolePolicies'] } })
  }
  function detail(body, actor) {
    const task = checkedTask(body.taskId, body.projectId, actor), limit = body.attemptLimit ?? 20
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw failure('Attempt page limit must be between 1 and 50')
    const rows = Object.values(rt.state.projectAttempts ?? {}).filter(row => sameTask(row, task)).sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || a.id.localeCompare(b.id))
    const end = body.beforeAttemptId === undefined ? rows.length : rows.findIndex(row => row.id === body.beforeAttemptId)
    if (end < 0) throw failure('Attempt cursor is unavailable')
    const page = rows.slice(Math.max(0, end - limit), end)
    return { task: structuredClone(task), attempts: page.map(attemptView), view: view(task, actor),
      attemptsPage: { total: rows.length, limit, before: end > limit ? page[0].id : null } }
  }
  function context(body) {
    if (!['roleSessions', 'roleSessionHistory', 'rolePolicies'].includes(body.section)) throw failure('Unknown Attempt context section')
    const attempt = ownEntry(rt.state.projectAttempts ?? {}, body.attemptId)
    const text = JSON.stringify(attempt[body.section] ?? null), offset = body.offset ?? 0, limit = body.limit ?? 8000
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length || !Number.isSafeInteger(limit) || limit < 1 || limit > 16000) throw failure('Invalid context page')
    const sha256 = createHash('sha256').update(text).digest('hex')
    if (body.expectedSha256 !== undefined && body.expectedSha256 !== sha256) throw failure('Attempt context changed', 'bot/conflict')
    const next = Math.min(text.length, offset + limit)
    return { attemptId: attempt.id, section: body.section, sha256, offset, text: text.slice(offset, next), totalChars: text.length, nextOffset: next < text.length ? next : null }
  }
  async function inspect(body, actor) {
    rt.requireProjectAccess(actor, body.projectId, 'configure')
    if (!stableId(body.requestId)) throw failure('Chief inspection needs a stable requestId')
    const task = body.taskId === undefined ? null : ownEntry(rt.state.tasks, String(body.taskId))
    if (body.taskId !== undefined && (!task || task.projectId !== body.projectId)) throw failure('Inspection Task is unavailable in this Project', 'bot/forbidden')
    return { run: await rt.projectChiefControl.request(body.projectId, 'inspection', { requestId: body.requestId, requestedBy: actor.memberId, ...(task ? { blockedTaskId: task.id } : {}) }) }
  }
  async function invoke(endpoint, body, actor) {
    if (endpoint === 'project-execution-boundary') return rt.projectExecutionBoundary(body, actor)
    if (endpoint === 'project-sources') return rt.projectSources.query(body, actor)
    if (endpoint === 'project-source-subscribe') return rt.projectSources.subscribe(body, actor)
    if (endpoint === 'project-source-disable') return rt.projectSources.disable(body, actor)
    if (endpoint === 'project-source-poll') return rt.projectSources.poll(body, actor)
    if (endpoint === 'project-task-inputs') return rt.projectInputs.list(body, actor)
    if (endpoint === 'project-task-input') return rt.projectInputs.publish(body, actor)
    if (endpoint === 'project-github-comment') return rt.projectCredentials.endpoint(endpoint, body, actor)
    if (endpoint === 'project-effect-retry') return rt.projectEffects.retry(body, actor)
    if (endpoint === 'project-task-run') return rt.projectScheduler.request(body, actor)
    if (endpoint === 'project-queue-cancel') return rt.projectScheduler.cancel(body, actor)
    if (endpoint === 'project-queue-retry') return rt.projectScheduler.retry(body, actor)
    if (endpoint === 'project-chief-inspect') return inspect(body, actor)
    if (endpoint === 'project-chief-configure') return rt.projectChiefControl.configure(body, actor)
    if (endpoint === 'project-chief-state') return rt.projectChiefControl.view(body.projectId, actor)
    if (endpoint === 'project-scheduled-task') return rt.projectScheduledTasks.endpoint(body, actor)
    if (endpoint === 'project-agent-mode') return rt.projectDelegations.mode(body, actor)
    if (endpoint === 'project-execution-input') return rt.projectHarness.input(body, actor)
    if (endpoint === 'project-agent-proposal-apply') return rt.projectAgents.endpoint(endpoint, body, actor)
    if (endpoint === 'project-task-detail') return detail(body, actor)
    if (['project-consultation-reply', 'project-consultation-ask', 'project-consultation-get', 'project-consultation-list'].includes(endpoint)) return rt.projectAgents.consultation(endpoint, body, actor)
    if (endpoint === 'project-handoff-get') return { handoff: rt.projectPools.get(body.taskId, body.handoffId, actor) }
    if (endpoint === 'project-handoff-list') return rt.projectPools.list(body.taskId, actor, body)
    if (endpoint === 'project-task-pools') {
      rt.requireProjectAccess(actor, body.projectId)
      return { pools: rt.projectAgents.deliveryDefinitions(body.projectId).roles.map(role => ({ botId: role.id, role: role.role, tasks: rt.projectPools.available(body.projectId, role.id, actor) })) }
    }
    return rt.projectDelivery.endpoint(endpoint, body, actor)
  }
  async function envelope(body, actor) {
    if (!record(body) || body.version !== DEVELOPMENT_PROTOCOL || !['command', 'query'].includes(body.kind) || !record(body.payload ?? {})) throw failure('Unsupported Project development request')
    const { name, projectId } = body
    rt.requireProjectAccess(actor, projectId)
    if (!Object.hasOwn(operations, name) && !['tasks', 'task', 'attempt.context', 'effects'].includes(name)) throw failure('Unknown Project development operation')
    if (queries.has(name) !== (body.kind === 'query')) throw failure('Operation kind does not match the contract')
    if (body.kind === 'command' && !stableId(body.requestId)) throw failure('A command needs a stable requestId')
    const args = { ...(body.payload ?? {}), projectId, ...(body.requestId !== undefined ? { requestId: body.requestId } : {}) }
    if (body.payload?.projectId !== undefined && body.payload.projectId !== projectId) throw failure('Payload belongs to another Project', 'bot/forbidden')
    // These targets have their own authority in the existing services, but the
    // envelope must also reject a target in another Project the actor can access.
    for (const [key, table] of [['proposalId', rt.state.projectAgentProposals], ['workerId', rt.state.projectHarnessWorkers]]) {
      if (args[key] === undefined) continue
      const target = ownEntry(table ?? {}, String(args[key]))
      if (!target || target.projectId !== projectId) throw failure('Target is unavailable in this Project', 'bot/forbidden')
    }
    if (name === 'execution.input') args.requestId = body.payload?.requestId
    let task
    for (const [key, table] of [['taskId', rt.state.tasks], ['attemptId', rt.state.projectAttempts], ['queueId', rt.state.projectQueue], ['effectId', rt.state.projectEffects]]) {
      if (args[key] === undefined) continue
      const target = ownEntry(table ?? {}, String(args[key]))
      if (!target || target.projectId !== projectId) throw failure('Target is unavailable in this Project', 'bot/forbidden')
      if (key === 'effectId' && !target.taskId) { if (task) throw failure('Effect has no Task binding', 'bot/forbidden'); continue }
      const selected = key === 'taskId' ? target : checkedTask(target.taskId, projectId, actor)
      if (task && selected.id !== task.id || args.taskId && selected.id !== args.taskId) throw failure('Targets belong to different Tasks', 'bot/forbidden')
      task = selected
    }
    if (body.expectedGeneration !== undefined && (!Number.isSafeInteger(body.expectedGeneration) || body.expectedGeneration < 0 || !task || task.collaboration?.generation !== body.expectedGeneration)) throw failure('Task generation changed', 'bot/conflict')
    if (body.expectedCandidateSha !== undefined && (body.expectedCandidateSha !== null && (typeof body.expectedCandidateSha !== 'string' || !/^[a-f0-9]{40}$/.test(body.expectedCandidateSha)) || !task || taskView(rt.state, task).candidateSha !== body.expectedCandidateSha)) throw failure('Task candidate changed', 'bot/conflict')
    let result
    if (name === 'effects') result = { effects: rt.projectEffects.list(projectId, actor, args) }
    else if (name === 'task') result = { task: view(checkedTask(args.taskId, projectId, actor), actor) }
    else if (name === 'attempt.context') {
      if (!args.attemptId) throw failure('Attempt context needs an Attempt')
      result = context(args)
    }
    else if (name === 'tasks') {
      const limit = args.limit ?? 50
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw failure('Task page limit must be between 1 and 200')
      const rows = Object.values(rt.state.tasks).filter(row => row.projectId === projectId).sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || a.id.localeCompare(b.id))
      const index = args.after === undefined ? -1 : rows.findIndex(row => row.id === args.after)
      if (args.after !== undefined && index < 0) throw failure('Task cursor is unavailable')
      const page = rows.slice(index + 1, index + 1 + limit)
      result = { tasks: page.map(row => view(row, actor)), next: index + 1 + page.length < rows.length ? page.at(-1).id : null }
    } else result = await invoke(operations[name], args, actor)
    return { version: DEVELOPMENT_PROTOCOL, ...(body.requestId !== undefined ? { requestId: body.requestId } : {}), result }
  }
  return { view: (task, actor) => { access(actor); return view(task, actor) },
    isQuery: developmentQuery,
    // Trusted host ports. Public HTTP never accepts role tokens or model results.
    roleResult: row => rt.projectPools.result(row),
    roleCommand(body) {
      if (body?.version !== DEVELOPMENT_PROTOCOL || !stableId(body.requestId) || !['claim', 'handoff', 'return', 'transfer', 'complete', 'arbitrate', 'handoff.accept', 'handoff.offer', 'role.memory.record'].includes(body.name)) throw failure('Unsupported role command')
      if (body.name === 'role.memory.record') return rt.projectPools.remember(body.taskId, body.claim, { ...body.payload, requestId: body.requestId })
      if (body.name === 'handoff.accept') return rt.projectPools.accept(body.taskId, body.botId, body.handoffId, body.requestId)
      if (body.name === 'handoff.offer') return rt.projectPools.decide(body.taskId, body.claim, { ...body.payload, requestId: body.requestId })
      if (body.name === 'claim') return rt.projectPools.claim(body.taskId, body.botId)
      return rt.projectPools.decide(body.taskId, body.claim, { ...body.payload, action: body.name, requestId: body.requestId })
    },
    scheduled: work => rt.projectChiefControl.scheduled(work),
    scheduledSource: (body, actor) => rt.projectSources.poll(body, actor),
    async endpoint(endpoint, body, actor) {
      if (endpoint !== 'project-development' && !legacy.has(endpoint)) return undefined
      access(actor)
      if (rt.readOnly?.() !== undefined && !(endpoint === 'project-development' ? developmentQuery(body) : readEndpoints.has(endpoint))) throw failure('Project service is read-only', 'bot/read-only')
      return endpoint === 'project-development' ? envelope(body, actor) : invoke(endpoint, body, actor)
    } }
}

export function install(rt) { rt.projectDevelopment = createDevelopmentService(rt) }
