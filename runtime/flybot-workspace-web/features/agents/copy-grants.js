import { FeatureError, idempotencyKey, requireBodyKeys } from '../../featurekit/http.js'
import { sharedBotSocial } from '../../lib/c/bot-social.js'

const SHARES = '/v1/ot/agent-copy-grants'
const ACCESS = '/v1/ot/agent-access'
const ID = '([0-9a-f]{32})'
const GRANT = '(otag_[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26})'
const DM = '(otc_[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26})'
const REVISION = /^[0-9a-f]{64}$/

const method = (request, allowed) => {
  if (!allowed.includes(request.method)) throw new FeatureError(405,'method','Unsupported agent share action')
}

function paging(request, extras = []) {
  const allowed = new Set(['after','limit',...extras])
  if ([...request.query.keys()].some(key => !allowed.has(key) || request.query.getAll(key).length !== 1)) {
    throw new FeatureError(400,'invalid','Invalid agent share filters')
  }
  return new URLSearchParams(request.query)
}

function noQuery(request) {
  if (request.query.size) throw new FeatureError(400,'invalid','Unexpected agent share parameters')
}

function route(pattern, fn) {
  return { pattern, async handle(...args) {
    try {
      return await fn(...args)
    } catch (error) {
      if (error instanceof FeatureError) throw error
      const status = error?.status ?? 503
      const code = String(error?.code || 'unavailable').split('/').pop().replace(/-/g,'_')
      throw new FeatureError(status, code, status >= 500 ? 'Agent sharing is temporarily unavailable' : error.message)
    }
  } }
}

