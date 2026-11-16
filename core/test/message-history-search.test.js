// All data is isolated in memory. No persistence directory, running instance or user data.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { install, SEARCH_LIMITS } from '../src/host/message-search.js'
import { install as installChannel } from '../src/host/channel.js'
import { install as installAuthz } from '../src/host/authz.js'
const alice = { memberId: 'alice' }, bob = { memberId: 'bob' }
const message = (seq, text, kind = 'user', extra = {}) => ({ seq, time: seq, type: kind === 'assistant' ? 'assistant/message' : 'user/message', surfaceOp: 'append',
  data: kind === 'assistant' ? { turn: 0, message: { role: 'assistant', content: [{ type: 'text', text }] } } : { source: { kind: 'user' }, content: [{ type: 'text', text }], turn: 0 }, ...extra })
function fixture({ logs = {}, bots, observe, dispose } = {}) {
  const state = { bots: bots ?? { a: { id: 'a', ownerId: 'alice', sessionId: 'a-live', segments: [{ sessionId: 'a-old' }] }, b: { id: 'b', ownerId: 'bob', sessionId: 'b-live' }, remote: { id: 'remote', ownerId: 'alice', remote: {}, sessionId: 'remote-live' } }, rooms: { room: { id: 'room', sessions: { a: 'internal-group' } } }, authSessions: { t: {} }, members: { alice: {}, bob: {} }, exchangeTurns: {} }
  const reads = [], disposed = []
  const provider = { async observeSession(id, opts) {
    assert.equal(opts.projectionMode, 'none')
    assert.ok(opts.signal instanceof AbortSignal)
    reads.push(id)
    if (observe) await observe(id)
    const events = logs[id] ?? []
    return { header: { id }, events, cursor: events.at(-1)?.seq ?? -1, [Symbol.dispose]: () => { disposed.push(id); dispose?.(id) } }
  }, searchEvents() { throw Error('must not build/write the native index') }, listSessions() { throw Error('must not enumerate another instance') } }
  const forbidden = () => { throw Error('must never activate, write, save, flush or list') }
  const rt = { state, ctx: { get: key => { assert.equal(key, 'sessionQuery'); return provider }, sessionController: { list: forbidden, resolveAgent: forbidden, page: forbidden } },
    save: forbidden, load: forbidden, resolveAgent: forbidden,
    partsOf: id => [...(state.bots[id]?.segments ?? []), ...(state.bots[id] ? [{ sessionId: state.bots[id].sessionId ?? id }] : [])],
    chatOf: id => state.bots[id]?.sessionId ?? id,
    botOf: id => Object.values(state.bots).find(bot => bot.id === id || bot.sessionId === id || bot.segments?.some(part => part.sessionId === id)),
  }
  installAuthz(rt); install(rt)
  return { rt, state, reads, disposed, provider, search: (body, actor = alice) => rt.searchMessages(body, actor) }
}

test('finds Chinese history in unloaded current and archived parts, without touching foreign sessions or writing', async () => {
  const f = fixture({ logs: { 'a-live': [message(1, '现在的中文计划')], 'a-old': [message(1, '从未加载的中文历史', 'assistant')], 'b-live': [message(1, '别人的中文')] } })
  const before = JSON.stringify(f.state)
  const result = await f.search({ query: '中文' })
  assert.equal(result.items.length, 2)
  assert.deepEqual(result.items.map(hit => hit.sessionId), ['a-live', 'a-old'])
  assert.equal(result.items[1].earlier, true)
  assert.equal(result.scope, 'local-bot-chats')
  assert.equal(result.cursor, null)
  assert.equal(JSON.stringify(f.state), before)
  assert.deepEqual(f.reads, f.disposed)
})

test('one-character Chinese, Unicode width/case, and FTS/regex metacharacters are literal', async () => {
  const f = fixture({ logs: { 'a-live': [message(1, '甲 ＡＢＣ %_*[x]')] } })
  for (const query of ['甲', 'abc', '%_*[x]']) assert.equal((await f.search({ query })).items.length, 1)
  assert.equal((await f.search({ query: '" OR *' })).items.length, 0)
})

test('empty, invalid and oversized queries never read logs; caller selectors/actor ids grant nothing', async () => {
  const f = fixture()
  assert.deepEqual((await f.search({ query: ' \n\t' })).items, [])
  for (const body of [{query:1},{query:'x'.repeat(257)},{query:'x\0'}, {query:'x',limit:0},{query:'x',limit:51},{query:'x',limit:1.5},{query:'x',sessionId:'b-live'},{query:'x',home:'/other'},{query:'x',actorId:'bob'}]) {
    await assert.rejects(f.search(body), {code:'bot/invalid'})
  }
  assert.deepEqual(f.reads, [])
})

