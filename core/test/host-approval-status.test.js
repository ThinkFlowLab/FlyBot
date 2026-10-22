// #754: the host side of a hold reads the same rule as the client (#734). A `pending_approval`
// hold — Bot Social's own outbound hold, the spelling its plugin side accepts — used to be a card
// whose Approve the host refused, a hold the chat drew as "Not sent", a record cleaned up mid-wait,
// a record the cap did not count, and a wait badge that never saw it. The judgment lives once, in
// `src/shared/approval-waiting.js`; these tests drive it through the host paths that used to hold
// their own literal.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const team = () => ({
  version: 1,
  mainBotIds: ['a'],
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
    b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2 },
    c: { id: 'c', name: 'Coder', role: 'Code', sessionId: 'c', createdAt: 3 },
  },
  rooms: {}, agents: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {}, revision: 0,
})

async function start(config = {}) {
  const home = config.home ?? mkdtempSync(join(tmpdir(), 'ds-bot-approval-status-'))
  if (config.home === undefined) writeFileSync(join(home, 'state.json'), JSON.stringify(config.state ?? team()))
  const ctx = fakeContext()
  const agents = new Map()
  const agentOf = (id) => {
    if (!agents.has(id)) {
      const calls = []
      agents.set(id, {
        session: { id, requestHeader: () => undefined }, id, calls, status: 'idle',
        followup(m) { calls.push(['followup', m]) }, steer(m) { calls.push(['steer', m]) },
        inject() {}, cancel() {}, async whenIdle() {}, inbox: { nextStep: [], nextTurn: [], remove() {} },
      })
    }
    return agents.get(id)
  }
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: { create: async () => ({ sessionId: 's1' }), resolveAgent: async id => ({ agent: agentOf(id) }), selectModel: async () => {}, page: async () => ({ records: [], hasMore: false }) },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => {
    if (options.path.endsWith('bot')) route = options
    return register(options)
  }
  apply(ctx, { home })
  const call = async (endpoint, payload) => {
    const response = await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))
    return response.json()
  }
  const stop = async ({ keepHome = false } = {}) => {
    await ctx.dispose()
    if (!keepHome) rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  const received = id => (agents.get(id)?.calls ?? []).map(([, m]) => m.content.map(b => b.text).join('\n'))
  const statePath = join(home, 'state.json')
  return { ctx, fb: ctx.flybot, call, home, stop, received, statePath }
}

// Holds every send flagged meta.hold, so a test decides exactly the sends it created.
function holdFlagged(fb) {
  fb.bot.send.use({ name: 'gate', handle: async msg => (msg.meta?.hold ? { action: 'hold', reason: 'held by test' } : undefined) })
}

const heldId = async (fb, spec) => {
  const result = await fb.bot.send(spec)
  assert.equal(result.action, 'hold', JSON.stringify(result))
  return result.approvalId
}

// Rewrites one stored hold's status, the way a plugin or an older Bot Social would have written it.
function setStatus(statePath, id, status) {
  const state = JSON.parse(readFileSync(statePath, 'utf8'))
  const record = state.flybot.approvals[id]
  assert.ok(record, `approval ${id} is stored`)
  record.status = status
  writeFileSync(statePath, JSON.stringify(state))
}

// A held auto-reply, the shape the chat card reads (#418).
const heldReply = (fb, spec = {}) => heldId(fb, { from: 'a', to: 'b', text: 'a held reply', via: 'auto-reply', meta: { hold: true, replyIn: { sessionId: 's1', turn: 1 } }, ...spec })

