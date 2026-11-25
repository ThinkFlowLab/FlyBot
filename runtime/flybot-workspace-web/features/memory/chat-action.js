import { digest, HEX32, idempotencyKey, refuse, requireBodyKeys } from '../../featurekit/http.js'
import { sharedBotSocial } from '../../lib/c/bot-social.js'
import { personalMemoryWorkspace, requireMemoryWorkspace } from './access.js'
import { actionView, createAction } from './extras.js'

const ROOM = /^otc_[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/
const MESSAGE = /^otm_[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/

function chatSource(body) {
  const source = requireBodyKeys(body, ['kind','workspace_id','conversation_id','message_id','agent_id','revision'])
  const {kind,workspace_id,conversation_id,message_id,agent_id,revision} = source
  const agent = kind === 'agent' && [agent_id,conversation_id,message_id].every(id => typeof id === 'string' && HEX32.test(id))
    && revision === undefined
  const social = kind === 'social' && typeof conversation_id === 'string' && ROOM.test(conversation_id)
    && typeof message_id === 'string' && MESSAGE.test(message_id) && agent_id === undefined
    && Number.isSafeInteger(revision) && revision > 0
  if (typeof workspace_id !== 'string' || !HEX32.test(workspace_id) || (!agent && !social)) {
    refuse(400, 'invalid', '请选择有效的文字消息。')
  }
  return source
}

async function verifySource(host, personal, source) {
  const {kind,workspace_id:workspace,conversation_id:conversation,message_id:message,revision} = source
  if (kind === 'agent') {
    await requireMemoryWorkspace(host, workspace)
    try {
      if (await host.call('agents/actionSource', source) !== true) refuse(404, 'not_found', '无法访问原消息。')
    } catch (error) {
      if (error?.status === 409) refuse(409, 'source_changed', '只能从可用的已完成文字消息创建行动。')
      if ([403,404].includes(error?.status)) refuse(404, 'not_found', '无法访问原消息。')
      throw error
    }
    return
  }
  const social = sharedBotSocial(host)
  let current
  try {
    if (workspace === personal) {
      const room = await social.get('/v1/ot/conversations/' + conversation)
      if (room.public_agent || !(room.account_group || room.direct)) refuse(404, 'not_found', '无法访问原消息。')
      current = await social.get(`/v1/ot/messages/${message}?conversation_id=${conversation}`)
    } else {
      current = await social.get(`/v1/ot/workspaces/${workspace}/conversations/${conversation}/messages/${message}`)
    }
  } catch (error) {
    if (error?.status === 409) refuse(409, 'source_changed', '原消息已发生变化，请重新选择。')
    if ([403,404].includes(error?.status)) refuse(404, 'not_found', '无法访问原消息。')
    throw error
  }
  if (current.revision !== revision || current.retracted || typeof current.body !== 'string' || !current.body.trim()
      || current.attachment || current.voice) {
    refuse(409, 'source_changed', '原消息已发生变化，请重新选择。')
  }
}

export const chatActionRoutes = [{
  pattern: /^\/v1\/workspaces\/([0-9a-f]{32})\/memory\/actions\/from-chat$/,
  async handle(req, workspace) {
    if (req.method !== 'POST') refuse(405, 'method', 'Only POST is supported')
    if (req.queryString) refuse(400, 'invalid', 'Invalid chat action request')
    const personal = await personalMemoryWorkspace(req.host)
    if (!personal || workspace !== personal) refuse(404, 'not_found', '请选择你的个人工作区。')
    idempotencyKey(req.headers)
    const {source:input,title,notes} = requireBodyKeys(await req.json(8192), ['source','title','notes'])
    const source = chatSource(input)
    const {kind,workspace_id,conversation_id,message_id,agent_id,revision} = source
    const key = digest('memory-action-chat:' + JSON.stringify([kind,workspace_id,conversation_id,message_id,agent_id]))
    const find = () => req.store.get('SELECT * FROM memory_actions WHERE workspace_id=? AND key_hash=?', workspace, key)
    const replay = row => ({body:{action:actionView(req.store,row)}})
    const prior = find()
    if (prior) return replay(prior)
    await verifySource(req.host, personal, source)
    return req.store.transaction(() => {
      const createdMeanwhile = find()
      if (createdMeanwhile) return replay(createdMeanwhile)
      const {status,action} = createAction(req, workspace, {title,notes}, key)
      req.store.run('INSERT INTO memory_chat_action_sources VALUES(?,?,?,?,?,?,?)',
        action.id, kind, workspace_id, conversation_id, message_id, agent_id ?? null, revision ?? null)
      return {status,body:{action:{...action,source_chat:source}}}
    })
  },
}]
