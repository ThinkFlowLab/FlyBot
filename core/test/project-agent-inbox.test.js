import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createProjectAgentInbox } from '../src/host/project-agent-inbox.js'
import { createProjectEffects } from '../src/host/project-effects.js'

function fixture(kind = 'external', options = {}) {
  let clock = 1000, failSave = false, active = false
  const receipt = { id: 'question', projectId: 'p', version: 'conversation-handoff/v1', direction: 'incoming', initiatedBy: 'owner', returnTo: 'carrier', text: 'Choose an option', requestId: 'decision', chiefDecisionId: 'decision', linkedTaskId: 't', status: 'accepted', at: clock }
  const carrier = { id: 'carrier', memberId: 'owner', personalAgentId: 'agent', participationId: 'participation', projectId: 'p', visibility: 'private' }
  const participation = { id: 'participation', projectId: 'p', agentId: 'agent', ownerId: 'owner', carrierId: 'carrier', status: 'active' }
  const identity = { id: 'agent', ownerId: 'owner', status: 'active', kind }
  const actor = { memberId: 'owner', agentId: 'agent', personalAgentCredentialId: 'credential', personalAgentCredentialGeneration: 1 }
  const state = { projectAgents: { carrier }, projectAgentTranscripts: { carrier: [receipt] }, tasks: { t: { id: 't', projectId: 'p', chiefQuestion: { decisionId: 'decision', recipient: { consultationId: 'question' } } } } }
  const rt = { state, config: { projectAgentInbox: { leaseMs: 1000 } }, readOnly: () => undefined, requireProjectAccess(who, project) { if (who.memberId !== 'owner' || project !== 'p' || participation.status !== 'active') throw Error('denied') }, validateHumanActor: async who => who.memberId === 'owner' && who.personalAgentCredentialGeneration !== 0,
    personalAgents: { agentOf: id => id === 'agent' ? identity : null, participationFor: () => participation, requireParticipation: () => { if (participation.status !== 'active') throw Error('left') } }, projectAgents: { inboxExecutionActive: () => active } }
  rt.projectEffects = createProjectEffects(rt, { now: () => clock })
  rt.save = async () => { if (failSave) throw Error('save failed'); rt.projectEffects.saved(rt.projectEffects.capture()) }
  let publications = 0
  const inbox = createProjectAgentInbox(rt, { parent: async (body, who) => { rt.requireProjectAccess(who, body.projectId); if (body.agentId && body.agentId !== 'agent' || who.agentId && who.agentId !== 'agent') throw Error('scope'); return carrier }, view: () => ({ id: receipt.id }), replyDirect: async body => { if (body.publish) publications++; return { consultation: { id: receipt.id }, replyId: body.requestId, published: Boolean(body.publish) } } }, { now: () => clock, ...options })
  rt.projectEffects.register('consultation.notify', { run: effect => inbox.deliver(effect) })
  rt.projectDelegations = { background: async () => true, forAgent: () => ({ id: 'grant' }) }
  return { inbox, rt, actor, receipt, participation, body: { projectId: 'p', messageId: 'question' }, tick: n => { clock += n }, saveFailure: v => { failSave = v }, active: v => { active = v }, publications: () => publications }
}

for (const kind of ['internal', 'external']) test(`${kind} uses the same durable claim, renewal and result fencing`, async () => {
  const f = fixture(kind), call = (operation, fields = {}, actor = f.actor) => f.inbox.endpoint(operation, { ...f.body, ...fields }, actor)
  assert.equal((await call('list')).items[0].phase, 'pending')
  const claim = await call('claim', { requestId: 'take' })
  await assert.rejects(call('complete', { ...claim.claim, generation: 999, requestId: 'reply', text: 'A' }), /claim|generation/i)
  await assert.rejects(call('claim', { requestId: 'competing' }, { ...f.actor, personalAgentCredentialId: 'other' }), /claim|lease/i)
  const renewed = await call('renew', { ...claim.claim, requestId: 'renew' })
  assert.equal(renewed.claim.generation, claim.claim.generation)
  const result = await call('complete', { ...claim.claim, requestId: 'reply', text: 'A', publish: true })
  assert.equal(result.published, true)
  assert.equal((await call('complete', { ...claim.claim, requestId: 'reply', text: 'A', publish: true })).published, true)
  assert.equal(f.publications(), 1)
  await assert.rejects(call('complete', { ...claim.claim, requestId: 'reply', text: 'B' }), /reused|conflict/i)
})

