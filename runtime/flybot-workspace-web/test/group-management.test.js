import assert from 'node:assert/strict'
import test from 'node:test'
import { setSharedBotSocial } from '../lib/c/bot-social.js'
import { messengerV1 } from '../lib/c/legacy-v1.js'
import { nativeGroupClient } from '../lib/c/native-groups.js'

const personal = 'a'.repeat(32)
const teamWorkspace = 'b'.repeat(32)
const room = 'otc_group'
const group = (title, revision) => ({
  id:room,kind:'group',title,account_group:true,activity_version:`1.${revision}.0.0`,
  members:[{owner_id:'social_member',platform_user_id:'c'.repeat(32),handle:'sample.home'}],
  group_management:{revision,owner_id:'social_member',can_rename:true},
})

test('the browser group bridge derives its scope and preserves stable member identities and leave receipts', async t => {
  t.after(() => setSharedBotSocial(undefined))
  const writes = []
  setSharedBotSocial({
    async request(method,path,payload) {
      if (path === '/v1/ot/me') return {owner_id:'social_member'}
      assert.equal(method,'POST')
      assert.equal(path,`/v1/ot/conversations/${room}/management`)
      writes.push(payload)
      if (payload.revision === 0) throw Object.assign(new Error('Changed elsewhere'), {status:409,code:'social/group_management_conflict'})
      if (payload.action === 'leave') return {left:true,conversation_id:room}
      return {conversation:group(payload.title, payload.revision + 1)}
    },
  })
  const call = messengerV1({async call(name) {
    assert.equal(name,'agents/personal-binding')
    return {workspace_id:personal}
  }})
  const endpoint = (workspace,body) => call({method:'POST',path:`/v1/workspaces/${workspace}/social/conversations/${room}/management`,body})
  const renamed = await endpoint(personal,{action:'rename',title:'Release notes',revision:1})
  assert.equal(renamed.status,200)
  assert.equal(renamed.body.conversation.workspace_id,personal)
  assert.equal(renamed.body.conversation.members[0].user_id,'c'.repeat(32))
  assert.equal(renamed.body.conversation.members[0].group_member_id,'social_member')
  assert.equal(renamed.body.conversation.group_management.owner_id,'social_member')
  assert.deepEqual(writes[0],{action:'rename',title:'Release notes',revision:1,direct:true})
  assert.equal((await endpoint(teamWorkspace,{action:'leave',revision:1,direct:true})).status,400)
  assert.deepEqual((await endpoint(teamWorkspace,{action:'leave',revision:1})).body,{left:true,conversation_id:room})
  assert.deepEqual(writes[1],{action:'leave',revision:1,workspace:teamWorkspace})
  assert.equal((await endpoint(personal,{action:'leave',revision:0})).body.error.code,'group_management_conflict')
})

test('the native room reuses its existing projection and a stale read cannot restore an exited group', async () => {
  let conversation = group('Initial title',1)
  let saves = 0, sessions = 0, announcements = 0
  const removed = []
  const rt = {
    state:{rooms:{}},roomOf(id) { return this.state.rooms[id] },
    createSession:async () => `native-${++sessions}`,
    save:async () => { saves++ },
    mobileEndpoint() {}, sendUser() {}, updateRoom() {},
    async deleteRoom(id) { delete this.state.rooms[id]; removed.push(id) },
  }
  const raw = {
    async get(path) {
      assert.equal(path,`/v1/ot/conversations/${room}/announcement`)
      announcements++
      return {announcement:{body:'Existing announcement'}}
    },
    async request(_method,path) {
      if (path.endsWith('/management')) return {left:true,conversation_id:room}
      return conversation
    },
  }
  const client = nativeGroupClient({currentRuntime:() => ({rt})},raw)
  const path = `/v1/ot/conversations/${room}`
  assert.equal((await client.get(path)).native_room_id,'native-1')
  assert.equal((await client.get(path)).native_room_id,'native-1')
  assert.deepEqual([sessions,saves,announcements],[1,1,1])
  const initial = conversation
  conversation = group('Changed title',2)
  await client.get(path)
  assert.equal(rt.roomOf('native-1').name,'Changed title')
  conversation = initial
  await client.get(path)
  assert.equal(rt.roomOf('native-1').name,'Changed title')
  await client.post(`${path}/management`,{action:'leave',revision:2})
  assert.equal((await client.get(path)).native_room_id,undefined)
  assert.deepEqual(removed,['native-1'])
  assert.equal(sessions,1)
})

