import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { RESERVED_NAMES, feishuAppSend, feishuReply } from '../src/host/connectors.js'
import { fakeContext } from './fake-ctx.js'
import { cleanHome } from './temp-home.js'

// #1266, the connector-row half: the owner's word is 「飞书是做成一个连接器，左下角点击连接应用的时候
// 可以连接」. So the row is where Feishu is configured — one row, two modes (a custom-bot webhook, or a
// self-built app with its long connection), the App ID kept in the record because it is not a secret,
// the App Secret only in secrets.json, Choose Bots for what a Bot can reach, and the guest list the
// app mode's gate reads. Every test here fails on the sender-row shape it replaces.

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

const teamHome = record => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-feishu-channel-'))
  const state = record === undefined ? TEAM : { ...TEAM, connectors: { feishu: record } }
  writeFileSync(join(home, 'state.json'), JSON.stringify(state))
  return home
}

const answer = (status, body) => ({ status, ok: status >= 200 && status < 300, body, json: async () => body })

// A fake Feishu: tenant tokens and message sends, and every call recorded. The scripted answers are
// consumed in order by non-token calls (the webhook probe, a send), the last one repeating.
function fakeFeishu(script = []) {
  const calls = []
  const queue = [...script]
  const fetch = async (url, init) => {
    const body = init?.body === undefined ? undefined : JSON.parse(init.body)
    calls.push({ url: String(url), method: init?.method, body, headers: init?.headers ?? {} })
    if (String(url).includes('/auth/v3/tenant_access_token/internal')) return answer(200, { code: 0, tenant_access_token: 't_app_token' })
    if (String(url).includes('/open-apis/im/v1/messages')) return answer(200, { code: 0, data: { message_id: 'om_answer' } })
    return queue.length > 1 ? queue.shift() : (queue[0] ?? answer(200, { code: 0, data: { message_id: 'om_1' } }))
  }
  return { calls, fetch }
}

// The runtime a plugin sees after install, with the socket replaced by a stub: `dials` are the
// `onEvent` handlers handed to it, exactly what a real long connection would call. `onClose` is
// extra work the stub socket does while closing, so a test can watch a shutdown wait for it.
function rig(t, { record, feishu = { api: 'https://feishu.test' }, onClose = async () => {} } = {}) {
  const home = teamHome(record)
  const ctx = fakeContext()
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (route) => { ctx.route = route; return register(route) }
  const rt = createRuntime(ctx, { home, feishu })
  const dials = []
  const closes = []
  rt.feishuTransport = {
    nameOf: async openId => (openId === 'ou_stranger_1' ? 'Mallory' : `Someone ${openId}`),
    connect: async (onEvent) => { dials.push(onEvent); return { close: async () => { closes.push(1); await onClose() } } },
  }
  // #1983: `dispose()` is the one teardown, and it waits for the dial and the log before the home
  // is removed once — no retry in `cleanHome` to cover a writer that was not awaited.
  t.after(async () => { await ctx.dispose(); cleanHome(home) })
  return { rt, ctx, home, dials, closes }
}

async function call(ctx, endpoint, payload) {
  const response = await ctx.route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))
  return response.json()
}

const rowOf = value => (value?.connectors ?? value ?? []).find(entry => entry.id === 'feishu')
const until = async (read, done, ms = 3000) => {
  const end = Date.now() + ms
  let value = await read()
  while (!done(value) && Date.now() < end) {
    await new Promise(resolve => setTimeout(resolve, 10))
    value = await read()
  }
  return value
}
const event = ({ id = 'e1', openId = 'ou_owner_1', chatId = 'oc_chat_1', text = 'hello there' } = {}) => ({
  header: { event_id: id, event_type: 'im.message.receive_v1' },
  event: {
    sender: { sender_id: { open_id: openId } },
    message: { chat_id: chatId, message_type: 'text', content: JSON.stringify({ text }) },
  },
})

test('#1266: one Feishu row, two modes, nothing connected and no socket', async (t) => {
  const { ctx, dials } = rig(t)
  const row = rowOf((await call(ctx, 'state', {})).value)
  assert.equal(row.kind, 'channel')
  assert.equal(row.state, 'off')
  assert.equal(row.mode, null, 'no mode is live before the first connect')
  assert.deepEqual(row.modes.map(mode => mode.id), ['webhook', 'app'])
  assert.deepEqual(row.modes[0].credentials.map(field => [field.name, field.masked]), [['webhook', true]])
  assert.deepEqual(row.modes[1].credentials.map(field => [field.name, field.masked]), [['app_id', false], ['app_secret', true]], 'the App ID is not a secret; the App Secret never comes back')
  assert.deepEqual(row.allowed, [])
  assert.deepEqual(row.inbound.refusedSenders, [])
  assert.equal(row.inbound.state, 'off')
  assert.equal(dials.length, 0, 'connecting is a decision, not a default')
})

