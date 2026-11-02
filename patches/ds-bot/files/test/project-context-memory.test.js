import assert from 'node:assert/strict'
import { test } from 'node:test'
import { stageRoleSummary, rollbackRoleSummary, readRoleSummary } from '../src/host/project-context-memory.js'
const fixture = () => {
  const task = { id: 't', projectId: 'p', title: 'Repair the behavior', criteria: 'Preserve the safety boundary' }
  const claim = { id: 'claim-one', projectId: 'p', taskId: 't', attemptId: 'a', botId: 'p:developer', generation: 1, status: 'completed' }
  const state = { tasks: { t: task }, projectAttempts: { a: { projectId: 'p', taskId: 't', candidateSha: 'a'.repeat(40), evidence: { tests: { sha: 'b'.repeat(40), passed: true } } } } }
  return { state, task, claim, role: 'developer', summary: { completed: 'Implementation candidate prepared', next: 'Run independent tests' }, receiptId: 'handoff-one' }
}

test('Task-role summaries keep scoped evidence, uncertainty and immutable previous versions without upgrading claims', () => {
  const input = fixture()
  stageRoleSummary(input.state, input)
  const first = readRoleSummary(input.state, 'p', 't', 'developer')
  assert.equal(first.progress.classification, 'role-claim')
  assert.equal(first.evidence.tests.status, 'stale')
  assert.equal(first.evidence.tests.passed, false)
  assert.equal(first.next.text, 'Run independent tests')
  assert.equal(first.requirements.taskId, 't')
  assert.equal(readRoleSummary(input.state, 'other', 't', 'developer'), null)
  assert.equal(readRoleSummary(input.state, 'p', 't', 'reviewer'), null)
  const duplicate = stageRoleSummary(input.state, input)
  assert.equal(duplicate.changed, false)
  const next = { ...input, claim: { ...input.claim, id: 'claim-two', generation: 2 }, summary: { completed: 'Addressed the failed case', next: 'Request review' }, receiptId: 'handoff-two' }
  stageRoleSummary(input.state, next)
  const current = readRoleSummary(input.state, 'p', 't', 'developer')
  assert.equal(current.revision, 2)
  assert.equal(current.previousSha256, first.sha256)
  const stored = input.state.projectRoleMemory[current.id]
  assert.equal(stored.versions.length, 1)
  assert.match(stored.versions[0].text, /Implementation candidate/)
  assert.equal(stored.versions[0].versions, undefined)
})

test('failed/invalid consolidation leaves the last valid summary and never overwrites a concurrent update', () => {
  const input = fixture()
  stageRoleSummary(input.state, input)
  const first = readRoleSummary(input.state, 'p', 't', 'developer')
  assert.throws(() => stageRoleSummary(input.state, { ...input, task: { ...input.task, projectId: 'other' } }), /scope/)
  assert.equal(readRoleSummary(input.state, 'p', 't', 'developer').sha256, first.sha256)
  const next = { ...input, claim: { ...input.claim, id: 'claim-two' }, receiptId: 'handoff-two' }
  const candidate = stageRoleSummary(input.state, next)
  assert.equal(rollbackRoleSummary(input.state, candidate), true)
  assert.equal(readRoleSummary(input.state, 'p', 't', 'developer').sha256, first.sha256)
  const latest = stageRoleSummary(input.state, next)
  input.state.projectRoleMemory[latest.id].status = 'archived'
  assert.equal(rollbackRoleSummary(input.state, latest), false)
  input.state.projectRoleMemory[latest.id].text += 'tampered'
  assert.throws(() => readRoleSummary(input.state, 'p', 't', 'developer'), /changed/)
})

