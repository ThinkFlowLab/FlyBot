import assert from 'node:assert/strict'
import { test } from 'node:test'
import { autonomyPolicy, operationsContact, assistanceRequest, assistanceScope, consultationCurrent, compensationSchedules, assistanceFacts } from '../src/host/project-chief-assistance.js'
import { parseChiefResponse } from '../src/host/project-chief-protocol.js'
const help = { cause: 'Runner unavailable', evidence: 'candidate abc / exit127', attempted: 'Verified clean and preparation', requestedOperation: 'Provision the approved runner', requiredPermission: 'Separate host operator grant', verification: 'Retest the same candidate', resumeCondition: 'Confirmed old exit and passing readiness' }
test('operations assistance is explicit, structured and budgeted guidance, never a fixed recovery route', () => {
  assert.equal(autonomyPolicy().maxRecoveryActions, 4)
  for (const invalid of [{ maxRecoveryActions: -1 }, { maxRecoveryMs: 0 }, { guidance: 'x'.repeat(8001) }, { route: 'developer' }]) assert.throws(() => autonomyPolicy(invalid), /Invalid/)
  assert.equal(assistanceRequest({ recipient: 'initiator' }), null)
  assert.equal(assistanceRequest({ recipient: 'operations', assistance: help }).version, 'chief-assistance/v1')
  for (const decision of [{ recipient: 'other' }, { recipient: 'operations' }, { recipient: 'operations', assistance: { ...help, cause: '' } }]) assert.throws(() => assistanceRequest(decision), /recipient|assistance/)
  assert.throws(() => parseChiefResponse(JSON.stringify({ summary: 'ask', decisions: [{ taskId: 't', action: 'needs-human', reason: 'Need operator', recipient: 'operations' }] }), []), /assistance/)
})
test('operations contact requires current manager scope and an explicit active owned participation', () => {
  const identity = { id: 'ops-agent', status: 'active', ownerId: 'operator' }, participation = { ownerId: 'operator', status: 'active' }
  let manager = true
  const rt = { personalAgents: { agentOf: () => identity, participationFor: () => participation }, projectCan: () => manager }
  const contact = { memberId: 'operator', agentId: 'ops-agent' }
  assert.deepEqual(operationsContact(rt, 'p', contact), contact)
  manager = false; assert.throws(() => operationsContact(rt, 'p', contact), /Owner\/Maintainer/)
  manager = true; participation.status = 'left'; assert.throws(() => operationsContact(rt, 'p', contact), /participation/)
  assert.throws(() => operationsContact(rt, 'p', { ...contact, root: true }), /explicit/)
})
test('same decision cannot authorize delayed replies after generation, requirements, candidate or recipient changes', () => {
  const state = { projectChiefPolicies: { p: { operationsContact: { memberId: 'ops', agentId: 'a' } } }, projectAttempts: { a: { candidateSha: 'sha' } } }
  const task = { id: 't', projectId: 'p', title: 'Fix', criteria: 'pass', status: 'open', deliveryAttemptId: 'a', collaboration: { generation: 3 }, projectTask: { requirements: { revision: 2 } }, chiefQuestion: { decisionId: 'd' } }
  const row = { projectId: 'p', chiefDecisionId: 'd', assistanceScope: assistanceScope(state, task, 'operations') }
  assert.equal(consultationCurrent(state, row, task), true)
  for (const mutate of [() => task.collaboration.generation++, () => task.projectTask.requirements.revision++, () => task.criteria = 'changed', () => state.projectAttempts.a.candidateSha = 'new', () => state.projectChiefPolicies.p.operationsContact.agentId = 'other']) {
    const snapshot = structuredClone({ state, task }); mutate(); assert.equal(consultationCurrent(state, row, task), false); Object.assign(state, snapshot.state); Object.assign(task, snapshot.task)
  }
  task.status = 'cancelled'; assert.equal(consultationCurrent(state, row, task), false)
})
test('assistance observability exposes status and original scheduled next check without private text', () => {
  const state = { personalAgentParticipations: { part: { carrierId: 'c' } }, projectAgentTranscripts: { c: [{ id: 'q', projectId: 'p', chiefDecisionId: 'd', text: 'PRIVATE', inbox: { phase: 'processing', claim: { expiresAt: 9000 } }, notificationEffect: { id: 'e' } }] }, projectEffects: { e: { status: 'pending', executions: 2, dueAt: 8000 } }, projectScheduledTasks: { hourly: { id: 'hourly', projectId: 'p', target: { kind: 'project-chief' }, enabled: true, status: 'active', nextDueAt: 12000, config: { when: { kind: 'every', seconds: 3600 } }, deliveries: {} } } }
  const facts = assistanceFacts(state, { projectId: 'p', chiefQuestion: { decisionId: 'd', recipient: { participationId: 'part', consultationId: 'q' } } })
  assert.equal(facts.claimExpiresAt, 9000); assert.equal(facts.notification.attempts, 2)
  assert.ok(!JSON.stringify(facts).includes('PRIVATE'))
  assert.equal(compensationSchedules(state, 'p', 'primary')[0].nextCheckAt, 12000)
})
