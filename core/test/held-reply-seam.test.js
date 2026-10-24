// #986: the seam between the host's hold record and the Bot view the client draws from. Each end is
// pinned on its own — `host-approval-status.test.js` reads statuses through the channel, and
// `held-reply.test.js` draws a hand-built `heldReplies` — so nothing pinned the middle: a `retry: false`
// that never reached the view would still draw a Retry button, and both suites would stay green.
// These cases start at a real hold (a middleware's `hold`, then the owner's approval, then the dispatch
// failure), read the Bot's `heldReplies` **from the host's `state` view**, and draw that same object on
// the turn it answers.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { apply } from '../index.js'
import { fakeContext } from './fake-ctx.js'

// The client bundle: `cells.js` finds the held record through `text.js` `heldReplyOf` (by session and
// turn) and wraps the bubbles in `HeldReply`, which draws `HeldReplyActions` from `held-reply.js`.
const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/cells.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'node', write: false,
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
function MarkdownText() { return null }
const sandbox = { module: { exports: {} } }
sandbox.exports = sandbox.module.exports
runInNewContext(bundle.outputFiles[0].text, {
  ...sandbox,
  require: (name) => {
    const platform = {
      react: {
        createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
        useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}], useEffect: () => {}, useRef: current => ({ current }),
        useLayoutEffect: () => {}, useMemo: make => make(), Fragment: 'fragment', Component: class {},
      },
      'react-dom': { createPortal: node => node },
      '@deepseek-ai/dsh-client-ui-primitives': { MarkdownText },
    }
    if (!(name in platform)) throw new Error(`no platform module ${name}`)
    return platform[name]
  },
})
const { AssistantCell } = sandbox.module.exports

const expand = (node, names) => {
  if (Array.isArray(node)) return node.flatMap(child => expand(child, names))
  if (node === null || typeof node !== 'object') return node
  if (names.includes(node.type?.name)) return expand(node.type({ ...node.props, children: node.children }), names)
  return { ...node, children: (node.children ?? []).map(child => expand(child, names)) }
}
const find = (node, match) => {
  if (Array.isArray(node)) return node.flatMap(child => find(child, match))
  if (node === null || typeof node !== 'object') return []
  return [...(match(node) ? [node] : []), ...find(node.children, match)]
}
const strings = node => (Array.isArray(node) ? node.flatMap(strings) : typeof node === 'string' ? [node] : node && typeof node === 'object' ? strings(node.children ?? []) : [])
const text = node => strings(node).join('')

// The roster the client builds from a `state` answer: a Bot is looked up by its own chat's Session id.
const rosterOf = view => {
  const bots = view.bots.map(bot => ({ ...bot }))
  return { bots, byId: Object.fromEntries(bots.map(bot => [bot.sessionId, bot])), roomsById: {}, exchangeTurns: {}, remoteTypedTurns: {} }
}
// One closed turn of Bot `a`, the shape the chat hands `AssistantCell`. The turn number picks which
// held reply the seam under test put in the view.
const draw = (roster, turn) => expand(AssistantCell({
  node: { key: `n${turn}`, location: { kind: 'step', turn: { turn, status: 'closed' } }, data: { turn, step: 1, seq: 10, status: 'done', finalNode: { seq: 10 }, blocks: [{ kind: 'text', text: '4.' }] } },
  sessionId: 'a',
  useTurnData: key => (key === 'turn-tail' ? { closing: { finalNode: { seq: 10 } } } : undefined),
  useRoster: select => select(roster),
  useUi: () => null,
  useTurnSteps: () => [],
  useTurnContext: () => [],
  actions: { noteLive() {} },
}), ['HeldReply', 'HeldReplyActions', 'Bubbles'])
const heldBox = drawn => find(drawn, node => node.props?.className === 'bt-held-reply')[0]
const buttons = node => find(node, child => child.type === 'button').map(text)

const hash = token => createHash('sha256').update(token).digest('hex')

const team = () => ({
  version: 1,
  mainBotIds: ['a'],
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
    b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2 },
  },
  rooms: {}, agents: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {}, revision: 0,
})

