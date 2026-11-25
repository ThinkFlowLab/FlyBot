import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import memory from '../features/memory/index.js'
import { key } from './helpers.js'

const PERSONAL = '1'.repeat(32)
const TEAM = '2'.repeat(32)
const OTHER = '3'.repeat(32)
const prefix = (workspace, suffix = '') => `/v1/workspaces/${workspace}/memory${suffix}`

function memoryRuntime(t) {
  const directory = mkdtempSync(join(tmpdir(), 'memory-action-draft-'))
  const teams = new Set([TEAM])
  let text
  const feature = memory({
    featureDir: () => directory, dataDir: directory, log() {},
    async call(endpoint) {
      if (endpoint === 'agents/personal-binding') return {workspace_id:PERSONAL}
      if (endpoint === 'teams/activeWorkspaces') return [...teams].map(id => ({id}))
      return null
    },
    currentRuntime: () => text ? {backgroundTextOnly:text} : null,
  })
  t.after(() => feature.store.close())
  return {
    teams, store:feature.store, model(fn) { text = fn },
    request: (method, workspace, suffix, body, idempotency_key) =>
      feature.endpoints.v1({method,path:prefix(workspace,suffix),body,idempotency_key}),
  }
}

async function page(runtime, workspace, title, body) {
  const result = await runtime.request('POST', workspace, '', {title, body}, key())
  assert.equal(result.status, 201)
  return result.body.page
}

const ref = page => ({id:page.id, revision:page.revision})
const suggestion = (page, title) => ({title, memory_page_id:page.id, source_revision:page.revision})

test('only the explicitly selected current workspace notes reach the native model, with no generated writes', async t => {
  const runtime = memoryRuntime(t)
  const selected = await page(runtime, PERSONAL, 'Release', 'Confirm the review meeting this week.')
  const second = await page(runtime, PERSONAL, 'Launch', 'Write the promotion checklist.')
  const ignored = await page(runtime, PERSONAL, 'Unselected', 'Do not include this other note.')
  const outside = await page(runtime, TEAM, 'Team', 'Separate team note.')
  runtime.teams.add(OTHER)
  const shared = await page(runtime, OTHER, 'Another workspace', 'An unavailable personal note.')
  runtime.teams.delete(OTHER)
  const before = runtime.store.get('SELECT COUNT(*) AS n FROM memory_actions').n
  const draft = (workspace, sources, idempotency = key()) => runtime.request('POST', workspace, '/actions/draft',
    {sources}, idempotency)
  assert.equal((await draft(PERSONAL, [ref(selected)])).status, 503)

  let modelCalls = 0
  const entered = Promise.withResolvers()
  const finish = Promise.withResolvers()
  runtime.model(async prompt => {
    modelCalls += 1
    assert.match(prompt,/Confirm the review meeting/)
    assert.match(prompt,/Write the promotion checklist/)
    assert.doesNotMatch(prompt,/other note|Separate team note|unavailable personal note/)
    entered.resolve()
    return finish.promise
  })
  assert.equal((await draft(PERSONAL, [ref(outside)])).status, 404)
  assert.equal((await draft(OTHER, [ref(shared)])).status, 404)
  assert.equal((await draft(PERSONAL, [ref(ignored),ref(ignored)])).status, 400)
  const requestKey = key()
  const sources = [ref(selected), ref(second)]
  const first = draft(PERSONAL, sources, requestKey)
  await entered.promise
  const retry = draft(PERSONAL, sources, requestKey)
  assert.equal((await draft(PERSONAL, [ref(selected)], requestKey)).status, 409)
  assert.equal((await draft(PERSONAL, sources)).status, 429)
  finish.resolve(JSON.stringify({suggestions:[{title:'Confirm the review meeting',source:1}, {title:'Write the checklist',source:2}]}))
  const result = await first
  assert.deepEqual(await retry, result)
  assert.deepEqual(await draft(PERSONAL, sources, requestKey), result)
  assert.equal(modelCalls, 1)
  assert.deepEqual(result.body, {
    sources:[{...ref(selected),title:selected.title},{...ref(second),title:second.title}],
    suggestions:[{title:'Confirm the review meeting',memory_page_id:selected.id},{title:'Write the checklist',memory_page_id:second.id}],
  })
  assert.equal(runtime.store.get('SELECT COUNT(*) AS n FROM memory_actions').n, before)
  assert.equal(runtime.store.get('SELECT COUNT(*) AS n FROM memory_action_draft_saves').n, 0)
})

