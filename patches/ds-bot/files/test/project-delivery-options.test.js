import assert from 'node:assert/strict'
import { test } from 'node:test'
import { deliveryScope, deliveryChoices, requireAttemptAcceptance, requireNextAttempt } from '../src/host/project-delivery-options.js'
function fixture() {
  const task = { id: 't', projectId: 'p', title: 'Goal', criteria: 'All requirements', status: 'result-ready', deliveryAttemptId: 'a', collaboration: { generation: 3 } }
  const a = { id: 'a', projectId: 'p', taskId: 't', status: 'waiting-acceptance', requirement: { title: task.title, criteria: task.criteria }, candidateSha: 'sha', pr: { number: 1 }, evidence: { tests: { sha: 'sha', passed: true }, review: { sha: 'sha', verdict: 'approve' } } }
  return { task, a, state: { projectAttempts: { a } } }
}
test('delivery choices describe preconditions without choosing a business action or granting authority', () => {
  const { task, a, state } = fixture(), before = JSON.stringify(state)
  const choices = deliveryChoices(state, task, { status: 'observed', merged: true })
  assert.equal(choices.recommendation, null)
  assert.equal(choices.actions.find(row => row.action === 'accept-attempt').status, 'ready')
  assert.equal(choices.actions.find(row => row.action === 'return').status, 'blocked')
  assert.equal(choices.actions.find(row => row.action === 'start-next').status, 'blocked')
  assert.equal(choices.actions.find(row => row.action === 'close').status, 'unknown')
  assert.match(choices.actions.find(row => row.action === 'needs-human').reason, /Last resort/)
  assert.equal(JSON.stringify(state), before)
  a.status = 'accepted'; a.settlement = { completed: 'one result' }
  assert.doesNotThrow(() => requireNextAttempt(task, a))
})
test('unknown provider result and absent evidence never imply acceptance', () => {
  const { task, a, state } = fixture()
  assert.equal(deliveryChoices(state, task, { status: 'unknown' }).actions[0].status, 'unknown')
  assert.equal(deliveryChoices(state, task, { status: 'observed', merged: false }).actions[0].status, 'blocked')
  delete a.evidence.tests
  assert.equal(deliveryChoices(state, task, null).actions[0].status, 'blocked')
})
for (const field of ['terminal', 'cancelled', 'superseded', 'foreign', 'status', 'requirement', 'review', 'tests', 'kind']) test('shared acceptance guard refuses ' + field, () => {
  const { task, a } = fixture()
  if (field === 'terminal') task.status = 'accepted'
  if (field === 'cancelled') a.cancelRequested = true
  if (field === 'superseded') a.supersededBy = 'b'
  if (field === 'foreign') a.projectId = 'other'
  if (field === 'status') a.status = 'failed'
  if (field === 'requirement') delete a.requirement
  if (field === 'review') a.evidence.review.sha = 'old'
  if (field === 'tests') a.evidence.tests.passed = false
  if (field === 'kind') task.projectTaskKind = 'release'
  assert.throws(() => requireAttemptAcceptance(task, a))
})
test('scoped fingerprints ignore unrelated history but bind relevant revisions and evidence', () => {
  const { state, task, a } = fixture(), scope = deliveryScope(state, task)
  state.unrelated = { revision: 10 }; task.lastMeaningfulProgressAt = Date.now()
  assert.equal(deliveryScope(state, task), scope)
  a.evidence.review.summary = 'Changed evidence'
  assert.notEqual(deliveryScope(state, task), scope)
  task.projectTask = { requirements: { revision: 1 } }
  assert.doesNotThrow(() => requireAttemptAcceptance(task, a))
  assert.throws(() => requireNextAttempt(task, a), /Accept the current/)
})

