// #402 in the DS-Bot shape: the workspace export is a read-only aggregation of
// the user's own feature stores. There is no table here — the feature reads
// artifacts, memory pages and agents through `host.call` and returns one
// manifest, so the bundle is always the data the caller can already see.
//
// The page surface does not exist yet: no page calls this endpoint, which is why
// the slice stops at the API and says so in the PR body.
import assert from 'node:assert/strict'
import test from 'node:test'
import { bootMemory, key } from './helpers.js'
import { nativeAgentFixture } from './native-agent-fixture.js'
import { attachRuntime, detachRuntime } from '../src/host.js'
import { LEGACY_PATH } from '../src/dispatch.js'
import exportFeature, { EXPORT_TYPES, MAX_LIMIT, exportPage } from '../features/export/index.js'

const WS = 'a'.repeat(32)
const OTHER = 'b'.repeat(32)
const PATH = `/v1/workspaces/${WS}/export`

// Rows as the real providers hand them over: the feature stores real columns,
// including credential-adjacent ones the export must never carry.
const artifacts = () => [
  { id: 'art-2', kind: 'slides', title: '二季度复盘', updated: 200, token: 'tok_live_do_not_export', owner: 'someone-else' },
  { id: 'art-1', kind: 'document', title: '周报', updated: 300, api_key: 'sk-should-never-appear' },
]
const memory = () => [
  { id: 'mem-1', workspace_id: WS, revision: 3, title: '团队约定', body: '内部正文', updated: 250 },
  { id: 'mem-2', workspace_id: WS, revision: 1, title: '旧页', body: '旧正文', updated: 100 },
]
const agents = () => [
  { id: 'agt-1', name: '研究员', workspace_id: WS, updated: 400, invite_code: 'invite-abc', archived: 0 },
]

function host({ binding = { workspace_id: WS }, teams = [{ id: WS, name: '我的工作区' }], artifactsPages = null, calls = [] } = {}) {
  return {
    calls,
    call: async (name, payload) => {
      calls.push([name, payload])
      if (name === 'agents/personal-binding') return binding
      if (name === 'teams/activeWorkspaces') return teams
      if (name === 'agents/workspaceExportRows') return { items: agents() }
      if (name === 'memory/pages') return memory()
      if (name === 'artifacts/v1') {
        const pages = artifactsPages || [{ status: 200, body: { items: artifacts(), cursor: null } }]
        const index = Number(new URLSearchParams(payload.path.split('?')[1] || '').get('cursor') || 0)
        return pages[index] ?? { status: 200, body: { items: [], cursor: null } }
      }
      throw new Error('unexpected endpoint ' + name)
    },
  }
}

const get = async (H, query = '', options) => (await exportFeature(H, options).endpoints.v1({ method: 'GET', path: PATH, query })).body
const status = async (H, query = '', options) => (await exportFeature(H, options).endpoints.v1({ method: 'GET', path: PATH, query })).status

test('one call returns a manifest with per-type counts, grouped and stably sorted', async () => {
  const body = await get(host())
  assert.equal(body.format, 'flybot-workspace.workspace.export')
  assert.equal(body.version, 1)
  assert.equal(body.workspace_id, WS)
  assert.deepEqual(body.counts, { artifacts: 2, memory: 2, agents: 1, total: 5 })
  assert.deepEqual(body.groups.map(group => group.type), EXPORT_TYPES)
  assert.deepEqual(body.groups.map(group => group.total), [2, 2, 1])
  assert.deepEqual(body.groups[0].entries.map(entry => entry.id), ['art-1', 'art-2'],
                   'newest first, id ascending breaks the tie')
  assert.deepEqual(body.groups[1].entries.map(entry => entry.id), ['mem-1', 'mem-2'])
  assert.deepEqual(body.groups[2].entries.map(entry => entry.id), ['agt-1'])
  assert.deepEqual(body.page, { type: 'all', limit: 50, cursor: 0, next_cursor: null, returned: 5 })
})

