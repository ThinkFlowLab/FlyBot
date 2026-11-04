import assert from 'node:assert/strict'
import {test} from 'node:test'
import {taskSession,taskSessionId,backendBindingKey,backendContextKey,resumableBinding,confirmedWorkerExit,pinTaskRoleDefinition,discardUnpreparedTaskDefinitions,roleDefinitionKey} from '../src/host/project-task-sessions.js'

test('Task-role identity persists across Attempts and separates projects, tasks and roles', () => {
  const state={tasks:{t:{projectId:'p'},t2:{projectId:'p'}}}
  const session={projectId:'p',taskId:'t',role:'developer'}
  const record=taskSession(state,session)
  assert.equal(taskSession(state,{...session,attemptId:'new'}),record)
  assert.notEqual(taskSession(state,{...session,role:'reviewer'}).id,record.id)
  assert.notEqual(taskSession(state,{...session,taskId:'t2'}).id,record.id)
  assert.notEqual(taskSessionId('other','t','developer'),record.id)
  assert.throws(()=>taskSession(state,{...session,projectId:'other'}),/scope/)
  assert.throws(()=>taskSession(state,{...session,role:'chief'}),/scope/)
  record.role='reviewer'
  assert.throws(()=>taskSession(state,session),/identity/)
})

test('SDK binding fingerprints distinguish cwd, principal, resource, profile, model and persona changes', () => {
  const input={harness:'codex',resourceId:'r',principalId:'owner',cwd:'/task',model:'model',profile:{home:'/home',configDir:'/config'},definition:'persona'}
  const key=backendBindingKey(input)
  assert.equal(backendBindingKey(structuredClone(input)),key)
  for(const field of ['harness','resourceId','principalId','cwd','model','definition']) assert.notEqual(backendBindingKey({...input,[field]:'changed'}),key)
  for(const field of ['home','configDir','baseUrl']) assert.notEqual(backendBindingKey({...input,profile:{...input.profile,[field]:'changed'}}),key)
  assert.equal(resumableBinding({}, {bindings:[]},key),null)
})