test('resident Chief working topics remain separate, bounded and retrievable across later turns', async () => {
  const { chiefSummarySources } = await import('../src/host/project-context-memory.js')
  const { buildProjectContext, readContextArchive } = await import('../src/host/project-role-context.js')
  const input = fixture()
  input.state.projectAgents = { 'public-p': { id: 'public-p', projectId: 'p', visibility: 'public' } }
  stageRoleSummary(input.state, { ...input, role: 'chief' })
  const other = { ...input.task, id: 'second', title: 'Handle another topic' }
  input.state.tasks.second = other
  stageRoleSummary(input.state, { ...input, task: other, role: 'chief', claim: { ...input.claim, id: 'another-claim', taskId: other.id, attemptId: 'another-attempt' }, summary: { completed: 'Second topic remains unresolved', next: 'Ask about its separate boundary' }, receiptId: 'second-receipt' })
  assert.equal(chiefSummarySources(input.state, 'p').length, 2)
  assert.deepEqual(chiefSummarySources(input.state, 'foreign'), [])
  const rt = { state: input.state, config: { projectContext: { defaults: { windowTokens: 16000, summaryTokens: 3500 } } }, readProject: id => ({ id, goal: 'Preserve project continuity', scope: 'Authorized changes only' }) }
  const context = await buildProjectContext(rt, { projectId: 'p', role: 'chief', definition: { instructions: 'Keep unresolved questions visible' }, focus: 'Second topic boundary', retrieval: true })
  assert.ok(context.text.includes('Second topic remains unresolved'))
  assert.equal(context.archive.summary.length, 2)
  const source = chiefSummarySources(input.state, 'p')[0]
  let offset = 0, raw = '', pages = 0
  for (;;) {
    const page = readContextArchive(context, [{ kind: 'summary', id: source.id, offset }], { projectId: 'p', role: 'chief' })[0]
    raw += page.text; pages++
    if (page.nextOffset === null) break
    assert.ok(page.nextOffset > offset)
    assert.ok(pages < 20)
    offset = page.nextOffset
  }
  assert.match(raw, /handoff-one/)
  assert.ok(context.usage.layers.summary <= 3500)
})

test('role execution experience stays unverified, versions its source and cannot overwrite an approved human fact', async () => {
  const { stageExecutionMemory, stagePublicRoleMemory } = await import('../src/host/project-context-memory.js')
  const input = fixture()
  const note = { ...input, requestId: 'remember-one', factKey: 'test-boundary', text: 'A negative case may need an independent host run' }
  const first = stageExecutionMemory(input.state, note)
  assert.equal(first.row.classification, 'inference')
  assert.equal(first.row.source.independentlyVerified, false)
  assert.equal(stageExecutionMemory(input.state, note).changed, false)
  assert.throws(() => stageExecutionMemory(input.state, { ...note, text: 'Changed same request' }), /intent/)
  assert.throws(() => stageExecutionMemory(input.state, { ...note, classification: 'fact' }), /verified facts/)
  assert.throws(() => stageExecutionMemory(input.state, { ...note, text: 'sk-unitsecret123456789012345' }), /secrets/)
  const next = stageExecutionMemory(input.state, { ...note, claim: { ...input.claim, id: 'next-role-claim' }, text: 'The hypothesis still needs confirmation', classification: 'unresolved' })
  assert.equal(next.row.versions.length, 1)
  stagePublicRoleMemory(input.state, { projectId: 'p', body: { role: 'developer', memoryId: first.id, text: 'Use the verified host check', classification: 'fact', source: { kind: 'human', reference: 'Reviewed test evidence' } }, actor: { memberId: 'owner' }, idFactory: () => 'unused' })
  assert.throws(() => stageExecutionMemory(input.state, { ...note, claim: { ...input.claim, id: 'third-role-claim' } }), /Human-controlled/)
})

test('first summary and experience staging can roll back, while concurrent memory changes are retained', async () => {
  const { stageExecutionMemory, rollbackExecutionMemory } = await import('../src/host/project-context-memory.js')
  const input = fixture(), staged = stageRoleSummary(input.state, input)
  assert.equal(rollbackRoleSummary(input.state, staged), true)
  assert.equal(readRoleSummary(input.state, 'p', 't', 'developer'), null)
  const note = { ...input, requestId: 'one-note', factKey: 'scope', text: 'A claim needs current authority' }
  const first = stageExecutionMemory(input.state, note)
  assert.equal(rollbackExecutionMemory(input.state, first), true)
  assert.equal(Object.keys(input.state.projectRoleMemory).length, 0)
  stageExecutionMemory(input.state, note)
  const next = stageExecutionMemory(input.state, { ...note, claim: { ...input.claim, id: 'new-claim' }, text: 'A current generation also matters' })
  assert.equal(rollbackExecutionMemory(input.state, next), true)
  const changed = stageExecutionMemory(input.state, { ...note, claim: { ...input.claim, id: 'third-claim' } })
  input.state.projectRoleMemory[changed.id].status = 'archived'
  assert.equal(rollbackExecutionMemory(input.state, changed), false)
  assert.equal(rollbackExecutionMemory(input.state, null), false)
})
