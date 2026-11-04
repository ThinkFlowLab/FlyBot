import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createProjectEffects, EffectDeferred, EffectCancelled } from '../src/host/project-effects.js'

function fixture(state = {}, handler) {
  let clock = 100, disk, saveFailure = false, hold
  const seen = []
  const rt = { state, readOnly: () => undefined, requireProjectAccess(actor, projectId, action) { if (actor?.memberId !== 'owner' || projectId !== 'p' || action && action !== 'configure') throw Error('Denied') } }
  const effects = createProjectEffects(rt, { now: () => clock })
  rt.save = async () => {
    const capture = effects.capture(), snapshot = structuredClone(state)
    if (hold) await hold
    if (saveFailure) throw Error('Disk unavailable')
    disk = snapshot; effects.saved(capture)
  }
  const spec = { kind: 'test', key: 'stable', projectId: 'p', taskId: 't', payload: { value: 1 } }
  effects.register('test', handler ?? { run: async row => { seen.push(row.payload.value); return { receipt: row.payload.value } } })
  return { effects, rt, spec, seen, disk: () => disk, tick: n => { clock += n }, failSave: value => { saveFailure = value }, holdSave: value => { hold = value } }
}

test('operator-configured retry budget applies to the original effect engine and rejects invalid timing before intent', async () => {
  const f = fixture({}, { run: async () => { throw Error('receiver offline') } })
  f.rt.config = { projectEffectRetry: { test: { maxFailures: 2, baseDelayMs: 100, maxDelayMs: 500 } } }
  const token = f.effects.stage(f.spec); await f.effects.persist(token); await f.effects.drain()
  assert.equal(f.rt.state.projectEffects[token.id].failures, 1)
  assert.equal(f.rt.state.projectEffects[token.id].status, 'pending')
  f.tick(200); await f.effects.drain()
  assert.equal(f.rt.state.projectEffects[token.id].status, 'failed')
  f.rt.config.projectEffectRetry.test.baseDelayMs = -1
  assert.throws(() => f.effects.stage({ ...f.spec, key: 'invalid' }), /retry configuration/)
})

test('intent and business state commit together; uncommitted or failed saves cannot execute', async () => {
  const f = fixture({ tasks: { t: { status: 'queued' } } })
  const token = f.effects.stage(f.spec)
  await f.effects.drain(); assert.deepEqual(f.seen, [])
  f.failSave(true)
  await assert.rejects(f.effects.persist(token), /Disk unavailable/)
  await f.effects.drain(); assert.deepEqual(f.seen, [])
  f.failSave(false)
  await f.effects.persist(token)
  assert.equal(f.disk().tasks.t.status, 'queued')
  assert.equal(f.disk().projectEffects[token.id].status, 'pending')
  await Promise.all([f.effects.drain(), f.effects.drain(), f.effects.drain()])
  assert.deepEqual(f.seen, [1])
  assert.equal(f.disk().projectEffects[token.id].status, 'done')
  assert.deepEqual(f.effects.stage(f.spec), token)
  await f.effects.drain(); assert.deepEqual(f.seen, [1])
  assert.throws(() => f.effects.stage({ ...f.spec, payload: { value: 2 } }), /different content/)
})

test('a no-op store save is not a durability receipt', async () => {
  const f = fixture(); f.rt.save = async () => {}
  const token = f.effects.stage(f.spec)
  await assert.rejects(f.effects.persist(token), /not confirmed/)
  await f.effects.drain(); assert.deepEqual(f.seen, [])
  assert.equal(f.effects.discardUncommitted(token), true)
  assert.deepEqual(f.rt.state.projectEffects, {})
})

