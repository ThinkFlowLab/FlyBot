import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createProjectEffects } from '../src/host/project-effects.js'
import { install, createProjectInputs } from '../src/host/project-inputs.js'
const actor = { memberId: 'owner' }
function fixture(state) {
  let committed, saves = 0, fail = false, clock = 0
  const claim = { id: 'claim', botId: 'p:developer', generation: 2, status: 'active', projectId: 'p', taskId: 't' }
  const rt = { state: state ?? { tasks: { t: { id: 't', projectId: 'p', status: 'working', collaboration: { generation: 2, botId: claim.botId, claim, currentHandoffId: 'h' } } } },
    readOnly: () => undefined, projects: { requireActive() {} },
    requireProjectAccess(a, p) { if (p !== 'p' || a.memberId !== 'owner') throw new Error('denied') },
    async save() { saves++; if (fail) throw new Error('disk failed'); const proof = rt.projectEffects.capture(); committed = JSON.parse(JSON.stringify(rt.state)); rt.projectEffects.saved(proof) } }
  rt.projectEffects = createProjectEffects(rt, { now: () => clock }); install(rt)
  return { rt, claim: rt.state.tasks.t.collaboration.claim, disk: () => committed, saves: () => saves, advance(ms) { clock += ms }, fail(value) { fail = value } }
}
const input = (requestId = 'feedback', text = 'Keep the original group chat') => ({ projectId: 'p', taskId: 't', requestId, text })

test('human feedback is committed once with its notify intent and immutable source identity', async () => {
  const f = fixture(), first = await f.rt.projectInputs.publish(input(), actor)
  assert.equal(first.already, false)
  assert.equal((await f.rt.projectInputs.publish(input(), actor)).already, true)
  assert.equal(Object.keys(f.rt.state.projectTaskInputs).length, 1)
  assert.equal(Object.keys(f.disk().projectEffects).length, 1)
  await assert.rejects(f.rt.projectInputs.publish(input('feedback', 'different'), actor), /different content/)
  const view = f.rt.projectInputs.list({ projectId: 'p', taskId: 't' }, actor).inputs[0]
  assert.equal(view.phase, 'accepted'); assert.equal(view.source.memberId, 'owner')
  await f.rt.projectEffects.drain()
  assert.equal(f.rt.projectInputs.list({ projectId: 'p', taskId: 't' }, actor).inputs[0].phase, 'accepted', 'notify receipt does not fabricate delivery or read')
})

test('failed/no-op persistence cannot release a new input and provenance/routing cannot be forged', async () => {
  const f = fixture(); f.fail(true)
  await assert.rejects(f.rt.projectInputs.publish(input(), actor), /disk failed/)
  assert.equal(Object.keys(f.rt.state.projectTaskInputs).length, 0)
  f.fail(false)
  f.rt.save = async () => {}
  await assert.rejects(f.rt.projectInputs.publish(input(), actor), /not confirmed/)
  assert.equal(Object.keys(f.rt.state.projectTaskInputs).length, 0)
  for (const body of [{ ...input(), projectId: 'foreign' }, { ...input(), recipient: 'p:reviewer' }, { ...input(), source: { kind: 'handoff' } }, { ...input(), claim: {} }, input('bad.id'), input('huge', 'x'.repeat(4001))]) await assert.rejects(f.rt.projectInputs.publish(body, actor))
  await assert.rejects(f.rt.projectInputs.publish(input(), { memberId: 'foreign' }), /denied/)
})

