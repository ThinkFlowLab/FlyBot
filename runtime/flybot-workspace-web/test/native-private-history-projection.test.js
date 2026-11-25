import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {DatabaseSync} from 'node:sqlite'
import test from 'node:test'
import {createAgents} from '../features/agents/index.js'

const workspace = 'a'.repeat(32), foreignWorkspace = 'b'.repeat(32)
const agentId = '1'.repeat(32), foreignAgent = '2'.repeat(32)
const conversationId = '3'.repeat(32), foreignConversation = '4'.repeat(32)
const args = {workspace_id:workspace,id:agentId,conversation_id:conversationId}
const tick = () => new Promise(resolve => setImmediate(resolve))

const input = (text, source = {kind:'user',rpcId:'native-request'}) => ({type:'user/message',surfaceOp:'append',data:{source,
  content:typeof text === 'string' ? [{type:'text',text}] : text}})
const output = text => ({type:'assistant/message',surfaceOp:'append',data:{message:{source:{kind:'model'},content:
  typeof text === 'string' ? [{type:'text',text}] : text}}})

function fixture(t, {recovery = false} = {}) {
  const db = new DatabaseSync(':memory:')
  t.after(() => db.close())
  const bus = new EventEmitter()
  const bots = {local:{id:'local',sessionId:'part-1',flybotWorkspace:{agent_id:agentId,workspace_id:workspace}},
    other:{id:'other',sessionId:'outside',flybotWorkspace:{agent_id:foreignAgent,workspace_id:foreignWorkspace}},
    nativeOnly:{id:'nativeOnly',sessionId:'unmapped'}}
  const rt = {chatOwners:new Map([['part-1','local'],['outside','other'],['unmapped','nativeOnly']]), pastOwners:new Map(),botOf:id=>bots[id]}
  const sessions = new Map()
  rt.resolveAgent = async () => assert.fail('History recovery must not start a native agent')
  let flushes = 0, blocked = null
  const ctx = {on:bus.on.bind(bus),sessions:{async flush() {flushes++; if (blocked) await blocked}}}
  let lookups = 0
  if (recovery) ctx.sessions.get = id => {
    lookups++
    return sessions.get(id)
  }
  const service = {rt,ctx,nativeTurn:() => assert.fail('committed native events must never rerun a model'),
    prepareMappedChat:() => assert.fail('history must not change the chosen model')}
  const host = {currentRuntime:() => service,runtime:async () => service,call:async () => null}
  const {endpoints,attachHistory} = createAgents({db,host})
  async function seed({listen = true} = {}) {
    await endpoints.import({agents:[{id:agentId,workspace_id:workspace,name:'Linked Bot'},
      {id:foreignAgent,workspace_id:foreignWorkspace,name:'Other linked Bot'}]})
    const mapObject = db.prepare('INSERT INTO native_agent_objects VALUES(?,?,?)')
    const mapSession = db.prepare('INSERT INTO native_agent_sessions VALUES(?,?,?)')
    const put = db.prepare('INSERT INTO agent_conversations(id,agent_id,title,created,updated) VALUES(?,?,?,?,?)')
    for (const [cid,agent,bot,sid] of [[conversationId,agentId,'local','part-1'],[foreignConversation,foreignAgent,'other','outside']]) {
      put.run(cid,agent,'Saved conversation',1,1)
      mapObject.run(agent,bot,bots[bot].flybotWorkspace.agent_id === agentId ? 'Linked Bot' : 'Other linked Bot')
      mapSession.run(`agent:${agent}:${cid}`,agent,sid)
    }
    if (listen) attachHistory(service)
  }
  function session(id) {
    const events = []
    const native = {id,get seq() { return events.length },eventAt:seq=>events[seq]}
    sessions.set(id,native)
    return {native, filler(count) {
      for (let i = 0; i < count; i++) events.push({type:'session/title',seq:events.length})
    },turn(content, {end = {},time = 1_800_000_000_000} = {}) {
      const turn = events.length + 1
      const frames = [{type:'turn/start',data:{}},...content,{type:'turn/end',data:{reason:{kind:'completed'},...end}}]
      let last
      for (const frame of frames) {
        last = {...frame,data:{turn,...frame.data},seq:events.length,time:time+events.length}
        events.push(last)
        bus.emit('session/event',native,last)
      }
      return () => bus.emit('session/event',native,last)
    }}
  }
  return {ctx,db,rt,bots,endpoints,seed,session,attach:() => attachHistory(service),
    lookups:() => lookups,flushes:() => flushes,block:promise=>{blocked=promise}}
}