test('generation rejects model-invented references and drops suggestions if source or workspace access changes', async t => {
  const runtime = memoryRuntime(t)
  const source = await page(runtime, TEAM, 'Team follow-up', 'Coordinate with the team this week.')
  const draft = source => runtime.request('POST', TEAM, '/actions/draft', {sources:[ref(source)]}, key())
  runtime.model(async () => JSON.stringify({suggestions:[{title:'Unfounded source',source:2}]}))
  assert.equal((await draft(source)).body.error.code, 'invalid_suggestion')
  const entered = Promise.withResolvers()
  const finish = Promise.withResolvers()
  runtime.model(async () => { entered.resolve(); return finish.promise })
  const changing = draft(source)
  await entered.promise
  const edit = await runtime.request('POST', TEAM, '/' + source.id, {revision:1,changes:{body:'Updated team follow-up.'}})
  assert.equal(edit.status, 200)
  finish.resolve('{"suggestions":[{"title":"Coordinate with the team","source":1}]}')
  assert.equal((await changing).status, 409)

  runtime.model(async () => {
    runtime.teams.delete(TEAM)
    return '{"suggestions":[{"title":"Coordinate with the team","source":1}]}'
  })
  assert.equal((await draft(edit.body.page)).status, 404)
  assert.equal((await runtime.request('GET', TEAM, '/actions')).status, 404)
  assert.equal(runtime.store.get('SELECT COUNT(*) AS n FROM memory_actions').n, 0)
})

test('only chosen action drafts are atomically saved and retries cannot duplicate a saved or removed action', async t => {
  const runtime = memoryRuntime(t)
  const another = memoryRuntime(t)
  const location = await page(runtime, PERSONAL, 'A selected source', 'Review the notes.')
  const current = await page(runtime, PERSONAL, 'A second source', 'Send a checklist.')
  const foreign = await page(runtime, TEAM, 'A different source', 'Team only note.')
  const existing = (await runtime.request('POST', PERSONAL, '/actions', {title:'Existing action',notes:'Keep intact'}, key())).body.action
  const save = (items, idempotency = key(), target = PERSONAL) =>
    runtime.request('POST', target, '/actions/draft/save', {items}, idempotency)
  const chosen = [suggestion(location, 'Review the original'), suggestion(current, 'Send the edited checklist')]
  assert.equal((await save([chosen[0], suggestion(foreign,'Wrong source')])).status, 404)
  assert.equal((await save([chosen[0], {...chosen[1], source_revision:2}])).status, 409)
  assert.equal((await save([chosen[0], {...chosen[0], title:'  REVIEW THE ORIGINAL  '}])).status, 400)
  assert.equal((await save(chosen, key(), OTHER)).status, 404)
  assert.equal((await another.request('POST', PERSONAL, '/actions/draft/save', {items:chosen}, key())).status, 404)
  assert.equal((await runtime.request('GET', PERSONAL, '/actions')).body.items.length, 1)
  const requestKey = key()
  const [first, replay] = await Promise.all([save(chosen, requestKey), save(chosen, requestKey)])
  assert.equal(first.status, 201, JSON.stringify(first.body))
  assert.equal(replay.status, 200)
  assert.deepEqual(replay.body, {...first.body,replayed:true})
  assert.deepEqual(first.body.items.map(({title,memory_page_title,status}) => ({title,memory_page_title,status})), [
    {title:chosen[0].title,memory_page_title:location.title,status:'open'},
    {title:chosen[1].title,memory_page_title:current.title,status:'open'},
  ])
  assert.equal((await save(chosen.slice(0,1), requestKey)).status, 409)
  assert.deepEqual((await runtime.request('GET', PERSONAL, '/actions/' + existing.id)).body.action, existing)
  await runtime.request('POST', PERSONAL, '/actions/' + first.body.items[0].id + '/remove', {})
  assert.equal((await save(chosen, requestKey)).body.items.length, 1)
  assert.equal((await runtime.request('GET', PERSONAL, '/actions')).body.items.length, 2)
})