test('durable inbox, adapter delivery, SDK output and explicit role read/handling remain distinct', async () => {
  const f = fixture(); await f.rt.projectInputs.publish(input(), actor)
  const batch = await f.rt.projectInputs.prepare('t', f.claim)
  assert.deepEqual(await f.rt.projectInputs.prepare('t', f.claim), batch)
  const row = Object.values(f.rt.state.projectTaskInputs)[0]
  assert.equal(row.deliveries.length, 1)
  assert.equal(f.rt.projectInputs.list({ projectId: 'p', taskId: 't' }, actor).inputs[0].phase, 'inbox-accepted')
  await f.rt.projectInputs.transport('t', f.claim, batch.batchId, { kind: 'adapter-written', sha256: 'a'.repeat(64) })
  assert.equal(f.rt.projectInputs.list({ projectId: 'p', taskId: 't' }, actor).inputs[0].phase, 'delivered')
  await f.rt.projectInputs.transport('t', f.claim, batch.batchId, { kind: 'sdk-output', sha256: 'b'.repeat(64) })
  assert.equal(f.rt.projectInputs.list({ projectId: 'p', taskId: 't' }, actor).inputs[0].phase, 'observed')
  assert.equal(row.deliveries[0].readAt, undefined)
  assert.throws(() => f.rt.projectInputs.requireHandled('t'), /unhandled/)
  await f.rt.projectInputs.acknowledge('t', f.claim, { batchId: batch.batchId, read: [row.id], handled: [] })
  assert.equal(f.rt.projectInputs.list({ projectId: 'p', taskId: 't' }, actor).inputs[0].phase, 'read-confirmed')
  await f.rt.projectInputs.acknowledge('t', f.claim, { batchId: batch.batchId, read: [row.id], handled: [row.id] })
  assert.equal(f.rt.projectInputs.list({ projectId: 'p', taskId: 't' }, actor).inputs[0].phase, 'handled')
  f.rt.projectInputs.requireHandled('t')
  assert.equal(f.rt.state.tasks.t.status, 'working')
})

test('current injected batch is the only scope for read receipts; transfer rejects old worker acknowledgement', async () => {
  const f = fixture(); await f.rt.projectInputs.publish(input(), actor)
  const old = structuredClone(f.claim), batch = await f.rt.projectInputs.prepare('t', old), id = batch.inputs[0].id
  for (const receipt of [{ batchId: 'foreign', read: [id], handled: [id] }, { batchId: batch.batchId, read: ['foreign'], handled: [] }, { batchId: batch.batchId, read: [], handled: [id] }, {}]) await assert.rejects(f.rt.projectInputs.acknowledge('t', old, receipt), /batch|acknowledgement/)
  const c = f.rt.state.tasks.t.collaboration
  c.generation = 4; c.botId = 'p:tester'; c.claim = { ...old, id: 'next-claim', generation: 4, botId: c.botId }
  await assert.rejects(f.rt.projectInputs.acknowledge('t', old, { batchId: batch.batchId, read: [id], handled: [id] }), /stale/)
  const next = await f.rt.projectInputs.prepare('t', c.claim)
  assert.equal(next.inputs[0].id, id)
  assert.equal(f.rt.projectInputs.list({ projectId: 'p', taskId: 't' }, actor).inputs[0].recipient.botId, 'p:tester')
})

test('restart retains accepted and delivered inputs without claiming a model read', async () => {
  const first = fixture(); await first.rt.projectInputs.publish(input(), actor)
  const batch = await first.rt.projectInputs.prepare('t', first.claim)
  await first.rt.projectInputs.transport('t', first.claim, batch.batchId, { kind: 'adapter-written', sha256: 'a'.repeat(64) })
  const next = fixture(first.disk()); next.rt.projectEffects.recover()
  assert.equal((await next.rt.projectInputs.publish(input(), actor)).already, true)
  assert.equal(next.rt.projectInputs.list({ projectId: 'p', taskId: 't' }, actor).inputs[0].phase, 'delivered')
  assert.deepEqual(await next.rt.projectInputs.prepare('t', next.claim), batch)
  next.rt.state.tasks.t.status = 'cancelled'
  assert.equal(next.rt.projectInputs.list({ projectId: 'p', taskId: 't' }, actor).inputs[0].phase, 'cancelled')
  await assert.rejects(next.rt.projectInputs.publish(input('new'), actor), /active Task/)
  await assert.rejects(next.rt.projectInputs.acknowledge('t', next.claim, { batchId: batch.batchId, read: [batch.inputs[0].id], handled: [] }), /stale/)
  assert.equal(Object.keys(next.rt.state.tasks).length, 1)
})

