import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createProjectEffects } from '../src/host/project-effects.js'
import { createProjectReleases } from '../src/host/project-releases.js'
const sha = 'a'.repeat(40), actor = { memberId: 'owner-1' }
function fixture(t) {
  const task = { id: 't', projectId: 'p', projectTaskKind: 'release', deliveryAttemptId: 'a', projectTask: { requirements: { revision: 1 } } }
  const attempt = { id: 'a', taskId: 't', projectId: 'p', baseSha: sha, status: 'running', requirement: { repository: 'org/repo', projectTaskRevision: 1 } }
  const project = { id: 'p', ownerUserId: 'owner-1', repository: 'org/repo' }
  const rt = { state: { tasks: { t: task }, projectAttempts: { a: attempt } }, config: { projectRepositories: { 'org/repo': { path: '/provisioned/repo', allowedPaths: ['src'], testCommand: ['node', '--test'], release: { provider: 'github', enabled: true } } } },
    readOnly: () => undefined, requireProjectAccess(who, id) { if (rt.revoked || who.memberId !== actor.memberId || id !== 'p') throw new Error('Denied') },
    projectDelegations: { background: async () => true }, projectTaskLifecycle: { requireExecutable() {} } }
  rt.projectEffects = createProjectEffects(rt)
  rt.save = async () => { if (!rt.noCommit) rt.projectEffects.saved(rt.projectEffects.capture()) }
  let published, count = 0
  const provider = { inspect: async () => { if (rt.revokeDuringInspect) rt.revoked = true; return published }, publish: async spec => {
    count++
    if (rt.rejectPublish) throw Object.assign(new Error('Rejected'), { code: 'release/rejected' })
    if (!rt.noArtifact) published = { provider: 'github', repository: spec.repository, sha: spec.sha, tag: spec.tag, releaseId: 42, publishedAt: '2026-11-03T00:00:00Z', marker: true }
    if (rt.loseResponse) throw new Error('Response lost')
  } }
  const service = createProjectReleases(rt, { projectOf: () => project, providerFactory: () => provider })
  t.after(() => rt.projectEffects.close())
  const body = { attemptId: 'a', requestId: 'release-one', tag: 'v1.0', sha, mode: 'publish' }
  return { rt, task, attempt, service, provider, body, count: () => count, changeProof: change => { published = { ...published, ...change } } }
}
test('explicit release intent commits before one publication, duplicates replay, and Chief verifies current external proof', async t => {
  const f = fixture(t)
  await f.service.endpoint('project-release-request', f.body, actor)
  assert.equal(f.count(), 0)
  await f.rt.projectEffects.drain()
  assert.equal(f.count(), 1); assert.equal(f.attempt.release.status, 'observed')
  assert.equal((await f.service.endpoint('project-release-request', f.body, actor)).already, true)
  await f.rt.projectEffects.drain(); assert.equal(f.count(), 1)
  assert.equal((await f.service.verify(f.attempt)).sha, sha)
  await assert.rejects(f.service.endpoint('project-release-request', { ...f.body, tag: 'v2' }, actor), /already exists/)
  f.changeProof({ sha: 'b'.repeat(40) }); await assert.rejects(f.service.verify(f.attempt), /proof/)
  assert.equal(f.task.status, undefined, 'Release evidence alone never closes a Task')
})
test('lost publication responses reconcile the existing artifact without a second POST', async t => {
  const f = fixture(t); f.rt.loseResponse = true
  await f.service.endpoint('project-release-request', f.body, actor); await f.rt.projectEffects.drain()
  assert.equal(f.attempt.release.status, 'unknown'); assert.equal(f.count(), 1)
  await f.service.endpoint('project-release-reconcile', { attemptId: 'a', requestId: 'inspect-one' }, actor); await f.rt.projectEffects.drain()
  assert.equal(f.attempt.release.status, 'observed'); assert.equal(f.count(), 1)
})
test('an unknown absent external result stays unknown and retries never republish', async t => {
  const f = fixture(t); f.rt.loseResponse = true; f.rt.noArtifact = true
  await f.service.endpoint('project-release-request', f.body, actor); await f.rt.projectEffects.drain()
  await f.service.endpoint('project-release-reconcile', { attemptId: 'a', requestId: 'inspect-two' }, actor); await f.rt.projectEffects.drain()
  assert.equal(f.attempt.release.status, 'unknown'); assert.equal(f.count(), 1)
  await assert.rejects(f.service.verify(f.attempt), /verified release/)
})
test('revocation before or during observation fences publication and unconfirmed saves cannot authorize I/O', async t => {
  for (const phase of ['before', 'during', 'save']) {
    const f = fixture(t)
    if (phase === 'save') {
      f.rt.noCommit = true
      await assert.rejects(f.service.endpoint('project-release-request', f.body, actor), /commit/)
      assert.equal(f.attempt.release, undefined)
    } else {
      await f.service.endpoint('project-release-request', f.body, actor)
      if (phase === 'before') f.rt.revoked = true; else f.rt.revokeDuringInspect = true
      await f.rt.projectEffects.drain()
      assert.equal(f.attempt.release.status, 'revoked')
    }
    assert.equal(f.count(), 0)
  }
})
test('observe mode is read-only, rejected publication is distinct from unknown, and stale requirements cannot close', async t => {
  const observer = fixture(t)
  await observer.service.endpoint('project-release-request', { ...observer.body, mode: 'observe' }, actor); await observer.rt.projectEffects.drain()
  assert.equal(observer.attempt.release.status, 'awaiting-artifact'); assert.equal(observer.count(), 0)
  const failed = fixture(t); failed.rt.rejectPublish = true
  await failed.service.endpoint('project-release-request', failed.body, actor); await failed.rt.projectEffects.drain()
  assert.equal(failed.attempt.release.status, 'failed')
  const stale = fixture(t)
  await stale.service.endpoint('project-release-request', stale.body, actor); await stale.rt.projectEffects.drain()
  stale.task.projectTask.requirements.revision++
  await assert.rejects(stale.service.verify(stale.attempt), /requirements/)
  const denied = fixture(t)
  await assert.rejects(denied.service.endpoint('project-release-request', denied.body, { memberId: 'member' }), /Denied/)
  await assert.rejects(denied.service.endpoint('project-release-request', denied.body, { ...actor, chiefJobId: 'chief' }), /not release authorization/)
})
