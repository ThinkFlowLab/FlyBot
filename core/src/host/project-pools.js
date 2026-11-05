// Per-logical-Bot routing on existing Task records. Execution remains a host adapter.
import { protocolCorrection, freezeReceiptProposal, readReceiptProposal, receiptDigest } from './project-receipt-correction.js'
import { randomUUID, createHash } from 'node:crypto'
import { ownEntry } from './store.js'
import { initialRoleTarget } from './project-role-admission.js'
import { taskSessionId } from './project-task-sessions.js'
import { stageRoleSummary, rollbackRoleSummary, stageExecutionMemory, rollbackExecutionMemory, roleMemoryView } from './project-context-memory.js'
import { EffectDeferred, EffectCancelled } from './project-effects.js'
export const POOL_PROTOCOL = 'project-handoff/v1'
export function dispatchView(state, task, committed) {
  const effect = Object.values(state.projectEffects ?? {}).find(row => row.kind === 'pool.dispatch' && row.projectId === task.projectId && row.taskId === task.id && row.payload?.handoffId === task.collaboration?.currentHandoffId)
  if (!effect) return null
  return { effectId: effect.id, status: effect.status, generation: effect.generation, committed: committed ? committed({ id: effect.id, generation: effect.generation }) : null, executions: effect.executions ?? 0, failures: effect.failures ?? 0, waitingFor: effect.waitingFor ?? null, reason: effect.error ?? null, dueAt: effect.dueAt ?? null }
}

const refuse = message => Object.assign(new Error(message), { code: 'bot/handoff' })
const clone = value => structuredClone(value)
const intentHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const reasonOf = value => { if (typeof value !== 'string' || !value.trim() || value.length > 4000) throw refuse('A bounded handoff reason is required'); return value.trim() }


export const HANDOFF_CONTRACT = 'project-handoff-contract/v1'
function contextReference(state, task, role) {
  if (!role || role === 'chief') return null
  const logicalSessionId = taskSessionId(task.projectId, task.id, role)
  const logical = ownEntry(state.projectTaskSessions ?? {}, logicalSessionId)
  const sessions = Object.values(state.projectAttempts ?? {}).filter(attempt => attempt.projectId === task.projectId && attempt.taskId === task.id)
    .flatMap(attempt => [...(attempt.roleSessionHistory ?? []).filter(session => session.role === role), attempt.roleSessions?.[role]])
    .filter(session => session?.projectId === task.projectId && session.taskId === task.id && session.role === role)
    .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
  const session = sessions.at(-1)
  return { logicalSessionId: session?.logicalSessionId ?? logicalSessionId, sessionId: session?.id ?? null, workSummaryRef: logical?.workSummaryRef ? clone(logical.workSummaryRef) : null,
    definitionRef: session?.definitionRef ?? logical?.definitionRef ?? null, definitionRevision: session?.definitionRevision ?? null }
}
// A projection over the original durable receipt, not another workflow/store.
export function handoffContract(state, task, receipt) {
  if (!receipt || receipt.projectId !== task.projectId || receipt.taskId !== task.id) throw refuse('Unknown Task handoff')
  const roles = state.projectAgentDefinitions?.[task.projectId]?.roles ?? []
  const roleOf = id => roles.find(role => role.id === id)?.role ?? (typeof id === 'string' && id.startsWith(task.projectId + ':') ? id.slice(task.projectId.length + 1) : null)
  const sourceRole = roleOf(receipt.from), targetRole = roleOf(receipt.to)
  const previous = task.collaboration.history.find(row => row.id === receipt.predecessorId)
  const execution = receipt.sourceExecution ?? previous?.execution
  const successor = task.collaboration.history.find(row => row.predecessorId === receipt.id || row.requestId === receipt.execution?.id)
  const currentClaim = task.collaboration.currentHandoffId === receipt.id ? task.collaboration.claim : null
  const accepted = receipt.acceptance ?? (receipt.claimId ? { claimId: receipt.claimId, acceptedAt: receipt.acceptedAt, botId: receipt.to } : null)
  const status = receipt.status === 'completed' ? 'processed' : receipt.status === 'intervened' ? 'revoked' : receipt.status === 'rejected' ? 'invalidated' : receipt.finishedAt && receipt.decision ? 'processed' : receipt.status
  const context = receipt.contextRefs ?? { source: contextReference(state, task, sourceRole), target: contextReference(state, task, targetRole) }
  const events = [{ type: 'offered', at: receipt.createdAt }]
  if (accepted) events.push({ type: 'accepted', at: accepted.acceptedAt })
  if (receipt.finishedAt) events.push({ type: status, at: receipt.finishedAt })
  const ownsInitiative = status === 'accepted' && currentClaim?.status === 'active'
  const fenced = status === 'accepted' && currentClaim && !ownsInitiative && currentClaim.status !== 'completed'
  return { version: HANDOFF_CONTRACT, transportVersion: receipt.version, id: receipt.id, projectId: task.projectId, taskId: task.id,
    requestId: receipt.requestId, attemptId: receipt.attemptId, generation: receipt.generation, state: status, purpose: receipt.purpose,
    source: { botId: receipt.from, role: sourceRole, context: clone(context.source), execution: execution ? { claimId: execution.id, workerId: execution.workerId ?? null, generation: execution.generation, exitConfirmed: execution.exitConfirmed ?? null } : null },
    target: { botId: receipt.to, role: targetRole, context: clone(context.target) },
    summary: clone(receipt.summary ?? { completed: '', next: receipt.reason }), reason: receipt.reason, requirements: clone(receipt.requirements),
    evidence: clone(receipt.evidence ?? []), claims: clone(receipt.claims ?? []),
    acceptance: accepted ? { ...clone(accepted), workerId: receipt.execution?.workerId ?? currentClaim?.workerId ?? null } : null,
    initiative: { kind: status === 'pending' ? 'pool' : ownsInitiative ? 'execution' : fenced ? 'fenced' : 'relinquished', botId: status === 'pending' || ownsInitiative ? receipt.to : null },
    predecessorId: receipt.predecessorId ?? null, successorId: successor?.id ?? null,
    failure: !receipt.failure && currentClaim && task.collaboration.block ? { phase: 'recovery', reason: task.collaboration.block.reason } : receipt.failure ? { phase: receipt.execution?.failure ? 'execution-admission' : 'execution-or-evidence', reason: receipt.failure } : null, events }
}

