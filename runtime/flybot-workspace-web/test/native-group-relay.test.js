import assert from 'node:assert/strict'
import {setTimeout as delay} from 'node:timers/promises'
import {test} from 'node:test'
import {nativeGroupRelay} from '../lib/c/native-group-relay.js'

const cid = 'otc_' + '1'.repeat(26)
const mid = 'otm_' + '2'.repeat(26)
const old = 'otm_' + '3'.repeat(26)
const legacy = 'otm_' + '4'.repeat(26)
const mirrored = 'otm_' + '5'.repeat(26)
const conversationPath = '/v1/ot/conversations/' + cid
const messagesPath = conversationPath + '/messages'
const roundPath = conversationPath + '/native-rounds/' + mid
const owner = 'owner'
const seats = [
  {mine:true, agent_ref:'writer', owner:{owner_id:owner}},
  {mine:true, agent_ref:'reviewer', owner:{owner_id:owner}},
]

async function eventually(check) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return
    await delay(10)
  }
  assert.ok(check(), 'Expected relay state was not reached')
}

function fixture(t, {exchange, initialState, roster = seats, mode = 'default', people = [{owner_id:owner}], lines = [],
  history, seq = 2, page = [{id:old,seq:1,body:'此前的讨论',created_at:1_700_000_000_000,author:{kind:'member',name:'Member'}}],
  author, nativeHost = owner, coordinator = true, working = [], image,
} = {}) {
  let lineListener
  let dispose
  let busy = false
  let state = initialState
  const received = []
  const writes = []
  const opened = []
  const logged = [...lines]
  const members = ['writer', 'reviewer']
  const room = {id:'native-room', members, flybotWorkspace:{conversation_id:cid, native_group_host:nativeHost,
    ...(exchange ? {native_exchange:exchange} : {}),
    ...(history ? {native_history:history} : {}),
  }}
  const conversation = {id:cid,kind:'group',account_group:true,agents:roster,members:people,
    group_management:{owner_id:owner},group_agent_routing:{can_edit:coordinator,policy:{mode},
      native_group_host:nativeHost,native_group_coordinator:coordinator,native_group_images:Boolean(image) && people.length === 1},
  }
  const item = {message_id:mid,conversation_id:cid,seq,body:'评审文档',agent_mentions:[{owner_id:owner,agent_id:'writer'}],
    author,text_only:people.length > 1,...(image && {has_image:true})}
  function addLine(line) {
    logged.push({...line,seq:(logged.at(-1)?.seq ?? 0) + 1})
    lineListener?.(room)
  }
  const rt = {
    state:{rooms:{[room.id]:room}},
    ctx:{on:(_event, cb) => {dispose = cb}, get:key => {
      assert.equal(key,'attachments')
      return {saveImage:async ({mediaType,data,name}) => {
        assert.deepEqual({mediaType,data,name}, {mediaType:image.mime,data:Buffer.from(image.data,'base64'),name:image.title})
        return {attachmentId:'stored-image',mediaType}
      }}
    }},
    botOf:id => ({name:id,flybotWorkspace:{agent_id:id}}),
    sharedRoomCursor:() => logged.at(-1)?.seq ?? 0,
    workingInRoom:() => working,
    roomActive:() => busy,
    groupLinesAfter:async (_id, cursor) => logged.filter(line => line.seq > cursor),
    save:async options => {assert.deepEqual(options,{required:true})},
    logRoom:(_room, line) => addLine(line),
    onRoomLine:listener => {lineListener = listener},
    beginSharedRoomRound:async (roomId, input) => {
      busy = true
      opened.push({roomId,input})
      addLine({who:input.author ?? 'User', text:input.text, flybotWorkspaceMessageId:input.sourceId})
    },
  }
  const raw = {
    get:async path => {
      if (path.startsWith('/v1/ot/native-group-inbox')) return {items:state && state !== 'finished' && coordinator ? [{...item,state}] : []}
      if (path === conversationPath) return conversation
      if (path === `${messagesPath}/${mid}/file`) return image
      assert.equal(path, messagesPath + '?limit=40&before=' + seq)
      return {messages:page}
    },
    post:async (path, body) => {
      if (path === messagesPath) {
        received.push(body)
        if (body.native_round) state = 'queued'
        return {id:mid}
      }
      writes.push({path,body})
      if (path === roundPath + '/lines') return {id:mirrored}
      if (path === roundPath + '/progress') return {ok:true}
      assert.equal(path, roundPath)
      if (body.action === 'start') {
        assert.equal(state, 'queued')
        state = 'running'
        return {started:true,state}
      }
      assert.equal(body.action, 'finish')
      state = 'finished'
      return {state}
    },
  }
  const relay = nativeGroupRelay({rt,raw,sync:async item => item,log:message => assert.fail(message)})
  t.after(() => dispose())
  const send = body => relay.send(data => raw.post(messagesPath,data), 'POST', messagesPath, {client_key:'abcdef', body:item.body, ...body})
  return {room,addLine, received, writes, opened, logged, send, setBusy:value => {busy = value}, state:() => state}
}

