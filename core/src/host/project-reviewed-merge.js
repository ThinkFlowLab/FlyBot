// Reviewer approval enters an authorized host Effect; Chief still owns Task closure.
import { projectMergePolicy, mergeDigest } from './project-merge-policy.js'
import { EffectCancelled, EffectDeferred } from './project-effects.js'
import { confirmedWorkerExit } from './project-task-sessions.js'
import { nativeExitConfirmed } from './project-native-sessions.js'
import { verifyRolePolicy } from './project-role-policy.js'
export function mergeHandoffView(state, attempt) {
  const handoff = attempt?.merge?.chiefHandoff
  if (!handoff) return null
  const savedEffect = state.projectEffects?.[handoff.effect?.id], savedRun = state.projectExecutions?.[handoff.runId]
  const effect = savedEffect?.projectId === attempt.projectId && savedEffect.taskId === attempt.taskId ? savedEffect : null
  const run = savedRun?.projectId === attempt.projectId && savedRun.source?.attemptId === attempt.id && savedRun.source.candidateSha === handoff.candidateSha ? savedRun : null
  return { effectId: handoff.effect?.id ?? null, candidateSha: handoff.candidateSha, status: effect?.status === 'done' ? 'delivered' : effect?.status ?? 'uncommitted', reason: effect?.error ?? null, waitingFor: effect?.waitingFor ?? null,
    runId: handoff.runId ?? null, runStatus: run?.status ?? null, runFailure: run?.failure?.slice(0, 1000) ?? null, waitingRunId: handoff.waitingRunId ?? null, createdAt: handoff.createdAt, requestedAt: handoff.requestedAt ?? null }
}
export function createReviewedMerge(rt, { projectOf, settingsOf, publisherOf, validatePublication, serialAttempt, now = Date.now }) {
  const attempts = () => rt.state.projectAttempts ?? {}
  const policyOf = attempt => { const project = projectOf(attempt.projectId, attempt); return projectMergePolicy(settingsOf(project), project.defaultBranch ?? 'main') }
  function mergeProof(attempt) {
    const proof = attempt?.evidence?.merge, effect = rt.state.projectEffects?.[proof?.effectId], intent = effect?.payload?.intent
    if (!proof || !intent || proof.scope !== 'provider-confirmed-merge-observation' || !/^[0-9a-f]{40}$/.test(proof.mergeCommitSha ?? '') || proof.sha !== attempt.candidateSha || effect?.kind !== 'github.merge' || effect.projectId !== attempt.projectId || effect.taskId !== attempt.taskId || effect.payload.attemptId !== attempt.id || effect.payload.candidateSha !== proof.sha || attempt.merge?.effectId !== effect.id || proof.repository !== intent?.repository || proof.number !== intent.number || attempt.pr?.repository !== proof.repository || attempt.pr?.number !== proof.number || attempt.pr?.sha !== proof.sha || proof.policySha256 !== effect.payload.policySha256 || proof.reviewSha256 !== effect.payload.reviewSha256) return null
    return proof
  }
  const proofKey = proof => mergeDigest([proof.effectId, proof.sha, proof.mergeCommitSha, proof.repository, proof.number, proof.baseBranch, proof.policySha256, proof.reviewSha256])
  function currentTask(attempt) {
    const task = rt.state.tasks[attempt.taskId]
    if (!task || task.projectId !== attempt.projectId || task.deliveryAttemptId !== attempt.id || ['accepted', 'cancelled'].includes(task.status) || attempt.cancelRequested || attempt.status === 'cancelled' || ['cancelled', 'closed', 'stopping'].includes(task.collaboration?.status)) throw new EffectCancelled('Merged candidate is no longer awaiting current Task acceptance')
    return task
  }
  async function stageHandoff(attempt) {
    const proof = mergeProof(attempt)
    if (!proof) return null
    const key = proofKey(proof), previous = attempt.merge.chiefHandoff
    if (attempt.merge.status !== 'merged') {
      attempt.merge.observations = [...(attempt.merge.observations ?? []), { status: attempt.merge.status, reason: attempt.merge.reason, reconciledBy: proof.effectId, at: now() }].slice(-8)
      Object.assign(attempt.merge, { status: 'merged', reason: 'provider-confirmed-merge-retained', nextCheckAt: null })
    }
    const token = rt.projectEffects.stage({ kind: 'chief.merge-handoff', key, projectId: attempt.projectId, taskId: attempt.taskId, payload: { attemptId: attempt.id, candidateSha: proof.sha, proofKey: key } })
    if (previous?.effect?.id !== token.id) attempt.merge.chiefHandoff = { effect: token, candidateSha: proof.sha, createdAt: now() }
    try { await rt.projectEffects.persist(token) }
    catch (error) { if (rt.projectEffects.discardUncommitted(token)) { if (previous) attempt.merge.chiefHandoff = previous; else delete attempt.merge.chiefHandoff }; throw error }
    return token
  }
  rt.projectEffects?.register('chief.merge-handoff', {
    run: async (effect, context) => {
      const attempt = attempts()[effect.payload.attemptId], proof = mergeProof(attempt)
      if (!proof || proofKey(proof) !== effect.payload.proofKey || attempt.merge.chiefHandoff?.effect?.id !== effect.id) throw new EffectCancelled('Merge handoff evidence was superseded')
      currentTask(attempt)
      const handoff = attempt.merge.chiefHandoff, policy = rt.state.projectChiefPolicies?.[attempt.projectId]
      if (!policy?.enabled) throw new EffectDeferred('Confirmed merge awaits configured Chief authority', { waitingFor: 'chief-authority' })
      rt.requireProjectAccess({ memberId: policy.authorityMemberId }, attempt.projectId, 'configure')
      context.assertCurrent()
      const source = { mergeEffectId: proof.effectId, attemptId: attempt.id, candidateSha: proof.sha }
      const runs = Object.values(rt.state.projectExecutions ?? {}).filter(row => row.kind === 'chief-control' && row.projectId === attempt.projectId)
      const prior = runs.find(row => row.source?.mergeEffectId === proof.effectId && row.source.attemptId === attempt.id && row.source.candidateSha === proof.sha)
      // Finish the existing Chief turn first; its fresh correction snapshot sees the merge.
      const active = runs.find(row => ['queued', 'running', 'correction-pending', 'interrupted'].includes(row.status) && row !== prior)
      if (active) { handoff.waitingRunId = active.id; throw new EffectDeferred('Confirmed merge awaits the current Chief judgement', { waitingFor: 'chief-current-decision' }) }
      const run = prior ?? await rt.projectChiefControl.request(attempt.projectId, 'inspection', source, attempt.taskId)
      context.assertCurrent(); currentTask(attempt)
      if (proofKey(mergeProof(attempt) ?? {}) !== effect.payload.proofKey) throw new EffectCancelled('Candidate merge changed during Chief handoff')
      handoff.runId = run.id; handoff.requestedAt ??= now(); delete handoff.waitingRunId
      // The Run and its receipt are saved together, including a request whose response was lost.
      await rt.projectEffects.persist({ id: effect.id, generation: effect.generation })
      return { runId: run.id, attemptId: attempt.id, candidateSha: proof.sha, mergeEffectId: proof.effectId }
    },
  }, { replace: true })
  async function reconcileHandoffs() {
    let staged = 0
    for (const attempt of Object.values(attempts())) {
      if (staged >= 32) { rt.projectScheduler?.wake(); break }
      if (!mergeProof(attempt)) continue
      try { currentTask(attempt) } catch (error) { if (error instanceof EffectCancelled) continue; throw error }
      const handoff = attempt.merge.chiefHandoff
      if (handoff?.effect && rt.projectEffects.intentCommitted(handoff.effect)) continue
      await stageHandoff(attempt); ++staged
    }
    return staged
  }
  function reviewScope(attempt, task) {
    const role = attempt.roleAssignments?.reviewer ?? 'reviewer', session = attempt.roleSessions?.[role], review = attempt.evidence.review
    if (!session || (session.policyRole ?? session.role) !== 'reviewer' || review?.logicalRole !== role || review.roleSessionId !== session.id || review.policySha256 !== attempt.rolePolicies?.[role]?.sha256) throw new EffectCancelled('Reviewer approval has no matching pinned execution scope')
    verifyRolePolicy(attempt.rolePolicies[role], session.context?.sources?.policy?.sha256)
    const sdk = (session.execution?.harness ?? 'flybot') !== 'flybot'
    const worker = sdk ? rt.state.projectHarnessWorkers?.[session.botId] : rt.state.projectNativeWorkers?.[session.botId]
    if (!worker || worker.projectId !== attempt.projectId || worker.taskId !== attempt.taskId || worker.attemptId !== attempt.id || worker.role !== role || worker.sessionKey !== session.id) throw new EffectCancelled('Reviewer execution identity is missing or changed')
    if (sdk ? !confirmedWorkerExit(rt.state, worker) : !nativeExitConfirmed(rt.state, worker)) throw new EffectDeferred('Reviewer execution exit is unconfirmed', { waitingFor: 'worker-exit' })
    if (sdk && (worker.backendSessionId !== session.backendSessionId || worker.generation !== session.resourceLease?.generation || rt.state.projectResourceLeases?.[worker.leaseId]?.status !== 'released')) throw new EffectCancelled('Reviewer SDK binding changed')
    if (session.poolClaimId) {
      const source = task.collaboration?.history.flatMap(row => [row.execution, row.sourceExecution]).find(row => row?.id === session.poolClaimId && row.generation === session.generation && row.workerId === session.botId)
      if (!source || source.status !== 'completed' || source.exitConfirmed !== true) throw new EffectDeferred('Reviewer handoff is not durably completed', { waitingFor: 'role-handoff' })
    } else if (rt.state.projectExecutions?.[attempt.runId]?.status !== 'done') throw new EffectDeferred('Original delivery Run is not complete', { waitingFor: 'role-handoff' })
  }
  async function validate(effect, context) {
    const attempt = attempts()[effect.payload.attemptId]
    if (!attempt || attempt.merge?.effectId !== effect.id) throw new EffectCancelled('Merge intent was superseded')
    const policy = policyOf(attempt)
    if (!policy) throw Object.assign(new EffectCancelled('Project automatic merge policy disabled'), { mergeStatus: 'cancelled', mergeReason: 'policy-disabled' })
    const retry = rt.state.projectEffects?.[effect.id]?.retries?.at(-1)
    if (retry && retry.at > (attempt.merge.budgetRenewedAt ?? attempt.merge.createdAt)) { attempt.merge.budgetRenewedAt = retry.at; attempt.merge.deadlineAt = retry.at + policy.maxWaitMs }
    if (mergeDigest(policy) !== effect.payload.policySha256 || mergeDigest(attempt.evidence.review) !== effect.payload.reviewSha256 || attempt.evidence.tests?.sha256 !== effect.payload.testSha256) throw new EffectCancelled('Merge policy or verified candidate evidence changed')
    await validatePublication(effect, { ...context, inline: false })
    const task = rt.state.tasks[attempt.taskId]
    reviewScope(attempt, task)
    try { rt.projectInputs?.requireHandled(task.id) } catch { throw new EffectDeferred('Current Task input needs actual handling before merge', { waitingFor: 'task-input' }) }
    context.assertCurrent()
    return { attempt, policy }
  }
  async function checked(effect, context) {
    try { return await validate(effect, context) }
    catch (error) {
      const attempt = attempts()[effect.payload.attemptId]
      if (attempt?.merge?.effectId === effect.id) { attempt.merge.status = error.mergeStatus ?? (error instanceof EffectDeferred ? 'waiting' : 'blocked'); if (!(error instanceof EffectDeferred)) attempt.merge.nextCheckAt = null; attempt.merge.reason = error.mergeReason ?? (error instanceof EffectDeferred ? error.message : 'Merge prerequisites changed; inspect current policy, candidate and role bindings'); attempt.merge.waitingFor = error.waitingFor ?? 'chief'; await rt.save() }
      throw error
    }
  }
  rt.projectEffects?.register('github.merge', {
    validate: (effect, context) => mergeProof(attempts()[effect.payload.attemptId])?.effectId === effect.id ? context.assertCurrent() : checked(effect, context),
    run: (effect, context) => serialAttempt(effect.payload.attemptId, async () => {
      const recorded = attempts()[effect.payload.attemptId]
      if (mergeProof(recorded)?.effectId === effect.id) { await stageHandoff(recorded); return structuredClone(recorded.evidence.merge) }
      const { attempt, policy } = await checked(effect, context)
      const broker = publisherOf(projectOf(attempt.projectId, attempt), () => validate(effect, context))
      if (typeof broker.merge !== 'function') throw new EffectCancelled('Selected publication adapter has no merge capability')
      let observation
      try {
        for (let step = 0; step < 3; ++step) {
          observation = await broker.merge(effect.payload.intent, policy, async metadata => {
            await validate(effect, context)
            attempt.merge.lastWrite = { ...metadata, at: now() }
            await rt.projectEffects.persist({ id: effect.id, generation: effect.generation })
            await validate(effect, context)
          })
          if (!['draft-marked-ready', 'merge-requested-awaiting-observation'].includes(observation.reason)) break
        }
      } catch {
        observation = { version: 'project-merge-observation/v1', status: 'unknown', reason: 'provider-outcome-unavailable; reconcile before another write', observedAt: now() }
      }
      context.assertCurrent()
      Object.assign(attempt.merge, observation, { version: 'project-reviewed-merge/v1', observationVersion: observation.version, nextCheckAt: observation.status === 'merged' ? null : now() + policy.pollIntervalMs })
      attempt.merge.observations = [...(attempt.merge.observations ?? []), { status: observation.status, reason: observation.reason, at: observation.observedAt }].slice(-8)
      if (observation.status === 'merged') {
        await validate(effect, context)
        attempt.evidence.merge = { sha: attempt.candidateSha, mergeCommitSha: observation.mergeCommitSha, repository: effect.payload.intent.repository, number: effect.payload.intent.number, baseBranch: policy.baseBranch, policySha256: effect.payload.policySha256, reviewSha256: effect.payload.reviewSha256, effectId: effect.id, scope: 'provider-confirmed-merge-observation', identity: structuredClone(effect.payload.intent.mergeIdentity ?? effect.payload.intent.identity), at: observation.observedAt }
        await stageHandoff(attempt)
        rt.projectScheduler?.wake()
        return structuredClone(attempt.evidence.merge)
      }
      await rt.save()
      throw new EffectDeferred(observation.reason, { waitingFor: observation.status === 'queued' ? 'github-merge-queue' : observation.status === 'blocked' ? 'github-merge-blocked' : 'github-merge-observation', retryAfterMs: policy.pollIntervalMs })
    }),
  }, { replace: true })
  async function stage(attempt) {
    let policy
    try { policy = policyOf(attempt) } catch { attempt.merge = { version: 'project-reviewed-merge/v1', status: 'blocked', reason: 'merge-policy-unavailable', candidateSha: attempt.candidateSha, nextCheckAt: null }; await rt.save(); return null }
    if (!policy) return null
    const task = rt.state.tasks[attempt.taskId], pr = attempt.pr
    if (!pr || pr.sha !== attempt.candidateSha || pr.repository !== attempt.requirement.repository || attempt.evidence.review?.verdict !== 'approve' || attempt.evidence.review.sha !== attempt.candidateSha) throw new EffectCancelled('Merge requires the original approved candidate publication')
    const reviewSha256 = mergeDigest(attempt.evidence.review), policySha256 = mergeDigest(policy)
    const intent = { id: mergeDigest([attempt.id, attempt.candidateSha, reviewSha256, policySha256]), repository: pr.repository, number: pr.number, branch: pr.branch ?? attempt.publicationBinding?.branch ?? attempt.branch, publicationMarker: pr.publicationMarker ?? attempt.publicationBinding?.publicationMarker ?? `<!-- flybot-publication:${attempt.publicationEffectId ?? attempt.id} -->`, creatorLogin: pr.creatorLogin, identity: structuredClone(pr.identity), ...(pr.mergeIdentity ? { mergeIdentity: structuredClone(pr.mergeIdentity) } : {}), candidateSha: attempt.candidateSha }
    const spec = { kind: 'github.merge', key: intent.id, projectId: attempt.projectId, taskId: attempt.taskId, payload: { attemptId: attempt.id, candidateSha: attempt.candidateSha, initiatedBy: task.collaboration?.initiatedBy ?? attempt.initiatedBy, reviewSha256, policySha256, testSha256: attempt.evidence.tests.sha256, intent } }
    const token = rt.projectEffects.stage(spec)
    if (attempt.merge?.effectId === token.id) return token
    const previous = attempt.merge
    attempt.merge = { version: 'project-reviewed-merge/v1', status: 'waiting', reason: 'approved-candidate-admitted', effectId: token.id, candidateSha: attempt.candidateSha, policySha256, reviewSha256, createdAt: now(), deadlineAt: now() + policy.maxWaitMs, nextCheckAt: now() }
    try { await rt.projectEffects.persist(token) } catch (error) { if (rt.projectEffects.discardUncommitted(token)) { if (previous) attempt.merge = previous; else delete attempt.merge }; throw error }
    rt.projectScheduler?.wake()
    return token
  }
  function requireMerged(attempt, observed) {
    const policy = policyOf(attempt)
    if (!policy) return false
    if (attempt.merge?.status !== 'merged' || attempt.merge.candidateSha !== attempt.candidateSha || attempt.merge.policySha256 !== mergeDigest(policy) || !attempt.evidence.merge || observed?.merged !== true || observed.mergeCommitSha !== attempt.evidence.merge.mergeCommitSha || observed.baseRef !== policy.baseBranch) throw new Error('Configured automatic merge is not confirmed for this candidate and target')
    return true
  }
  return { stage, requireMerged, policyOf, reconcileHandoffs }
}
