import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createFeishuService } from '../src/host/feishu-service.js'
import { createFeishuVault } from '../src/host/feishu-vault.js'
import { createFeishuEventServer } from '../src/host/feishu-http.js'
import { readMessage, fromPost, markdown, toCard, MAX_POST } from '../src/host/feishu-format.js'
import { setupSteps, permissionJSON, validateCredentials } from '../src/shared/feishu.js'
import { canUse } from '../src/host/secrets.js'
import { installFeishuTools, FEISHU_OPERATIONS, operationWrites } from '../src/host/feishu-tools.js'
import { createFeishuCalendars } from '../src/host/feishu-calendar.js'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { SOURCE_KIND } from '../src/host/constants.js'
import { createFeishuApi } from '../src/host/feishu-api.js'
import { createFeishuTransport, SDK_PACKAGE } from '../src/host/feishu-sdk.js'
import { install as installResume } from '../src/host/resume.js'
import { install as installDelivery } from '../src/host/delivery.js'

const APP = 'cli_0123456789abcdef', OTHER = 'cli_fedcba9876543210'
const owner = { memberId: 'owner-1' }
const creds = { appId: APP, appSecret: 'fixture-app-secret', verificationToken: 'fixture-verification' }
const event = (id = 'm1', more = {}) => ({ header: { event_id: `e-${id}`, event_type: 'im.message.receive_v1', app_id: APP, token: creds.verificationToken }, event: { sender: { sender_id: { open_id: 'ou_alice' }, sender_type: 'user' }, message: { message_id: id, chat_id: 'oc_group', chat_type: 'group', root_id: 'om_root', message_type: 'text', mentions: [{ id: { open_id: 'ou_bot' } }], content: JSON.stringify({ text: 'hello' }), ...more } } })
const until = async fn => { for (let i = 0; i < 100; i++) { if (fn()) return; await delay(5) }; assert.fail('condition did not settle') }
function rig(snapshot, options = {}) {
  const rt = { home: '', config: {}, state: snapshot ?? { members: { 'owner-1': { id: 'owner-1', displayName: 'Owner' }, bob: { id: 'bob', displayName: 'Bob' } }, bots: { b1: { id: 'b1', ownerId: 'owner-1', name: 'Chief' } } }, ctx: {}, authzEnforced: () => true, readOnly: () => undefined, load: async () => {}, save: async () => {}, botOf(id) { return rt.state.bots[id] } }
  const calls = [], delivered = [], history = [], secrets = new Map()
  const vault = { get: async id => secrets.get(id), set: async (id, value) => value === undefined ? secrets.delete(id) : secrets.set(id, structuredClone(value)) }
  let failSend = false, failPost = false
  const request = async (url, init) => {
    const path = new URL(url).pathname, body = init.body instanceof FormData ? init.body : init.body ? JSON.parse(init.body) : undefined
    calls.push({ path, method: init.method, body })
    if (path.includes('tenant_access_token')) return Response.json({ code: 0, tenant_access_token: 'fixture-tenant-token', expire: 7200 })
    if (failSend && path.includes('/messages') && init.method === 'POST' && !path.includes('reactions')) throw new Error('fixture network failure')
    if (failPost && body?.msg_type === 'post') return Response.json({ code: 230001 })
    const data = path.includes('bot/v3/info') ? { bot: { open_id: 'ou_bot', app_name: 'Example' } } : path.includes('application/v6/scopes') ? { scopes: [] } : path.includes('/chats/') ? { name: 'Example group' } : path.includes('reactions') ? { reaction_id: 'reaction1' } : { message_id: 'sent-card' }
    return Response.json({ code: 0, data })
  }
  rt.deliver = async m => { delivered.push(m) }
  rt.remoteChats = { open: async () => {}, deliver: async m => { history.push(m) } }
  const transport = options.transport ?? (() => ({ connect: async () => ({ close: async () => {} }) }))
  const service = createFeishuService(rt, { request, vault, transport })
  const save = async (id = APP, mode = 'socket') => {
    await service.endpoint({ operation: 'save', appId: id, appSecret: creds.appSecret, mode, verificationToken: creds.verificationToken, publicUrl: 'https://events.example.com', botId: 'b1' }, owner)
    await service.endpoint({ operation: 'allow', appId: id, openId: 'ou_alice' }, owner)
  }
  return { rt, service, calls, delivered, history, vault, secrets, save, failSend: value => { failSend = value }, failPost: value => { failPost = value } }
}