test('a committed native conversation appears in the exact existing Web history and deduplicates a replay', async t => {
  const f = fixture(t)
  await f.seed()
  const flush = Promise.withResolvers()
  f.block(flush.promise)
  const replay = f.session('part-1').turn([input('Plain native browser user text'),output('Intermediate assistant text'),
    {type:'tool/result',data:{result:'not written to the transcript'}},
    input('Private injected workspace instructions',{kind:'agent-instructions',form:'instructions'}),
    output([{type:'reasoning',text:'private reasoning'},{type:'text',text:'Native final text'}])])
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM agent_messages').get().n,0)
  const loaded = f.endpoints.openConversation(args)
  flush.resolve()
  const opened = await loaded
  assert.deepEqual(opened.items.map(({role,text,status})=>[role,text,status]),[
    ['user','Plain native browser user text','sent'],['assistant','Native final text','succeeded'],
  ])
  assert.equal(opened.conversation.native_session_id,'part-1')
  assert.equal(opened.conversation.updated,1_800_000_000)
  const ids = opened.items.map(item=>item.id)
  const api = await f.endpoints.v1({method:'GET',path:`/v1/workspaces/${workspace}/agents/${agentId}/conversations/${conversationId}`})
  assert.deepEqual(api.body.items.map(({id,body})=>[id,body]),[[ids[0],'Plain native browser user text'],[ids[1],'Native final text']])
  assert.equal((await f.endpoints.v1({method:'GET',path:`/v1/workspaces/${foreignWorkspace}/agents/${agentId}/conversations/${conversationId}`})).status,404)
  assert.deepEqual(f.db.prepare('SELECT session_id,event_seq,source FROM native_agent_events ORDER BY event_seq').all()
    .map(row=>[row.session_id,row.event_seq,row.source]),[['part-1',1,'native'],['part-1',5,'native']])
  replay()
  assert.deepEqual((await f.endpoints.openConversation(args)).items.map(item=>item.id),ids)
  assert.equal(f.flushes(),2)
})

test('the native projection excludes Web sends, history import, tools, unrelated Sessions and retired access', async t => {
  const f = fixture(t)
  await f.seed()
  const session = f.session('part-1')
  session.turn([input('Wrapped Web input',{kind:'user',rpcId:'ot-agent:existing-web'}),output('Already displayed by Web')])
  session.turn([input('Imported old message',{kind:'user',imported:true}),output('Already stored history')])
  session.turn([input('Internal release automation',{kind:'schedule'}),output('From an automation')])
  session.turn([input('Internal handoff text',{kind:'user',handoff:true}),output('Handoff thought')])
  session.turn([input([{type:'text',text:'Native image caption'},{type:'file'}]),output('Attachment result')])
  f.session('unmapped').turn([input('Unrelated native-only prompt'),output('Unrelated response')])
  f.bots.other.flybotWorkspace.workspace_id = workspace
  f.session('outside').turn([input('Stale wrong workspace'),output('Foreign response')])
  f.bots.other.flybotWorkspace.workspace_id = foreignWorkspace
  await tick()
  assert.equal(f.flushes(),0)

  session.turn([input('Tool request without completed answer',{kind:'user',rpcId:'native-tool-only'}),
    output([{type:'text',text:'A narrated tool step'},{type:'tool-call',name:'internal'}])])
  session.turn([input('Interrupted native input',{kind:'user',rpcId:'native-aborted'}),output('Aborted reply')],{end:{reason:{kind:'aborted'}}})
  session.turn([input('Native user alongside Web prompt',{kind:'user',rpcId:'native-mixed'}),
    input('Existing Web prompt',{kind:'user',rpcId:'ot-agent:already-known'}),output('Shared mixed answer')])
  const history = await f.endpoints.openConversation(args)
  assert.deepEqual(history.items.map(({role,text})=>[role,text]),[
    ['user','Tool request without completed answer'],['user','Interrupted native input'],['user','Native user alongside Web prompt'],
  ])
  const locked = Promise.withResolvers()
  f.block(locked.promise)
  session.turn([input('Queued before archive',{kind:'user',rpcId:'native-before-archive'}),output('Archive race result')])
  await f.endpoints.organizeConversation({...args,action:'archive'})
  locked.resolve()
  assert.equal((await f.endpoints.openConversation(args)).items.length,3)
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM agent_messages WHERE conversation_id=?').get(foreignConversation).n,0)
})

test('an owned moved part continues the same Web conversation and replays the exact request only once', async t => {
  const f = fixture(t)
  await f.seed()
  const first = f.session('part-1')
  const flushed = Promise.withResolvers()
  f.block(flushed.promise)
  first.turn([input('Before native part rollover'),output('Final before rollover')])
  f.bots.local.segments = [{sessionId:'part-1'}]
  f.bots.local.sessionId = 'part-2'
  f.rt.chatOwners.delete('part-1')
  f.rt.pastOwners.set('part-1',{botId:'local'})
  f.rt.chatOwners.set('part-2','local')
  flushed.resolve()
  const second = f.session('part-2')
  second.turn([input('Before native part rollover'),output('Duplicate rerun must not create history')])
  second.turn([input('Native continuation',{kind:'user',rpcId:'next-native-request'}),output('New continuation answer')])
  const {items,conversation} = await f.endpoints.openConversation(args)
  assert.equal(conversation.id,conversationId)
  assert.deepEqual(items.map(item=>item.text),['Before native part rollover','Final before rollover','Native continuation','New continuation answer'])
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM agent_conversations WHERE agent_id=?').get(agentId).n,1)
})

