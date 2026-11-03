import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createProjectEffects } from '../src/host/project-effects.js'
import { createCommandReceipts } from '../src/host/project-command-receipts.js'
function fixture(initial) {
  const state = structuredClone(initial ?? { members: { alice: {}, bob: {} }, tasks: { t: { id: 't', projectId: 'p', requesterId: 'alice' } } })
  let disk, failSave = false, saves = 0, revoke = false
  const rt = { state, readOnly: () => undefined,
    requireProjectAccess(actor, projectId, action = 'read') { if (revoke || projectId !== 'p' || !state.members[actor?.memberId] || action !== 'read' && actor.memberId !== 'alice') throw Object.assign(Error('Current access denied'), { code: 'bot/forbidden' }) },
    async save() { ++saves; if (failSave) throw Error('fixture durable failure'); const capture = rt.projectEffects.capture(); disk = structuredClone(state); rt.projectEffects.saved(capture) },
  }
  rt.projectEffects = createProjectEffects(rt)
  const receipts = createCommandReceipts(rt), actor = { memberId: 'alice' }
  const spec = { projectId: 'p', requestId: 'once', name: 'fixture.command', args: { taskId: 't' }, action: 'task-write', taskId: 't', actor }
  return { rt, receipts, spec, actor, disk: () => disk, fail: value => { failSave = value }, revoke: () => { revoke = true }, saves: () => saves }
}

test('concurrent commands commit one result; retries ignore advanced mutable preconditions and reject intent conflicts', async () => {
  const f = fixture(); let invoked = 0, preconditions = 0
  const invoke = async () => ({ changed: ++invoked }), check = () => { if (++preconditions > 2) throw Error('stale generation') }
  const [first, second] = await Promise.all([f.receipts.run(f.spec, invoke, check), f.receipts.run(f.spec, invoke, check)])
  assert.equal(invoked, 1); assert.deepEqual(first.result, second.result)
  const retry = await f.receipts.run(f.spec, invoke, () => { throw Error('advanced generation must not reject a confirmed replay') })
  assert.equal(retry.replayed, true); assert.equal(invoked, 1)
  assert.equal(f.rt.projectEffects.intentCommitted(f.rt.state.projectCommandReceipts[first.receipt.id].resultEffect), true)
  await assert.rejects(f.receipts.run({ ...f.spec, args: { taskId: 'different' } }, invoke), error => error.code === 'bot/idempotency-conflict')
  f.revoke(); await assert.rejects(f.receipts.run(f.spec, invoke), /access denied/)
  await f.rt.projectEffects.close()
})

test('failed intent cannot dispatch; lost response recovers its durable result after restart without invoking again', async () => {
  const f = fixture(); let invoked = 0
  f.fail(true)
  await assert.rejects(f.receipts.run(f.spec, async () => ({ changed: ++invoked })), /durable failure/)
  assert.equal(invoked, 0); assert.equal(Object.keys(f.rt.state.projectCommandReceipts).length, 0)
  f.fail(false)
  await f.receipts.run(f.spec, async () => ({ changed: ++invoked }))
  const g = fixture(f.disk()); g.rt.projectEffects.recover()
  const recovered = await g.receipts.run(g.spec, async () => { throw Error('Must not execute') })
  assert.deepEqual(recovered.result, { changed: 1 }); assert.equal(recovered.replayed, true)
  assert.equal(invoked, 1)
  await Promise.all([f.rt.projectEffects.close(), g.rt.projectEffects.close()])
})

test('ambiguous command outcomes do not silently repeat and private receipt/effect access stays principal scoped', async () => {
  const f = fixture(); let invoked = 0
  await assert.rejects(f.receipts.run(f.spec, async () => { ++invoked; throw Error('External outcome unknown') }), /outcome unknown/)
  await assert.rejects(f.receipts.run(f.spec, async () => { ++invoked }), error => error.code === 'bot/outcome-unknown')
  assert.equal(invoked, 1)
  assert.equal(f.receipts.get('p', 'once', f.actor).status, 'unknown')
  assert.throws(() => f.receipts.get('p', 'once', { memberId: 'bob' }), /unavailable/)
  assert.equal(f.rt.projectEffects.list('p', { memberId: 'bob' }).length, 0)
  const own = f.rt.projectEffects.list('p', f.actor)
  assert.ok(own.length >= 2)
  await assert.rejects(f.rt.projectEffects.retry({ projectId: 'p', effectId: own[0].id, requestId: 'unauthorized' }, { memberId: 'bob' }))
  await f.rt.projectEffects.close()
})

test('explicit reconciliation seals a result without a second generic invocation; current Task source is stamped once', async () => {
  const f = fixture(); let invoked = 0
  const spec = { ...f.spec, name: 'task.propose' }
  await assert.rejects(f.receipts.run(spec, async () => {
    ++invoked
    const source = f.receipts.source('p')
    assert.equal(source.origin.kind, 'human'); assert.ok(source.commandReceiptId)
    assert.equal(f.receipts.source('p'), null)
    throw Error('response lost after target commit')
  }))
  const recovered = await f.receipts.run({ ...spec, reconcile: async () => ({ result: { taskId: 'durable-target' } }) }, async () => { ++invoked })
  assert.equal(invoked, 1); assert.equal(recovered.reconstructed, true)
  const page = f.receipts.result('p', { commandRequestId: 'once', limit: 1000 }, f.actor)
  assert.equal(page.text, JSON.stringify({ taskId: 'durable-target' }))
  assert.throws(() => f.receipts.result('p', { commandRequestId: 'once', expectedSha256: 'stale' }, f.actor), /changed/)
  await f.rt.projectEffects.close()
})