test('an entry carries only the export fields: no token, key, invite code or free-text body', async () => {
  const body = await get(host())
  for (const group of body.groups) {
    for (const entry of group.entries) {
      assert.deepEqual(Object.keys(entry).sort(), ['id', 'title', 'type', 'updated'].sort(),
                       'the whitelist is the contract, not a filter someone has to maintain')
    }
  }
  const wire = JSON.stringify(body)
  for (const secret of ['tok_live_do_not_export', 'sk-should-never-appear', 'invite-abc', '内部正文']) {
    assert.equal(wire.includes(secret), false, `${secret} must not leave the workspace`)
  }
})

test('another account workspace answers 404, and neither store is read', async () => {
  const H = host({ binding: { workspace_id: OTHER }, teams: [{ id: OTHER, name: '别人的工作区' }] })
  const response = await exportFeature(H).endpoints.v1({ method: 'GET', path: PATH, query: '' })
  assert.equal(response.status, 404)
  assert.equal(response.body.error.code, 'workspace/not-found')
  assert.deepEqual(H.calls.filter(([name]) => name === 'memory/pages'), [])
})

test('the listing pages with a cursor: every entry once, then next_cursor goes null', async () => {
  const first = await get(host(), 'limit=2')
  assert.deepEqual(first.page, { type: 'all', limit: 2, cursor: 0, next_cursor: 2, returned: 2 })
  assert.deepEqual(first.groups.map(group => group.entries.map(entry => entry.id)),
                   [['art-1', 'art-2'], [], []], 'groups keep their fixed order and the page is cut from that order')
  const seen = first.groups.flatMap(group => group.entries)
  let cursor = first.page.next_cursor
  while (cursor !== null) {
    const page = await get(host(), `limit=2&cursor=${cursor}`)
    seen.push(...page.groups.flatMap(group => group.entries))
    cursor = page.page.next_cursor
  }
  assert.deepEqual(seen.map(entry => entry.id), ['art-1', 'art-2', 'mem-1', 'mem-2', 'agt-1'])
  assert.equal(new Set(seen.map(entry => entry.id)).size, 5, 'no entry is served twice')
})

test('a type filter groups the same entries under one type only', async () => {
  const body = await get(host(), 'type=memory')
  assert.deepEqual(body.groups.map(group => group.type), ['memory'])
  assert.deepEqual(body.counts, { artifacts: 0, memory: 2, agents: 0, total: 2 })
  assert.deepEqual(body.page.type, 'memory')
})

test('a workspace past the scan cap is refused with 400 and the cap, not buffered whole', async () => {
  // The provider keeps handing back a fresh page forever: the feature must stop
  // at its own cap instead of reading it all into memory.
  const artifactsPages = Array.from({ length: 40 }, (_, index) => ({
    status: 200, body: { items: [{ id: `art-${index}`, title: 't', updated: index }], cursor: index + 1 },
  }))
  const H = host({ artifactsPages })
  const response = await exportFeature(H, { maxScan: 3 }).endpoints.v1({ method: 'GET', path: PATH, query: '' })
  assert.equal(response.status, 400)
  assert.equal(response.body.error.code, 'export/too-large')
  assert.match(response.body.error.message, /3/)
  assert.match(response.body.error.message, /1000/)
})

test('bad queries are 400 invalid, and write methods are 405', async () => {
  for (const query of ['limit=0', 'limit=999', 'limit=x', 'cursor=-1', 'type=secrets', 'unknown=1']) {
    assert.equal(await status(host(), query), 400, query)
  }
  const response = await exportFeature(host()).endpoints.v1({ method: 'POST', path: PATH, query: '', body: {} })
  assert.equal(response.status, 405)
  assert.equal(MAX_LIMIT, 200)
})

test('the projection is a pure function: the same rows in, the same manifest out', () => {
  const sources = { workspace: WS, artifacts: artifacts(), memory: memory(), agents: agents() }
  assert.deepEqual(exportPage(sources, {}), exportPage(sources, {}))
  assert.deepEqual(exportPage(sources, { type: 'agents' }).groups[0].entries,
                   [{ type: 'agents', id: 'agt-1', title: '研究员', updated: 400 }])
})