test('accepted state without scoped settlement cannot grant next delivery and recommendations remain explicit history', () => {
  const { task, a, state } = fixture()
  a.status = 'accepted'; assert.throws(() => requireNextAttempt(task, a), /Accept the current/)
  a.status = 'waiting-acceptance'; assert.throws(() => requireNextAttempt(task, a), /Accept the current/)
  a.evidence.merge = { scope: 'provider-confirmed-merge-observation', sha: a.candidateSha }
  assert.equal(deliveryChoices(state, task).actions[1].status, 'blocked')
  task.chiefRecommendationId = 'decision'
  state.projectChiefDecisions = { decision: { id: 'decision', taskId: task.id, status: 'applied', action: 'continue', reason: 'Inspect evidence', expectedScope: 'previous' } }
  const recommendation = deliveryChoices(state, task).recommendation
  assert.equal(recommendation.action, 'continue'); assert.equal(recommendation.alreadyApplied, true)
  delete state.projectAttempts.a
  assert.throws(() => requireAttemptAcceptance(task), /current unfinished/)
})

test('input identity changes invalidate the scope without depending on insertion order or delivery bookkeeping', () => {
  const { state, task, a } = fixture()
  const one = { id: 'one', projectId: 'p', taskId: 't', sha256: 'one-hash', status: 'accepted', source: { kind: 'human' } }, two = { ...one, id: 'two', sha256: 'two-hash' }
  state.projectTaskInputs = { two, one, foreign: { ...one, id: 'foreign', projectId: 'another' } }
  const first = deliveryScope(state, task)
  state.projectTaskInputs = { one, two }; one.deliveries = [{ batchId: 'injected' }]
  assert.equal(deliveryScope(state, task), first)
  two.status = 'cancelled'; assert.notEqual(deliveryScope(state, task), first)
  delete a.requirement; assert.throws(() => requireAttemptAcceptance(task, a), /snapshot is unavailable/)
})

test('queued next-admission facts are scoped and ordered, and state changes invalidate a prior choice', () => {
  const { state, task } = fixture()
  const entry = { projectId: 'p', taskId: 't', status: 'failed', reason: 'Target advanced', continuation: { mode: 'next', previousAttemptId: 'a', expectedBaseSha: 'base' } }
  state.projectQueue = { z: { ...entry, id: 'z' }, a: { ...entry, id: 'a', status: 'waiting' }, foreign: { ...entry, id: 'foreign', taskId: 'other' } }
  const choices = deliveryChoices(state, task)
  assert.deepEqual(choices.admission.map(row => row.id), ['a', 'z'])
  state.projectQueue.a.status = 'blocked'
  assert.notEqual(deliveryScope(state, task), choices.expectedScope)
})

test('historical Attempt requirements are advisory differences, with bounded facts and the existing disclosure source', () => {
  const { state, task, a } = fixture()
  a.requirement.projectTaskRevision = 2; a.requirement.impact = 'Initial impact'; a.requirement.scope = 'Initial scope'
  task.projectTask = { requirements: { revision: 4, impact: 'Expanded impact', scope: 'Remaining goal' } }
  task.title = 'Remaining work'; task.criteria = 'New acceptance criteria'
  const choices = deliveryChoices(state, task, { status: 'observed', merged: true })
  assert.equal(choices.actions[0].status, 'ready')
  assert.deepEqual(choices.requirements.changedFields, ['revision', 'title', 'criteria', 'impact', 'scope'])
  assert.equal(choices.requirements.attemptRevision, 2); assert.equal(choices.requirements.taskRevision, 4)
  assert.equal(choices.requirements.priorValues.criteria, 'All requirements')
  assert.equal(choices.requirements.source.query, 'attempt.context')
  assert.match(choices.requirements.notice, /not.*Task completion/)
  assert.doesNotThrow(() => requireAttemptAcceptance(task, a))
})

test('legacy matching requirements keep the advisory compact and absent snapshots stay unknown', () => {
  const { state, task, a } = fixture()
  assert.deepEqual(deliveryChoices(state, task).requirements.changedFields, [])
  assert.deepEqual(deliveryChoices(state, task).requirements.priorValues, {})
  delete a.requirement
  assert.equal(deliveryChoices(state, task).requirements, null)
})

for (const field of ['title', 'criteria']) test('scoped acceptance still requires a valid pinned ' + field, () => {
  const { task, a } = fixture()
  delete a.requirement[field]
  assert.throws(() => requireAttemptAcceptance(task, a), /snapshot is unavailable/)
})