test('input list is bounded to the authorized Task; handoff input preserves host provenance', async () => {
  const f = fixture(); await f.rt.projectInputs.publish(input(), actor)
  const task = f.rt.state.tasks.t, handoff = { id: 'h', reason: 'Review the exact candidate' }
  const staged = f.rt.projectInputs.stageHandoff(task, handoff)
  assert.equal(f.rt.projectInputs.stageHandoff(task, handoff).created, false)
  assert.equal(staged.row.source.kind, 'handoff')
  await assert.rejects(async () => f.rt.projectInputs.list({ projectId: 'foreign', taskId: 't' }, actor), /another Project/)
  assert.throws(() => f.rt.projectInputs.list({ projectId: 'p', taskId: 't', limit: 201 }, actor), /limit/)
  assert.throws(() => f.rt.projectInputs.list({ projectId: 'p', taskId: 't', after: 'foreign' }, actor), /cursor/)
  const page = f.rt.projectInputs.list({ projectId: 'p', taskId: 't', limit: 1 }, actor)
  assert.equal(page.inputs.length, 1); assert.ok(page.next)
  assert.equal(f.rt.projectInputs.list({ projectId: 'p', taskId: 't', after: page.next }, actor).inputs.length, 1)
  f.rt.projectInputs.discardHandoff(staged.row.id)
  assert.equal(Object.keys(f.rt.state.projectTaskInputs).length, 1)
  f.rt.readOnly = () => 'read-only'
  await assert.rejects(f.rt.projectInputs.publish(input('other'), actor), /read-only/)
  assert.equal(createProjectInputs(f.rt).pending('t').length, 1)
})

test('busy input batches drain bounded new sources without repeating an injected body', async () => {
  const f=fixture()
  for(let n=0;n<5;n++)await f.rt.projectInputs.publish(input('event-'+n,'feedback '+n),actor)
  const first=await f.rt.projectInputs.prepare('t',f.claim)
  await f.rt.projectInputs.transport('t',f.claim,first.batchId,{kind:'adapter-written',sha256:'a'.repeat(64)})
  const second=await f.rt.projectInputs.prepare('t',f.claim,{next:true})
  await f.rt.projectInputs.transport('t',f.claim,second.batchId,{kind:'adapter-written',sha256:'b'.repeat(64)})
  const third=await f.rt.projectInputs.prepare('t',f.claim,{next:true})
  await f.rt.projectInputs.transport('t',f.claim,third.batchId,{kind:'adapter-written',sha256:'c'.repeat(64)})
  assert.equal(first.inputs.length,2);assert.equal(second.inputs.length,2);assert.equal(third.inputs.length,1)
  assert.deepEqual([first.remaining,second.remaining,third.remaining],[3,1,0])
  assert.equal(new Set([...first.inputs,...second.inputs,...third.inputs].map(row=>row.id)).size,5)
  assert.equal((await f.rt.projectInputs.prepare('t',f.claim,{next:true})).inputs.length,0)
  const receipts=[first,second,third].map(batch=>({batchId:batch.batchId,read:batch.inputs.map(row=>row.id),handled:batch.inputs.map(row=>row.id)}))
  await assert.rejects(f.rt.projectInputs.acknowledge('t',f.claim,[receipts[0],{batchId:'foreign',read:['forged'],handled:['forged']}]),/batch/)
  assert.ok(Object.values(f.rt.state.projectTaskInputs).every(row=>row.status==='accepted'),'A malformed multi-batch receipt must not partly consume earlier inputs')
  await f.rt.projectInputs.acknowledge('t',f.claim,receipts)
  f.rt.projectInputs.requireHandled('t')
})