export function createProjectPools(rt) {
  let adapter, acceptanceEffects, tail = Promise.resolve()
  let recovered = false
  const serial = fn => { const result = tail.then(fn, fn); tail = result.catch(() => {}); return result }
  function acceptanceAdapter() {
    if (rt.projectEffects && acceptanceEffects !== rt.projectEffects) {
      rt.projectEffects.register('pool.accept', { run: effect => ({ claimId: effect.payload.claimId, handoffId: effect.payload.handoffId, status: 'durable-acceptance' }) }, { replace: true })
      acceptanceEffects = rt.projectEffects
    }
  }
  rt.projectEffects?.register('pool.retire', { run: effect => ({ claimId: effect.payload.claimId, status: 'durable-exit-retirement' }) })
  acceptanceAdapter() // Register on restart even when no new claim has been made.
  const taskOf = id => { const task = ownEntry(rt.state.tasks, id); if (!task?.projectId) throw refuse('Unknown Project Task'); return task }
  const definitions = projectId => rt.projectAgents.deliveryDefinitions(projectId)
  const targetOf = (projectId, botId) => {
    const target = definitions(projectId).roles.find(role => role.id === botId)
    if (!target) throw refuse('Target logical Bot is not in this Project')
    return target
  }
  const sourceOf = (task, botId) => {
    const active = definitions(task.projectId).roles.find(row => row.id === botId)
    if (active) return active
    const claim = task.collaboration?.claim
    const retired = Object.values(rt.state.projectRetiredRoles ?? {}).find(row => row.projectId === task.projectId && row.id === botId)
    if (!retired || claim?.botId !== botId || !['active', 'completed', 'intervened'].includes(claim.status)) throw refuse('Source logical Bot has no retained execution claim')
    return { ...retired, role: claim.role ?? retired.role, policyRole: claim.policyRole ?? retired.policyRole ?? retired.role }
  }
  const dispatchIntent = (task, row) => rt.projectEffects?.stage({ kind: 'pool.dispatch', key: row.id, projectId: task.projectId, taskId: task.id,
    payload: { handoffId: row.id, botId: row.to, initiatedBy: row.initiatedBy } })
  async function authority(task) {
    const actor = { memberId: task.collaboration.initiatedBy }
    rt.requireProjectAccess(actor, task.projectId, 'task-write', task)
    await rt.projectDelegations?.background(actor.memberId, task.collaboration.sourceSessionId)
    rt.requireProjectAccess(actor, task.projectId, 'task-write', task)
    rt.projects.requireActive(task.projectId)
    return actor
  }
  async function current(task, token) {
    const claim = task.collaboration?.claim
    if (!claim || claim.id !== token?.id || claim.generation !== token?.generation || claim.botId !== token?.botId || claim.status !== 'active') throw refuse('Claim is stale or belongs to another Bot')
    if (claim.acceptanceEffect && !rt.projectEffects?.intentCommitted(claim.acceptanceEffect)) throw refuse('Claim acceptance has no confirmed durable intent')
    const requirementsRevision = claim.requirementsRevision ?? rt.state.projectAttempts?.[claim.attemptId]?.requirement?.projectTaskRevision
    const currentRequirements = () => !task.projectTask || requirementsRevision === undefined || requirementsRevision === task.projectTask.requirements.revision
    if (!currentRequirements()) throw refuse('Task requirements version changed before execution decision')
    await authority(task)
    if (task.collaboration.claim !== claim || claim.status !== 'active' || claim.generation !== token.generation) throw refuse('Claim was revoked during authority validation')
    if (!currentRequirements()) throw refuse('Task requirements version changed during authority validation')
    return claim
  }
  async function checkAdmission(task, { from, to, attemptId, requestId, purpose }) {
    if (!adapter) throw refuse('Handoff execution adapter is unavailable')
    const c = task.collaboration, target = targetOf(task.projectId, to)
    const fromRole = from ? sourceOf(task, from).role : ''
    // A privileged, audited Chief decision resolves a routing loop. Keep global
    // usage/history, but bound autonomous repetitions after that intervention.
    const epoch = c.history.findLastIndex(row => row.purpose === 'chief-intervention')
    const cycles = purpose === 'chief-intervention' ? 0 : c.history.slice(epoch + 1).filter(row => row.from === from && row.to === to).length
    const trustedEvidence = await adapter.evidence?.({ task, attemptId }) ?? []
    const acceptance = target.role === 'chief' ? undefined : task.poolAcceptance?.[target.role]
    const handoff = { card: task.id, fromRole, toRole: target.role, attempt: cycles, owner: c.initiatedBy, acceptance, evidence: trustedEvidence, idempotencyKey: requestId }
    const checked = adapter.validate(handoff, { roles: definitions(task.projectId).roles.map(row => row.role), pools: Object.fromEntries(definitions(task.projectId).roles.map(row => [row.role, { workers: 1 }])), execOwner: c.initiatedBy, seen: c.history.map(row => row.requestId), cycleMax: rt.config.projectHandoff?.cycleMax ?? 3, quota: rt.config.projectHandoff?.quota ?? {}, used: c.usage ?? {} })
    if (!checked.ok) throw refuse(`Handoff refused (${checked.code}): ${checked.reason}`)
    return { fromRole, trustedEvidence }
  }
  async function offer(task, { from, to, reason, requestId, attemptId, evidence = [], purpose = 'work', expectedGeneration, summary, experience, initialTarget }) {
    if (!adapter) throw refuse('Handoff execution adapter is unavailable')
    reason = reasonOf(reason)
    const c = task.collaboration, target = targetOf(task.projectId, to)
    if (typeof requestId !== 'string' || !/^[\w-]{1,120}$/.test(requestId)) throw refuse('A stable handoff requestId is required')
    const duplicate = c.history.find(row => row.requestId === requestId)
    if (duplicate) {
      if (duplicate.from !== from || duplicate.to !== to || duplicate.reason !== reason || duplicate.attemptId !== attemptId || duplicate.purpose !== purpose || summary && intentHash(duplicate.summary) !== intentHash(summary)) throw refuse('Handoff idempotency key was reused with different content')
      return clone(duplicate)
    }
    await authority(task)
    const { fromRole, trustedEvidence } = await checkAdmission(task, { from, to, attemptId, requestId, purpose })
    if (initialTarget) initialRoleTarget(rt, task, { initialTarget })
    if (expectedGeneration !== undefined && c.generation !== expectedGeneration) throw refuse('Claim generation changed before handoff admission')
    const row = { id: `handoff-${randomUUID()}`, version: POOL_PROTOCOL, policyVersion: 'project-role-policy/v1', definitionRevision: definitions(task.projectId).revision, projectId: task.projectId, taskId: task.id, attemptId, initiatedBy: c.initiatedBy, from, to, reason, requestId, purpose, evidence: clone(trustedEvidence), claims: clone(evidence), requirements: { title: task.title, criteria: task.criteria ?? '' }, status: 'pending', generation: c.generation + 1, createdAt: Date.now() }
    const sourceClaim = c.claim?.botId === from ? c.claim : null
    row.predecessorId = c.currentHandoffId ?? null
    row.summary = summary ?? { completed: '', next: reason }
    if (sourceClaim) row.sourceExecution = clone(sourceClaim)
    const workSummary = sourceClaim?.status === 'completed' && fromRole !== 'chief' && purpose !== 'children-completed' ? stageRoleSummary(rt.state, { task, claim: sourceClaim, role: fromRole, summary: row.summary, receiptId: row.id }) : null
    if (workSummary?.changed) row.workSummaryRef = clone(workSummary.logical.workSummaryRef)
    const learned = []
    if (experience !== undefined) {
      try {
        if (!sourceClaim || !Array.isArray(experience) || experience.length > 3) throw refuse('Role experience needs at most three scoped notes')
        for (const [index, note] of experience.entries()) learned.push(stageExecutionMemory(rt.state, { ...note, task, claim: sourceClaim, role: fromRole, requestId: `handoff-memory-${index}` }))
        row.memoryRefs = learned.map(candidate => ({ id: candidate.id, revision: candidate.row.revision, classification: candidate.row.classification }))
      } catch (error) {
        for (const candidate of learned.reverse()) rollbackExecutionMemory(rt.state, candidate)
        learned.length = 0
        row.memoryIssue = { code: error.code ?? 'bot/context-resume', reason: error.message, retainedPrevious: true }
      }
    }
    row.contextRefs = { source: contextReference(rt.state, task, fromRole), target: contextReference(rt.state, task, target.role) }
    await rt.projectScheduler?.captureWait?.(task)
    const before = rt.projectEffects ? { collaboration: clone(c), handoff: task.handoff, question: task.chiefQuestion } : null
    let input, intent
    try {
      input = rt.projectInputs?.stageHandoff(task, row)
      if (input) row.inputId = input.row.id
      intent = dispatchIntent(task, row)
    } catch (error) {
      if (input?.created) rt.projectInputs.discardHandoff(input.row.id)
      rollbackRoleSummary(rt.state, workSummary)
      for (const candidate of [...learned].reverse()) rollbackExecutionMemory(rt.state, candidate)
      throw error
    }
    c.generation = row.generation
    c.history.push(row); c.botId = to; c.status = target.role === 'chief' ? 'arbitration' : 'queued'; c.currentHandoffId = row.id; delete c.claim
    if (c.block) { row.resolvedBlock = clone(c.block); delete c.block }
    if (task.chiefQuestion) { row.resolvedChiefQuestion = clone(task.chiefQuestion); delete task.chiefQuestion }
    task.handoff = { from: fromRole || 'requester', to: target.role, reason, at: row.createdAt }
    try { if (intent) await rt.projectEffects.persist(intent); else await rt.save() }
    catch (error) {
      if (intent && rt.projectEffects.discardUncommitted(intent)) {
        rollbackRoleSummary(rt.state, workSummary)
        for (const candidate of [...learned].reverse()) rollbackExecutionMemory(rt.state, candidate)
        if (input?.created) rt.projectInputs.discardHandoff(input.row.id)
        for (const key of Object.keys(c)) delete c[key]
        Object.assign(c, before.collaboration)
        if (before.handoff === undefined) delete task.handoff; else task.handoff = before.handoff
        if (before.question === undefined) delete task.chiefQuestion; else task.chiefQuestion = before.question
      }
      throw error
    }
    rt.projectScheduler?.wake()
    return clone(row)
  }
  async function admit(attempt, actor, { targetRole, initialTarget, kind } = {}) {
    const task = taskOf(attempt.taskId)
    rt.projectTaskLifecycle?.requireExecutable(task)
    if (kind && task.projectTaskKind && kind !== task.projectTaskKind) throw refuse('Task kind cannot change at execution admission')
    kind ??= task.projectTaskKind ?? 'code'
    rt.requireProjectAccess(actor, task.projectId, 'task-write', task)
    const selected = initialRoleTarget(rt, task, { targetRole, initialTarget: initialTarget ?? attempt.initialTarget })
    targetRole = selected?.role ?? targetRole ?? 'developer'
    const target = definitions(task.projectId).roles.find(row => row.role === targetRole)
    if (!target || !['code', 'decision', 'release'].includes(kind)) throw refuse('Unsupported Task target or kind')
    task.collaboration ??= { version: POOL_PROTOCOL, initiatedBy: actor.memberId, generation: 0, history: [] }
    const c = task.collaboration
    if (c.claim?.status === 'active') throw refuse('Task still has an active execution claim')
    c.sourceSessionId = actor.sessionId ?? null
    c.initiatedBy = actor.memberId
    c.attemptId = attempt.id; c.kind = kind
    return offer(task, { from: null, to: target.id, reason: 'Authorized Task execution request', requestId: attempt.id, attemptId: attempt.id, initialTarget: selected })
  }
  async function claim(taskId, botId, handoffId, requestId, waiting) {
    const task = taskOf(taskId), c = task.collaboration
    if (requestId !== undefined) {
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(requestId) || typeof requestId !== 'string' || !handoffId) throw refuse('Accept needs a stable requestId and handoffId')
      await authority(task)
      const prior = c?.history.find(row => row.acceptance?.requestId === requestId)
      if (prior) {
        if (prior.acceptance.effect && !rt.projectEffects?.intentCommitted(prior.acceptance.effect)) throw refuse('Handoff acceptance is not durably committed')
        if (prior.id !== handoffId || prior.to !== botId) throw refuse('Accept idempotency key was reused for another handoff')
        const execution = prior.execution ?? (c.claim?.id === prior.claimId ? c.claim : null)
        return execution ? clone(execution) : { ...clone(prior.acceptance), id: prior.claimId, status: 'historical' }
      }
    }
    rt.projectTaskLifecycle?.requireExecutable(task)
    if (!c || c.botId !== botId || c.status !== 'queued' || handoffId && c.currentHandoffId !== handoffId) return null
    await authority(task)
    let definition = definitions(task.projectId).roles.find(row => row.id === botId)
    if (!definition) { c.status = 'blocked'; c.block = { reason: 'Target role is retired; Chief must explicitly select an active role', at: Date.now() }; await rt.save(); return null }
    const target = definition, expectedGeneration = c.generation
    if (target.role !== 'chief') {
      // Arbitration may observe a failed writer, but a downstream execution must
      // not bypass an unresolved old exit by selecting another resource.
      const unknown = c.history.flatMap(row => [row.execution, row.sourceExecution]).filter(row => row?.workerId && row.exitConfirmed === false)
      for (const execution of unknown) {
        let exited = false
        try { exited = await adapter.release(execution.workerId) } catch { /* Preserve unknown occupancy. */ }
        if (!exited) throw refuse('Source execution exit is unconfirmed; handoff remains pending')
        execution.exitConfirmed = true
      }
      await authority(task)
      if (c.generation !== expectedGeneration || c.status !== 'queued' || c.botId !== botId) throw refuse('Handoff changed during source-exit confirmation')
    }
    definition = definitions(task.projectId).roles.find(row => row.id === botId)
    if (!definition) { c.status = 'blocked'; c.block = { reason: 'Target role is retired; Chief must explicitly select an active role', at: Date.now() }; await rt.save(); return null }
    const holder = Object.values(rt.state.tasks).find(row => row.collaboration?.claim?.botId === botId && row.collaboration.claim.status === 'active')
    if (holder) { waiting?.('logical-role', `Logical Bot is held by Task ${holder.id}, claim ${holder.collaboration.claim.id}`); return null }
    if (adapter.ready && !await adapter.ready({ task, definition })) { waiting?.('execution-resource', 'Receiving execution resource is not ready'); return null }
    if (rt.projectScheduler?.admitPool && !await rt.projectScheduler.admitPool(task, definition)) { waiting?.('project-capacity', 'Project execution admission is waiting for capacity'); return null }
    await authority(task)
    if (c.generation !== expectedGeneration || c.status !== 'queued' || c.botId !== botId) return null
    const receipt = c.history.find(row => row.id === c.currentHandoffId)
    if (!receipt || receipt.status !== 'pending') throw refuse('Task has no pending handoff receipt')
    const limit = rt.config.projectHandoff?.quota?.steps
    if (Number.isFinite(limit) && (c.usage?.steps ?? 0) >= limit) { c.status = 'blocked'; c.block = { reason: 'Handoff refused (quota): execution step quota is exhausted', at: Date.now() }; await rt.save(); throw refuse(c.block.reason) }
    const claim = { id: `claim-${randomUUID()}`, botId, role: definition.role, policyRole: definition.policyRole ?? definition.role, ...(task.projectTask ? { requirementsRevision: task.projectTask.requirements.revision } : {}), generation: ++c.generation, taskId: task.id, projectId: task.projectId, attemptId: c.attemptId, status: 'active', createdAt: Date.now() }
    const before = { generation: expectedGeneration, status: c.status, claim: c.claim, usage: c.usage === undefined ? undefined : clone(c.usage), receipt: clone(receipt), wait: task.projectTask?.wait ? clone(task.projectTask.wait) : null }
    c.usage ??= {}; c.usage.steps = (c.usage.steps ?? 0) + 1
    if (receipt.purpose === 'children-completed' && task.projectTask?.wait?.status === 'queued') Object.assign(task.projectTask.wait, { status: 'resumed', resumedClaimId: claim.id, resumedAt: Date.now() })
    c.claim = claim; c.status = 'claimed'; receipt.status = 'accepted'; receipt.acceptedAt = Date.now(); receipt.claimId = claim.id
    receipt.acceptance = { claimId: claim.id, botId: claim.botId, generation: claim.generation, acceptedAt: receipt.acceptedAt, ...(requestId ? { requestId } : {}), ...(claim.chiefRunId ? { chiefRunId: claim.chiefRunId } : {}) }
    let intent
    try {
      if (rt.projectEffects) {
        acceptanceAdapter()
        intent = rt.projectEffects.stage({ kind: 'pool.accept', key: claim.id, projectId: task.projectId, taskId: task.id,
          payload: { claimId: claim.id, handoffId: receipt.id, attemptId: claim.attemptId, botId: claim.botId, generation: claim.generation } })
        claim.acceptanceEffect = intent
        receipt.acceptance.effect = intent
        await rt.projectEffects.persist(intent)
      } else await rt.save() // In-memory/legacy hosts without the durable Effects service.
    } catch (error) {
      const uncommitted = !intent || rt.projectEffects.discardUncommitted(intent)
      if (uncommitted && c.claim === claim && c.generation === claim.generation && c.currentHandoffId === receipt.id) {
        c.generation = before.generation; c.status = before.status
        if (before.claim === undefined) delete c.claim; else c.claim = before.claim
        if (before.usage === undefined) delete c.usage; else c.usage = before.usage
        for (const key of Object.keys(receipt)) delete receipt[key]
        Object.assign(receipt, before.receipt)
        if (before.wait) task.projectTask.wait = before.wait
      }
      throw error
    }
    return clone(claim)
  }
  async function decide(taskId, token, decision) {
    const task = taskOf(taskId), c = task.collaboration
    const prior = c?.history.find(row => row.execution?.id === token?.id)
    if (prior) {
      if (!prior.decision || prior.execution.status !== 'completed') throw refuse('Claim is stale or execution admission failed')
      await authority(task)
      if (prior.decision.intentHash !== intentHash(decision)) throw refuse('Execution decision idempotency key was reused with different content')
      return decision.action === 'split' && task.projectTask?.wait?.claimId === token.id ? { status: 'waiting-children', childTaskIds: task.projectTask.dependencies.map(row => row.taskId), wait: clone(task.projectTask.wait) } : clone(c.history.find(row => row.requestId === (decision.requestId ?? token.id)) ?? { status: 'blocked', reason: c.block?.reason })
    }
    const claim = await current(task, token)
    const action = decision?.action, reason = reasonOf(decision?.reason)
    if (!['handoff', 'return', 'transfer', 'complete', 'arbitrate', 'split'].includes(action)) throw refuse('Bot must hand off, return, transfer or request Chief judgement')
    const summary = { completed: decision.completed === undefined ? '' : reasonOf(decision.completed), next: decision.next === undefined ? reason : reasonOf(decision.next) }
    const role = sourceOf(task, claim.botId).role
    const children = action === 'split' ? rt.projectTaskLifecycle.prepareSplit(task, claim, decision) : null
    const next = action === 'split' ? null : ['complete', 'arbitrate'].includes(action) ? definitions(task.projectId).roles.find(row => row.role === 'chief') : targetOf(task.projectId, decision.to)
    if (!next && action !== 'split') throw refuse('Chief is not configured')
    await rt.projectInputs?.validateReceipt?.(task.id, claim, decision.inputReceipts)
    // Stop confirmation precedes relinquishing the claim and capacity.
    if (claim.workerId) {
      if (!await adapter.release(claim.workerId)) throw refuse('Worker exit is unconfirmed; claim and capacity remain held')
      claim.exitConfirmed = true
    }
    await current(task, token)
    if (action === 'handoff' || action === 'complete') await adapter.complete({ task, claim, role, outputs: decision.outputs ?? {} })
    await current(task, token)
    await rt.projectInputs?.acknowledge(task.id, claim, decision.inputReceipts)
    await current(task, token)
    rt.projectInputs?.finishHandoff(task.id, claim)
    if (claim.inputCorrection) claim.inputCorrection.status = 'resolved'
    claim.status = 'completed'; claim.decision = { action, reason, intentHash: intentHash(decision), at: Date.now() }
    const receipt = c.history.find(row => row.id === c.currentHandoffId)
    receipt.finishedAt = Date.now(); receipt.decision = clone(claim.decision); receipt.execution = clone(claim)
    c.usage ??= {}; c.usage.ms = (c.usage.ms ?? 0) + Date.now() - claim.createdAt
    const usage = rt.state.projectHarnessWorkers?.[claim.workerId]?.usage
    c.usage.tokens = (c.usage.tokens ?? 0) + (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0)
    if (action === 'split') return rt.projectTaskLifecycle.commitSplit(task, claim, { ...decision, summary, role }, children)
    if ((next.policyRole ?? next.role) === 'developer' && c.kind === 'code') c.attemptId = await adapter.rework?.({ task, claim, reason }) ?? c.attemptId
    try {
      return await offer(task, { from: claim.botId, to: next.id, reason, requestId: decision.requestId ?? claim.id, attemptId: c.attemptId, evidence: decision.evidence ?? [], purpose: action, expectedGeneration: claim.generation, summary, experience: decision.memory })
    } catch (error) {
      c.status = 'blocked'; c.block = { reason: error.message, at: Date.now() }; await rt.save(); throw error
    }
  }
  async function remember(taskId, token, body) {
    if (rt.readOnly?.() !== undefined) throw refuse('Role memory is read-only')
    const task = taskOf(taskId), claim = await current(task, token), role = targetOf(task.projectId, claim.botId).role
    const candidate = stageExecutionMemory(rt.state, { ...body, task, claim, role })
    let intent
    try {
      intent = rt.projectEffects?.stage({ kind: 'context.memory', key: `${claim.id}:${body.requestId}`, projectId: task.projectId, taskId, payload: { memoryId: candidate.id, revision: candidate.row.revision } })
      if (intent) await rt.projectEffects.persist(intent)
      else {
        const before = rt.savesQueued?.(), saved = rt.save(), queued = rt.savesQueued?.()
        await saved
        if (typeof before === 'number' && queued <= before) throw refuse('Role memory did not commit a state snapshot')
      }
    } catch (error) {
      if (!intent || rt.projectEffects.discardUncommitted(intent)) rollbackExecutionMemory(rt.state, candidate)
      throw error
    }
    return { memory: roleMemoryView(candidate.row), already: !candidate.changed, authority: 'none' }
  }
  function available(projectId, botId, actor) {
    rt.requireProjectAccess(actor, projectId); targetOf(projectId, botId)
    return Object.values(rt.state.tasks).filter(task => task.projectId === projectId && task.collaboration?.botId === botId && ['queued', 'arbitration'].includes(task.collaboration.status)).map(clone)
  }
  function get(taskId, handoffId, actor) {
    const task = taskOf(taskId)
    rt.requireProjectAccess(actor, task.projectId)
    return handoffContract(rt.state, task, task.collaboration?.history.find(row => row.id === handoffId))
  }
  function list(taskId, actor, { after, limit = 50 } = {}) {
    const task = taskOf(taskId)
    rt.requireProjectAccess(actor, task.projectId)
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw refuse('Invalid handoff page limit')
    const rows = task.collaboration?.history ?? []
    const index = after === undefined ? -1 : rows.findIndex(row => row.id === after)
    if (after !== undefined && index < 0) throw refuse('Unknown handoff cursor')
    const page = rows.slice(index + 1, index + 1 + limit)
    return { items: page.map(row => handoffContract(rt.state, task, row)), next: index + 1 + page.length < rows.length ? page.at(-1).id : null }
  }
  const owns = botId => Object.values(rt.state.tasks).some(task => task.collaboration?.claim?.workerId === botId || task.collaboration?.history.some(row => row.execution?.workerId === botId))
  async function feedback(task, token, decision, error, responseSha256 = receiptDigest(decision)) {
    const claim = await current(task, token), previous = claim.inputCorrection
    const proposal = previous?.proposal ?? await freezeReceiptProposal(rt, task, claim, decision)
    const correction = protocolCorrection(previous, { version: 'input-correction/v1', limit: previous?.limit ?? rt.config.projectHandoff?.inputCorrectionBudget ?? 2,
      feedback: { ...clone(error.receiptFeedback), receiptResponseSha256: responseSha256, at: Date.now(), proposalSha256: proposal.sha256, businessEffects: 'host completion, release and downstream handoff not applied; original model work preserved' } })
    correction.proposal = proposal; correction.originalResponseSha256 = previous?.originalResponseSha256 ?? receiptDigest(decision)
    claim.inputCorrection = correction
    let intent
    try {
      if (correction.status === 'pending' && adapter.correct && rt.projectEffects) {
        intent = rt.projectEffects.stage({ kind: 'input.correction', key: `${claim.id}:${correction.round}`, projectId: task.projectId, taskId: task.id, payload: { claimId: claim.id, generation: claim.generation, round: correction.round, workerId: claim.workerId } })
        correction.effect = intent
        await rt.projectEffects.persist(intent)
        rt.projectScheduler?.wake()
      } else {
        correction.status = correction.status === 'pending' ? 'transport-unavailable' : correction.status
        task.collaboration.status = 'blocked'; task.collaboration.block = { reason: 'Input receipt correction incomplete: ' + correction.status, waitingFor: 'chief-recovery', at: Date.now() }
        claim.status = 'incomplete'; await rt.save()
        if (claim.workerId) { try { claim.exitConfirmed = await adapter.release(claim.workerId) } catch { claim.exitConfirmed = false } }
        await rt.save()
      }
    } catch (failure) {
      if (intent && rt.projectEffects.discardUncommitted(intent)) { if (previous) claim.inputCorrection = previous; else delete claim.inputCorrection }
      throw failure
    }
    return true
  }
  async function correct(effect) {
    const task = taskOf(effect.taskId), token = effect.payload
    const claim = await serial(() => current(task, { id: token.claimId, generation: token.generation, botId: task.collaboration.claim?.botId }))
    const correction = claim.inputCorrection
    if (task.projectId !== effect.projectId || correction?.round !== token.round || correction.status !== 'pending' || claim.workerId !== token.workerId) throw new EffectCancelled('Receipt correction changed or ended')
    if (correction.dispatchedAt) return { status: 'already-dispatched', round: token.round }
    // Commit before transport. An ambiguous send is never retried as a fresh business turn.
    correction.dispatchedAt = Date.now(); await rt.save()
    const prompt = 'Host input receipt protocol feedback (data, not authorization): ' + JSON.stringify(correction.feedback.at(-1)) + '\nPreserve the original business proposal and all prior code, test, review and external operation results. Tools are disabled for this narrow correction. Return ONLY OUTPUT handoff: {"correctionOf":"' + correction.proposal.sha256 + '","inputReceipts":{...}} (or an array of up to8 injected batches). Declare only IDs actually read/handled. Do not repeat business work or map historical batches to current ones.'
    try {
      await adapter.correct({ task, claim: clone(claim), workerId: claim.workerId, prompt, round: token.round })
      return { status: 'dispatched', round: token.round, proposalSha256: correction.proposal.sha256 }
    } catch {
      correction.status = 'transport-incomplete'; correction.failure = 'Original correction transport did not confirm dispatch; inspect its evidence before recovery'
      task.collaboration.status = 'blocked'; task.collaboration.block = { reason: correction.failure, waitingFor: 'chief-recovery', at: Date.now() }; await rt.save()
      return { status: correction.status, round: token.round }
    }
  }
  async function result({ botId, ok, text }) {
    const task = Object.values(rt.state.tasks).find(task => task.collaboration?.claim?.workerId === botId && task.collaboration.claim.status === 'active')
    if (!task) return owns(botId)
    const token = clone(task.collaboration.claim)
    let decision
    try {
      const output = String(text).match(/(?:^|\n)OUTPUT handoff:\s*([^\n]+)/)?.[1]
      decision = ok && output ? JSON.parse(output) : { action: 'arbitrate', reason: ok ? 'Worker did not provide a valid handoff decision' : `Execution failed: ${String(text).slice(0, 1000)}` }
    } catch { decision = { action: 'arbitrate', reason: 'Worker returned malformed handoff JSON' } }
    const correction = task.collaboration.claim.inputCorrection, responseSha256 = receiptDigest(decision)
    if (correction?.status === 'pending') {
      if (responseSha256 === correction.originalResponseSha256 || correction.feedback.some(row => row.receiptResponseSha256 === responseSha256)) return true
      if (!ok || decision?.correctionOf !== correction.proposal.sha256 || Object.keys(decision).some(key => !['correctionOf', 'inputReceipts'].includes(key)) || decision.inputReceipts === undefined) {
        return feedback(task, token, decision, { receiptFeedback: { ...correction.feedback.at(-1), version: 'input-receipt-feedback/v1', kind: 'correction-schema', field: 'correctionOf/inputReceipts', correctable: true, message: 'Return only a receipt patch for the exact frozen proposal' } })
      }
      decision = { ...await readReceiptProposal(rt, task, token, correction.proposal), inputReceipts: decision.inputReceipts }
    }
    try { await decide(task.id, token, decision) }

    catch (error) {
      if (error.receiptFeedback?.correctable && task.collaboration.claim?.exitConfirmed !== true) return feedback(task, token, decision, error, responseSha256)
      const c = task.collaboration; c.status = 'blocked'; c.block = { reason: error.message, at: Date.now() }
      if (c.claim?.workerId) {
        c.claim.status = 'blocked'; ++c.generation
        try { c.claim.exitConfirmed = await adapter.release(c.claim.workerId) } catch { c.claim.exitConfirmed = false }
      }
      const receipt = c.history.find(row => row.id === c.currentHandoffId)
      if (receipt) { receipt.status = 'rejected'; receipt.failure = c.block.reason; receipt.finishedAt = Date.now(); receipt.execution = clone(c.claim ?? token) }
      await rt.save()
      try {
        await authority(task)
        if (c.claim?.exitConfirmed !== false) await offer(task, { from: token.botId, to: `${task.projectId}:chief`, reason: `Host execution/evidence gate failed: ${c.block.reason}`, requestId: `gate-${token.id}`, attemptId: c.attemptId, purpose: 'arbitrate' })
      } catch {
        if (rt.state.projectChiefPolicies?.[task.projectId]?.enabled) void rt.projectChiefControl.request(task.projectId, 'inspection', { blockedTaskId: task.id, reason: c.block.reason, requestId: token.id }).catch(error => rt.warn('Chief fallback admission failed: %s', error.message))
      }
    }
    return true
  }
  async function pump(taskId, handoffId) {
    if (!adapter && taskId) throw new EffectDeferred('Pool execution adapter is unavailable', { waitingFor: 'execution-adapter' })
    if (!adapter || rt.readOnly?.()) return
    const offered = Object.values(rt.state.tasks).filter(task => (!taskId || task.id === taskId) && (!handoffId || task.collaboration?.currentHandoffId === handoffId) && task.collaboration?.status === 'queued')
    for (const task of offered) {
      let token, wait
      try { token = await serial(() => claim(task.id, task.collaboration.botId, handoffId, undefined, (kind, reason) => { wait = { kind, reason } })) }
      catch (error) {
        rt.warn?.('Bot pool claim refused: %s', error.message)
        if (taskId) { if (error.code?.startsWith('bot/')) throw new EffectDeferred(error.message.slice(0, 500), { waitingFor: 'pool-admission' }); throw error }
        continue
      }
      if (!token) { if (taskId && wait) throw new EffectDeferred(wait.reason, { waitingFor: wait.kind }); continue }
      try {
        const workerId = await adapter.execute({ task, claim: token, definition: targetOf(task.projectId, token.botId) })
        await serial(async () => {
          const claim = await current(task, token); claim.workerId = workerId
          const receipt = task.collaboration.history.find(row => row.id === task.collaboration.currentHandoffId)
          if (receipt?.acceptance?.claimId === claim.id) Object.assign(receipt.acceptance, { workerId, boundAt: Date.now(), context: contextReference(rt.state, task, targetOf(task.projectId, claim.botId).role) })
          await rt.save()
        })
        await adapter.dispatch({ task, claim: token, workerId })
      } catch (error) {
        let failedClaim
        const reason = `Execution admission failed: ${String(error.message).slice(0, 1000)}`
        await serial(async () => {
          const c = task.collaboration
          if (c.claim?.id !== token.id) return
          failedClaim = c.claim; failedClaim.status = 'failed'; failedClaim.failure = reason;
          if (error.code === 'bot/context-resume') failedClaim.contextFailure = { code: error.code, kind: ['incompatible-execution-binding', 'continuation-source-unavailable'].includes(error.details?.kind) ? error.details.kind : 'context-resume-refused', contextPreserved: true, attemptId: failedClaim.attemptId, claimId: failedClaim.id, generation: failedClaim.generation }; ++c.generation
          c.status = 'blocked'; c.block = { reason, at: Date.now() }; await rt.save()
        })
        if (!failedClaim) continue
        failedClaim.exitConfirmed = false
        if (failedClaim.workerId) { try { failedClaim.exitConfirmed = await adapter.release(failedClaim.workerId) } catch { failedClaim.exitConfirmed = false } }
        else if (adapter.abort) { try { failedClaim.exitConfirmed = await adapter.abort({ task, claim: failedClaim, reason }) } catch { /* Retain unconfirmed preparation occupancy. */ } }
        await serial(async () => {
          const c = task.collaboration
          if (c.claim?.id !== token.id) return
          const receipt = c.history.find(row => row.id === c.currentHandoffId)
          if (receipt) { receipt.status = 'rejected'; receipt.finishedAt = Date.now(); receipt.failure = reason; receipt.execution = clone(failedClaim) }
          await rt.save()
          try { await offer(task, { from: failedClaim.botId, to: `${task.projectId}:chief`, reason, requestId: `admission-${failedClaim.id}`, attemptId: c.attemptId, purpose: 'arbitrate' }) }
          catch { /* Preserve the block and unknown capacity when authority itself is unavailable. */ }
        })
      }
    }
  }
  async function retireExited(taskId, body, actor, verify) {
    const task = taskOf(taskId), c = task.collaboration, claim = c?.claim
    if (rt.readOnly?.() !== undefined) throw refuse('Execution retirement requires a writable host')
    rt.requireProjectAccess(actor, task.projectId, 'configure', task)
    rt.projects.requireActive(task.projectId)
    if (claim?.id === body.claimId && claim.retirement && rt.projectEffects?.intentCommitted(claim.retirement.effect) && [c.generation, claim.retirement.previousGeneration].includes(body.generation)) return { retirement: clone(claim.retirement), generation: c.generation }
    if (!claim || claim.id !== body.claimId || c.generation !== body.generation || !['active', 'interrupted', 'blocked', 'waiting-human'].includes(claim.status)) throw refuse('Execution retirement snapshot is stale')
    reasonOf(body.reason)
    const proof = await verify(task, claim)
    rt.requireProjectAccess(actor, task.projectId, 'configure', task)
    rt.projects.requireActive(task.projectId)
    if (task.collaboration !== c || c.claim !== claim || c.generation !== body.generation || claim.id !== body.claimId) throw refuse('Execution retirement snapshot changed during validation')
    const previous = clone(c), receipt = c.history.find(row => row.id === c.currentHandoffId)
    if (!rt.projectEffects) throw refuse('Execution retirement requires durable Effects')
    const token = rt.projectEffects.stage({ kind: 'pool.retire', key: claim.id, projectId: task.projectId, taskId, payload: { claimId: claim.id, generation: claim.generation, proof } })
    claim.status = 'interrupted'; claim.exitConfirmed = true
    claim.retirement = { claimId: claim.id, generation: claim.generation, previousGeneration: body.generation, by: actor.memberId, reason: body.reason, proof, effect: token, at: Date.now() }
    ++c.generation; c.status = 'blocked'
    if (receipt) { receipt.status = 'interrupted'; receipt.finishedAt = Date.now(); receipt.execution = clone(claim) }
    try { await rt.projectEffects.persist(token) }
    catch (error) {
      if (rt.projectEffects.discardUncommitted(token) && c.claim === claim && c.generation === body.generation + 1) {
        for (const key of Object.keys(c)) delete c[key]
        Object.assign(c, previous)
      }
      throw error
    }
    return { retirement: clone(claim.retirement), generation: c.generation }
  }
  async function revokeExecution(taskId, claimId, reason) {
    const task = taskOf(taskId), c = task.collaboration
    if (!c || c.claim?.id !== claimId || c.claim.status !== 'active') return false
    const claim = c.claim
    c.status = 'blocked'; ++c.generation; c.block = { reason, at: Date.now() }
    claim.status = 'revoked'
    await rt.save()
    if (claim.workerId) { try { claim.exitConfirmed = await adapter.release(claim.workerId) } catch { claim.exitConfirmed = false } }
    await rt.save()
    return true
  }
  async function revokePrincipal(projectId, memberId) {
    for (const task of Object.values(rt.state.tasks)) {
      const c = task.collaboration
      if (task.projectId !== projectId || c?.initiatedBy !== memberId || !['queued', 'claimed'].includes(c.status)) continue
      if (c.claim?.status === 'active') await revokeExecution(task.id, c.claim.id, 'Initiating human authority was revoked')
      else { c.status = 'blocked'; ++c.generation; c.block = { reason: 'Initiating human authority was revoked', at: Date.now() }; await rt.save() }
    }
  }
  async function validateClosure(taskId, actor, evidence) {
    const task = taskOf(taskId)
    rt.projectInputs?.requireHandled(taskId, actor)
    rt.projectChiefControl.requireJobActor(actor, task.projectId)
    const roles = definitions(task.projectId).roles
    const result = adapter.validate({ card: task.id, fromRole: 'chief', toRole: 'chief', attempt: 0, owner: actor.memberId, acceptance: task.acceptance, evidence }, { roles: roles.map(row => row.role), pools: Object.fromEntries(roles.map(row => [row.role, { workers: 1 }])), execOwner: actor.memberId, seen: new Set() })
    if (!result.ok) throw refuse(`Chief completion gate refused (${result.code}): ${result.reason}`)
  }
  async function retryChief(taskId, actor) {
    const task = taskOf(taskId), c = task.collaboration
    rt.requireProjectAccess(actor, task.projectId, 'configure')
    await rt.projectDelegations.background(actor.memberId)
    if (c?.claim?.botId !== `${task.projectId}:chief` || c.claim.status !== 'interrupted') throw refuse('Chief retry has no interrupted Chief claim')
    const receipt = c.history.find(row => row.id === c.currentHandoffId)
    if (receipt) { receipt.status = 'interrupted'; receipt.finishedAt = Date.now(); receipt.execution = clone(c.claim) }
    c.initiatedBy = actor.memberId; c.sourceSessionId = null
    return offer(task, { from: `${task.projectId}:chief`, to: `${task.projectId}:chief`, reason: 'Retry Chief judgement after confirmed previous host invocation exit', requestId: `recovery-${randomUUID()}`, attemptId: c.attemptId, purpose: 'arbitrate' })
  }
  async function chiefClaim(taskId, actor) {
    const task = taskOf(taskId), c = task.collaboration
    rt.projectChiefControl.requireJobActor(actor, task.projectId)
    rt.requireProjectAccess(actor, task.projectId, 'accept')
    if (!c || c.status !== 'arbitration' || c.botId !== `${task.projectId}:chief`) throw refuse('Task is not waiting in the Chief pool')
    const receipt = c.history.find(row => row.id === c.currentHandoffId)
    if (!receipt || receipt.status !== 'pending') throw refuse('Chief handoff receipt is stale')
    const claim = { id: `chief-claim-${randomUUID()}`, taskId, projectId: task.projectId, attemptId: c.attemptId, botId: c.botId, chiefRunId: actor.chiefJobId, generation: ++c.generation, status: 'active', createdAt: Date.now() }
    c.claim = claim; c.status = 'chief-working'; receipt.status = 'accepted'; receipt.acceptedAt = Date.now(); receipt.claimId = claim.id
    receipt.acceptance = { claimId: claim.id, botId: claim.botId, generation: claim.generation, acceptedAt: receipt.acceptedAt, ...(claim.chiefRunId ? { chiefRunId: claim.chiefRunId } : {}) }
    await rt.save(); return clone(claim)
  }
  async function validateChiefRoute(body, actor) {
    const task = taskOf(body.taskId), c = task.collaboration
    rt.projectChiefControl.requireJobActor(actor, task.projectId)
    rt.requireProjectAccess(actor, task.projectId, 'run-control')
    if (!c || c.generation !== body.expectedGeneration) throw refuse('Chief routing snapshot is stale')
    const target = targetOf(task.projectId, body.targetBotId)
    await authority(task)
    await adapter?.validateRecovery?.({ task, target })
    if (c.generation !== body.expectedGeneration) throw refuse('Chief routing snapshot is stale')
    return target
  }
  async function chiefRoute(body, actor) {
    const task = taskOf(body.taskId), c = task.collaboration
    rt.projectChiefControl.requireJobActor(actor, task.projectId)
    rt.requireProjectAccess(actor, task.projectId, 'run-control')
    if (!c || c.generation !== body.expectedGeneration) throw refuse('Chief routing snapshot is stale')
    const target = targetOf(task.projectId, body.targetBotId)
    if (target.role === 'chief') throw refuse('Chief must decide a concrete next role or request human clarification')
    reasonOf(body.reason)
    await validateChiefRoute(body, actor)
    await authority(task)
    await checkAdmission(task, { from: `${task.projectId}:chief`, to: target.id, attemptId: c.attemptId, requestId: body.decisionId, purpose: 'chief-intervention' })
    if (c.generation !== body.expectedGeneration) throw refuse('Chief routing snapshot is stale')
    const oldClaim = c.claim
    ++c.generation
    if (oldClaim) oldClaim.status = 'intervened'
    c.status = 'stopping'; await rt.save()
    if (oldClaim?.workerId && sourceOf(task, oldClaim.botId).role !== 'chief') {
      let stopped = false
      try { stopped = await adapter.release(oldClaim.workerId) } catch { /* retain unknown worker capacity */ }
      oldClaim.exitConfirmed = stopped
      if (!stopped) { c.status = 'blocked'; c.block = { reason: 'Chief intervention is waiting for confirmed worker exit', decisionId: body.decisionId, at: Date.now() }; await rt.save(); throw refuse(c.block.reason) }
    }
    try {
      await rt.projectChiefControl.validateActor(actor)
      const currentReceipt = c.history.find(row => row.id === c.currentHandoffId)
      if (currentReceipt) { currentReceipt.status = 'intervened'; currentReceipt.finishedAt = Date.now(); if (oldClaim) currentReceipt.execution = clone(oldClaim); currentReceipt.chiefDecisionId = body.decisionId }
      c.initiatedBy = actor.memberId; c.sourceSessionId = null
      const previous = rt.state.projectAttempts?.[c.attemptId]
      if ((target.policyRole ?? target.role) === 'developer') c.attemptId = await adapter.rework({ task, claim: oldClaim ?? { attemptId: c.attemptId, id: body.decisionId, botId: `${task.projectId}:chief` }, reason: body.reason, force: body.rework !== false, decisionId: body.decisionId })
      else if (previous && previous.status !== 'running') {
        if (!adapter.resumeVerification) throw refuse('Interrupted delivery requires an evidence-supported recovery adapter')
        await adapter.resumeVerification({ task, target, decisionId: body.decisionId, reason: body.reason })
      }
      return await offer(task, { from: `${task.projectId}:chief`, to: target.id, reason: body.reason, requestId: body.decisionId, attemptId: c.attemptId, purpose: 'chief-intervention' })
    } catch (error) {
      c.status = 'blocked'; c.block = { reason: String(error.message), decisionId: body.decisionId, at: Date.now() }; await rt.save(); throw error
    }
  }
  async function resumeChildren(taskId, waitId) {
    const task = taskOf(taskId), c = task.collaboration, wait = task.projectTask?.wait
    if (!wait || wait.id !== waitId) throw refuse('Parent continuation changed')
    const requestId = `children-${wait.id}`
    const prior = c.history.find(row => row.requestId === requestId)
    if (prior) return clone(prior)
    await authority(task)
    if (c.status !== 'waiting-children' || c.claim?.id !== wait.claimId || c.claim.status !== 'completed' || c.claim.workerId && !c.claim.exitConfirmed) throw refuse('Parent continuation is not released')
    const ready = rt.projectTaskLifecycle.ready(task)
    if (!ready) throw new EffectDeferred('Child results are not yet adjudicated', { waitingFor: 'children' })
    // A sealed pre-split candidate is immutable. Continue in a successor Attempt,
    // preserving the Task-role Session rather than editing accepted evidence.
    if ((targetOf(task.projectId, wait.botId).policyRole ?? targetOf(task.projectId, wait.botId).role) === 'developer' && c.kind === 'code') {
      const existing = rt.state.projectAttempts?.[task.deliveryAttemptId]
      if (existing && existing.id !== c.attemptId && existing.feedback?.previousAttemptId === c.attemptId && rt.state.projectAttempts[c.attemptId]?.supersededBy === existing.id) c.attemptId = existing.id
      else c.attemptId = await adapter.rework?.({ task, claim: c.claim, reason: `Integrate adjudicated child results: ${wait.resumePoint}` }) ?? c.attemptId
    }
    await rt.projectScheduler?.captureWait?.(task, { kind: 'children', id: wait.id })
    const previous = wait.status
    wait.status = 'queued'
    try {
      return await offer(task, { from: wait.botId, to: wait.botId, reason: `Resume parent integration: ${wait.resumePoint}`, requestId, attemptId: c.attemptId, purpose: 'children-completed',
        summary: { completed: 'Child results are available; integration and parent acceptance remain pending.', next: wait.resumePoint } })
    } catch (error) { if (!c.history.some(row => row.requestId === requestId)) wait.status = previous; throw error }
  }
  function recover() {
    if (recovered || rt.readOnly?.()) return false
    recovered = true
    let changed = false
    for (const task of Object.values(rt.state.tasks)) {
      const c = task.collaboration
      if (!c?.claim || c.claim.status !== 'active') continue
      if (c.claim.inputCorrection?.status === 'pending') c.claim.inputCorrection.status = 'interrupted'
      c.status = 'blocked'; c.claim.status = 'interrupted'; c.block = { reason: 'Host restarted; worker exit and resources must be reconciled before reassigning', at: Date.now() }; ++c.generation; changed = true
    }
    if (rt.projectEffects) {
      const count = Object.keys(rt.state.projectEffects ?? {}).length
      for (const task of Object.values(rt.state.tasks)) {
        const c = task.collaboration
        if (task.projectTask?.admission.status !== 'accepted' && task.projectTask && !['accepted', 'cancelled'].includes(task.status)) rt.projectTaskLifecycle.stageIntake(task)
        if (task.projectTask?.parentTaskId) rt.projectTaskLifecycle.stageDependencyResume(task)
        if (!['queued', 'arbitration'].includes(c?.status)) continue
        const receipt = c.history?.find(row => row.id === c.currentHandoffId)
        if (receipt?.status === 'pending') {
          if (rt.projectInputs && !receipt.inputId) { receipt.inputId = rt.projectInputs.stageHandoff(task, receipt).row.id; changed = true }
          dispatchIntent(task, receipt)
        }
      }
      if (Object.keys(rt.state.projectEffects ?? {}).length !== count) changed = true
    }
    return changed
  }
  return { connect(value) { adapter = value; return () => { if (adapter === value) adapter = null } }, get, list, accept: (taskId, botId, handoffId, requestId) => serial(() => claim(taskId, botId, handoffId, requestId)), admit: (attempt, actor, body) => serial(() => admit(attempt, actor, body)), available, owns,
    correct, retireExited: (id, body, actor, verify) => serial(() => retireExited(id, body, actor, verify)),
    resumeChildren: (id, waitId) => serial(() => resumeChildren(id, waitId)),
    claim: (id, botId) => serial(() => claim(id, botId)), remember: (id, token, body) => serial(() => remember(id, token, body)), decide: (id, token, decision) => serial(() => decide(id, token, decision)), result: row => serial(() => result(row)), pump, recover, revokePrincipal: (projectId, memberId) => serial(() => revokePrincipal(projectId, memberId)), revokeExecution: (id, claimId, reason) => serial(() => revokeExecution(id, claimId, reason)), validateClosure, retryChief: (id, actor) => serial(() => retryChief(id, actor)), chiefClaim: (id, actor) => serial(() => chiefClaim(id, actor)), validateChiefRoute: (body, actor) => serial(() => validateChiefRoute(body, actor)), chiefRoute: (body, actor) => serial(() => chiefRoute(body, actor)) }
}
export function install(rt) {
  rt.projectPools = createProjectPools(rt)
  rt.ctx?.tools?.guard?.(exec => {
    const sessionId = exec?.agent?.session?.id ?? exec?.agent?.id
    const bot = rt.botOf(rt.selfOf(sessionId) ?? sessionId)
    if (!bot) return undefined
    const task = Object.values(rt.state.tasks).find(task => task.collaboration?.claim?.workerId === bot.id && task.collaboration?.claim?.inputCorrection && task.collaboration.claim.inputCorrection.status !== 'resolved')
    return task ? 'Input receipt correction permits only a declaration patch; business tools are disabled' : undefined
  })
  rt.projectEffects?.register('input.correction', { run: effect => rt.projectPools.correct(effect) })
  rt.projectEffects?.register('context.memory', { run: effect => ({ ...effect.payload, status: 'memory-version-committed' }) })
  rt.projectEffects?.register('pool.dispatch', {
    async validate(effect, context) {
      const task = ownEntry(rt.state.tasks, effect.taskId), c = task?.collaboration
      if (!task || task.projectId !== effect.projectId || c?.currentHandoffId !== effect.payload.handoffId || ['accepted', 'cancelled'].includes(task.status) || !['queued', 'arbitration', 'chief-working', 'claimed'].includes(c.status)) throw new EffectCancelled('Task ended, changed handoff or needs Chief recovery')
      try {
        await rt.projectDelegations?.background(effect.payload.initiatedBy, c.sourceSessionId)
        context.assertCurrent()
        rt.requireProjectAccess({ memberId: effect.payload.initiatedBy }, task.projectId, 'task-write', task)
        if (task.collaboration.currentHandoffId !== effect.payload.handoffId) throw new EffectCancelled('Handoff changed during authority validation')
      } catch (error) { throw new EffectCancelled(error instanceof EffectCancelled ? error.message : 'Initiating authority is unavailable or revoked') }
    },
    async run(effect) {
      const task = ownEntry(rt.state.tasks, effect.taskId)
      if (task.collaboration.currentHandoffId !== effect.payload.handoffId) throw new EffectCancelled('Handoff changed before dispatch')
      if (task.collaboration.status === 'arbitration') {
        await rt.projectChiefControl.pump()
        if (task.collaboration.status === 'arbitration') throw new EffectDeferred('Chief is disabled or busy')
      } else await rt.projectPools.pump(task.id, effect.payload.handoffId)
      const c = task.collaboration
      if (c.currentHandoffId === effect.payload.handoffId && c.status === 'queued') throw new EffectDeferred('Receiving Bot or execution resource is busy')
      const receipt = c.history.find(row => row.id === effect.payload.handoffId)
      return { handoffId: effect.payload.handoffId, claimId: receipt?.claimId ?? null, workerId: receipt?.execution?.workerId ?? (c.currentHandoffId === effect.payload.handoffId ? c.claim?.workerId ?? null : null), status: 'dispatch-observed' }
    },
  })
}