test('a saved group stays visible in the plugin while the native room projection retries', async () => {
  const conversation = group('New group', 1)
  const other = {...group('Existing group', 1), id: 'otc_other'}
  let sessions = 0
  let writes = 0
  let projectionAvailable = false
  const rt = {
    state:{rooms:{}},roomOf(id) { return this.state.rooms[id] },
    createSession:async () => `native-${++sessions}`,
    async save() {}, mobileEndpoint() {}, sendUser() {}, updateRoom() {}, deleteRoom() {},
  }
  const raw = {
    async get(path) {
      if (path.includes(room) && !projectionAvailable) throw new Error('Announcement unavailable')
      return {announcement:{body:''}}
    },
    async request(method,path) {
      if (method === 'POST') { writes++; return conversation }
      if (path === '/v1/ot/conversations') return {conversations:[conversation, other]}
      return conversation
    },
  }
  const client = nativeGroupClient({currentRuntime:() => ({rt})}, raw)
  const path = '/v1/ot/conversations'
  assert.deepEqual(await client.post(path,{kind:'group',title:conversation.title}), conversation)
  const {conversations} = await client.get(path)
  assert.deepEqual(conversations[0], conversation)
  assert.equal(conversations[1].native_room_id, 'native-1')
  assert.deepEqual(await client.get(`${path}/${room}`), conversation)
  projectionAvailable = true
  assert.equal((await client.get(`${path}/${room}`)).native_room_id, 'native-2')
  assert.equal((await client.get(`${path}/${room}`)).native_room_id, 'native-2')
  assert.deepEqual([writes, sessions], [1, 2])
})

test('default groups clear an inferred Chief and preserve a deliberately selected native admin', async () => {
  const chief = 'a'.repeat(32), helper = 'b'.repeat(32)
  const path = `/v1/ot/conversations/${room}`
  const owner = {owner_id:'room-owner', handle:'owner'}
  const chiefTarget = {owner_id:owner.owner_id,agent_id:chief}
  const helperTarget = {owner_id:owner.owner_id,agent_id:helper}
  const original = {...group('Project',1),team_id:null,members:[owner],
    agents:[{mine:true,owner,agent_ref:helper,name:'Helper'},{mine:true,owner,agent_ref:chief,name:'Personal Agent'}],
    group_agent_routing:{mode:'personal',policy:{mode:'default'},can_edit:true,native_chief:chiefTarget}}
  let conversation = original
  const native = {id:'native-group',name:'Project',members:['helper-bot','chief-bot'],admin:'chief-bot',
    mode:'admin',origin:'flybot-workspace',flybotWorkspace:{conversation_id:room,reply_policy:{mode:'default',chief:chiefTarget}}}
  const rt = {
    state:{rooms:{'native-group':native}},
    roomOf(id) { return this.state.rooms[id] },
    async save() {}, mobileEndpoint() {}, updateRoom() {}, deleteRoom() {}, sendUser() {},
  }
  const raw = {
    async request(method,target) {
      assert.deepEqual([method,target],['GET',path])
      return conversation
    },
    async get(target) {
      assert.equal(target,path+'/announcement')
      return {announcement:{body:''}}
    },
    async put() { assert.fail('opening a shared group must not add or promote the account Chief') },
  }
  const host = {currentRuntime:() => ({rt}),
    async call(operation,payload) {
      assert.equal(operation,'agents/byId')
      assert.ok([chief,helper].includes(payload.id))
      return {agent:{id:payload.id,native_bot_id:payload.id === chief ? 'chief-bot' : 'helper-bot'}}
    },
  }
  const client = nativeGroupClient(host, raw)
  assert.equal((await client.get(path)).native_room_id,native.id)
  assert.equal(native.admin,null)
  assert.equal(native.mode,'admin')
  assert.equal(native.flybotWorkspace.reply_policy.chief,undefined)
  assert.deepEqual(native.members,['helper-bot','chief-bot'])

  conversation = {...original,activity_version:'1.2.0.0',group_agent_routing:{...original.group_agent_routing,
    policy:{mode:'lead',lead:helperTarget}}}
  assert.equal((await client.get(path)).native_room_id,native.id)
  assert.equal(native.admin,'helper-bot')
  assert.deepEqual(native.flybotWorkspace.reply_policy.lead,helperTarget)

  conversation = {...group('Project',3),team_id:null,members:[owner],agents:original.agents,
    group_agent_routing:{mode:'personal',policy:{mode:'everyone'},can_edit:true}}
  assert.equal((await client.get(path)).native_room_id,native.id)
  assert.equal(native.admin,null)
  assert.equal(native.mode,'everyone')
})

