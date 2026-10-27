import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { apply } from '../index.js'
import { FEISHU_MODES, feishuPost } from '../src/host/connectors.js'
import { createNotifier } from '../src/host/notify.js'
import { fakeContext } from './fake-ctx.js'

// #1263 phase 1: Feishu (Lark) outbound through a custom-bot webhook. Feishu is not an MCP
// server, so it is a *sender* connector: a definition with no mount, one status and one POST.
// Its verdict is the `code` in the body, not the HTTP status — a rate limit and a refused
// signature both arrive as HTTP 200 — which is why the retry policy is notify.js's rather than
// a second one written next to the mount code.

const TEAM = {
  version: 1,
  mainBotIds: ['m1'],
  revision: 1,
  bots: { m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief of Staff', instructions: '', createdAt: 1 } },
  rooms: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

const teamHome = () => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-feishu-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  return home
}

const cleanHome = home => rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })

const answer = (status, body) => ({ status, ok: status >= 200 && status < 300, body, json: async () => body })
const hookToken = () => randomBytes(8).toString('hex')
const webhookOf = token => `https://feishu.test/open-apis/bot/v2/hook/${token}`

// The connector is installed with its own API address so a test never talks to Feishu. Every
// warn call is kept whole, arguments and all: `reason()` only redacts a secret that is already
// saved, so the argument a message is formatted from is exactly where a pasted webhook leaks.
function setup({ home = teamHome(), fetch: reply, feishu = { api: 'https://feishu.test' } } = {}) {
  const warns = []
  const ctx = fakeContext()
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (route) => { ctx.route = route; return register(route) }
  const original = ctx.logger.warn
  ctx.logger.warn = (...args) => { warns.push(args); if (original) original(...args) }
  apply(ctx, { home, feishu })
  return { ctx, home, warns, reply }
}

async function call(ctx, endpoint, payload) {
  const response = await ctx.route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))
  return response.json()
}

const row = (view, id = 'feishu') => (view?.connectors ?? view ?? []).find(entry => entry.id === id)
// #1266: the same row now carries the inbound state (off, no socket, app pair not saved). It is
// spelled out here instead of spread, so a value leaking into the row cannot pass unnoticed.
const INBOUND_OFF = { state: 'off', connected: 0, duplicates: 0, refused: 0, refusedSenders: [], app: 'missing' }
// #1266: the sender row became a channel with two modes. Spelled out here, so a field leaking into
// the row (or a mode arriving from nowhere) cannot pass unnoticed.
const feishuRow = (state, mode = null) => ({ id: 'feishu', name: 'Feishu', state, kind: 'channel', account: null, mode, modes: FEISHU_MODES, allowed: [], inbound: INBOUND_OFF })
const said = (warns, needle) => warns.filter(args => args.some(value => String(value).includes(needle)))

// A fake Feishu that records each POST and answers from the script (the last answer repeats).
function fakeFeishu(script = [answer(200, { code: 0, msg: 'success', data: { message_id: 'om_1' } })]) {
  const posts = []
  const queue = [...script]
  const fetch = async (url, init) => {
    posts.push({ url, init, body: init?.body === undefined ? undefined : JSON.parse(init.body) })
    return queue.length > 1 ? queue.shift() : queue[0]
  }
  return { posts, fetch }
}

test('#1263: Feishu is a sender row of its own, off until a webhook is pasted', async (t) => {
  const { ctx, home } = setup()
  t.after(async () => { await ctx.dispose(); cleanHome(home) })
  const state = await call(ctx, 'state', {})
  assert.deepEqual(row(state.value), feishuRow('off'))
  // A sender has no tools, so it is not a name a saved capability may take either way.
  assert.deepEqual(state.value.connectors.map(entry => entry.id), ['github', 'composio', 'feishu'])
})