test('restart replays a committed pending action and reconciles ambiguous remote success by stable identity', async () => {
  const f = fixture(), token = f.effects.stage(f.spec)
  await f.effects.persist(token)
  const state = structuredClone(f.disk()), g = fixture(state)
  g.effects.recover(); await g.effects.drain()
  assert.deepEqual(g.seen, [1])
  assert.equal(g.disk().projectEffects[token.id].status, 'done')
  let remote = 0
  const h = fixture(), pending = h.effects.stage(h.spec)
  await h.effects.persist(pending)
  h.rt.state.projectEffects[pending.id].status = 'running'
  ++h.rt.state.projectEffects[pending.id].revision
  await h.rt.save()
  remote++ // Lost reply after the external system accepted the stable action.
  const restored = fixture(structuredClone(h.disk()), { run: async () => ({ remote }) })
  assert.equal(restored.effects.recover(), true)
  await restored.rt.save(); await restored.effects.drain()
  assert.equal(remote, 1)
  assert.deepEqual(restored.disk().projectEffects[pending.id].receipt, { remote: 1 })
})

test('old completion cannot acknowledge a replaced generation', async () => {
  const f = fixture(); let release, started
  const gate = new Promise(resolve => { release = resolve }), ready = new Promise(resolve => { started = resolve })
  f.effects.register('slow', { run: async row => { started(); await gate; return { value: row.payload.value } } })
  const spec = { ...f.spec, kind: 'slow' }, token = f.effects.stage(spec)
  await f.effects.persist(token)
  const running = f.effects.drain(); await ready
  const replacement = f.effects.stage({ ...spec, replace: true, payload: { value: 2 } })
  await f.effects.persist(replacement); release(); await running
  const row = f.rt.state.projectEffects[token.id]
  assert.equal(row.generation, 2)
  assert.equal(row.status, 'pending')
  assert.deepEqual(row.history[0].lateReceipt, { value: 1 })
  await f.effects.drain()
  assert.equal(row.status, 'done'); assert.deepEqual(row.receipt, { value: 2 })
})

test('resource waits defer without failure, retries back off and authority cancellation never retries', async () => {
  const f = fixture(); let mode = 'defer', calls = 0
  f.effects.register('unstable', { validate: async () => { if (mode === 'cancel') throw new EffectCancelled('Stopped or revoked') }, run: async () => { calls++; if (mode === 'defer') throw new EffectDeferred('Resource busy'); throw Error('secret error must not be projected') } })
  const token = f.effects.stage({ ...f.spec, kind: 'unstable' }); await f.effects.persist(token)
  await f.effects.drain()
  const row = f.rt.state.projectEffects[token.id]
  assert.equal(row.failures, 0); assert.equal(row.status, 'pending')
  await f.effects.drain(); assert.equal(calls, 1)
  f.tick(1000); mode = 'fail'
  for (let n = 0; n < 6; n++) { await f.effects.drain(); f.tick(60001) }
  assert.equal(row.status, 'failed'); assert.equal(row.failures, 6)
  assert.ok(!JSON.stringify(f.effects.list('p', { memberId: 'owner' })).includes('secret error'))
  await assert.rejects(f.effects.retry({ projectId: 'other', effectId: row.id, requestId: 'retry' }, { memberId: 'owner' }))
  mode = 'cancel'
  await f.effects.retry({ projectId: 'p', effectId: row.id, requestId: 'retry' }, { memberId: 'owner' })
  const prior = calls; await f.effects.drain()
  assert.equal(row.status, 'cancelled'); assert.equal(calls, prior)
})

test('inline publication persists intent before I/O and stores its receipt with business effects', async () => {
  const f = fixture({ published: false })
  f.effects.register('publish', { run: async row => { assert.equal(f.disk().projectEffects[row.id].status, 'running'); f.rt.state.published = true; return { pr: 123 } } })
  const spec = { ...f.spec, kind: 'publish' }
  assert.deepEqual(await f.effects.perform(spec), { pr: 123 })
  assert.equal(f.disk().published, true)
  assert.deepEqual(await f.effects.perform(spec), { pr: 123 })
  await f.effects.close()
  assert.throws(() => f.effects.stage({ ...spec, key: 'other' }), /not writable/)
})