function cwdFixture(harness = 'codex') {
  const definition = { role: 'tester', instructions: 'Preserve original testing convention' }
  const definitionKey = roleDefinitionKey({ role: 'tester', definition })
  const binding = { harness, resourceId: 'r', principalId: 'owner', cwd: '/new', model: 'model', profile: { home: '/profile', configDir: '/config' }, definition: definitionKey }
  const oldKey = backendBindingKey({ ...binding, cwd: '/old' })
  const previous = { version: 'task-role-binding/v2', definitionKey, key: oldKey, workerId: 'old', sessionId: 'original-thread' }
  const record = { id: 'logical', projectId: 'p', taskId: 't', role: 'tester', bindings: [previous] }
  const session = { id: 'new-role', projectId: 'p', taskId: 't', attemptId: 'a2', role: 'tester', definition, generation: 3, poolClaimId: 'claim-new', resourceLease: { id: 'new-lease', generation: 1 } }
  const workspace = { id: 'new-workspace', projectId: 'p', attemptId: 'a2', role: 'tester', resourceId: 'r', status: 'allocated', path: '/new', materialization: { expectedCheckout: 'a'.repeat(40), actualCheckout: 'a'.repeat(40) } }
  const state = { tasks: { t: { id: 't', projectId: 'p', deliveryAttemptId: 'a2', collaboration: { generation: 3, claim: { id: 'claim-new', status: 'active', generation: 3, attemptId: 'a2' } } } }, projectAttempts: { a1: { projectId: 'p', taskId: 't', roleSessions: { tester: { id: 'old-role', projectId: 'p', taskId: 't', role: 'tester', definition } } }, a2: { id: 'a2', projectId: 'p', taskId: 't', status: 'running', roleSessions: { tester: session }, workspaces: { tester: workspace } } }, projectWorkspaces: { 'new-workspace': workspace }, projectHarnessWorkers: { old: { id: 'old', projectId: 'p', taskId: 't', attemptId: 'a1', role: 'tester', logicalSessionId: 'logical', sessionKey: 'old-role', harness, sdkVersion: harness === 'codex' ? '0.166.0' : '0.3.316', resourceId: 'r', principalId: 'owner', cwd: '/old', definitionKey, bindingKey: oldKey, leaseId: 'old-lease', generation: 1, status: 'released', backendSessionId: 'original-thread', releaseProof: { kind: 'sdk-stop-ack-and-process-exit', workerId: 'old', generation: 1 } } }, projectResourceLeases: { 'old-lease': { projectId: 'p', attemptId: 'a1', role: 'tester', principalId: 'owner', worker: { kind: 'sdk', handle: 'old' }, releaseProof: { kind: 'sdk-stop-ack-and-process-exit', workerId: 'old', generation: 1 }, resourceId: 'r', generation: 1, status: 'released' }, 'new-lease': { id: 'new-lease', sessionKey: 'new-role', projectId: 'p', attemptId: 'a2', role: 'tester', resourceId: 'r', principalId: 'owner', generation: 1, status: 'reserved', reservationOwner: { claimId: 'claim-new', generation: 3, sessionId: 'new-role' } } } }
  return { state, record, binding, session, workspace, definitionKey }
}
test('cwd-only migration retains logical identity and exact old thread while preserving physical fingerprints', () => {
  for (const harness of ['codex', 'claude-agent']) {
    const f = cwdFixture(harness), key = backendBindingKey(f.binding)
    const restored = resumableBinding(f.state, f.record, key, f)
    assert.equal(restored.sessionId, 'original-thread')
    assert.equal(restored.restoration.mode, harness === 'codex' ? 'resumed' : 'reconstructed')
    assert.equal(restored.restoration.fromCwd, '/old'); assert.equal(restored.restoration.cwd, '/new')
    assert.notEqual(restored.key, key)
    assert.equal(restored.restoration.contextIdentityKey, backendContextKey(f.binding))
    assert.equal(f.record.bindings.length, 1)
  }
})
test('cwd migration cannot cross identity, profile, authorization, workspace, claim or exit boundaries', () => {
  const mutations = [
    f => { f.binding.principalId = 'other' }, f => { f.binding.resourceId = 'other' }, f => { f.binding.profile.configDir = '/other' }, f => { f.binding.model = 'other' },
    f => { f.state.projectHarnessWorkers.old.sdkVersion = 'unknown' }, f => { f.state.projectHarnessWorkers.old.status = 'running' }, f => { f.state.projectResourceLeases['old-lease'].status = 'reserved' }, f => { f.state.projectResourceLeases['old-lease'].attemptId = 'foreign' }, f => { f.state.projectResourceLeases['old-lease'].worker.handle = 'foreign' }, f => { f.state.projectResourceLeases['old-lease'].releaseProof.workerId = 'foreign' },
    f => { f.state.tasks.t.deliveryAttemptId = 'old' }, f => { f.state.tasks.t.collaboration.generation++ }, f => { f.state.tasks.t.collaboration.claim.workerId = 'already-running' },
    f => { f.state.projectResourceLeases['new-lease'].reservationOwner.generation++ }, f => { f.state.projectResourceLeases['new-lease'].principalId = 'other' },
    f => { f.state.projectWorkspaces['new-workspace'].materialization.actualCheckout = 'b'.repeat(40) }, f => { f.state.projectWorkspaces['new-workspace'].projectId = 'foreign' },
    f => { f.session.definition = { role: 'tester', instructions: 'Changed convention' } }, f => { delete f.state.projectAttempts.a1.roleSessions.tester },
  ]
  for (const mutate of mutations) { const f = cwdFixture(); mutate(f); assert.throws(() => resumableBinding(f.state, f.record, backendBindingKey(f.binding), f), { code: 'bot/context-resume' }) }
})

