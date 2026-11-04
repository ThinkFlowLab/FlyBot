import { nativeExitConfirmed } from './project-native-sessions.js'
import { confirmedWorkerExit } from './project-task-sessions.js'
// Public projections retain references to exact scoped sources; never copy an
// entire growing lifecycle or caller authentication context into every list row.
const pick = (row, keys) => Object.fromEntries(keys.filter(key => row?.[key] !== undefined).map(key => [key, structuredClone(row[key])]))
const short = (value, max = 2000) => typeof value === 'string' ? value.slice(0, max) : value
const reference = (taskId, section, count) => ({ query: 'task.history', taskId, section, ...(count === undefined ? {} : { count }) })
export function taskProvenance(task) {
  const source = task.commandSource?.origin
  const agentId = source?.agentId ?? task.personalAgentSource?.agentId
  return { kind: agentId ? 'personal-agent' : source?.kind ?? 'human', memberId: task.requesterId ?? null, ...(agentId ? { agentId } : {}), ...(source?.botId ? { botId: source.botId } : {}), ...(task.personalAgentSource?.approvedBy ? { approvedBy: task.personalAgentSource.approvedBy } : {}), scope: 'project-published' }
}
export function taskContractView(task) {
  const row = task.projectTask
  if (!row) return null
  return { version: row.version, projectionVersion: 'project-task-contract-summary/v1', admission: { ...pick(row.admission, ['status', 'revision']), latestDecision: row.admission.decisions?.at(-1) ? pick(row.admission.decisions.at(-1), ['id', 'runId', 'at']) : null },
    requirements: { ...pick(row.requirements, ['revision', 'updatedAt']), ...Object.fromEntries(['title', 'criteria', 'impact', 'scope'].filter(key => row.requirements[key] !== undefined).map(key => [key, short(row.requirements[key])])) },
    parentTaskId: row.parentTaskId ?? null,
    wait: row.wait ? { ...pick(row.wait, ['id', 'status', 'botId', 'claimId', 'resumedClaimId', 'at', 'resumedAt']), resumePoint: short(row.wait.resumePoint) } : null,
    dependencies: (row.dependencies ?? []).slice(0, 16).map(dependency => ({ taskId: dependency.taskId, status: dependency.status,
      result: dependency.result ? pick(dependency.result, ['kind', 'taskId', 'sourceTaskId', 'replacementTaskId', 'replacementVersion', 'decisionId', 'attemptId', 'candidateSha', 'requirementsRevision', 'integrated']) : null })),
    block: row.block ? { ...pick(row.block, ['kind', 'attemptId', 'at']), reason: short(row.block.reason) } : null,
    historyRefs: Object.fromEntries(['requirementsHistory', 'waitHistory', 'results', 'admissionDecisions'].map(section => [section, reference(task.id, section, section === 'admissionDecisions' ? row.admission.decisions?.length ?? 0 : row[section]?.length ?? 0)])),
    currentRef: reference(task.id, 'requirements'), preview: true }
}
export function taskDetailView(task) {
  const result = pick(task, ['id', 'projectId', 'requesterId', 'projectTaskKind', 'status', 'priority', 'progress', 'createdAt', 'updatedAt', 'waitingFor', 'approvalId', 'inputApprovalIds'])
  for (const key of ['title', 'criteria', 'note']) if (task[key] !== undefined) result[key] = short(task[key])
  if (task.target) result.target = { ...pick(task.target, ['owner', 'repo', 'number']), href: short(task.target.href) }
  if (task.inputRequest) result.inputRequest = { ...pick(task.inputRequest, ['id', 'status']), question: short(task.inputRequest.question) }
  if (task.result) result.result = { summary: short(task.result.summary), ...pick(task.result, ['at', 'sha', 'attemptId']) }
  result.projectionVersion = 'project-task-detail/v1'
  result.source = taskProvenance(task)
  result.projectTask = taskContractView(task)
  result.historyRefs = Object.fromEntries(['note', 'result', 'actors', 'handoffs'].map(section => [section, reference(task.id, section)]))
  return result
}
export function taskHistorySource(task, section) {
  if (section === 'admissionDecisions') return task.projectTask?.admission.decisions ?? []
  if (['requirements', 'requirementsHistory', 'waitHistory', 'results', 'dependencies'].includes(section)) return task.projectTask?.[section] ?? (section === 'requirements' ? null : [])
  if (section === 'handoffs') return task.collaboration?.history ?? []
  if (['note', 'result', 'actors'].includes(section)) return task[section] ?? null
  throw Object.assign(new Error('Unknown scoped Task history section'), { code: 'bot/invalid' })
}
export function sourcePage(value, body, identity) {
  const text = JSON.stringify(value), offset = body.offset ?? 0, limit = body.limit ?? 8000
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length || !Number.isSafeInteger(limit) || limit < 1 || limit > 16000) throw Object.assign(new Error('Invalid source page'), { code: 'bot/invalid' })
  const sha256 = identity(text)
  if (body.expectedSha256 !== undefined && body.expectedSha256 !== sha256) throw Object.assign(new Error('Source changed; restart from its current reference'), { code: 'bot/conflict' })
  const next = Math.min(text.length, offset + limit)
  return { sha256, offset, text: text.slice(offset, next), totalChars: text.length, nextOffset: next < text.length ? next : null }
}

