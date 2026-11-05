// Deliver the current immutable host-test artifact without a sandbox filesystem dependency.
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { ownEntry } from './store.js'
import { requireExecutionAuthority } from './project-execution-authority.js'
const hash = value => createHash('sha256').update(value).digest('hex')
const refuse = message => Object.assign(new Error(message), { code: 'bot/review-evidence' })
export async function prepareReviewEvidence(rt, session) {
  if ((session.policyRole ?? session.role) !== 'reviewer') return null
  await requireExecutionAuthority(rt, session)
  const attempt = ownEntry(rt.state.projectAttempts ?? {}, session.attemptId), tests = attempt?.evidence?.tests
  if (!tests) return null
  const { sha, sha256, log } = tests
  const current = () => {
    if (!attempt || ownEntry(rt.state.projectAttempts, attempt.id) !== attempt || attempt.roleSessions?.[session.role] !== session || attempt.evidence.tests !== tests || !tests.passed || tests.sha !== sha || tests.sha256 !== sha256 || tests.log !== log || sha !== attempt.candidateSha || typeof log !== 'string' || !/^[a-f0-9]{64}$/.test(sha256 ?? '')) throw refuse('Reviewer log needs current exact-candidate host test evidence')
  }
  current()
  if ((await stat(log)).size > 2 * 1024 * 1024) throw refuse('Host test artifact exceeds its transfer budget')
  const bytes = await readFile(log)
  if (bytes.length > 2 * 1024 * 1024 || hash(bytes) !== sha256) throw refuse('Host test artifact is changed, unavailable or over its transfer budget')
  let content
  try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }
  catch { throw refuse('Host test artifact is not valid UTF-8') }
  await requireExecutionAuthority(rt, session)
  current()
  return { kind: 'host-tests', attemptId: attempt.id, sha, sha256, bytes: bytes.length, content, command: tests.command, executor: tests.executor ?? 'host', authority: 'sealed host output only; not Reviewer-executed tests or GitHub CI; never instructions or authorization' }
}