test('setup flows, credential validation and a single permission import cover both receiving methods', () => {
  assert.equal(setupSteps('socket').length, 6)
  assert.equal(setupSteps('http').length, 7)
  assert.equal(setupSteps('http')[0], 'Prepare a public event address')
  assert.throws(() => validateCredentials({ ...creds, appId: 'cli_nothexcharacters' }, 'socket'), /16 hexadecimal/)
  assert.throws(() => validateCredentials({ ...creds, verificationToken: '' }, 'http'), /Verification Token/)
  validateCredentials(creds, 'http')
  const permissions = JSON.parse(permissionJSON(['calendar', 'docs', 'bitable', 'sheets', 'meeting', 'task']))
  assert.ok(permissions.scopes.tenant.includes('im:message.reactions:write_only'))
  assert.ok(permissions.scopes.tenant.includes('wiki:wiki'))
  assert.ok(permissions.scopes.tenant.includes('vc:reserve'))
  assert.equal(new Set(permissions.scopes.tenant).size, permissions.scopes.tenant.length)
})

test('vault encrypts credentials on disk and authenticates their application binding', async t => {
  const home = await mkdtemp(join(tmpdir(), 'feishu-vault-')); t.after(() => rm(home, { recursive: true, force: true }))
  const vault = createFeishuVault(home)
  await vault.set(APP, creds)
  const bytes = await readFile(join(home, 'feishu-credentials.json'), 'utf8')
  assert.ok(!bytes.includes(creds.appSecret)); assert.ok(!bytes.includes(creds.verificationToken))
  assert.equal((await stat(join(home, 'feishu-credentials.json'))).mode & 0o777, 0o600)
  assert.deepEqual(await createFeishuVault(home).get(APP), creds)
  assert.equal(canUse({ name: 'FEISHU_APP_SECRET', scope: 'all' }, 'b1'), false)
  assert.equal(canUse({ name: 'OTHER_KEY', scope: 'all' }, 'b1'), true)
  assert.equal(canUse({ name: 'FEISHU_CUSTOM_USER_KEY', scope: 'all' }, 'b1'), true)
  await vault.set(APP, undefined); assert.equal(await vault.get(APP), undefined)
})

test('switching methods retains app, sender list, identity, Bot and conversation handle, but deletes token', async () => {
  const r = rig(); await r.save(APP, 'http')
  await r.service.endpoint({ operation: 'identity', appId: APP, openId: 'ou_alice', memberId: 'bob' }, owner)
  await r.service.endpoint({ operation: 'save', appId: APP, mode: 'socket' }, owner)
  assert.equal(Object.keys(r.service.data().apps).length, 1)
  assert.equal((await r.vault.get(APP)).verificationToken, undefined)
  assert.deepEqual(r.service.appOf(APP).allowed, ['ou_alice'])
  assert.equal(r.service.appOf(APP).botId, 'b1')
  assert.equal(r.service.identity(APP, 'ou_alice').memberId, 'bob')
  await assert.rejects(r.service.receive(APP, event(), 'http'), /Receiving method changed/)
  const display = JSON.stringify(r.service.view(owner))
  assert.ok(!display.includes(creds.appSecret)); assert.ok(!display.includes(creds.verificationToken))
})

test('persisted inbox deduplicates concurrent and restarted deliveries and routes replies to their thread', async () => {
  const r = rig(); await r.save()
  await Promise.all([r.service.receive(APP, event(), 'socket'), r.service.receive(APP, event(), 'socket')])
  await until(() => r.delivered.length === 1)
  assert.equal(r.delivered[0].toId, 'b1'); assert.equal(r.delivered[0].feishu.rootId, 'om_root')
  assert.equal(r.history[0].handle, `feishu:oc_group`)
  const restarted = rig(structuredClone(r.rt.state)); await restarted.vault.set(APP, await r.vault.get(APP))
  assert.equal((await restarted.service.receive(APP, event(), 'socket')).duplicate, true)
  assert.equal(restarted.delivered.length, 0)
  await r.service.complete(r.delivered[0].feishu, '**answer**')
  const reply = r.calls.find(c => c.path.endsWith('/om_root/reply'))
  assert.ok(reply); assert.equal(reply.body.reply_in_thread, true)
  assert.equal(reply.body.msg_type, 'post')
  assert.ok(r.calls.some(c => c.method === 'DELETE' && c.path.endsWith('/reactions/reaction1')))
})