test('Chief receipts are scoped to its persisted snapshot and generation, with a total text budget', async () => {
  const f=fixture()
  for(let n=0;n<3;n++)await f.rt.projectInputs.publish(input('event-'+n,'x'.repeat(4000)),actor)
  const snapshot=[{taskId:'t',generation:2}],run={id:'chief-run',projectId:'p'}
  await f.rt.projectInputs.prepareChief(snapshot,run)
  const batch=snapshot[0].taskInbox
  assert.equal(batch.inputs.length,2);assert.equal(batch.remaining,1)
  assert.equal(batch.inputs.reduce((size,row)=>size+row.text.length,0),8000)
  const receipt={batchId:batch.batchId,read:batch.inputs.map(row=>row.id),handled:batch.inputs.map(row=>row.id)}
  await assert.rejects(f.rt.projectInputs.acknowledgeChief('t',snapshot[0],{...run,projectId:'foreign'},receipt),/snapshot/)
  await assert.rejects(f.rt.projectInputs.acknowledgeChief('t',snapshot[0],run,{...receipt,read:['foreign']}),/snapshot/)
  await f.rt.projectInputs.acknowledgeChief('t',snapshot[0],run,receipt)
  assert.throws(()=>f.rt.projectInputs.requireHandled('t'),/unhandled/)
  f.rt.state.tasks.t.collaboration.generation++
  await assert.rejects(f.rt.projectInputs.acknowledgeChief('t',snapshot[0],run,receipt),/snapshot/)
  await assert.rejects(f.rt.projectInputs.prepareChief([{taskId:'t',generation:3}],{...run,projectId:'foreign'}),/scope/)
})

test('membership revocation invalidates pending source input without reviving it on regrant', async () => {
  const f=fixture();const first=await f.rt.projectInputs.publish(input(),actor)
  const batch=await f.rt.projectInputs.prepare('t',f.claim)
  f.rt.projectInputs.revokeSource('p','owner')
  assert.equal(f.rt.projectInputs.list({projectId:'p',taskId:'t'},actor).inputs[0].status,'cancelled')
  assert.equal(f.rt.projectInputs.pending('t').length,0)
  f.rt.projectInputs.requireHandled('t')
  await assert.rejects(f.rt.projectInputs.acknowledge('t',f.claim,{batchId:batch.batchId,read:[first.input.id],handled:[first.input.id]}),/cancelled|revoked|inactive/)
  assert.equal((await f.rt.projectInputs.publish(input(),actor)).already,true)
  assert.equal(f.rt.projectInputs.pending('t').length,0)
  await f.rt.projectInputs.publish(input('new-grant-event'),actor)
  assert.equal(f.rt.projectInputs.pending('t').length,1)
})

test('tampered payloads and future input protocols cannot acquire receipts or silently pass closure', async () => {
  const f=fixture();await f.rt.projectInputs.publish(input(),actor)
  const batch=await f.rt.projectInputs.prepare('t',f.claim),row=Object.values(f.rt.state.projectTaskInputs)[0]
  row.text='tampered'
  assert.throws(()=>f.rt.projectInputs.list({projectId:'p',taskId:'t'},actor),/content changed/)
  await assert.rejects(f.rt.projectInputs.acknowledge('t',f.claim,{batchId:batch.batchId,read:[row.id],handled:[row.id]}),/content changed/)
  await assert.rejects(f.rt.projectInputs.publish(input(),actor),/content changed/)
  row.version='project-task-input/v999';delete row.deliveries;delete row.source
  assert.equal(f.rt.projectInputs.list({projectId:'p',taskId:'t'},actor).inputs[0].phase,'unavailable')
  assert.throws(()=>f.rt.projectInputs.requireHandled('t'),/protocol upgrade/)
  await assert.rejects(f.rt.projectInputs.prepare('t',f.claim),/protocol upgrade/)
  await assert.rejects(f.rt.projectInputs.publish(input(),actor),/protocol upgrade/)
})

test('reply to a Chief question wakes Chief even before the Task has a role collaboration record', async () => {
  const f = fixture(); delete f.rt.state.tasks.t.collaboration
  f.rt.state.tasks.t.chiefQuestion = { decisionId: 'decision', recipient: { consultationId: 'consultation' } }
  f.rt.state.projectChiefPolicies = { p: { enabled: true } }
  let requested = 0
  f.rt.projectChiefControl = { request: async () => { requested++; return { id: 'resumed-chief' } } }
  await f.rt.projectInputs.publish(input(), actor)
  await f.rt.projectEffects.drain()
  assert.equal(requested, 1)
})

