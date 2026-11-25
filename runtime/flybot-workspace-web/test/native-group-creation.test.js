import assert from 'node:assert/strict'
import test from 'node:test'
import {setSharedBotSocial} from '../lib/c/bot-social.js'
import {messengerV1} from '../lib/c/legacy-v1.js'
import {nativeGroupClient} from '../lib/c/native-groups.js'

const personal = 'a'.repeat(32)
const team = 'b'.repeat(32)
const revoked = 'c'.repeat(32)
const personalAgent = '1'.repeat(32)
const teamAgent = '2'.repeat(32)
const me = {owner_id:'signed-actor',handle:'actor.home',display_name:'Actor'}
const collection = '/v1/ot/conversations'
const workspace = {id:'ott_team',workspace_id:team,name:'Release team'}
const request = {workspace_id:personal,title:'Release room',bot_ids:['personal-bot'],request_key:'existing-native-group-key-1'}

function fixture(t) {
  const nativeSessions = [], saves = [], posts = []
  const transcripts = new Map(), rooms = new Map(), receipts = new Map()
  const state = {rooms:{},bots:{}}
  let storageUnavailable = false, workspaceActive = true, detailUnavailable = false
  function bot(id, ws, agentId, flags = {}) {
    state.bots[id] = {id,name:id,flybotWorkspace:{workspace_id:ws,agent_id:agentId},...flags}
  }
  bot('personal-bot',personal,personalAgent)
  bot('team-bot',team,teamAgent)
  bot('revoked-bot',revoked,'3'.repeat(32))
  bot('archived-bot',personal,'4'.repeat(32),{hidden:true})
  bot('secret-bot',personal,'5'.repeat(32),{private:true})
  bot('unassigned-bot',null,null)
  const rt = {state, roomOf:id => state.rooms[id], botOf:id => state.bots[id],
    async createSession(title) {
      nativeSessions.push(title)
      return `room-${nativeSessions.length}`
    },
    async save(options) {
      saves.push(options)
      if (storageUnavailable) throw new Error('Durable native state could not be saved')
    },
    createRoom() { assert.fail('the shared workflow must use Bot Social') },
    greetRoom() { assert.fail('creation does not trigger a native greeting') },
    updateRoom() {}, deleteRoom() {},
    mobileEndpoint: () => 'upstream',
    sendUser() { assert.fail('shared room must send to the canonical transcript') },
  }
  const host = {currentRuntime:() => ({rt}),
    async call(name,payload) {
      if (name === 'agents/personal-binding') return {workspace_id:personal,agent_id:personalAgent}
      if (name === 'agents/groupActivity') return {running:[],speaking:[]}
      assert.ok(['agents/get','agents/byId'].includes(name))
      const local = Object.values(state.bots).find(bot => bot.flybotWorkspace.agent_id === payload.id)
      assert.ok(local)
      if (name === 'agents/get') assert.equal(payload.workspace_id,local.flybotWorkspace.workspace_id)
      return {agent:{id:payload.id,name:local.name,native_bot_id:local.id,workspace_id:local.flybotWorkspace.workspace_id}}
    },
  }
  const raw = {
    async request(method,path,payload) {
      if (method === 'POST') {
        posts.push([path,payload])
        if (path === collection) {
          if (payload.members.includes('outsider.home')) {
            throw Object.assign(new Error('No access to selected member'), {code:'social/not_reachable'})
          }
          const seen = receipts.get(payload.idempotency_key)
          if (seen) {
            assert.deepEqual(payload,seen.payload)
            return rooms.get(seen.id)
          }
          const id = 'otc_' + String(rooms.size + 1).padStart(26,'0')
          receipts.set(payload.idempotency_key,{id,payload})
          const conversation = {id,kind:'group',title:payload.title,team_id:payload.team_id ?? null,
            account_group:payload.account_group === true,members:[me],group_management:{revision:1},
            agents:payload.agents.map(agent => ({...agent,mine:true,owner:me}))}
          rooms.set(id,conversation)
          transcripts.set(id,[])
          return conversation
        }
        const [id] = path.slice(collection.length + 1).split('/')
        assert.equal(path,`${collection}/${id}/messages`)
        const messages = transcripts.get(id)
        const seen = messages.find(message => message.client_key === payload.client_key)
        if (seen) return seen
        const message = {id:'otm_00000000000000000000000001',body:payload.body,client_key:payload.client_key,
          author:{kind:'member',...me},seq:1,revision:1,mine:true,created_at:1700000000000}
        messages.push(message)
        return message
      }
      if (path === '/v1/ot/me') return me
      if (path === '/v1/ot/workspaces') return {workspaces:workspaceActive ? [workspace] : []}
      const [id,operation] = path.slice(collection.length+1).split('/')
      assert.ok(rooms.has(id),path)
      if (operation === 'announcement') return {announcement:{body:''}}
      if (operation?.startsWith('messages?')) return {messages:transcripts.get(id),last_seq:1,read_seq:1,pins:[]}
      if (detailUnavailable) throw new Error('Projection refresh unavailable')
      return rooms.get(id)
    },
    get(path) { return this.request('GET',path) },
    post(path,payload) { return this.request('POST',path,payload) },
  }
  const client = nativeGroupClient(host,raw)
  t.after(() => setSharedBotSocial(undefined))
  setSharedBotSocial(raw)
  return {rt,client,host,nativeSessions,saves,posts,rooms,transcripts,
    setStorageUnavailable: value => {storageUnavailable=value},
    setWorkspaceActive: value => {workspaceActive=value},
    setDetailUnavailable: value => {detailUnavailable=value},
  }
}