test('only append-origin human/assistant text is searched, including pre-compaction transcript; never tools or model replacement copies', async () => {
  const f = fixture({logs:{'a-live':[
    message(1,'needle old human transcript'),
    message(2,'needle replacement','user',{surfaceOp:{from:1,to:1}}),
    message(3,'needle plugin user','user',{data:{source:{kind:'ds-bot'},content:[{type:'text',text:'needle plugin user'}]}}),
    {seq:4,type:'tool/result',surfaceOp:'append',data:{message:{content:[{type:'text',text:'needle tool result'}]}}},
    message(5,'needle log-only','user',{surfaceOp:undefined}),
  ]}})
  const result=await f.search({query:'needle'})
  assert.deepEqual(result.items.map(hit=>hit.seq),[1])
})

test('exchange-hidden turns and unknown-turn messages in a hidden session fail closed', async () => {
  const hidden=message(1,'needle');const unknown=message(2,'needle');delete unknown.data.turn
  const f=fixture({logs:{'a-live':[hidden,unknown,message(3,'needle visible','assistant',{data:{turn:3,message:{content:[{type:'text',text:'needle visible'}]}}})]}})
  f.state.exchangeTurns['a-live']=[0]
  assert.deepEqual((await f.search({query:'needle'})).items.map(hit=>hit.seq),[3])
})

test('pagination is bounded, no duplicates, and opaque cursors are query/actor/instance bound', async () => {
  const f=fixture({logs:{'a-live':Array.from({length:5},(_,i)=>message(i,'needle '+i))}})
  const first=await f.search({query:'needle',limit:2})
  assert.ok(first.cursor)
  for (const [query,actor] of [['different',alice],['needle',bob]]) await assert.rejects(f.search({query,cursor:first.cursor},actor),{code:'bot/invalid'})
  await assert.rejects(fixture().search({query:'needle',cursor:first.cursor}),{code:'bot/invalid'})
  await assert.rejects(f.search({query:'needle',cursor:'../../secret'}),{code:'bot/invalid'})
  const next=await f.search({query:'needle',limit:2,cursor:first.cursor})
  const last=await f.search({query:'needle',limit:2,cursor:next.cursor})
  assert.deepEqual([...first.items,...next.items,...last.items].map(hit=>hit.seq),[4,3,2,1,0])
  assert.equal(last.cursor,null)
})

test('authorization denies anonymous in member mode, narrows owners, excludes group/internal/remote sessions', async () => {
  const f=fixture({logs:{'b-live':[message(1,'needle')]}})
  assert.equal(f.rt.authorize(null,'search-messages',{}).code,'bot/unauthorized')
  await assert.rejects(f.search({query:'needle'},null),{code:'bot/unauthorized'})
  assert.equal(f.rt.authorize(alice,'search-messages',{}).ok,true)
  await f.search({query:'needle'})
  assert.deepEqual(f.reads,['a-live','a-old'])
  f.reads.length=0
  assert.equal((await f.search({query:'needle'},bob)).items.length,1)
  assert.deepEqual(f.reads,['b-live'])
})

test('revocation during awaits prevents delivery and subsequent pages recheck ownership', async () => {
  let f
  f=fixture({logs:{'a-live':[message(1,'needle')]},observe:async id=>{if(id==='a-live') f.state.bots.a.ownerId='bob'}})
  assert.deepEqual((await f.search({query:'needle'})).items,[])
  assert.deepEqual(f.reads,['a-live'])
})

test('backend failures are sanitized and explicitly incomplete, never a false exhaustive empty', async () => {
  const f=fixture({observe:async()=>{throw Error('/other-instance/config API_KEY=NEVER_RETURN')}})
  const result=await f.search({query:'needle'})
  assert.equal(result.incomplete,true)
  assert.equal(JSON.stringify(result).includes('API_KEY'),false)
  f.rt.ctx.get=()=>undefined
  await assert.rejects(f.search({query:'needle'}),{code:'bot/search-unavailable'})
})

test('continuation detects changed history and expired cursors', async () => {
  const logs={'a-live':[message(0,'needle'),message(1,'needle')]}
  const f=fixture({logs})
  const first=await f.search({query:'needle',limit:1})
  logs['a-live'].push(message(2,'needle'))
  await assert.rejects(f.search({query:'needle',cursor:first.cursor}),{code:'bot/invalid'})
  const now=Date.now
  Date.now=()=>now()+SEARCH_LIMITS.ttl+1
  try {await assert.rejects(f.search({query:'needle',cursor:first.cursor}),{code:'bot/invalid'})} finally {Date.now=now}
})

