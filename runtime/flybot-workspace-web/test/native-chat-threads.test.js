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

test('cancellation stays bound to the selected live Session and a later turn can resume there', async t => {
  t.mock.timers.enable({apis:['setTimeout']})
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
  const cancelled = runTurn(rt, ctx, bot.id, 'first', 'stop', 100, [], {sessionId, signal:controller.signal, interactive:true})
  t.mock.timers.tick(150)
  controller.abort(reason)
  await assert.rejects(cancelled, error => error === reason)
  const resumed = await runTurn(rt, ctx, bot.id, 'second', 'resume', undefined, [], {sessionId})
  assert.deepEqual(resumed, {text: 'reply', sessionId, turnId: null})
  assert.deepEqual(selected, [['send', sessionId, 'stop'], ['cancel', sessionId], ['send', sessionId, 'resume']])
  assert.equal(bot.sessionId, 'foreground')
})

function bridgedTurn({sendAcknowledgment, ...options} = {}) {
  const {rt, bot} = fixture()
  const events = new EventEmitter()
  const ctx = {on(name, fn) { events.on(name, fn); return () => events.off(name, fn) }}
  const session = {id:bot.sessionId}
  const sessionEvent = (type, data, target = session) => events.emit('session/event', target, {type,data})
  const echo = (rpcId = 'my-request', target = session) => sessionEvent('user/message', {source:{rpcId}}, target)
  rt.displayItems = (_, [event]) => event.type === 'assistant/message' ? [{kind:'bot',text:event.data.text}] : []
  rt.sendUser = async () => {
    rt.live.set(session.id, {turn:1})
    sessionEvent('turn/start', {turn:1})
    await sendAcknowledgment
  }
  const reply = runTurn(rt, ctx, bot.id, 'first', 'my-request', 100, [], {sessionId:session.id, ...options})
  return {rt, bot, events, session, sessionEvent, echo, reply}
}

test('an interactive reply can stream and finish after the admission deadline', async t => {
  t.mock.timers.enable({apis:['setTimeout']})
  const phases = []
  const {echo, events, session, sessionEvent, reply} = bridgedTurn({interactive:true, onPhase:phase => phases.push(phase)})
  echo()
  t.mock.timers.tick(101)
  const agent = {id:session.id, session}
  events.emit('agent/assistant-stream', {agent, frame:{type:'start', turn:1, attemptId:'draft', step:1, revision:1}})
  events.emit('agent/assistant-stream', {agent, frame:{type:'chunk', attemptId:'draft', revision:2, chunk:{type:'text-delta', text:'working'}}})
  t.mock.timers.tick(200)
  sessionEvent('assistant/message', {turn:1, text:'completed reply'})
  sessionEvent('turn/end', {turn:1, turnId:'finished'})
  assert.deepEqual(phases, ['thinking', 'writing'])
  assert.deepEqual(await reply, {text:'completed reply', sessionId:session.id, turnId:'finished'})
  assert.equal(events.eventNames().length, 0)
})

test('an acknowledged private send with no echo or native work releases its listeners', async t => {
  t.mock.timers.enable({apis:['setTimeout']})
  const {rt, events, session, reply} = bridgedTurn({interactive:true})
  const expectInterruption = assert.rejects(reply, {code:'agents/reply-interrupted'})
  await new Promise(setImmediate)
  rt.live.delete(session.id)
  t.mock.timers.tick(100)
  await expectInterruption
  assert.deepEqual(events.eventNames(), [])
})

test('a blocked private reply settles even when its Bot moves to an untagged part', async () => {
  for (const interim of ['', 'I will check this.']) {
    const {rt, bot, echo, events, session, sessionEvent, reply} = bridgedTurn({interactive:true})
    echo()
    if (interim) sessionEvent('assistant/message',{turn:1,text:interim})
    rt.switchJobs = () => [{resume:false}]
    rt.isSwitchingPart = () => true
    bot.sessionId = 'next-part'
    bot.segments.push({sessionId:session.id})
    rt.chatOwners.delete(session.id)
    rt.pastOwners.set(session.id,{botId:bot.id})
    rt.chatOwners.set(bot.sessionId,bot.id)
    sessionEvent('turn/end',{turn:1,reason:{kind:'blocked'}})
    await assert.rejects(reply, {code:'agents/reply-blocked'})
    assert.deepEqual(events.eventNames(), [])
  }
})

test('an exact tagged handoff still carries the reply into the next native part', async () => {
  const {rt, bot, echo, session, sessionEvent, reply} = bridgedTurn({interactive:true})
  echo()
  sessionEvent('assistant/message',{turn:1,text:'Before handoff'})
  rt.switchJobs = () => [{resume:true,flybotPrivateReply:'my-request'}]
  rt.isSwitchingPart = id => id === session.id
  sessionEvent('turn/end',{turn:1,reason:{kind:'aborted'}})
  const next = {id:'next-part'}
  bot.sessionId = next.id
  bot.segments.push({sessionId:session.id})
  rt.chatOwners.delete(session.id)
  rt.pastOwners.set(session.id,{botId:bot.id})
  rt.chatOwners.set(next.id,bot.id)
  rt.switchJobs = () => []
  sessionEvent('turn/start',{turn:1},next)
  sessionEvent('user/message',{source:{resume:true,flybotPrivateReply:'my-request'}},next)
  sessionEvent('assistant/message',{turn:1,text:'After handoff'},next)
  sessionEvent('turn/end',{turn:1,reason:{kind:'completed'}},next)
  assert.deepEqual(await reply,{text:'Before handoff\n\nAfter handoff',sessionId:next.id,turnId:null})
})