test('opening the exact private chat recovers its own resumed native turns without copying a fork seed', async t => {
  const f = fixture(t,{recovery:true})
  await f.seed({listen:false})
  const source = f.session('part-1')
  source.turn([input('Inherited private input'),output('Inherited reply')])
  source.native.inheritedEventCount = source.native.seq
  source.turn([input('Earlier committed native input',{kind:'user',rpcId:'persisted-native'}),output('Earlier committed native reply')])
  source.turn([input('Already rendered Web input',{kind:'user',rpcId:'ot-agent:rendered'}),output('Already rendered Web reply')])
  source.turn([input('Imported input',{kind:'user',imported:true}),output('Imported reply')])
  source.native.firstLiveSeq = source.native.seq
  f.db.prepare('INSERT INTO agent_messages VALUES (?,?,?,?,?,?,?)')
    .run('9'.repeat(32),conversationId,'assistant','Existing later Web reply','succeeded',1_800_000_001,'{}')
  f.attach()
  const path = `/v1/workspaces/${workspace}/agents/${agentId}/conversations/${conversationId}`
  const get = query => f.endpoints.v1({method:'GET',path:path+query})
  assert.equal((await get('?limit=50&snapshot=1')).body.items.length,1)
  assert.equal((await get(`?limit=10&around=${'9'.repeat(32)}`)).body.items.length,1)
  assert.equal(f.lookups(),0)
  const {body} = await get('?limit=50')
  assert.deepEqual(body.items.map(row=>row.body),['Earlier committed native input','Earlier committed native reply','Existing later Web reply'])
  assert.equal(body.conversation.native_session_id,'part-1')
  assert.equal(f.db.prepare('SELECT next_seq FROM native_agent_history_checkpoints').get().next_seq,source.native.seq)
  assert.equal(f.flushes(),1)
  assert.deepEqual((await get('?limit=50')).body.items.map(row=>row.id),body.items.map(row=>row.id))
  assert.equal(f.flushes(),1)
  assert.deepEqual(f.db.prepare('SELECT role,status,created FROM agent_messages WHERE conversation_id=? ORDER BY created,rowid').all(conversationId)
    .map(row=>[row.role,row.status,row.created]), [['user','sent',1_800_000_000],['assistant','succeeded',1_800_000_000],['assistant','succeeded',1_800_000_001]])
})

test('history recovery flushes before cursor commit and shares bounded work with concurrent opens and the live relay', async t => {
  const f = fixture(t,{recovery:true})
  await f.seed({listen:false})
  const native = f.session('part-1')
  native.filler(2046)
  native.turn([input('Exact request crossing the checkpoint',{kind:'user',rpcId:'durable-crossing'}),output('Durable answer')])
  native.native.firstLiveSeq = native.native.seq
  const blocked = Promise.withResolvers()
  f.block(blocked.promise)
  const first = f.endpoints.openConversation(args)
  const concurrent = f.endpoints.openConversation(args)
  while (!f.flushes()) await tick()
  assert.equal(f.lookups(),1)
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM native_agent_history_checkpoints').get().n,0)
  blocked.reject(new Error('simulated durability failure'))
  await Promise.all([first,concurrent])
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM native_agent_history_checkpoints').get().n,0)
  f.block(null)
  assert.equal((await f.endpoints.openConversation(args)).items.length,0)
  assert.equal(f.db.prepare('SELECT next_seq FROM native_agent_history_checkpoints').get().next_seq,2048)
  f.attach()
  native.turn([input('A live native request',{kind:'user',rpcId:'new-native'}),output('Live answer')],{time:1_800_000_002_000})
  const reopened = await f.endpoints.openConversation(args)
  assert.deepEqual(reopened.items.map(row=>row.text),['Exact request crossing the checkpoint','Durable answer','A live native request','Live answer'])
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM native_agent_events').get().n,4)
  assert.equal(f.db.prepare('SELECT next_seq FROM native_agent_history_checkpoints').get().next_seq,native.native.seq)
})