export function attemptMetadataView(attempt) {
  const result = pick(attempt, ['id', 'protocol', 'projectId', 'taskId', 'workflowId', 'workflowVersion', 'runId', 'status', 'initiatedBy', 'baseSha', 'seedSha', 'candidateSha', 'branch', 'createdAt', 'updatedAt', 'acceptedAt', 'acceptedBy', 'acceptedViaChief', 'cancelRequested', 'supersededBy', 'roleAssignments'])
  if (attempt.requirement) result.requirement = { ...pick(attempt.requirement, ['repository', 'projectTaskRevision']), ...Object.fromEntries(['title', 'criteria', 'impact', 'scope', 'note'].filter(key => attempt.requirement[key] !== undefined).map(key => [key, short(attempt.requirement[key])])) }
  if (attempt.failure) result.failure = { ...pick(attempt.failure, ['at']), message: short(attempt.failure.message) }
  if (attempt.feedback) result.feedback = { ...pick(attempt.feedback, ['previousAttemptId', 'kind', 'candidateSha']), reason: short(attempt.feedback.reason) }
  if (attempt.release) result.release = { ...pick(attempt.release, ['id', 'status', 'observedAt']), ...pick(attempt.release.spec, ['repository', 'tag', 'sha', 'mode']), sourceRef: { query: 'release.status', attemptId: attempt.id } }
  if (attempt.pr) result.pr = pick(attempt.pr, ['number', 'sha', 'url', 'repository'])
  if (attempt.publicationBinding) result.publicationBinding = pick(attempt.publicationBinding, ['number', 'repository', 'branch', 'previousSha', 'upstreamSha', 'upstreamRef'])
  if (attempt.integrationInputs) result.integrationInputs = attempt.integrationInputs.slice(0, 20).map(row => pick(row, ['version', 'repository', 'ref', 'sha', 'purpose']))
  if (attempt.evidence?.tests?.preparation) result.environment = pick(attempt.evidence.tests.preparation, ['id', 'status', 'executor', 'workspaceId', 'resourceId', 'identitySha256', 'sha256'])
  if (attempt.workspaces) result.workspaces = Object.fromEntries(Object.entries(attempt.workspaces).slice(0, 32).map(([role, row]) => [role, pick(row, ['id', 'status', 'role', 'resourceId', 'materialization'])]))
  if (attempt.agentDefinitions) result.agentDefinitions = { revision: attempt.agentDefinitions.revision, roles: (attempt.agentDefinitions.roles ?? []).slice(0, 32).map(row => ({ ...pick(row, ['id', 'role', 'policyRole', 'name', 'model']), skills: (row.skills ?? []).slice(0, 20).map(value => short(value, 300)), execution: pick(row.execution, ['harness', 'model', 'resourceIds']) })) }
  function evidence(row) { return { ...pick(row, ['sha', 'sha256', 'passed', 'status', 'reason', 'executor', 'testsStarted', 'exitConfirmed', 'verdict', 'harness', 'sdkVersion', 'resourceId', 'sessionId', 'model', 'startedAt', 'completedAt']), ...(row.summary ? { summary: short(row.summary) } : {}) } }
  result.evidence = {}
  for (const [key, row] of Object.entries(attempt.evidence ?? {}).slice(0, 32)) {
    if (key === 'execution') result.evidence.execution = Object.fromEntries(Object.entries(row).slice(0, 32).map(([role, value]) => [role, evidence(value)]))
    else result.evidence[key] = evidence(row)
  }
  result.sourceRefs = Object.fromEntries(['evidence', 'feedback', 'requirement', 'failure', 'agentDefinitions', 'integrationAdmissions'].map(section => [section, { query: 'attempt.context', attemptId: attempt.id, section }]))
  result.projectionVersion = 'project-attempt-summary/v1'
  result.preview = true
  return result
}

// A scoped physical execution fact, not an inference from a missing Bot or PID.
export function executionMetadataView(state, row) {
  if (!row) return null
  const native = Object.hasOwn(state.projectNativeWorkers ?? {}, row.id)
  const attempt = state.projectAttempts?.[row.attemptId]
  const session = [attempt?.roleSessions?.[row.role], ...(attempt?.roleSessionHistory ?? [])].find(value => value?.id === row.sessionKey)
  const lease = row.leaseId && state.projectResourceLeases?.[row.leaseId]
  const exit = native ? nativeExitConfirmed(state, row) : confirmedWorkerExit(state, row)
  return { ...pick(row, ['id', 'role', 'resourceId', 'generation', 'sessionKey', 'logicalSessionId', 'createdAt', 'executionStartedAt', 'releasedAt']),
    environmentObservations: row.environmentObservations ?? [], capabilityFailure: row.capabilityFailure ?? null,
    harness: native ? 'flybot' : row.harness ?? null, status: row.status, startupPhase: native ? null : row.spawnPhase ?? null,
    policyRole: session?.policyRole ?? row.policyRole ?? row.role ?? null,
    definitionRevision: session?.definitionRevision ?? null,
    activationEffectId: native ? row.activationEffect?.id ?? null : null,
    exitConfirmed: Boolean(exit && !state.bots?.[row.id] && (!row.leaseId || lease?.status === 'released')),
    exitProof: row.releaseProof ? pick(row.releaseProof, ['kind', 'generation', 'at', 'registeredWorkEmpty']) : null,
    pending: row.pending ? pick(row.pending, ['id', 'kind']) : null,
    ...(row.pendingWork ? { pendingWork: row.pendingWork.slice(0, 32).map(value => ({ kind: typeof value.kind === 'string' ? value.kind.slice(0, 80) : 'unknown', count: Number.isSafeInteger(value.count) ? value.count : 0 })) } : {}) }
}