test('an observed result without its final commit is labelled pending and retries finish it without executing twice', async () => {
  const f = fixture(); let invoked = 0
  await assert.rejects(f.receipts.run(f.spec, async () => { ++invoked; f.fail(true); return { changed: true } }), /durable failure/)
  const pending = f.receipts.get('p', 'once', f.actor)
  assert.equal(pending.status, 'completion-pending-commit'); assert.equal(pending.committed, false)
  assert.throws(() => f.receipts.result('p', { commandRequestId: 'once' }, f.actor), /not committed/)
  f.fail(false)
  const recovered = await f.receipts.run(f.spec, async () => { ++invoked })
  assert.equal(invoked, 1); assert.equal(recovered.receipt.committed, true)
  assert.deepEqual(recovered.result, { changed: true })
  await f.rt.projectEffects.close()
})

test('large recovered results are hash scoped, paged and refuse symlinked payloads', async t => {
  const fs = await import('node:fs'), { tmpdir } = await import('node:os'), { join } = await import('node:path')
  const f = fixture(); f.rt.home = fs.mkdtempSync(join(tmpdir(), 'flybot-command-result-'))
  t.after(async () => { await f.rt.projectEffects.close(); fs.rmSync(f.rt.home, { recursive: true, force: true }) })
  const result = { text: 'result data '.repeat(10000) }
  const completed = await f.receipts.run(f.spec, async () => result)
  assert.equal((await f.receipts.run(f.spec, async () => { throw Error('No redispatch') })).result.text, result.text)
  const row = f.rt.state.projectCommandReceipts[completed.receipt.id]
  assert.equal(row.resultText, undefined); assert.equal(row.resultFile, true)
  assert.equal(f.receipts.result('p', { commandRequestId: 'once', limit: 99 }, f.actor).text.length, 99)
  const file = join(f.rt.home, 'project-command-results', row.resultSha256 + '.json'), outside = join(f.rt.home, 'outside-reference.json')
  fs.writeFileSync(outside, JSON.stringify(result)); fs.unlinkSync(file); fs.symlinkSync(outside, file)
  assert.throws(() => f.receipts.result('p', { commandRequestId: 'once' }, f.actor), /regular file/)
})

test('an omitted candidate precondition differs from explicitly requiring no candidate', async () => {
  const f = fixture()
  await f.receipts.run(f.spec, async () => ({ changed: true }))
  await assert.rejects(f.receipts.run({ ...f.spec, expectedCandidateSha: null }, async () => ({ changed: false })), error => error.code === 'bot/idempotency-conflict')
  await f.rt.projectEffects.close()
})

test('native and external connections of one independent personal agent share receipts across carrier changes', async () => {
  const f = fixture()
  f.rt.state.projectAgents = { carrier: { personalAgentId: 'independent-agent' }, replacement: { personalAgentId: 'independent-agent' } }
  const native = { memberId: 'alice', agentId: 'carrier', watchGrantId: 'grant-1' }
  const external = { memberId: 'alice', agentId: 'independent-agent', personalAgentCredentialId: 'external-credential' }
  let invoked = 0
  const first = await f.receipts.run({ ...f.spec, actor: native }, async () => ({ changed: ++invoked }))
  assert.equal(first.receipt.origin.kind, 'personal-agent')
  assert.equal(first.receipt.origin.agentId, 'independent-agent')
  const repeated = await f.receipts.run({ ...f.spec, actor: external }, async () => ({ changed: ++invoked }))
  const rotated = await f.receipts.run({ ...f.spec, actor: { ...native, agentId: 'replacement', watchGrantId: 'grant-2' } }, async () => ({ changed: ++invoked }))
  assert.equal(invoked, 1); assert.equal(first.receipt.id, repeated.receipt.id); assert.equal(rotated.receipt.id, first.receipt.id)
  f.rt.state.members.alice.status = 'disabled'
  await assert.rejects(f.receipts.run({ ...f.spec, actor: external }, async () => ({})), /disabled/)
  await f.rt.projectEffects.close()
})

test('request IDs are operation scoped; ambiguous lookups require a name and missing receipt queries are pure', async () => {
  const f = fixture(), original = JSON.stringify(f.rt.state)
  assert.throws(() => f.receipts.get('p', 'missing', f.actor), /unavailable/)
  assert.equal(JSON.stringify(f.rt.state), original)
  const first = await f.receipts.run(f.spec, async () => ({ first: true }))
  const second = await f.receipts.run({ ...f.spec, name: 'fixture.other' }, async () => ({ second: true }))
  assert.notEqual(first.receipt.id, second.receipt.id)
  assert.throws(() => f.receipts.get('p', 'once', f.actor), error => error.code === 'bot/ambiguous-command')
  assert.equal(f.receipts.get('p', 'once', f.actor, 'fixture.other').id, second.receipt.id)
  assert.equal(f.receipts.result('p', { commandRequestId: 'once', commandName: f.spec.name }, f.actor).text, '{"first":true}')
  await f.rt.projectEffects.close()
})
