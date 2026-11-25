const objectId = /^[0-9a-f]{32}$/
const rosterId = /^[A-Za-z0-9._:-]{1,80}$/
const handle = /^[A-Za-z0-9._-]{1,80}$/
const conversationId = /^otc_[0-9A-HJKMNP-TV-Z]{26}$/
const requestKey = /^[A-Za-z0-9_-]{16,64}$/
const groupPath = '/v1/ot/conversations'

function refuse(code, message) {
  throw Object.assign(new Error(message), {code:`bot/${code}`})
}

export function nativeGroupCreation(host, raw, rt, sync) {
  const scopedBot = (bot, workspaceId) => bot && !bot.hidden && !bot.private && rosterId.test(bot.id || '') &&
    bot.flybotWorkspace?.workspace_id === workspaceId && objectId.test(bot.flybotWorkspace.agent_id || '')

  async function scopes() {
    const [binding, directory] = await Promise.all([
      host.call('agents/personal-binding', {}), raw.get('/v1/ot/workspaces'),
    ])
    if (!Array.isArray(directory?.workspaces)) refuse('refused', 'Could not verify shared workspaces')
    const workspaces = new Map()
    if (objectId.test(binding?.workspace_id || '')) {
      workspaces.set(binding.workspace_id, {workspace_id:binding.workspace_id,name:'Personal workspace',kind:'personal'})
    }
    for (const team of directory.workspaces) {
      const id = team?.workspace_id
      if (!objectId.test(id || '') || !rosterId.test(team.id || '') || typeof team.name !== 'string' || !team.name || workspaces.has(id)) continue
      workspaces.set(id,{workspace_id:id,name:team.name,kind:'team',team_id:team.id})
    }
    return workspaces
  }

  async function workspaces(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).length) {
      refuse('invalid', 'Unexpected workspace request parameters')
    }
    const bots = Object.values(rt.state.bots || {})
    return {workspaces:[...(await scopes()).values()].map(({workspace_id,name,kind}) => ({
      workspace_id,name,kind,bot_ids:bots.filter(bot => scopedBot(bot,workspace_id)).map(bot => bot.id),
    }))}
  }

  async function create(payload = {}) {
    const {workspace_id:workspaceId,title:rawTitle,bot_ids:botIds,request_key:key,member_handles:members = []} = payload || {}
    const title = typeof rawTitle === 'string' ? rawTitle.trim() : ''
    if (!payload || Array.isArray(payload) || Object.keys(payload).some(field => !['workspace_id','title','bot_ids','request_key','member_handles'].includes(field)) ||
        typeof workspaceId !== 'string' || !objectId.test(workspaceId) || !title || title.length > 80 || /[\u0000-\u001f\u007f]/.test(title) ||
        typeof key !== 'string' || !requestKey.test(key) || !Array.isArray(botIds) || botIds.length > 10 ||
        new Set(botIds).size !== botIds.length || botIds.some(id => typeof id !== 'string' || !rosterId.test(id)) ||
        !Array.isArray(members) || members.length > 49 || members.some(value => typeof value !== 'string' || !handle.test(value)) ||
        !(botIds.length + members.length)) {
      refuse('invalid','Choose a workspace, a group title and at least one eligible participant')
    }
    const scope = (await scopes()).get(workspaceId)
    if (!scope) refuse('not-found','This shared workspace is unavailable')
    const personal = scope.kind === 'personal'
    const agents = await Promise.all(botIds.map(async id => {
      const bot = rt.botOf(id)
      if (!scopedBot(bot,workspaceId)) refuse('not-found','A selected Bot is unavailable in this workspace')
      const {agent} = await host.call('agents/get',{workspace_id:workspaceId,id:bot.flybotWorkspace.agent_id})
      const current = rt.botOf(id)
      if (!agent || agent.workspace_id !== workspaceId || agent.native_bot_id !== id || agent.archived || agent.native_deleted ||
          !scopedBot(current,workspaceId) || current.flybotWorkspace.agent_id !== agent.id) {
        refuse('not-found','A selected Bot is unavailable in this workspace')
      }
      return {agent_ref:agent.id,name:agent.name.slice(0,40).toWellFormed()}
    }))
    const conversation = await raw.post(groupPath,{
      kind:'group',title,members,agents,idempotency_key:'native-group:' + key,
      ...(personal ? {account_group:true} : {team_id:scope.team_id}),
    })
    if (!conversationId.test(conversation?.id || '') || conversation.kind !== 'group' || conversation.public_agent ||
        (personal ? conversation.account_group !== true || conversation.team_id : conversation.team_id !== scope.team_id)) {
      refuse('refused','Could not verify the saved shared group')
    }
    let room = null
    try {
      const mapped = await sync(conversation)
      room = rt.roomOf(mapped.native_room_id) || null
    } catch {
      host.log?.('Native shared group was saved and will be projected on retry.')
    }
    return {conversation_id:conversation.id,room}
  }

  return {workspaces, create}
}
