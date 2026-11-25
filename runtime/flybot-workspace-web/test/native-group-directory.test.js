import assert from 'node:assert/strict'
import test from 'node:test'
import {nativeGroupClient} from '../lib/c/native-groups.js'

const teamId = 'ott_native_directory'
const workspace = 'a'.repeat(32)
const personal = 'b'.repeat(32)
const teamGroup = 'otc_00000000000000000000000003'
const personalGroup = 'otc_00000000000000000000000001'
const staleGroup = 'otc_00000000000000000000000002'
const directory = '/v1/ot/group-directory'
const messagesPath = `/v1/ot/conversations/${teamGroup}/messages?limit=100`
const received = {id:'otm_00000000000000000000000001',body:'Written in FlyBot',seq:1,revision:1,created_at:1700000000000,
  author:{kind:'member',handle:'owner.home',display_name:'Owner'}}

test('native-first directory stays read-only and only opens one authorized projection of a selected Web group', async () => {
  const seen = [], persisted = [], persons = [{owner_id:'outside-runtime',handle:'owner.home',display_name:'Owner'},
    {owner_id:'current-runtime',handle:'recipient.home',display_name:'Recipient'}]
  let sessions = 0, unavailable = false, locked = true
  const conversation = {id:teamGroup,kind:'group',title:'Shared release discussion',team_id:teamId,members:persons,
    agents:[{agent_ref:'remote',mine:false,owner:persons[0]}],group_management:{revision:2}}
  const rt = {state:{rooms:{}},roomOf(id) {return this.state.rooms[id]},
    async createSession() { return 'native-room-' + ++sessions },
    async save(options) { persisted.push(options); if (locked) throw new Error('Roster locked') },
    sendUser() { assert.fail('shared sends do not use native local history') },
    mobileEndpoint: () => 'upstream', updateRoom() {}, deleteRoom() { assert.fail('no destructive directory cleanup') },
  }
  const host = {currentRuntime:() => ({rt}), async call(name) {
    if (name === 'agents/personal-binding') return {workspace_id:personal}
    if (name === 'agents/groupActivity') return {running:[],speaking:[]}
    assert.fail('listing and remote-only groups never load local agents')
  }}
  const denied = () => Object.assign(new Error('No such conversation'),{code:'social/conversation_not_found',status:404})
  const raw = {
    async get(path) {
      seen.push(path)
      if (path === directory) return {items:[{conversation_id:teamGroup,title:conversation.title,kind:'team',workspace_id:workspace,
        workspace_name:'Release team',last_message:received}],next_cursor:teamGroup}
      if (path === directory + '?cursor=' + teamGroup) {
        return {items:[{conversation_id:personalGroup,title:'Personal discussion',kind:'personal',workspace_id:null,workspace_name:null}],next_cursor:null}
      }
      if (path === directory + '/' + staleGroup) throw denied()
      if (path === directory + '/' + teamGroup || path === '/v1/ot/conversations/' + teamGroup) {
        if (unavailable) throw denied()
        return conversation
      }
      if (path === '/v1/ot/conversations/' + teamGroup + '/announcement') return {announcement:{body:''}}
      if (path === messagesPath) return {messages:[received]}
      assert.fail('Unexpected canonical request ' + path)
    },
    async post() { throw denied() },
  }
  nativeGroupClient(host, raw)
  const list = payload => rt.mobileEndpoint('flybot-workspace-group-directory',payload)
  const open = id => rt.mobileEndpoint('flybot-workspace-group-open',{conversation_id:id})
  assert.deepEqual(await list({}),{items:[{conversation_id:teamGroup,title:conversation.title,kind:'team',workspace_id:workspace,
    workspace_name:'Release team'}],next_cursor:teamGroup})
  assert.deepEqual(await list({cursor:teamGroup}),{items:[{conversation_id:personalGroup,title:'Personal discussion',kind:'personal',
    workspace_id:personal,workspace_name:null}],next_cursor:null})
  assert.equal(sessions,0)
  assert.deepEqual(persisted,[])
  assert.deepEqual(seen,[directory,directory+'?cursor='+teamGroup])
  await assert.rejects(list({cursor:'forged'}),{code:'bot/invalid'})
  await assert.rejects(open(staleGroup),{code:'bot/not-found'})
  assert.equal(sessions,0)

  await assert.rejects(open(teamGroup),/Roster locked/)
  assert.equal(sessions,1)
  locked = false
  const [first,replay] = await Promise.all([open(teamGroup),open(teamGroup)])
  assert.equal(first.conversation_id,teamGroup)
  assert.equal(first.room.id,'native-room-1')
  assert.equal(replay.room.id,first.room.id)
  assert.equal(sessions,1)
  assert.deepEqual(persisted,[{required:true},{required:true}])
  assert.deepEqual(first.room.members,[])
  assert.deepEqual(first.room.remoteParticipants.map(member => member.id),persons.map(member => member.owner_id))
  const chat = await rt.mobileEndpoint('room-chat',{roomId:first.room.id})
  assert.deepEqual(chat.items.map(item => [item.source_message_id,item.text]),[[received.id,received.body]])

  unavailable = true
  await assert.rejects(open(teamGroup),{code:'bot/not-found'})
  await assert.rejects(rt.mobileEndpoint('room-chat',{roomId:first.room.id}),{status:404})
  await assert.rejects(rt.sendUser({sessionId:first.room.id,content:[{type:'text',text:'Rejected'}]}),{status:404})
  assert.equal(sessions,1)
  assert.equal(await rt.mobileEndpoint('upstream-path',{}),'upstream')
})