test('interrupting a private handoff removes the exact queued continuation', {timeout:2000}, async () => {
  const controller = new AbortController()
  const {rt, bot, echo, session, sessionEvent, reply} = bridgedTurn({interactive:true,signal:controller.signal})
  echo()
  rt.switchJobs = () => [{resume:true,flybotPrivateReply:'my-request'}]
  rt.isSwitchingPart = id => id === session.id
  const reason = new Error('A newer message interrupted this reply')
  const stopped = assert.rejects(reply, error => error === reason)
  controller.abort(reason)
  const next = {id:'next-part'}
  bot.sessionId = next.id
  bot.segments.push({sessionId:session.id})
  rt.chatOwners.delete(session.id)
  rt.pastOwners.set(session.id,{botId:bot.id})
  rt.chatOwners.set(next.id,bot.id)
  const unrelated = {id:'other',source:{rpcId:'someone-else'}}
  const continued = {id:'continuation',source:{resume:true,flybotPrivateReply:'my-request'}}
  const queued = [unrelated,continued]
  rt.resolveAgent = async id => {
    assert.equal(id,next.id)
    return {inbox:{nextTurn:queued,remove(key) {
      const position = queued.findIndex(m => m.id === key)
      return position >= 0 && queued.splice(position,1).length === 1
    }}}
  }
  sessionEvent('turn/end',{turn:1,reason:{kind:'blocked'}})
  await stopped
  assert.deepEqual(queued,[unrelated])
})

test('a missed private terminal event can be recovered from the exact owned session turn', async t => {
  t.mock.timers.enable({apis:['setTimeout']})
  const {rt, echo, events, session, sessionEvent, reply} = bridgedTurn({interactive:true})
  const log = [
    ['turn/start',{turn:0}],
    ['user/message',{source:{rpcId:'other-request'}}],
    ['assistant/message',{turn:0,text:'Do not take this reply'}],
    ['turn/end',{turn:0,reason:{kind:'completed'}}],
    ['turn/start',{turn:1}],
    ['user/message',{source:{rpcId:'my-request'}}],
    ['assistant/message',{turn:1,text:'The saved answer'}],
    ['turn/end',{turn:1,reason:{kind:'completed'},turnId:'saved'}],
  ]
  session.seq = log.length
  session.eventAt = seq => {
    const [type,data] = log[seq]
    return {type,data,seq}
  }
  echo()
  sessionEvent('assistant/message',{turn:1,text:'The saved answer'})
  rt.live.delete(session.id)
  t.mock.timers.tick(100)
  assert.deepEqual(await reply,{text:'The saved answer',sessionId:session.id,turnId:'saved'})
  assert.deepEqual(events.eventNames(), [])
})

test('an unacknowledged send requires an exact native echo before the deadline', async t => {
  t.mock.timers.enable({apis:['setTimeout']})
  const {echo, session, reply} = bridgedTurn({interactive:true,sendAcknowledgment:new Promise(() => {})})
  const timedOut = assert.rejects(reply, /turn timed out/)
  echo('other-request')
  echo('my-request', {id:'other-session'})
  echo('my-request', {id:session.id})
  t.mock.timers.tick(100)
  await timedOut
})

test('fixed turn deadlines still apply to background and managed group calls after native echo', async t => {
  t.mock.timers.enable({apis:['setTimeout']})
  for (const options of [{}, {interactive:true, managedGroup:true}]) {
    const {echo, events, reply} = bridgedTurn(options)
    const timedOut = assert.rejects(reply, /turn timed out/)
    echo()
    t.mock.timers.tick(100)
    await timedOut
    assert.equal(events.eventNames().length, 0)
  }
})

test('disposal settles only the exact admitted Session without requiring a stream frame', async t => {
  t.mock.timers.enable({apis:['setTimeout']})
  const {echo, events, session, reply} = bridgedTurn({interactive:true})
  echo()
  t.mock.timers.tick(150)
  let rejected = false
  const expectDisposal = assert.rejects(reply, {code:'agents/empty-reply'}).then(() => { rejected = true })
  events.emit('agent/disposed', {agent:{id:session.id, session:{id:session.id}}})
  await Promise.resolve()
  assert.equal(rejected, false)
  assert.equal(events.listenerCount('agent/disposed'), 1)
  events.emit('agent/disposed', {agent:{id:session.id, session}})
  await expectDisposal
  assert.equal(events.eventNames().length, 0)
})

test('stopping an admitted reply does not cancel a later native turn', async t => {
  t.mock.timers.enable({apis:['setTimeout']})
  const controller = new AbortController()
  const {rt, echo, events, session, reply} = bridgedTurn({interactive:true, signal:controller.signal})
  let cancelled = false
  rt.resolveAgent = async () => ({session, cancel:() => { cancelled = true }})
  echo()
  t.mock.timers.tick(150)
  rt.live.set(session.id, {turn:2})
  const reason = new Error('stopped by user')
  controller.abort(reason)
  await assert.rejects(reply, error => error === reason)
  assert.equal(cancelled, false)
  assert.equal(events.eventNames().length, 0)
})

test('a stopped interactive reply settles if native cancellation produces no terminal event', async t => {
  t.mock.timers.enable({apis:['setTimeout']})
  const controller = new AbortController()
  const {rt, echo, events, session, reply} = bridgedTurn({interactive:true, signal:controller.signal})
  const attempted = Promise.withResolvers()
  rt.resolveAgent = async () => ({session, cancel:attempted.resolve})
  echo()
  t.mock.timers.tick(150)
  const reason = new Error('stopped by user')
  const stopped = assert.rejects(reply, error => error === reason)
  controller.abort(reason)
  await attempted.promise
  t.mock.timers.tick(30_000)
  await stopped
  assert.equal(events.eventNames().length, 0)
})
