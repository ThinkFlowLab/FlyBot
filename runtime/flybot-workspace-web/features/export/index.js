// #402: a workspace export is a read-only aggregation over the user's own
// feature stores. Nothing is written here and no table is created — the feature
// reads artifacts, memory pages and agents through `host.call` and projects them
// onto one manifest, so a bundle can never contain something the caller cannot
// already see in the same DS-Bot.
//
import { compatHandler } from '../../lib/b4/compat.js'
import { Fault } from '../../lib/b4/http.js'

export const EXPORT_TYPES = ['artifacts', 'memory', 'agents']
export const FORMAT = 'flybot-workspace.workspace.export'
export const VERSION = 1
export const MAX_LIMIT = 200
// Rows read per type for one request. Past this the request is refused instead
// of buffering a whole workspace: paging with ?type= keeps every request bounded.
export const MAX_SCAN = 1000
const DEFAULT_LIMIT = 50
const SOURCE_PAGE = 100
const MEMORY_PROVIDER_CAP = 500
const MAX_TITLE = 200

const text = value => typeof value === 'string' ? value.slice(0, MAX_TITLE) : ''
const stamp = value => Number.isFinite(value) ? Math.floor(value) : 0
const byNewest = (a, b) => (b.updated - a.updated) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

// The export contract is this whitelist, not a deny-list someone has to keep in
// sync with every new column: a row may carry tokens, api keys, invite codes or
// another member's free text, and none of it is copied out of the store.
const project = {
  artifacts: row => ({ type: 'artifacts', id: String(row?.id ?? ''), title: text(row?.title), updated: stamp(row?.updated ?? row?.created) }),
  memory: row => ({ type: 'memory', id: String(row?.id ?? ''), title: text(row?.title), updated: stamp(row?.updated) }),
  agents: row => ({ type: 'agents', id: String(row?.id ?? ''), title: text(row?.name ?? row?.title), updated: stamp(row?.updated) }),
}

// The manifest for one page. Pure: the same rows in always give the same bytes
// out, which is what makes the export checkable in a test.
export function exportPage({ workspace, artifacts = [], memory = [], agents = [], truncated = {} }, { type = 'all', cursor = 0, limit = DEFAULT_LIMIT } = {}) {
  const rows = { artifacts, memory, agents }
  const selected = type === 'all' ? EXPORT_TYPES : [type]
  const groups = selected.map(kind => ({
    type: kind,
    total: rows[kind].length,
    entries: rows[kind].map(project[kind]).filter(entry => entry.id).sort(byNewest),
  }))
  const counts = { artifacts: 0, memory: 0, agents: 0 }
  for (const group of groups) counts[group.type] = group.total
  counts.total = groups.reduce((sum, group) => sum + group.total, 0)
  const flat = groups.flatMap(group => group.entries)
  const window = flat.slice(cursor, cursor + limit)
  const next = cursor + window.length
  return {
    format: FORMAT,
    version: VERSION,
    workspace_id: workspace,
    counts,
    groups: groups.map(group => ({ type: group.type, total: group.total, entries: window.filter(entry => entry.type === group.type) })),
    page: { type, limit, cursor, next_cursor: next < flat.length ? next : null, returned: window.length },
    truncated,
  }
}

function readQuery(query) {
  const q = new URLSearchParams(query)
  for (const key of q.keys()) {
    if (!['type', 'limit', 'cursor'].includes(key)) throw new Fault(400, 'invalid', 'Unknown export parameter')
    if (q.getAll(key).length > 1) throw new Fault(400, 'invalid', 'Repeated export parameter')
  }
  const type = q.get('type') ?? 'all'
  if (!['all', ...EXPORT_TYPES].includes(type)) throw new Fault(400, 'invalid', 'Provide a known export type')
  const rawLimit = q.get('limit') ?? String(DEFAULT_LIMIT)
  const limit = Number(rawLimit)
  if (!/^\d+$/.test(rawLimit) || !Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new Fault(400, 'invalid', `Provide a limit from 1 to ${MAX_LIMIT}`)
  }
  const rawCursor = q.get('cursor') ?? '0'
  const cursor = Number(rawCursor)
  if (!/^\d+$/.test(rawCursor) || !Number.isInteger(cursor) || cursor < 0) throw new Fault(400, 'invalid', 'Provide a cursor from 0 upward')
  return { type, cursor, limit }
}