test('a plain shared group send starts the corresponding native room, then mirrors each Bot line once', async t => {
  const h = fixture(t)
  await h.send({group_agent_request:true, agent_mentions:[{owner_id:owner,agent_id:'writer'}]})
  await eventually(() => h.opened.length === 1)
  assert.equal(h.received[0].native_round, true)
  assert.deepEqual(h.opened, [{roomId:h.room.id,input:{text:'评审文档',sourceId:mid,mentions:['writer']}}])
  assert.deepEqual(h.logged.map(line => line.flybotWorkspaceMessageId), [old, mid])
  assert.equal(h.logged[0].time, 1_700_000_000_000)
  h.addLine({botId:'writer',kind:'working',text:'working'})
  h.addLine({botId:'writer',text:'@reviewer 请评审'})
  h.addLine({botId:'reviewer',text:'审完了'})
  h.setBusy(false)
  await eventually(() => h.state() === 'finished' && !h.room.flybotWorkspace.native_exchange)
  const published = h.writes.filter(item => item.path.endsWith('/lines')).map(item => item.body)
  assert.deepEqual(published.map(line => [line.agent_ref,line.body]), [['writer','@reviewer 请评审'], ['reviewer','审完了']])
  assert.equal(new Set(published.map(line => line.client_key)).size, 2)
  assert.deepEqual(h.room.flybotWorkspace.native_history.mirrored, [mirrored])
  assert.deepEqual(h.writes.map(item => item.body.action ?? 'line'), ['start','line','line','finish'])
})

test('a supported group image and its caption follow the native room', async t => {
  const image = {mime:'image/png',title:'screenshot.png',data:'iVBORw0KGgo='}
  const h = fixture(t,{image})
  await h.send({attachment:image})
  await eventually(() => h.opened.length === 1)
  assert.deepEqual(h.received.map(message => message.native_round), [true])
  assert.deepEqual(h.opened[0].input.images, [{attachmentId:'stored-image',mediaType:'image/png'}])
  assert.equal(h.opened[0].input.text, '评审文档')
})

test('a multi-owner group upload keeps the existing attachment route', async t => {
  const image = {mime:'image/png',title:'screenshot.png',data:'iVBORw0KGgo='}
  const h = fixture(t,{image,people:[{owner_id:owner},{owner_id:'another'}]})
  await h.send({attachment:image})
  assert.equal(h.received[0].native_round, undefined)
  assert.deepEqual(h.opened, [])
})

test('restart publishes durable lines without opening a second round', async t => {
  const h = fixture(t,{initialState:'running',exchange:{id:mid,cursor:1,dispatched:true},
    lines:[{seq:2,botId:'reviewer',text:'recovered result'}]})
  await eventually(() => h.state() === 'finished')
  assert.equal(h.opened.length, 0)
  assert.deepEqual(h.writes.map(item => item.body.action ?? item.body.body), ['recovered result','finish'])
})

test('an unknown running round is finalized without rerunning tools', async t => {
  const h = fixture(t,{initialState:'running'})
  await eventually(() => h.state() === 'finished')
  assert.equal(h.opened.length, 0)
  assert.deepEqual(h.writes.map(item => item.body.action), ['finish'])
})

test('unavailable native routes and files use normal sends', async t => {
  const [mentionsOnly, file] = [
    fixture(t,{mode:'mentions',nativeHost:null}), fixture(t),
  ]
  await mentionsOnly.send()
  await file.send({attachment:{title:'file'}})
  for (const h of [mentionsOnly,file]) assert.equal(h.received[0].native_round, undefined)
})

test('a guest submits through the shared round, and only the host starts it in text-only mode', async t => {
  const author = {owner_id:'guest',display_name:'Guest QA'}
  const people = [{owner_id:owner},author]
  const guest = fixture(t,{people,coordinator:false,author})
  await guest.send()
  assert.equal(guest.received[0].native_round, true)
  assert.equal(guest.opened.length, 0)
  const bot = {id:'writer',flybotWorkspace:{agent_id:'writer'}}
  const working = []
  const host = fixture(t,{people,author,initialState:'queued',working})
  await eventually(() => host.opened.length === 1)
  assert.deepEqual(host.writes[0].body, {action:'start',text_only:true})
  assert.equal(host.opened[0].input.textOnly, true)
  assert.equal(host.logged.at(-1).who, 'Guest QA')
  working.push({bot})
  host.addLine({botId:'writer',kind:'working',text:'working'})
  await eventually(() => host.writes.some(item => item.path.endsWith('/progress')))
  assert.deepEqual(host.writes.find(item => item.path.endsWith('/progress')).body, {working_agent_refs:['writer']})
})


test('later native rounds import missed shared lines without repeating native text', async t => {
  const h = fixture(t,{seq:5,initialState:'queued',history:{through:1,cursor:1,mirrored:[mirrored]},
    lines:[{seq:1,who:'Member',text:'old',flybotWorkspaceMessageId:old},
      {seq:2,who:'User',text:'already ran',flybotWorkspaceMessageId:'otm_'+'6'.repeat(26)},
      {seq:3,botId:'writer',text:'already mirrored'}],
    page:[{seq:1,id:old,body:'old'},
      {seq:2,id:'otm_'+'6'.repeat(26),body:'already ran'},
      {seq:3,id:mirrored,body:'already mirrored',author:{kind:'agent',agent_ref:'writer'}},
      {seq:4,id:legacy,body:'message posted between native rounds'}],
  })
  await eventually(() => h.opened.length === 1)
  assert.deepEqual(h.logged.map(line => line.text), ['old','already ran','already mirrored','message posted between native rounds','评审文档'])
  assert.deepEqual(h.room.flybotWorkspace.native_history,{through:4,cursor:4,mirrored:[mirrored]})
})