test('#1263: connecting posts one test message, turns ready, and keeps the webhook out of state, disk and the log', async (t) => {
  const token = hookToken()
  const webhook = webhookOf(token)
  const feishu = fakeFeishu()
  const realFetch = globalThis.fetch
  globalThis.fetch = feishu.fetch
  const { ctx, home, warns } = setup({ fetch: feishu.fetch })
  t.after(async () => { globalThis.fetch = realFetch; await ctx.dispose(); cleanHome(home) })

  const connected = await call(ctx, 'connector-connect', { id: 'feishu', token: ` ${webhook} ` })
  assert.equal(connected.ok, true, JSON.stringify(connected))
  assert.deepEqual(row(connected.value), feishuRow('ready', 'webhook'))

  assert.equal(feishu.posts.length, 1, 'one test POST on connect')
  assert.equal(feishu.posts[0].url, webhook)
  assert.equal(feishu.posts[0].init.method, 'POST')
  assert.equal(feishu.posts[0].body.msg_type, 'text')
  assert.equal(typeof feishu.posts[0].body.content.text, 'string')
  assert.ok(feishu.posts[0].body.content.text.length > 0)

  const state = await call(ctx, 'state', {})
  assert.ok(!JSON.stringify(state).includes(token), 'the view and the state answer never carry the URL')
  assert.ok(!readFileSync(join(home, 'state.json'), 'utf8').includes(token), 'state.json never carries the URL')
  assert.deepEqual(said(warns, token), [], 'no warn line carries the URL, in any argument')
})

test('#1263: a webhook Feishu refuses stays on the row as an error that names no token', async (t) => {
  const token = hookToken()
  const feishu = fakeFeishu([answer(400, { code: 19021, msg: 'signature error' })])
  const realFetch = globalThis.fetch
  globalThis.fetch = feishu.fetch
  const { ctx, home, warns } = setup({ fetch: feishu.fetch })
  t.after(async () => { globalThis.fetch = realFetch; await ctx.dispose(); cleanHome(home) })

  const refused = await call(ctx, 'connector-connect', { id: 'feishu', token: webhookOf(token) })
  assert.equal(refused.ok, true, JSON.stringify(refused))
  const refusedRow = row(refused.value)
  assert.equal(refusedRow.state, 'error', 'the test POST is what decides ready')
  assert.match(refusedRow.error, /Feishu/)
  assert.ok(!JSON.stringify(refused).includes(token), 'the refusal never carries the URL')
  assert.equal(feishu.posts.length, 1)

  const state = await call(ctx, 'state', {})
  assert.ok(!JSON.stringify(state).includes(token))
  assert.ok(!readFileSync(join(home, 'state.json'), 'utf8').includes(token), 'state.json never carries the URL')
  assert.ok(said(warns, 'Feishu').length > 0, 'the refusal is logged')
  assert.deepEqual(said(warns, token), [], 'no warn line carries the URL, in any argument')
  assert.deepEqual(state.value.secrets.map(secret => secret.name), ['FEISHU_WEBHOOK'])
})

test('#1263: a Feishu that never answers fails on the deadline instead of hanging', async () => {
  const started = Date.now()
  const answerOrNothing = await feishuPost(webhookOf('x'), 'hello', { fetch: () => new Promise(() => {}), timeoutMs: 25 })
  assert.deepEqual(answerOrNothing, { ok: false, error: 'network' })
  assert.ok(Date.now() - started < 2_000, 'the deadline, not the fetch, ends the wait')
})

test('#1263: a rate limit in the body is retried, a refused signature is not', async () => {
  // Feishu answers HTTP 200 for both, so the classifier — not the status — decides.
  const limited = fakeFeishu([answer(200, { code: 9499, msg: 'too many request' }), answer(200, { code: 0, msg: 'success', data: { message_id: 'om_2' } })])
  const retried = createNotifier({ channel: 'feishu', transport: { postMessage: message => feishuPost(webhookOf('x'), message.text, { fetch: limited.fetch }) }, baseDelayMs: 1, delay: async () => {}, log: () => {} })
  const sent = await retried.send({ key: 'k1', text: 'hello' })
  assert.equal(sent.state, 'sent')
  assert.equal(sent.attempts, 2, '9499 is transient: the same call is tried again')
  assert.equal(limited.posts.length, 2)

  const refused = fakeFeishu([answer(200, { code: 19021, msg: 'signature error' })])
  const hopeless = createNotifier({ channel: 'feishu', transport: { postMessage: message => feishuPost(webhookOf('x'), message.text, { fetch: refused.fetch }) }, baseDelayMs: 1, delay: async () => {}, log: () => {} })
  const failed = await hopeless.send({ key: 'k2', text: 'hello' })
  assert.equal(failed.state, 'failed')
  assert.equal(failed.permanent, true, 'a refused signature will be refused again')
  assert.equal(failed.attempts, 1)
  assert.equal(refused.posts.length, 1)
  assert.match(failed.error, /19021/)
})

