import assert from 'node:assert/strict'
import { test } from 'node:test'
import { childResultSources } from '../src/host/project-child-inputs.js'
import { createTaskContract, taskOutcome } from '../src/host/project-task-lifecycle.js'

function fixture() {
  const parent = { id: 'parent', projectId: 'p', projectTaskKind: 'code', title: 'Integrate independent changes', criteria: 'Integrated candidate passes' }
  const child = { id: 'child', projectId: 'p', projectTaskKind: 'code', title: 'Independent goal', criteria: 'Independent result', status: 'accepted', deliveryAttemptId: 'child-attempt', completedBy: { kind: 'chief', decisionId: 'accepted-child' } }
  for (const row of [parent, child]) createTaskContract(row, { impact: row.title })
  parent.projectTask.dependencies = [{ taskId: child.id, status: 'satisfied', result: { taskId: child.id, decisionId: 'accepted-child', candidateSha: 'a'.repeat(40) } }]
  parent.projectTask.wait = { id: 'wait', status: 'resumed' }
  const attempt = { id: 'child-attempt', taskId: child.id, projectId: 'p', status: 'accepted', acceptedViaChief: 'accepted-child', candidateSha: 'a'.repeat(40), requirement: { repository: 'owner/repo', projectTaskRevision: 1 }, evidence: {
    implementation: { sha: 'a'.repeat(40) }, tests: { sha: 'a'.repeat(40), passed: true, sha256: 'b'.repeat(64) }, review: { sha: 'a'.repeat(40), verdict: 'approve' },
  } }
  const state = { tasks: { parent, child }, projectAttempts: { 'child-attempt': attempt } }
  return { state, parent, child, attempt }
}

test('child sources reference Chief-accepted exact artifacts without claiming they were integrated', () => {
  const f = fixture(), sources = childResultSources(f.state, f.parent, 'owner/repo')
  assert.equal(sources[0].sourceTaskId, 'child')
  assert.equal(sources[0].sha, f.attempt.candidateSha)
  assert.equal(sources[0].outcomeVersion, taskOutcome(f.state, f.child).version)
  assert.match(sources[0].ref, /^refs\/remotes\/operator\/project-child\/[a-f0-9]{40}$/)
  assert.equal(sources[0].integration, 'required')
  assert.equal(sources[0].integrated, false)
  assert.equal(childResultSources(f.state, f.parent, 'another/repo')[0].integration, 'external-repository-reference')
  assert.equal(f.parent.status, undefined)
})

test('foreign, incomplete, stale or model-only child success cannot become an approved source', () => {
  for (const mutate of [
    f => { f.child.projectId = 'foreign' }, f => { f.child.status = 'cancelled' }, f => { f.child.completedBy.kind = 'developer' },
    f => { f.attempt.status = 'running' }, f => { f.attempt.acceptedViaChief = 'different' }, f => { f.attempt.evidence.tests.passed = false },
    f => { f.attempt.evidence.review.sha = '0'.repeat(40) }, f => { f.attempt.requirement.projectTaskRevision = 0 },
    f => { f.parent.projectTask.dependencies[0].result.decisionId = 'old' },
  ]) {
    const f = fixture(); mutate(f)
    assert.throws(() => childResultSources(f.state, f.parent, 'owner/repo'))
  }
})

test('a Chief-approved substitute retains its own outcome scope; a qualitative waiver is not code', () => {
  const f = fixture(), dependency = f.parent.projectTask.dependencies[0]
  dependency.status = 'waived'
  dependency.resolution = { decisionId: 'substitution' }
  dependency.result = { kind: 'chief-resolution', sourceTaskId: f.child.id, replacementTaskId: f.child.id, replacementVersion: taskOutcome(f.state, f.child).version, decisionId: 'substitution', candidateSha: f.attempt.candidateSha }
  assert.equal(childResultSources(f.state, f.parent, 'owner/repo')[0].sourceTaskId, f.child.id)
  dependency.result.replacementVersion = 'stale'
  assert.throws(() => childResultSources(f.state, f.parent, 'owner/repo'), /changed|stale/)
  dependency.result = { kind: 'chief-resolution', sourceTaskId: null, decisionId: 'substitution', evidence: ['Formal parent decision'] }
  assert.equal(childResultSources(f.state, f.parent, 'owner/repo')[0].kind, 'judgement')
  assert.equal(childResultSources(f.state, f.parent, 'owner/repo')[0].sha, undefined)
})