test('missing bindings recover the latest trustworthy worker through the same cwd migration gates', () => {
  for (const harness of ['codex', 'claude-agent']) {
    const f = cwdFixture(harness)
    f.state.projectHarnessWorkers.old.bindingVersion = 'task-role-binding/v2'
    f.record.bindings = []
    const restored = resumableBinding(f.state, f.record, backendBindingKey(f.binding), f)
    assert.equal(restored.recoveredFromWorker, true)
    assert.equal(restored.sessionId, 'original-thread')
    assert.equal(restored.restoration.mode, harness === 'codex' ? 'resumed' : 'reconstructed')
    f.state.projectHarnessWorkers.old.status = 'unreachable'
    assert.throws(() => resumableBinding(f.state, f.record, backendBindingKey(f.binding), f), /unconfirmed/)
  }
})
test('cleared bindings skip only proven unstarted admissions and never forget prior real context', () => {
  const f = cwdFixture()
  f.state.projectHarnessWorkers.old.bindingVersion = 'task-role-binding/v2'
  f.state.projectHarnessWorkers.old.createdAt = 1
  const proof = { kind: 'sdk-worker-not-started', workerId: 'cold', generation: 1, at: 5 }
  f.state.projectHarnessWorkers.cold = { ...structuredClone(f.state.projectHarnessWorkers.old), id: 'cold', backendSessionId: null, leaseId: 'cold-lease', executionStartedAt: null, spawnPhase: 'aborted', releaseProof: proof, createdAt: 2 }
  f.state.projectResourceLeases['cold-lease'] = { projectId: 'p', attemptId: 'a1', role: 'tester', resourceId: 'r', generation: 1, status: 'released', worker: { handle: 'cold' }, releaseProof: proof }
  f.record.bindings = []
  assert.equal(resumableBinding(f.state, f.record, backendBindingKey(f.binding), f).sessionId, 'original-thread')
  f.state.projectHarnessWorkers.cold.releaseProof = { kind: 'unknown', workerId: 'cold', generation: 1 }
  assert.throws(() => resumableBinding(f.state, f.record, backendBindingKey(f.binding), f), /unconfirmed/)
})

test('resumption requires same-scope backend identity and confirmed worker and lease exit', () => {
  const record={id:'logical',projectId:'p',taskId:'t',role:'developer',bindings:[{key:'key',workerId:'w',sessionId:'thread'}]}
  const original={projectHarnessWorkers:{w:{projectId:'p',taskId:'t',role:'developer',logicalSessionId:'logical',bindingKey:'key',leaseId:'l',resourceId:'r',generation:2,status:'released',backendSessionId:'thread',releaseProof:{kind:'sdk-stop-ack-and-process-exit',generation:2}}},projectResourceLeases:{l:{projectId:'p',resourceId:'r',generation:2,status:'released'}}}
  assert.equal(resumableBinding(original,record,'key').sessionId,'thread')
  assert.throws(()=>resumableBinding(original,record,'different'),/resume|binding/)
  for(const [target,key,value] of [['worker','projectId','foreign'],['worker','taskId','other'],['worker','role','reviewer'],['worker','logicalSessionId','other'],['worker','bindingKey','other'],['worker','status','unreachable'],['worker','backendSessionId','foreign'],['worker','releaseProof',null],['lease','status','reserved'],['lease','generation',3],['lease','projectId','other'],['lease','resourceId','other']]) {
    const state=structuredClone(original)
    ;(target==='worker'?state.projectHarnessWorkers.w:state.projectResourceLeases.l)[key]=value
    assert.throws(()=>resumableBinding(state,record,'key'),/unconfirmed/)
  }
  assert.throws(()=>resumableBinding({},record,'key'),/unconfirmed/)
})


