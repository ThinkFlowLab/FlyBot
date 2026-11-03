// Release authorization and observation live on the existing Attempt and Effects.
import { createHash } from 'node:crypto'
import { ownEntry } from './store.js'
import { repositorySettings } from './project-repository-policy.js'
import { githubReleaseProvider } from './project-release-github.js'
import { EffectCancelled } from './project-effects.js'
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const fail = message => Object.assign(new Error(message), { code: 'bot/release' })
const reference = actor => Object.fromEntries(['memberId', 'sessionId', 'agentId', 'watchGrantId', 'watchGeneration', 'personalAgentCredentialId', 'personalAgentCredentialGeneration'].filter(key => actor[key] !== undefined).map(key => [key, actor[key]]))
const view = row => row ? { id: row.id, status: row.status, repository: row.spec.repository, tag: row.spec.tag, sha: row.spec.sha, mode: row.spec.mode, authorizedBy: row.actor.memberId, createdAt: row.createdAt, observedAt: row.observedAt ?? null, proof: row.proof ? structuredClone(row.proof) : null, effect: structuredClone(row.effect), result: row.result ?? null } : null
export function createProjectReleases(rt, { projectOf, providerFactory = settings => githubReleaseProvider(settings.github) }) {
  let tail = Promise.resolve()
  const serial = fn => { const result = tail.then(fn, fn); tail = result.catch(() => {}); return result }
  function attemptOf(id) {
    const attempt = ownEntry(rt.state.projectAttempts ?? {}, id), task = ownEntry(rt.state.tasks ?? {}, attempt?.taskId)
    if (!attempt || !task || task.projectId !== attempt.projectId || task.deliveryAttemptId !== attempt.id || task.projectTaskKind !== 'release') throw fail('Release needs the current release Task Attempt')
    return { attempt, task }
  }
  function settingsOf(attempt) {
    const project = projectOf(attempt.projectId, attempt), settings = repositorySettings(rt, project)
    if (settings.release?.enabled !== true || settings.release.provider !== 'github') throw fail('Release provider is not explicitly configured')
    return settings
  }
  const policyHash = settings => hash({ release: settings.release, github: settings.github })
  async function authority(attempt, task, row) {
    if (rt.readOnly?.() !== undefined) throw new EffectCancelled('Release host is read-only')
    await rt.projectDelegations?.background(row.actor.memberId, row.actor.sessionId)
    if (rt.validateProjectActor && !await rt.validateProjectActor(row.actor)) throw new EffectCancelled('Release principal was revoked')
    if (row.actor.watchGrantId && !await rt.projectDelegations.validateActor(row.actor)) throw new EffectCancelled('Release delegation was revoked')
    rt.requireProjectAccess(row.actor, task.projectId, 'configure')
    rt.projectTaskLifecycle?.requireExecutable(task)
    if (attemptOf(attempt.id).attempt !== attempt || attempt.release !== row || attempt.status !== 'running' || attempt.cancelRequested || task.projectTask && task.projectTask.requirements.revision !== row.requirementsRevision) throw new EffectCancelled('Release Task or requirements changed')
    const settings = settingsOf(attempt)
    if (policyHash(settings) !== row.policySha256) throw new EffectCancelled('Release provider configuration changed')
    return settings
  }
  function checkProof(row, proof) {
    if (!proof || proof.provider !== 'github' || proof.repository !== row.spec.repository || proof.tag !== row.spec.tag || proof.sha !== row.spec.sha || !Number.isSafeInteger(proof.releaseId) || proof.releaseId < 1 || typeof proof.publishedAt !== 'string' || !Number.isFinite(Date.parse(proof.publishedAt)) || row.spec.mode === 'publish' && proof.marker !== true) throw fail('Release proof is missing, stale or belongs to another request')
    return proof
  }
  async function execute(effect, inspectOnly) {
    const { attempt, task } = attemptOf(effect.payload.attemptId), row = attempt.release
    if (!row || row.id !== effect.payload.releaseId) throw new EffectCancelled('Release request changed')
    let settings
    try { settings = await authority(attempt, task, row) }
    catch (error) { row.status = 'revoked'; row.result = 'Current authority or execution binding is unavailable'; await rt.save(); throw new EffectCancelled(row.result) }
    const save = () => rt.projectEffects.persist({ id: effect.id, generation: effect.generation })
    const provider = providerFactory(settings), authorize = async () => {
      try { return await authority(attempt, task, row) }
      catch { row.status = 'revoked'; row.result = 'Release authority changed during execution'; await save(); throw new EffectCancelled(row.result) }
    }
    let proof = await provider.inspect(row.spec, authorize)
    if (!proof && !inspectOnly && row.spec.mode === 'publish' && !row.submissionStarted) {
      await authorize()
      row.status = 'submitting'; row.submissionStarted = true
      await save() // A restart after this point may inspect, but never blindly repeat POST.
      try { await provider.publish(row.spec, authorize) }
      catch (error) {
        row.status = error.code === 'release/rejected' ? 'failed' : 'unknown'
        row.result = row.status === 'failed' ? 'Provider rejected the release request' : 'External result unknown; reconcile without resubmission'
        await save(); return { releaseId: row.id, status: row.status }
      }
      try { proof = await provider.inspect(row.spec, authorize) }
      catch { row.status = 'unknown'; row.result = 'Published response needs external verification'; await save(); return { releaseId: row.id, status: row.status } }
    }
    if (!proof) {
      row.status = row.submissionStarted ? 'unknown' : 'awaiting-artifact'
      row.result = row.submissionStarted ? 'Reconcile external result; no repeated publication authorized' : 'No published release was observed'
      await save(); return { releaseId: row.id, status: row.status }
    }
    await authorize()
    try { checkProof(row, proof) }
    catch { row.status = 'failed'; row.result = 'Observed release does not match the authorized target'; await save(); return { releaseId: row.id, status: row.status } }
    row.proof = proof; row.proofSha256 = hash(proof); row.observationEffect = { id: effect.id, generation: effect.generation }; row.observedAt = Date.now(); row.status = 'observed'; row.result = null
    await save(); return { releaseId: row.id, status: row.status, proofSha256: row.proofSha256 }
  }
  rt.projectEffects?.register('release.execute', { run: effect => execute(effect, false) }, { replace: true })
  rt.projectEffects?.register('release.reconcile', { run: effect => execute(effect, true) }, { replace: true })
  async function request(body, actor) {
    const { attempt, task } = attemptOf(body.attemptId)
    if (actor.chiefJobId) throw fail('Chief completion is not release authorization')
    rt.requireProjectAccess(actor, task.projectId, 'configure')
    rt.projectTaskLifecycle?.requireExecutable(task)
    if (attempt.status !== 'running' || attempt.cancelRequested || !rt.projectEffects || rt.readOnly?.() !== undefined) throw fail('Release Attempt is not writable and running')
    const settings = settingsOf(attempt)
    const mode = body.mode ?? 'observe'
    if (!['observe', 'publish'].includes(mode) || !/^[A-Za-z0-9_-]{1,100}$/.test(body.requestId ?? '') || typeof body.tag !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,100}$/.test(body.tag) || body.tag.includes('..') || body.tag.includes('//') || body.tag.endsWith('/') || body.tag.endsWith('.lock') || !/^[a-f0-9]{40}$/.test(body.sha ?? '') || body.sha !== attempt.baseSha || typeof (body.name ?? body.tag) !== 'string' || (body.name ?? body.tag).length > 120 || typeof (body.notes ?? '') !== 'string' || (body.notes ?? '').length > 4000) throw fail('Release needs stable requestId, valid tag, pinned base SHA and bounded text')
    const spec = { mode, repository: attempt.requirement.repository, tag: body.tag, sha: body.sha, name: body.name ?? body.tag, notes: body.notes ?? '', marker: `<!-- flybot-release:${attempt.id}:${body.requestId} -->` }
    const requestHash = hash(spec), prior = attempt.release
    if (prior) {
      if (prior.requestId !== body.requestId || prior.requestHash !== requestHash || prior.actor.memberId !== actor.memberId) throw fail('Release request already exists; reconcile it instead of replacing authorization')
      return { release: view(prior), already: true }
    }
    const row = { id: `release-${attempt.id}`, requestId: body.requestId, requestHash, spec, actor: reference(actor), policySha256: policyHash(settings), requirementsRevision: task.projectTask?.requirements.revision ?? null, status: 'authorized', createdAt: Date.now() }
    attempt.release = row
    let token
    try {
      token = rt.projectEffects.stage({ kind: 'release.execute', key: row.id, projectId: task.projectId, taskId: task.id, payload: { attemptId: attempt.id, releaseId: row.id } })
      row.effect = token
      await authority(attempt, task, row)
      await rt.projectEffects.persist(token)
    } catch (error) { if (!token || rt.projectEffects.discardUncommitted(token)) delete attempt.release; throw error }
    rt.projectScheduler?.wake()
    return { release: view(row) }
  }
  async function reconcile(body, actor) {
    const { attempt, task } = attemptOf(body.attemptId), row = attempt.release
    rt.requireProjectAccess(actor, task.projectId, 'configure')
    if (!row || !/^[A-Za-z0-9_-]{1,100}$/.test(body.requestId ?? '') || rt.readOnly?.() !== undefined) throw fail('Reconciliation needs an authorized request and stable requestId')
    const token = rt.projectEffects.stage({ kind: 'release.reconcile', key: `${row.id}:${body.requestId}`, projectId: task.projectId, taskId: task.id, payload: { attemptId: attempt.id, releaseId: row.id } })
    await rt.projectEffects.persist(token); rt.projectScheduler?.wake()
    return { release: view(row), reconciliation: token }
  }
  async function verify(attempt) {
    const row = attempt.release
    if (!isVerified(attempt)) throw fail('A verified release result is required for Chief closure')
    const { task } = attemptOf(attempt.id)
    const settings = await authority(attempt, task, row)
    const proof = await providerFactory(settings).inspect(row.spec, () => authority(attempt, task, row))
    checkProof(row, proof)
    if (proof.releaseId !== row.proof.releaseId || proof.publishedAt !== row.proof.publishedAt) throw fail('Published release identity changed before closure')
    await authority(attempt, task, row)
    return structuredClone(row.proof)
  }
  function isVerified(attempt) {
    const row = attempt?.release, token = row?.observationEffect
    const effect = token && ownEntry(rt.state.projectEffects ?? {}, token.id)
    return Boolean(row?.status === 'observed' && hash(row.proof) === row.proofSha256 && rt.projectEffects?.intentCommitted(token) && effect?.status === 'done' && effect.receipt?.proofSha256 === row.proofSha256)
  }
  return { verify, isVerified, endpoint(endpoint, body, actor) {
    if (endpoint === 'project-release-request') return serial(() => request(body, actor))
    if (endpoint === 'project-release-reconcile') return serial(() => reconcile(body, actor))
    if (endpoint === 'project-release-status') { const { attempt } = attemptOf(body.attemptId); rt.requireProjectAccess(actor, attempt.projectId); return { release: view(attempt.release) } }
  } }
}
