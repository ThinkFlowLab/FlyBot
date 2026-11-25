import { HEX32, digest, nowSeconds, refuse } from '../../featurekit/http.js'
import { TITLE_MAX } from './common.js'
import { createAction } from './extras.js'

async function personalWorkspace(host) {
  const binding = await host.call('agents/personal-binding', {})
  return HEX32.test(binding?.workspace_id) ? binding.workspace_id : null
}

export async function sharedMeetingActions({store, host}, source, call) {
  if (!call?.internal) refuse(404, 'not_found', 'Internal endpoint')
  const workspace = await personalWorkspace(host)
  if (!workspace) return []
  if (Array.isArray(source.actions)) {
    if (source.actions.length > 50) refuse(400, 'invalid', 'Too many shared action references')
    return store.all(`SELECT s.share_id, s.revision, s.action_index, a.id, a.workspace_id, a.status, a.revision AS action_revision
      FROM memory_shared_meeting_action_sources s JOIN memory_actions a ON a.id=s.action_id
      WHERE a.workspace_id=? AND s.workspace_id=? AND (s.share_id, s.revision, s.action_index) IN (
        SELECT json_extract(value,'$.share_id'), json_extract(value,'$.revision'), json_extract(value,'$.action_index')
        FROM json_each(?)
      )`, workspace, source.workspace_id, JSON.stringify(source.actions))
  }
  return store.all(`SELECT s.action_index AS "index", a.id, a.workspace_id, a.status, a.revision
    FROM memory_shared_meeting_action_sources s JOIN memory_actions a ON a.id=s.action_id
    WHERE a.workspace_id=? AND s.workspace_id=? AND s.share_id=? AND s.revision=?`,
  workspace, source.workspace_id, source.share_id, source.revision)
}

export async function saveSharedMeetingAction(context, payload, call) {
  if (!call?.internal) refuse(404, 'not_found', 'Internal endpoint')
  const {source, meeting, item} = payload
  const {store, host} = context
  const workspace = await personalWorkspace(host)
  if (!workspace) refuse(409, 'personal_workspace_required', '请先打开个人空间。')

  const text = item.text.trim()
  const line = text.replace(/\s+/g, ' ')
  const title = line.length > TITLE_MAX
    ? line.slice(0, TITLE_MAX - 1).replace(/[\uD800-\uDBFF]$/, '').trimEnd() + '…'
    : line
  const due = item.due_date && Date.parse(item.due_date) / 1000
  const due_at = Number.isInteger(due) && due >= 0 && due <= 2 ** 31 ? due : null
  const notes = [
    text !== title ? text : '',
    '来自「' + meeting + '」的共享纪要 · 版本 ' + source.revision,
    item.owner ? '原负责人 ' + item.owner : '',
    due_at === null && item.due_date ? '原截止日期 ' + item.due_date : '',
  ].filter(Boolean).join('\n')
  const {workspace_id, share_id, revision, action_index} = source
  const key = digest(`shared-meeting-action:${workspace_id}:${share_id}:${revision}:${action_index}`)
  return store.transaction(() => {
    const {status, action} = createAction({...context, now:nowSeconds()}, workspace, {title, notes, due_at}, key)
    if (status === 201) {
      store.run('INSERT INTO memory_shared_meeting_action_sources VALUES(?,?,?,?,?)',
        action.id, workspace_id, share_id, revision, action_index)
    }
    return {status, body:{action:{id:action.id, workspace_id:workspace, status:action.status, revision:action.revision}}}
  })
}