export default function exportFeature(host, { maxScan = MAX_SCAN } = {}) {
  // Only a workspace this account belongs to can be exported; anything else is
  // the same 404 as an unknown id, so the endpoint cannot probe other accounts.
  async function workspaceOr404(workspace) {
    const binding = await host.call('agents/personal-binding', {})
    if (binding?.workspace_id === workspace) return
    const teams = await host.call('teams/activeWorkspaces', {}).catch(() => {
      throw new Fault(503, 'unavailable', 'Workspace membership is unavailable')
    })
    if (Array.isArray(teams) && teams.some(team => team?.id === workspace)) return
    throw new Fault(404, 'workspace/not-found', 'No such workspace for this account')
  }

  async function artifactsOf(workspace) {
    const rows = [], seen = new Set()
    let cursor = ''
    do {
      const out = await host.call('artifacts/v1', { method: 'GET', path: `/v1/workspaces/${workspace}/artifacts?limit=${SOURCE_PAGE}${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}` })
      if (out?.status !== 200) throw new Fault(out?.status || 503, out?.body?.error?.code || 'unavailable', out?.body?.error?.message || 'The artifacts store is unavailable')
      rows.push(...(out.body?.items || []))
      if (rows.length > maxScan) {
        throw new Fault(400, 'export/too-large', `The workspace has more than ${maxScan} artifacts rows; the export scans at most ${maxScan} rows per type per request (shipped cap ${MAX_SCAN} rows)`)
      }
      cursor = out.body?.cursor || ''
      if (cursor && seen.has(cursor)) throw new Fault(503, 'invalid_cursor', 'The artifacts store repeated a cursor')
      seen.add(cursor)
    } while (cursor)
    return rows
  }

  // memory/pages caps itself at 500 rows; reading it whole is the bound.
  async function memoryOf(workspace) {
    const rows = await readSource('memory/pages', { workspace_id: workspace })
    if (!Array.isArray(rows)) throw new Fault(503, 'unavailable', 'The memory store is unavailable')
    return { rows, truncated: rows.length >= MEMORY_PROVIDER_CAP }
  }

  async function readSource(endpoint, payload) {
    try {
      return await host.call(endpoint, payload)
    } catch (error) {
      if (error?.status === 404) throw new Fault(404, 'workspace/not-found', 'No such workspace for this account')
      throw new Fault(503, 'unavailable', 'A workspace export source is unavailable')
    }
  }

  async function agentsOf(workspace) {
    const out = await readSource('agents/workspaceExportRows', { workspace_id: workspace, limit: MAX_SCAN })
    if (!Array.isArray(out?.items)) throw new Fault(503, 'unavailable', 'The agents store is unavailable')
    return out
  }

  return {
    endpoints: {
      v1: compatHandler([
        { method: 'GET', path: /^\/v1\/workspaces\/([0-9a-f]{32})\/export$/,
          async handle({ match, query }) {
            const options = readQuery(query)
            const workspace = match[1]
            await workspaceOr404(workspace)
            const wants = kind => options.type === 'all' || options.type === kind
            const [artifacts, memory, agents] = await Promise.all([
              wants('artifacts') ? artifactsOf(workspace) : [],
              wants('memory') ? memoryOf(workspace) : { rows: [], truncated: false },
              wants('agents') ? agentsOf(workspace) : { items: [], truncated: false },
            ])
            const truncated = {
              ...(memory.truncated ? {memory: true} : {}),
              ...(agents.truncated ? {agents: true} : {}),
            }
            return [200, exportPage({ workspace, artifacts, memory: memory.rows, agents: agents.items, truncated }, options)]
          } },
      ]),
    },
  }
}