test('scope, persistence failure, expired claims, revocation and unknown native exit fail closed', async () => {
  const f = fixture(), take = requestId => f.inbox.endpoint('claim', { ...f.body, requestId }, f.actor)
  await assert.rejects(f.inbox.endpoint('list', { ...f.body, agentId: 'other' }, f.actor), /scope/)
  f.saveFailure(true); await assert.rejects(take('unsaved'), /save failed/); f.saveFailure(false)
  const first = await take('first'); f.tick(1001)
  const next = await take('next'); assert.ok(next.claim.generation > first.claim.generation)
  await assert.rejects(f.inbox.endpoint('renew', { ...f.body, ...first.claim, requestId: 'old' }, f.actor), /claim|generation/i)
  f.participation.status = 'left'; await assert.rejects(take('left'), /denied|left/)
  const native = fixture('internal'); const claimed = await native.inbox.endpoint('claim', { ...native.body, requestId: 'first' }, native.actor)
  native.tick(1001); native.active(true)
  await assert.rejects(native.inbox.endpoint('claim', { ...native.body, requestId: 'again' }, native.actor), /exit|active/i)
  native.active(false)
  assert.ok((await native.inbox.endpoint('claim', { ...native.body, requestId: 'again' }, native.actor)).claim.generation > claimed.claim.generation)
})

test('only verified human-selected connections restage the same mailbox notification; failed save cannot enable delivery', async () => {
  const notifications = [], f = fixture('external', { notify: async (_setting, event) => { notifications.push(event); return { received: true } } })
  const carrier = f.rt.state.projectAgents.carrier
  const token = f.inbox.stage(carrier, f.receipt)
  await f.rt.save(); await f.rt.projectEffects.drain()
  assert.equal(f.rt.state.projectEffects[token.id].receipt.status, 'private-mailbox')
  assert.equal(notifications.length, 0)
  f.rt.config.projectAgentWebhooks = { approved: { ownerId: 'owner', agentId: 'agent', projectId: 'p', endpoint: 'https://receiver.example/notify', signingKeyFile: '/private/key' } }
  const body = { projectId: 'p', agentId: 'agent', enabled: true, connectionId: 'approved', requestId: 'enable' }, human = { memberId: 'owner', sessionId: 'human' }
  await assert.rejects(f.inbox.endpoint('connection.configure', body, f.actor), /signed-in human/)
  await assert.rejects(f.inbox.endpoint('connection.configure', { ...body, connectionId: 'foreign' }, human), /not provisioned/)
  f.saveFailure(true); await assert.rejects(f.inbox.endpoint('connection.configure', body, human), /save failed/); f.saveFailure(false)
  assert.equal(f.participation.notification, undefined)
  await f.inbox.endpoint('connection.configure', body, human)
  await f.rt.projectEffects.drain()
  const notification = notifications.find(row => row.type === 'inbox.available')
  assert.equal(notification.messageId, 'question')
  assert.equal(notification.text, undefined)
  assert.equal(notification.token, undefined)
  assert.equal(f.rt.state.projectEffects[token.id].receipt.transport, 'webhook')
  assert.equal((await f.inbox.endpoint('list', { projectId: 'p' }, f.actor)).items[0].phase, 'pending', 'Receiving Webhook never claims or completes a message')
  await f.inbox.endpoint('connection.configure', { ...body, enabled: false, requestId: 'disable' }, human)
  assert.equal((await f.inbox.endpoint('connection', { projectId: 'p' }, f.actor)).connection.enabled, false)
  assert.ok(!JSON.stringify(await f.inbox.endpoint('connection', { projectId: 'p' }, f.actor)).includes('signingKey'))
})

test('native notification contains only a reference and cannot bypass the common claim service', async () => {
  const f = fixture('internal'), carrier = f.rt.state.projectAgents.carrier, delivered = []
  f.rt.personalAgents.carrierId = () => carrier.id
  f.rt.projectAgents.wakeWatch = async (_projectId, _memberId, text, expected) => { assert.equal(expected, carrier.id); delivered.push(text) }
  const token = f.inbox.stage(carrier, f.receipt)
  await f.rt.save(); await f.rt.projectEffects.drain()
  assert.match(delivered[0], /project_agent_inbox/)
  assert.ok(!delivered[0].includes(f.receipt.text))
  assert.equal(f.receipt.inbox, undefined)
  assert.equal(f.rt.state.projectEffects[token.id].receipt.transport, 'native')
  const claimed = await f.inbox.endpoint('claim', { ...f.body, requestId: 'native-claim' }, f.actor)
  await f.inbox.endpoint('fail', { ...f.body, ...claimed.claim, requestId: 'native-fail', retryable: true }, f.actor)
  f.active(true)
  await assert.rejects(f.inbox.endpoint('claim', { ...f.body, requestId: 'cannot-restart' }, f.actor), /exit|active/)
})