export function agentCopyRoutes(host, endpoints) {
  const social = () => sharedBotSocial(host)
  const scoped = `^/v1/workspaces/${ID}/agents/${ID}`
  const list = query => social().get(SHARES + (query.size ? '?' + query : ''))
  const ownAgent = (workspace, id) => endpoints.get({workspace_id:workspace,id}).then(({agent}) => agent)
  const personalWorkspace = async () => (await endpoints['personal-binding']())?.workspace_id
  async function savedActiveAgent(workspace, id, revision) {
    if (await personalWorkspace() !== workspace) await social().get('/v1/ot/teams/by-workspace/'+workspace)
    const agent = await ownAgent(workspace,id)
    if (agent.archived || agent.native_deleted) throw new FeatureError(404,'not_found','Agent is unavailable')
    if (agent.revision !== revision) throw new FeatureError(409,'agent_changed','Agent changed; reopen sharing to review it')
    return agent
  }
  return [
    route(/^\/v1\/agent-copy-grants\/recipients$/, async request => {
      method(request,['GET'])
      const query = paging(request)
      return {body:await social().get(SHARES+'/recipients'+(query.size ? '?'+query : ''))}
    }),
    route(/^\/v1\/agent-copy-grants$/, async request => {
      method(request,['GET'])
      const query = paging(request,['direction'])
      const direction = query.get('direction') ?? 'received'
      if (direction !== 'received' && direction !== 'sent') throw new FeatureError(400,'invalid','Invalid agent share direction')
      query.set('direction',direction)
      return {body:await list(query)}
    }),
    route(new RegExp(scoped+'/shares$'), async (request, workspace, id) => {
      method(request,['GET','POST'])
      if (request.method === 'GET') {
        const query = paging(request)
        await ownAgent(workspace,id)
        query.set('direction','sent')
        query.set('source_agent_id',id)
        return {body:await list(query)}
      }
      noQuery(request)
      const body = requireBodyKeys(await request.json(1024),['recipient_owner_id','share_instructions','share_quick_starts','revision'])
      if (typeof body.recipient_owner_id !== 'string' || !/^[A-Za-z0-9._-]{1,80}$/.test(body.recipient_owner_id)
        || typeof body.share_instructions !== 'boolean' || typeof body.share_quick_starts !== 'boolean'
        || !Number.isSafeInteger(body.revision) || body.revision < 1) {
        throw new FeatureError(400,'invalid','Choose a recipient and the agent content to share')
      }
      const key = idempotencyKey(request.headers)
      const agent = await savedActiveAgent(workspace,id,body.revision)
      const template = {name:agent.name,summary:agent.summary,category:agent.category,
        ...(body.share_instructions ? {instructions:agent.instructions} : {}),
        ...(body.share_quick_starts ? {quick_starts:agent.quick_starts} : {}),
      }
      return {status:201,body:await social().post(SHARES,{
        recipient_owner_id:body.recipient_owner_id, source_agent_id:id, client_key:key, template,
        share_instructions:body.share_instructions, share_quick_starts:body.share_quick_starts,
      })}
    }),
    route(new RegExp(scoped+'/shares/'+GRANT+'/revoke$'), async (request,workspace,id,grant) => {
      method(request,['POST'])
      noQuery(request)
      requireBodyKeys(await request.json(128),[])
      await ownAgent(workspace,id)
      return {body:await social().del(SHARES+'/'+grant+'?source_agent_id='+id)}
    }),
    route(new RegExp(scoped+'/access$'), async (request,workspace,id) => {
      method(request,['GET','POST'])
      if (request.method === 'GET') {
        const query = paging(request)
        await ownAgent(workspace,id)
        query.set('agent_id',id)
        return {body:await social().get(ACCESS+'?'+query)}
      }
      noQuery(request)
      const body = requireBodyKeys(await request.json(1024),['recipient_owner_id','revision'])
      if (typeof body.recipient_owner_id !== 'string' || !/^[A-Za-z0-9._-]{1,80}$/.test(body.recipient_owner_id)
        || !Number.isSafeInteger(body.revision) || body.revision < 1) {
        throw new FeatureError(400,'invalid','Choose a recipient for the current agent version')
      }
      const agent = await savedActiveAgent(workspace,id,body.revision)
      const result = await social().post(ACCESS,{
        agent_id:id, name:agent.name.slice(0,40).toWellFormed(), recipient_owner_id:body.recipient_owner_id,
      })
      return {status:result.created === false ? 200 : 201,body:{access:result.access}}
    }),
    route(new RegExp(scoped+'/access/'+DM+'/revoke$'), async (request,workspace,id,conversation) => {
      method(request,['POST'])
      noQuery(request)
      requireBodyKeys(await request.json(128),[])
      await ownAgent(workspace,id)
      return {body:await social().del(ACCESS+'/'+conversation+'/'+id)}
    }),
    route(new RegExp('^/v1/agent-copy-grants/'+GRANT+'/remix$'), async (request,grant) => {
      method(request,['GET','POST'])
      noQuery(request)
      const path = SHARES+'/'+grant
      if (request.method === 'GET') return {body:await social().get(path)}
      const body = requireBodyKeys(await request.json(1024),['revision','name','workspace_id'])
      if (typeof body.revision !== 'string' || !REVISION.test(body.revision)
        || (body.name !== undefined && (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length>80))) {
        throw new FeatureError(400,'invalid','Review the shared agent and give the copy a valid name')
      }
      const key = idempotencyKey(request.headers)
      const workspace = await personalWorkspace()
      if (!workspace || (body.workspace_id !== undefined && body.workspace_id !== workspace)) {
        throw new FeatureError(403,'forbidden','Copy the shared agent into your personal workspace')
      }
      const {template} = await social().post(path+'/claim',{revision:body.revision})
      if (!template || template.revision !== body.revision) {
        throw new FeatureError(409,'agent_copy_changed','The shared template changed; open it again')
      }
      const result = await endpoints.createRemix({
        workspace_id:workspace,idempotency_key:key,name:body.name ?? template.name,
        summary:template.summary,category:template.category,instructions:template.instructions,quick_starts:template.quick_starts,
      },{internal:true,source:'agent-copy-grant:'+grant+':'+body.revision})
      return {status:result.status,body:{agent:{id:result.agent.id,name:result.agent.name,workspace_id:workspace}}}
    }),
  ]
}