test('#1263: connector-send posts the text once and records when it last worked', async (t) => {
  const token = hookToken()
  const feishu = fakeFeishu()
  const realFetch = globalThis.fetch
  globalThis.fetch = feishu.fetch
  const { ctx, home } = setup({ fetch: feishu.fetch })
  t.after(async () => { globalThis.fetch = realFetch; await ctx.dispose(); cleanHome(home) })

  const early = await call(ctx, 'connector-send', { id: 'feishu', text: 'hello room' })
  assert.equal(early.ok, false)
  assert.match(early.error.message, /Connect Feishu/)

  await call(ctx, 'connector-connect', { id: 'feishu', token: webhookOf(token) })
  const sent = await call(ctx, 'connector-send', { id: 'feishu', text: '  hello room  ' })
  assert.equal(sent.ok, true, JSON.stringify(sent))
  assert.equal(feishu.posts.length, 2, 'the connect probe and this one message')
  assert.equal(feishu.posts[1].body.content.text, 'hello room')
  assert.equal(feishu.posts[1].url, webhookOf(token))

  const saved = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).connectors.feishu
  assert.equal(typeof saved.lastOkAt, 'number')
  assert.equal(typeof saved.connectedAt, 'number')
  assert.ok(!readFileSync(join(home, 'state.json'), 'utf8').includes(token))

  const empty = await call(ctx, 'connector-send', { id: 'feishu', text: '   ' })
  assert.equal(empty.ok, false, 'an empty message is refused before anything is posted')
  assert.equal(feishu.posts.length, 2)
})

// --- Settings → Connectors, the Feishu row ---

