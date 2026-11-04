// Reviewer approval enters an authorized host Effect; Chief still owns Task closure.
import { projectMergePolicy, mergeDigest } from './project-merge-policy.js'
import { EffectCancelled, EffectDeferred, EffectExhausted } from './project-effects.js'
import { confirmedWorkerExit } from './project-task-sessions.js'
import { nativeExitConfirmed } from './project-native-sessions.js'
import { verifyRolePolicy } from './project-role-policy.js'
export function createReviewedMerge(rt, { projectOf, settingsOf, publisherOf, validatePublication, serialAttempt, now = Date.now }) {
  const attempts = () => rt.state.projectAttempts ?? {}
  const policyOf = attempt => { const project = projectOf(attempt.projectId, attempt); return projectMergePolicy(settingsOf(project), project.defaultBranch ?? 'main') }
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
    if (now() > attempt.merge.deadlineAt) throw Object.assign(new EffectExhausted('Merge wait budget exhausted'), { mergeReason: 'merge-wait-budget-exhausted' })
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
    validate: checked,
    run: (effect, context) => serialAttempt(effect.payload.attemptId, async () => {
      const { attempt, policy } = await checked(effect, context)
      if (now() > attempt.merge.deadlineAt) { attempt.merge.status = 'blocked'; attempt.merge.reason = 'merge-wait-budget-exhausted'; await rt.save(); throw new EffectExhausted('Merge wait budget exhausted; retain evidence for Chief judgement') }
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
        await rt.save()
        if (rt.state.projectChiefPolicies?.[attempt.projectId]?.enabled) await rt.projectChiefControl.request(attempt.projectId, 'inspection', { mergeEffectId: effect.id, attemptId: attempt.id, candidateSha: attempt.candidateSha })
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
  return { stage, requireMerged, policyOf }
}