async function start(config = {}) {
  const home = config.home ?? mkdtempSync(join(tmpdir(), 'ds-bot-held-reply-seam-'))
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
  // A member session rides the header the browser sends (`x-flybot-member-session`), never the body,
  // so an enforcement case reads the view the way a signed-in person's window does.
  const call = async (endpoint, payload, token) => {
    const init = { method: 'POST', body: JSON.stringify({ endpoint, payload }) }
    if (token) init.headers = { 'x-flybot-member-session': token }
    return (await route.fetch(new Request('http://localhost/api/bot', init))).json()
  }
  const readView = token => call('state', {}, token).then(result => result.value)
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { ctx, fb: ctx.flybot, call, readView, home, stop }
}

// A friend's Bot on the roster, so the send has somewhere to go; the transport below is what fails.
const FRIEND = { kind: 'remote', handle: '@coder.bob.home' }

// Holds one auto-reply per call, then approves it, so the dispatch failure is the host's own: `release()`
// calls the transport, and a `noRetry` error marks the stored record the way a real sender does (#954).
async function failHeldReply(fb, call, { turn, terminal }) {
  const result = await fb.bot.send({
    from: 'a', to: FRIEND, text: terminal ? 'terminal reply' : 'flaky reply', via: 'auto-reply',
    meta: { hold: true, replyIn: { sessionId: 'a', turn } },
  })
  assert.equal(result.action, 'hold', JSON.stringify(result))
  const decided = await call('flybot/decide', { id: result.approvalId, decision: 'approve' })
  assert.equal(decided.ok, true, JSON.stringify(decided))
  assert.equal(decided.value.status, 'failed', JSON.stringify(decided.value))
  return decided.value
}

test('#986: a terminal failure reaches the view as retry:false, and its card draws no Retry; a retryable one keeps it', async (t) => {
  const { fb, call, readView, stop } = await start()
  t.after(stop)
  await fb.ready()
  fb.bot.send.use({ name: 'gate', handle: async msg => (msg.meta?.hold ? { action: 'hold', reason: 'held by test' } : undefined) })
  // The transport is where a send ends: the terminal refusal says no later try can work (#954).
  fb.transports.add('bot-social', {
    send: async (msg) => {
      // The terminal one is marked only by the flag: nothing in its sentence says so, so the
      // `retry: false` the view must carry is the only reason the card can drop the button.
      throw Object.assign(new Error(msg.text === 'terminal reply' ? 'HTTP 403: the line was refused' : 'HTTP 500'), msg.text === 'terminal reply' ? { noRetry: true } : {})
    },
  })
  await fb.grants.set('a', [{ grantee: '@coder.bob.home' }])

  const terminal = await failHeldReply(fb, call, { turn: 3, terminal: true })
  const retryable = await failHeldReply(fb, call, { turn: 4, terminal: false })
  assert.deepEqual([terminal.noRetry, retryable.noRetry], [true, undefined])

  // One read of the view, from the host: this is the step the seam lives in.
  const view = await readView()
  const bot = view.bots.find(entry => entry.id === 'a')
  assert.ok(Array.isArray(bot.heldReplies), 'the Bot carries the holds the chat draws')
  const byTurn = Object.fromEntries(bot.heldReplies.map(entry => [entry.turn, entry]))
  // The terminal record survives the view: the flag the sender wrote is on the object the client gets.
  assert.equal(byTurn[3].status, 'failed')
  assert.equal(byTurn[3].retry, false, 'the view carries retry:false')
  assert.equal(byTurn[3].error, 'HTTP 403: the line was refused')
  // And the retryable one carries no flag at all, so the negative control cannot pass by dropping Retry.
  assert.equal(byTurn[4].status, 'failed')
  assert.equal('retry' in byTurn[4], false, 'a retryable failure is not marked terminal')
  assert.equal(byTurn[4].error, 'HTTP 500')

  // Draw the very objects the view returned, on the turns they answer.
  const roster = rosterOf(view)
  const terminalBox = heldBox(draw(roster, 3))
  assert.ok(terminalBox, 'the failed reply is drawn on its turn')
  assert.equal(terminalBox.props['data-state'], 'failed')
  assert.deepEqual(buttons(terminalBox), [], 'a terminal failure offers no Retry')
  assert.ok(strings(terminalBox).includes('Not sent: delivery failed'))

  const retryableBox = heldBox(draw(roster, 4))
  assert.equal(retryableBox.props['data-state'], 'failed')
  assert.deepEqual(buttons(retryableBox), ['Retry'], 'a retryable failure still offers Retry')
  // The turn that did not fail keeps its plain bubble.
  assert.equal(heldBox(draw(roster, 5)), undefined)
})

