import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createBridge, MODEL_OVERRIDE, prepareNativeChat, runTurn, startBridge } from '../../flybot-image/ds-bot-bridge.mjs'
import { addPrivateChat, livePrivateChat } from '../lib/native-chat.js'
import { adoptThread } from '../features/agents/history.js'

function fixture() {
  const bot = {id: 'bot', name: 'Bot', sessionId: 'foreground', segments: []}
  const other = {id: 'other', sessionId: 'other-session', segments: []}
  const rt = {
    botOf: id => ({bot, other})[id],
    chatOf: () => bot.sessionId,
    chatOwners: new Map([[bot.sessionId, bot.id], [other.sessionId, other.id]]),
    pastOwners: new Map(),
    live: new Map(),
  }
  return {bot, other, rt}
}

test('new private chats leave the native foreground alone and a saved part follows only its own live head', async () => {
  const {rt, bot} = fixture()
  addPrivateChat(rt, bot, {sessionId: 'private-head', segments: [{sessionId: 'private-root'}]})
  addPrivateChat(rt, bot, {sessionId: 'sibling', segments: []})
  assert.equal(bot.sessionId, 'foreground')
  assert.throws(() => addPrivateChat(rt, bot, {sessionId: 'other-session'}), /already owned/)
  assert.equal(livePrivateChat(rt, 'other', 'private-root'), undefined)
  rt.pastOwners.set('a-group', {botId: bot.id, roomId: 'room'})
  assert.equal(livePrivateChat(rt, bot.id, 'a-group'), undefined)

  const calls = []
  rt.applyModel = async () => 'provider/model'
  rt.selectSessionModel = async (id, model) => calls.push([id, model])
  rt.applyPermission = async (owner, id) => calls.push([owner.id, id])
  assert.equal(await prepareNativeChat(rt, bot.id, 'private-root'), 'private-head')
  assert.deepEqual(calls, [['private-head', {provider: 'provider', model: 'model'}], [bot.id, 'private-head']])
  await assert.rejects(prepareNativeChat(rt, bot.id, 'other-session'), /no longer active/)
})

test('moving a saved conversation keeps its past parts non-live under the new Bot', async () => {
  const {rt, bot, other} = fixture()
  addPrivateChat(rt, bot, {sessionId: 'private-head', segments: [{sessionId: 'private-root'}]})
  addPrivateChat(rt, bot, {sessionId: 'sibling', segments: []})
  rt.live.set('private-root', {turn: 1})
  await assert.rejects(adoptThread({rt, source: bot, target: other, sessionId: 'private-root'}), {code: 'agents/history-busy'})
  rt.live.delete('private-root')
  assert.equal(await adoptThread({rt, source: bot, target: other, sessionId: 'private-root'}), 'private-head')
  assert.deepEqual(bot.openParts.map(part => part.sessionId), ['sibling'])
  assert.equal(other.sessionId, 'other-session')
  assert.deepEqual(rt.pastOwners.get('private-root'), {botId: 'other'})
  assert.equal(rt.chatOwners.has('private-root'), false)
  assert.equal(livePrivateChat(rt, bot.id, 'private-root'), undefined)
  assert.equal(livePrivateChat(rt, other.id, 'private-root'), 'private-head')
})

test('a corrupt stored chain fails closed when it claims two conversation roots', async () => {
  const {rt, bot} = fixture()
  bot.openParts = [null, {}, {sessionId: 'sibling', segments: [null, {}]}]
  bot.segments = [null, {}, {sessionId: 'saved-a'}, {sessionId: 'saved-b'}]
  bot.flybotWorkspace = {sessionKeys: {a: 'saved-a', aAlias: 'saved-a', b: 'saved-b'}}
  rt.pastOwners.set('saved-a', {botId: bot.id})
  rt.pastOwners.set('saved-b', {botId: bot.id})
  rt.chatOwners.set('sibling', bot.id)
  assert.equal(livePrivateChat(rt, bot.id, 'sibling'), 'sibling')
  assert.equal(livePrivateChat(rt, bot.id, 'saved-a'), undefined)
  await assert.rejects(prepareNativeChat(rt, bot.id, 'saved-b'), /no longer active/)
  delete bot.flybotWorkspace.sessionKeys.b
  assert.equal(livePrivateChat(rt, bot.id, 'saved-a'), 'foreground')
})

test('adoption verifies the owner of every prior segment before modifying either Bot', async () => {
  const {rt, bot, other} = fixture()
  bot.openParts = [null, {sessionId: 'private-head', segments: [null, {sessionId: 'foreign-part'}]}]
  rt.chatOwners.set('private-head', bot.id)
  rt.chatOwners.set('foreign-part', other.id)
  rt.pastOwners.set('foreign-part', {botId: bot.id})
  await assert.rejects(adoptThread({rt, source: bot, target: other, sessionId: 'private-head'}),
    {code: 'agents/legacy-session-unowned'})
  assert.equal(bot.openParts[1].sessionId, 'private-head')
  assert.equal(other.openParts, undefined)
  assert.equal(rt.chatOwners.get('private-head'), bot.id)
  assert.equal(rt.chatOwners.get('foreign-part'), other.id)

  rt.chatOwners.delete('foreign-part')
  assert.equal(await adoptThread({rt, source: bot, target: other, sessionId: 'private-head'}), 'private-head')
  assert.deepEqual(other.openParts[0].segments, [{sessionId: 'foreign-part'}])
})

