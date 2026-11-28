import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, request as httpRequest } from 'node:http'
import { EventEmitter, once } from 'node:events'
import { PassThrough } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import {
  createBridge, createBridgeServer, forwardModel, runTurn, startBridge, MODEL_ID,
  userModelOverride, MODEL_OVERRIDE, prepareNativeChat, textOnlyCompletion,
} from '../runtime/flybot-image/ds-bot-bridge.mjs'

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
const close = server => new Promise(resolve => server.close(resolve))

test('loopback proxy uses the configured model and key; DS-Bot holds a per-boot token', async () => {
  const seen = []
  const upstream = createServer((req, res) => {
    let raw = ''
    req.on('data', c => { raw += c })
    req.on('end', () => {
      seen.push({ path: req.url, auth: req.headers.authorization, body: JSON.parse(raw) })
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.end('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n')
    })
  })
  const upstreamPort = await listen(upstream)
  const modelApi = { base_url: `http://127.0.0.1:${upstreamPort}/v1`, model: 'real-model', api_key: 'synthetic-model-key' }
  let model = modelApi
  const state = { token: 'placeholder-token', startupModel: () => model }
  const proxy = createBridgeServer(state)
  const port = await listen(proxy)
  const url = `http://127.0.0.1:${port}`
  try {
    assert.equal((await fetch(url + '/v1/chat/completions', { method: 'POST', body: '{}' })).status, 401)
    const models = await (await fetch(url + '/v1/models', { headers: { authorization: 'Bearer placeholder-token' } })).json()
    assert.equal(models.data[0].id, MODEL_ID)
    const response = await fetch(url + '/v1/chat/completions', { method: 'POST',
      headers: { authorization: 'Bearer placeholder-token', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL_ID, stream: true, messages: [{ role: 'user', content: 'x' }] }) })
    assert.equal(response.status, 200)
    assert.match(await response.text(), /\[DONE\]/)
    assert.equal(seen[0].path, '/v1/chat/completions')
    assert.equal(seen[0].auth, 'Bearer synthetic-model-key')
    assert.equal(seen[0].body.model, 'real-model')
    assert.equal((await fetch(url + '/mcp', { method: 'POST', body: '{}' })).status, 404)
    model = null
    const idle = await fetch(url + '/v1/chat/completions', { method: 'POST', headers: { authorization: 'Bearer placeholder-token' }, body: '{}' })
    assert.equal(idle.status, 503)
  } finally { await close(proxy); await close(upstream) }
})

test('exact-HTTP grant: redirects are rejected and only the granted path is used', async () => {
  const base = 'http://8.8.8.8:8080/v1'
  const modelApi = { base_url: base, model: 'm', api_key: 'k', http_endpoint_grant: { base_url: base, format: 'flybot-workspace.exact-http-task.v1' } }
  const requests = []
  const fake = status => (options, onResponse) => {
    requests.push(options)
    const req = new EventEmitter()
    req.end = () => {
      const response = new PassThrough()
      response.statusCode = status
      response.headers = { 'content-type': 'application/json' }
      onResponse(response)
      response.end('{"ok":true}')
    }
    req.destroy = () => {}
    return req
  }
  const res = { headersSent: false, writeHead() { this.headersSent = true }, destroy() {}, chunks: [] }
  await assert.rejects(forwardModel(modelApi, Buffer.from('{}'), res, { httpRequester: fake(302) }), /redirect/)
  assert.equal(requests[0].path, '/v1/chat/completions')
  assert.equal(requests[0].agent, false)
  assert.equal(requests[0].family, 4)
  const wrong = { ...modelApi, http_endpoint_grant: { base_url: 'http://8.8.4.4:8080/v1', format: 'flybot-workspace.exact-http-task.v1' } }
  await assert.rejects(forwardModel(wrong, Buffer.from('{}'), res, { httpRequester: fake(200) }), /grant/)
})

function fakeRuntime() {
  const ctx = new EventEmitter()
  const on = ctx.on.bind(ctx)
  ctx.on = (name, fn) => { on(name, fn); return () => ctx.off(name, fn) }
  const log = []
  let bridgeState
  const bot = { id: 'bot1', model: undefined }
  const rt = {
    state: { mainBotIds: ['bot1'] },
    botOf: id => (id === 'bot1' ? bot : undefined),
    chatOf: () => 'chat1',
    addProvider: async body => { log.push(['addProvider', body.provider, body.baseURL, body.key === bridgeState.token]) },
    setProviderKey: async () => {},
    bootstrap: async () => { log.push(['bootstrap']) },
    updateBot: async (id, patch) => { log.push(['updateBot', patch.model]); bot.model = 'flybot-workspace/' + patch.model },
    capabilityDelete: async (name, opts) => {
      log.push(['delete', name, opts.ui])
      delete rt.state.capabilities.items[name]
    },
    displayItems: (_sid, [event]) => (event.type === 'assistant/message' ? [{ kind: 'bot', text: event.data.text }] : []),
    sendUser: async ({ sessionId, content, requestId }) => {
      log.push(['sendUser', sessionId, content[0].text, requestId])
      setImmediate(() => {
        const session = { id: sessionId }
        ctx.emit('session/event', session, { type: 'turn/start' })
        ctx.emit('session/event', session, { type: 'user/message', data: { source: { rpcId: requestId } } })
        ctx.emit('session/event', session, { type: 'assistant/message', data: { text: 'reply from DS-Bot' } })
        ctx.emit('session/event', session, { type: 'turn/end', data: { turn: 't1' } })
      })
    },
  }
  return { rt, ctx, log, bind: state => { bridgeState = state } }
}