const { outputFiles } = await build({
  stdin: {
    contents: "export { ConnectorsPage } from './src/client/connectors.js'",
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const h = (type, props, ...children) => ({ type, props: { ...props, children } })
let states = []
const react = {
  createElement: h, Fragment: Symbol('F'), useEffect() {}, useLayoutEffect() {},
  useState: v => [states.length > 0 ? states.shift() : (typeof v === 'function' ? v() : v), () => {}],
  useMemo: f => f(), useRef: current => ({ current }), useCallback: f => f, useSyncExternalStore: (_s, get) => get(),
}
const browser = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module: browser, exports: browser.exports, document: { hidden: false }, navigator: { language: 'en' }, localStorage: { getItem: () => null, setItem() {} },
  window: { matchMedia: () => ({ matches: false }) }, setTimeout, clearTimeout,
  require: (name) => {
    if (name === 'react') return react
    if (name === 'react-dom') return { createPortal: node => node }
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return {}
    throw new Error(`Unexpected platform module ${name}`)
  },
})
const { ConnectorsPage } = browser.exports

const expand = (node) => {
  if (node === null || node === undefined || typeof node === 'boolean') return null
  if (Array.isArray(node)) return node.map(expand)
  if (typeof node !== 'object') return node
  if (typeof node.type === 'function') return expand(node.type(node.props))
  return { ...node, props: { ...node.props, children: expand(node.props.children) } }
}
const all = (node, out = []) => { if (node && typeof node === 'object') { if (Array.isArray(node)) node.forEach(child => all(child, out)); else { out.push(node); all(node.props?.children, out) } } return out }
const text = node => (node === null || node === undefined ? '' : Array.isArray(node) ? node.map(text).join('') : typeof node === 'object' ? text(node.props.children) : String(node))

const actions = { connectorConnect: async () => {}, connectorDisconnect: async () => {}, connectorRetry: async () => {}, connectorSend: async () => {} }
const renderRow = (connector, given = []) => {
  states = [...given]
  const tree = expand(h(ConnectorsPage, { roster: { connectors: [connector], bots: [], self: { memberId: 'me' } }, actions }))
  states = []
  return tree
}

const FEISHU_OFF = { id: 'feishu', name: 'Feishu', state: 'off', kind: 'channel', account: null, mode: null, modes: FEISHU_MODES, allowed: [] }
const FEISHU_APP = { ...FEISHU_OFF, state: 'ready', mode: 'app', allowed: [{ openId: 'ou_owner_1', name: 'Owner' }], inbound: { state: 'ready', refusedSenders: [{ openId: 'ou_stranger_1', name: 'Mallory', at: '2026-10-26T10:00:00.000Z' }] } }

test('#1266: the Feishu row offers both ways to connect, and the webhook one links to Feishu', () => {
  // form open, so the two mode buttons, the field and the link are drawn
  const tree = renderRow(FEISHU_OFF, [true, false, '', [], false, false, null])
  const buttons = all(tree).filter(node => node.type === 'button')
  const modeButtons = buttons.filter(node => node.props['aria-pressed'] !== undefined && !node.props.className?.includes('bt-app-chip'))
  assert.deepEqual(modeButtons.map(text), ['Custom bot webhook', 'App (long connection)'], 'one row, two modes, not a second Feishu row')
  const input = all(tree).find(node => node.type === 'input')
  assert.equal(input.props['aria-label'], 'Webhook URL', 'the webhook mode asks for its one credential')
  const link = all(tree).find(node => node.type === 'a')
  assert.doesNotMatch(link.props.href, /github\.com/, 'the row must not send the owner to GitHub for Feishu')
  assert.match(link.props.href, /feishu/i)
  assert.doesNotMatch(text(tree), /GitHub token/)
})

test('#1266: app mode asks for the App ID and the App Secret, and the App ID is not masked', () => {
  const tree = renderRow({ ...FEISHU_OFF, mode: 'app' }, [true, false, '', [], false, false, null])
  const inputs = all(tree).filter(node => node.type === 'input')
  assert.deepEqual(inputs.map(node => node.props['aria-label']).filter(Boolean).slice(0, 3), ['App ID', 'App Secret'])
  assert.equal(inputs[0].props.type, 'text', 'the App ID is kept in the record, so it is not a secret field')
  assert.equal(all(tree).find(node => node.type === 'a').props.href.includes('app'), true, 'the link is how to create the app')
})

test('#1266: a webhook-only Feishu offers no per-Bot switch; the app mode does, with the guest list', () => {
  const webhook = renderRow({ ...FEISHU_OFF, state: 'ready', mode: 'webhook' })
  const webhookLabels = all(webhook).filter(node => node.type === 'button').map(text)
  assert.ok(webhookLabels.includes('Disconnect'), webhookLabels.join('|'))
  assert.ok(!webhookLabels.includes('Choose Bots'), 'a webhook is the phase-1 sender: a per-Bot switch would do nothing')
  assert.doesNotMatch(text(webhook), /On for all \d+ Bots/)
  assert.doesNotMatch(text(webhook), /Who may talk to the Bots/)

  const app = renderRow(FEISHU_APP)
  const appLabels = all(app).filter(node => node.type === 'button').map(text)
  assert.ok(appLabels.includes('Choose Bots'), 'an app gives a Bot a way in, so the switch is real')
  assert.match(text(app), /Off for every Bot|On for all \d+ Bots/, 'the row says which Bots may reach it')
  assert.match(text(app), /Who may talk to the Bots/)
  assert.match(text(app), /Owner/, 'who is allowed is on the row')
  assert.match(text(app), /Mallory/, 'and who was turned away is there with Allow beside it')
  assert.ok(appLabels.includes('Allow') && appLabels.includes('Block'))
  assert.ok(!appLabels.includes('Send'), 'app mode answers by itself: there is no room to post into')
})