test('native workspace creation uses the canonical share and one projection across save recovery and first message', async t => {
  const f = fixture(t)
  const call = (endpoint,payload) => f.rt.mobileEndpoint(endpoint,payload)
  assert.deepEqual(await call('flybot-workspace-group-workspaces',{}), {workspaces:[
    {workspace_id:personal,name:'Personal workspace',kind:'personal',bot_ids:['personal-bot']},
    {workspace_id:team,name:workspace.name,kind:'team',bot_ids:['team-bot']},
  ]})
  f.setStorageUnavailable(true)
  const pending = await call('flybot-workspace-group-create',request)
  assert.deepEqual(pending,{conversation_id:'otc_00000000000000000000000001',room:null})
  assert.equal(f.rooms.size,1)
  assert.equal(f.nativeSessions.length,1)
  assert.deepEqual(f.saves,[{required:true}])

  f.setStorageUnavailable(false)
  const [resumed,replay] = await Promise.all([
    call('flybot-workspace-group-create',request), call('flybot-workspace-group-create',request),
  ])
  assert.equal(resumed.room.id,'room-1')
  assert.equal(replay.room.id,resumed.room.id)
  assert.equal(resumed.room.flybotWorkspace.conversation_id,pending.conversation_id)
  assert.equal(resumed.room.flybotWorkspace.account_group,true)
  assert.deepEqual(resumed.room.members,['personal-bot'])
  assert.equal(f.rooms.size,1)
  assert.equal(f.nativeSessions.length,1)
  assert.equal(f.transcripts.get(pending.conversation_id).length,0)
  assert.deepEqual(f.posts[0],[collection,{kind:'group',title:request.title,members:[],
    agents:[{agent_ref:personalAgent,name:'personal-bot'}],account_group:true,idempotency_key:'native-group:' + request.request_key}])

  f.setDetailUnavailable(true)
  const nativeSend = {sessionId:resumed.room.id,requestId:'native-user-send-exact',content:[{type:'text',text:'Shared first message'}]}
  const message = await f.rt.sendUser(nativeSend)
  assert.equal((await f.rt.sendUser(nativeSend)).id,message.id)
  assert.equal(f.transcripts.get(pending.conversation_id).length,1)
  f.setDetailUnavailable(false)
  const nativeView = await call('room-chat',{roomId:resumed.room.id})
  assert.deepEqual(nativeView.items.map(item => [item.source_message_id,item.text]),[[message.id,message.body]])
  const web = await messengerV1(f.host)({method:'GET',path:`/v1/workspaces/${personal}/social/conversations/${pending.conversation_id}`})
  assert.equal(web.status,200)
  assert.equal(web.body.conversation.id,pending.conversation_id)
  assert.equal(web.body.conversation.native_room_id,resumed.room.id)
  assert.deepEqual(web.body.items.map(item => [item.id,item.body]),[[message.id,message.body]])
  assert.equal(await call('unrelated-method',{}),'upstream')
})

test('native sharing checks the exact active workspace and rejects a private, archived, foreign or unassigned Bot', async t => {
  const f = fixture(t)
  const create = body => f.rt.mobileEndpoint('flybot-workspace-group-create',{...request,...body})
  for (const body of [{workspace_id:revoked},{bot_ids:['team-bot']},{bot_ids:['archived-bot']},
    {bot_ids:['secret-bot']},{bot_ids:['unassigned-bot']}]) {
    await assert.rejects(create(body), {code:'bot/not-found'})
  }
  for (const body of [{title:'  '},{bot_ids:[]},{bot_ids:['personal-bot','personal-bot']},{team_id:workspace.id},{greet:true}]) {
    await assert.rejects(create(body), {code:'bot/invalid'})
  }
  assert.equal(f.posts.length,0)
  await assert.rejects(create({member_handles:['outsider.home']}), {code:'social/not_reachable'})
  assert.equal(f.rooms.size,0)

  const input = {workspace_id:team,bot_ids:['team-bot'],title:'Team scope',request_key:'existing-native-group-key-2'}
  const shared = await create(input)
  assert.equal(shared.room.flybotWorkspace.team_id,workspace.id)
  assert.deepEqual(shared.room.members,['team-bot'])
  assert.deepEqual(f.posts.at(-1),[collection,{kind:'group',title:input.title,members:[],team_id:workspace.id,
    agents:[{agent_ref:teamAgent,name:'team-bot'}],idempotency_key:'native-group:' + input.request_key}])
  f.setWorkspaceActive(false)
  await assert.rejects(create(input), {code:'bot/not-found'})
  assert.equal(f.rooms.size,1)
})