test('#1266: connecting the app keeps the id in the record, the secret in secrets.json, and opens the socket', async (t) => {
  const feishu = fakeFeishu()
  const realFetch = globalThis.fetch
  globalThis.fetch = feishu.fetch
  const { rt, ctx, home, dials } = rig(t)
  t.after(() => { globalThis.fetch = realFetch })

  const connected = await call(ctx, 'connector-connect', { id: 'feishu', mode: 'app', credentials: { app_id: ' cli_app_1 ', app_secret: 'app-secret-value' } })
  assert.equal(connected.ok, true, JSON.stringify(connected))
  const row = rowOf(connected.value)
  assert.equal(row.state, 'ready')
  assert.equal(row.mode, 'app')
  assert.equal(row.inbound.state, 'ready')
  assert.equal(row.inbound.app, 'set')
  assert.equal(dials.length, 1, 'the socket dialled once the pair was proved')

  const tokenCall = feishu.calls.find(entry => entry.url.endsWith('/open-apis/auth/v3/tenant_access_token/internal'))
  assert.deepEqual(tokenCall.body, { app_id: 'cli_app_1', app_secret: 'app-secret-value' }, 'the probe proves the pair it was given')
  assert.equal(feishu.calls.filter(entry => entry.url.includes('im/v1/messages')).length, 0, 'connecting sends no message')

  const disk = readFileSync(join(home, 'state.json'), 'utf8')
  assert.equal(JSON.parse(disk).connectors.feishu.appId, 'cli_app_1')
  assert.doesNotMatch(disk, /app-secret-value/, 'the App Secret is not in state.json')
  assert.equal(rt.secretValue('FEISHU_APP_SECRET'), 'app-secret-value')
  assert.doesNotMatch(JSON.stringify(connected.value), /app-secret-value/, 'and it never comes back in the row')
})

test('#1266: a stranger starts no turn, appears on the row, and Allow makes the next message land', async (t) => {
  const feishu = fakeFeishu()
  const realFetch = globalThis.fetch
  globalThis.fetch = feishu.fetch
  const { rt, ctx, dials } = rig(t)
  t.after(() => { globalThis.fetch = realFetch })
  const delivered = []
  rt.remoteChats.open = async () => 'chat'
  rt.remoteChats.deliver = async message => { delivered.push(message); return 'chat' }

  await call(ctx, 'connector-connect', { id: 'feishu', mode: 'app', credentials: { app_id: 'cli_app_1', app_secret: 'app-secret-value' } })
  const onEvent = dials[0]
  assert.equal(await onEvent(event({ id: 'e1', openId: 'ou_stranger_1' })), 'refused')
  assert.equal(delivered.length, 0, 'nobody may spend the owner\'s tokens by default')

  const refused = rowOf((await call(ctx, 'state', {})).value).inbound.refusedSenders
  assert.equal(refused.length, 1)
  assert.equal(refused[0].openId, 'ou_stranger_1')
  assert.equal(refused[0].name, 'Mallory', 'the row names who was turned away')
  assert.match(refused[0].at, /^\d{4}-\d{2}-\d{2}T/)

  const allowed = await call(ctx, 'connector-allow', { id: 'feishu', openId: 'ou_stranger_1' })
  assert.equal(allowed.ok, true, JSON.stringify(allowed))
  const row = rowOf(allowed.value)
  assert.deepEqual(row.allowed, [{ openId: 'ou_stranger_1', name: 'Mallory' }])
  assert.deepEqual(row.inbound.refusedSenders, [], 'an allowed sender leaves the refused list at once')

  assert.equal(await onEvent(event({ id: 'e2', openId: 'ou_stranger_1' })), 'delivered')
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0].handle, 'feishu:oc_chat_1')
  assert.equal(delivered[0].plugin, 'feishu', 'the chat still carries the plugin its answers leave on')

  const blocked = await call(ctx, 'connector-block', { id: 'feishu', openId: 'ou_stranger_1' })
  assert.deepEqual(rowOf(blocked.value).allowed, [])
  assert.equal(await onEvent(event({ id: 'e3', openId: 'ou_stranger_1' })), 'refused')
  assert.equal(delivered.length, 1)
})

// #1983: the nightly teardown lost an `rmdir` to a writer that outlived `dispose()`. The socket's
// close is one of those writers, and a shutdown that drops it with `void` returns while it is
// still closing — the home is then removed under it. This socket takes a real tick to close, and
// `dispose()` must not resolve before it has.
test('#1983: a shutdown waits for the Feishu dial to close', async (t) => {
  const feishu = fakeFeishu()
  const realFetch = globalThis.fetch
  globalThis.fetch = feishu.fetch
  t.after(() => { globalThis.fetch = realFetch })
  const closed = []
  const { ctx } = rig(t, { onClose: async () => { await new Promise(resolve => setTimeout(resolve, 50)); closed.push(1) } })
  await call(ctx, 'connector-connect', { id: 'feishu', mode: 'app', credentials: { app_id: 'cli_app_1', app_secret: 'app-secret-value' } })
  assert.equal(closed.length, 0, 'the stub socket is still open while the test runs')
  await ctx.dispose()
  assert.equal(closed.length, 1, 'dispose() waited for the socket close, so a teardown cannot race it')
})