test('late receipts cannot commit a staged replacement that the caller has not saved', async () => {
  const f = fixture(); let release, started
  const gate = new Promise(resolve => { release = resolve }), ready = new Promise(resolve => { started = resolve })
  f.effects.register('slow-uncommitted', { run: async row => { f.seen.push(row.payload.value); started(); await gate; return { value: row.payload.value } } })
  const spec = { ...f.spec, kind: 'slow-uncommitted' }, original = f.effects.stage(spec)
  await f.effects.persist(original)
  const first = f.effects.drain(); await ready
  const replacement = f.effects.stage({ ...spec, replace: true, payload: { value: 2 } })
  release(); await first
  assert.equal(f.disk().projectEffects[original.id].generation, 1)
  f.failSave(true)
  await assert.rejects(f.effects.persist(replacement), /Disk unavailable/)
  assert.equal(f.effects.discardUncommitted(replacement), true)
  f.failSave(false); await f.effects.drain()
  assert.equal(f.rt.state.projectEffects[original.id].status, 'done')
  assert.ok(f.seen.every(value => value === 1), 'the uncommitted replacement never executes')
})

test('storage recovery retries a launch checkpoint or receipt without dropping committed work', async () => {
  const f = fixture(), token = f.effects.stage(f.spec)
  await f.effects.persist(token); f.failSave(true)
  await assert.rejects(f.effects.drain(), /Disk unavailable/)
  assert.deepEqual(f.seen, [])
  f.failSave(false); f.tick(1001); await f.effects.drain()
  assert.deepEqual(f.seen, [1])
  const g = fixture()
  g.effects.register('receipt-failure', { run: async () => { g.seen.push(1); g.failSave(true); return { remote: 'accepted' } } })
  const receipt = g.effects.stage({ ...g.spec, kind: 'receipt-failure' }); await g.effects.persist(receipt)
  await assert.rejects(g.effects.drain(), /Disk unavailable/)
  assert.equal(g.disk().projectEffects[receipt.id].status, 'running')
  g.failSave(false); await g.effects.drain()
  assert.deepEqual(g.seen, [1])
  assert.equal(g.disk().projectEffects[receipt.id].status, 'done')
})

test('a rename acknowledgement survives a later journal error while unknown protocol records are retained', async () => {
  const f = fixture(), token = f.effects.stage(f.spec)
  f.rt.save = async () => { f.effects.saved(f.effects.capture()); throw Error('Journal failed after rename') }
  await f.effects.persist(token); await f.effects.drain()
  assert.deepEqual(f.seen, [1])
  const state = { projectEffects: { future: { id: 'future', version: 'project-effect/v99', generation: 1, revision: 1, projectId: 'p', status: 'pending', dueAt: 0, kind: 'test', key: 'future', payload: { value: 99 } } } }
  const g = fixture(state), before = JSON.stringify(state)
  g.effects.recover(); await g.effects.drain()
  assert.equal(JSON.stringify(state), before)
  assert.deepEqual(g.seen, [])
})

test('intent commit proof survives receipt revisions but cannot authorize a replacement or future protocol', async () => {
  const f=fixture(),token=f.effects.stage(f.spec)
  assert.equal(f.effects.intentCommitted(token),false)
  assert.equal(f.effects.intentCommitted(null),false)
  await f.effects.persist(token)
  assert.equal(f.effects.intentCommitted(token),true)
  f.rt.state.projectEffects[token.id].revision++
  assert.equal(f.effects.list('p',{memberId:'owner'})[0].committed,false)
  assert.equal(f.effects.intentCommitted(token),true,'Durable unchanged intent is distinct from an unsaved receipt revision')
  const next=f.effects.stage({...f.spec,payload:{value:2},replace:true})
  assert.equal(f.effects.intentCommitted(token),false)
  assert.equal(f.effects.intentCommitted(next),false)
  await f.effects.persist(next)
  assert.equal(f.effects.intentCommitted(next),true)
  f.rt.state.projectEffects[next.id].version='project-effect/v999'
  assert.equal(f.effects.intentCommitted(next),false)
})
