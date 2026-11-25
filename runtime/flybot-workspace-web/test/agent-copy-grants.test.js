import assert from 'node:assert/strict'
import test from 'node:test'
import { agentCopyRoutes } from '../features/agents/copy-grants.js'
import { createV1Endpoint } from '../featurekit/v1.js'
import { setSharedBotSocial } from '../lib/c/bot-social.js'

const workspace = 'a'.repeat(32)
const agent = 'b'.repeat(32)
const grant = 'otag_'+'1'.repeat(26)
const revision = 'd'.repeat(64)
const key = 'fixture-agent-copy-key'
const source = `/v1/workspaces/${workspace}/agents/${agent}/shares`
const shares = '/v1/ot/agent-copy-grants'
const incoming = '/v1/agent-copy-grants/'+grant+'/remix'
const accessSource = `/v1/workspaces/${workspace}/agents/${agent}/access`
const accessPath = '/v1/ot/agent-access'
const conversation = 'otc_'+'2'.repeat(26)

function fixture(t) {
  const calls = []
  const saved = {name:'Local agent',summary:'Notes',category:'research',instructions:'Private instructions',
    quick_starts:['Plan a study'],revision:6}
  const shared = {...saved,instructions:'',revision}
  let revoked = false
  let accessCreated = false
  const connector = {
    request(method,path,body) { return this[{GET:'get',POST:'post',DELETE:'del'}[method]](path,body) },
    async get(path) { calls.push(['GET',path]); return {items:[],next_cursor:null} },
    async post(path,body) {
      calls.push(['POST',path,body])
      if (path === accessPath) {
        const created = !accessCreated
        accessCreated = true
        return {created,access:{conversation_id:conversation}}
      }
      if (path === shares+'/'+grant+'/claim') {
        if (revoked) throw Object.assign(new Error('撤回'),{status:410,code:'social/agent_copy_revoked'})
        return {grant:{id:grant},template:shared}
      }
      return {grant:{id:grant}}
    },
    async del(path) {
      calls.push(['DELETE',path])
      return path.startsWith(accessPath+'/') ? {revoked:true} : {grant:{id:grant,state:'revoked'}}
    },
  }
  setSharedBotSocial(connector)
  t.after(() => setSharedBotSocial(undefined))
  const routes = agentCopyRoutes({},{
    'personal-binding':async () => ({workspace_id:workspace}),
    async get({workspace_id,id}) {
      assert.deepEqual([workspace_id,id],[workspace,agent])
      return {agent:saved}
    },
    async createRemix(payload,access) {
      calls.push(['CREATE',payload,access])
      return {status:201,agent:{id:'e'.repeat(32),name:payload.name}}
    },
  })
  const v1 = createV1Endpoint({feature:'agents',routes,context:{}})
  const request = (method,path,body) => v1({method,path,body,idempotency_key:key})
  return {request,calls,revoke:() => {revoked = true}}
}

test('agent share sends fields from the saved owner revision and scopes sender revocation', async t => {
  const f = fixture(t)
  const send = {recipient_owner_id:'recipient',share_instructions:false,share_quick_starts:true,revision:6}
  assert.equal((await f.request('POST',source,{...send,instructions:'Forged content'})).status,400)
  assert.equal((await f.request('POST',source,{...send,revision:5})).status,409)
  assert.deepEqual(f.calls,[])
  assert.equal((await f.request('POST',source,send)).status,201)
  const [method,path,saved] = f.calls.pop()
  assert.deepEqual([method,path],['POST',shares])
  assert.deepEqual(saved,{
    recipient_owner_id:'recipient',source_agent_id:agent,client_key:key,
    share_instructions:false,share_quick_starts:true,
    template:{name:'Local agent',summary:'Notes',category:'research',quick_starts:['Plan a study']},
  })
  await f.request('GET',source+'?limit=10')
  assert.equal(f.calls.pop()[1],shares+'?limit=10&direction=sent&source_agent_id='+agent)
  assert.equal((await f.request('POST',source+'/'+grant+'/revoke',{})).body.grant.state,'revoked')
  assert.deepEqual(f.calls.pop(),['DELETE',shares+'/'+grant+'?source_agent_id='+agent])
})

test('private copy authorizes the exact recipient revision before creating in their personal runtime', async t => {
  const f = fixture(t)
  const copy = {revision,name:'Personal copy'}
  assert.equal((await f.request('POST',incoming,{...copy,workspace_id:'f'.repeat(32)})).status,403)
  assert.deepEqual(f.calls,[])
  const result = await f.request('POST',incoming,copy)
  assert.equal(result.status,201)
  assert.equal(result.body.agent.workspace_id,workspace)
  assert.deepEqual(f.calls,[
    ['POST',shares+'/'+grant+'/claim',{revision}],
    ['CREATE',{workspace_id:workspace,idempotency_key:key,name:'Personal copy',summary:'Notes',category:'research',
      instructions:'',quick_starts:['Plan a study']},{internal:true,source:'agent-copy-grant:'+grant+':'+revision}],
  ])
  f.revoke()
  const denied = await f.request('POST',incoming,copy)
  assert.equal(denied.status,410)
  assert.equal(denied.body.error.code,'agent_copy_revoked')
  assert.equal(f.calls.filter(([method])=>method==='CREATE').length,1)
})

test('original agent access uses the saved version and preserves the existing conversation on replay', async t => {
  const f = fixture(t)
  const body = {recipient_owner_id:'recipient',revision:6}
  assert.equal((await f.request('POST',accessSource,{...body,name:'Forged name'})).status,400)
  assert.equal((await f.request('POST',accessSource,{...body,revision:5})).status,409)
  assert.deepEqual(f.calls,[])

  for (const expectedStatus of [201,200]) {
    const response = await f.request('POST',accessSource,body)
    assert.equal(response.status,expectedStatus)
    assert.deepEqual(response.body,{access:{conversation_id:conversation}})
    assert.deepEqual(f.calls.pop(),['POST',accessPath,{agent_id:agent,name:'Local agent',recipient_owner_id:'recipient'}])
  }

  await f.request('GET',accessSource+'?limit=10&after='+conversation)
  assert.deepEqual(f.calls.pop(),['GET',accessPath+'?limit=10&after='+conversation+'&agent_id='+agent])
  assert.deepEqual((await f.request('POST',accessSource+'/'+conversation+'/revoke',{})).body,{revoked:true})
  assert.deepEqual(f.calls.pop(),['DELETE',accessPath+'/'+conversation+'/'+agent])
})