test('per-request source reads are capped even when all histories fail; oversized source is explicitly limited', async () => {
  const bots=Object.fromEntries(Array.from({length:20},(_,i)=>['a'+i,{id:'a'+i,ownerId:'alice'}]))
  const f=fixture({bots,observe:async()=>{throw Error('bad history')}})
  const result=await f.search({query:'needle'})
  assert.equal(f.reads.length,SEARCH_LIMITS.pagesPerRequest)
  assert.ok(result.cursor)
  assert.equal(result.incomplete,true)
  const big=fixture({logs:{'a-live':Array.from({length:SEARCH_LIMITS.sourceEvents+1},()=>message(0,'needle'))}})
  assert.equal((await big.search({query:'needle'})).limited,true)
})

test('legacy single-human mode stays instance-local and query never mutates a read-only runtime', async () => {
  const f=fixture({logs:{'a-old':[message(0,'needle')]}})
  f.state.authSessions={}; f.rt.readOnly=()=> 'read-only host'
  assert.equal((await f.search({query:'needle'},null)).items.length,1)
  assert.equal(f.reads.some(id=>id==='remote-live'||id==='internal-group'),false)
})


test('real /api/bot channel allows read-only search, authenticates from the header, and rejects forged payload authority', async () => {
  const f=fixture({logs:{'a-old':[message(0,'历史 needle')]}})
  let route
  f.rt.ctx.effect=run=>run()
  f.rt.ctx.connection={fetch:{register:value=>{route=value;return ()=>{}}}}
  f.rt.refresh=async()=>{}
  f.rt.load=async()=>{} // installation only; search itself never calls the loader
  f.rt.readOnly=()=> 'another window owns the writer'
  f.rt.authenticate=async token=>token==='alice-token'?alice:token==='bob-token'?bob:null
  f.rt.noteFailure=()=>{throw Error('unexpected internal failure')}
  installChannel(f.rt)
  const call=async(token,payload,endpoint='search-messages')=> (await route.fetch(new Request('http://fixture.invalid/api/bot',{method:'POST',headers:token?{'x-flybot-member-session':token}:{},body:JSON.stringify({endpoint,payload})}))).json()
  const result=await call('alice-token',{query:'历史'})
  assert.equal(result.ok,true)
  assert.equal(result.value.items[0].sessionId,'a-old')
  const context=await call('alice-token',{hitToken:result.value.items[0].hitToken},'history-hit')
  assert.equal(context.ok,true)
  assert.equal(context.value.sessionId,'a-old')
  assert.equal((await call('bob-token',{hitToken:result.value.items[0].hitToken},'history-hit')).error.code,'bot/history-unavailable')
  assert.equal((await call(null,{hitToken:result.value.items[0].hitToken},'history-hit')).error.code,'bot/unauthorized')
  assert.equal((await call(null,{query:'历史'})).error.code,'bot/unauthorized')
  assert.equal((await call('bob-token',{query:'历史'})).value.items.length,0)
  assert.equal((await call('alice-token',{query:'历史',actorId:'bob'})).error.code,'bot/invalid')
})

test('per-owner concurrent work is refused and released, without blocking another owner', async () => {
  let release
  const held=new Promise(resolve=>{release=resolve})
  const f=fixture({observe:async id=>{if(id==='a-live')await held}})
  const pending=f.search({query:'needle'})
  await assert.rejects(f.search({query:'needle'}),{code:'bot/search-unavailable'})
  await f.search({query:'needle'},bob)
  release();await pending
  await f.search({query:'needle'})
})

test('read-only hit returns its exact earlier segment and original bounded context, never opens an Agent', async () => {
  const f=fixture({logs:{'a-old':[message(0,'before'),message(1,'原始 ＡＢＣ 命中'),message(2,'after','assistant')]}})
  const hit=(await f.search({query:'abc'})).items[0]
  const view=await f.rt.readHistoryHit({hitToken:hit.hitToken},alice)
  assert.equal(view.scope,'read-only-history');assert.equal(view.sessionId,'a-old');assert.equal(view.part,1);assert.equal(view.partCount,2)
  assert.deepEqual(view.entries.map(entry=>entry.text),['before','原始 ＡＢＣ 命中','after'])
  assert.equal(view.entries[1].hit,true)
  assert.deepEqual(f.reads,['a-live','a-old','a-old'])
  assert.deepEqual(f.reads,f.disposed)
})

