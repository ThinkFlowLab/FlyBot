// #2782: a refused save puts the whole standing-approval list back the way it was found. The
// snapshot is taken before the write and the writes are only queued (store.js:1014-1018), so two
// writers on the same Bot can overlap: the one whose save is refused restores a list that already
// lacks — or already has — the other writer's grant. The refusal here is the store's own (the
// temp name is a directory, store.js:1022), so the two saves stay refused however the calls land.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const KIND_1 = 'bash:escalate:danger-full-access'
const KIND_2 = 'pwsh'
const seed = (grants) => {
  const state = {
    version: 1,
    mainBotIds: ['a'],
    bots: {
      a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
      b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2 },
    },
    rooms: { r1: { id: 'r1', name: 'Ops', members: ['a', 'b'], mode: 'admin', admin: 'b', named: true, sessions: { b: 'gb' }, log: [], seq: 0, seen: {} } },
    agents: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {}, revision: 0,
  }
  if (grants !== undefined) state.bots.b.standingApprovals = grants
  return state
}
const kindsOf = grants => (grants ?? []).map(grant => grant.kind)
const tick = () => new Promise(resolve => setImmediate(resolve))
const until = async (check, what) => {
  const deadline = Date.now() + 3000
  while (!check() && Date.now() < deadline) await tick()
  assert.ok(check(), `never reached: ${what}`)
}
const onDisk = home => {
  const state = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  return kindsOf(state.bots.b?.standingApprovals)
}
// The store refuses every write whose temp name is not a plain file of its own (store.js:1022).
const refuseSaves = home => mkdirSync(`${join(home, 'state.json')}.${process.pid}.tmp`)
const allowSaves = home => rmSync(`${join(home, 'state.json')}.${process.pid}.tmp`, { recursive: true, force: true })

async function start(t, grants, { gated = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'approvals-serialization-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed(grants)))
  const ctx = fakeContext()
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: {
      create: async () => ({ sessionId: 's1' }),
      resolveAgent: async () => ({ agent: { session: { id: 'gb' }, calls: [], cancelled: [], inbox: { nextStep: [], nextTurn: [], remove: () => false }, followup() {}, steer() {}, cancel() {} } }),
      selectModel: async () => {},
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  const rt = createRuntime(ctx, { home })
  await rt.load()
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  const ask = (toolName, reason) => ctx.listeners.get('approval/request')[0]({ agent: { session: { id: 'gb' } }, toolName, reason }, () => 'from-dsh')
  // Held writes: the store still takes its snapshot when the test releases the call, so a test
  // can put one write in front of the other on purpose instead of racing the clock.
  const gates = []
  if (gated) {
    const realSave = rt.save
    rt.save = () => new Promise((resolve, reject) => { gates.push(() => realSave().then(resolve, reject)) })
  }
  return { rt, home, ask, gates }
}
const refusedSave = (outcome) => {
  assert.equal(outcome.status, 'rejected', 'the store must refuse this save')
  assert.match(String(outcome.reason.message), /Not saved: .*is not a plain file of its own/)
}
const sameAfterRefusal = (t, rt, home) => {
  const memory = kindsOf(rt.botOf('b').standingApprovals)
  assert.deepEqual(memory, onDisk(home), 'memory and the file disagree after a refused save')
  return memory
}

// Reading 1: two "Always allow" answers on the same Bot overlap and both saves are refused.
// Neither grant ever reached the store, so neither may be live in memory after the rollback.
test('overlapping grants: a refused save leaves no grant live that the file does not hold', async (t) => {
  const { rt, home, ask } = await start(t)
  refuseSaves(home)
  void ask('bash', 'escalate sandbox to danger-full-access: read AGENTS.md')
  void ask('pwsh', 'run the migration script')
  const cards = rt.approvalsView()
  assert.equal(cards.length, 2, 'two cards must be waiting')

  const outcomes = await Promise.allSettled([
    rt.answerApproval(cards[0].id, 'always-bot'),
    rt.answerApproval(cards[1].id, 'always-bot'),
  ])
  for (const outcome of outcomes) refusedSave(outcome)

  const memory = sameAfterRefusal(t, rt, home)
  assert.deepEqual(memory, [], `a refused grant came back as another writer's old value: ${JSON.stringify(memory)}`)
})

// Reading 2a: the same two answers, started in the other order.
test('overlapping grants in the other order: memory still equals the file', async (t) => {
  const { rt, home, ask } = await start(t)
  refuseSaves(home)
  void ask('bash', 'escalate sandbox to danger-full-access: read AGENTS.md')
  void ask('pwsh', 'run the migration script')
  const cards = rt.approvalsView()
  assert.equal(cards.length, 2, 'two cards must be waiting')

  const outcomes = await Promise.allSettled([
    rt.answerApproval(cards[1].id, 'always-bot'),
    rt.answerApproval(cards[0].id, 'always-bot'),
  ])
  for (const outcome of outcomes) refusedSave(outcome)

  const memory = sameAfterRefusal(t, rt, home)
  assert.deepEqual(memory, [], `a refused grant came back as another writer's old value: ${JSON.stringify(memory)}`)
})

// Reading 2b: a removal of one kind overlaps a grant of another kind. The removal is refused and
// the grant lands, so the Bot must end up holding both grants, in memory and in state.json.
test('a refused removal: a grant landed in the same window is not dropped', async (t) => {
  const { rt, home, ask, gates } = await start(t, [{ kind: KIND_1, label: 'bash · danger-full-access', at: 1 }], { gated: true })

  const removed = rt.removeStandingApproval('bot', 'b', KIND_1).then(() => 'saved', error => error)
  await until(() => kindsOf(rt.botOf('b').standingApprovals).length === 0 && gates.length === 1, 'the removal mutates and its save is held')

  refuseSaves(home)
  void ask('pwsh', 'run the migration script')
  const cards = rt.approvalsView()
  assert.equal(cards.length, 1, 'one card must be waiting')
  const granted = rt.answerApproval(cards[0].id, 'always-bot').then(() => 'saved', error => error)

  // The removal is refused: it never happened, and it must not take the grant with it.
  gates.shift()()
  const refused = await removed
  assert.notEqual(refused, 'saved', "the removal's save must be refused")
  assert.match(String(refused.message), /Not saved: .*is not a plain file of its own/)

  await until(() => gates.length === 1, 'the grant\'s save is held after the removal settled')
  allowSaves(home)
  gates.shift()()
  assert.equal(await granted, 'saved', 'the grant\'s save must land')

  const memory = sameAfterRefusal(t, rt, home)
  assert.deepEqual(memory, [KIND_1, KIND_2], `a refused removal dropped a grant landed in the same window: ${JSON.stringify(memory)}`)
})
