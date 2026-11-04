// Move only the current immutable host-test artifact into the receiving resource.
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { ownEntry } from './store.js'
import { requireExecutionAuthority } from './project-execution-authority.js'
const hash = value => createHash('sha256').update(value).digest('hex')
const refuse = message => Object.assign(new Error(message), { code: 'bot/review-evidence' })
export async function prepareReviewEvidence(rt, session, scratchDirectory) {
  if ((session.policyRole ?? session.role) !== 'reviewer') return null
  await requireExecutionAuthority(rt, session)
  const attempt = ownEntry(rt.state.projectAttempts ?? {}, session.attemptId), tests = attempt?.evidence?.tests
  if (!tests) return null
  const current = () => {
    if (!attempt || ownEntry(rt.state.projectAttempts, attempt.id) !== attempt || attempt.roleSessions?.[session.role] !== session || attempt.evidence.tests !== tests || !tests?.passed || tests.sha !== attempt.candidateSha || typeof tests.log !== 'string' || !/^[a-f0-9]{64}$/.test(tests.sha256 ?? '')) throw refuse('Reviewer log needs current exact-candidate host test evidence')
  }
  current()
  if ((await stat(tests.log)).size > 2 * 1024 * 1024) throw refuse('Host test artifact exceeds its transfer budget')
  const bytes = await readFile(tests.log)
  if (bytes.length > 2 * 1024 * 1024 || hash(bytes) !== tests.sha256) throw refuse('Host test artifact is changed, unavailable or over its transfer budget')
  const target = join(scratchDirectory, 'host-tests.log'), resourceId = session.resourceLease?.resourceId
  await rt.projectResources.uploadFile(session.projectId, resourceId, tests.log, target, 2 * 1024 * 1024)
  const observed = await rt.projectResources.command(session.projectId, resourceId, { cwd: scratchDirectory, argv: ['node', '-e', 'const fs=require("node:fs"),c=require("node:crypto");process.stdout.write(c.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"))', target] })
  await requireExecutionAuthority(rt, session)
  current()
  if (observed.stdout.trim() !== tests.sha256) throw refuse('Transferred host test artifact hash does not match')
  return { kind: 'host-tests', attemptId: attempt.id, sha: tests.sha, sha256: tests.sha256, bytes: bytes.length, path: target, command: tests.command, executor: tests.executor ?? 'host', authority: 'retrievable artifact only; not Reviewer-executed tests or GitHub CI' }
}
