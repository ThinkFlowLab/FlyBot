const groupId = /^otc_[0-9A-HJKMNP-TV-Z]{26}$/
const objectId = /^[0-9a-f]{32}$/
const path = '/v1/ot/group-directory'

function refuse(code, message) {
  throw Object.assign(new Error(message), {code:`bot/${code}`})
}

function fields(payload, allowed) {
  return payload && typeof payload === 'object' && !Array.isArray(payload) && Object.keys(payload).every(key => key === allowed)
}

export function nativeGroupDirectory(host, raw) {
  async function list(payload) {
    if (!fields(payload,'cursor') || (payload.cursor !== undefined &&
        (typeof payload.cursor !== 'string' || !groupId.test(payload.cursor)))) {
      refuse('invalid', 'Invalid shared group directory cursor')
    }
    const result = await raw.get(path + (payload.cursor ? '?cursor=' + encodeURIComponent(payload.cursor) : ''))
    if (!Array.isArray(result?.items) || result.items.length > 30 ||
        (result.next_cursor !== null && (typeof result.next_cursor !== 'string' || !groupId.test(result.next_cursor))) ||
        result.items.some(row => !row || typeof row.conversation_id !== 'string' || !groupId.test(row.conversation_id) ||
          typeof row.title !== 'string' || !['personal','team'].includes(row.kind))) {
      refuse('refused', 'Could not verify the shared group directory')
    }
    const binding = result.items.some(row => row.kind === 'personal') ? await host.call('agents/personal-binding', {}) : null
    const items = result.items.map(({conversation_id,title,kind,workspace_id,workspace_name}) => {
      const id = kind === 'personal' ? binding?.workspace_id : workspace_id
      return {conversation_id,title,kind,
        workspace_id:typeof id === 'string' && objectId.test(id) ? id : null,
        workspace_name:kind === 'team' && typeof workspace_name === 'string' ? workspace_name : null,
      }
    })
    return {items,next_cursor:result.next_cursor}
  }

  async function get(payload) {
    if (!fields(payload,'conversation_id') || typeof payload.conversation_id !== 'string' || !groupId.test(payload.conversation_id)) {
      refuse('invalid', 'Choose an exact shared group')
    }
    const id = payload.conversation_id
    let group
    try { group = await raw.get(path + '/' + encodeURIComponent(id)) }
    catch (error) {
      if (error?.code === 'social/conversation_not_found') refuse('not-found', 'This shared group is unavailable')
      throw error
    }
    if (group?.id !== id || group.kind !== 'group' || group.public_agent || !group.group_management ||
        (!group.team_id && group.account_group !== true)) {
      refuse('not-found', 'This shared group is unavailable')
    }
    return group
  }

  return {list,get}
}