test('the DeepSeek Flash vision model updates a retained provider and follows account changes', async () => {
  const fake = fakeRuntime()
  const bridge = createBridge(fake.rt, { port: 1 })
  fake.bind(bridge.state)
  let model = 'DeepSeek-V4.1-Flash-1017'
  bridge.state.startupModel = () => ({model})
  fake.rt.addProvider = async () => { throw new Error('flybot-workspace is already set up') }
  const updates = []
  fake.rt.saveProviderModels = async ({provider,models}) => updates.push([provider,models[0].input])
  await bridge.prepareModel()
  await bridge.prepareModel()
  assert.deepEqual(updates,[['flybot-workspace',['text','image']]])
  model = 'another-text-only-model'
  await bridge.prepareModel()
  model = 'deepseek-flash'
  await bridge.prepareModel()
  assert.deepEqual(updates,[
    ['flybot-workspace',['text','image']], ['flybot-workspace',['text']], ['flybot-workspace',['text','image']],
  ])
})

test('a missing model is actionable and does not block other native providers', () => {
  const fake = fakeRuntime()
  const bridge = createBridge(fake.rt, {port:1})
  const bot = fake.rt.botOf('bot1')
  bot.model = 'flybot-workspace/' + MODEL_ID
  bridge.state.startupModel = () => null
  assert.throws(() => bridge.requireModel(bot.id), {code:'agents/model-unconfigured', status:503})
  bot.model = 'other-provider/alternate'
  assert.doesNotThrow(() => bridge.requireModel(bot.id))
  bot.model = MODEL_ID
  bridge.state.startupModel = () => ({model:'owner-selected'})
  assert.doesNotThrow(() => bridge.requireModel(bot.id))
})

