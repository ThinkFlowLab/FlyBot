import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { ROOM_REPLY_TIMEOUT_MS } from '../src/host/constants.js'

// Chief in its own chat 'a'; Writer, the admin of group 'r1', speaks there from 'gb'.
const seed = () => ({
  version: 1,
  mainBotIds: ['a'],
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
    b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2 },
  },
  rooms: { r1: { id: 'r1', name: 'Ops', members: ['a', 'b'], mode: 'admin', admin: 'b', named: true, sessions: { b: 'gb' }, log: [], seq: 0, seen: {} } },
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  prefs: {},
  revision: 0,
})

async function start(home = mkdtempSync(join(tmpdir(), 'ds-bot-status-'))) {
  if (!existsSync(join(home, 'state.json'))) writeFileSync(join(home, 'state.json'), JSON.stringify(seed()))
  const ctx = fakeContext()
  const agents = new Map()
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) {
      const calls = []
      const cancelled = []
      // What the Session has not taken up yet; a test empties it when the turn starts.
      const held = []
      const inbox = {
        nextStep: [],
        nextTurn: held,
        remove(id) {
          const at = held.findIndex(message => message.id === id)
          if (at === -1) return false
          held.splice(at, 1)
          return true
        },
      }
      const keep = (message) => { calls.push(message); held.push(message) }
      agents.set(sessionId, { session: { id: sessionId }, calls, cancelled, inbox, followup: keep, steer: keep, cancel(reason) { cancelled.push(reason) } })
    }
    return agents.get(sessionId)
  }
  const archived = []
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async (id, options) => { archived.push([id, options]) } },
    sessionController: { create: async () => ({ sessionId: 's1' }), resolveAgent: async sessionId => ({ agent: agentOf(sessionId) }), selectModel: async () => {} },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => { route = options; return register(options) }
  apply(ctx, { home })
  let seq = 0
  const emit = (id, type, data) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener({ id }, { type, seq: ++seq, data })
    }
  }
  const tool = (name, args, sessionId, exec = {}) => ctx.registeredTools.get(name).execute(args, { agent: { id: sessionId }, ...exec })
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))).json()
  const askApproval = (sessionId, extra = {}, next = () => 'from-dsh') => ctx.listeners.get('approval/request')[0]({ agent: { session: { id: sessionId } }, toolName: 'pwsh', reason: 'escalate sandbox', ...extra }, next)
  // A restart test reopens the same home, so removal is the caller's choice.
  const stop = async ({ keepHome = false } = {}) => { await ctx.dispose(); if (!keepHome) rmSync(home, { recursive: true, force: true, maxRetries: 5 }) }
  await tool('list_bots', {}, 'a')
  return { agentOf, emit, tool, call, askApproval, stop, archived, home }
}

// Waits on real I/O (state writes) without timers, which some tests mock.
const settle = async (check) => {
  const until = Date.now() + 3000
  while (!check() && Date.now() < until) await new Promise(resolve => setImmediate(resolve))
  assert.ok(check(), 'condition not reached')
}
const text = message => message.content.map(block => block.text ?? '').join('\n')

// Starts a round in 'r1' and opens Writer's turn in 'gb'; the round stops with the test.
async function openTurn(t, { agentOf, emit, tool }) {
  let result
  const stop = new AbortController()
  t.after(() => stop.abort())
  void tool('group_relay', {}, 'r1', { callId: 'c1', signal: stop.signal }).then((value) => { result = JSON.parse(value) })
  await settle(() => agentOf('gb').calls.length === 1)
  const message = agentOf('gb').calls[0]
  agentOf('gb').inbox.nextTurn.length = 0
  emit('gb', 'turn/start', { turn: 1 })
  emit('gb', 'user/message', { content: message.content, source: message.source })
  const read = () => result
  read.stop = () => stop.abort()
  return read
}

