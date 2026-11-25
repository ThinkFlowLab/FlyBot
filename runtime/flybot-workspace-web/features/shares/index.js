// Stream C: share a team run with a team. The run executes in this user's DS-Bot (features/team-runs);
// only a teammate-visible snapshot (title, goal, status, step names/outputs) is published to Bot Social.
import { sharedBotSocial, seg } from '../../lib/c/bot-social.js'
import { compatHandler } from '../../lib/b4/compat.js'
import { Fault } from '../../lib/b4/http.js'
import { wrap } from '../../lib/c/legacy-v1.js'
import { HEX32 } from '../../featurekit/http.js'
import { selectedResults, snapshotVersion, teamRunSource } from './team-run-source.js'

const RUN_ROUTE = /^\/v1\/workspaces\/([0-9a-f]{32})\/team-runs\/([0-9a-f]{32})\/share$/
const SHARED_LIST = /^\/v1\/workspaces\/([0-9a-f]{32})\/shared-runs$/
const SHARED_ITEM = /^\/v1\/workspaces\/([0-9a-f]{32})\/shared-runs\/(otsr_[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26})$/
const SHARED_REVOKE = /^\/v1\/workspaces\/([0-9a-f]{32})\/shared-runs\/(otsr_[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26})\/revoke$/
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled'])

function snapshotOf(run) {
  return {
    progress: run.progress ?? null,
    steps: (run.steps ?? []).map(step => {
      const output = String(step.output ?? '')
      return {position: step.position, agent_name: step.agent_name, status: step.status,
        output: output.length > 2000 ? output.slice(0, 1999) + '…' : output}
    }),
  }
}

export default function shares(host) {
  const bs = () => sharedBotSocial(host)
  const path = (p) => `/v1/ot/teams/${seg(p?.team_id, 'team_id')}/shared-runs`
  async function sharedPath(workspaceId, client) {
    const binding = await host.call('agents/personal-binding', {})
    if (binding?.workspace_id === workspaceId) throw new Fault(404, 'not_found', '请选择团队工作区。')
    const team = await client.get('/v1/ot/teams/by-workspace/' + workspaceId)
    if (team?.workspace_id !== workspaceId) throw new Fault(404, 'not_found', '找不到此团队。')
    return path({team_id: team.id})
  }
  const published = (run) => ({
    run_ref: run.id, title: run.title, goal: run.goal, status: run.status, snapshot: snapshotOf(run),
  })
  function display(row, viewer, detail = false) {
    const own = viewer && row.owner?.owner_id === viewer
    return {
      id: row.id, title: row.title, status: row.status, created_at: row.created_at, updated_at: row.updated_at,
      author: row.owner?.display_name || row.owner?.handle || '', own: Boolean(own),
      ...(own && HEX32.test(row.run_ref || '') ? {run_id: row.run_ref} : {}),
      ...(detail ? {goal: row.goal, snapshot: row.snapshot, source_version: snapshotVersion(row)} : {}),
    }
  }
  return {
    endpoints: {
      v1: compatHandler([
        { method: 'POST', path: RUN_ROUTE, handle: ({match}) => wrap(async () => {
          const [, workspaceId, id] = match
          const client = bs()
          const {run} = await host.call('team-runs/get', {workspace_id: workspaceId, id})
          if (!run || run.id !== id || run.workspace_id !== workspaceId) throw new Fault(404, 'not_found', '找不到这项任务。')
          if (!TERMINAL.has(run.status)) throw new Fault(409, 'conflict', '任务结束后可以共享结果。')
          const target = await sharedPath(workspaceId, client)
          const row = await client.put(target, published(run))
          return [200, {share: display(row, row.owner?.owner_id, true)}]
        }) },
        { method: 'GET', path: SHARED_LIST, handle: ({match}) => wrap(async () => {
          const client = bs()
          const target = await sharedPath(match[1], client)
          const [me, rows] = await Promise.all([client.get('/v1/ot/me'), client.get(target + '?summary=1')])
          return [200, {items: (rows.runs ?? []).map(row => display(row, me.owner_id))}]
        }) },
        { method: 'GET', path: SHARED_ITEM, handle: ({match}) => wrap(async () => {
          const client = bs()
          const target = await sharedPath(match[1], client)
          const [me, row] = await Promise.all([client.get('/v1/ot/me'), client.get(target + '/' + match[2])])
          return [200, {share: display(row, me.owner_id, true)}]
        }) },
        { method: 'POST', path: SHARED_REVOKE, handle: ({match}) => wrap(async () => {
          const client = bs()
          const target = await sharedPath(match[1], client)
          return [200, await client.del(target + '/' + match[2])]
        }) },
      ]),
      async teamRunContext(p, call) {
        if (!call?.internal) throw new Fault(404, 'not_found', 'Internal endpoint')
        const source = teamRunSource(p?.source)
        if (!source || typeof p?.workspace_id !== 'string' || !HEX32.test(p.workspace_id)) {
          throw new Fault(400, 'invalid', 'Invalid shared result reference')
        }
        const client = bs()
        const target = await sharedPath(p.workspace_id, client)
        const row = await client.get(target + '/' + source.id)
        if (row?.id !== source.id || !TERMINAL.has(row.status) || source.version !== snapshotVersion(row)) {
          throw new Fault(409, 'source_changed', '共享结果已更新，请重新打开并选择步骤结果。')
        }
        const results = selectedResults(row, source)
        if (!results) throw new Fault(400, 'invalid', '请选择有输出的已完成步骤。')
        return results
      },
      async publish(p, call) {
        const caller = call?.host ?? host
        const { run } = await caller.call('team-runs/get', { id: p?.run_id, workspace_id: p?.workspace_id })
        return bs().put(path(p), published(run))
      },
      list: async (p) => bs().get(path(p)),
      get: async (p) => bs().get(`${path(p)}/${seg(p?.share_id, 'share_id')}`),
      unshare: async (p) => bs().del(`${path(p)}/${seg(p?.share_id, 'share_id')}`),
    },
  }
}