test('bridge startup protects an existing workflow foreground chain without claiming its siblings', async t => {
  const {rt, bot} = fixture()
  const home = mkdtempSync(join(tmpdir(), 'ot-bridge-chats-'))
  t.after(() => rmSync(home, {recursive: true, force: true}))
  const legacy = {'automation:saved': 'older-foreground', 'skill-run:other': 'other-session', 'automation:background': 'background'}
  writeFileSync(join(home, 'flybot-workspace-chats.json'), JSON.stringify(legacy))
  bot.segments.push({sessionId: 'older-foreground'})
  rt.pastOwners.set('older-foreground', {botId: bot.id})
  bot.openParts = [{sessionId: 'background', segments: []}]
  rt.chatOwners.set('background', bot.id)
  bot.model = 'flybot-workspace/flybot-workspace-model'
  rt.state = {mainBotIds: [bot.id]}
  rt.addProvider = rt.bootstrap = async () => {}
  let saved = 0
  rt.save = async () => { saved++ }
  const bridge = createBridge(rt, {env: {DSH_HOME: home}})
  assert.equal(await bridge.setup(), bot.id)
  assert.equal(bot.flybotWorkspace.managedOpenParts, true)
  assert.deepEqual(bot.flybotWorkspace.sessionKeys, {'automation:saved': 'older-foreground'})
  assert.equal(saved, 1)
  assert.equal(bot.sessionId, 'foreground')
})

test('native bootstrap installs the authenticated provider before selecting Chief’s exact model', async t => {
  const {rt, bot} = fixture()
  const home = mkdtempSync(join(tmpdir(), 'ot-native-bootstrap-'))
  t.after(() => rmSync(home, {recursive:true, force:true}))
  globalThis[MODEL_OVERRIDE] = () => ({provider:'fixture'})
  t.after(() => { delete globalThis[MODEL_OVERRIDE] })
  rt.state = {mainBotIds:[bot.id]}
  bot.model = 'other-provider/flybot-workspace-model'
  const calls = []
  rt.load = async () => {}
  rt.addProvider = async ({provider,baseURL,key}) => {
    assert.equal(provider, 'flybot-workspace')
    assert.equal(new URL(baseURL).hostname, '127.0.0.1')
    assert.match(key, /^[a-f0-9]{48}$/)
    calls.push('provider')
  }
  rt.bootstrap = async () => { calls.push('native bootstrap') }
  rt.updateBot = async (id, {model}) => {
    assert.equal(id, bot.id)
    bot.model = model
    calls.push('model')
  }
  const {server,bridge} = startBridge(rt, {}, {env:{DSH_HOME:home}, port:0, log:() => {}})
  t.after(() => server.close())
  await Promise.all([rt.bootstrap(), bridge.setup(), rt.bootstrap()])
  assert.deepEqual(calls, ['provider', 'native bootstrap', 'model'])
  assert.equal(bot.model, 'flybot-workspace/flybot-workspace-model')
})

test('cancellation stays bound to the selected live Session and a later turn can resume there', async () => {
  const {rt, bot} = fixture()
  addPrivateChat(rt, bot, {sessionId: 'private-head', segments: [{sessionId: 'private-root'}]})
  const events = new EventEmitter()
  const ctx = {on(name, fn) { events.on(name, fn); return () => events.off(name, fn) }}
  const session = {id: 'private-head'}
  const closeTurn = turn => events.emit('session/event', session, {type: 'turn/end', data: {turn}})
  const selected = []
  let turn = 0
  rt.resolveAgent = async id => {
    assert.equal(id, session.id)
    return {session, cancel() { selected.push(['cancel', id]); closeTurn(turn) }}
  }
  rt.displayItems = (_, [event]) => event.type === 'assistant/message' ? [{kind: 'bot', text: 'reply'}] : []
  rt.sendUser = async ({sessionId, requestId}) => {
    selected.push(['send', sessionId, requestId])
    assert.equal(sessionId, session.id)
    turn++
    rt.live.set(sessionId, {turn})
    events.emit('session/event', session, {type: 'turn/start', data: {turn}})
    events.emit('session/event', session, {type: 'user/message', data: {source: {rpcId: requestId}}})
    if (requestId === 'resume') {
      events.emit('session/event', session, {type: 'assistant/message', data: {turn}})
      closeTurn(turn)
    }
  }
  const sessionId = livePrivateChat(rt, bot.id, 'private-root')
  const controller = new AbortController()
  const reason = new Error('stopped by user')
  const cancelled = runTurn(rt, ctx, bot.id, 'first', 'stop', undefined, [], {sessionId, signal: controller.signal})
  controller.abort(reason)
  await assert.rejects(cancelled, error => error === reason)
  const resumed = await runTurn(rt, ctx, bot.id, 'second', 'resume', undefined, [], {sessionId})
  assert.deepEqual(resumed, {text: 'reply', sessionId, turnId: null})
  assert.deepEqual(selected, [['send', sessionId, 'stop'], ['cancel', sessionId], ['send', sessionId, 'resume']])
  assert.equal(bot.sessionId, 'foreground')
})
