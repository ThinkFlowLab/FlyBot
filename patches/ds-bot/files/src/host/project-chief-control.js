import { autonomyPolicy, operationsContact, assistanceRequest, assistanceScope, assistanceFacts, compensationSchedules } from './project-chief-assistance.js'
import { classifyChiefRecovery, progressCheckpoint } from './project-chief-recovery.js'
// Chief arbitration uses existing Tasks, Runs, Sessions and resource leases.
import { randomUUID, createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { captureProcessScope, priorScopeExited } from './project-process-proof.js'
import { fileDigest } from './project-resource-workspaces.js'
import { ownEntry, setEntry } from './store.js'
import { dependencyFact } from './project-task-lifecycle.js'
import { inspectionLifecycle, inspectionHealth, scheduledInspectionState } from './project-chief-lifecycle.js'
import { protocolCorrection } from './project-receipt-correction.js'
import { CHIEF_AUTONOMY, parseChiefResponse, correctionBudget, chiefProtocolError } from './project-chief-protocol.js'
import { confirmedWorkerExit } from './project-task-sessions.js'
import { stageRoleSummary } from './project-context-memory.js'
const template = JSON.parse(readFileSync(new URL('./project-chief-schedule.json', import.meta.url), 'utf8'))
const refuse = message => Object.assign(new Error(message), { code: 'bot/chief' })
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const terminal = new Set(['accepted', 'cancelled'])
export function inspectionResources(state, task) {
  const rows = Object.values(state.projectResourceLeases ?? {}).filter(lease => state.projectAttempts?.[lease.attemptId]?.taskId === task.id).map(lease => ({ role: lease.role, status: lease.status, attemptId: lease.attemptId, workerId: lease.worker?.handle ?? null, releasedAt: lease.releasedAt ?? null, releaseProof: lease.releaseProof?.kind ?? (lease.status === 'released' && state.projectHarnessWorkers?.[lease.worker?.handle]?.status === 'released' && state.projectHarnessWorkers[lease.worker.handle].leaseId === lease.id && state.projectHarnessWorkers[lease.worker.handle].generation === lease.generation ? 'persisted-sdk-confirmed-release' : null) }))
  const proven = new Set(['sdk-stop-ack-and-process-exit', 'systemd-prior-invocation-exited', 'unbound-reservation-release', 'persisted-sdk-confirmed-release'])
  const historical = rows.filter(row => row.attemptId !== task.deliveryAttemptId && row.status === 'released' && proven.has(row.releaseProof))
  return { resources: rows.filter(row => !historical.includes(row)), ...(historical.length ? { releasedResourceHistory: { count: historical.length, allConfirmedReleased: true, sha256: digest(historical), source: 'projectResourceLeases and projectHarnessWorkers; original records retained' } } : {}) }
}
export function progressFingerprint(attempt) {
  const tests = attempt?.evidence?.tests
  return digest(tests?.passed === true && tests.sha === attempt.candidateSha ? { testedCandidate: tests.sha } : null)
}
export function inspectionFacts(state, task, thresholds, now = Date.now()) {
  const c = task.collaboration, attempt = state.projectAttempts?.[task.deliveryAttemptId], fingerprint = progressFingerprint(attempt)
  const { checkpoint, lastMeaningfulProgressAt, progressEvidence } = progressCheckpoint(c?.history)
  const handoffs = (c?.history.length ?? 0) - checkpoint
  const worker = c?.claim?.workerId ? state.projectHarnessWorkers?.[c.claim.workerId] : null
  const reasons = []
  const recipient = task.chiefQuestion?.recipient
  const participation = recipient?.participationId && ownEntry(state.personalAgentParticipations ?? {}, recipient.participationId)
  const question = participation && ownEntry(state.projectAgentTranscripts ?? {}, participation.carrierId)?.find(row => row.id === recipient.consultationId)
  const notification = question?.notificationEffect && ownEntry(state.projectEffects ?? {}, question.notificationEffect.id)
  if (notification?.status === 'failed') reasons.push('Personal-agent notification exhausted its configured delivery budget')
  if (question?.inbox?.phase === 'processing' && question.inbox.claim?.expiresAt <= now) reasons.push('Personal-agent processing lease expired; reconcile its execution before reassignment')
  if (question && (question.inbox?.phase === 'failed' || now - (question.inbox?.updatedAt ?? question.at) > thresholds.longWaitMs)) reasons.push('Personal-agent inbox needs attention; inspect the original request or escalate to its human')
  if (handoffs >= thresholds.maxHandoffsWithoutProgress) reasons.push('Repeated handoffs without verified artifact/test/review progress')
  if (c?.claim?.status === 'active' && now - c.claim.createdAt > thresholds.longExecutionMs) reasons.push('Execution exceeds the configured duration threshold')
  if (worker?.status === 'running' && now - (worker.lastEventAt ?? worker.createdAt) > thresholds.missingHeartbeatMs) reasons.push('Execution heartbeat is missing')
  if (['queued', 'arbitration', 'blocked'].includes(c?.status) && now - (c.history.at(-1)?.createdAt ?? task.updatedAt) > thresholds.longWaitMs) reasons.push('Task wait exceeds the configured duration threshold')
  return { assistance: assistanceFacts(state, task), taskId: task.id, fingerprint, handoffsWithoutProgress: handoffs, reasons, observedAt: now, checkpoint, lastMeaningfulProgressAt, progressEvidence }
}
export function allocationProof(state, task) {
  const id = task.deliveryAttemptId, attempt = state.projectAttempts?.[id]
  const leases = Object.values(state.projectResourceLeases ?? {}).filter(row => row.attemptId === id)
  const workers = [...Object.values(state.projectHarnessWorkers ?? {}), ...Object.values(state.bots ?? {}).filter(row => row.ephemeral)].filter(row => row.attemptId === id)
  const counts = { leases: leases.length, workers: workers.length, sessions: Object.keys(attempt?.roleSessions ?? {}).length + (attempt?.roleSessionHistory?.length ?? 0), workspaces: Object.keys(attempt?.workspaces ?? {}).length }
  // All delivery adapters persist registration before an external worker may start.
  const absent = Boolean(attempt) && !task.collaboration?.claim?.workerId && Object.values(counts).every(count => count === 0)
  return { version: 'registered-before-external-start/v1', attemptId: id ?? null, status: absent ? 'not-allocated' : 'recorded-or-unknown', counts }
}
export function createProjectChiefControl(rt) {
  const policies = () => (rt.state.projectChiefPolicies ??= {})
  const active = new Map(), waiters = new Map()
  const stopping = new Map()
  let pumping = false, reconciling = null
  rt.projectEffects?.register('chief.inspection-recovery', { run: row => ({ runId: row.payload.runId }) }, { replace: true })
  rt.projectEffects?.register('chief.inspection-stop', { run: row => ({ runId: row.payload.runId, stopAttempt: row.payload.stopAttempt }) }, { replace: true })
  rt.projectEffects?.register('chief.correction', { run: row => ({ runId: row.payload.runId, round: row.payload.round }) }, { replace: true })
  const policyOf = id => ownEntry(policies(), id)
  function requireJobActor(actor, projectId) {
    const job = active.get(actor?.chiefJobId), policy = policyOf(projectId)
    if (rt.readOnly?.() || !job || job.token !== actor.chiefToken || job.run.projectId !== projectId || job.run.initiatedBy !== actor.memberId || job.run.status !== 'running' || job.run.invocation !== job.invocation || !policy?.enabled || policy.revision !== job.run.policyRevision || policy.authorityMemberId !== actor.memberId) throw refuse('Chief job authority is missing, revoked or stale')
    return job
  }
  async function validateActor(actor) {
    const run = ownEntry(rt.state.projectExecutions ?? {}, actor?.chiefJobId)
    requireJobActor(actor, run?.projectId)
    await rt.projectDelegations.background(actor.memberId)
    requireJobActor(actor, run.projectId)
    rt.requireProjectAccess(actor, run.projectId, 'configure')
    return true
  }
  function view(projectId, actor) {
    rt.requireProjectAccess(actor, projectId)
    const policy = policyOf(projectId), logical = policy?.scheduleId ? rt.state.projectScheduledTasks?.[policy.scheduleId] : null
    return { compensation: compensationSchedules(rt.state, projectId, policy?.scheduleId), health: inspectionHealth(rt.state, projectId), policy: structuredClone(policy ?? { enabled: false }), template: structuredClone(template), schedule: logical ? { id: logical.id, enabled: logical.enabled, status: logical.status, config: structuredClone(logical.config), deliveries: Object.values(logical.deliveries).slice(-5).map(row => structuredClone(row)) } : null, runs: Object.values(rt.state.projectExecutions ?? {}).filter(run => run.projectId === projectId && run.kind === 'chief-control').slice(-30).map(({ capability: _capability, ...row }) => structuredClone(row)) }
  }
  async function configure(body, actor) {
    rt.requireProjectAccess(actor, body.projectId, 'configure')
    if (actor.chiefJobId) throw refuse('Chief cannot grant or change its own arbitration authority')
    if (body.enabled !== false) await rt.projectDelegations.background(actor.memberId)
    const previous = policyOf(body.projectId)
    if (body.operationsContact !== undefined && (actor.agentId || actor.personalAgentCredentialId || actor.watchGrantId || actor.consultationProxyAgentId)) throw refuse('Only the signed-in human may select operations assistance')
    const contact = body.operationsContact === undefined ? structuredClone(previous?.operationsContact ?? null) : operationsContact(rt, body.projectId, body.operationsContact)
    const autonomy = autonomyPolicy(body.autonomy ?? previous?.autonomy)
    const inspection = { ...structuredClone(template), ...structuredClone(previous?.inspection ?? {}), ...structuredClone(body.inspection ?? {}), thresholds: { ...template.thresholds, ...(body.inspection?.thresholds ?? previous?.inspection?.thresholds ?? {}) } }
    correctionBudget({ inspection }); inspection.lifecycle = inspectionLifecycle(inspection)
    for (const value of Object.values(inspection.thresholds)) if (!Number.isSafeInteger(value) || value < 1) throw refuse('Chief inspection thresholds must be positive integers')
    const policy = { operationsContact: contact, autonomy, projectId: body.projectId, enabled: body.enabled !== false, authorityMemberId: actor.memberId, authorizedBy: actor.memberId, revision: (previous?.revision ?? 0) + 1, inspection, updatedAt: Date.now() }
    if (previous?.scheduleId || policy.enabled) {
      const scheduled = await rt.projectScheduledTasks.save({ projectId: body.projectId, ...(previous?.scheduleId ? { id: previous.scheduleId } : {}), target: { kind: 'project-chief', projectId: body.projectId }, rebindAuthority: true, ...inspection, enabled: policy.enabled && inspection.enabled !== false }, actor)
      policy.scheduleId = scheduled.id
    }
    setEntry(policies(), body.projectId, policy); await rt.save()
    return view(body.projectId, actor)
  }
  async function request(projectId, kind, source, taskId) {
    const policy = policyOf(projectId)
    if (!policy?.enabled) throw refuse('Chief arbitration authority has not been configured')
    const sourceKey = digest({ projectId, kind, source, taskId })
    const prior = Object.values(rt.state.projectExecutions ?? {}).find(run => run.kind === 'chief-control' && run.sourceKey === sourceKey)
    if (prior) return prior
    const id = `chief-run-${randomUUID()}`
    rt.bindProject({ kind: 'run', id, projectId, ...(taskId ? { taskId } : {}), status: 'queued' })
    const run = ownEntry(rt.state.projectExecutions, id)
    Object.assign(run, { kind: 'chief-control', purpose: kind, sourceKey, source: structuredClone(source), invocation: 0, correctionLimit: correctionBudget(policy), initiatedBy: policy.authorityMemberId, policyRevision: policy.revision, createdAt: Date.now() })
    if (kind === 'inspection' && source?.scheduleId) for (const old of Object.values(rt.state.projectExecutions ?? {})) if (old.id !== run.id && old.kind === 'chief-control' && old.projectId === projectId && old.purpose === 'inspection' && old.source?.scheduleId === source.scheduleId && ['queued', 'interrupted'].includes(old.status)) {
      old.recovery ??= {}; old.recovery.supersededBy = run.id
      if (old.status === 'queued') { old.status = 'cancelled'; old.failure = 'Coalesced into a newer scheduled inspection'; old.finishedAt = Date.now() }
    }
    await rt.save()
    rt.projectScheduler?.wake()
    return run
  }
  async function scheduled({ row, delivery }) {
    const prior = Object.values(rt.state.projectExecutions ?? {}).find(run => run.kind === 'chief-control' && run.projectId === row.projectId && run.source?.scheduleId === row.id && run.source?.occurrenceId === delivery.id)
    const run = prior ?? await request(row.projectId, 'inspection', { scheduleId: row.id, scheduleRevision: row.revision, occurrenceId: delivery.id, prompt: row.config.prompt })
    return { runId: run.id, pending: ['queued', 'running', 'correction-pending'].includes(run.status) }
  }
  const scheduledState = ({ row, delivery }) => scheduledInspectionState(rt.state, row, delivery)
  async function snapshot(run) {
    const tasks = Object.values(rt.state.tasks).filter(task => task.projectId === run.projectId && (!terminal.has(task.status) || run.purpose === 'task-change' && run.taskId === task.id) && (run.taskId || run.source?.blockedTaskId ? task.id === (run.taskId ?? run.source.blockedTaskId) : true)).slice(0, 30)
    return Promise.all(tasks.map(async task => {
      const attempt = rt.state.projectAttempts?.[task.deliveryAttemptId]
      const facts = inspectionFacts(rt.state, task, policyOf(run.projectId).inspection.thresholds)
      const autonomy = autonomyPolicy(policyOf(run.projectId).autonomy)
      const recoveryDecisions = Object.values(rt.state.projectChiefDecisions ?? {}).filter(row => row.taskId === task.id && row.projectId === task.projectId && row.status === 'applied' && ['route', 'return', 'request-tests', 'retry-notification'].includes(row.action) && row.at > (facts.lastMeaningfulProgressAt ?? 0)).sort((a, b) => a.at - b.at)
      facts.recoveryGuidance = { actionsSinceProgress: recoveryDecisions.length, windowStartedAt: recoveryDecisions[0]?.at ?? null, deadlineAt: recoveryDecisions.length ? recoveryDecisions[0].at + autonomy.maxRecoveryMs : null, budgetExceeded: recoveryDecisions.length >= autonomy.maxRecoveryActions || Boolean(recoveryDecisions.length && Date.now() - recoveryDecisions[0].at >= autonomy.maxRecoveryMs), consequence: 'Chief reassesses lawful next steps; host selects no escalation or role' }
      task.lastMeaningfulProgressAt = facts.lastMeaningfulProgressAt; task.meaningfulProgressEvidence = structuredClone(facts.progressEvidence)
      const claim = task.collaboration?.claim, worker = rt.state.projectHarnessWorkers?.[claim?.workerId]
      return { taskId: task.id, chiefActionIssue: task.chiefActionIssue ? { ...task.chiefActionIssue, historical: task.chiefActionIssue.generation !== (task.collaboration?.generation ?? 0) } : null, chiefDecisionIssue: task.chiefDecisionIssue ? { ...task.chiefDecisionIssue, historical: task.chiefDecisionIssue.generation !== (task.collaboration?.generation ?? 0) } : null, title: task.title, criteria: task.criteria ?? '', projectTaskKind: task.projectTaskKind ?? 'code', status: task.status, taskContract: task.projectTask ? { version: task.projectTask.version, admission: { status: task.projectTask.admission.status, ...(task.projectTask.admission.failure ? { failure: structuredClone(task.projectTask.admission.failure) } : {}) }, requirements: structuredClone(task.projectTask.requirements), wait: structuredClone(task.projectTask.wait ?? null), dependencies: task.projectTask.dependencies.map(row => ({ ...structuredClone(row), current: dependencyFact(rt.state, task, row.taskId) })) } : null,
        allocationProof: allocationProof(rt.state, task),
        execution: claim ? { claimId: claim.id, generation: claim.generation, workerId: claim.workerId ?? null, botId: claim.botId, status: claim.status, startedAt: claim.createdAt, elapsedMs: Date.now() - claim.createdAt, workerStatus: worker?.status ?? null, profile: worker?.profile ?? null, authenticationFailure: worker?.authenticationFailure ?? null, capabilityFailure: worker?.capabilityFailure ?? null, environmentObservations: worker?.environmentObservations ?? [], lastEventAt: worker?.lastEventAt ?? null } : null,
        handoff: task.collaboration?.history.at(-1) ? { id: task.collaboration.history.at(-1).id, purpose: task.collaboration.history.at(-1).purpose, reason: task.collaboration.history.at(-1).reason } : null,
        block: task.collaboration?.block ?? null, ...inspectionResources(rt.state, task),
        environment: { preparations: Object.values(attempt?.workspaces ?? {}).filter(row => row.environmentPreparation).slice(-6).map(row => ({ id: row.environmentPreparation.id, role: row.role, executor: row.environmentPreparation.executor, status: row.environmentPreparation.status, sha256: row.environmentPreparation.sha256 })), observations: Object.values(rt.state.projectHarnessWorkers ?? {}).filter(row => row.attemptId === attempt?.id && row.projectId === task.projectId && row.taskId === task.id).flatMap(row => (row.environmentObservations ?? []).map(value => ({ ...value, workerId: row.id, role: row.role, resourceId: row.resourceId }))).slice(-8) },
        contextRecovery: { admission: task.collaboration?.history.findLast(row => row.execution?.contextFailure)?.execution.contextFailure ?? null, workers: Object.values(rt.state.projectHarnessWorkers ?? {}).filter(row => row.attemptId === attempt?.id && row.taskId === task.id && row.projectId === task.projectId && (row.contextFailure || row.restoration)).slice(-6).map(row => ({ id: row.id, logicalSessionId: row.logicalSessionId, contextFailure: row.contextFailure ?? null, restoration: row.restoration ? { mode: row.restoration.mode, sourceWorkerId: row.restoration.sourceWorkerId, sourceSessionId: row.restoration.sourceSessionId, physicalSessionId: row.restoration.physicalSessionId ?? null, archiveSha256: row.restoration.archiveSha256 ?? null } : null })) },
        repositoryRecovery: await rt.projectDelivery.recoveryFacts?.(task) ?? null, integrationInputs: structuredClone(attempt?.integrationInputs ?? []), attemptStatus: attempt?.status ?? null,
        generation: task.collaboration?.generation ?? 0, destination: task.collaboration?.botId ?? null, attemptId: attempt?.id ?? null, candidateSha: attempt?.candidateSha ?? null,
        evidence: { implementation: attempt?.evidence.implementation ? { sha: attempt.evidence.implementation.sha, paths: attempt.evidence.implementation.paths } : null,
          tests: attempt?.evidence.tests ? { sha: attempt.evidence.tests.sha, passed: attempt.evidence.tests.passed, status: attempt.evidence.tests.status ?? null, stage: attempt.evidence.tests.stage ?? null, reason: attempt.evidence.tests.reason ?? null, testsStarted: attempt.evidence.tests.testsStarted ?? null, preparation: attempt.evidence.tests.preparation ? { id: attempt.evidence.tests.preparation.id, status: attempt.evidence.tests.preparation.status, executor: attempt.evidence.tests.preparation.executor, sha256: attempt.evidence.tests.preparation.sha256 } : null, sha256: attempt.evidence.tests.sha256, command: attempt.evidence.tests.command } : null,
          review: attempt?.evidence.review ? { sha: attempt.evidence.review.sha, verdict: attempt.evidence.review.verdict, summary: attempt.evidence.review.summary, repositoryVerdict: attempt.evidence.review.report?.repositoryVerdict ?? 'INC' } : null,
          merge: attempt?.evidence.merge ? structuredClone(attempt.evidence.merge) : null, mergeState: attempt?.merge ? { status: attempt.merge.status, reason: attempt.merge.reason, nextCheckAt: attempt.merge.nextCheckAt, mergeCommitSha: attempt.merge.mergeCommitSha ?? null } : null,
          outputs: attempt?.evidence.developer?.outputs ?? null, pr: attempt?.pr ? { number: attempt.pr.number, sha: attempt.pr.sha, url: attempt.pr.url } : null }, inspection: facts }
    }))
  }
  async function applyDecision(job, decision) {
    const { run } = job
    let { actor } = job
    await validateActor(actor)
    const task = ownEntry(rt.state.tasks, decision?.taskId), saved = job.snapshot.find(row => row.taskId === decision?.taskId)
    if (!task || task.projectId !== run.projectId || !saved || terminal.has(task.status) && decision.action !== 'reopen') throw refuse('Chief decision names an unavailable Task')
    if (task.projectTask && task.projectTask.requirements.revision !== saved.taskContract?.requirements.revision) throw refuse('Task requirements changed after Chief snapshot')
    if ((task.collaboration?.generation ?? 0) !== saved.generation || task.deliveryAttemptId !== saved.attemptId && (task.deliveryAttemptId ?? null) !== saved.attemptId || (rt.state.projectAttempts?.[task.deliveryAttemptId]?.candidateSha ?? null) !== saved.candidateSha) throw refuse('Task progressed after the Chief snapshot; decision is stale')
    const reason = typeof decision.reason === 'string' ? decision.reason.trim() : ''
    if (!reason || reason.length > 4000 || !['close', 'route', 'return', 'request-tests', 'needs-human', 'continue', 'admit', 'revise', 'cancel', 'reopen', 'resolve-dependency', 'retry-notification', 'reconcile-exit'].includes(decision.action)) throw refuse('Chief decision needs a supported action and bounded reason')
    if (decision.action === 'needs-human') { assistanceRequest(decision); if (decision.recipient === 'operations' && !operationsContact(rt, task.projectId, policyOf(task.projectId).operationsContact)) throw refuse('No operations contact is configured') }
    const audit = { id: `chief-decision-${randomUUID()}`, runId: run.id, projectId: run.projectId, taskId: task.id, initiatedBy: run.initiatedBy, executorRole: 'chief', action: decision.action, reason, snapshotSha256: run.snapshotSha256, candidateSha: saved.candidateSha, criteria: structuredClone(decision.criteria ?? []), status: 'requested', invocation: job.invocation, at: Date.now() }
    rt.state.projectChiefDecisions ??= {}; setEntry(rt.state.projectChiefDecisions, audit.id, audit)
    actor = rt.projectInputs?.chiefActor(actor, task.id, saved, run, decision.inputReceipts) ?? actor
    try {
    if (['admit', 'revise', 'cancel', 'reopen', 'resolve-dependency'].includes(decision.action)) {
      await rt.projectTaskLifecycle.adjudicate(task, { ...decision, expectedRequirementsRevision: saved.taskContract?.requirements.revision }, audit, actor)
    } else if (decision.action === 'continue') {
      if (run.purpose === 'arbitration' && task.collaboration) {
        task.collaboration.status = 'blocked'
        if (task.collaboration.claim?.chiefRunId === run.id) task.collaboration.claim.status = 'waiting-human'
        task.collaboration.block = { reason: `Chief deferred completion: ${reason}`, chiefDecisionId: audit.id, at: Date.now() }
      }
      task.chiefObservations = { fingerprint: saved.inspection.fingerprint, handoffCount: task.collaboration?.history.length ?? 0, lastDecisionId: audit.id, at: Date.now() }
    } else if (decision.action === 'needs-human') {
      if (task.collaboration) { task.collaboration.status = 'blocked'; task.collaboration.block = { reason, chiefDecisionId: audit.id, at: Date.now() } }
      if (task.collaboration?.claim?.chiefRunId === run.id) task.collaboration.claim.status = 'waiting-human'
      const assistance = assistanceRequest(decision)
      task.chiefQuestion = { decisionId: audit.id, reason, ...(assistance ? { assistance } : {}), at: Date.now() }
      await rt.projectScheduler?.captureWait?.(task)
      task.chiefQuestion.assistanceScope = assistanceScope(rt.state, task, decision.recipient)
      task.chiefQuestion.recipient = rt.projectAgents.contactUser?.(task, { id: audit.id, reason, recipient: decision.recipient, assistance, requiresHuman: decision.requiresHuman === true }, actor) ?? { kind: 'human', memberId: task.collaboration?.initiatedBy ?? actor.memberId }
    } else if (decision.action === 'reconcile-exit') {
      if (!saved.execution?.claimId) throw refuse('Exit reconciliation requires a claim in the current snapshot')
      audit.retirement = await rt.projectDelivery.reconcileExit({ projectId: task.projectId, attemptId: saved.attemptId, claimId: saved.execution.claimId, generation: saved.generation, reason }, actor)
    } else if (decision.action === 'retry-notification') {
      await rt.projectAgentInbox.remind(task, audit.id, actor)
    } else if (decision.action === 'close') {
      rt.projectTaskLifecycle?.requireCompletedDependencies(task)
      const criteriaIssues = !Array.isArray(decision.criteria) || !decision.criteria.length ? ['criteria: no acceptance items supplied'] : decision.criteria.flatMap((row, index) => [row?.passed !== true ? `criteria[${index}].passed: criterion not satisfied` : null, typeof row?.criterion !== 'string' || !row.criterion.trim() ? `criteria[${index}].criterion: missing acceptance item` : null, typeof row?.evidence !== 'string' || !row.evidence.trim() ? `criteria[${index}].evidence: missing evidence` : null].filter(Boolean))
      if (criteriaIssues.length) { audit.criteriaIssues = criteriaIssues; throw Object.assign(refuse(`Chief closure needs explicit acceptance-criteria evidence: ${criteriaIssues.join('; ')}`), { criteriaIssues, recovery: { version: 'chief-recovery/v1', kind: 'acceptance-evidence-missing', retryable: false, conditions: criteriaIssues, actions: ['inspect the actual current acceptance criteria and evidence'] } }) }
      await rt.projectDelivery.chiefAccept({ taskId: task.id, expectedSha: saved.candidateSha, decision: audit }, actor)
      if (task.collaboration) { if (task.collaboration.claim?.chiefRunId !== run.id) task.collaboration.claim = { id: `chief-final-${audit.id}`, botId: `${task.projectId}:chief`, chiefRunId: run.id, generation: task.collaboration.generation, executionEvidence: job.executionEvidence, workerId: job.executionEvidence?.workerId ?? `native-chief-job-${run.id}` }; task.collaboration.status = 'closed'; if (task.collaboration.claim) task.collaboration.claim.status = 'completed'; const receipt = task.collaboration.history.find(row => row.id === task.collaboration.currentHandoffId); if (receipt) { receipt.status = 'completed'; receipt.finishedAt = Date.now(); receipt.chiefDecisionId = audit.id; receipt.execution = structuredClone(task.collaboration.claim ?? { chiefRunId: run.id }) } ++task.collaboration.generation }
    } else {
      const target = decision.action === 'request-tests' ? `${run.projectId}:tester` : decision.targetBotId
      if (typeof target !== 'string') throw refuse('Chief routing needs an explicit logical Bot')
      if (!rt.projectAgents.deliveryDefinitions(run.projectId).roles.some(row => row.id === target && row.role !== 'chief')) throw refuse('Chief routing target is not an active Project execution role')
      if (decision.repositoryInputs !== undefined) await rt.projectDelivery.admitChiefInputs(task.id, decision.repositoryInputs, actor, saved)
      await rt.projectPools.chiefRoute({ taskId: task.id, targetBotId: target, expectedGeneration: saved.generation, reason, decisionId: audit.id, rework: decision.action === 'return' }, actor)
    }
    rt.projectInputs?.commitChief(actor, { afterDecision: true })
    rt.projectInputs?.finishChiefHandoff(task.id, saved.handoff?.id, audit.id)
    try {
      const summary = stageRoleSummary(rt.state, { task, role: 'chief', receiptId: audit.id,
        claim: { id: audit.id, projectId: task.projectId, taskId: task.id, attemptId: task.deliveryAttemptId ?? saved.attemptId, generation: task.collaboration?.generation ?? 0, decision: { action: decision.action, intentHash: audit.snapshotSha256 } },
        summary: { completed: `Chief ${decision.action}: ${reason}`, next: task.collaboration?.status === 'closed' ? 'Task closed by Chief after the existing evidence/authority gates' : task.chiefQuestion ? 'Await the addressed personal agent or current user; Chief retains arbitration' : `Follow the current ${task.collaboration?.status ?? task.status} state and original decision` } })
      audit.workSummaryRef = { id: summary.row.id, revision: summary.row.revision, sha256: summary.row.sha256 }
    } catch (error) {
      // Summary failure is visible and retains its last valid version; it must
      // not erase an already applied decision or manufacture a new Session.
      audit.contextIssue = { code: error.code ?? 'bot/context-resume', reason: error.message, retainedPrevious: true }
    }
    audit.status = 'applied'; audit.finishedAt = Date.now();
    const resume = rt.projectTaskLifecycle?.stageDependencyResume(task)
    if (resume) await rt.projectEffects.persist(resume); else await rt.save()
    return audit
    } finally { rt.projectInputs?.releaseChief(actor) }
  }
  async function completed(job, result) {
    const { run } = job
    if (active.get(run.id) !== job || run.invocation !== job.invocation || run.status !== 'running' || job.resultInProgress) return { ignored: true }
    job.resultInProgress = true
    let correcting = false, stage = result.stage ?? 'execution'
    const responseSha256 = result.ok === true && result.text !== undefined ? digest(String(result.text)) : null
    const diagnosticSha256 = result.ok !== true && result.text !== undefined ? digest(String(result.text)) : null
    run.lastResult = { ok: result.ok === true, invocation: job.invocation, source: result.stage === 'dispatch' ? 'host-dispatch' : 'executor', responseSha256, diagnosticSha256, receivedAt: Date.now() }
    try {
      if (!result.ok) throw Object.assign(refuse(`Chief execution failed before decision validation (${result.recoveryIssue?.kind ?? 'execution-failed'}); inspect this Run's execution evidence`), { recovery: result.recoveryIssue ?? classifyChiefRecovery(new Error('Chief execution failed')) })
      stage = 'execution-evidence'
      await validateActor(job.actor)
      const execution = result.executionEvidence, carrier = rt.state.projectAgents?.[`public-${run.projectId}`]
      if (!execution || execution.chiefRunId !== run.id || execution.carrierGeneration !== carrier?.carrierGeneration) throw refuse('Chief carrier changed or execution evidence is missing')
      if (execution.kind === 'sdk-chief') {
        const worker = rt.state.projectHarnessWorkers?.[execution.workerId], lease = rt.state.projectResourceLeases?.[worker?.leaseId]
        if (!worker || worker.chiefRunId !== run.id || worker.generation !== execution.generation || lease?.generation !== execution.generation || worker.sealedLog !== execution.log || await fileDigest(execution.log) !== execution.sha256) throw refuse('Chief SDK execution evidence is missing, stale or changed')
        rt.projectResources.requireBinding(run.projectId, lease)
      } else if (execution.kind !== 'native-chief' || execution.botId !== carrier.botId || execution.sessionId !== carrier.sessionId) throw refuse('Chief native execution Session changed')
      await validateActor(job.actor)
      const catalog = rt.projectAgents.deliveryDefinitions(run.projectId)
      if ((catalog.revision ?? null) !== job.roleRevision) throw refuse('Chief role catalog changed after snapshot')
      job.executionEvidence = execution
      const invocation = { number: job.invocation, snapshotSha256: run.snapshotSha256, responseSha256: digest(String(result.text)), execution: structuredClone(execution), at: Date.now() }
      ;(run.invocationHistory ??= []).push(invocation)
      stage = 'parsing'
      const protocolProblems = []
      const parsed = parseChiefResponse(result.text, job.logicalBots, { onInvalid: (decision, error) => protocolProblems.push({ decision, error }) })
      if (run.taskId && !run.appliedDecisions?.some(row => row.taskId === run.taskId) && !parsed.decisions.some(row => row?.taskId === run.taskId)) throw chiefProtocolError('decisions', 'an explicit decision for the requested Task', run.taskId)
      if (run.taskId) { const task = rt.state.tasks[run.taskId]; if (task.collaboration?.claim?.chiefRunId === run.id) { task.collaboration.claim.workerId = execution.workerId ?? `native-chief-job-${run.id}`; task.collaboration.claim.executionEvidence = execution } }
      job.executionEvidence = execution
      stage = 'preflight'
      for (const decision of parsed.decisions) {
        if (protocolProblems.some(row => row.decision?.taskId === decision?.taskId)) continue
        try {
          const applied = run.appliedDecisions?.find(row => row.taskId === decision.taskId)
          if (applied) { if (applied.intent !== digest(decision)) throw chiefProtocolError('decisions', 'omit an already applied Task decision; start a new judgement for new facts', decision.taskId); continue }
          const saved = job.snapshot.find(row => row.taskId === decision.taskId)
          if (!saved) throw chiefProtocolError('taskId', 'an exact Task in this invocation snapshot', decision.taskId)
          const current = ownEntry(rt.state.tasks, decision.taskId), changed = []
          if (!current || current.projectId !== run.projectId) changed.push('Task scope')
          else {
            if ((current.collaboration?.generation ?? 0) !== saved.generation) changed.push('generation')
            if ((current.deliveryAttemptId ?? null) !== saved.attemptId) changed.push('Attempt')
            if ((rt.state.projectAttempts?.[current.deliveryAttemptId]?.candidateSha ?? null) !== saved.candidateSha) changed.push('candidate')
            if (current.title !== saved.title || (current.criteria ?? '') !== saved.criteria || current.projectTask && current.projectTask.requirements.revision !== saved.taskContract?.requirements.revision) changed.push('requirements')
          }
          if (changed.length) throw Object.assign(chiefProtocolError('snapshot', `fresh facts after ${changed.join(', ')} changed`, decision.taskId), { recovery: { version: 'chief-recovery/v1', kind: 'stale-snapshot', changedFields: changed, retryable: false, conditions: ['fresh scoped snapshot; never rebase old input receipts'], actions: ['Chief reassesses current facts'] } })
          if (['route', 'return', 'request-tests'].includes(decision.action)) await rt.projectPools?.validateChiefRoute?.({ taskId: decision.taskId, targetBotId: decision.action === 'request-tests' ? `${run.projectId}:tester` : decision.targetBotId, expectedGeneration: saved.generation }, job.actor)
          try { rt.projectInputs?.validateChiefReceipt?.(decision.taskId, saved, run, decision.inputReceipts) }
          catch (error) { if (!error.receiptFeedback) throw error; throw Object.assign(chiefProtocolError('inputReceipts', 'the current injected snapshot IDs and handled subset of read', decision.taskId), { receiptFeedback: error.receiptFeedback, recovery: classifyChiefRecovery(error) }) }
        } catch (error) {
          if (error.code !== 'bot/chief-protocol') throw error
          protocolProblems.push({ decision, error })
        }
      }
      const roleProposals = protocolProblems.length ? [] : parsed.roleProposals ?? []
      if (!Array.isArray(roleProposals) || roleProposals.length > 4) throw refuse('Chief role proposals must be a bounded array')
      run.roleProposalIds = []
      for (const [index, proposal] of roleProposals.entries()) {
        const offered = await rt.projectAgents.proposeRoleForJob(job.actor, { ...proposal, requestId: `chief-role-${run.id}-${index}` })
        run.roleProposalIds.push(offered.proposal.id)
      }
      stage = 'applying'
      const results = [], failures = []
      for (const decision of parsed.decisions.filter(decision => !protocolProblems.some(row => row.decision?.taskId === decision?.taskId))) {
        try {
        const applied = run.appliedDecisions?.find(row => row.taskId === decision.taskId)
        if (applied) { if (applied.intent !== digest(decision)) throw refuse('A prior invocation already applied this Task decision; inspect its current state in a new job'); results.push(rt.state.projectChiefDecisions[applied.id]); continue }
        const audit = await applyDecision(job, decision); results.push(audit)
        ;(run.appliedDecisions ??= []).push({ taskId: decision.taskId, intent: digest(decision), id: audit.id })
        if (rt.state.tasks[decision.taskId]?.chiefActionIssue) delete rt.state.tasks[decision.taskId].chiefActionIssue
        if (rt.state.tasks[decision.taskId]?.chiefDecisionIssue) delete rt.state.tasks[decision.taskId].chiefDecisionIssue
        } catch (error) {
          if (run.purpose !== 'inspection' || error.code === 'bot/chief-protocol') throw error
          const failure = { taskId: decision.taskId, code: error.code ?? 'bot/chief', message: String(error.message).slice(0, 1000), at: Date.now() }; failures.push(failure)
          const task = rt.state.tasks[decision.taskId]; if (task?.projectId === run.projectId && (task.collaboration?.generation ?? 0) === job.snapshot.find(row => row.taskId === task.id)?.generation) task.chiefActionIssue = { runId: run.id, generation: task.collaboration?.generation ?? 0, kind: 'decision-refused', ...failure }
          await rt.save()
        }
      }
      if (protocolProblems.length) throw Object.assign(protocolProblems[0].error, { taskFeedback: protocolProblems.map(({ error }) => ({ taskId: error.taskId, fields: error.fields, recovery: error.recovery ?? null, receiptFeedback: error.receiptFeedback ?? null })) })
      await validateActor(job.actor)
      if (run.correction) run.correction.status = 'resolved'
      if (run.failureDetail) { run.failureDetail.historical = true; run.failureDetail.resolvedAt = Date.now() }
      delete run.failure; delete run.recoveryIssue
      run.waitingFor = null; run.status = failures.length ? 'partial' : 'done'; run.decisionFailures = failures; if (failures.length) run.failure = `${failures.length} Task decisions were refused; independent decisions continued`; run.summary = parsed.summary.slice(0, 8000); run.decisionIds = results.map(row => row.id); run.executionEvidence = result.executionEvidence ?? null
      waiters.get(run.id)?.resolve()
    } catch (error) {
      if (active.get(run.id) !== job || run.status !== 'running') return { ignored: true }
      if (error.code === 'bot/chief-protocol') {
        const previous = run.correction, round = (previous?.round ?? 0) + 1, limit = run.correctionLimit ?? correctionBudget(policyOf(run.projectId))
        const feedback = { ...(error.recovery ? { recovery: error.recovery } : {}), ...(error.receiptFeedback ? { receiptFeedback: error.receiptFeedback } : {}), code: error.code, taskId: error.taskId, fields: error.fields, message: error.message.slice(0, 500), at: Date.now(), sideEffects: (run.appliedDecisions?.length ? 'valid Task decisions were applied; never replay them' : 'response protocol rejected before applying its decisions'), taskFeedback: error.taskFeedback ?? [], allowedTaskIds: job.snapshot.map(row => row.taskId), appliedTaskIds: (run.appliedDecisions ?? []).map(row => row.taskId) }
        run.correction = protocolCorrection(previous, { version: 'chief-correction/v1', limit, feedback, priorExecution: job.executionEvidence ?? null })
        run.status = round <= limit ? 'correction-pending' : 'incomplete'; run.failure = feedback.message
        if (rt.projectEffects) {
          const token = rt.projectEffects.stage({ kind: 'chief.correction', key: `${run.id}:${round}`, projectId: run.projectId, ...(run.taskId ? { taskId: run.taskId } : {}), payload: { runId: run.id, round, feedbackSha256: digest(feedback) } })
          run.correction.effect = token
          try { await rt.projectEffects.persist(token) }
          catch (failure) {
            rt.projectEffects.discardUncommitted(token)
            run.status = 'failed'; run.correction.status = 'commit-failed'; run.failure = 'Chief protocol feedback could not be committed; preserve the original judgement for recovery'
            const task = run.taskId && rt.state.tasks[run.taskId]
            if (task?.collaboration?.claim?.chiefRunId === run.id) { task.collaboration.status = 'blocked'; task.collaboration.claim.status = 'failed' }
            throw failure
          }
        }
        for (const task of Object.values(rt.state.tasks).filter(row => row.projectId === run.projectId && (error.taskId ? row.id === error.taskId : run.taskId ? row.id === run.taskId : false))) {
          const saved = job.snapshot.find(row => row.taskId === task.id)
          if (!saved || terminal.has(task.status) || (task.collaboration?.generation ?? 0) !== saved.generation) continue
          task.chiefDecisionIssue = { runId: run.id, generation: saved.generation, status: run.correction.status, feedback, at: Date.now() }
          if (run.status === 'incomplete') {
            if (task.projectTask && task.projectTask.admission.status !== 'accepted') task.projectTask.admission.failure = { chiefRunId: run.id, reason: feedback.message, at: Date.now() }
            if (task.collaboration?.claim?.chiefRunId === run.id && task.collaboration.generation === job.snapshot.find(row => row.taskId === task.id)?.generation) { task.collaboration.status = 'blocked'; task.collaboration.claim.status = 'incomplete' }
          }
        }
        correcting = run.status === 'correction-pending'
        if (!correcting) waiters.get(run.id)?.reject(refuse('Chief judgement incomplete; correction budget exhausted'))
        return { correction: structuredClone(run.correction) }
      }
      run.status = 'failed'; run.failure = String(error.message).slice(0, 1000); run.recoveryIssue = error.recovery ?? classifyChiefRecovery(error)
      run.failureDetail = { invocation: job.invocation, stage, code: error.code ?? 'bot/chief', responseSha256, diagnosticSha256, recoveryKind: run.recoveryIssue.kind, criteriaIssues: error.criteriaIssues ?? [], at: Date.now() }
      if (run.correction?.status === 'pending') {
        run.correction.status = 'transport-incomplete'
        const task = run.taskId && ownEntry(rt.state.tasks, run.taskId)
        if (task?.chiefDecisionIssue?.runId === run.id && task.chiefDecisionIssue.generation === (task.collaboration?.generation ?? 0)) task.chiefDecisionIssue.status = 'transport-incomplete'
      }
      if (run.purpose === 'inspection' && run.recoveryIssue.retryable) {
        const config = inspectionLifecycle(policyOf(run.projectId)?.inspection)
        run.status = 'interrupted'; run.waitingFor = 'recovery'; run.recovery = { ...run.recovery, status: 'waiting-exit', attempts: run.recovery?.attempts ?? 0, notBefore: Date.now() + config.recoveryDelayMs }
      }
      for (const audit of Object.values(rt.state.projectChiefDecisions ?? {})) if (audit.runId === run.id && audit.status === 'requested') { audit.status = 'rejected'; audit.failure = run.failure; audit.finishedAt = Date.now() }
      if (run.taskId) {
        const task = ownEntry(rt.state.tasks, run.taskId), saved = job.snapshot.find(row => row.taskId === run.taskId)
        if (task && !terminal.has(task.status) && saved && (task.collaboration?.generation ?? 0) === saved.generation && (task.deliveryAttemptId ?? null) === saved.attemptId) {
          task.chiefActionIssue = { runId: run.id, generation: saved.generation, kind: 'chief-run-failure', ...run.failureDetail, message: run.failure }
          if (task.projectTask && task.projectTask.admission.status !== 'accepted') task.projectTask.admission.failure = { chiefRunId: run.id, reason: run.failure, at: Date.now() }
          if (task.collaboration?.claim?.chiefRunId === run.id) { task.collaboration.status = 'blocked'; task.collaboration.claim.status = 'failed' }
        }
      }
      waiters.get(run.id)?.reject(error)
    } finally { if (run.invocation !== job.invocation) return; run.lastInvocationFinishedAt = Date.now(); if (!correcting) run.finishedAt = Date.now(); if (active.get(run.id) === job) active.delete(run.id); if (!correcting) waiters.delete(run.id); await rt.save(); if (correcting) rt.projectScheduler?.wake() }
  }
  async function inspectionExited(run) {
    await rt.projectAgents.reconcileChiefExit?.(run)
    const workers = Object.values(rt.state.projectHarnessWorkers ?? {}).filter(row => row.chiefRunId === run.id && (row.chiefInvocation === undefined ? row.id === run.workerId : row.chiefInvocation === run.invocation))
    const leases = Object.values(rt.state.projectResourceLeases ?? {}).filter(row => row.chiefRunId === run.id && row.chiefInvocation === run.invocation || workers.some(worker => worker.leaseId === row.id))
    if (leases.some(row => row.status !== 'released')) return false
    if (workers.length) return workers.every(row => confirmedWorkerExit(rt.state, row) && leases.some(lease => lease.id === row.leaseId && lease.projectId === row.projectId && lease.attemptId === row.attemptId && lease.role === row.role && lease.resourceId === row.resourceId && lease.generation === row.generation && lease.worker?.handle === row.id))
    if (leases.length && leases.every(row => row.releaseProof && (!row.worker && row.releaseProof.kind === 'unbound-reservation-release' || row.worker?.kind === 'native-turn' && ['host-confirmed-worker-exit', 'systemd-prior-invocation-exited', 'native-chief-prior-host-exited'].includes(row.releaseProof.kind)))) return true
    const agent = rt.state.projectAgents?.[`public-${run.projectId}`], proof = agent?.lastRequest?.exitProof
    if (proof?.confirmed && proof.runId === run.id && agent.lastRequest.chiefRunId === run.id && proof.carrierGeneration === agent.carrierGeneration && proof.invocation === run.invocation) return true
    if (['native-chief-quiescent', 'native-chief-prior-host-exited', 'sdk-chief-confirmed-exit', 'chief-never-dispatched'].includes(run.exitProof?.kind) && run.exitProof?.confirmed && run.exitProof.runId === run.id && run.exitProof.invocation === run.invocation) return true
    return Boolean(await priorScopeExited(run.processScope))
  }
  async function inspectionBarrier(current) {
    for (const run of Object.values(rt.state.projectExecutions ?? {})) {
      if (run.id === current.id || run.projectId !== current.projectId || run.kind !== 'chief-control' || run.status !== 'interrupted' && run.recovery?.exitConfirmed !== false || !run.startedAt) continue
      if (!await inspectionExited(run)) return true
      if (run.recovery?.exitConfirmed === false) { run.recovery.exitConfirmed = true; if (run.status !== 'interrupted') run.recovery.status = 'isolated-exit-confirmed'; await rt.save() }
    }
    return false
  }
  function reconcileInspections() {
    if (reconciling) return reconciling
    reconciling = (async () => {
      const now = Date.now()
      for (const run of Object.values(rt.state.projectExecutions ?? {}).filter(row => row.kind === 'chief-control' && row.purpose === 'inspection')) {
        const policy = policyOf(run.projectId), config = inspectionLifecycle(policy?.inspection)
        if (['queued', 'running', 'correction-pending'].includes(run.status)) {
          const since = run.status === 'queued' ? run.queuedAt ?? run.createdAt : run.startedAt ?? run.createdAt
          const limit = run.status === 'queued' ? config.queueTimeoutMs : config.runTimeoutMs
          if (now - since >= limit) {
            const job = active.get(run.id)
            run.waitingFor = run.status === 'queued' ? 'chief-busy' : 'worker-exit'; run.status = run.status === 'queued' ? 'failed' : 'interrupted'; run.failure = `Chief inspection ${job ? 'execution' : 'queue/execution'} deadline exceeded`; run.finishedAt = now
            run.recovery = { ...run.recovery, status: 'waiting-exit', notBefore: now + config.recoveryDelayMs, attempts: run.recovery?.attempts ?? 0 }
            if (job && !job.resultInProgress) active.delete(run.id)
            waiters.get(run.id)?.reject(refuse(run.failure)); waiters.delete(run.id)
            await rt.save()
          }
        }
        if (run.status !== 'interrupted' && run.recovery?.exitConfirmed !== false) continue
        if (run.status === 'interrupted' && (!policy?.enabled || policy.revision !== run.policyRevision || run.source?.scheduleId && (!rt.state.projectScheduledTasks?.[run.source.scheduleId]?.enabled || run.source.scheduleRevision !== undefined && rt.state.projectScheduledTasks[run.source.scheduleId].revision !== run.source.scheduleRevision))) { run.status = 'cancelled'; run.failure = 'Inspection recovery authority or schedule changed'; active.delete(run.id); await rt.save() }
        if (!run.recovery) { run.recovery = { status: 'waiting-exit', notBefore: now + config.recoveryDelayMs, attempts: 0 }; await rt.save() }
        const exited = await inspectionExited(run)
        run.recovery.exitConfirmed = exited
        if (!exited) {
          run.recovery.status = (run.recovery.stopAttempts ?? 0) >= config.maxStopAttempts ? 'exit-unconfirmed' : 'waiting-exit'
          run.recoveryIssue = { version: 'chief-recovery/v1', kind: 'worker-exit-unknown', retryable: true, conditions: ['matching execution exit proof'], actions: ['inspect registered worker and lease evidence'], stopBudgetExhausted: (run.recovery.stopAttempts ?? 0) >= config.maxStopAttempts }
          if (!stopping.has(run.id) && (run.recovery.stopAttempts ?? 0) < config.maxStopAttempts && now >= (run.recovery.nextStopAt ?? 0) && rt.projectAgents.stopChiefJob) {
            run.recovery.stopAttempts = (run.recovery.stopAttempts ?? 0) + 1
            run.recovery.nextStopAt = now + config.recoveryDelayMs
            const invocation = run.invocation
            let stopIntent
            try {
              if (rt.projectEffects) {
                stopIntent = rt.projectEffects.stage({ kind: 'chief.inspection-stop', key: `${run.id}:${invocation}:${run.recovery.stopAttempts}`, projectId: run.projectId, payload: { runId: run.id, invocation, stopAttempt: run.recovery.stopAttempts } })
                await rt.projectEffects.persist(stopIntent)
              } else await rt.save()
            } catch (error) { if (!stopIntent || rt.projectEffects.discardUncommitted(stopIntent)) --run.recovery.stopAttempts; throw error }
            const pending = Promise.resolve().then(() => rt.projectAgents.stopChiefJob(run.projectId, run.id)).then(async proof => {
              if (proof?.confirmed && run.invocation === invocation && ['interrupted', 'cancelled', 'failed'].includes(run.status)) { run.exitProof = { ...proof, runId: run.id, invocation, at: Date.now() }; await rt.save(); rt.projectScheduler?.wake() }
            }).catch(error => { run.recovery.stopFailure = String(error.message).slice(0, 300) }).finally(() => stopping.delete(run.id))
            stopping.set(run.id, pending)
          }
          continue
        }
        if (run.status !== 'interrupted') { run.recovery.status = 'isolated-exit-confirmed'; active.delete(run.id); await rt.save(); continue }
        if (active.has(run.id) || rt.projectAgents.chiefBusy(run.projectId)) continue
        if (run.recovery.supersededBy) { run.status = 'cancelled'; run.recovery.status = 'coalesced'; await rt.save(); continue }
        if ((run.recovery.attempts ?? 0) >= config.maxRecoveries) { run.status = 'failed'; run.recovery.status = 'exhausted'; await rt.save(); continue }
        if (now < run.recovery.notBefore) continue
        try {
          await rt.projectDelegations.background(policy.authorityMemberId)
          rt.requireProjectAccess({ memberId: policy.authorityMemberId }, run.projectId, 'configure')
          if (policyOf(run.projectId) !== policy || policy.revision !== run.policyRevision) throw refuse('Inspection policy changed during recovery')
          if (run.recovery.stopAttempts) run.recovery.stopHistory = [...(run.recovery.stopHistory ?? []), { invocation: run.invocation, attempts: run.recovery.stopAttempts, lastStopAt: run.recovery.nextStopAt }].slice(-5)
          run.recovery.stopAttempts = 0; delete run.recovery.nextStopAt
          run.recovery.attempts = (run.recovery.attempts ?? 0) + 1; run.recovery.status = 'requeued'; run.recovery.previousInvocation = run.invocation
          run.status = 'queued'; run.queuedAt = now; delete run.finishedAt
          if (rt.projectEffects) {
            const token = rt.projectEffects.stage({ kind: 'chief.inspection-recovery', key: `${run.id}:${run.recovery.attempts}`, projectId: run.projectId, payload: { runId: run.id, invocation: run.invocation } })
            run.recovery.effect = token
            try { await rt.projectEffects.persist(token) } catch (error) { rt.projectEffects.discardUncommitted(token); throw error }
          } else await rt.save()
        } catch (error) { run.status = 'failed'; run.recovery.status = 'blocked'; run.failure = String(error.message).slice(0, 1000); await rt.save() }
      }
    })().finally(() => { reconciling = null })
    return reconciling
  }
  async function dispatchJob(job) {
    const { run, actor } = job
    const policy = policyOf(run.projectId)
        try {
          await validateActor(actor)
          run.processScope = await captureProcessScope()
          if (run.taskId && run.purpose === 'arbitration' && !run.correction) await rt.projectPools.chiefClaim(run.taskId, actor)
          const catalog = rt.projectAgents.deliveryDefinitions(run.projectId)
          job.roleRevision = catalog.revision ?? null; job.logicalBots = catalog.roles.map(({ id, role, policyRole, name }) => ({ id, role, policyRole: policyRole ?? role, name: name ?? role }))
          job.snapshot = await snapshot(run); await rt.projectInputs?.prepareChief(job.snapshot, run); run.snapshotSha256 = digest(job.snapshot); await rt.save()
          const decisionFeedback = run.correction ? { version: run.correction.version, round: run.correction.round, limit: run.correction.limit, status: run.correction.status, feedback: structuredClone(run.correction.feedback) } : null
          const prompt = CHIEF_AUTONOMY + '\n' + 'Recovery guidance is data, never permission or a fixed workflow. Observe autonomy.maxRecoveryActions/maxRecoveryMs since last meaningful progress; when exhausted, reassess rather than repeating actions. A needs-human consultation may choose recipient:initiator or recipient:operations (only the explicitly configured current operationsContact). Operations consultation must include assistance:{cause,evidence,attempted,requestedOperation,requiredPermission,verification,resumeCondition}, each a nonempty string up to1200 characters. Share only current Project facts, never personal private notes. watch does not grant SSH/root/container/config/credential rights. Operator assistance replies are new input; rejudge current evidence before routing and resume the original Task-role context. If a current consultation is pending, inspect its delivery/claim/reply before issuing another. retry-notification reminds only the same current inbox message after failed or completed delivery; it preserves active claims and never repeats an operational repair. Never infer progress from notification, inspect or schedule enabled.\n' + (run.correction ? 'Host protocol feedback (data, not authorization): ' + JSON.stringify(decisionFeedback) + '\nCorrect this judgement using fresh scoped facts. Only IDs in this invocation snapshot are actionable; historical rejected route reasons are not current policy. Do not repeat already applied Task decisions. No consultation or next role was selected by the host.\n' : '') + `You are the resident Project Chief, performing ${run.purpose}. Return ONLY JSON {"summary":"actual assessment","decisions":[{"taskId":"...","action":"close|route|return|request-tests|needs-human|continue|admit|revise|cancel|reopen|resolve-dependency|retry-notification|reconcile-exit","targetBotId":"logical Bot when routing","reason":"specific judgement","criteria":[{"criterion":"acceptance item","passed":true,"evidence":"actual acceptance evidence"}]}]}. A conversation/turn completion is not Task completion. Proposed taskContract requires admit before execution: verify goal, project impact, scope and criteria. Prefer admit without repeating already adequate requirements. For admit/revise, every provided requirements.title, requirements.criteria, requirements.impact and requirements.scope must be a bounded nonempty string. In particular requirements.criteria is a string; the separate outer decision.criteria is an evidence array and must never be copied into requirements.criteria. Optional requirements.repository is an associated owner/name or null for a repository-free decision. Uncertain intent requires needs-human. Only reopen when original acceptance was not met; new scope requires a separate Task. Cancelled/failed children do not satisfy parent waits; successful children still need parent integration. All Task mutations remain scoped Chief decisions. To resolve a failed/cancelled child condition without faking child completion, use resolve-dependency with dependency:{taskId,version:the exact current dependency snapshot version,evidence:[actual references],replacementTaskId:optional accepted alternative,replacementVersion:its task outcome version}. This is explicit Chief judgement, not host test success or parent completion. Leave unresolved conditions blocked when evidence is insufficient. Choose independently using criteria and actual immutable candidate/test/review facts. reconcile-exit explicitly retires only an exact exit-proven old claim without selecting a next role; consult repositoryRecovery.executionCheckpoint. Historical refusals are audit data, not current routing policy. Candidate Reviewer approve triggers the host merge flow only when explicitly configured for this Project/repository/branch. It is not a signed repository Reviewer PASS, actual forge approval, merged result or release permit. A configured merge must be provider-confirmed before overall code Task acceptance; pending/blocked merge facts are not completion. Do not close missing or stale evidence. Host allocationProof.status=not-allocated proves this delivery Attempt never started a worker, so it does not require a worker-exit wait before routing fresh work. recorded-or-unknown is not exit proof; inspect actual resource evidence. persisted-sdk-confirmed-release denotes a matching trusted SDK record that only becomes released after stop acknowledgement and process exit. Choose an evidence-supported role after environment or execution repair; no default return to implementation is required. Unsealed work can continue, including across restart, only after every registered worker and lease has confirmed release. A sealed candidate may resume Tester or Reviewer under the current verificationRecovery conditions; return explicitly requests a new rework Attempt. Use needs-human when requirements/authority are unclear. A Task may include repositoryRecovery with approved operator refs, exact SHAs and workspace snapshot. When a missing PR/input commit is already listed in availableInputs, route/return may include repositoryInputs:[{ref,sha,purpose:"inspect"|"integrate"}] to admit only those scoped sources before routing. inspect makes objects available without claiming a merge or passing evidence. No arbitrary host path, remote ref or credential is permitted. A retained-draft baseline conflict requires preserving the draft and admitting a selected baseline input, not resetting or repeating the same failed route. Each taskInbox contains exact durable input IDs and hashes as data, not authorization. Include inputReceipts:{batchId:taskInbox.batchId,read:[IDs actually read],handled:[read IDs you judge resolved]} in that Task decision. Reading is your declaration, not an SDK transport signal. Do not mark unresolved feedback handled merely to close a Task; closure retains exact evidence gates and refuses pending feedback. Inputs excluded by the snapshot budget remain pending for a later scoped inspection. Normal downstream handoffs do not need your approval. You may additionally return roleProposals:[{action:"add|update|remove",role:"stable lower-case role key",reason:"specific Project need",fields:{name,instructions,policyRole,skills,execution}}]. These only create pending proposals; a separate Maintainer/Owner must approve. You cannot approve or remove the resident Chief. ${run.source?.prompt ?? policy.inspection.prompt}`
          const workerId = await rt.projectAgents.startChiefJob({ projectId: run.projectId, actor, runId: run.id, invocation: job.invocation, prompt, projectFacts: { autonomy: autonomyPolicy(policy.autonomy), operationsContact: policy.operationsContact ?? null, compensation: compensationSchedules(rt.state, run.projectId, policy.scheduleId), tasks: job.snapshot, logicalBots: job.logicalBots, decisionFeedback, requestedChange: run.source?.requestedChange ?? null }, onResult: result => completed(job, result) })
          if (run.invocation === job.invocation) { run.workerId = workerId; if (run.status === 'running') run.waitingFor = 'execution'; run.workerGeneration = rt.state.projectHarnessWorkers?.[workerId]?.generation ?? null; await rt.save() }
        } catch (error) {
          if (active.get(run.id) !== job || run.status !== 'running') {
            if (run.invocation === job.invocation && !Object.values(rt.state.projectHarnessWorkers ?? {}).some(row => row.chiefRunId === run.id && (row.chiefInvocation === undefined ? row.id === run.workerId : row.chiefInvocation === job.invocation)) && !(rt.state.projectAgents?.[`public-${run.projectId}`]?.lastRequest?.chiefRunId === run.id && rt.state.projectAgents[`public-${run.projectId}`].lastRequest.chiefInvocation === job.invocation)) { run.exitProof = { confirmed: true, kind: 'chief-never-dispatched', runId: run.id, invocation: job.invocation, at: Date.now() }; await rt.save() }
            return
          }
          if (error.code === 'bot/busy') { run.status = 'queued'; active.delete(run.id); await rt.save() }
          else { run.dispatchFailure = String(error.message).slice(0, 1000); run.recoveryIssue = classifyChiefRecovery(error); await completed(job, { ok: false, stage: 'dispatch', text: String(error.message), recoveryIssue: run.recoveryIssue }) }
        }
  }
  async function pump() {
    if (rt.readOnly?.()) return
    await reconcileInspections()
    if (pumping) return
    pumping = true
    try {
      for (const run of Object.values(rt.state.projectExecutions ?? {}).filter(row => row.kind === 'chief-control' && row.status === 'correction-pending')) {
        if (rt.projectAgents.chiefBusy(run.projectId)) continue
        if (run.correction?.effect && !rt.projectEffects?.intentCommitted(run.correction.effect)) continue
        const previous = run.correction?.priorExecution
        if (previous?.kind === 'sdk-chief' && (rt.state.projectHarnessWorkers?.[previous.workerId]?.generation !== previous.generation || rt.state.projectHarnessWorkers?.[previous.workerId]?.chiefRunId !== run.id || rt.state.projectHarnessWorkers?.[previous.workerId]?.projectId !== run.projectId || !confirmedWorkerExit(rt.state, rt.state.projectHarnessWorkers?.[previous.workerId]) || rt.state.projectResourceLeases?.[rt.state.projectHarnessWorkers?.[previous.workerId]?.leaseId]?.status !== 'released')) continue
        run.status = 'queued'; await rt.save()
      }
      for (const run of Object.values(rt.state.projectExecutions ?? {}).filter(row => row.kind === 'chief-control' && row.status === 'interrupted' && row.taskId && row.purpose !== 'inspection')) {
        const task = rt.state.tasks[run.taskId], policy = policyOf(run.projectId)
        if (!policy?.enabled || task?.collaboration?.claim?.chiefRunId !== run.id || task.collaboration.claim.status !== 'interrupted') continue
        if (!await inspectionExited(run)) continue
        try { await rt.projectPools.retryChief(task.id, { memberId: policy.authorityMemberId }); run.recovery = { status: 'requeued', at: Date.now() }; await rt.save() } catch (error) { run.recovery = { status: 'blocked', reason: error.message, at: Date.now() } }
      }
      for (const task of Object.values(rt.state.tasks)) if (task.collaboration?.status === 'arbitration' && !terminal.has(task.status) && policyOf(task.projectId)?.enabled) await request(task.projectId, 'arbitration', { handoffId: task.collaboration.currentHandoffId }, task.id)
      for (const run of Object.values(rt.state.projectExecutions ?? {}).filter(row => row.kind === 'chief-control' && row.status === 'queued')) {
        if ([...active.values()].some(job => job.run.projectId === run.projectId) || rt.projectAgents.chiefBusy(run.projectId)) { run.waitingFor = 'chief-busy'; continue }
        if (await inspectionBarrier(run)) { run.waitingFor = 'worker-exit'; continue }
        const policy = policyOf(run.projectId)
        if (!policy?.enabled || policy.revision !== run.policyRevision) { run.status = 'cancelled'; waiters.get(run.id)?.reject(refuse('Chief policy changed before execution')); waiters.delete(run.id); await rt.save(); continue }
        const actor = { memberId: policy.authorityMemberId, chiefJobId: run.id, chiefToken: randomUUID() }
        const job = { run, actor, token: actor.chiefToken, snapshot: [], invocation: (run.invocation ?? 0) + 1 }
        run.invocation = job.invocation; run.executionBoundary = null; delete run.workerId; delete run.workerGeneration
        run.status = 'running'; run.waitingFor = 'preparing'; run.startedAt = Date.now(); active.set(run.id, job); await rt.save()
        void dispatchJob(job).catch(error => rt.warn?.('Chief dispatch result could not be saved: %s', error.message))
      }
    } finally { pumping = false }
  }
  function recover() {
    let changed = false
    for (const run of Object.values(rt.state.projectExecutions ?? {})) if (run.kind === 'chief-control' && run.status === 'running') { run.status = 'interrupted'; run.waitingFor = 'recovery'; run.recoveryIssue = { version: 'chief-recovery/v1', kind: 'host-recovering', retryable: true, conditions: ['prior execution exit reconciliation'], actions: ['wait for the existing recovery pass'] }; run.failure = 'Host restarted before Chief result was validated'; changed = true }
    return changed
  }
  return { exitConfirmed: inspectionExited, configure, view, request, scheduled, scheduledState, pump, recover, requireJobActor, validateActor, applyDecision, template: structuredClone(template) }
}
export function install(rt) {
  rt.projectChiefControl = createProjectChiefControl(rt)
  rt.projectScheduledTasks.register('project-chief', { resolve: async (target, actor) => rt.projectAgents.ensurePublic(target.projectId, actor), run: work => rt.projectDevelopment.scheduled(work), status: work => rt.projectChiefControl.scheduledState(work) })
}