test('a group Session\'s approval waits in the team view, frees the round, and the late reply reaches the group', async (t) => {
  const host = await start()
  t.after(host.stop)
  const result = await openTurn(t, host)
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'pwsh', arguments: JSON.stringify({ command: 'Copy-Item a.md E:/docs', description: 'Copy the doc' }) })
  const outcome = host.askApproval('gb', { callId: 'k1' })

  await settle(() => result() !== undefined)
  assert.deepEqual(result().replies.map(reply => [reply.kind, reply.name]), [['approval', 'Writer']])

  const { value } = await host.call('state', {})
  assert.equal(value.activity.b, 'alert')
  const [approval] = value.work.approvals
  assert.deepEqual([approval.botId, approval.roomId, approval.tool, approval.answerable], ['b', 'r1', 'pwsh', true])
  assert.deepEqual(approval.detail, { text: 'Copy the doc', code: 'Copy-Item a.md E:/docs' })
  assert.equal(value.work.bots.b.roomId, 'r1')
  assert.equal(value.work.bots.b.tool, 'pwsh')

  assert.equal((await host.call('approval-answer', { id: approval.id, choice: 'allow' })).ok, true)
  assert.equal(await outcome, 'allowed-once')
  assert.equal((await host.call('approval-answer', { id: approval.id, choice: 'allow' })).error.code, 'bot/stale')
  assert.deepEqual((await host.call('state', {})).value.work.approvals, [])

  host.emit('gb', 'tool/result', { callId: 'k1' })
  host.emit('gb', 'assistant/message', { message: { content: [{ type: 'text', text: 'Writer: Copied the doc to E:/docs.' }] } })
  host.emit('gb', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await settle(() => host.agentOf('r1').calls.length === 1)
  const post = host.agentOf('r1').calls[0]
  assert.deepEqual([post.source.role, post.source.late, post.source.senderSessionId], ['post', true, 'b'])
  assert.equal(text(post), '[Group post from Writer]\nCopied the doc to E:/docs.')
})

test('an own chat\'s approval stays with DSH and is listed while it waits', async (t) => {
  const host = await start()
  t.after(host.stop)
  let release
  const outcome = host.askApproval('a', {}, () => new Promise((resolve) => { release = resolve }))
  const [approval] = (await host.call('state', {})).value.work.approvals
  assert.deepEqual([approval.botId, approval.roomId, approval.answerable], ['a', undefined, false])
  assert.equal((await host.call('approval-answer', { id: approval.id, choice: 'allow' })).error.code, 'bot/stale')
  release('rejected')
  assert.equal(await outcome, 'rejected')
  assert.deepEqual((await host.call('state', {})).value.work.approvals, [])
  // Sessions off the team are not DS Bot's to answer.
  assert.equal(await host.askApproval('elsewhere'), 'from-dsh')
})

test('a member still going keeps its turn; one quiet for the whole wait is missed, and a later [PASS] stays out of the group', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = await start()
  t.after(host.stop)
  const result = await openTurn(t, host)
  t.mock.timers.tick(ROOM_REPLY_TIMEOUT_MS - 1000)
  // A team tool is quick: it does not let the round go on without the member.
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'list_bots', arguments: '{}' })
  t.mock.timers.tick(ROOM_REPLY_TIMEOUT_MS - 1000)
  await settle(() => true)
  assert.equal(result(), undefined)

  t.mock.timers.tick(1000)
  await settle(() => result() !== undefined)
  assert.deepEqual(result().replies.map(reply => [reply.kind, reply.name]), [['missed', 'Writer']])

  host.emit('gb', 'assistant/message', { message: { content: [{ type: 'text', text: '[PASS]' }] } })
  host.emit('gb', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await settle(() => true)
  assert.equal(host.agentOf('r1').calls.length, 0)
})

// Real I/O that does not end in a condition the test can see.
const idle = () => new Promise(resolve => setTimeout(resolve, 50))