test('#754: a pending_approval hold is approved by the host, and the reply leaves', async (t) => {
  const first = await start()
  holdFlagged(first.fb)
  const id = await heldReply(first.fb)
  await first.ctx.dispose()
  setStatus(first.statePath, id, 'pending_approval')

  const { call, stop, received } = await start({ home: first.home })
  t.after(stop)
  // The chat's own view of it is a waiting hold, not a settled "Not sent".
  const view = (await call('state', {})).value
  const held = view.bots.find(bot => bot.id === 'a').heldReplies
  assert.deepEqual(held.map(entry => [entry.id, entry.status]), [[id, 'pending_approval']])
  assert.equal(view.bots.find(bot => bot.id === 'a').pendingCount, 1, 'the row counts it as waiting')

  const decided = await call('flybot/decide', { id, decision: 'approve' })
  assert.equal(decided.ok, true, JSON.stringify(decided))
  assert.equal(decided.value.status, 'approved')
  assert.deepEqual(received('b'), ['[Message from Chief]\na held reply'], 'the approved hold was dispatched')
  // The turn now reads Sent, and nothing on the row is waiting any more.
  const after = (await call('state', {})).value.bots.find(bot => bot.id === 'a')
  assert.deepEqual(after.heldReplies.map(entry => [entry.id, entry.status]), [[id, 'approved']])
  assert.equal(after.pendingCount, 0, 'nothing is left waiting')
})

test('#754: a pending_approval hold is rejected by the host, and nothing is dispatched', async (t) => {
  const first = await start()
  holdFlagged(first.fb)
  const id = await heldReply(first.fb)
  await first.ctx.dispose()
  setStatus(first.statePath, id, 'pending_approval')
  const { call, stop, received } = await start({ home: first.home })
  t.after(stop)
  const decided = await call('flybot/decide', { id, decision: 'reject' })
  assert.equal(decided.ok, true, JSON.stringify(decided))
  assert.equal(decided.value.status, 'rejected')
  assert.deepEqual(received('b'), [], 'a rejected hold never goes out')
})

test('#754: a settled status is still refused, and it cannot be decided twice', async () => {
  for (const status of ['approved', 'auto', undefined]) {
    const first = await start()
    holdFlagged(first.fb)
    const id = await heldReply(first.fb)
    await first.ctx.dispose()
    setStatus(first.statePath, id, status)
    const { call, stop } = await start({ home: first.home })
    try {
      for (const decision of ['approve', 'reject']) {
        const refused = await call('flybot/decide', { id, decision })
        assert.equal(refused.ok, false, `${String(status)} is refused for ${decision}`)
        assert.equal(refused.error.code, 'bot/stale', JSON.stringify(refused))
      }
    } finally {
      await stop()
    }
  }
})

test('#754: an open hold counts toward the cap, whichever waiting spelling it uses', async (t) => {
  const first = await start()
  holdFlagged(first.fb)
  const id = await heldReply(first.fb)
  await first.ctx.dispose()
  // Fill the cap with waiting holds: the stored one, copied to 99 more.
  const state = JSON.parse(readFileSync(first.statePath, 'utf8'))
  const record = state.flybot.approvals[id]
  record.status = 'pending_approval'
  state.flybot.approvals = {}
  for (let i = 0; i < 100; i++) state.flybot.approvals[`${id}-${i}`] = { ...record, id: `${id}-${i}`, createdAt: 1000 + i }
  writeFileSync(first.statePath, JSON.stringify(state))

  const { fb, stop } = await start({ home: first.home })
  t.after(stop)
  holdFlagged(fb)
  const refused = await fb.bot.send({ from: 'a', to: 'b', text: 'one too many', meta: { hold: true } })
  assert.equal(refused.action, 'deny', JSON.stringify(refused))
  assert.match(refused.reason, /100 messages already wait for approval/)
})

