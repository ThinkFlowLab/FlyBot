import { refuse } from '../../featurekit/http.js'
import { sharedBotSocial } from '../../lib/c/bot-social.js'

export const CALL_ID = /^otcav_[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/

export async function callSource(req, workspaceId, id) {
  if (typeof id !== 'string' || !CALL_ID.test(id)) refuse(400, 'invalid', '无效的通话编号。')
  const binding = await req.host.call('agents/personal-binding', {}).catch(() => null)
  if (binding?.workspace_id !== workspaceId) {
    const teams = await req.host.call('teams/activeWorkspaces', {}).catch(() => [])
    if (!Array.isArray(teams) || !teams.some(team => team.id === workspaceId)) refuse(404, 'not_found', '无法访问此工作区。')
  }
  let record
  try {
    ({record} = await sharedBotSocial(req.host).get('/v1/ot/call-records/' + id))
  } catch (error) {
    if (error?.status === 404) refuse(404, 'call_record_not_found', '找不到可用于纪要的通话。')
    if (error?.status === 409 && error.code === 'social/meeting_call_active') {
      refuse(409, 'meeting_call_active', '通话结束后可以整理纪要。')
    }
    refuse(503, 'call_record_unavailable', '暂时无法读取通话信息。')
  }
  if (record?.id !== id || typeof record.title !== 'string' || !['audio','video'].includes(record.kind)
      || !Number.isSafeInteger(record.started_at) || !Number.isSafeInteger(record.ended_at)
      || record.started_at < 0 || record.ended_at < record.started_at || !Array.isArray(record.attendees)) {
    refuse(503, 'call_record_unavailable', '暂时无法读取通话信息。')
  }
  const names = new Map()
  for (const value of record.attendees.slice(0, 50)) {
    if (typeof value !== 'string') continue
    const name = value.trim().slice(0, 80).toWellFormed()
    const key = name.toLocaleLowerCase('en-US')
    if (name && !names.has(key)) names.set(key, name)
  }
  return {id, title: record.title, kind: record.kind, started_at: Math.floor(record.started_at / 1000),
    ended_at: Math.floor(record.ended_at / 1000), attendees: [...names.values()]}
}