test('a new shared group with local members uses native room creation without an inferred admin', async () => {
  const owner = {owner_id:'social_member', handle:'sample.home'}
  const conversation = {...group('Project',1),agents:['first','second'].map(agent_ref=>({mine:true,owner,agent_ref,name:agent_ref})),
    group_agent_routing:{mode:'personal',policy:{mode:'default'},can_edit:true}}
  const path = `/v1/ot/conversations/${room}`
  const rt = {
    state:{rooms:{}},
    roomOf(id) { return this.state.rooms[id] },
    async createRoom({name,members,mode,admin}) {
      assert.deepEqual({name,members,mode,admin},{name:'Project',members:['bot-first','bot-second'],mode:'admin',admin:null})
      return this.state.rooms.native1 = {id:'native1',name,members,mode,admin}
    },
    async save() {}, mobileEndpoint() {}, updateRoom() {}, deleteRoom() {}, sendUser() {},
  }
  const raw = {
    async request(method,target) {
      assert.deepEqual([method,target],['GET',path])
      return conversation
    },
    async get(target) {
      assert.equal(target,path+'/announcement')
      return {announcement:{body:''}}
    },
  }
  const host = {currentRuntime:() => ({rt}),async call(operation,{id}) {
    assert.equal(operation,'agents/byId')
    return {agent:{id,native_bot_id:'bot-'+id}}
  }}
  const client = nativeGroupClient(host,raw)
  const opened = await client.get(path)
  assert.equal(opened.native_room_id,'native1')
  assert.equal(rt.roomOf('native1').flybotWorkspace.conversation_id,room)
})