test('#754: a waiting hold is not cleaned up as a finished one', async (t) => {
  const first = await start()
  holdFlagged(first.fb)
  const id = await heldReply(first.fb)
  await first.ctx.dispose()
  // One waiting hold older than 200 finished ones: the cleanup keeps waiting records, so only the
  // finished ones may be dropped when the store overflows.
  const state = JSON.parse(readFileSync(first.statePath, 'utf8'))
  const record = state.flybot.approvals[id]
  state.flybot.approvals = { [id]: { ...record, status: 'pending_approval', createdAt: 1 } }
  for (let i = 0; i < 200; i++) state.flybot.approvals[`done-${i}`] = { ...record, id: `done-${i}`, status: 'rejected', createdAt: 100 + i }
  writeFileSync(first.statePath, JSON.stringify(state))

  const { fb, call, stop } = await start({ home: first.home })
  t.after(stop)
  holdFlagged(fb)
  const created = await fb.bot.send({ from: 'b', to: 'a', text: 'a new hold', meta: { hold: true } })
  assert.equal(created.action, 'hold', JSON.stringify(created))
  const all = await call('flybot/approvals', { status: 'all' })
  assert.equal(all.ok, true)
  const ids = all.value.map(entry => entry.id)
  assert.ok(ids.includes(id), 'the waiting hold survived the cleanup')
  assert.ok(ids.includes(created.approvalId), 'the new hold is stored')
  assert.ok(!ids.includes('done-0'), 'a finished record was the one dropped')
})

test('#754: a closed-out Bot cannot leave a waiting hold behind', async (t) => {
  const first = await start()
  holdFlagged(first.fb)
  const id = await heldId(first.fb, { from: 'b', to: 'c', text: 'from a Bot about to go', meta: { hold: true } })
  await first.ctx.dispose()
  setStatus(first.statePath, id, 'pending_approval')
  const { call, stop } = await start({ home: first.home })
  t.after(stop)
  const deleted = await call('delete-bot', { id: 'b' })
  assert.equal(deleted.ok, true, JSON.stringify(deleted))
  const stored = (await call('flybot/approvals', { status: 'all' })).value.find(entry => entry.id === id)
  assert.equal(stored.status, 'stale', 'the hold is invalidated, not left decidable')
  assert.equal((await call('flybot/decide', { id, decision: 'approve' })).ok, false)
})

test('#754: host and client import the same judgment, and neither keeps a literal of its own', () => {
  // One module, imported by both sides: the acceptance is that no side holds its own copy.
  assert.equal(existsSync(new URL('../src/client/approval-waiting.js', import.meta.url)), false, 'the client copy is gone')
  const read = path => readFileSync(new URL(path, import.meta.url), 'utf8')
  const files = {
    'hooks.js': read('../src/host/hooks.js'),
    'channel.js': read('../src/host/channel.js'),
    'held-reply.js': read('../src/client/held-reply.js'),
    'flybot-slots.js': read('../src/client/flybot-slots.js'),
    'cells.js': read('../src/client/cells.js'),
  }
  // The statuses each used to spell out for itself, by name: a hold status is never compared to
  // the literal `pending` here again, so a third waiting spelling cannot land on one side only.
  const ownLiteral = {
    'hooks.js': /a\.status === 'pending'|a\.status !== 'pending'|approval\.status !== 'pending'/,
    'channel.js': /reply\.status === 'pending'/,
    'held-reply.js': /held\?\.status === 'pending'/,
    'flybot-slots.js': /approval\.status === 'pending'/,
    'cells.js': /held\.status === 'pending'/,
  }
  for (const [name, source] of Object.entries(files)) {
    assert.match(source, /from '\.\.\/shared\/approval-waiting\.js'/, `${name} imports the shared rule`)
    assert.doesNotMatch(source, ownLiteral[name], `${name} keeps no literal of its own`)
  }
  assert.match(files['hooks.js'], /isApprovalWaiting\(a\.status\)/, 'the cap, the cleanup and the in-flight filter ask the rule')
  assert.match(files['hooks.js'], /!isApprovalWaiting\(approval\.status\)/, 'decide() asks the rule')
  assert.match(files['hooks.js'], /isApprovalWaiting\(a\.status\) \)?\|\| a\.status === 'failed'|\) : 'rejected'/, 'heldOf asks the rule')
  assert.match(files['channel.js'], /isApprovalWaiting\(reply\.status\)/, 'the wait badge asks the rule')
  assert.match(files['cells.js'], /isApprovalWaiting\(held\.status\)/, 'the chat bubble asks the rule')
})