test('save failure is not acknowledged as a handled event', async () => {
  const r = rig(); await r.save()
  r.rt.save = async () => { throw new Error('disk full') }
  await assert.rejects(r.service.receive(APP, event(), 'socket'), /disk full/)
  assert.equal(Object.keys(r.service.data().events).length, 0)
  r.rt.save = async () => {}
  assert.equal((await r.service.receive(APP, event(), 'socket')).duplicate, false)
  await until(() => r.delivered.length === 1)
})

test('HTTP verifies token, application, mode and encryption before accepting a challenge or event', async () => {
  const r = rig(); await r.save(APP, 'http')
  await assert.rejects(r.service.receive(APP, { token: 'wrong', type: 'url_verification', challenge: 'x' }, 'http'), /Verification Token/)
  assert.deepEqual(await r.service.receive(APP, { token: creds.verificationToken, type: 'url_verification', challenge: 'x' }, 'http'), { challenge: 'x' })
  await assert.rejects(r.service.receive(APP, { token: creds.verificationToken, encrypt: 'ciphertext' }, 'http'), /Encrypt Key/)
  const foreign = event(); foreign.header.app_id = OTHER
  await assert.rejects(r.service.receive(APP, foreign, 'http'), /does not match/)
  assert.equal(Object.keys(r.service.data().events).length, 0)
})

test('event listener exposes only event paths and never console or arbitrary API access', async t => {
  const r = rig(); await r.save(APP, 'http')
  const server = createFeishuEventServer(r.service)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close())
  const base = `http://127.0.0.1:${server.address().port}`
  assert.equal((await fetch(`${base}/api/bot`)).status, 404)
  const response = await fetch(`${base}/api/feishu/events/${APP}`, { method: 'POST', body: JSON.stringify({ type: 'url_verification', token: creds.verificationToken, challenge: 'challenge' }) })
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { challenge: 'challenge' })
})