test('a multi-owner group projects one native admin even when the Bots share an agent ID', async () => {
  const owner = {owner_id:'room-owner',handle:'owner.home'}
  const peer = {owner_id:'room-peer',handle:'peer.home'}
  const sharedAgentId = 'a'.repeat(32)
  const lead = {owner_id:peer.owner_id,agent_id:sharedAgentId}
  const path = `/v1/ot/conversations/${room}`

  async function open(viewer) {
    const coordinator = viewer === owner
    const conversation = {...group('Shared project',1),members:[owner,peer],
      agents:[owner,peer].map(holder => ({agent_ref:sharedAgentId,name:'Reviewer',owner:holder,mine:viewer === holder})),
      group_agent_routing:{mode:'shared',policy:{mode:'lead',lead},native_group_host:owner.owner_id,
        native_group_coordinator:coordinator,can_edit:coordinator}}
    const rt = {
      state:{rooms:{}}, roomOf(id) { return this.state.rooms[id] },
      async createSession() { return 'admin-room' },
      async save() {}, mobileEndpoint() {}, updateRoom() {}, deleteRoom() {}, sendUser() {},
    }
    const raw = {request:async () => conversation, get:async () => ({announcement:{body:''}})}
    const host = {currentRuntime:() => ({rt}), async call(name,{id}) {
      assert.equal(name,'agents/byId')
      assert.equal(id,sharedAgentId)
      return {agent:{native_bot_id:viewer.owner_id+'-bot'}}
    }}
    const opened = await nativeGroupClient(host,raw).get(path)
    return rt.roomOf(opened.native_room_id)
  }

  const hostRoom = await open(owner)
  const peerRoom = await open(peer)
  assert.equal(hostRoom.mode,'admin')
  assert.equal(hostRoom.admin,null)
  const remoteAdmin = hostRoom.flybotWorkspace.native_bot_seats.find(seat => seat.id === hostRoom.flybotWorkspace.native_group_admin)
  assert.equal(remoteAdmin.owner_id,peer.owner_id)
  assert.equal(remoteAdmin.agent_ref,sharedAgentId)
  assert.equal(peerRoom.admin,peer.owner_id+'-bot')
  assert.deepEqual(hostRoom.flybotWorkspace.reply_policy.lead,peerRoom.flybotWorkspace.reply_policy.lead)
})

test('sending plain text from the native room uses the same shared group and reply receipt', async () => {
  const conversation = group('Product team', 1)
  const path = `/v1/ot/conversations/${room}`
  const message = {id:'otm_plain_text', body:'你们好', mine:true, created_at:1, revision:1}
  const receipt = {...message, reply_jobs:[{id:'job-shared', status:'queued'}]}
  const rt = {
    state:{rooms:{}}, roomOf(id) { return this.state.rooms[id] },
    async createSession() { return 'native-group-id' },
    async save() {}, mobileEndpoint() {}, updateRoom() {}, deleteRoom() {},
    sendUser() { assert.fail('the projected room should send through its shared conversation') },
  }
  const calls = []
  const raw = {
    async get(target) {
      if (target === path) return conversation
      if (target === path + '/announcement') return {announcement:{body:''}}
      assert.equal(target, path + '/messages?limit=100')
      return {messages:[message]}
    },
    async request(method,target) {
      assert.deepEqual([method,target], ['GET',path])
      return conversation
    },
    async post(target,payload) {
      calls.push({target,payload})
      return receipt
    },
  }
  const host = {
    currentRuntime:() => ({rt}),
    async call(operation,payload) {
      assert.deepEqual([operation,payload], ['agents/groupActivity',{conversation_id:room}])
      return {running:[], speaking:[]}
    },
  }
  const client = nativeGroupClient(host, raw)
  const opened = await client.get(path)
  assert.equal(opened.native_room_id, 'native-group-id')
  assert.equal(await rt.sendUser({sessionId:opened.native_room_id, content:[{type:'text',text:message.body}], requestId:'native-plain-key'}), receipt)
  assert.deepEqual(calls, [{target:path + '/messages', payload:{body:message.body, client_key:'native-plain-key'}}])
  const chosen = String.raw`@[Shared \[draft\]](ot-agent:other.owner/shared:agent)`
  const example = '```text\n' + chosen + '\n```'
  const send = text => rt.sendUser({sessionId:opened.native_room_id, content:[{type:'text',text}], requestId:'native-mention-key'})
  assert.equal(await send(chosen + ' ' + chosen + ' 回复这段示例\n' + example), receipt)
  assert.deepEqual(calls.at(-1), {target:path + '/messages', payload:{
    body:'回复这段示例\n' + example, client_key:'native-mention-key',
    agent_mentions:[{owner_id:'other.owner',agent_id:'shared:agent'}],
  }})
  assert.equal(await send('仅显示 ' + '`' + chosen + '`'), receipt)
  assert.deepEqual(calls.at(-1).payload, {body:'仅显示 ' + '`' + chosen + '`', client_key:'native-mention-key'})
  await assert.rejects(send(chosen), {code:'bot/invalid'})
  assert.equal(calls.length,3)
  const live = await rt.mobileEndpoint('room-chat',{roomId:opened.native_room_id})
  assert.deepEqual(live.items.map(item => ({id:item.source_message_id,text:item.text})), [{id:message.id,text:message.body}])
})

