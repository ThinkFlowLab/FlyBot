// Per-logical-Bot routing on existing Task records. Execution remains a host adapter.
import { randomUUID, createHash } from 'node:crypto'
import { ownEntry } from './store.js'
import { EffectDeferred, EffectCancelled } from './project-effects.js'
export const POOL_PROTOCOL = 'project-handoff/v1'
const refuse = message => Object.assign(new Error(message), { code: 'bot/handoff' })
const clone = value => structuredClone(value)
const intentHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const reasonOf = value => { if (typeof value !== 'string' || !value.trim() || value.length > 4000) throw refuse('A bounded handoff reason is required'); return value.trim() }

export function createProjectPools(rt) {
  let adapter, tail = Promise.resolve()
  let recovered = false
  const serial = fn => { const result = tail.then(fn, fn); tail = result.catch(() => {}); return result }
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
    await authority(task)
    if (task.collaboration.claim !== claim || claim.status !== 'active' || claim.generation !== token.generation) throw refuse('Claim was revoked during authority validation')
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
  async function offer(task, { from, to, reason, requestId, attemptId, evidence = [], purpose = 'work', expectedGeneration }) {
    if (!adapter) throw refuse('Handoff execution adapter is unavailable')
    reason = reasonOf(reason)
    const c = task.collaboration, target = targetOf(task.projectId, to)
    if (typeof requestId !== 'string' || !/^[\w-]{1,120}$/.test(requestId)) throw refuse('A stable handoff requestId is required')
    const duplicate = c.history.find(row => row.requestId === requestId)
    if (duplicate) {
      if (duplicate.from !== from || duplicate.to !== to || duplicate.reason !== reason) throw refuse('Handoff idempotency key was reused with different content')
      return clone(duplicate)
    }
    await authority(task)
    const { fromRole, trustedEvidence } = await checkAdmission(task, { from, to, attemptId, requestId, purpose })
    if (expectedGeneration !== undefined && c.generation !== expectedGeneration) throw refuse('Claim generation changed before handoff admission')
    const row = { id: `handoff-${randomUUID()}`, version: POOL_PROTOCOL, policyVersion: 'project-role-policy/v1', definitionRevision: definitions(task.projectId).revision, projectId: task.projectId, taskId: task.id, attemptId, initiatedBy: c.initiatedBy, from, to, reason, requestId, purpose, evidence: clone(trustedEvidence), claims: clone(evidence), requirements: { title: task.title, criteria: task.criteria ?? '' }, status: 'pending', generation: c.generation + 1, createdAt: Date.now() }
    const before = rt.projectEffects ? { collaboration: clone(c), handoff: task.handoff, question: task.chiefQuestion } : null
    const input = rt.projectInputs?.stageHandoff(task, row)
    if (input) row.inputId = input.row.id
    let intent
    try { intent = dispatchIntent(task, row) }
    catch (error) { if (input?.created) rt.projectInputs.discardHandoff(input.row.id); throw error }
    c.generation = row.generation
    c.history.push(row); c.botId = to; c.status = target.role === 'chief' ? 'arbitration' : 'queued'; c.currentHandoffId = row.id; delete c.claim
    if (c.block) { row.resolvedBlock = clone(c.block); delete c.block }
    if (task.chiefQuestion) { row.resolvedChiefQuestion = clone(task.chiefQuestion); delete task.chiefQuestion }
    task.handoff = { from: fromRole || 'requester', to: target.role, reason, at: row.createdAt }
    try { if (intent) await rt.projectEffects.persist(intent); else await rt.save() }
    catch (error) {
      if (intent && rt.projectEffects.discardUncommitted(intent)) {
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
  async function admit(attempt, actor, { targetRole = 'developer', kind } = {}) {
    const task = taskOf(attempt.taskId)
    if (kind && task.projectTaskKind && kind !== task.projectTaskKind) throw refuse('Task kind cannot change at execution admission')
    kind ??= task.projectTaskKind ?? 'code'
    rt.requireProjectAccess(actor, task.projectId, 'task-write', task)
    const target = definitions(task.projectId).roles.find(row => row.role === targetRole)
    if (!target || !['code', 'decision', 'release'].includes(kind)) throw refuse('Unsupported Task target or kind')
    task.collaboration ??= { version: POOL_PROTOCOL, initiatedBy: actor.memberId, generation: 0, history: [] }
    const c = task.collaboration
    if (c.claim?.status === 'active') throw refuse('Task still has an active execution claim')
    c.sourceSessionId = actor.sessionId ?? null
    c.initiatedBy = actor.memberId
    c.attemptId = attempt.id; c.kind = kind
    return offer(task, { from: null, to: target.id, reason: 'Authorized Task execution request', requestId: attempt.id, attemptId: attempt.id })
  }
  async function claim(taskId, botId, handoffId) {
    const task = taskOf(taskId), c = task.collaboration
    if (!c || c.botId !== botId || c.status !== 'queued' || handoffId && c.currentHandoffId !== handoffId) return null
    await authority(task)
    const definition = definitions(task.projectId).roles.find(row => row.id === botId)
    if (!definition) { c.status = 'blocked'; c.block = { reason: 'Target role is retired; Chief must explicitly select an active role', at: Date.now() }; await rt.save(); return null }
    if (Object.values(rt.state.tasks).some(row => row.collaboration?.claim?.botId === botId && row.collaboration.claim.status === 'active')) return null
    if (adapter.ready && !adapter.ready({ task, definition })) return null
    const receipt = c.history.find(row => row.id === c.currentHandoffId)
    if (!receipt || receipt.status !== 'pending') throw refuse('Task has no pending handoff receipt')
    const limit = rt.config.projectHandoff?.quota?.steps
    if (Number.isFinite(limit) && (c.usage?.steps ?? 0) >= limit) { c.status = 'blocked'; c.block = { reason: 'Handoff refused (quota): execution step quota is exhausted', at: Date.now() }; await rt.save(); throw refuse(c.block.reason) }
    const claim = { id: `claim-${randomUUID()}`, botId, role: definition.role, policyRole: definition.policyRole ?? definition.role, generation: ++c.generation, taskId: task.id, projectId: task.projectId, attemptId: c.attemptId, status: 'active', createdAt: Date.now() }
    c.usage ??= {}; c.usage.steps = (c.usage.steps ?? 0) + 1
    c.claim = claim; c.status = 'claimed'; receipt.status = 'accepted'; receipt.acceptedAt = Date.now(); receipt.claimId = claim.id
    await rt.save()
    return clone(claim)
  }
  async function decide(taskId, token, decision) {
    const task = taskOf(taskId), c = task.collaboration
    const prior = c?.history.find(row => row.execution?.id === token?.id)
    if (prior) {
      if (!prior.decision || prior.execution.status !== 'completed') throw refuse('Claim is stale or execution admission failed')
      await authority(task)
      if (prior.decision.intentHash !== intentHash(decision)) throw refuse('Execution decision idempotency key was reused with different content')
      return clone(c.history.find(row => row.requestId === (decision.requestId ?? token.id)) ?? { status: 'blocked', reason: c.block?.reason })
    }
    const claim = await current(task, token)
    const action = decision?.action, reason = reasonOf(decision?.reason)
    if (!['handoff', 'return', 'transfer', 'complete', 'arbitrate'].includes(action)) throw refuse('Bot must hand off, return, transfer or request Chief judgement')
    const role = sourceOf(task, claim.botId).role
    const next = ['complete', 'arbitrate'].includes(action) ? definitions(task.projectId).roles.find(row => row.role === 'chief') : targetOf(task.projectId, decision.to)
    if (!next) throw refuse('Chief is not configured')
    // Stop confirmation precedes relinquishing the claim and capacity.
    if (claim.workerId && !await adapter.release(claim.workerId)) throw refuse('Worker exit is unconfirmed; claim and capacity remain held')
    await current(task, token)
    if (action === 'handoff' || action === 'complete') await adapter.complete({ task, claim, role, outputs: decision.outputs ?? {} })
    await current(task, token)
    await rt.projectInputs?.acknowledge(task.id, claim, decision.inputReceipts)
    await current(task, token)
    rt.projectInputs?.finishHandoff(task.id, claim)
    claim.status = 'completed'; claim.decision = { action, reason, intentHash: intentHash(decision), at: Date.now() }
    const receipt = c.history.find(row => row.id === c.currentHandoffId)
    receipt.finishedAt = Date.now(); receipt.decision = clone(claim.decision); receipt.execution = clone(claim)
    c.usage ??= {}; c.usage.ms = (c.usage.ms ?? 0) + Date.now() - claim.createdAt
    const usage = rt.state.projectHarnessWorkers?.[claim.workerId]?.usage
    c.usage.tokens = (c.usage.tokens ?? 0) + (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0)
    if ((next.policyRole ?? next.role) === 'developer' && c.kind === 'code') c.attemptId = await adapter.rework?.({ task, claim, reason }) ?? c.attemptId
    try {
      return await offer(task, { from: claim.botId, to: next.id, reason, requestId: decision.requestId ?? claim.id, attemptId: c.attemptId, evidence: decision.evidence ?? [], purpose: action, expectedGeneration: claim.generation })
    } catch (error) {
      c.status = 'blocked'; c.block = { reason: error.message, at: Date.now() }; await rt.save(); throw error
    }
  }
  function available(projectId, botId, actor) {
    rt.requireProjectAccess(actor, projectId); targetOf(projectId, botId)
    return Object.values(rt.state.tasks).filter(task => task.projectId === projectId && task.collaboration?.botId === botId && ['queued', 'arbitration'].includes(task.collaboration.status)).map(clone)
  }
  const owns = botId => Object.values(rt.state.tasks).some(task => task.collaboration?.claim?.workerId === botId || task.collaboration?.history.some(row => row.execution?.workerId === botId))
  async function result({ botId, ok, text }) {
    const task = Object.values(rt.state.tasks).find(task => task.collaboration?.claim?.workerId === botId && task.collaboration.claim.status === 'active')
    if (!task) return owns(botId)
    const token = clone(task.collaboration.claim)
    let decision
    try {
      const output = String(text).match(/(?:^|\n)OUTPUT handoff:\s*([^\n]+)/)?.[1]
      decision = ok && output ? JSON.parse(output) : { action: 'arbitrate', reason: ok ? 'Worker did not provide a valid handoff decision' : `Execution failed: ${String(text).slice(0, 1000)}` }
    } catch { decision = { action: 'arbitrate', reason: 'Worker returned malformed handoff JSON' } }
    try { await decide(task.id, token, decision) }
    catch (error) {
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
    if (!adapter || rt.readOnly?.()) return
    const offered = Object.values(rt.state.tasks).filter(task => (!taskId || task.id === taskId) && (!handoffId || task.collaboration?.currentHandoffId === handoffId) && task.collaboration?.status === 'queued')
    for (const task of offered) {
      let token
      try { token = await serial(() => claim(task.id, task.collaboration.botId, handoffId)) }
      catch (error) { rt.warn?.('Bot pool claim refused: %s', error.message); continue }
      if (!token) continue
      try {
        const workerId = await adapter.execute({ task, claim: token, definition: targetOf(task.projectId, token.botId) })
        await serial(async () => { const claim = await current(task, token); claim.workerId = workerId; await rt.save() })
        await adapter.dispatch({ task, claim: token, workerId })
      } catch (error) {
        let failedClaim
        const reason = `Execution admission failed: ${String(error.message).slice(0, 1000)}`
        await serial(async () => {
          const c = task.collaboration
          if (c.claim?.id !== token.id) return
          failedClaim = c.claim; failedClaim.status = 'failed'; failedClaim.failure = reason; ++c.generation
          c.status = 'blocked'; c.block = { reason, at: Date.now() }; await rt.save()
        })
        if (!failedClaim) continue
        failedClaim.exitConfirmed = false
        if (failedClaim.workerId) { try { failedClaim.exitConfirmed = await adapter.release(failedClaim.workerId) } catch { failedClaim.exitConfirmed = false } }
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
    await rt.save(); return clone(claim)
  }
  async function chiefRoute(body, actor) {
    const task = taskOf(body.taskId), c = task.collaboration
    rt.projectChiefControl.requireJobActor(actor, task.projectId)
    rt.requireProjectAccess(actor, task.projectId, 'run-control')
    if (!c || c.generation !== body.expectedGeneration) throw refuse('Chief routing snapshot is stale')
    const target = targetOf(task.projectId, body.targetBotId)
    if (target.role === 'chief') throw refuse('Chief must decide a concrete next role or request human clarification')
    reasonOf(body.reason)
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
      else if (previous && previous.status !== 'running') throw refuse('Interrupted delivery must return to Developer in a new Attempt')
      return await offer(task, { from: `${task.projectId}:chief`, to: target.id, reason: body.reason, requestId: body.decisionId, attemptId: c.attemptId, purpose: 'chief-intervention' })
    } catch (error) {
      c.status = 'blocked'; c.block = { reason: String(error.message), decisionId: body.decisionId, at: Date.now() }; await rt.save(); throw error
    }
  }
  function recover() {
    if (recovered || rt.readOnly?.()) return false
    recovered = true
    let changed = false
    for (const task of Object.values(rt.state.tasks)) {
      const c = task.collaboration
      if (!c?.claim || c.claim.status !== 'active') continue
      c.status = 'blocked'; c.claim.status = 'interrupted'; c.block = { reason: 'Host restarted; worker exit and resources must be reconciled before reassigning', at: Date.now() }; ++c.generation; changed = true
    }
    if (rt.projectEffects) {
      const count = Object.keys(rt.state.projectEffects ?? {}).length
      for (const task of Object.values(rt.state.tasks)) {
        const c = task.collaboration
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
  return { connect(value) { adapter = value; return () => { if (adapter === value) adapter = null } }, admit: (attempt, actor, body) => serial(() => admit(attempt, actor, body)), available, owns,
    claim: (id, botId) => serial(() => claim(id, botId)), decide: (id, token, decision) => serial(() => decide(id, token, decision)), result: row => serial(() => result(row)), pump, recover, revokePrincipal: (projectId, memberId) => serial(() => revokePrincipal(projectId, memberId)), revokeExecution: (id, claimId, reason) => serial(() => revokeExecution(id, claimId, reason)), validateClosure, retryChief: (id, actor) => serial(() => retryChief(id, actor)), chiefClaim: (id, actor) => serial(() => chiefClaim(id, actor)), chiefRoute: (body, actor) => serial(() => chiefRoute(body, actor)) }
}
export function install(rt) {
  rt.projectPools = createProjectPools(rt)
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