test('context tickets reject foreign actor, other instance, selectors and expiration before reading', async () => {
  const f=fixture({logs:{'a-live':[message(0,'needle')]}})
  const hit=(await f.search({query:'needle'})).items[0], body={hitToken:hit.hitToken}
  f.reads.length=0
  for(const [payload,actor] of [[body,bob],[{...body,sessionId:'b-live'},alice],[{hitToken:'../config'},alice]]) {
    await assert.rejects(f.rt.readHistoryHit(payload,actor),{code:'bot/history-unavailable'})
  }
  await assert.rejects(fixture().rt.readHistoryHit(body,alice),{code:'bot/history-unavailable'})
  assert.deepEqual(f.reads,[])
  const now=Date.now;Date.now=()=>now()+SEARCH_LIMITS.ttl+1
  try {await assert.rejects(f.rt.readHistoryHit(body,alice),{code:'bot/history-unavailable'})} finally {Date.now=now}
})

test('stale hits reject appended or modified history, deleted Bot/session, removed segment and newly hidden turns',async()=>{
 for(const change of ['append','modify','bot-delete','session-delete','segment-remove','hidden']){
  const logs={'a-old':[message(0,'needle')]};const f=fixture({logs})
  const hit=(await f.search({query:'needle'})).items[0]
  if(change==='append')logs['a-old'].push(message(1,'new'))
  if(change==='modify')logs['a-old'][0].data.content[0].text='replaced same seq'
  if(change==='bot-delete')delete f.state.bots.a
  if(change==='session-delete')delete logs['a-old']
  if(change==='segment-remove')f.state.bots.a.segments=[]
  if(change==='hidden')f.state.exchangeTurns['a-old']=[0]
  await assert.rejects(f.rt.readHistoryHit({hitToken:hit.hitToken},alice),{code:'bot/history-unavailable'},change)
 }
})

test('revocation or deletion during the context await, and revocation during dispose, prevent all delivery',async()=>{
 for(const change of ['owner','delete','dispose']){
  let checking=false,f
  f=fixture({logs:{'a-old':[message(0,'needle')]},observe:async()=>{
   if(checking&&change==='owner')f.state.bots.a.ownerId='bob'
   if(checking&&change==='delete')delete f.state.bots.a
  },dispose:()=>{if(checking&&change==='dispose')f.state.bots.a.ownerId='bob'}})
  const hit=(await f.search({query:'needle'})).items[0];checking=true
  await assert.rejects(f.rt.readHistoryHit({hitToken:hit.hitToken},alice),{code:'bot/history-unavailable'})
 }
})

test('pagination after ownership change skips revoked segments and old tickets cannot acquire context',async()=>{
 const f=fixture({bots:{a:{id:'a',ownerId:'alice',sessionId:'a-live',segments:[{sessionId:'a-old'}]},c:{id:'c',ownerId:'alice',sessionId:'c-live'}},logs:{'a-live':[message(0,'needle'),message(1,'needle')],'a-old':[message(0,'needle')],'c-live':[message(0,'needle c')]}})
 const first=await f.search({query:'needle',limit:1});assert.ok(first.cursor)
 f.state.bots.a.ownerId='bob';f.reads.length=0
 const next=await f.search({query:'needle',cursor:first.cursor})
 assert.deepEqual(next.items.map(hit=>hit.botId),['c'])
 assert.deepEqual(f.reads,['c-live'])
 await assert.rejects(f.rt.readHistoryHit({hitToken:first.items[0].hitToken},alice),{code:'bot/history-unavailable'})
})

test('result UTF-8 bytes are capped and pagination loses no hit at a byte boundary',async()=>{
 const id='分'.repeat(200), query='中'.repeat(256)
 const f=fixture({bots:{[id]:{id,ownerId:'alice',sessionId:id}},logs:{[id]:Array.from({length:50},(_,i)=>message(i,'前'.repeat(50)+query+'后'.repeat(100)))}})
 const first=await f.search({query,limit:50})
 assert.ok(Buffer.byteLength(JSON.stringify(first))<=SEARCH_LIMITS.resultBytes)
 assert.ok(first.cursor);assert.equal(first.limited,true)
 const next=await f.search({query,limit:50,cursor:first.cursor})
 assert.ok(Buffer.byteLength(JSON.stringify(next))<=SEARCH_LIMITS.resultBytes)
 assert.equal(new Set([...first.items,...next.items].map(hit=>hit.seq)).size,50)
 assert.equal(next.cursor,null)
})

