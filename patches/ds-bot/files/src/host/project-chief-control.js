// Chief arbitration uses existing Tasks, Runs, Sessions and resource leases.
import { randomUUID, createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { captureProcessScope, priorScopeExited } from './project-process-proof.js'
import { fileDigest } from './project-resource-workspaces.js'
import { ownEntry, setEntry } from './store.js'
import { dependencyFact } from './project-task-lifecycle.js'
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
function verifiedProgress(evidence = []) {
  return evidence.filter(row => row.kind === 'host-tests' && row.passed === true && typeof row.sha === 'string' && typeof row.sha256 === 'string')
}
export function progressFingerprint(attempt) {
  const tests = attempt?.evidence?.tests
  return digest(tests?.passed === true && tests.sha === attempt.candidateSha ? { testedCandidate: tests.sha } : null)
}
export function inspectionFacts(state, task, thresholds, now = Date.now()) {
  const c = task.collaboration, attempt = state.projectAttempts?.[task.deliveryAttemptId], fingerprint = progressFingerprint(attempt)
  let checkpoint = 0, lastMeaningfulProgressAt = null, progressEvidence = []
  const seen = new Set()
  for (const [index, receipt] of (c?.history ?? []).entries()) {
    const fresh = verifiedProgress(receipt.evidence).filter(row => !seen.has(row.sha))
    for (const row of fresh) seen.add(row.sha)
    if (fresh.length) { checkpoint = index + 1; lastMeaningfulProgressAt = receipt.createdAt; progressEvidence = fresh.map(row => ({ handoffId: receipt.id, sha: row.sha, testLogSha256: row.sha256 })) }
  }
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
  return { taskId: task.id, fingerprint, handoffsWithoutProgress: handoffs, reasons, observedAt: now, checkpoint, lastMeaningfulProgressAt, progressEvidence }
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
  let pumping = false
  const policyOf = id => ownEntry(policies(), id)
  function requireJobActor(actor, projectId) {
    const job = active.get(actor?.chiefJobId), policy = policyOf(projectId)
    if (rt.readOnly?.() || !job || job.token !== actor.chiefToken || job.run.projectId !== projectId || job.run.initiatedBy !== actor.memberId || job.run.status !== 'running' || !policy?.enabled || policy.revision !== job.run.policyRevision || policy.authorityMemberId !== actor.memberId) throw refuse('Chief job authority is missing, revoked or stale')
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
    return { policy: structuredClone(policy ?? { enabled: false }), template: structuredClone(template), schedule: logical ? { id: logical.id, enabled: logical.enabled, status: logical.status, config: structuredClone(logical.config), deliveries: Object.values(logical.deliveries).slice(-5).map(row => structuredClone(row)) } : null, runs: Object.values(rt.state.projectExecutions ?? {}).filter(run => run.projectId === projectId && run.kind === 'chief-control').slice(-30).map(({ capability: _capability, ...row }) => structuredClone(row)) }
  }
  async function configure(body, actor) {
    rt.requireProjectAccess(actor, body.projectId, 'configure')
    if (actor.chiefJobId) throw refuse('Chief cannot grant or change its own arbitration authority')
    if (body.enabled !== false) await rt.projectDelegations.background(actor.memberId)
    const previous = policyOf(body.projectId)
    const inspection = { ...structuredClone(template), ...structuredClone(previous?.inspection ?? {}), ...structuredClone(body.inspection ?? {}), thresholds: { ...template.thresholds, ...(body.inspection?.thresholds ?? previous?.inspection?.thresholds ?? {}) } }
    for (const value of Object.values(inspection.thresholds)) if (!Number.isSafeInteger(value) || value < 1) throw refuse('Chief inspection thresholds must be positive integers')
    const policy = { projectId: body.projectId, enabled: body.enabled !== false, authorityMemberId: actor.memberId, authorizedBy: actor.memberId, revision: (previous?.revision ?? 0) + 1, inspection, updatedAt: Date.now() }
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
    Object.assign(run, { kind: 'chief-control', purpose: kind, sourceKey, source: structuredClone(source), initiatedBy: policy.authorityMemberId, policyRevision: policy.revision, createdAt: Date.now() })
    await rt.save()
    rt.projectScheduler?.wake()
    return run
  }
  async function scheduled({ row, delivery }) {
    const run = await request(row.projectId, 'inspection', { scheduleId: row.id, occurrenceId: delivery.id, prompt: row.config.prompt })
    if (run.status === 'done') return
    return new Promise((resolve, reject) => { waiters.set(run.id, { resolve, reject }); void pump() })
  }
  async function snapshot(run) {
    const tasks = Object.values(rt.state.tasks).filter(task => task.projectId === run.projectId && (!terminal.has(task.status) || run.purpose === 'task-change' && run.taskId === task.id) && (run.taskId || run.source?.blockedTaskId ? task.id === (run.taskId ?? run.source.blockedTaskId) : true)).slice(0, 30)
    return Promise.all(tasks.map(async task => {
      const attempt = rt.state.projectAttempts?.[task.deliveryAttemptId]
      const facts = inspectionFacts(rt.state, task, policyOf(run.projectId).inspection.thresholds)
      task.lastMeaningfulProgressAt = facts.lastMeaningfulProgressAt; task.meaningfulProgressEvidence = structuredClone(facts.progressEvidence)
      const claim = task.collaboration?.claim, worker = rt.state.projectHarnessWorkers?.[claim?.workerId]
      return { taskId: task.id, title: task.title, criteria: task.criteria ?? '', projectTaskKind: task.projectTaskKind ?? 'code', status: task.status, taskContract: task.projectTask ? { version: task.projectTask.version, admission: { status: task.projectTask.admission.status, ...(task.projectTask.admission.failure ? { failure: structuredClone(task.projectTask.admission.failure) } : {}) }, requirements: structuredClone(task.projectTask.requirements), wait: structuredClone(task.projectTask.wait ?? null), dependencies: task.projectTask.dependencies.map(row => ({ ...structuredClone(row), current: dependencyFact(rt.state, task, row.taskId) })) } : null,
        allocationProof: allocationProof(rt.state, task),
        execution: claim ? { botId: claim.botId, status: claim.status, startedAt: claim.createdAt, elapsedMs: Date.now() - claim.createdAt, workerStatus: worker?.status ?? null, lastEventAt: worker?.lastEventAt ?? null } : null,
        handoff: task.collaboration?.history.at(-1) ? { id: task.collaboration.history.at(-1).id, purpose: task.collaboration.history.at(-1).purpose, reason: task.collaboration.history.at(-1).reason } : null,
        block: task.collaboration?.block ?? null, ...inspectionResources(rt.state, task),
        repositoryRecovery: await rt.projectDelivery.recoveryFacts?.(task) ?? null, integrationInputs: structuredClone(attempt?.integrationInputs ?? []), attemptStatus: attempt?.status ?? null,
        generation: task.collaboration?.generation ?? 0, destination: task.collaboration?.botId ?? null, attemptId: attempt?.id ?? null, candidateSha: attempt?.candidateSha ?? null,
        evidence: { implementation: attempt?.evidence.implementation ? { sha: attempt.evidence.implementation.sha, paths: attempt.evidence.implementation.paths } : null,
          tests: attempt?.evidence.tests ? { sha: attempt.evidence.tests.sha, passed: attempt.evidence.tests.passed, sha256: attempt.evidence.tests.sha256, command: attempt.evidence.tests.command } : null,
          review: attempt?.evidence.review ? { sha: attempt.evidence.review.sha, verdict: attempt.evidence.review.verdict, summary: attempt.evidence.review.summary, repositoryVerdict: attempt.evidence.review.report?.repositoryVerdict ?? 'INC' } : null,
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
    if (!reason || reason.length > 4000 || !['close', 'route', 'return', 'request-tests', 'needs-human', 'continue', 'admit', 'revise', 'cancel', 'reopen', 'resolve-dependency'].includes(decision.action)) throw refuse('Chief decision needs a supported action and bounded reason')
    const audit = { id: `chief-decision-${randomUUID()}`, runId: run.id, projectId: run.projectId, taskId: task.id, initiatedBy: run.initiatedBy, executorRole: 'chief', action: decision.action, reason, snapshotSha256: run.snapshotSha256, candidateSha: saved.candidateSha, criteria: structuredClone(decision.criteria ?? []), status: 'requested', at: Date.now() }
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
      task.chiefQuestion = { decisionId: audit.id, reason, at: Date.now() }
      task.chiefQuestion.recipient = rt.projectAgents.contactUser?.(task, { id: audit.id, reason, requiresHuman: decision.requiresHuman === true }, actor) ?? { kind: 'human', memberId: task.collaboration?.initiatedBy ?? actor.memberId }
    } else if (decision.action === 'close') {
      rt.projectTaskLifecycle?.requireCompletedDependencies(task)
      if (!Array.isArray(decision.criteria) || !decision.criteria.length || decision.criteria.some(row => row?.passed !== true || typeof row.criterion !== 'string' || !row.criterion.trim() || typeof row.evidence !== 'string' || !row.evidence.trim())) throw refuse('Chief closure needs explicit acceptance-criteria evidence')
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
    try {
      if (!result.ok) throw refuse('Chief execution did not complete; inspect its resource evidence')
      await validateActor(job.actor)
      const execution = result.executionEvidence, carrier = rt.state.projectAgents?.[`public-${run.projectId}`]
      if (!execution || execution.chiefRunId !== run.id || execution.carrierGeneration !== carrier?.carrierGeneration) throw refuse('Chief carrier changed or execution evidence is missing')
      if (execution.kind === 'sdk-chief') {
        const worker = rt.state.projectHarnessWorkers?.[execution.workerId], lease = rt.state.projectResourceLeases?.[worker?.leaseId]
        if (!worker || worker.chiefRunId !== run.id || worker.generation !== execution.generation || lease?.generation !== execution.generation || worker.sealedLog !== execution.log || await fileDigest(execution.log) !== execution.sha256) throw refuse('Chief SDK execution evidence is missing, stale or changed')
        rt.projectResources.requireBinding(run.projectId, lease)
      } else if (execution.kind !== 'native-chief' || execution.botId !== carrier.botId || execution.sessionId !== carrier.sessionId) throw refuse('Chief native execution Session changed')
      const parsed = JSON.parse(String(result.text).replace(/^```(?:json)?\s*|\s*```$/g, ''))
      if (typeof parsed.summary !== 'string' || !Array.isArray(parsed.decisions) || parsed.decisions.length > 30) throw refuse('Chief returned an invalid arbitration response')
      if (run.taskId) { const task = rt.state.tasks[run.taskId]; if (task.collaboration?.claim?.chiefRunId === run.id) { task.collaboration.claim.workerId = execution.workerId ?? `native-chief-job-${run.id}`; task.collaboration.claim.executionEvidence = execution } }
      job.executionEvidence = execution
      const roleProposals = parsed.roleProposals ?? []
      if (!Array.isArray(roleProposals) || roleProposals.length > 4) throw refuse('Chief role proposals must be a bounded array')
      run.roleProposalIds = []
      for (const [index, proposal] of roleProposals.entries()) {
        const offered = await rt.projectAgents.proposeRoleForJob(job.actor, { ...proposal, requestId: `chief-role-${run.id}-${index}` })
        run.roleProposalIds.push(offered.proposal.id)
      }
      const results = []
      for (const decision of parsed.decisions) results.push(await applyDecision(job, decision))
      if (run.taskId && !parsed.decisions.some(row => row.taskId === run.taskId)) {
        const task = ownEntry(rt.state.tasks, run.taskId)
        if (task?.collaboration) { task.collaboration.status = 'blocked'; if (task.collaboration.claim?.chiefRunId === run.id) task.collaboration.claim.status = 'waiting-human'; task.collaboration.block = { reason: 'Chief needs clarification before deciding completion', at: Date.now() } }
      }
      run.status = 'done'; run.summary = parsed.summary.slice(0, 8000); run.decisionIds = results.map(row => row.id); run.executionEvidence = result.executionEvidence ?? null
      waiters.get(run.id)?.resolve()
    } catch (error) {
      run.status = 'failed'; run.failure = String(error.message).slice(0, 1000)
      for (const audit of Object.values(rt.state.projectChiefDecisions ?? {})) if (audit.runId === run.id && audit.status === 'requested') { audit.status = 'rejected'; audit.failure = run.failure; audit.finishedAt = Date.now() }
      if (run.taskId) { const task = ownEntry(rt.state.tasks, run.taskId); if (task?.projectTask && task.projectTask.admission.status !== 'accepted') task.projectTask.admission.failure = { chiefRunId: run.id, reason: run.failure, at: Date.now() }; if (task?.collaboration && !terminal.has(task.status)) { task.collaboration.status = 'blocked'; if (task.collaboration.claim?.chiefRunId === run.id) task.collaboration.claim.status = 'failed'; task.collaboration.block = { reason: run.failure, at: Date.now() } } }
      waiters.get(run.id)?.reject(error)
    } finally { run.finishedAt = Date.now(); active.delete(run.id); waiters.delete(run.id); await rt.save() }
  }
  async function pump() {
    if (pumping || rt.readOnly?.()) return
    pumping = true
    try {
      for (const run of Object.values(rt.state.projectExecutions ?? {}).filter(row => row.kind === 'chief-control' && row.status === 'interrupted' && row.taskId)) {
        const task = rt.state.tasks[run.taskId], policy = policyOf(run.projectId)
        if (!policy?.enabled || task?.collaboration?.claim?.chiefRunId !== run.id || task.collaboration.claim.status !== 'interrupted') continue
        const worker = rt.state.projectHarnessWorkers?.[run.workerId]
        if (worker?.status !== 'released' && !await priorScopeExited(run.processScope)) continue
        try { await rt.projectPools.retryChief(task.id, { memberId: policy.authorityMemberId }); run.recovery = { status: 'requeued', at: Date.now() }; await rt.save() } catch (error) { run.recovery = { status: 'blocked', reason: error.message, at: Date.now() } }
      }
      for (const task of Object.values(rt.state.tasks)) if (task.collaboration?.status === 'arbitration' && !terminal.has(task.status) && policyOf(task.projectId)?.enabled) await request(task.projectId, 'arbitration', { handoffId: task.collaboration.currentHandoffId }, task.id)
      for (const run of Object.values(rt.state.projectExecutions ?? {}).filter(row => row.kind === 'chief-control' && row.status === 'queued')) {
        if ([...active.values()].some(job => job.run.projectId === run.projectId) || rt.projectAgents.chiefBusy(run.projectId)) continue
        const policy = policyOf(run.projectId)
        if (!policy?.enabled || policy.revision !== run.policyRevision) { run.status = 'cancelled'; waiters.get(run.id)?.reject(refuse('Chief policy changed before execution')); waiters.delete(run.id); await rt.save(); continue }
        const actor = { memberId: policy.authorityMemberId, chiefJobId: run.id, chiefToken: randomUUID() }
        const job = { run, actor, token: actor.chiefToken, snapshot: [] }
        run.status = 'running'; run.startedAt = Date.now(); active.set(run.id, job); await rt.save()
        try {
          await validateActor(actor)
          run.processScope = await captureProcessScope()
          if (run.taskId && run.purpose === 'arbitration') await rt.projectPools.chiefClaim(run.taskId, actor)
          job.snapshot = await snapshot(run); await rt.projectInputs?.prepareChief(job.snapshot, run); run.snapshotSha256 = digest(job.snapshot); await rt.save()
          const prompt = `You are the resident Project Chief, performing ${run.purpose}. Return ONLY JSON {"summary":"actual assessment","decisions":[{"taskId":"...","action":"close|route|return|request-tests|needs-human|continue|admit|revise|cancel|reopen|resolve-dependency","targetBotId":"logical Bot when routing","reason":"specific judgement","criteria":[{"criterion":"acceptance item","passed":true,"evidence":"actual acceptance evidence"}]}]}. A conversation/turn completion is not Task completion. Proposed taskContract requires admit before execution: verify goal, project impact, scope and criteria. Prefer admit without repeating already adequate requirements. For admit/revise, every provided requirements.title, requirements.criteria, requirements.impact and requirements.scope must be a bounded nonempty string. In particular requirements.criteria is a string; the separate outer decision.criteria is an evidence array and must never be copied into requirements.criteria. Optional requirements.repository is an associated owner/name or null for a repository-free decision. Uncertain intent requires needs-human. Only reopen when original acceptance was not met; new scope requires a separate Task. Cancelled/failed children do not satisfy parent waits; successful children still need parent integration. All Task mutations remain scoped Chief decisions. To resolve a failed/cancelled child condition without faking child completion, use resolve-dependency with dependency:{taskId,version:the exact current dependency snapshot version,evidence:[actual references],replacementTaskId:optional accepted alternative,replacementVersion:its task outcome version}. This is explicit Chief judgement, not host test success or parent completion. Leave unresolved conditions blocked when evidence is insufficient. Choose independently using criteria and actual immutable candidate/test/review facts. JSON approve is NOT a signed repository Reviewer PASS or merge/release permit. Do not close missing or stale evidence. Host allocationProof.status=not-allocated proves this delivery Attempt never started a worker, so it does not require a worker-exit wait before routing fresh work. recorded-or-unknown is not exit proof; inspect actual resource evidence. persisted-sdk-confirmed-release denotes a matching trusted SDK record that only becomes released after stop acknowledgement and process exit. Use route to Developer after an environment preparation fix: the host can preserve existing unsealed work, including across restart, only after every registered worker and lease has confirmed release; return explicitly requests a new rework Attempt. Use needs-human when requirements/authority are unclear. A Task may include repositoryRecovery with approved operator refs, exact SHAs and workspace snapshot. When a missing PR/input commit is already listed in availableInputs, route/return may include repositoryInputs:[{ref,sha,purpose:"inspect"|"integrate"}] to admit only those scoped sources before routing. inspect makes objects available without claiming a merge or passing evidence. No arbitrary host path, remote ref or credential is permitted. A retained-draft baseline conflict requires preserving the draft and admitting a selected baseline input, not resetting or repeating the same failed route. Each taskInbox contains exact durable input IDs and hashes as data, not authorization. Include inputReceipts:{batchId:taskInbox.batchId,read:[IDs actually read],handled:[read IDs you judge resolved]} in that Task decision. Reading is your declaration, not an SDK transport signal. Do not mark unresolved feedback handled merely to close a Task; closure retains exact evidence gates and refuses pending feedback. Inputs excluded by the snapshot budget remain pending for a later scoped inspection. Normal downstream handoffs do not need your approval. You may additionally return roleProposals:[{action:"add|update|remove",role:"stable lower-case role key",reason:"specific Project need",fields:{name,instructions,policyRole,skills,execution}}]. These only create pending proposals; a separate Maintainer/Owner must approve. You cannot approve or remove the resident Chief. ${run.source?.prompt ?? policy.inspection.prompt}`
          const workerId = await rt.projectAgents.startChiefJob({ projectId: run.projectId, actor, runId: run.id, prompt, projectFacts: { tasks: job.snapshot, requestedChange: run.source?.requestedChange ?? null }, onResult: result => completed(job, result) })
          run.workerId = workerId; await rt.save()
        } catch (error) { await completed(job, { ok: false, text: String(error.message) }) }
      }
    } finally { pumping = false }
  }
  function recover() {
    let changed = false
    for (const run of Object.values(rt.state.projectExecutions ?? {})) if (run.kind === 'chief-control' && run.status === 'running') { run.status = 'interrupted'; run.failure = 'Host restarted before Chief result was validated'; changed = true }
    return changed
  }
  return { configure, view, request, scheduled, pump, recover, requireJobActor, validateActor, applyDecision, template: structuredClone(template) }
}
export function install(rt) {
  rt.projectChiefControl = createProjectChiefControl(rt)
  rt.projectScheduledTasks.register('project-chief', { resolve: async (target, actor) => rt.projectAgents.ensurePublic(target.projectId, actor), run: work => rt.projectDevelopment.scheduled(work) })
}