test('stopping a round stops the member turn it started, and that turn posts nothing', async (t) => {
  const host = await start()
  t.after(host.stop)
  const result = await openTurn(t, host)
  result.stop()
  await settle(() => result() !== undefined)
  await settle(() => host.agentOf('gb').cancelled.length === 1)
  assert.equal(host.agentOf('gb').cancelled[0].reason, 'ds-bot/stopped')
  // The turn may end with text before the stop lands.
  host.emit('gb', 'assistant/message', { message: { content: [{ type: 'text', text: 'Done anyway.' }] } })
  host.emit('gb', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await idle()
  assert.equal(host.agentOf('r1').calls.length, 0)
})

test('stopping a round withdraws a member turn that has not started', async (t) => {
  const host = await start()
  t.after(host.stop)
  let result
  const stop = new AbortController()
  t.after(() => stop.abort())
  void host.tool('group_relay', {}, 'r1', { callId: 'c1', signal: stop.signal }).then((value) => { result = JSON.parse(value) })
  await settle(() => host.agentOf('gb').calls.length === 1)
  stop.abort()
  await settle(() => result !== undefined)
  await settle(() => host.agentOf('gb').inbox.nextTurn.length === 0)
  assert.deepEqual(host.agentOf('gb').cancelled, [])
})

test('deleting a group cancels its members\' waiting approvals and stops their Sessions', async (t) => {
  const host = await start()
  t.after(host.stop)
  await openTurn(t, host)
  const outcome = host.askApproval('gb')
  assert.equal((await host.call('delete-room', { id: 'r1' })).ok, true)
  assert.equal(await outcome, 'cancelled')
  assert.deepEqual((await host.call('state', {})).value.work.approvals, [])
  assert.deepEqual(host.archived.find(([id]) => id === 'gb'), ['gb', { stopActivity: true }])
})

test('a report back names the members still waiting for an approval', async (t) => {
  const host = await start()
  t.after(host.stop)
  const posted = await host.tool('post_to_group', { group: 'Ops', message: 'Copy the doc', report_back: true }, 'a')
  assert.match(posted, /^Posted in "Ops"/)
  const post = host.agentOf('r1').calls[0]
  host.emit('r1', 'user/message', { content: post.content, source: post.source })
  const result = await openTurn(t, host)
  void host.askApproval('gb')
  await settle(() => result() !== undefined)
  await settle(() => host.agentOf('a').calls.length === 1)
  const report = text(host.agentOf('a').calls[0])
  assert.match(report, /Nobody replied to your post\./)
  assert.match(report, /Waiting for the user's approval: Writer\./)
})

test('a member that fails after the round moved on shows the failure in the group, and nobody answers it', async (t) => {
  const host = await start()
  t.after(host.stop)
  const result = await openTurn(t, host)
  const outcome = host.askApproval('gb')
  await settle(() => result() !== undefined)
  const [approval] = (await host.call('state', {})).value.work.approvals
  await host.call('approval-answer', { id: approval.id, choice: 'allow' })
  await outcome
  host.emit('gb', 'turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'RATE_LIMIT', status: 429, message: 'Too many requests' } } })
  await settle(() => host.agentOf('r1').calls.length === 1)
  const post = host.agentOf('r1').calls[0]
  assert.deepEqual([post.source.late, post.source.quiet, post.source.failed], [true, true, { code: 'RATE_LIMIT', status: 429, message: 'Too many requests' }])

  host.emit('r1', 'user/message', { content: post.content, source: post.source })
  const round = JSON.parse(await host.tool('group_relay', {}, 'r1', { callId: 'c2', signal: new AbortController().signal }))
  assert.deepEqual(round.replies.map(reply => [reply.kind, reply.name, reply.code, reply.status]), [['failed', 'Writer', 'RATE_LIMIT', 429]])
  assert.deepEqual(round.failed, ['Writer'])
  assert.equal(host.agentOf('gb').calls.length, 1)
})

// Under PTC the model calls run_code, and the program dispatches the real tools.
const program = (emit, sessionId, callId, code = 'await main()') => emit(sessionId, 'tool/call', { callId, name: 'run_code', arguments: JSON.stringify({ code }) })
const dispatch = (emit, sessionId, parentCallId, n, name, args = {}) => {
  const subCallId = `${parentCallId}:ptc:${n}`
  emit(sessionId, 'tool/ptc-dispatch-start', { rootCallId: parentCallId, parentCallId, subCallId, name, arguments: args })
  return () => emit(sessionId, 'tool/ptc-dispatch', { rootCallId: parentCallId, parentCallId, subCallId, name, arguments: args, isError: false, content: [] })
}

test('a Bot running a PTC program shows the tool the program is in', async (t) => {
  const host = await start()
  t.after(host.stop)
  const now = async () => {
    const { value } = await host.call('state', {})
    return [value.activity.b, value.work.bots.b?.tool]
  }
  host.emit('b', 'turn/start', { turn: 1 })
  program(host.emit, 'b', 'k1')
  assert.deepEqual(await now(), ['working', 'run_code'])
  const messaged = dispatch(host.emit, 'b', 'k1', 1, 'message_bot', { to: 'Chief', message: 'Done?' })
  assert.deepEqual(await now(), ['sending', 'message_bot'])
  const read = dispatch(host.emit, 'b', 'k1', 2, 'read_group_chat', { group: 'Ops' })
  assert.deepEqual(await now(), ['searching', 'read_group_chat'])
  read()
  assert.deepEqual(await now(), ['sending', 'message_bot'])
  messaged()
  assert.deepEqual(await now(), ['working', 'run_code'])
  dispatch(host.emit, 'b', 'k1', 3, 'ask_user', { question: 'Ship it?', options: [{ label: 'Yes' }] })()
  assert.deepEqual(await now(), ['working', 'run_code'])
  host.emit('b', 'tool/result', { callId: 'k1' })
  assert.deepEqual(await now(), ['thinking', undefined])
})

test('an approval asked inside a PTC program shows what that call does', async (t) => {
  const host = await start()
  t.after(host.stop)
  const result = await openTurn(t, host)
  program(host.emit, 'gb', 'k1')
  dispatch(host.emit, 'gb', 'k1', 1, 'pwsh', { command: 'Copy-Item a.md E:/docs', description: 'Copy the doc' })
  void host.askApproval('gb', { callId: 'k1:ptc:1' })
  await settle(() => result() !== undefined)
  const { value } = await host.call('state', {})
  const [approval] = value.work.approvals
  assert.deepEqual(approval.detail, { text: 'Copy the doc', code: 'Copy-Item a.md E:/docs' })
  assert.equal(value.work.bots.b.tool, 'pwsh')
})

// #540: "Always allow" on the card is a standing grant, per Bot or per group, kept on
// the record and revocable; DSH only knows one-shot outcomes. It answers only a turn the
// owner started (turn-origin.js).
const ESCALATE = 'escalate sandbox to danger-full-access: read AGENTS.md'
const KIND = 'bash:escalate:danger-full-access'
// Opens a turn in a Bot's own chat whose message came from `source`.
const chatTurn = (host, sessionId, source = { kind: 'user' }) => {
  host.emit(sessionId, 'turn/start', { turn: 1 })
  host.emit(sessionId, 'user/message', { content: [{ type: 'text', text: 'go' }], source })
}
const grantFromGroup = async (host, choice) => {
  const first = host.askApproval('gb', { toolName: 'bash', reason: ESCALATE })
  const [approval] = (await host.call('state', {})).value.work.approvals
  assert.equal((await host.call('approval-answer', { id: approval.id, choice })).ok, true)
  assert.equal(await first, 'allowed-once')
}

test('Always allow for this Bot answers later matching asks itself, survives in the store, and Remove asks again', async (t) => {
  const host = await start()
  t.after(host.stop)
  await openTurn(t, host)
  await grantFromGroup(host, 'always-bot')

  const bot = (await host.call('state', {})).value.bots.find(entry => entry.id === 'b')
  assert.deepEqual(bot.standingApprovals.map(grant => [grant.kind, grant.label]), [[KIND, 'bash · danger-full-access']])
  assert.deepEqual(JSON.parse(readFileSync(join(host.home, 'state.json'), 'utf8')).bots.b.standingApprovals.map(grant => grant.kind), [KIND])
  // The same kind again, and from the Bot's own chat, is answered without a card; another kind still asks.
  assert.equal(await host.askApproval('gb', { toolName: 'bash', reason: 'escalate sandbox to danger-full-access: again' }), 'allowed-once')
  chatTurn(host, 'b')
  assert.equal(await host.askApproval('b', { toolName: 'bash', reason: ESCALATE }, () => 'from-dsh'), 'allowed-once')
  assert.equal(await host.askApproval('b', { toolName: 'bash', reason: 'escalate sandbox to workspace-write: x' }, () => 'from-dsh'), 'from-dsh')
  assert.deepEqual((await host.call('state', {})).value.work.approvals, [])

  assert.equal((await host.call('standing-approval-remove', { scope: 'bot', id: 'b', kind: KIND })).value, true)
  assert.equal(await host.askApproval('b', { toolName: 'bash', reason: ESCALATE }, () => 'from-dsh'), 'from-dsh')
})

test('a standing grant never answers a turn someone other than the owner started', async (t) => {
  const host = await start()
  t.after(host.stop)
  await openTurn(t, host)
  await grantFromGroup(host, 'always-bot')
  // A friend's message (remote chat) and another member's line both still ask.
  chatTurn(host, 'b', { kind: 'bot', remote: { handle: '@friend' }, form: 'remote-chat' })
  assert.equal(await host.askApproval('b', { toolName: 'bash', reason: ESCALATE }, () => 'from-dsh'), 'from-dsh')
  const host2 = await start()
  t.after(host2.stop)
  await openTurn(t, host2)
  await grantFromGroup(host2, 'always-bot')
  chatTurn(host2, 'b', { kind: 'user', authorId: 'someone-else' })
  assert.equal(await host2.askApproval('b', { toolName: 'bash', reason: ESCALATE }, () => 'from-dsh'), 'from-dsh')
  // No turn at all: fail closed.
  assert.equal(await host2.askApproval('a', { toolName: 'bash', reason: ESCALATE }, () => 'from-dsh'), 'from-dsh')
})

// #608: the owner answered "Always allow for this Bot" and the same card came back. DSH opens a
// retry turn of its own after an answer; that turn carries no message verdict, so the grant was
// skipped. Nobody's request is in such a turn in the Bot's own chat, so the owner's grant stands.
test('#608: an own-chat turn that carries no verdict still honours the Bot grant', async (t) => {
  const host = await start()
  t.after(host.stop)
  await openTurn(t, host)
  await grantFromGroup(host, 'always-bot')
  // A turn DSH starts for itself: no message, or only a host notice, so turn-origin has no verdict.
  host.emit('b', 'turn/start', { turn: 2 })
  assert.equal(await host.askApproval('b', { toolName: 'bash', reason: ESCALATE }, () => 'from-dsh'), 'allowed-once')
  host.emit('b', 'turn/end', { reason: { kind: 'completed' } })
  host.emit('b', 'turn/start', { turn: 3 })
  host.emit('b', 'user/message', { content: [{ type: 'text', text: 'note' }], source: { kind: 'bot', form: 'relay', role: 'mention' } })
  assert.equal(await host.askApproval('b', { toolName: 'bash', reason: ESCALATE }, () => 'from-dsh'), 'allowed-once')
  // Someone else's turn in that chat still asks, and says once why the grant was not used.
  host.emit('b', 'turn/end', { reason: { kind: 'completed' } })
  host.emit('b', 'turn/start', { turn: 4 })
  host.emit('b', 'user/message', { content: [{ type: 'text', text: 'hi' }], source: { kind: 'bot', remote: { handle: '@friend' }, form: 'remote-chat' } })
  assert.equal(await host.askApproval('b', { toolName: 'bash', reason: ESCALATE }, () => 'from-dsh'), 'from-dsh')
})

// #620: the own-chat widening the own-chat widening in standingCovers is for a turn nobody's request is in, not for a
// source kind the host cannot read. An unrecognised kind fails closed, so the grant does not apply.
test('#620: an unrecognised source kind in the Bot’s own chat still asks', async (t) => {
  const host = await start()
  t.after(host.stop)
  await openTurn(t, host)
  await grantFromGroup(host, 'always-bot')
  host.emit('b', 'turn/start', { turn: 2 })
  host.emit('b', 'user/message', { content: [{ type: 'text', text: 'from a future source' }], source: { kind: 'some-future-kind' } })
  assert.equal(await host.askApproval('b', { toolName: 'bash', reason: ESCALATE }, () => 'from-dsh'), 'from-dsh')
})

test('#608: a grant survives a restart and answers the same ask again', async (t) => {
  const first = await start()
  t.after(() => rmSync(first.home, { recursive: true, force: true, maxRetries: 5 }))
  await openTurn(t, first)
  await grantFromGroup(first, 'always-bot')
  await first.stop({ keepHome: true })
  const second = await start(first.home)
  t.after(second.stop)
  // Same store, a session the runtime has to pick up again: the grant is still there.
  second.emit('b', 'turn/start', { turn: 1 })
  second.emit('b', 'user/message', { content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } })
  assert.equal(await second.askApproval('b', { toolName: 'bash', reason: ESCALATE }, () => 'from-dsh'), 'allowed-once')
})

test('Always allow for this group covers that group only', async (t) => {
  const host = await start()
  t.after(host.stop)
  await openTurn(t, host)
  await grantFromGroup(host, 'always-room')
  const room = (await host.call('state', {})).value.rooms.find(entry => entry.id === 'r1')
  assert.deepEqual(room.standingApprovals.map(grant => grant.kind), [KIND])
  assert.equal(await host.askApproval('gb', { toolName: 'bash', reason: ESCALATE }), 'allowed-once')
  // Not the Bot's own chat: the grant was for work in the group.
  chatTurn(host, 'b')
  assert.equal(await host.askApproval('b', { toolName: 'bash', reason: ESCALATE }, () => 'from-dsh'), 'from-dsh')
  assert.equal((await host.call('standing-approval-remove', { scope: 'room', id: 'r1', kind: KIND })).value, true)
  const again = host.askApproval('gb', { toolName: 'bash', reason: ESCALATE })
  const [open] = (await host.call('state', {})).value.work.approvals
  assert.equal(open.answerable, true)
  assert.equal((await host.call('approval-answer', { id: open.id, choice: 'reject' })).ok, true)
  assert.equal(await again, 'rejected')
})

test('Always allow for this group is refused for an ask that did not come from a group', async (t) => {
  const host = await start()
  t.after(host.stop)
  // An own chat's ask is DSH's to answer, so it has no card to give a group grant from.
  let release
  const outcome = host.askApproval('a', { toolName: 'bash' }, () => new Promise((resolve) => { release = resolve }))
  const [approval] = (await host.call('state', {})).value.work.approvals
  assert.equal((await host.call('approval-answer', { id: approval.id, choice: 'always-room' })).ok, false)
  release('rejected')
  assert.equal(await outcome, 'rejected')
  assert.equal((await host.call('state', {})).value.bots.find(entry => entry.id === 'a').standingApprovals, undefined)
})

test('a running Bot\'s work names its current step, in one short line, until the turn ends', async (t) => {
  const host = await start()
  t.after(host.stop)
  await openTurn(t, host)
  const bots = async () => (await host.call('state', {})).value.work.bots
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'pwsh', arguments: JSON.stringify({ command: 'rg -n "TODO"\n  src/client   --glob *.js', description: 'Find the TODOs' }) })
  assert.deepEqual([(await bots()).b.tool, (await bots()).b.step], ['pwsh', 'rg -n "TODO" src/client --glob *.js'])
  host.emit('gb', 'tool/result', { callId: 'k1' })
  host.emit('gb', 'tool/call', { callId: 'k2', name: 'web_fetch', arguments: JSON.stringify({ url: `https://example.com/${'a'.repeat(200)}` }) })
  const { step } = (await bots()).b
  assert.ok(step.startsWith('https://example.com/a') && step.endsWith('…') && step.length <= 80, step)
  host.emit('gb', 'tool/result', { callId: 'k2' })
  assert.equal((await bots()).b.step, undefined)
  host.emit('gb', 'turn/end', { reason: { kind: 'error', error: new Error('boom') } })
  assert.equal((await bots()).b, undefined)
})