test('notify waits for configured Chief recovery and never interrupts a healthy worker', async () => {
  const f=fixture();f.rt.state.tasks.t.collaboration.status='blocked'
  await f.rt.projectInputs.publish(input(),actor)
  await f.rt.projectEffects.drain()
  const effect=Object.values(f.rt.state.projectEffects).find(row=>row.kind==='input.notify')
  assert.equal(effect.status,'pending');assert.equal(effect.waitingFor,'configuration');assert.equal(effect.failures,0)
  let requested=0
  f.rt.state.projectChiefPolicies={p:{enabled:true}}
  f.rt.projectChiefControl={async request(project,kind,source){requested++;assert.equal(project,'p');assert.equal(kind,'inspection');assert.equal(source.blockedTaskId,'t');return{id:'existing-chief-run'}}}
  f.advance(1001);await f.rt.projectEffects.drain()
  assert.equal(effect.status,'done');assert.equal(effect.receipt.chiefRunId,'existing-chief-run');assert.equal(requested,1)
  const stopped=fixture();await stopped.rt.projectInputs.publish(input(),actor);stopped.rt.state.tasks.t.collaboration.status='stopping'
  await stopped.rt.projectEffects.drain()
  assert.equal(Object.values(stopped.rt.state.projectEffects)[0].status,'cancelled')
  const revoked=fixture();await revoked.rt.projectInputs.publish(input(),actor);revoked.rt.requireProjectAccess=()=>{throw Error('revoked')}
  await revoked.rt.projectEffects.drain()
  assert.equal(Object.values(revoked.rt.state.projectEffects)[0].status,'cancelled')
})

test('Chief plans do not consume input on failed decisions and only an internal permit can accompany atomic closure', async () => {
  const f=fixture();await f.rt.projectInputs.publish(input(),actor)
  const run={id:'chief-run',projectId:'p'},snapshot=[{taskId:'t',generation:2}]
  await f.rt.projectInputs.prepareChief(snapshot,run)
  const batch=snapshot[0].taskInbox,receipts={batchId:batch.batchId,read:batch.inputs.map(i=>i.id),handled:batch.inputs.map(i=>i.id)}
  const scoped=f.rt.projectInputs.chiefActor({...actor,chiefJobId:run.id},'t',snapshot[0],run,receipts)
  assert.equal(Object.values(f.rt.state.projectTaskInputs)[0].status,'accepted','Preparing a valid decision cannot consume input before the decision succeeds')
  f.rt.projectInputs.requireHandled('t',scoped)
  assert.throws(()=>f.rt.projectInputs.requireHandled('t',JSON.parse(JSON.stringify(scoped))),/unhandled/,'A serialized/forged token grants no closure exception')
  f.rt.projectInputs.releaseChief(scoped)
  assert.throws(()=>f.rt.projectInputs.requireHandled('t',scoped),/unhandled/)
  const approved=f.rt.projectInputs.chiefActor({...actor,chiefJobId:run.id},'t',snapshot[0],run,receipts)
  f.rt.projectInputs.commitChief(approved)
  f.rt.state.tasks.t.status='accepted';await f.rt.save()
  assert.equal(Object.values(f.disk().projectTaskInputs)[0].status,'handled')
  assert.equal(f.disk().tasks.t.status,'accepted')
  assert.equal(f.rt.projectInputs.commitChief(approved),false)
})

test('new feedback or generation drift after Chief planning blocks closure without consuming old inputs', async () => {
  const f=fixture();await f.rt.projectInputs.publish(input(),actor)
  const run={id:'chief-run',projectId:'p'},snapshot=[{taskId:'t',generation:2}]
  await f.rt.projectInputs.prepareChief(snapshot,run)
  const batch=snapshot[0].taskInbox,receipts={batchId:batch.batchId,read:batch.inputs.map(i=>i.id),handled:batch.inputs.map(i=>i.id)}
  const scoped=f.rt.projectInputs.chiefActor({...actor,chiefJobId:run.id},'t',snapshot[0],run,receipts)
  await f.rt.projectInputs.publish(input('later','A later acceptance correction'),actor)
  assert.throws(()=>f.rt.projectInputs.commitChief(scoped),/unhandled/)
  f.rt.state.tasks.t.collaboration.generation++
  assert.throws(()=>f.rt.projectInputs.commitChief(scoped),/generation/)
  assert.ok(Object.values(f.rt.state.projectTaskInputs).every(row=>row.status==='accepted'))
})