test('scan/message bytes are executable limits, distinct from the unbounded native cold materialization',async()=>{
 const f=fixture({logs:{'a-live':Array.from({length:20},(_,i)=>message(i,'x'.repeat(150_000)+' needle'))}})
 const first=await f.search({query:'needle',limit:50})
 assert.ok(first.cursor);assert.equal(first.limited,true);assert.ok(first.items.length<20)
 const next=await f.search({query:'needle',limit:50,cursor:first.cursor})
 assert.equal(first.items.length+next.items.length,20)
 const large=fixture({logs:{'a-live':[message(0,'needle '+'x'.repeat(SEARCH_LIMITS.messageBytes))]}})
 const skipped=await large.search({query:'needle'})
 assert.equal(skipped.items.length,0);assert.equal(skipped.limited,true)
})

test('context enforces UTF-8 output cap, preserves original Unicode and excludes hidden/tool/plugin neighbors',async()=>{
 const logs={'a-old':[message(0,'😄'.repeat(10_000)),message(1,'😄'.repeat(10_000)+' needle 原文'),message(2,'😄'.repeat(10_000),'assistant'),message(3,'hidden','user',{data:{turn:3,source:{kind:'user'},content:[{type:'text',text:'NEVER-HIDDEN'}]}}),{seq:4,type:'tool/result',surfaceOp:'append',data:{content:[{type:'text',text:'NEVER-TOOL'}]}}]}
 const f=fixture({logs});f.state.exchangeTurns['a-old']=[3]
 const hit=(await f.search({query:'needle'})).items[0]
 const view=await f.rt.readHistoryHit({hitToken:hit.hitToken},alice)
 assert.ok(Buffer.byteLength(JSON.stringify(view))<=SEARCH_LIMITS.contextBytes)
 assert.ok(view.entries.some(entry=>entry.hit&&entry.text.includes('needle 原文')&&entry.truncated))
 assert.ok(view.entries.every(entry=>!entry.text.includes('\uFFFD') && entry.text.isWellFormed()))
 assert.equal(JSON.stringify(view).includes('NEVER'),false)
})

test('context cancellation propagates to the provider and shares search concurrency budget',async()=>{
 let checking=false,signalSeen,release,entered
 const started=new Promise(resolve=>{entered=resolve})
 const held=new Promise(resolve=>{release=resolve})
 const f=fixture({logs:{'a-live':[message(0,'needle')]}})
 const hit=(await f.search({query:'needle'})).items[0]
 const observe=f.provider.observeSession
 f.provider.observeSession=async(id,opts)=>{if(checking){signalSeen=opts.signal;entered();await held}return observe(id,opts)}
 checking=true
 const abort=new AbortController()
 const pending=f.rt.readHistoryHit({hitToken:hit.hitToken},alice,abort.signal)
 await started
 await assert.rejects(f.search({query:'needle'}),{code:'bot/search-unavailable'})
 abort.abort();release()
 await assert.rejects(pending,{code:'bot/history-unavailable'})
 assert.equal(signalSeen.aborted,true)
})

test('global concurrency and segment-count caps execute before unbounded corpus work',async()=>{
 let release,entered,count=0
 const held=new Promise(resolve=>{release=resolve}), started=new Promise(resolve=>{entered=resolve})
 const bots=Object.fromEntries(Array.from({length:5},(_,i)=>['a'+i,{id:'a'+i,ownerId:'owner'+i}]))
 const f=fixture({bots,observe:async()=>{if(++count===4)entered();await held}})
 const pending=Array.from({length:4},(_,i)=>f.search({query:'needle'},{memberId:'owner'+i}))
 await started
 await assert.rejects(f.search({query:'needle'},{memberId:'owner4'}),{code:'bot/search-unavailable'})
 release();await Promise.all(pending)
 const many=fixture({bots:Object.fromEntries(Array.from({length:SEARCH_LIMITS.sessions+1},(_,i)=>['b'+i,{id:'b'+i,ownerId:'alice'}]))})
 const result=await many.search({query:'needle'})
 assert.equal(result.limited,true);assert.equal(many.reads.length,SEARCH_LIMITS.pagesPerRequest)
})


test('JSON escaping is included in the context byte budget, not mistaken for raw UTF-8 length',async()=>{
 const text='\n\t\\"'.repeat(6000)
 const f=fixture({logs:{'a-live':[message(0,text),message(1,text+'needle'+text),message(2,text,'assistant')]}})
 const hit=(await f.search({query:'needle'})).items[0]
 const view=await f.rt.readHistoryHit({hitToken:hit.hitToken},alice)
 assert.ok(view.entries.some(entry=>entry.hit&&entry.text.includes('needle')&&entry.truncated))
 assert.ok(Buffer.byteLength(JSON.stringify(view))<=SEARCH_LIMITS.contextBytes)
})