test('supervisor-confirmed prior invocation permits same Task-role resumption with exact lease proof', () => {
  const proof={kind:'systemd-prior-invocation-exited',previousInvocationId:'a'.repeat(32),at:123}
  const record={id:'logical',projectId:'p',taskId:'t',role:'developer',bindings:[{key:'key',workerId:'w',sessionId:'thread'}]}
  const original={projectHarnessWorkers:{w:{id:'w',projectId:'p',taskId:'t',attemptId:'a',role:'developer',logicalSessionId:'logical',bindingKey:'key',leaseId:'l',resourceId:'r',generation:2,status:'released',backendSessionId:'thread',releaseProof:proof}},projectResourceLeases:{l:{id:'l',projectId:'p',attemptId:'a',role:'developer',resourceId:'r',generation:2,status:'released',worker:{kind:'sdk',handle:'w'},processScope:{kind:'systemd-control-group',killMode:'control-group',invocationId:'a'.repeat(32)},releaseProof:proof}}}
  assert.equal(resumableBinding(original,record,'key').sessionId,'thread')
  const mutations=[
    s=>{s.projectResourceLeases.l.releaseProof=null},
    s=>{s.projectResourceLeases.l.releaseProof.previousInvocationId='b'.repeat(32)},
    s=>{s.projectResourceLeases.l.processScope.invocationId='b'.repeat(32)},
    s=>{s.projectResourceLeases.l.processScope.kind='unmanaged-process'},
    s=>{s.projectResourceLeases.l.processScope.killMode='process'},
    s=>{s.projectResourceLeases.l.worker.handle='other'},
    s=>{s.projectResourceLeases.l.worker.kind='native'},
    s=>{s.projectResourceLeases.l.attemptId='other'},
    s=>{s.projectResourceLeases.l.role='reviewer'},
    s=>{s.projectResourceLeases.l.generation=3},
    s=>{s.projectResourceLeases.l.status='unreachable'},
    s=>{s.projectHarnessWorkers.w.releaseProof={...proof,previousInvocationId:''}},
    s=>{s.projectHarnessWorkers.w.status='unreachable'},
  ]
  for(const mutate of mutations){const s=JSON.parse(JSON.stringify(original));mutate(s);assert.throws(()=>resumableBinding(s,record,'key'),/unconfirmed/)}
})


test('exit proof guards reject missing workers, unconfirmed generations and unbound supervisor claims', () => {
  assert.equal(confirmedWorkerExit({}, null), false)
  assert.equal(confirmedWorkerExit({}, {status:'released',generation:2}), false)
  assert.equal(confirmedWorkerExit({}, {status:'released',releaseProof:{kind:'sdk-stop-ack-and-process-exit'}}), false)
  assert.equal(confirmedWorkerExit({}, {status:'released',generation:0}), false)
  assert.equal(confirmedWorkerExit({}, {status:'released',generation:2,releaseProof:{kind:'sdk-stop-ack-and-process-exit',generation:1}}), false)
  assert.equal(confirmedWorkerExit({}, {status:'released',generation:2,releaseProof:{kind:'systemd-prior-invocation-exited'}}), false)
  assert.equal(confirmedWorkerExit({}, {status:'released',generation:2,leaseId:'absent',releaseProof:{kind:'systemd-prior-invocation-exited',previousInvocationId:'a'.repeat(32)}}), false)
})

test('late callback failure cannot erase a fully fenced SDK stop and lease exit proof', () => {
  const proof={kind:'sdk-stop-ack-and-process-exit',workerId:'w',generation:2,at:123}
  const worker={id:'w',projectId:'p',taskId:'t',attemptId:'a',role:'chief',resourceId:'r',leaseId:'l',generation:2,status:'failed',releasedAt:123,exit:{code:0,signal:null},releaseProof:proof}
  const lease={projectId:'p',attemptId:'a',role:'chief',resourceId:'r',generation:2,status:'released',worker:{kind:'sdk',handle:'w'},releaseProof:proof}
  const state={projectResourceLeases:{l:lease}}
  assert.equal(confirmedWorkerExit(state,worker),true)
  for(const mutate of [w=>{w.releaseProof=null},w=>{w.releaseProof.workerId='other'},w=>{w.releaseProof.generation=3},w=>{w.exit.code=null},w=>{w.status='unreachable'},w=>{w.releasedAt=null},w=>{w.attemptId='other'}]) {
    const w=structuredClone(worker);mutate(w);assert.equal(confirmedWorkerExit(state,w),false)
  }
  for(const mutate of [l=>{l.status='unreachable'},l=>{l.releaseProof=null},l=>{l.worker.handle='other'},l=>{l.generation=3},l=>{l.role='developer'}]) {
    const l=structuredClone(lease);mutate(l);assert.equal(confirmedWorkerExit({projectResourceLeases:{l}},worker),false)
  }
})

