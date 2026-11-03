// Resolve original Task/dependency records to immutable code/report references.
// A reference is data, not permission to merge, publish or close the parent.
import { createHash } from 'node:crypto'
import { ownEntry } from './store.js'
import { taskOutcome } from './project-task-lifecycle.js'
const fail = message => Object.assign(new Error(message), { code: 'bot/child-input' })
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')

export function childResultSources(state, parent, repository) {
  if (!parent.projectTask?.wait) return []
  if (ownEntry(state.tasks ?? {}, parent.id)?.projectId !== parent.projectId) throw fail('Parent Task is outside the Project')
  return parent.projectTask.dependencies.map(dependency => {
    const result = dependency.result
    if (!['satisfied', 'waived'].includes(dependency.status) || !result) throw fail('Child dependency has no adjudicated outcome')
    if (dependency.status === 'waived') {
      if (result.kind !== 'chief-resolution' || dependency.resolution?.decisionId !== result.decisionId) throw fail('Child waiver lacks scoped Chief judgement')
      if (!result.sourceTaskId) {
        if (!Array.isArray(result.evidence) || !result.evidence.length) throw fail('Child waiver needs explicit evidence references')
        return { dependencyId: dependency.taskId, kind: 'judgement', decisionId: result.decisionId, integration: 'not-code', integrated: false }
      }
      if (result.replacementTaskId !== result.sourceTaskId) throw fail('Replacement source scope changed')
    }
    const sourceTaskId = result.sourceTaskId ?? dependency.taskId
    const child = ownEntry(state.tasks ?? {}, sourceTaskId)
    if (!child || child.projectId !== parent.projectId) throw fail('Child result belongs to another Project')
    if (child.status !== 'accepted' || child.completedBy?.kind !== 'chief' || !child.completedBy.decisionId) throw fail('Child result has not been accepted by Chief')
    const outcome = taskOutcome(state, child)
    if (!outcome.version || dependency.status === 'waived' && outcome.version !== result.replacementVersion || dependency.status === 'satisfied' && result.decisionId !== child.completedBy.decisionId) throw fail('Child result changed after dependency judgement')
    const attempt = ownEntry(state.projectAttempts ?? {}, child.deliveryAttemptId)
    if (!attempt || attempt.projectId !== parent.projectId || attempt.taskId !== child.id || attempt.status !== 'accepted' || attempt.acceptedViaChief !== child.completedBy.decisionId) throw fail('Child Attempt acceptance is missing or stale')
    if (child.projectTask && attempt.requirement?.projectTaskRevision !== child.projectTask.requirements.revision) throw fail('Child requirements changed after acceptance')
    const base = { dependencyId: dependency.taskId, sourceTaskId, attemptId: attempt.id, decisionId: child.completedBy.decisionId, outcomeVersion: outcome.version, integrated: false }
    if (!attempt.candidateSha) {
      if (child.projectTaskKind !== 'decision') throw fail('Code child has no sealed candidate')
      return { ...base, kind: 'report', integration: 'not-code' }
    }
    const sha = attempt.candidateSha, evidence = attempt.evidence ?? {}
    if (!/^[a-f0-9]{40}$/.test(sha) || sha !== result.candidateSha || evidence.implementation?.sha !== sha || evidence.tests?.sha !== sha || evidence.tests.passed !== true || !/^[a-f0-9]{64}$/.test(evidence.tests.sha256 ?? '') || evidence.review?.sha !== sha || evidence.review.verdict !== 'approve') throw fail('Child code evidence is missing, stale or unverified')
    const sourceRepository = attempt.requirement?.repository
    if (typeof sourceRepository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(sourceRepository)) throw fail('Child code repository is unavailable')
    return { ...base, kind: 'code', sha, repository: sourceRepository, testLogSha256: evidence.tests.sha256,
      ref: `refs/remotes/operator/project-child/${digest([parent.projectId, child.id, outcome.version]).slice(0, 40)}`,
      integration: sourceRepository !== repository ? 'external-repository-reference' : parent.projectTaskKind === 'code' ? 'required' : 'artifact-reference' }
  })
}