test('generation or operations-recipient rotation supersedes an otherwise matching Chief question before claim/reply/delivery', async () => {
  const { assistanceScope } = await import('../src/host/project-chief-assistance.js')
  for (const change of ['generation', 'contact']) {
    const f = fixture(), task = f.rt.state.tasks.t
    task.title = 'Fix runner'; task.collaboration = { generation: 1 }
    f.rt.state.projectChiefPolicies = { p: { operationsContact: { memberId: 'owner', agentId: 'agent' } } }
    f.receipt.assistanceScope = assistanceScope(f.rt.state, task, 'operations')
    const claim = await f.inbox.endpoint('claim', { ...f.body, requestId: 'take' }, f.actor)
    const token = f.inbox.stage(f.rt.state.projectAgents.carrier, f.receipt); await f.rt.save()
    if (change === 'generation') task.collaboration.generation++
    else f.rt.state.projectChiefPolicies.p.operationsContact.agentId = 'replacement'
    assert.equal((await f.inbox.endpoint('list', f.body, f.actor)).items[0].phase, 'superseded')
    await assert.rejects(f.inbox.endpoint('complete', { ...f.body, ...claim.claim, requestId: 'late', text: 'Done', publish: true }, f.actor), /no longer current/)
    await f.rt.projectEffects.drain()
    assert.equal(f.rt.state.projectEffects[token.id].status, 'cancelled')
    assert.equal(f.publications(), 0)
  }
})

test('Chief compensation reuses one message and original Effect, while live claims and lost commit prevent another delivery', async () => {
  const f = fixture(), task = f.rt.state.tasks.t, carrier = f.rt.state.projectAgents.carrier
  task.chiefQuestion.recipient = { participationId: 'participation', consultationId: f.receipt.id, agentId: 'agent' }
  f.rt.state.personalAgentParticipations = { participation: f.participation }
  f.rt.projectChiefControl = { validateActor: async actor => { if (actor.chiefJobId !== 'authorized') throw Error('stale Chief') } }
  const chief = { memberId: 'owner', chiefJobId: 'authorized' }
  const original = f.inbox.stage(carrier, f.receipt); await f.rt.save(); await f.rt.projectEffects.drain()
  assert.equal(f.rt.state.projectEffects[original.id].status, 'done')
  await assert.rejects(f.inbox.remind(task, 'denied', { memberId: 'owner' }), /stale/)
  f.saveFailure(true); await assert.rejects(f.inbox.remind(task, 'unsaved', chief), /save failed/); f.saveFailure(false)
  assert.deepEqual(f.receipt.notificationEffect, original)
  const remind = await f.inbox.remind(task, 'compensate', chief)
  assert.equal(remind.effectId, original.id); assert.ok(remind.generation > original.generation)
  assert.equal((await f.inbox.remind(task, 'concurrent', chief)).status, 'already-pending')
  await f.rt.projectEffects.drain()
  const first = await f.inbox.endpoint('claim', { ...f.body, requestId: 'take' }, f.actor)
  assert.equal((await f.inbox.remind(task, 'claimed', chief)).status, 'already-claimed')
  f.tick(1001)
  await f.inbox.remind(task, 'expired', chief); await f.rt.projectEffects.drain()
  const next = await f.inbox.endpoint('claim', { ...f.body, requestId: 'retake' }, f.actor)
  assert.ok(next.claim.generation > first.claim.generation)
  await assert.rejects(f.inbox.endpoint('complete', { ...f.body, ...first.claim, requestId: 'late', text: 'Old repair', publish: true }, f.actor), /claim|generation/)
  await f.inbox.endpoint('complete', { ...f.body, ...next.claim, requestId: 'result', text: 'Verified advice', publish: true }, f.actor)
  assert.equal(f.publications(), 1)
  assert.equal((await f.inbox.remind(task, 'completed', chief)).status, 'already-handled')
})