test('an incompatible latest Task-role binding cannot silently start a fresh Session or select older context', () => {
  const record = { id: 'logical', projectId: 'p', taskId: 't', role: 'developer', bindings: [{ key: 'old', workerId: 'w', sessionId: 'original-thread' }] }
  assert.throws(() => resumableBinding({}, record, 'new'), /resume|binding|context/i)
  const state = { projectHarnessWorkers: { w: { projectId: 'p', taskId: 't', role: 'developer', logicalSessionId: 'logical', bindingKey: 'old', leaseId: 'l', resourceId: 'r', generation: 2, status: 'released', backendSessionId: 'original-thread', releaseProof: { kind: 'sdk-stop-ack-and-process-exit', generation: 2 } } }, projectResourceLeases: { l: { projectId: 'p', resourceId: 'r', generation: 2, status: 'released' } } }
  record.bindings.push({ key: 'new', workerId: 'later', sessionId: 'latest-thread' })
  assert.throws(() => resumableBinding(state, record, 'old'), /resume|binding|context/i)
})


function pinnedFixture() {
  const scope = { projectId: 'p', taskId: 't', role: 'developer' }
  const definition = { role: 'developer', instructions: 'Original persona', resolvedSkills: [{ name: 'verify', sha256: 'a'.repeat(64) }], memory: ['Current fact'], toolPolicy: { shell: true }, execution: { harness: 'codex', resourceIds: ['r', 'backup'] } }
  const state = { tasks: { t: { projectId: 'p' }, other: { projectId: 'p' } }, projectAgentDefinitions: { p: { revision: 1, roles: [structuredClone(definition)] } } }
  return { state, scope, definition }
}

test('a Task pins its definition once, shares immutable snapshots, and keeps current memory outside them', () => {
  const { state, scope, definition } = pinnedFixture()
  const first = pinTaskRoleDefinition(state, scope, definition)
  assert.equal(first.definition.memory, undefined)
  assert.equal(first.revision, 1)
  const same = pinTaskRoleDefinition(state, { ...scope, taskId: 'other' }, definition)
  assert.equal(same.definitionRef, first.definitionRef)
  state.projectAgentDefinitions.p.revision = 2
  definition.instructions = 'Changed persona'
  definition.memory = ['New fact']
  const retry = pinTaskRoleDefinition(state, scope, definition)
  assert.equal(retry.definition.instructions, 'Original persona')
  assert.equal(retry.definitionKey, first.definitionKey)
  assert.deepEqual(retry.change, { pinnedRevision: 1, currentRevision: 2, retainedOriginalDefinition: true })
  state.tasks.fresh = { projectId: 'p' }
  const next = pinTaskRoleDefinition(state, { ...scope, taskId: 'fresh' }, definition)
  assert.notEqual(next.definitionRef, first.definitionRef)
  assert.equal(next.definition.instructions, 'Changed persona')
  assert.equal(next.revision, 2)
  retry.definition.instructions = 'Mutating a returned copy'
  assert.equal(pinTaskRoleDefinition(state, scope, definition).definition.instructions, 'Original persona')
})

test('pinned role definitions do not preserve revoked live permissions or tolerate changed snapshots', () => {
  const fixture = pinnedFixture()
  pinTaskRoleDefinition(fixture.state, fixture.scope, fixture.definition)
  for (const mutate of [
    role => { role.status = 'retired' },
    role => { role.execution.harness = 'claude-agent' },
    role => { role.execution.resourceIds = [] },
    role => { role.toolPolicy.shell = false },
  ]) {
    const state = structuredClone(fixture.state)
    mutate(state.projectAgentDefinitions.p.roles[0])
    assert.throws(() => pinTaskRoleDefinition(state, fixture.scope, fixture.definition), { code: 'bot/context-resume' })
  }
  const snapshot = Object.values(fixture.state.projectRoleDefinitionSnapshots)[0]
  snapshot.definition.instructions = 'Changed stored persona'
  assert.throws(() => pinTaskRoleDefinition(fixture.state, fixture.scope, fixture.definition), /changed/)
})