test('#1266: Disconnect closes the socket, deletes both credentials, and no turn starts after it', async (t) => {
  const feishu = fakeFeishu()
  const realFetch = globalThis.fetch
  globalThis.fetch = feishu.fetch
  const { rt, ctx, dials, closes, home } = rig(t)
  t.after(() => { globalThis.fetch = realFetch })
  const delivered = []
  rt.remoteChats.open = async () => 'chat'
  rt.remoteChats.deliver = async message => { delivered.push(message); return 'chat' }

  await call(ctx, 'connector-connect', { id: 'feishu', mode: 'app', credentials: { app_id: 'cli_app_1', app_secret: 'app-secret-value' } })
  const onEvent = dials[0]
  const off = await call(ctx, 'connector-disconnect', { id: 'feishu' })
  assert.equal(off.ok, true, JSON.stringify(off))
  const row = rowOf(off.value)
  assert.equal(row.state, 'off')
  assert.equal(row.mode, null)
  assert.equal(row.inbound.state, 'off')
  assert.deepEqual(row.allowed, [])
  assert.equal(closes.length, 1, 'the socket was closed, not leaked')
  assert.equal(rt.secretValue('FEISHU_APP_SECRET'), undefined)
  assert.equal(JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).connectors?.feishu, undefined)

  assert.equal(await onEvent(event({ id: 'e9' })), 'off', 'an event a socket still hands over starts nothing while off')
  assert.equal(delivered.length, 0)
})

test('#1266: webhook mode is today\'s sender: one test POST, ready, no socket and no guest list', async (t) => {
  const feishu = fakeFeishu([answer(200, { code: 0, data: { message_id: 'om_test' } })])
  const realFetch = globalThis.fetch
  globalThis.fetch = feishu.fetch
  const { ctx, dials } = rig(t)
  t.after(() => { globalThis.fetch = realFetch })

  const connected = await call(ctx, 'connector-connect', { id: 'feishu', mode: 'webhook', credentials: { webhook: 'https://feishu.test/open-apis/bot/v2/hook/abc' } })
  assert.equal(connected.ok, true, JSON.stringify(connected))
  const row = rowOf(connected.value)
  assert.equal(row.state, 'ready')
  assert.equal(row.mode, 'webhook')
  assert.equal(row.inbound.state, 'off')
  assert.equal(dials.length, 0, 'webhook mode dials nothing')
  assert.equal(feishu.calls.filter(entry => entry.url.includes('/bot/v2/hook/')).length, 1, 'one test message, as phase 1')
  const guest = await call(ctx, 'connector-allow', { id: 'feishu', openId: 'ou_someone_1' })
  assert.equal(guest.ok, false, 'a webhook-only row has no guest list')
})

test('#1266: a half-saved app pair dials nothing and says so on the row', async (t) => {
  const { ctx, dials } = rig(t, { record: { mode: 'app', appId: 'cli_app_1' } })
  const row = await until(async () => rowOf((await call(ctx, 'state', {})).value), value => value?.state === 'error')
  assert.equal(row.state, 'error')
  assert.match(row.error, /App ID and App Secret/)
  assert.equal(dials.length, 0, 'one half of a pair never opens a socket')
  assert.equal(row.inbound.state, 'off')
})

test('#1266: app mode answers back into the same Feishu chat, as the app', async (t) => {
  const feishu = fakeFeishu()
  const realFetch = globalThis.fetch
  globalThis.fetch = feishu.fetch
  t.after(() => { globalThis.fetch = realFetch })

  const handed = []
  const reply = feishuReply({
    appOf: () => ({ appId: 'cli_app_1', appSecret: 'app-secret-value' }),
    secretValue: () => undefined,
    sendApp: async (message, options) => { handed.push({ message, options }) },
  })
  await reply({ handle: 'feishu:oc_chat_9', text: 'the answer' })
  assert.deepEqual(handed[0].message, { appId: 'cli_app_1', appSecret: 'app-secret-value', chatId: 'oc_chat_9', text: 'the answer' })
  await assert.rejects(reply({ handle: 'not-a-feishu-chat', text: 'x' }), /Not sent: this answer has no Feishu chat/)

  await feishuAppSend(
    { appId: 'cli_app_1', appSecret: 'app-secret-value', chatId: 'oc_chat_9', text: 'the answer' },
    { api: 'https://feishu.test' },
  )
  const send = feishu.calls.find(entry => entry.url.includes('/open-apis/im/v1/messages'))
  assert.equal(send.url, 'https://feishu.test/open-apis/im/v1/messages?receive_id_type=chat_id')
  assert.equal(send.body.receive_id, 'oc_chat_9')
  assert.equal(send.body.msg_type, 'text')
  assert.deepEqual(JSON.parse(send.body.content), { text: 'the answer' })
  assert.equal(send.headers.authorization, 'Bearer t_app_token')
})

test('#1266: feishu is a name a saved capability may not take', () => {
  assert.ok(RESERVED_NAMES.includes('feishu'))
})