test('native shared group policy projects exact remote leads and saves through the authoritative scope and revision', async () => {
  const ownId = '1'.repeat(32), remoteId = 'linked:assistant'
  const lead = {owner_id:'owner:teammate', agent_id:remoteId}
  const target = '/v1/ot/conversations/' + room
  const teamId = 'ott_policy'
  const groupWith = (revision, policy, {canEdit = true, team = null, activity = revision} = {}) => ({
    ...group('Policy group',revision), team_id:team, account_group:team === null,
    activity_version:`10.${activity}.0.0`,
    agents:[{agent_ref:ownId,name:'Shared name',mine:true,owner:{owner_id:'social_member',display_name:'Owner'}},
      {agent_ref:remoteId,name:'Shared name',mine:false,owner:{owner_id:lead.owner_id,display_name:'Teammate',handle:'team.home'}}],
    group_agent_routing:{mode:'personal',default:'all',policy,can_edit:canEdit},
  })
  let conversation = groupWith(2,{mode:'lead',lead})
  let readResponse = conversation
  let workspaceAvailable = true
  const out = [], original = []
  const rt = {
    state:{rooms:{local:{id:'local'}}}, roomOf(id) { return this.state.rooms[id] },
    async createSession() { return 'native-policy-room' },
    async save() {}, mobileEndpoint() {}, sendUser() {}, deleteRoom() {},
    updateRoom(...args) { original.push(args); return 'native upstream' },
  }
  const raw = {
    async get(path) {
      if (path === target) return conversation
      if (path === target + '/announcement') return {announcement:{body:''}}
      assert.equal(path,'/v1/ot/workspaces')
      const other = {id:'ott_other',workspace_id:personal}
      return {workspaces:workspaceAvailable ? [other,{id:teamId,workspace_id:teamWorkspace}] : [other]}
    },
    async request(method,path) {
      assert.deepEqual([method,path],['GET',target])
      return readResponse
    },
    async post(path,payload) {
      assert.equal(path,target+'/management')
      out.push(payload)
      if (payload.revision !== conversation.group_management.revision) {
        throw Object.assign(new Error('Changed elsewhere'),{status:409,code:'social/group_management_conflict'})
      }
      const {mode,lead} = payload
      conversation = groupWith(payload.revision + 1,{mode,...(lead ? {lead} : {})},{team:conversation.team_id})
      return {conversation}
    },
  }
  const host = {currentRuntime:() => ({rt}), async call(name,payload) {
    assert.deepEqual([name,payload],['agents/byId',{id:ownId}])
    return {agent:{native_bot_id:'local-bot'}}
  }}
  const bridge = nativeGroupClient(host,raw)
  const id = (await bridge.get(target)).native_room_id
  const policy = () => rt.roomOf(id).flybotWorkspace.reply_policy
  assert.deepEqual(rt.roomOf(id).members,['local-bot'])
  assert.equal(rt.roomOf(id).admin,null,'A reply lead has no native administrator privileges')
  assert.deepEqual(policy().lead,lead)
  assert.deepEqual(policy().targets.map(item => item.owner_name),['Owner','Teammate'])
  assert.equal(policy().targets[1].owner_handle,'team.home')
  assert.equal(policy().revision,2)

  const direct = {flybotWorkspaceReplyPolicy:{mode:'everyone',revision:2}}
  await assert.rejects(rt.updateRoom(id,direct,'bot'),/Only a human/)
  await assert.rejects(rt.updateRoom(id,{...direct,name:'Invalid combined edit'}),/on its own/)
  await assert.rejects(rt.updateRoom(id,{flybotWorkspaceReplyPolicy:{mode:'lead',revision:2,lead:{...lead,workspace:personal}}}),/eligible/)
  assert.deepEqual(out,[])
  assert.equal(await rt.updateRoom('local',{mode:'admin'},'native-bot'),'native upstream')
  assert.deepEqual(original,[['local',{mode:'admin'},'native-bot']])

  const saved = await rt.updateRoom(id,direct)
  assert.equal(saved.room.flybotWorkspace.reply_policy.mode,'everyone')
  assert.deepEqual(out[0],{action:'reply_policy',mode:'everyone',revision:2,direct:true})
  await assert.rejects(rt.updateRoom(id,{flybotWorkspaceReplyPolicy:{mode:'default',revision:2}}),{status:409})
  assert.equal(policy().revision,3)
  assert.equal(policy().mode,'everyone')

  conversation = groupWith(4,{mode:'lead',lead,lead_unavailable:true},{team:teamId,activity:6})
  conversation.agents.pop()
  readResponse = conversation
  await bridge.get(target)
  assert.equal(policy().lead_unavailable,true)
  assert.deepEqual(policy().lead,lead)
  assert.equal(policy().targets.length,1)
  const {group_management:_unused,...summary} = conversation
  readResponse = summary
  await bridge.get(target)
  assert.equal(policy().revision,4,'A current list preview cannot erase the reviewed detail revision')
  readResponse = groupWith(4,{mode:'lead',lead},{team:teamId,activity:5})
  await bridge.get(target)
  assert.equal(policy().lead_unavailable,true,'A delayed roster snapshot cannot revive an unavailable lead')

  workspaceAvailable = false
  const named = {flybotWorkspaceReplyPolicy:{mode:'mentions',revision:4}}
  await assert.rejects(rt.updateRoom(id,named),/workspace is unavailable/)
  assert.equal(out.length,2)
  workspaceAvailable = true
  await rt.updateRoom(id,named)
  assert.deepEqual(out[2],{action:'reply_policy',mode:'mentions',revision:4,workspace:teamWorkspace})
  assert.equal(policy().revision,5)
  assert.equal(policy().mode,'mentions')

  const selected = {flybotWorkspaceReplyPolicy:{mode:'lead',revision:5,lead}}
  await rt.updateRoom(id,selected)
  assert.deepEqual(out[3],{action:'reply_policy',mode:'lead',revision:5,lead,workspace:teamWorkspace})
  assert.deepEqual(policy().lead,lead)

  conversation = groupWith(7,{mode:'default'},{team:teamId})
  const {group_management:_revision,...draftSummary} = conversation
  readResponse = draftSummary
  await bridge.get(target)
  assert.equal(policy().revision,undefined)
  await assert.rejects(rt.updateRoom(id,{flybotWorkspaceReplyPolicy:{mode:'everyone',revision:7}}),/Refresh/)
  assert.equal(out.length,4)
  await rt.updateRoom(id,{flybotWorkspaceReplyPolicy:{refresh:true}})
  assert.equal(policy().revision,7)

  conversation = groupWith(8,{mode:'default'},{team:teamId,canEdit:false})
  const {group_management:_management,...nextSummary} = conversation
  readResponse = nextSummary
  await bridge.get(target)
  assert.equal(policy().revision,undefined,'A changed list preview is not a reviewed detail')
  await assert.rejects(rt.updateRoom(id,{flybotWorkspaceReplyPolicy:{mode:'everyone',revision:8}}),/group owner/)
  assert.equal(out.length,4)
  await rt.updateRoom(id,{flybotWorkspaceReplyPolicy:{refresh:true}})
  assert.equal(policy().revision,8)
  assert.equal(policy().can_edit,false)
  assert.equal(out.length,4,'Refresh never writes to Bot Social')
})