test('Markdown round trip preserves rich content and thread metadata without fetching external images', () => {
  const text = fromPost({ zh_cn: { title: 'Title', content: [[{ tag: 'text', text: 'bold', style: ['bold'] }, { tag: 'a', text: 'link', href: 'https://example.com' }], [{ tag: 'code_block', language: 'js', text: 'x()' }], [{ tag: 'hr' }]] } })
  assert.match(text, /\*\*bold\*\*/); assert.match(text, /\[link\]/); assert.match(text, /```js/); assert.match(text, /---/)
  const m = event('rich', { message_type: 'post', content: JSON.stringify({ zh_cn: { content: [[{ tag: 'text', text: 'hello' }, { tag: 'img', image_key: 'fixture-image' }]] } }) })
  const read = readMessage(m)
  assert.equal(read.text, 'hello'); assert.equal(read.files.length, 1); assert.equal(read.rootId, 'om_root')
  assert.match(markdown('# Title\n![pic](https://example.com/x.png)\n<at user_id="all">all</at>'), /^#### Title/)
  assert.ok(!markdown('<at user_id="all">').includes('<at user_id="all">'))
  assert.equal(markdown('See [notes](/files/1) and [site](https://example.com)'), 'See notes and [site](https://example.com)', 'a console-relative link keeps only its text')
  assert.equal(markdown('```mermaid\ngraph TD\n```'), '```mermaid\ngraph TD\n```', 'Mermaid stays code, with no console link')
  assert.equal(markdown('Ask @Bob', new Map([['Bob', 'ou_bob']])), 'Ask <at user_id="ou_bob">Bob</at>')
})

test('rich-post rejection and size overflow fall back to plain text, leaving technical details in diagnostics', async () => {
  const r = rig(); await r.save(); r.failPost(true)
  await r.service.sendText(APP, { chatId: 'chat' }, '**answer**', 'uuid1')
  assert.deepEqual(r.calls.filter(c => c.body?.msg_type).map(c => c.body.msg_type), ['post', 'text'])
  await r.service.sendText(APP, { chatId: 'chat' }, 'x'.repeat(MAX_POST + 1), 'uuid2')
  assert.equal(r.calls.at(-1).body.msg_type, 'text')
  assert.equal(r.service.appOf(APP).diagnostics[0].kind, 'format')
})

test('failed sending keeps the Get reaction; explicit retry sends once and only then removes it', async () => {
  const r = rig(); await r.save(); await r.service.receive(APP, event(), 'socket'); await until(() => r.delivered.length === 1)
  r.failSend(true); await r.service.complete(r.delivered[0].feishu, 'answer')
  assert.equal(r.service.data().events[`${APP}:m1`].reactionId, 'reaction1')
  assert.ok(!r.calls.some(c => c.method === 'DELETE'))
  r.failSend(false); await r.service.endpoint({ operation: 'retry', appId: APP, outboxId: `${APP}:m1` }, owner)
  assert.equal(r.service.data().outbox[`${APP}:m1`].status, 'sent')
  assert.equal(r.service.data().events[`${APP}:m1`].reactionId, undefined)
})

test('cards persist before sending and require the actual linked clicker; replay and foreign app cannot resubmit', async () => {
  const r = rig(); await r.save()
  const card = await r.service.card(APP, 'b1', { chatId: 'oc_group', rootId: 'om_root' }, { title: 'Question', blocks: [{ type: 'text', text: 'Choose' }, { type: 'input', name: 'comment', label: 'Comment' }], actions: [{ id: 'yes', label: 'Submit' }] })
  const callback = { header: { event_type: 'card.action.trigger', event_id: 'click1' }, event: { operator: { open_id: 'ou_alice' }, context: { open_message_id: 'sent-card', open_chat_id: 'oc_group' }, action: { value: { flybot_card: card.id, action: 'yes', version: 1 }, form_value: { comment: 'hi' } } } }
  assert.equal((await r.service.receive(APP, callback, 'socket')).toast.type, 'error')
  assert.equal(r.delivered.length, 0)
  await r.service.endpoint({ operation: 'identity', appId: APP, openId: 'ou_alice', memberId: 'bob' }, owner)
  const response = await r.service.receive(APP, callback, 'socket')
  assert.equal(response.toast.content, '已提交')
  await until(() => r.delivered.length === 1)
  assert.equal(r.service.data().cards[card.id].submissions[0].memberId, 'bob')
  assert.match(r.delivered[0].text, /bob/)
  assert.deepEqual(await r.service.receive(APP, callback, 'socket'), response)
  await delay(10); assert.equal(r.delivered.length, 1)
  const rendered = toCard(r.service.data().cards[card.id])
  assert.equal(rendered.body.elements.find(e => e.tag === 'form').elements[0].tag, 'input')
  assert.equal(rendered.body.elements.find(e => e.tag === 'form').elements.at(-1).disabled, true)
})

test('tool capabilities default off, remain app-specific and are removed with the connection', async () => {
  const r = rig(); await r.save(); await r.save(OTHER)
  assert.throws(() => r.service.authorizeTool('b1', APP, 'calendar', false), /not granted/)
  await r.service.endpoint({ operation: 'grant', appId: APP, botId: 'b1', product: 'calendar', mode: 'read' }, owner)
  assert.equal(r.service.authorizeTool('b1', APP, 'calendar', false), 'read')
  assert.throws(() => r.service.authorizeTool('b1', APP, 'calendar', true), /not granted/)
  assert.throws(() => r.service.authorizeTool('b1', OTHER, 'calendar', false), /not granted/)
  await assert.rejects(r.service.endpoint({ operation: 'grant', appId: APP, botId: 'b1', product: 'calendar', mode: 'write' }, { memberId: 'bob' }), /app owner/)
  await r.service.endpoint({ operation: 'delete', appId: APP }, owner)
  assert.equal(r.service.data().grants[APP], undefined); assert.equal(await r.vault.get(APP), undefined)
})

test('write gate requests native approval before network access; meeting host must come from linked request context', async () => {
  const r = rig(); await r.save()
  const tools = new Map(), listeners = new Map()
  r.rt.ctx = { tools: { register: tool => tools.set(tool.name, tool) }, on: (name, listener) => listeners.set(name, listener) }
  r.rt.whoseAgent = () => ({ bot: r.rt.state.bots.b1 })
  r.rt.liveOf = () => ({ info: { feishu: { appId: APP, openId: 'ou_alice' } } })
  installFeishuTools(r.rt, r.service)
  const args = { appId: APP, operation: 'calendar_create', parameters: { body: { summary: 'Team' } } }, exec = { name: 'feishu_tool', arguments: args, agent: { id: 'b1' } }
  await r.service.endpoint({ operation: 'grant', appId: APP, botId: 'b1', product: 'calendar', mode: 'ask' }, owner)
  const before = r.calls.length
  assert.equal((await listeners.get('tools/pre-execute')(exec, async () => ({ kind: 'allow' }))).kind, 'ask')
  assert.equal(r.calls.length, before)
  await r.service.endpoint({ operation: 'grant', appId: APP, botId: 'b1', product: 'meeting', mode: 'write' }, owner)
  const booking = { appId: APP, operation: 'meeting_reserve', parameters: { body: { owner_id: 'forged-owner', end_time: '2000000000' } } }
  await assert.rejects(tools.get('feishu_tool').execute(booking, exec), /没有关联/)
  await r.service.endpoint({ operation: 'identity', appId: APP, openId: 'ou_alice', memberId: 'bob' }, owner)
  await tools.get('feishu_tool').execute(booking, exec)
  assert.equal(r.calls.at(-1).body.owner_id, 'ou_alice')
  assert.deepEqual(new Set(Object.values(FEISHU_OPERATIONS).map(op => op[0])), new Set(['calendar', 'docs', 'bitable', 'sheets', 'meeting', 'task']))
  assert.equal(operationWrites(FEISHU_OPERATIONS.bitable_records), false)
})

test('multiple requests queue for one Bot and do not clear a later request reaction', async () => {
  const r = rig(); await r.save()
  await r.service.receive(APP, event('m1'), 'socket'); await until(() => r.delivered.length === 1)
  await r.service.receive(APP, event('m2'), 'socket'); await delay(15)
  assert.equal(r.delivered.length, 1)
  await r.service.complete(r.delivered[0].feishu, 'first answer')
  await until(() => r.delivered.length === 2)
  assert.equal(r.delivered[1].feishu.eventId, `${APP}:m2`)
  assert.ok(!r.calls.some(c => c.method === 'DELETE' && c.path.includes('/m2/')))
})

test('meetings use the actual linked human across companies and refuse ambiguous or missing accounts', async () => {
  const r = rig(); await r.save(); await r.save(OTHER)
  const tools = new Map()
  r.rt.ctx = { tools: { register: tool => tools.set(tool.name, tool) }, on() {} }
  r.rt.whoseAgent = () => ({ bot: r.rt.state.bots.b1 })
  let live = { info: { feishu: { appId: APP, openId: 'ou_alice' } }, requesterMemberId: 'owner-1' }
  r.rt.liveOf = () => live
  installFeishuTools(r.rt, r.service)
  for (const [appId, openId] of [[APP, 'ou_alice'], [OTHER, 'ou_bob_other']]) await r.service.endpoint({ operation: 'identity', appId, openId, memberId: 'bob' }, owner)
  await r.service.endpoint({ operation: 'grant', appId: OTHER, botId: 'b1', product: 'meeting', mode: 'write' }, owner)
  const booking = { appId: OTHER, operation: 'meeting_reserve', parameters: { body: { owner_id: 'forged', end_time: '2000000000' } } }, exec = { agent: { id: 'b1' } }
  await tools.get('feishu_tool').execute(booking, exec)
  assert.equal(r.calls.at(-1).body.owner_id, 'ou_bob_other')
  live = { requesterMemberId: 'bob' }
  await tools.get('feishu_tool').execute(booking, exec)
  assert.equal(r.calls.at(-1).body.owner_id, 'ou_bob_other')
  live = { info: { feishu: { appId: APP, openId: 'ou_unlinked' } }, requesterMemberId: 'bob' }
  await assert.rejects(tools.get('feishu_tool').execute(booking, exec), /没有关联/)
  live = { requesterMemberId: 'bob' }
  await r.service.endpoint({ operation: 'identity', appId: OTHER, openId: 'ou_second', memberId: 'bob' }, owner)
  await assert.rejects(tools.get('feishu_tool').execute(booking, exec), /没有关联/)
})

test('native delivery deduplicates a new event but permits its interrupted turn to resume', async () => {
  const messages = [], meta = { eventId: 'event', appId: APP, chatId: 'oc_chat' }
  const agent = { session: { surface: { nodes: [1] }, eventAt: () => ({ data: { source: { exchangeId: 'event' } } }) }, followup: message => messages.push(message) }
  const rt = { state: {}, ctx: { sessionController: { resolveAgent: async () => ({ agent }) }, sessions: { flush: async () => {} } }, botOf: id => id ? { id } : undefined, chatOf: id => id, roomOf() {}, ensureCapabilities: async () => {}, hideBlockingQuestion() {} }
  installDelivery(rt)
  const args = { toId: 'b1', role: 'feishu', exchangeId: 'event', feishu: meta, origin: 'other', text: 'question' }
  await rt.deliver(args); assert.equal(messages.length, 0)
  await rt.deliver({ ...args, resumed: true }); assert.equal(messages.length, 1)
  assert.deepEqual(messages[0].source.feishu, meta)
})

test('restart pickup retains the Feishu target and suppresses cancelled-handler recovery', async t => {
  const home = await mkdtemp(join(tmpdir(), 'feishu-resume-')), meta = { eventId: 'event', appId: APP, chatId: 'oc_chat', rootId: 'om_thread', openId: 'ou_alice' }
  await writeFile(join(home, 'inflight.json'), JSON.stringify({ turns: { b1: { botId: 'b1', trigger: { role: 'feishu', exchangeId: 'event', feishu: meta } }, b2: { botId: 'b2', trigger: { role: 'feishu', feishu: { ...meta, eventId: 'cancelled' } } } }, queued: {} }))
  const ctx = fakeContext(), deliveries = []
  const rt = { home, ctx, state: { feishu: { apps: { [APP]: {} }, events: { event: { botId: 'b1', status: 'admitted' }, cancelled: { botId: 'b2', status: 'cancelled' } } } }, live: new Map(), readOnly() {}, load: async () => {}, botOf: id => ({ id }), chatOf: id => id, resolveAgent: async () => ({}), deliver: async args => deliveries.push(args), warn() {} }
  t.mock.timers.enable({ apis: ['setTimeout'] })
  installResume(rt)
  t.after(async () => { await ctx.dispose(); await rm(home, { recursive: true, force: true }) })
  t.mock.timers.tick(3000)
  for (let i = 0; i < 1000 && !deliveries.length; i++) await new Promise(resolve => setImmediate(resolve))
  assert.equal(deliveries.length, 1)
  assert.equal(deliveries[0].role, 'feishu'); assert.equal(deliveries[0].resumed, true)
  assert.deepEqual(deliveries[0].feishu, meta)
})

test('native turn completion routes the original Feishu metadata to its durable outbox', async t => {
  const home = await mkdtemp(join(tmpdir(), 'feishu-turn-'))
  const ctx = fakeContext(), rt = createRuntime(ctx, { home })
  await rt.load()
  rt.state.bots.b1 = { id: 'b1', sessionId: 'b1', name: 'Chief', ownerId: 'owner-1' }
  rt.chatOwners.set('b1', 'b1')
  const completed = [], meta = { eventId: 'fixture-event', appId: APP, chatId: 'oc_chat', rootId: 'om_root', openId: 'ou_alice' }
  rt.feishu = { complete: async (...args) => completed.push(args) }
  t.after(async () => { await ctx.dispose(); await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }) })
  const emit = async (type, data) => { for (const listener of ctx.listeners.get('session/event') ?? []) await listener({ id: 'b1' }, { type, data }) }
  await emit('turn/start', { turn: 1 })
  await emit('user/message', { source: { kind: 'user', authorKind: 'human', authorId: 'bob' }, content: [{ type: 'text', text: 'native question' }] })
  assert.equal(rt.liveOf('b1').requesterMemberId, 'bob')
  await emit('turn/start', { turn: 2 })
  assert.equal(rt.liveOf('b1').requesterMemberId, undefined)
  await emit('user/message', { source: { kind: SOURCE_KIND, form: 'relay', role: 'feishu', exchangeId: 'fixture-event', feishu: meta, origin: 'other', hop: 0 }, content: [{ type: 'text', text: 'question' }] })
  await emit('assistant/message', { message: { content: [{ type: 'text', text: 'answer' }] } })
  await emit('turn/end', { reason: { kind: 'completed' } })
  assert.equal(completed.length, 1)
  assert.deepEqual(completed[0][0], meta)
  assert.equal(completed[0][1], 'answer')
})

test('calendar group sharing preserves existing owners and removes only its own unchanged ACL additions', async () => {
  const state = {}, calls = [], acl = [{ acl_id: 'owner-acl', role: 'owner', scope: { user_id: 'ou_owner' } }]
  const api = { async call(method, path, options = {}) {
    calls.push({ method, path, body: options.body })
    if (path.endsWith('/members')) return { items: [{ member_id: 'ou_owner' }, { member_id: 'ou_joiner' }] }
    if (method === 'GET') return { acls: structuredClone(acl) }
    if (method === 'POST') { const row = { acl_id: 'new-acl', ...options.body }; acl.push(row); return row }
    return {}
  } }
  const service = { data: () => state, api: () => api, commit: async fn => fn(), diagnose: async () => {}, authorizeTool() {} }
  const calendars = createFeishuCalendars(service)
  const result = await calendars.share(APP, 'b1', { calendar_id: 'calendar', chat_id: 'chat', role: 'reader' })
  assert.equal(result.members, 2)
  assert.equal(calls.filter(c => c.method === 'POST').length, 1)
  assert.equal(calls.find(c => c.method === 'POST').body.scope.user_id, 'ou_joiner')
  await calendars.share(APP, 'b1', { calendar_id: 'calendar', chat_id: 'chat', stop: true })
  assert.equal(calls.filter(c => c.method === 'DELETE').length, 1)
  assert.ok(calls.find(c => c.method === 'DELETE').path.endsWith('/new-acl'))
  assert.deepEqual(state.calendarShares, {})
})

test('revocation while obtaining a tenant token prevents the pending product request', async () => {
  let release, revoked = false
  const requests = []
  const api = createFeishuApi(async () => creds, async url => {
    requests.push(String(url))
    return new Promise(resolve => { release = () => resolve(Response.json({ code: 0, tenant_access_token: 'fixture-token' })) })
  })
  const pending = api.call('POST', 'calendar/v4/calendars', { body: { summary: 'Team' }, authorize: () => { if (revoked) throw new Error('grant revoked') } })
  await until(() => !!release)
  revoked = true; release()
  await assert.rejects(pending, /grant revoked/)
  assert.equal(requests.length, 1)
  assert.ok(requests[0].includes('/auth/v3/'))
})

test('changing a handler cancels only matching Feishu work and suppresses its late answer', async () => {
  const r = rig(); await r.save()
  r.rt.state.bots.b2 = { id: 'b2', ownerId: 'owner-1', name: 'Other Bot' }
  await r.service.receive(APP, event(), 'socket'); await until(() => r.delivered.length === 1)
  const meta = r.delivered[0].feishu, cancellations = []
  r.rt.liveOf = () => ({ turn: 1, info: { feishu: meta } })
  r.rt.resolveAgent = async () => ({ cancel: reason => cancellations.push(reason) })
  await r.service.endpoint({ operation: 'configure', appId: APP, botId: 'b2', chatId: 'oc_group' }, owner)
  assert.equal(cancellations.length, 1)
  assert.equal(r.service.data().events[meta.eventId].status, 'cancelled')
  await r.service.complete(meta, 'late answer')
  assert.equal(r.service.data().outbox[meta.eventId], undefined)
})

test('all six tool products use platform-held credentials and their named API operations', async () => {
  const r = rig(); await r.save()
  const tools = new Map()
  r.rt.ctx = { tools: { register: tool => tools.set(tool.name, tool) }, on() {} }
  r.rt.whoseAgent = () => ({ bot: r.rt.state.bots.b1 })
  r.rt.liveOf = () => ({ info: { feishu: { appId: APP, openId: 'ou_alice' } } })
  installFeishuTools(r.rt, r.service)
  await r.service.endpoint({ operation: 'identity', appId: APP, openId: 'ou_alice', memberId: 'bob' }, owner)
  const cases = [
    ['calendar', 'calendar_list', {}, '/calendar/v4/calendars'],
    ['docs', 'docs_read', { document_id: 'doc' }, '/docx/v1/documents/doc/raw_content'],
    ['bitable', 'bitable_records', { app_token: 'base', table_id: 'table', body: {} }, '/bitable/v1/apps/base/tables/table/records/search'],
    ['sheets', 'sheets_read', { spreadsheet_token: 'sheet', range: 'sheet1!A1:B2' }, '/sheets/v2/spreadsheets/sheet/values/'],
    ['meeting', 'meeting_reserve', { body: { end_time: '2000000000' } }, '/vc/v1/reserves/apply'],
    ['task', 'task_create', { body: { summary: 'Work' }, query: { user_id_type: 'open_id' } }, '/task/v2/tasks'],
  ]
  for (const [product, operation, parameters, path] of cases) {
    await r.service.endpoint({ operation: 'grant', appId: APP, botId: 'b1', product, mode: 'write' }, owner)
    const result = await tools.get('feishu_tool').execute({ appId: APP, operation, parameters }, { agent: { id: 'b1' } })
    assert.ok(r.calls.at(-1).path.includes(path), operation)
    assert.ok(!result.includes(creds.appSecret))
    assert.ok(!result.includes('fixture-tenant-token'))
  }
})

test('rich cards keep tables outside the final form and include all supported block types', () => {
  const record = { id: 'card', version: 1, card: { blocks: [
    { type: 'text', text: '**text**' }, { type: 'fields', items: [{ label: 'Key', value: 'Value' }] },
    { type: 'list', items: ['Item'] }, { type: 'progress', value: 50 }, { type: 'chart', spec: { type: 'bar', data: { values: [] } } },
    { type: 'pages', pages: [{ title: 'Table page', blocks: [{ type: 'table', columns: ['Column'], rows: [['Value']] }] }, { title: 'Text page', blocks: [{ type: 'text', text: 'Page' }] }] },
    { type: 'input', name: 'answer', label: 'Answer' }, { type: 'applet', description: 'Interactive explanation' },
  ], actions: [{ id: 'submit', label: 'Submit' }] } }
  const card = toCard(record), elements = card.body.elements
  assert.equal(card.schema, '2.0')
  assert.ok(elements.some(e => e.tag === 'table'))
  assert.ok(elements.some(e => e.tag === 'chart'))
  assert.ok(elements.some(e => e.tag === 'collapsible_panel'))
  assert.equal(elements.at(-1).tag, 'form')
  assert.ok(elements.at(-1).elements.every(e => ['input', 'button'].includes(e.tag)))
})

test('a long connection without the SDK installed says so instead of blaming the network', async () => {
  // The Docker image once linked ds-bot without its dependencies: credentials and network were
  // fine, but the diagnosis sent the owner to check them.
  const missing = (credentials) => createFeishuTransport({ credentials, importSdk: async () => { throw new Error(`Cannot find package '${SDK_PACKAGE}' imported from core`) } })
  const r = rig(undefined, { transport: ({ credentials }) => missing(credentials) })
  await r.save()
  await until(() => r.service.appOf(APP).diagnostics?.length)
  const [first] = r.service.appOf(APP).diagnostics
  assert.equal(first.kind, 'connection')
  assert.match(first.message, /long-connection SDK is not installed/)
  assert.doesNotMatch(first.message, /open\.feishu\.cn|credentials/)

  const offline = rig(undefined, { transport: () => ({ connect: async () => { throw new Error('getaddrinfo ENOTFOUND open.feishu.cn') } }) })
  await offline.save()
  await until(() => offline.service.appOf(APP).diagnostics?.length)
  assert.match(offline.service.appOf(APP).diagnostics[0].message, /^Could not connect to open\.feishu\.cn/, 'other dial failures keep the network advice')
})

test('the connection keeps no console address: save and configure ignore one', async () => {
  const r = rig(); await r.save()
  await r.service.endpoint({ operation: 'save', appId: APP, mode: 'socket', consoleUrl: 'https://flybot.example.com' }, owner)
  await r.service.endpoint({ operation: 'configure', appId: APP, consoleUrl: 'https://flybot.example.com' }, owner)
  assert.equal(r.service.appOf(APP).consoleUrl, undefined)
})

test('feishu_file uploads within the Feishu limits and refuses the rest without sending a console link', async () => {
  const r = rig(); await r.save()
  const tools = new Map()
  const small = { attachmentId: 'a-small', name: 'notes.txt', bytes: 5 }
  const huge = { attachmentId: 'a-huge', name: 'video.mov', bytes: 31 * 1024 * 1024 }
  const bigImage = { attachmentId: 'a-image', name: 'scan.png', mediaType: 'image/png', bytes: 11 * 1024 * 1024 }
  r.rt.ctx = { tools: { register: tool => tools.set(tool.name, tool) }, on() {}, attachments: {
    async* readFileStream() { yield Buffer.from('hello') },
    readImage: async () => assert.fail('an oversized image is not read'),
  } }
  r.rt.whoseAgent = () => ({ bot: r.rt.state.bots.b1 })
  r.rt.liveOf = () => ({ info: { feishu: { appId: APP, openId: 'ou_alice', chatId: 'oc_chat' } } })
  installFeishuTools(r.rt, r.service)
  const session = { surface: { nodes: [1] }, eventAt: () => ({ data: { message: { content: [small, huge, bigImage].map(attachment => ({ type: 'file', attachment })) } } }) }
  const send = attachmentId => tools.get('feishu_file').execute({ attachmentId }, { agent: { id: 'b1', session }, callId: `call-${attachmentId}` })

  assert.equal(await send('a-small'), 'Sent')
  assert.ok(r.calls.some(c => c.path.endsWith('/im/v1/files')))
  assert.equal(r.calls.filter(c => c.body?.msg_type === 'file').length, 1)
  await assert.rejects(send('a-huge'), /files up to 30 MB/)
  await assert.rejects(send('a-image'), /images up to 10 MB/)
  r.failSend(true)
  await assert.rejects(send('a-small'), /did not accept the attachment/)
  assert.equal(r.service.appOf(APP).diagnostics.at(-1).kind, 'attachment-send')
  assert.ok(!r.calls.some(c => ['post', 'text'].includes(c.body?.msg_type)), 'no fallback message with a link is sent')
})