test('#986: a friend\'s chat carries no heldReplies, and the provider does have one to give it', async (t) => {
  const state = team()
  // A friend's Bot on the roster, with an Auto-sent mark of its own: `heldRepliesOf` would return it,
  // so the branch at `channel.js:133` (`bot.remote`) is what keeps it off the view.
  state.bots.f = { id: 'f', name: 'Coder', sessionId: 'f', createdAt: 4, remote: { handle: '@coder.bob.home', home: '@bob.home' } }
  const mark = (botId) => ({ id: `auto-${botId}`, by: 'social', botId, sessionId: botId, turn: 2, to: '@coder.bob.home', at: 1 })
  state.flybot = { autoSent: [mark('f'), mark('b')] }
  const { readView, stop } = await start({ state })
  t.after(stop)
  const view = await readView()
  const friend = view.bots.find(entry => entry.id === 'f')
  assert.equal(friend.remote.handle, '@coder.bob.home')
  assert.equal('heldReplies' in friend, false, "a friend's chat never carries heldReplies")
  // The same provider entry on a local Bot does reach the view: the suppression is the branch, not an
  // empty list on both sides.
  const local = view.bots.find(entry => entry.id === 'b')
  assert.deepEqual(local.heldReplies.map(entry => [entry.id, entry.status]), [['auto-b', 'auto']])
})

test('#986: under enforcement only the owner\'s view of a shared room\'s Bot carries heldReplies', async (t) => {
  // Two owners, one shared room, and a held reply on owner-1's Bot: owner-2 can see the Bot (it is in
  // their room) but must not read what is waiting for owner-1 to decide.
  const state = team()
  state.version = 2
  state.members = {
    'owner-1': { id: 'owner-1', createdAt: 1, designatedChiefId: 'a' },
    'owner-2': { id: 'owner-2', createdAt: 2, designatedChiefId: null },
  }
  state.bots.a.ownerId = 'owner-1'
  state.bots.b.ownerId = 'owner-2'
  state.rooms.r1 = {
    id: 'r1', name: 'Shared', members: ['a', 'b'], admin: 'a', sessions: { a: 'gs-a', b: 'gs-b' },
    participants: [
      { kind: 'human', id: 'owner-1', role: 'admin', joinedSeq: 0 },
      { kind: 'human', id: 'owner-2', role: 'member', joinedSeq: 0 },
    ],
  }
  // Sessions are stored as token hashes only (`member-auth.js`); these two are the signed-in members.
  state.authSessions = {
    s1: { id: 's1', memberId: 'owner-1', tokenHash: hash('token-1'), createdAt: 1, expiresAt: Date.now() + 3_600_000 },
    s2: { id: 's2', memberId: 'owner-2', tokenHash: hash('token-2'), createdAt: 2, expiresAt: Date.now() + 3_600_000 },
  }
  state.flybot = { autoSent: [{ id: 'auto-a', by: 'social', botId: 'a', sessionId: 'a', turn: 2, to: '@coder.bob.home', at: 1 }] }
  const { readView, stop } = await start({ state })
  t.after(stop)

  const owner = await readView('token-1')
  assert.equal(owner.self.memberId, 'owner-1')
  const ownBot = owner.bots.find(entry => entry.id === 'a')
  assert.deepEqual(ownBot.heldReplies.map(entry => [entry.id, entry.status]), [['auto-a', 'auto']])

  const other = await readView('token-2')
  assert.equal(other.self.memberId, 'owner-2')
  const sharedBot = other.bots.find(entry => entry.id === 'a')
  assert.ok(sharedBot, 'the shared room still shows owner-2 the Bot')
  assert.equal('heldReplies' in sharedBot, false, 'a viewer who is not the owner reads none')
})