test('recovery refuses an archived conversation and keeps history on the same thread across a native rollover', async t => {
  const f = fixture(t,{recovery:true})
  await f.seed({listen:false})
  const first = f.session('part-1')
  first.turn([input('Saved owned part'),output('Saved owned answer')])
  const second = f.session('part-2')
  second.turn([input('Saved rollover input',{kind:'user',rpcId:'each-request-once'}),output('Saved rollover answer')],{time:1_800_000_001_000})
  f.bots.local.segments = [{sessionId:'part-1'}]
  f.bots.local.sessionId = 'part-2'
  f.rt.chatOwners.delete('part-1')
  f.rt.pastOwners.set('part-1',{botId:'local'})
  f.rt.chatOwners.set('part-2','local')
  const blocked = Promise.withResolvers()
  f.block(blocked.promise)
  const pending = f.endpoints.openConversation(args)
  while (!f.flushes()) await tick()
  await f.endpoints.organizeConversation({...args,action:'archive'})
  blocked.resolve()
  assert.deepEqual((await pending).items,[])
  assert.equal(f.lookups(),1)
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM native_agent_history_checkpoints').get().n,0)
  f.block(null)
  await f.endpoints.organizeConversation({...args,action:'restore'})
  assert.deepEqual((await f.endpoints.openConversation(args)).items.map(item=>item.text),
    ['Saved owned part','Saved owned answer','Saved rollover input','Saved rollover answer'])
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM native_agent_history_checkpoints').get().n,2)
})

test('opening a managed private chat restores native-only turns in its older parts', async t => {
  const f = fixture(t,{recovery:true})
  await f.seed({listen:false})
  const {local} = f.bots
  local.sessionId = 'foreground'
  local.openParts = [{sessionId:'part-1',segments:[{sessionId:'older'},{sessionId:'stale-part'}]}]
  local.tasks = [{sessionId:'settled-task'}]
  f.rt.chatOwners.set('foreground','local')
  f.rt.pastOwners.set('older',{botId:'local'})
  f.rt.pastOwners.set('stale-part',{botId:'local'})
  f.rt.chatOwners.set('stale-part','other')
  f.rt.pastOwners.set('settled-task',{botId:'local'})
  f.session('older').turn([input('Saved earlier native input'),output('Saved earlier answer')])
  f.session('part-1').turn([input('Saved private head',{kind:'user',rpcId:'own-head'}),output('Saved head answer')],
    {time:1_800_000_001_000})
  f.session('settled-task').turn([input('Unrelated task'),output('Other task answer')])
  f.session('stale-part').turn([input('Stale foreign claim'),output('Other owner answer')])
  const snapshot = () => f.endpoints.v1({method:'GET',
    path:`/v1/workspaces/${workspace}/agents/${agentId}/conversations/${conversationId}?limit=50&snapshot=1`})
  assert.equal((await snapshot()).status,409)
  assert.equal(f.lookups(),0)
  const {conversation,items} = await f.endpoints.openConversation(args)
  assert.equal(conversation.native_session_id,'part-1')
  assert.deepEqual(items.map(item=>item.text),['Saved earlier native input','Saved earlier answer','Saved private head','Saved head answer'])
  assert.deepEqual((await snapshot()).body.items.map(item=>item.id),items.map(item=>item.id))
  assert.deepEqual((await f.endpoints.openConversation(args)).items.map(item=>item.id),items.map(item=>item.id))
  assert.equal(f.lookups(),4)
})

test('cold history uses only the exact stored part and avoids reading it again at the known persisted cursor', async t => {
  const f = fixture(t,{recovery:true})
  await f.seed({listen:false})
  const source = f.session('part-1')
  source.turn([input('Recovered cold input'),output('Recovered cold reply')])
  const calls = []
  const storageIdentity = Symbol('fixture session backend')
  f.ctx.sessions.get = () => undefined
  f.ctx.get = name => name === 'sessionPersistence' ? {
    identity:storageIdentity,
    async stat(id,{signal}) {
      assert.equal(id,'part-1')
      assert.ok(signal instanceof AbortSignal)
      calls.push('stat')
      return {header:{id},revision:'known fixture revision'}
    },
    async open(id,access) {
      assert.equal(id,'part-1')
      assert.equal(access,'read')
      calls.push('open')
      return {id,inheritedEventCount:0,async read(offset,limit) {
        calls.push('read')
        assert.equal(offset,0)
        assert.equal(limit,2048)
        return {events:Array.from({length:source.native.seq},(_, index) => source.native.eventAt(index))}
      },async close() {calls.push('close')}}
    },
  } : undefined
  const {items} = await f.endpoints.openConversation(args)
  assert.deepEqual(items.map(row=>row.text),['Recovered cold input','Recovered cold reply'])
  assert.deepEqual((await f.endpoints.openConversation(args)).items.map(row=>row.id),items.map(row=>row.id))
  assert.deepEqual(calls,['stat','open','read','close','stat'])
  assert.equal(f.flushes(),0)
})