// The empty workspace is the one every new account hits: it must answer with
// three empty groups, not 404 and not a missing key.
test('an empty workspace still answers a well-formed manifest', async () => {
  const H = host()
  H.call = async name => {
    if (name === 'agents/personal-binding') return { workspace_id: WS }
    if (name === 'teams/activeWorkspaces') return []
    if (name === 'agents/workspaceExportRows') return { items: [] }
    if (name === 'memory/pages') return []
    if (name === 'artifacts/v1') return { status: 200, body: { items: [], cursor: null } }
    throw new Error('unexpected endpoint ' + name)
  }
  const body = await get(H)
  assert.deepEqual(body.counts, { artifacts: 0, memory: 0, agents: 0, total: 0 })
  assert.deepEqual(body.groups.map(group => [group.type, group.entries.length]), EXPORT_TYPES.map(type => [type, 0]))
  assert.equal(body.page.next_cursor, null)
})

test('the installed DS-Bot exports authorized local metadata without reconciling agents', async t => {
  const runtime = nativeAgentFixture()
  attachRuntime(runtime.services)
  t.after(detachRuntime)
  const otherWorkspace = 'b'.repeat(32)
  const owner = await bootMemory()
  const other = await bootMemory(undefined, {personal:otherWorkspace})
  const createdWork = await owner.call('artifacts', 'POST', `/v1/workspaces/${WS}/artifacts`, {
    title:'已保存的作品', body:'作品里不应导出的正文', kind:'document',
  }, key())
  const createdMemory = await owner.call('memory', 'POST', `/v1/workspaces/${WS}/memory`, {
    title:'已保存的记忆', body:'记忆里不应导出的正文',
  }, key())
  const createdAgent = await owner.call('agents', 'POST', `/v1/workspaces/${WS}/agents`, {
    name:'原智能体名称', instructions:'不应导出的提示词',
  }, key())
  for (const created of [createdWork, createdMemory, createdAgent]) assert.equal(created.status, 201)
  const agent = createdAgent.body.agent
  runtime.bots[agent.native_bot_id].name = 'DS-Bot 中改过的名称'
  runtime.services.rt.save = () => assert.fail('Export must never save the native roster')
  owner.features.table['agents/list'] = () => assert.fail('The normal directory can reconcile the native roster')
  assert.ok(owner.features.loaded.includes('export'), JSON.stringify(owner.features.failed))
  const result = await owner.call('export', 'GET', PATH)
  assert.equal(result.status, 200)
  assert.deepEqual(result.body.counts, {artifacts:1, memory:1, agents:1, total:3})
  assert.deepEqual(result.body.groups[0].entries.map(row => row.title), ['已保存的作品'])
  assert.deepEqual(result.body.groups[1].entries.map(row => row.title), ['已保存的记忆'])
  assert.deepEqual(result.body.groups[2].entries, [
    {id:agent.id, title:'DS-Bot 中改过的名称', type:'agents', updated:agent.updated},
  ])
  assert.doesNotMatch(JSON.stringify(result.body), /不应导出的正文|不应导出的提示词/)
  assert.equal((await other.call('export', 'GET', PATH)).status, 404)
  assert.equal((await other.call('export', 'GET', `/v1/workspaces/${otherWorkspace}/export`)).status, 200)
  const legacy = new URL(LEGACY_PATH, 'http://10.0.0.2:8080')
  legacy.searchParams.set('feature', 'export')
  legacy.searchParams.set('path', PATH)
  legacy.searchParams.set('query', 'type=memory&limit=1')
  const paged = await owner.ctx.routes.get(LEGACY_PATH).fetch(new Request(legacy))
  assert.equal(paged.status, 200)
  assert.equal(paged.headers.get('cache-control'), 'no-store')
  assert.deepEqual((await paged.json()).groups[0].entries.map(row => row.title), ['已保存的记忆'])
  assert.equal((await other.ctx.routes.get(LEGACY_PATH).fetch(new Request(legacy))).status, 404)
  legacy.searchParams.delete('query')
  assert.equal((await owner.ctx.routes.get(LEGACY_PATH).fetch(new Request(legacy, {method:'POST'}))).status, 405)
  assert.equal((await owner.endpoint('agents/workspaceExportRows', {workspace_id:WS, limit:1000})).ok, false)
})

test('a provider failure errors instead of silently publishing an incomplete manifest', async () => {
  const fake = host()
  const call = fake.call.bind(fake)
  fake.call = (name, payload) => {
    if (name === 'memory/pages') throw new Error('read failed')
    return call(name, payload)
  }
  assert.equal(await status(fake), 503)
  assert.equal(await status(fake, 'type=artifacts'), 200)
})
