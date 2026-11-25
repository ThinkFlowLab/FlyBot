// Home summaries read actual per-user feature stores and Bot Social, not the
// management DB's obsolete copies. Counts traverse the real bounded collections.
import { compatHandler } from '../../lib/b4/compat.js'
import { Fault } from '../../lib/b4/http.js'
import { sharedBotSocial } from '../../lib/c/bot-social.js'
import { wrap } from '../../lib/c/legacy-v1.js'

export default function overview(host) {
  async function read(feature, path) {
    const out = await host.call(feature + '/v1', {method:'GET', path})
    if (out.status !== 200) {
      throw new Fault(out.status || 503, out.body?.error?.code || 'unavailable', out.body?.error?.message || 'Summary source unavailable')
    }
    return out.body
  }

  async function collection(feature, wid) {
    const rows = [], seen = new Set()
    let cursor = ''
    do {
      const page = await read(feature, `/v1/workspaces/${wid}/${feature}?limit=50${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`)
      rows.push(...(page.items || []))
      cursor = page.cursor
      if (cursor && seen.has(cursor)) throw new Fault(503, 'invalid_cursor', 'Summary source repeated a cursor')
      seen.add(cursor)
    } while (cursor)
    return rows
  }
  const summary = async (wid, limit) => {
    const binding = await host.call('agents/personal-binding', {})
    let workspace = {id:wid, name:'个人空间', kind:'personal'}
    if (binding?.workspace_id !== wid) {
      const team = await wrap(() => sharedBotSocial(host).get('/v1/ot/teams/by-workspace/' + wid))
      workspace = {id:wid, name:team.name, kind:team.kind || (team.slug ? 'team' : 'workspace')}
    }
    const path = '/v1/workspaces/' + wid
    const [agents, artifacts, meetings, automations, social, notices] = await Promise.all([
      host.call('agents/workspaceOverview', {workspace_id:wid, limit}),
      collection('artifacts', wid), collection('meetings', wid),
      host.call('automations/list', {workspace_id:wid}),
      read('messenger', path + '/social/conversations'),
      read('social', path + '/notifications?limit=1&filter=unread'),
    ])
    const shared = social.items.map(({id,title,kind,members,preview,updated,unread_count}) => ({
      id,title,kind,members,preview,updated,unread_count,source:'social',
    }))
    return { workspace, recent_conversations:[...agents.items,...shared], recent_artifacts:artifacts, recent_meetings:meetings,
      counts: { agents:agents.count, artifacts:artifacts.length, meetings:meetings.length, automations:automations.items.length },
      unread_notifications:notices.unread_count }
  }
  return { endpoints: { v1: compatHandler([{ method: 'GET', path: /^\/v1\/workspaces\/([0-9a-f]{32})\/overview$/,
    async handle({ match, query }) {
      const q = new URLSearchParams(query), limit = Number(q.get('limit') || 5)
      if ([...q.keys()].some(k => k !== 'limit') || q.getAll('limit').length > 1 || !Number.isInteger(limit) || limit < 1 || limit > 10) throw new Fault(400, 'invalid', 'Provide a limit from 1 to 10')
      const data = await summary(match[1], limit)
      const recent = rows => rows.sort((a,b) => (b.updated || b.created || 0) - (a.updated || a.created || 0)).slice(0,limit)
      return [200, { ...data, recent_conversations: recent(data.recent_conversations), recent_artifacts: recent(data.recent_artifacts), recent_meetings: recent(data.recent_meetings), limit }]
    } }]) } }
}