test('a closing Effect engine cannot leave a phantom admitted input', async () => {
  const f=fixture();await f.rt.projectEffects.close()
  await assert.rejects(f.rt.projectInputs.publish(input(),actor),/not writable/)
  assert.equal(Object.keys(f.rt.state.projectTaskInputs).length,0)
})

test('receipt preflight exposes only current manifests and save failure never consumes a declaration', async () => {
  const f = fixture(); await f.rt.projectInputs.publish(input(), actor)
  const batch = await f.rt.projectInputs.prepare('t', f.claim), row = Object.values(f.rt.state.projectTaskInputs)[0]
  const good = { batchId: batch.batchId, read: [row.id], handled: [row.id] }
  for (const [receipt, kind] of [[{ ...good, batchId: 'typo' }, 'unknown-batch'], [{ ...good, read: [] }, 'handled-not-read'], [{ ...good, read: ['unseen'], handled: [] }, 'uninjected-input']]) {
    await assert.rejects(f.rt.projectInputs.validateReceipt('t', f.claim, receipt), error => {
      assert.equal(error.receiptFeedback.kind, kind); assert.equal(error.receiptFeedback.correctable, true)
      assert.deepEqual(error.receiptFeedback.batches[0], { batchId: batch.batchId, inputs: [{ id: row.id, sha256: row.sha256 }] })
      assert.ok(!JSON.stringify(error.receiptFeedback).includes(row.text)); return true
    })
  }
  assert.equal(row.status, 'accepted'); assert.equal(row.deliveries[0].readAt, undefined)
  await f.rt.projectInputs.validateReceipt('t', f.claim, good)
  f.fail(true); await assert.rejects(f.rt.projectInputs.acknowledge('t', f.claim, good), /disk failed/)
  assert.equal(row.status, 'accepted'); assert.equal(row.deliveries[0].readAt, undefined)
  f.fail(false); await f.rt.projectInputs.acknowledge('t', f.claim, good)
  assert.equal(row.status, 'handled')
  await f.rt.projectInputs.acknowledge('t', f.claim, good)
  assert.equal(row.status, 'handled')
})

test('foreign inputs, historical batches, revoked sources and changed bodies never become correctable grants', async () => {
  const f = fixture(); await f.rt.projectInputs.publish(input(), actor)
  const batch = await f.rt.projectInputs.prepare('t', f.claim), row = Object.values(f.rt.state.projectTaskInputs)[0]
  f.rt.state.projectTaskInputs.foreign = { ...structuredClone(row), id: 'foreign', taskId: 'other', text: 'foreign private content' }
  await assert.rejects(f.rt.projectInputs.validateReceipt('t', f.claim, { batchId: batch.batchId, read: ['foreign'], handled: [] }), error => error.receiptFeedback.kind === 'foreign-input' && !error.receiptFeedback.correctable && error.receiptFeedback.batches.length === 0)
  const good = { batchId: batch.batchId, read: [row.id], handled: [] }
  row.text += 'tampered'
  await assert.rejects(f.rt.projectInputs.validateReceipt('t', f.claim, good), error => error.receiptFeedback.kind === 'content-changed' && !error.receiptFeedback.correctable)
  row.text = input().text; f.rt.projectInputs.revokeSource('p', 'owner')
  await assert.rejects(f.rt.projectInputs.validateReceipt('t', f.claim, good), error => error.receiptFeedback.kind === 'source-revoked' && !error.receiptFeedback.correctable)
  const old = structuredClone(f.claim); f.rt.state.tasks.t.collaboration.claim = { ...old, id: 'new' }
  await assert.rejects(f.rt.projectInputs.validateReceipt('t', old, good), error => error.receiptFeedback.kind === 'stale-claim' && !error.receiptFeedback.correctable)
})

test('revocation while a receipt save fails cannot resurrect the old input on rollback or later regrant', async () => {
  const f = fixture(); await f.rt.projectInputs.publish(input(), actor)
  const batch = await f.rt.projectInputs.prepare('t', f.claim), row = Object.values(f.rt.state.projectTaskInputs)[0]
  const receipt = { batchId: batch.batchId, read: [row.id], handled: [row.id] }
  const save = f.rt.save
  f.rt.save = async () => { f.rt.projectInputs.revokeSource('p', 'owner'); throw new Error('disk failed during revocation') }
  await assert.rejects(f.rt.projectInputs.acknowledge('t', f.claim, receipt), /disk failed/)
  assert.equal(row.status, 'cancelled'); assert.equal(row.deliveries[0].readAt, undefined)
  f.rt.save = save
  await assert.rejects(f.rt.projectInputs.acknowledge('t', f.claim, receipt), error => error.receiptFeedback.kind === 'source-revoked' && !error.receiptFeedback.correctable)
  assert.equal(f.rt.projectInputs.pending('t').length, 0)
})

