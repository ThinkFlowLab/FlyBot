import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile, rm, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { prepareReviewEvidence } from '../src/host/project-review-evidence.js'
const exec = promisify(execFile), hash = bytes => createHash('sha256').update(bytes).digest('hex')
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'review-evidence-')), scratch = join(root, 'scratch'), log = join(root, 'host.log'), text = 'Actual host command output\n'
  await mkdir(scratch); await writeFile(log, text)
  t.after(() => rm(root, { recursive: true, force: true }))
  const claim = { id: 'claim', workerId: 'worker', botId: 'p:reviewer', status: 'active', attemptId: 'a', generation: 2 }
  const session = { id: 's', projectId: 'p', taskId: 't', attemptId: 'a', role: 'reviewer', botId: 'worker', generation: 2, poolClaimId: 'claim', resourceLease: { id: 'lease', resourceId: 'resource' } }
  const tests = { sha: 'a'.repeat(40), sha256: hash(text), log, passed: true, command: ['node', '--test'] }
  const attempt = { id: 'a', projectId: 'p', taskId: 't', candidateSha: tests.sha, roleSessions: { reviewer: session }, evidence: { tests } }
  let revoked = false
  const rt = { state: { tasks: { t: { id: 't', projectId: 'p', deliveryAttemptId: 'a', collaboration: { initiatedBy: 'owner', generation: 2, claim } } }, projectAttempts: { a: attempt } }, projects: { requireActive() {} }, requireProjectAccess() { if (revoked) throw Error('revoked') }, projectDelegations: { background: async () => {} }, projectResources: { requireBinding() { return { harnesses: ['flybot'], type: 'local' } }, uploadFile: async (_p, _r, source, target) => copyFile(source, target), command: async (_p, _r, { argv, cwd }) => exec(argv[0], argv.slice(1), { cwd }) } }
  return { rt, session, tests, attempt, scratch, text, revoke() { revoked = true } }
}
test('Reviewer receives hash-verified host log in writable scratch with exact candidate provenance', async t => {
  const f = await fixture(t), result = await prepareReviewEvidence(f.rt, f.session, f.scratch)
  assert.equal(await readFile(result.path, 'utf8'), f.text); assert.equal(result.sha256, f.tests.sha256)
  assert.equal(result.sha, f.attempt.candidateSha); assert.equal(result.executor, 'host')
  assert.match(result.authority, /not Reviewer-executed/)
  assert.notEqual(result.path, f.tests.log)
  f.session.role = 'developer'; assert.equal(await prepareReviewEvidence(f.rt, f.session, f.scratch), null)
})
test('Review log transfer refuses stale SHA, changed bytes, changed source and current revocation', async t => {
  const f = await fixture(t), copy = f.rt.projectResources.uploadFile
  f.tests.sha = 'b'.repeat(40); await assert.rejects(prepareReviewEvidence(f.rt, f.session, f.scratch), /exact-candidate/); f.tests.sha = f.attempt.candidateSha
  await writeFile(f.tests.log, 'changed'); await assert.rejects(prepareReviewEvidence(f.rt, f.session, f.scratch), /changed/); await writeFile(f.tests.log, f.text)
  f.rt.projectResources.uploadFile = async (...args) => { await copy(...args); await writeFile(args[3], 'changed in transit') }
  await assert.rejects(prepareReviewEvidence(f.rt, f.session, f.scratch), /hash does not match/)
  f.rt.projectResources.uploadFile = async (...args) => { await copy(...args); f.revoke() }
  await assert.rejects(prepareReviewEvidence(f.rt, f.session, f.scratch), /revoked/)
})
test('no host test log remains Not run; oversized transfer is refused', async t => {
  const f = await fixture(t)
  delete f.attempt.evidence.tests; assert.equal(await prepareReviewEvidence(f.rt, f.session, f.scratch), null)
  f.attempt.evidence.tests = f.tests
  await writeFile(f.tests.log, Buffer.alloc(2 * 1024 * 1024 + 1))
  await assert.rejects(prepareReviewEvidence(f.rt, f.session, f.scratch), /transfer budget/)
})

test('artifact source replacement while copying cannot inherit the old verified log', async t => {
  const f = await fixture(t), copy = f.rt.projectResources.uploadFile
  f.rt.projectResources.uploadFile = async (...args) => { await copy(...args); f.attempt.evidence.tests = { ...f.tests } }
  await assert.rejects(prepareReviewEvidence(f.rt, f.session, f.scratch), /current exact-candidate/)
})