test('a provisioned DS-Bot starts its native proxy and runs a turn without polling retired routes', async t => {
  const origins = []
  const management = createServer((req, res) => {
    origins.push(req.url)
    res.writeHead(410).end('{}')
  })
  const managementPort = await listen(management)
  t.after(async () => { management.closeAllConnections(); await close(management) })
  const home = mkdtempSync(join(tmpdir(), 'ot-native-only-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const keyFile = join(home, 'runtime-key.json')
  writeFileSync(keyFile, JSON.stringify({
    origin: 'http://127.0.0.1:' + managementPort,
    token: 'synthetic-runtime-key', hostname: 'native-fixture',
  }))
  const fake = fakeRuntime()
  const rt = fake.rt
  rt.state.capabilities = { items: {
    'ot-tools': { kind: 'mcp', transport: 'streamable-http', url: 'http://127.0.0.1:18731/mcp?catalog=0123456789abcdef' },
    'ot-apps': { kind: 'mcp', transport: 'streamable-http', url: 'http://127.0.0.1:3022/mcp' },
  } }
  const value = startBridge(rt, fake.ctx, {
    env: { DSH_HOME: home, FLYBOT_WORKSPACE_RUNTIME_KEY_FILE: keyFile },
    port: 0,
    log: () => {},
  })
  t.after(async () => {
    const stopped = once(value.server, 'close')
    value.dispose()
    value.server.closeAllConnections()
    await stopped
  })
  fake.bind(value.bridge.state)
  await once(value.server, 'listening')
  const models = await fetch('http://127.0.0.1:' + value.server.address().port + '/v1/models', {
    headers: { authorization: 'Bearer ' + value.bridge.state.token },
  })
  assert.equal(models.status, 200)
  const turn = await value.bridge.exclusive(async () => {
    await value.bridge.prepareModel()
    return runTurn(rt, fake.ctx, value.bridge.botId, 'native hello', 'native-fixture')
  })
  assert.equal(turn.text, 'reply from DS-Bot')
  assert.deepEqual(fake.log.find(entry => entry[0] === 'sendUser'), ['sendUser', 'chat1', 'native hello', 'native-fixture'])
  assert.deepEqual(fake.log.filter(entry => entry[0] === 'delete'), [['delete', 'ot-tools', true]])
  assert.deepEqual(Object.keys(rt.state.capabilities.items), ['ot-apps'])
  assert.deepEqual(origins, [])
})

test('sending to a live mapped part selects its route without changing the foreground or touching other parts', async () => {
  const foreground = 'foreground'
  const target = 'open-21'
  const parts = Array.from({length: 22}, (_, index) => ({sessionId:'open-' + index, segments:[]}))
  const bot = {id:'bot', sessionId:foreground, openParts:parts, appliedEffort:'high'}
  const operations = []
  const ctx = new EventEmitter()
  const session = {id:target}
  const rt = {
    botOf: id => id === bot.id ? bot : undefined,
    chatOf: () => bot.sessionId,
    chatOwners: new Map([[foreground,bot.id], ...parts.map(part => [part.sessionId,bot.id]), ['someone-else','other']]),
    pastOwners: new Map(),
    async switchPart() { assert.fail('an open part does not require switching') },
    async applyModel(subject, options) {
      assert.equal(subject,bot)
      assert.notEqual(options?.force,true)
      operations.push('check model')
      return 'flybot-workspace/flybot-workspace-model'
    },
    async selectSessionModel(id, route) {
      assert.equal(id,target)
      assert.deepEqual(route,{provider:'flybot-workspace',model:'flybot-workspace-model',reasoningEffort:'high'})
      operations.push('select target')
    },
    async applyPermission(subject, id) {
      assert.equal(subject,bot)
      assert.equal(id,target)
      operations.push('apply target permission')
    },
    async sendUser({sessionId,requestId}) {
      assert.equal(sessionId,target)
      operations.push('send to target')
      ctx.emit('session/event', session, {type:'turn/start',data:{turn:1}})
      ctx.emit('session/event', session, {type:'user/message',data:{source:{rpcId:requestId}}})
      ctx.emit('session/event', session, {type:'assistant/message',data:{text:'selected part reply'}})
      ctx.emit('session/event', session, {type:'turn/end',data:{turn:1}})
    },
    displayItems: (id, events) => {
      assert.equal(id,target)
      return events.filter(event => event.type==='assistant/message').map(event=>({kind:'bot',text:event.data.text}))
    },
  }
  await assert.rejects(prepareNativeChat(rt,bot.id,'someone-else'),/no longer active/)
  assert.deepEqual(operations,[])
  const sessionId = await prepareNativeChat(rt,bot.id,target)
  assert.equal(sessionId,target)
  const reply = await runTurn(rt,ctx,bot.id,'one test prompt','target-request',500,[],{sessionId})
  assert.deepEqual(operations,['check model','select target','apply target permission','send to target'])
  assert.equal(bot.sessionId,foreground)
  assert.equal(reply.text,'selected part reply')
  assert.equal(reply.sessionId,target)
  rt.chatOwners.set(target,'other')
  await assert.rejects(runTurn(rt,ctx,bot.id,'one test prompt','stale-target',500,[],{sessionId:target}),/no longer active/)
  assert.equal(operations.length,4)
})

test('the model proxy aborts the upstream request when DS-Bot disconnects before any response bytes', {timeout:3000}, async t => {
  const arrived = Promise.withResolvers(), disconnected = Promise.withResolvers()
  const upstream = createServer((req,res) => {
    req.resume()
    res.once('close', disconnected.resolve)
    arrived.resolve()
  })
  const upstreamPort = await listen(upstream)
  t.after(() => { upstream.closeAllConnections(); return close(upstream) })
  const log = []
  const model = {base_url:'https://cancel-provider.example/v1',model:'test',api_key:'synthetic'}
  const proxy = createBridgeServer({token:'local-only',startupModel:() => model}, {
    log:line => log.push(line), forward: (api,raw,res) => forwardModel(api,raw,res,{
      httpsRequester: (url, options, callback) => httpRequest(`http://127.0.0.1:${upstreamPort}${url.pathname}`,options,callback),
    }),
  })
  const port = await listen(proxy)
  t.after(() => { proxy.closeAllConnections(); return close(proxy) })
  const controller = new AbortController()
  const result = assert.rejects(fetch(`http://127.0.0.1:${port}/v1/chat/completions`,{method:'POST',body:'{}',
    headers:{authorization:'Bearer local-only'},signal:controller.signal}),{name:'AbortError'})
  await arrived.promise
  controller.abort()
  await result
  await disconnected.promise
  assert.deepEqual(log,[])
})

test('aborting a mapped text turn waits for its exact request echo and native settlement', async () => {
  const ctx = new EventEmitter()
  const listen = ctx.on.bind(ctx)
  ctx.on = (type, listener) => { listen(type, listener); return () => ctx.off(type, listener) }
  const bot = {id:'bot',sessionId:'foreground',openParts:[{sessionId:'target'}]}
  const session = {id:'target'}, foreground = {id:'foreground'}
  const stopped = Promise.withResolvers(), children = Promise.withResolvers()
  const calls = []
  const rt = {
    botOf: () => bot,
    chatOf: () => bot.sessionId,
    chatOwners:new Map([[session.id,bot.id],[foreground.id,bot.id]]),
    pastOwners:new Map(), live:new Map(),
    sendUser({sessionId,requestId}) { calls.push(['send',sessionId,requestId]) },
    async resolveAgent(id) {
      assert.equal(id,session.id)
      return {session,cancel(reason) { calls.push(['cancel',reason]); stopped.resolve() }}
    },
    stopSubagents(id) { calls.push(['children',id]); return children.promise },
    displayItems: () => [],
  }
  const already = AbortSignal.abort()
  await assert.rejects(runTurn(rt,ctx,bot.id,'Never send','pre-aborted',1000,[],{sessionId:session.id,signal:already}),{name:'AbortError'})
  const controller = new AbortController()
  const turn = runTurn(rt,ctx,bot.id,'Stop this one','current-request',1000,[],{sessionId:session.id,signal:controller.signal})
  let completed = false
  const final = assert.rejects(turn,{name:'AbortError'}).then(() => { completed = true })
  const event = (source,type,data) => ctx.emit('session/event',source,{type,data})
  controller.abort()
  event(foreground,'turn/start',{turn:41})
  event(foreground,'user/message',{source:{rpcId:'current-request'}})
  rt.live.set(session.id,{turn:2})
  event(session,'turn/start',{turn:2})
  event(session,'user/message',{source:{rpcId:'unrelated-prior-turn'}})
  await delay(0)
  assert.deepEqual(calls,[['send',session.id,'current-request']])
  event(session,'turn/end',{turn:2})
  rt.live.set(session.id,{turn:3})
  event(session,'turn/start',{turn:3})
  event(session,'user/message',{source:{rpcId:'current-request'}})
  await stopped.promise
  assert.deepEqual(calls,[['send',session.id,'current-request'],['children',session.id],['cancel',{kind:'user'}]])
  assert.equal(completed,false)
  event(session,'turn/end',{turn:3})
  await delay(0)
  assert.equal(completed,false)
  children.resolve()
  await final
  assert.equal(ctx.listenerCount('session/event'),0)
})

test('a delayed abort lookup cannot cancel a newer turn on the same Session', async () => {
  const ctx = new EventEmitter()
  const session = {id:'target'}
  const lookup = Promise.withResolvers(), resolveCalled = Promise.withResolvers()
  const controller = new AbortController()
  const rt = {
    chatOf: () => session.id,
    botOf: () => ({id:'bot',sessionId:session.id}),
    chatOwners:new Map([[session.id,'bot']]), pastOwners:new Map(), live:new Map([[session.id,{turn:1}]]),
    sendUser({requestId}) {
      ctx.emit('session/event',session,{type:'turn/start',data:{turn:1}})
      ctx.emit('session/event',session,{type:'user/message',data:{source:{rpcId:requestId}}})
    },
    resolveAgent() { resolveCalled.resolve(); return lookup.promise },
    stopSubagents() { assert.fail('a newer turn must be left running') },
    displayItems: () => [],
  }
  const result = assert.rejects(runTurn(rt,ctx,'bot','Original','current-request',1000,[],{signal:controller.signal}), {name:'AbortError'})
  controller.abort()
  await resolveCalled.promise
  rt.live.set(session.id,{turn:2})
  ctx.emit('session/event',session,{type:'turn/end',data:{turn:1}})
  lookup.resolve({session,cancel() { assert.fail('a newer turn must be left running') }})
  await result
})

test('an owned historical segment resumes at its own live head without switching the foreground', async () => {
  const bot = {id:'bot', sessionId:'foreground', openParts:[
    {sessionId:'current', segments:[{sessionId:'previous'}]},
  ]}
  const rt = {
    botOf: () => bot,
    chatOf: () => bot.sessionId,
    chatOwners: new Map([['foreground','bot'],['current','bot']]),
    pastOwners: new Map([['previous',{botId:'bot'}]]),
    async switchPart() { assert.fail('history lookup must not change the foreground') },
    applyModel: async()=>'flybot-workspace/flybot-workspace-model',
    selectSessionModel: async id=>assert.equal(id,'current'),
    applyPermission: async (subject,id)=>{
      assert.equal(subject,bot)
      assert.equal(id,'current')
    },
  }
  assert.equal(await prepareNativeChat(rt,'bot','previous'),'current')
  assert.equal(bot.sessionId,'foreground')
  assert.deepEqual(rt.pastOwners.get('previous'),{botId:'bot'})
})

test('the managed group turn hands off promptly when its exact native agent is disposed', async t => {
  for (const terminal of ['disposed event', 'aborted end']) {
    await t.test(terminal, async () => {
      const {rt, ctx} = fakeRuntime()
      const session = {id:'chat1'}
      rt.sendUser = async () => {}
      const result = runTurn(rt, ctx, 'bot1', 'group reply', 'group-request', 1000, [],
        {managedGroup:true, onProgress:() => {}})
      const completion = assert.rejects(result, {code:'agents/empty-reply'})
      const event = (type, data) => ctx.emit('session/event', session, {type,data})
      event('turn/start', {turn:7})
      event('user/message', {turn:7, source:{rpcId:'group-request'}})
      ctx.emit('agent/disposed', {agent:{id:session.id, session:{id:session.id}}})
      assert.equal(ctx.listenerCount('session/event'), 1)
      if (terminal === 'disposed event') ctx.emit('agent/disposed', {agent:{id:session.id, session}})
      else event('turn/end', {turn:7, reason:{kind:'aborted',reason:{kind:'disposed'}}})
      assert.equal(ctx.listenerCount('session/event'), 0)
      await completion
    })
  }
})

test('a queued private request binds on its live successor after the admission window', async () => {
  const {rt, ctx, log} = fakeRuntime()
  const bot = rt.botOf('bot1')
  const successor = {id:'successor'}
  bot.sessionId = 'chat1'
  rt.chatOwners = new Map([['chat1',bot.id]])
  rt.pastOwners = new Map()
  rt.sendUser = async request => log.push(request)
  rt.live = new Map([['chat1',{turn:4}]])
  const reply = runTurn(rt,ctx,bot.id,'queued input','own-request',12,[],{sessionId:'chat1',interactive:true})
  await delay(35)
  rt.live.clear()
  bot.segments = [{sessionId:'chat1'}]
  bot.sessionId = successor.id
  rt.chatOwners.delete('chat1')
  rt.pastOwners.set('chat1',{botId:bot.id})
  rt.chatOwners.set(successor.id,bot.id)
  ctx.emit('session/event',successor,{type:'turn/start',data:{turn:5}})
  ctx.emit('session/event',successor,{type:'user/message',data:{source:{rpcId:'own-request'}}})
  ctx.emit('session/event',successor,{type:'assistant/message',data:{turn:5,text:'queued answer'}})
  ctx.emit('session/event',successor,{type:'turn/end',data:{turn:5}})
  assert.equal((await reply).sessionId,successor.id)
  assert.equal(log.length,1)
})

test('a private reply follows only its native continuation across a part switch', async () => {
  const {rt, ctx, log} = fakeRuntime()
  const bot = rt.botOf('bot1')
  const first = {id:'chat1'}, successor = {id:'successor'}, other = {id:'other'}
  bot.sessionId = first.id
  bot.openParts = [{sessionId:other.id}]
  rt.chatOwners = new Map([[first.id,bot.id],[other.id,bot.id]])
  rt.pastOwners = new Map()
  rt.sendUser = async request => log.push(request)
  const event = (session,type,data) => ctx.emit('session/event',session,{type,data})
  const reply = runTurn(rt,ctx,bot.id,'continue once','own-request',1000,[],{sessionId:first.id,interactive:true})
  event(first,'turn/start',{turn:9})
  event(first,'user/message',{source:{rpcId:'own-request'}})
  event(first,'assistant/message',{turn:9,text:'Opening'})
  const handoffId = rt.flybotPrivateReplyForTurn(first.id,9)
  assert.equal(handoffId,'own-request')
  assert.equal(rt.flybotPrivateReplyForTurn(first.id,10),undefined)
  rt.isSwitchingPart = id => id === first.id
  rt.switchJobs = () => [{resume:true,flybotPrivateReply:handoffId}]
  event(first,'turn/end',{turn:9,reason:{kind:'error'}})
  assert.equal(rt.flybotPrivateReplyForTurn(first.id,9),undefined)
  bot.segments = [{sessionId:first.id}]
  bot.sessionId = successor.id
  rt.chatOwners.delete(first.id)
  rt.pastOwners.set(first.id,{botId:bot.id})
  rt.chatOwners.set(successor.id,bot.id)
  event(other,'turn/start',{turn:1})
  event(other,'user/message',{source:{resume:true,flybotPrivateReply:handoffId}})
  event(other,'assistant/message',{turn:1,text:'unrelated private chat'})
  event(other,'turn/end',{turn:1})
  event(successor,'turn/start',{turn:1})
  event(successor,'user/message',{source:{resume:true,flybotPrivateReply:'another-request'}})
  event(successor,'assistant/message',{turn:1,text:'unrelated native handoff'})
  event(successor,'turn/end',{turn:1})
  event(successor,'turn/start',{turn:2})
  event(successor,'user/message',{source:{resume:true,flybotPrivateReply:handoffId}})
  event(successor,'assistant/message',{turn:2,text:'Final answer'})
  event(successor,'turn/end',{turn:2,turnId:'native-final'})
  assert.deepEqual(await reply,{text:'Opening\n\nFinal answer',sessionId:successor.id,turnId:'native-final'})
  assert.equal(log.length,1)
})

test('native reply progress matches the admitted request, session, turn and attempt', async () => {
  const {rt, ctx, log} = fakeRuntime()
  const session = {id:'chat1'}
  const earlier = {id:'chat1'}
  const other = {id:'chat2'}
  const agent = {id:session.id, session}
  const progress = []
  const phases = []
  rt.sendUser = async request => { log.push(request) }
  const result = runTurn(rt, ctx, 'bot1', 'read this', 'own-rpc', 1000, [{type:'file', receiptId:'file1'}], {
    onProgress: value => progress.push(value),
    onPhase: value => phases.push(value),
  })
  const event = (type, data, subject = session) => ctx.emit('session/event', subject, {type, data})
  let revision = 0
  const stream = (type, payload, subject = agent) => ctx.emit('agent/assistant-stream', {
    agent: subject, frame: {type, revision: ++revision, ...payload},
  })
  const delta = (attemptId, text, type = 'text-delta', subject) => stream('chunk', {attemptId,chunk:{type,text}}, subject)
  assert.deepEqual(log[0].content, [{type:'text',text:'read this'}, {type:'file',receiptId:'file1'}])

  event('turn/start', {turn:5})
  event('user/message', {source:{rpcId:'wrong-rpc'}})
  event('user/message', {source:{rpcId:'own-rpc'}}, other)
  stream('start', {attemptId:'before-echo',turn:5,step:1})
  delta('before-echo', 'unrelated input')
  event('user/message', {source:{rpcId:'own-rpc'}})
  stream('start', {attemptId:'wrong-turn',turn:4,step:1})
  delta('wrong-turn', 'unrelated turn')
  rt.state.exchangeTurns = {chat1:[5]}
  stream('start', {attemptId:'hidden',turn:5,step:1})
  delta('hidden', 'hidden exchange text')
  rt.state.exchangeTurns = {}
  stream('start', {attemptId:'first',turn:5,step:1})
  delta('first', 'unrelated session', 'text-delta', {id:other.id,session:other})
  delta('first', 'replaced native session', 'text-delta', {id:earlier.id,session:earlier})
  delta('first', 'private reasoning', 'reasoning-delta')
  delta('first', 'private tool input', 'tool-call-delta')
  assert.deepEqual(progress, [])
  assert.deepEqual(phases, ['thinking'])

  delta('first', 'draft to discard')
  assert.deepEqual(progress, ['draft to discard'])
  assert.deepEqual(phases, ['thinking','writing'])
  event('assistant/attempt', {turn:5,step:1})
  stream('end', {attemptId:'first',outcome:{kind:'committed',eventType:'assistant/attempt',seq:12}})
  delta(undefined, 'unidentified late stream data')
  event('llm/retry-started', {turn:5,step:1})
  assert.deepEqual(progress, ['draft to discard', ''])
  assert.equal(phases.at(-1), 'thinking')

  stream('start', {attemptId:'retry',turn:5,step:1})
  event('turn/start', {turn:4})
  delta('first', 'late bytes from discarded attempt')
  delta('retry', 'Now ')
  delta('retry', 'visible')
  await delay(70)
  assert.deepEqual(progress, ['draft to discard', '', 'Now visible'])
  event('assistant/message', {turn:5,step:1,text:'Now visible'})
  stream('end', {attemptId:'retry',outcome:{kind:'committed',eventType:'assistant/message',seq:13}})
  stream('start', {attemptId:'next-step',turn:5,step:2})
  delta('next-step', 'next paragraph')
  await delay(70)
  assert.equal(progress.at(-1), 'Now visible\n\nnext paragraph')

  event('assistant/message', {turn:4,step:1,text:'wrong turn final'})
  event('assistant/message', {turn:5,step:2,text:'wrong session final'}, earlier)
  event('turn/end', {turn:4})
  event('assistant/message', {turn:5,step:2,text:'authoritative final paragraph'})
  stream('end', {attemptId:'next-step',outcome:{kind:'committed',eventType:'assistant/message',seq:14}})
  event('turn/end', {turn:5,turnId:'native-turn-id'})
  assert.deepEqual(await result, {text:'Now visible\n\nauthoritative final paragraph', sessionId:'chat1', turnId:'native-turn-id'})
  assert.equal(ctx.listenerCount('session/event'), 0)
  assert.equal(ctx.listenerCount('agent/assistant-stream'), 0)
  assert.equal(ctx.listenerCount('agent/disposed'), 0)
})

test('native progress clears on replacement and remains bounded without changing the final reply', async () => {
  const {rt, ctx} = fakeRuntime()
  rt.sendUser = async () => {}
  const progress = []
  const reply = runTurn(rt, ctx, 'bot1', 'hello', 'request', 1000, [], {onProgress(text) {
    progress.push(text)
    if (text) throw new Error('A progress consumer cannot fail the turn')
  }})
  const start = session => {
    ctx.emit('session/event', session, {type:'turn/start', data:{turn:1}})
    ctx.emit('session/event', session, {type:'user/message', data:{source:{rpcId:'request'}}})
    const agent = {id:'chat1', session}
    ctx.emit('agent/assistant-stream', {agent, frame:{type:'start', attemptId:'chat1:1', revision:1, turn:1, step:1}})
    return agent
  }
  const chunk = (agent, text, revision = 2) => ctx.emit('agent/assistant-stream', {
    agent, frame:{type:'chunk', attemptId:'chat1:1', revision, chunk:{type:'text-delta',text}},
  })
  const first = start({id:'chat1'})
  chunk(first, 'interrupted partial')
  assert.deepEqual(progress, ['interrupted partial'])
  ctx.emit('agent/disposed', {agent:first})
  assert.deepEqual(progress, ['interrupted partial', ''])
  const newSession = {id:'chat1'}
  const second = start(newSession)
  chunk(first, 'late text from the old agent', 3)
  const long = '界'.repeat(22_000)
  chunk(second, long)
  await delay(70)
  assert.equal(progress.at(-1), long.slice(0,20_000))
  ctx.emit('session/event', newSession, {type:'assistant/message', data:{turn:1,step:1,text:long}})
  ctx.emit('session/event', newSession, {type:'turn/end', data:{turn:1}})
  assert.equal((await reply).text, long)
  assert.equal(ctx.listenerCount('agent/assistant-stream'), 0)
})

test('native stream listeners and pending progress are removed on rejection or timeout', async () => {
  const {rt, ctx} = fakeRuntime()
  rt.sendUser = () => { throw new Error('send refused') }
  const progress = []
  const options = {onProgress(value) {
    progress.push(value)
    return Promise.reject(new Error('isolated progress consumer'))
  }}
  await assert.rejects(runTurn(rt, ctx, 'bot1', 'hello', 'request', 100, [], options), /send refused/)
  rt.sendUser = async () => {}
  const attempt = runTurn(rt, ctx, 'bot1', 'hello', 'request', 20, [], options)
  const session = {id:'chat1'}
  const agent = {id:session.id, session}
  ctx.emit('session/event', session, {type:'turn/start', data:{turn:1}})
  ctx.emit('session/event', session, {type:'user/message', data:{source:{rpcId:'request'}}})
  ctx.emit('agent/assistant-stream', {agent, frame:{type:'start', attemptId:'a1', revision:1, turn:1, step:1}})
  ctx.emit('agent/assistant-stream', {agent, frame:{type:'chunk', attemptId:'a1', revision:2, chunk:{type:'text-delta',text:'visible'}}})
  ctx.emit('agent/assistant-stream', {agent, frame:{type:'chunk', attemptId:'a1', revision:3, chunk:{type:'text-delta',text:'pending'}}})
  await assert.rejects(attempt, /timed out/)
  assert.equal(ctx.listenerCount('session/event'), 0)
  assert.equal(ctx.listenerCount('agent/assistant-stream'), 0)
  assert.equal(ctx.listenerCount('agent/disposed'), 0)
  await delay(60)
  assert.deepEqual(progress, ['visible'])
})

test('separate conversations use separate native DS-Bot threads and reuse persisted mapping', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ot-chats-'))
  const fake = fakeRuntime()
  const bot = fake.rt.botOf('bot1')
  let created = 0
  fake.rt.chatOf = () => bot.sessionId || bot.id
  fake.rt.createSession = async () => 'session-' + (++created)
  fake.rt.workDirOf = () => '/data/workspace'
  fake.rt.chatOwners = new Map()
  fake.rt.save = async () => {}
  fake.rt.applyModel = async () => {}
  fake.rt.applyPermission = async () => {}
  fake.rt.switchPart = async () => { assert.fail('selecting a private chat must not switch the foreground') }
  const bridge = createBridge(fake.rt, { env: { DSH_HOME: home }, port: 1 })
  fake.bind(bridge.state)
  try {
    await bridge.setup()
    const foreground = fake.rt.chatOf('bot1')
    const a = await bridge.selectConversation('conv-a')
    const b = await bridge.selectConversation('conv-b')
    assert.notEqual(a,b)
    assert.equal(await bridge.selectConversation('conv-a'),a)
    assert.deepEqual(bot.openParts.map(part=>part.sessionId),[a,b])
    const restarted = createBridge(fake.rt, { env: { DSH_HOME: home }, port: 1 })
    fake.bind(restarted.state)
    await restarted.setup()
    assert.equal(await restarted.selectConversation('conv-a'),a)
    assert.equal(await restarted.selectConversation('conv-b'),b)
    assert.equal(fake.rt.chatOf('bot1'),foreground)
    assert.equal(created, 2)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('B4: the account model override from @flybot-workspace/web wins, failures fall back to none', () => {
  const scope = {}
  assert.equal(userModelOverride(scope), null)
  scope[MODEL_OVERRIDE] = () => ({ provider: 'openai', base_url: 'https://models.example/v1', model: 'm', api_key: 'k'.repeat(12), source: 'user' })
  assert.equal(userModelOverride(scope).source, 'user')
  scope[MODEL_OVERRIDE] = () => { throw new Error('sealed value is corrupt') }
  assert.equal(userModelOverride(scope), null)
  scope[MODEL_OVERRIDE] = () => null
  assert.equal(userModelOverride(scope), null)
})

test('a held native turn does not delay another Bot, and keeps its own part protected', {timeout: 2000}, async () => {
  const {rt, ctx, log} = fakeRuntime()
  const bridge = createBridge(rt, {port:1})
  const started = Promise.withResolvers()
  const slowReply = Promise.withResolvers()
  rt.chatOf = botId => botId === 'main-bot' ? 'automation-session' : 'private-session'
  rt.sendUser = async ({sessionId, requestId}) => {
    log.push(requestId)
    const session = {id:sessionId}
    ctx.emit('session/event', session, {type:'turn/start', data:{turn:1}})
    ctx.emit('session/event', session, {type:'user/message', data:{source:{rpcId:requestId}}})
    if (requestId === 'automation-run') {
      started.resolve()
      await slowReply.promise
    }
    ctx.emit('session/event', session, {type:'assistant/message', data:{text:'reply for ' + sessionId}})
    ctx.emit('session/event', session, {type:'turn/end', data:{turn:1}})
  }
  const turn = (botId, requestId) => bridge.exclusive(() => runTurn(rt, ctx, botId, 'controlled input', requestId, 500), botId)
  const automation = turn('main-bot','automation-run')
  try {
    await started.promise
    const previousPart = turn('main-bot','main-bot-followup')
    const privateChat = await turn('personal-bot','private-send')
    assert.equal(privateChat.text,'reply for private-session')
    assert.deepEqual(log,['automation-run','private-send'])
    slowReply.resolve()
    assert.equal((await automation).text,'reply for automation-session')
    assert.equal((await previousPart).text,'reply for automation-session')
    assert.deepEqual(log,['automation-run','private-send','main-bot-followup'])
  } finally {
    slowReply.resolve()
  }
})

test('a roster-wide change fences current and later Bot work even if a turn fails', {timeout: 2000}, async () => {
  const bridge = createBridge(fakeRuntime().rt, {port:1})
  const running = Promise.withResolvers()
  const turn = Promise.withResolvers()
  const adopt = Promise.withResolvers()
  const started = Promise.withResolvers()
  const first = bridge.exclusive(() => { running.resolve(); return turn.promise },'main-bot')
  await running.promise
  const failed = assert.rejects(first, /fixture failure/)
  const migration = bridge.exclusive(() => { started.resolve(); return adopt.promise })
  let otherStarted = false
  const later = bridge.exclusive(() => { otherStarted = true },'personal-bot')
  try {
    await delay(0)
    assert.equal(otherStarted,false)
    turn.reject(new Error('fixture failure'))
    await failed
    await started.promise
    await delay(0)
    assert.equal(otherStarted,false)
    adopt.resolve()
    await migration
    await later
    assert.equal(otherStarted,true)
  } finally {
    turn.resolve()
    adopt.resolve()
  }
})

test('parallel native preparations apply a changed provider capability once', async () => {
  const fake = fakeRuntime()
  const bridge = createBridge(fake.rt, {port:1})
  fake.bind(bridge.state)
  let model = 'text-only'
  bridge.state.startupModel = () => ({model})
  const updates = []
  fake.rt.saveProviderModels = async ({models}) => { updates.push(models[0].input) }
  await bridge.prepareModel()
  model = 'DeepSeek-V4.1-Flash-1017'
  await Promise.all([bridge.prepareModel(), bridge.prepareModel()])
  assert.deepEqual(updates,[['text','image']])
})

test('isolated text-only requests stream answer text without tools, history, or reasoning', async () => {
  const seen = []
  const server = createBridgeServer(
    {token:'synthetic', startupModel:() => ({model:'fixture'})},
    {forward:async (_model, raw, response) => {
      const request = JSON.parse(String(raw))
      seen.push(request)
      if (!request.stream) {
        response.writeHead(200, {'content-type':'application/json'})
        response.end(JSON.stringify({choices:[{message:{content:'JSON result'}}]}))
        return
      }
      response.writeHead(200, {'content-type':'text/event-stream'})
      response.write(': comment\r\ndata: {"choices":[{"delta":{"reasoning_content":"private thought"}}]}\r\n\r\n')
      const bytes = Buffer.from('data: {"choices":[{"delta":{"content":"🌿 Plan"}}]}\r\n\r\n')
      const pivot = bytes.indexOf(0xf0) + 2
      response.write(bytes.subarray(0,pivot))
      await delay(5)
      response.write(bytes.subarray(pivot))
      if (request.messages.at(-1).content === 'incomplete') { response.end(); return }
      response.end('data: {"choices":[{"delta":{"content":" approved"}}]}\n\n' +
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n')
    }},
  )
  const port = await listen(server)
  const bridge = {baseURL:'http://127.0.0.1:'+port+'/v1',state:{token:'synthetic'},async setup() {}}
  try {
    const snapshots = []
    assert.equal(await textOnlyCompletion(bridge,'file excerpt',{system:'Member agent',onProgress:text=>snapshots.push(text)}),'🌿 Plan approved')
    assert.deepEqual(snapshots,['🌿 Plan','🌿 Plan approved'])
    assert.deepEqual(seen[0],{model:MODEL_ID,stream:true,messages:[
      {role:'system',content:'Member agent'},{role:'user',content:'file excerpt'},
    ]})
    assert.equal(await textOnlyCompletion(bridge,'summary'),'JSON result')
    await assert.rejects(textOnlyCompletion(bridge,'incomplete',{onProgress() {}}),/ended early/)
  } finally { await close(server) }
})