test('explicit Chief batch progress stages one durable continuation while read-only declarations do not', async () => {
  const f = fixture(), run = { id: 'chief-batches', projectId: 'p', initiatedBy: 'owner' }, snapshot = [{ taskId: 't', generation: 2 }]
  for (let index = 0; index < 4; ++index) await f.rt.projectInputs.publish(input(`batch-${index}`), actor)
  await f.rt.projectInputs.prepareChief(snapshot, run)
  const batch = snapshot[0].taskInbox, ids = batch.inputs.map(row => row.id)
  let scoped = f.rt.projectInputs.chiefActor({ ...actor, chiefJobId: run.id }, 't', snapshot[0], run, { batchId: batch.batchId, read: ids, handled: [] })
  f.rt.projectInputs.commitChief(scoped, { afterDecision: true })
  assert.equal(Object.values(f.rt.state.projectEffects).filter(row => row.payload?.requestId?.startsWith('chief-input-')).length, 0)
  scoped = f.rt.projectInputs.chiefActor({ ...actor, chiefJobId: run.id }, 't', snapshot[0], run, { batchId: batch.batchId, read: ids, handled: ids })
  f.rt.projectInputs.commitChief(scoped, { afterDecision: true }); await f.rt.save()
  const effects = Object.values(f.rt.state.projectEffects).filter(row => row.payload?.requestId?.startsWith('chief-input-'))
  assert.equal(effects.length, 1)
  assert.equal(f.rt.projectEffects.intentCommitted({ id: effects[0].id, generation: effects[0].generation }), true)
  assert.equal(f.rt.projectInputs.pending('t').length, 2)
  assert.equal(f.rt.projectInputs.commitChief(scoped, { afterDecision: true }), false)
  assert.equal(Object.values(f.rt.state.projectEffects).filter(row => row.payload?.requestId?.startsWith('chief-input-')).length, 1)
})

test('input notification waits for active Chief and reuses only current-policy queued judgements', async () => {
  for (const priorStatus of ['queued', 'running', 'correction-pending', 'interrupted', 'stale-policy']) {
    const f = fixture(), task = f.rt.state.tasks.t; task.collaboration.status = 'blocked'; task.collaboration.botId = 'p:chief'
    f.rt.state.projectChiefPolicies = { p: { enabled: true, revision: 2, authorityMemberId: 'owner' } }
    f.rt.state.projectExecutions = { prior: { id: 'prior', kind: 'chief-control', projectId: 'p', taskId: 't', policyRevision: priorStatus === 'stale-policy' ? 1 : 2, status: priorStatus === 'stale-policy' ? 'queued' : priorStatus } }
    let requested = 0
    f.rt.projectChiefControl = { async request(projectId, _kind, source) { ++requested; assert.equal(source.authorityRevision, 2); return { id: 'new-current' } } }
    await f.rt.projectInputs.publish(input(), actor); await f.rt.projectEffects.drain()
    const effect = Object.values(f.rt.state.projectEffects).find(row => row.kind === 'input.notify')
    if (priorStatus === 'queued') { assert.equal(requested, 0); assert.equal(effect.receipt.chiefRunId, 'prior') }
    else if (priorStatus === 'stale-policy') { assert.equal(requested, 1); assert.equal(effect.receipt.chiefRunId, 'new-current') }
    else {
      assert.equal(effect.waitingFor, 'chief-current-decision'); assert.equal(requested, 0)
      f.rt.state.projectExecutions.prior.status = 'failed'; f.advance(2000); await f.rt.projectEffects.drain()
      assert.equal(requested, 1); assert.equal(effect.receipt.chiefRunId, 'new-current')
    }
  }
})