test('failed preparation discards only unused definition pins and preserves established Session history', () => {
  const { state, scope, definition } = pinnedFixture()
  const first = pinTaskRoleDefinition(state, scope, definition)
  assert.equal(discardUnpreparedTaskDefinitions(state, 'other'), false)
  assert.equal(discardUnpreparedTaskDefinitions(state, 't'), true)
  assert.equal(Object.keys(state.projectRoleDefinitionSnapshots).length, 1)
  definition.instructions = 'Repaired initial definition'
  assert.notEqual(pinTaskRoleDefinition(state, scope, definition).definitionRef, first.definitionRef)
  state.projectAttempts = { attempt: { projectId: 'p', taskId: 't', roleSessionHistory: [{ role: 'developer' }] } }
  assert.equal(discardUnpreparedTaskDefinitions(state, 't'), false)
})

function observedFixture() {
  const scope = { projectId: 'p', taskId: 't', role: 'developer' }
  const logical = { ...scope, id: 'logical', bindings: [] }
  const worker = { ...scope, id: 'w', logicalSessionId: 'logical', attemptId: 'a', sessionKey: 's', bindingKey: 'key', backendSessionId: 'partial-thread', leaseId: 'l', resourceId: 'r', generation: 2, status: 'released', releaseProof: { kind: 'sdk-stop-ack-and-process-exit', workerId: 'w', generation: 2 } }
  const state = { projectHarnessWorkers: { w: worker }, projectResourceLeases: { l: { ...scope, attemptId: 'a', status: 'released', resourceId: 'r', generation: 2 } } }
  return { state, logical, worker, scope }
}

test('the latest partially observed SDK Session supersedes old completed bindings, but unknown context never resets', () => {
  const { state, logical, worker } = observedFixture()
  assert.equal(resumableBinding(state, logical, 'key').sessionId, 'partial-thread')
  logical.bindings.push({ key: 'old-key', workerId: 'old', sessionId: 'old-thread' })
  state.projectHarnessWorkers.old = { ...worker, id: 'old', bindingKey: 'old-key', backendSessionId: 'old-thread', createdAt: -1 }
  assert.equal(resumableBinding(state, logical, 'key').sessionId, 'partial-thread')
  worker.backendSessionId = null
  assert.throws(() => resumableBinding(state, logical, 'key'), /no recoverable/)
  worker.executionStartedAt = null
  assert.throws(() => resumableBinding(state, logical, 'key'), /binding|resume/)
  logical.bindings = []
  delete state.projectHarnessWorkers.old
  assert.equal(resumableBinding(state, logical, 'key'), null)
  worker.status = 'unreachable'
  assert.throws(() => resumableBinding(state, logical, 'key'), /unconfirmed/)
})

