import assert from 'node:assert/strict'
import test from 'node:test'
import {setSharedBotSocial} from '../lib/c/bot-social.js'
import {messengerV1} from '../lib/c/legacy-v1.js'

const personal = 'a'.repeat(32)
const teamWorkspace = 'b'.repeat(32)
const room = 'otc_policy'
const lead = {owner_id:'owner:teammate',agent_id:'linked:assistant'}

test('the native management adapter derives workspace scope and projects the exact saved policy, revision and errors', async t => {
  t.after(() => setSharedBotSocial(undefined))
  const writes = []
  setSharedBotSocial({
    async request(method,path,payload) {
      if (path === '/v1/ot/me') return {owner_id:'owner:viewer'}
      assert.equal(method,'POST')
      assert.equal(path,`/v1/ot/conversations/${room}/management`)
      writes.push(payload)
      if (payload.mode === 'lead') {
        throw Object.assign(new Error('Lead is no longer available'),{status:409,code:'social/group_reply_lead_unavailable'})
      }
      return {conversation:{
        id:room,kind:'group',account_group:payload.direct === true,
        group_management:{revision:payload.revision + 1,owner_id:'owner:viewer'},
        group_agent_routing:{
          mode:payload.direct ? 'personal' : 'shared',...(payload.direct ? {default:'all'} : {}),
          policy:{mode:payload.mode},can_edit:true,
        },
      }}
    },
  })
  const v1 = messengerV1({async call(name) {
    assert.equal(name,'agents/personal-binding')
    return {workspace_id:personal}
  }})
  const post = (workspace,body) => v1({method:'POST',path:`/v1/workspaces/${workspace}/social/conversations/${room}/management`,body})
  const action = 'reply_policy'
  assert.equal((await post(personal,{action,revision:1,mode:'everyone',lead})).status,400)
  assert.equal((await post(personal,{action,revision:1,mode:'lead',lead:{...lead,injected:true}})).status,400)
  assert.equal((await post(teamWorkspace,{action,revision:1,mode:'default',direct:true})).status,400)
  assert.equal(writes.length,0)
  const saved = await post(personal,{action,revision:1,mode:'everyone'})
  assert.equal(saved.status,200)
  assert.equal(saved.body.conversation.group_management.revision,2)
  assert.deepEqual(saved.body.conversation.group_agent_routing,{mode:'personal',default:'all',policy:{mode:'everyone'},can_edit:true})
  const quiet = await post(teamWorkspace,{action,revision:2,mode:'mentions'})
  assert.equal(quiet.status,200)
  assert.deepEqual(quiet.body.conversation.group_agent_routing,{mode:'shared',policy:{mode:'mentions'},can_edit:true})
  const denied = await post(teamWorkspace,{action,revision:1,mode:'lead',lead})
  assert.equal(denied.status,409)
  assert.equal(denied.body.error.code,'group_reply_lead_unavailable')
  assert.deepEqual(writes,[
    {action,revision:1,mode:'everyone',direct:true},
    {action,revision:2,mode:'mentions',workspace:teamWorkspace},
    {action,revision:1,mode:'lead',lead,workspace:teamWorkspace},
  ])
})