export function createChildInputAdmission(rt, ports) {
  function context(taskId, claim) {
    const task = ownEntry(rt.state.tasks ?? {}, taskId), attempt = ownEntry(rt.state.projectAttempts ?? {}, task?.deliveryAttemptId)
    if (!task?.projectTask?.wait || task.projectTaskKind !== 'code') return null
    if (!attempt || attempt.id !== claim?.attemptId || attempt.projectId !== task.projectId || attempt.taskId !== task.id) throw fail('Parent Attempt changed before child integration')
    const project = ports.projectOf(task.projectId)
    if (attempt.requirement.repository !== project.repository) throw fail('Parent execution repository changed; explicit recovery is required')
    ports.assertIdle(task, claim)
    rt.projectTaskLifecycle.requireCompletedDependencies(task)
    const actor = { memberId: task.collaboration.initiatedBy, ...(task.collaboration.sourceSessionId ? { sessionId: task.collaboration.sourceSessionId } : {}) }
    rt.requireProjectAccess(actor, task.projectId, 'task-write', task)
    rt.projects.requireActive(task.projectId)
    const sources = childResultSources(rt.state, task, project.repository)
    const signature = digest({ waitId: task.projectTask.wait.id, requirementsRevision: task.projectTask.requirements.revision, sources })
    return { task, attempt, project, actor, sources, signature }
  }
  function assertProof(taskId, claim, proof) {
    const current = context(taskId, claim)
    if (!current || current.signature !== proof.signature || current.actor.memberId !== proof.initiatedBy || current.attempt.id !== proof.attemptId) throw fail('Child integration source or authority changed during admission')
    return current
  }
  rt.projectEffects?.register('integration.child-refs', {
    async validate(effect, control) {
      const current = assertProof(effect.taskId, effect.payload.claim, effect.payload)
      await rt.projectDelegations?.background(current.actor.memberId, current.actor.sessionId)
      control.assertCurrent()
      assertProof(effect.taskId, effect.payload.claim, effect.payload)
    },
    async run(effect) {
      const current = assertProof(effect.taskId, effect.payload.claim, effect.payload)
      const settings = ports.settingsOf(current.project), refs = []
      for (const source of current.sources.filter(row => row.integration === 'required')) {
        assertProof(effect.taskId, effect.payload.claim, effect.payload)
        if (await ports.git(settings.path, ['cat-file', '-t', source.sha]) !== 'commit') throw fail('Accepted child commit is unavailable in its registered repository')
        let prior
        try { prior = await ports.git(settings.path, ['rev-parse', '--verify', '--quiet', source.ref]) }
        catch (error) { if (error.code !== 1) throw error }
        if (prior && prior !== source.sha) throw fail('Accepted child reference moved; preserve the existing source')
        if (!prior) {
          assertProof(effect.taskId, effect.payload.claim, effect.payload)
          await ports.git(settings.path, ['update-ref', source.ref, source.sha, '0'.repeat(40)])
        }
        refs.push({ ref: source.ref, sha: source.sha })
      }
      assertProof(effect.taskId, effect.payload.claim, effect.payload)
      return { refs, sourceSignature: current.signature }
    },
  }, { replace: true })
  async function admit(taskId, claim) {
    let current = context(taskId, claim)
    if (!current) return null
    await rt.projectDelegations?.background(current.actor.memberId, current.actor.sessionId)
    current = context(taskId, claim)
    const needed = current.sources.filter(row => row.integration === 'required')
    if (!needed.length) return { sources: current.sources, admission: null }
    const prior = current.attempt.integrationAdmissions?.findLast(row => row.origin === 'project-child-results' && row.sourceWaitId === current.task.projectTask.wait.id && row.sourcesFingerprint === current.signature)
    if (prior && rt.projectEffects.intentCommitted(prior.effect)) {
      await ports.verify(current.attempt)
      return { sources: current.sources, admission: structuredClone(prior), already: true }
    }
    const proof = { signature: current.signature, initiatedBy: current.actor.memberId, attemptId: current.attempt.id,
      claim: { id: claim.id, generation: claim.generation, botId: claim.botId, attemptId: claim.attemptId },
      sourceWaitId: current.task.projectTask.wait.id, sources: current.sources }
    const spec = { kind: 'integration.child-refs', key: `${claim.id}:${current.signature}`, projectId: current.task.projectId, taskId, payload: proof }
    const token = rt.projectEffects.stage(spec)
    try { await rt.projectEffects.perform(spec) }
    catch (error) { rt.projectEffects.discardUncommitted(token); throw error }
    current = assertProof(taskId, claim, proof)
    const inputs = [...(current.attempt.integrationInputs ?? [])]
    for (const source of needed) if (!inputs.some(row => row.sha === source.sha)) inputs.push({ ref: source.ref, sha: source.sha })
    const result = await ports.bind({ projectId: current.task.projectId, attemptId: current.attempt.id, requestId: `children-${current.signature.slice(0, 40)}`,
      inputs, generation: claim.generation, expectedWorkspace: await ports.snapshot(current.attempt) }, current.actor, proof)
    assertProof(taskId, claim, proof)
    return { ...result, sources: current.sources }
  }
  return { admit, assertProof }
}