// #626: the shape a Bot actually hits — the owner asks for work, the turn calls `subagent`, and the
// child settles while that same turn is still running. The notice is an account of work the owner
// already asked for, not a new request, so the connector tools stay.
test('#626: a subagent settling mid-turn does not take the connection away', async (t) => {
  const host = await start()
  t.after(host.stop)
  await openTurn(t, host)
  await grantFromGroup(host, 'always-bot')
  host.emit('b', 'turn/start', { turn: 2 })
  host.emit('b', 'user/message', { content: [{ type: 'text', text: 'read the repo and report' }], source: { kind: 'user' } })
  host.emit('b', 'tool/call', { callId: 's1', name: 'subagent', arguments: JSON.stringify({ prompt: 'summarise the README' }) })
  host.emit('b', 'user/message', { content: [{ type: 'text', text: 'Subagent finished: summarised the README.' }], source: { kind: 'subagent-settled', form: 'notice', summary: 'summarised the README', senderSessionId: 'child-1' } })
  assert.equal(await host.askApproval('b', { toolName: 'bash', reason: ESCALATE }, () => 'from-dsh'), 'allowed-once')
})

// #626: the host and DSH inject context into ordinary owner turns — this host's clock snapshot
// (`ds-bot-time-context`), DSH's own clock and cited-conversation snapshots, and the AGENTS.md
// baseline. None of them carries a request, so a turn that took one in still honours the owner's
// standing grant; treating one as `other` is what made the #608 card come back.
for (const kind of ['ds-bot-time-context', 'time-context', 'session-reference', 'agent-instructions']) {
  test(`#626: a turn that took in a ${kind} message still honours the Bot grant`, async (t) => {
    const host = await start()
    t.after(host.stop)
    await openTurn(t, host)
    await grantFromGroup(host, 'always-bot')
    host.emit('b', 'turn/start', { turn: 2 })
    host.emit('b', 'user/message', { content: [{ type: 'text', text: 'context' }], source: { kind, form: 'snapshot' } })
    assert.equal(await host.askApproval('b', { toolName: 'bash', reason: ESCALATE }, () => 'from-dsh'), 'allowed-once')
  })
}