test('legacy definition migration verifies original typed context and preserves its binding proof', async () => {
  const { roleContext } = await import('../src/host/project-role-context.js')
  const { state, scope, definition } = pinnedFixture()
  const logical = taskSession(state, scope)
  const context = roleContext({ ...scope, definition, revision: 1 })
  const session = { ...scope, id: 's', context, execution: definition.execution }
  const proof = { kind: 'sdk-stop-ack-and-process-exit', workerId: 'w', generation: 2 }
  state.projectAttempts = { a: { projectId: 'p', taskId: 't', roleSessionHistory: [session] } }
  state.projectHarnessWorkers = { w: { ...scope, id: 'w', attemptId: 'a', sessionKey: 's', logicalSessionId: logical.id, backendSessionId: 'legacy-thread', bindingKey: 'legacy-key', resourceId: 'r', leaseId: 'l', generation: 2, status: 'released', releaseProof: proof } }
  state.projectResourceLeases = { l: { projectId: 'p', resourceId: 'r', generation: 2, status: 'released' } }
  logical.bindings.push({ key: 'legacy-key', workerId: 'w', sessionId: 'legacy-thread' })
  definition.instructions = 'New definition after legacy execution'
  const pinned = pinTaskRoleDefinition(state, scope, definition)
  assert.equal(pinned.definition.instructions, 'Original persona')
  assert.deepEqual(pinned.definition.execution.resourceIds, ['r'])
  const oldProof = structuredClone(logical.bindings)
  assert.equal(resumableBinding(state, logical, 'v2-key', { legacyKey: 'legacy-key', definitionKey: pinned.definitionKey }).sessionId, 'legacy-thread')
  assert.deepEqual(logical.bindings, oldProof)
  session.context.sha256 = '0'.repeat(64)
  assert.throws(() => roleDefinitionKey(session), /hash/)
  assert.throws(() => resumableBinding(state, logical, 'v2-key', { legacyKey: 'legacy-key', definitionKey: pinned.definitionKey }), /hash/)
})

test('approved removal or capability reclassification cannot restart a pinned role with its old authority', () => {
  const f = pinnedFixture()
  pinTaskRoleDefinition(f.state, f.scope, f.definition)
  const removed = structuredClone(f.state)
  removed.projectAgentDefinitions.p.roles = []
  removed.projectRetiredRoles = { 'p:developer': { ...f.definition, retiredAt: 1 } }
  assert.throws(() => pinTaskRoleDefinition(removed, f.scope, f.definition), { code: 'bot/context-resume' })
  const changed = structuredClone(f.state)
  changed.projectAgentDefinitions.p.roles[0].policyRole = 'reviewer'
  assert.throws(() => pinTaskRoleDefinition(changed, f.scope, f.definition), { code: 'bot/context-resume' })
  assert.equal(f.state.projectRoleDefinitionSnapshots[Object.keys(f.state.projectRoleDefinitionSnapshots)[0]].definition.instructions, 'Original persona')
})

test('custom logical roles fingerprint their capability class without invalidating original default-role keys', () => {
  const base = { role: 'developer', instructions: 'Convention', resolvedSkills: [] }
  const original = roleDefinitionKey({ role: 'developer', definition: base })
  assert.equal(roleDefinitionKey({ role: 'developer', definition: { ...base, policyRole: 'developer' } }), original)
  const reviewer = roleDefinitionKey({ role: 'analyst', definition: { ...base, role: 'analyst', policyRole: 'reviewer' } })
  const developer = roleDefinitionKey({ role: 'analyst', definition: { ...base, role: 'analyst', policyRole: 'developer' } })
  assert.notEqual(reviewer, developer)
})


test('approved custom roles have distinct Task-role Sessions while retired Sessions remain stoppable', () => {
  const f = pinnedFixture(), analyst = { ...f.definition, role: 'analyst', policyRole: 'reviewer' }
  f.state.projectAgentDefinitions.p.roles.push(analyst)
  const logical = taskSession(f.state, { ...f.scope, role: 'analyst' })
  assert.notEqual(logical.id, taskSession(f.state, f.scope).id)
  f.state.projectAgentDefinitions.p.roles = []
  assert.equal(taskSession(f.state, { ...f.scope, role: 'analyst' }), logical)
  assert.throws(() => taskSession(f.state, { ...f.scope, role: 'unapproved' }), /scope changed/)
})


test('staged governance mutations cannot replace the execution-visible committed catalog', () => {
  const f = pinnedFixture(), committed = structuredClone(f.state.projectAgentDefinitions.p)
  f.state.projectAgentDefinitions.p = { revision: 2, roles: [] }
  const pinned = pinTaskRoleDefinition(f.state, f.scope, f.definition, 1, committed)
  assert.equal(pinned.revision, 1)
  assert.equal(pinned.definition.instructions, 'Original persona')
  assert.throws(() => pinTaskRoleDefinition(f.state, f.scope, f.definition, 2, f.state.projectAgentDefinitions.p), /retired/)
})
