import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { apply } from '../index.js'
import { PAGE_PATH } from '../src/pages.js'
import { loadFeatures, registerFeature } from '../src/features.js'
import { attachRuntime, detachRuntime, runtime } from '../src/host.js'
import { createDispatch, LEGACY_PATH } from '../src/dispatch.js'
import { deliverBundle, fakeCtx, volume } from './helpers.js'

const identity = { instanceId: 'c'.repeat(32) }

function featuresDir(files) {
  const root = mkdtempSync(join(tmpdir(), 'ot-features-'))
  for (const [name, source] of Object.entries(files)) {
    mkdirSync(join(root, name), { recursive: true })
    writeFileSync(join(root, name, 'index.js'), source)
  }
  return root
}

test('features register namespaced endpoints; a broken feature is skipped, others load', async () => {
  const dir = featuresDir({
    alpha: "export default (host) => ({ endpoints: { ping: async (p) => ({ pong: p, dir: host.featureDir() }) } })",
    broken: "throw new Error('boom')",
    'Bad_Name': "export default () => ({ endpoints: {} })",
    nofactory: "export const x = 1",
  })
  const data = mkdtempSync(join(tmpdir(), 'ot-data-'))
  const logs = []
  const { table, loaded, failed } = await loadFeatures({ dir, identity, dataDir: data, log: (m) => logs.push(m) })
  assert.deepEqual(loaded, ['alpha'])
  assert.deepEqual(failed.map((f) => f.name).sort(), ['Bad_Name', 'broken', 'nofactory'])
  assert.deepEqual(Object.keys(table), ['alpha/ping'])
  const value = await table['alpha/ping'](7)
  assert.equal(value.pong, 7)
  assert.equal(value.dir, join(data, 'flybot-workspace', 'features', 'alpha'))
})

test('native documents include saved appearance without waiting for another feature to initialize', async () => {
  const coordination = mkdtempSync(join(tmpdir(), 'ot-startup-'))
  const gate = join(coordination, 'gate.mjs')
  writeFileSync(gate, 'export const block = Promise.withResolvers(); export const entered = Promise.withResolvers()')
  const latch = await import(pathToFileURL(gate).href)
  const dir = featuresDir({
    settings: "export default () => ({ endpoints: { get: async () => ({settings: {values: {language: 'en',appearance:'dark'}}}) } })",
    deferred: "export default async () => { const g = await import(" + JSON.stringify(pathToFileURL(gate).href) + "); g.entered.resolve(); await g.block.promise; return {endpoints:{}} }",
  })
  const routes = new Map()
  const ctx = {
    connection: {fetch: {register: route => routes.set(route.path, route)}},
    effect: fn => fn(),
  }
  const pagesDir = fileURLToPath(new URL('../../../flybot_workspace/static/', import.meta.url))
  const {features} = apply(ctx, {pagesDir, featuresDir:dir, dataDir:coordination})
  try {
    await latch.entered.promise
    const response = await Promise.race([
      routes.get(PAGE_PATH).fetch(new Request('http://host' + PAGE_PATH + '?path=%2Fchat')),
      new Promise((_, reject) => setTimeout(() => reject(Error('Chat waited for an unrelated feature')), 3000).unref()),
    ])
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-language'), 'en')
    assert.match(await response.text(), /<html data-shell-appearance="dark" data-theme-resolved="dark" data-shell-language="en" lang="en">/)
    const memory = await routes.get(PAGE_PATH).fetch(new Request('http://host' + PAGE_PATH + '?path=%2Fmemory'))
    assert.equal(memory.headers.get('cache-control'), 'no-store')
    assert.match(await memory.text(), /<html data-shell-appearance="dark" data-theme-resolved="dark" data-shell-language="en"/)
  } finally {
    latch.block.resolve()
    assert.deepEqual((await features).loaded, ['settings','deferred'])
  }
})

test('native Chat serves the migrated owner directory while unrelated features initialize', {timeout: 3000}, async () => {
  const vol = volume()
  const gate = join(vol.root, 'gate.mjs')
  writeFileSync(gate, `
    export const importAgents = Promise.withResolvers()
    export const agentsEntered = Promise.withResolvers()
    export const otherReady = Promise.withResolvers()
    export const otherEntered = Promise.withResolvers()
  `)
  const gateURL = pathToFileURL(gate).href
  const latch = await import(gateURL)
  const real = name => JSON.stringify(new URL(`../features/${name}/index.js`, import.meta.url).href)
  const dir = featuresDir({
    chat: `export {default} from ${real('chat')}`,
    personal: `export {default} from ${real('personal')}`,
    teams: `export {default} from ${real('teams')}`,
    agents: `import agents from ${real('agents')}; import {importAgents, agentsEntered} from ${JSON.stringify(gateURL)};
      export default async host => { agentsEntered.resolve(); await importAgents.promise; return agents(host) }`,
    artifacts: `import {otherReady, otherEntered} from ${JSON.stringify(gateURL)};
      export default async () => { otherEntered.resolve(); await otherReady.promise; return {} }`,
  })
  const workspace = 'a'.repeat(32)
  const agent = 'b'.repeat(32)
  const rows = {workspace_agents: [{id:agent, workspace_id:workspace, name:'Owner assistant'}],
    personal_agents: [{workspace_id:workspace, agent_id:agent}]}
  const tables = Object.fromEntries(Object.entries(rows).map(([name, value]) => [name, JSON.stringify(value)]))
  const manifest = Object.fromEntries(Object.entries(tables).map(([name, value]) => [name,
    { rows: rows[name].length, sha256: createHash('sha256').update(value).digest('hex') }]))
  deliverBundle(vol, 'agents.bundle', JSON.stringify({format:'flybot-workspace-dsbot-import', version:1, feature:'agents', tables, manifest}))

  const ctx = fakeCtx()
  const {features} = apply(ctx, {dataDir:vol.data, featuresDir:dir})
  const fetch = (query, method = 'GET') => ctx.routes.get(LEGACY_PATH).fetch(new Request(`http://bot${LEGACY_PATH}?` +
    new URLSearchParams({feature:'teams', path:'/v1/workspaces', query}), {method, headers:{'x-ot-owner-username':'directory-owner'}}))
  const query = 'scope=personal&include=chat'
  try {
    await latch.agentsEntered.promise
    let directoryServed = false
    const directory = fetch(query).then(response => { directoryServed = true; return response })
    await new Promise(setImmediate)
    assert.equal(directoryServed, false, 'the directory waits for personal agent import')
    latch.importAgents.resolve()
    await latch.otherEntered.promise

    const response = await directory
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    const body = await response.json()
    assert.equal(body.viewer_username, 'directory-owner')
    assert.equal(body.items[0].id, workspace)
    assert.equal(body.personal_agent_id, agent)
    assert.equal(body.chat.items[0].id, agent)
    assert.equal(body.chat.items[0].memory_recall_default, true)
    const foreign = await (await fetch(`${query}&workspace=${'e'.repeat(32)}`)).json()
    assert.equal(foreign.chat, undefined)

    let otherResponses = 0
    const waiting = [fetch(`${query}&workspace=${workspace}&entry_agent=${agent}`), fetch(query, 'POST'),
      fetch('scope=personal&include=artifacts')].map(promise => promise.then(response => { otherResponses++; return response }))
    await new Promise(setImmediate)
    assert.equal(otherResponses, 0, 'snapshot, catalog and writes keep the full feature gate')
    latch.otherReady.resolve()
    assert.deepEqual((await Promise.all(waiting)).map(response => response.status), [200, 400, 200])
  } finally {
    latch.importAgents.resolve()
    latch.otherReady.resolve()
    assert.deepEqual((await features).failed, [])
  }
})

test('duplicate and malformed endpoints are refused', () => {
  const table = {}
  registerFeature(table, 'one', { endpoints: { a: async () => 1 } })
  assert.throws(() => registerFeature(table, 'one', { endpoints: { a: async () => 2 } }), /duplicate/)
  assert.throws(() => registerFeature(table, 'two', { endpoints: { '../x': async () => 2 } }), /invalid endpoint/)
  assert.throws(() => registerFeature(table, 'two', { endpoints: { ok: 'nope' } }), /invalid endpoint/)
})

test('runtime() resolves once the DS-Bot wrapper attaches, and times out otherwise', async () => {
  detachRuntime()
  await assert.rejects(runtime({ timeoutMs: 20 }), /not attached/)
  const pending = runtime({ timeoutMs: 1000 })
  const rt = { bots: [] }
  const ctx = {}
  attachRuntime({ rt, ctx })
  assert.equal((await pending).rt, rt)
  assert.equal((await runtime()).ctx, ctx)
  detachRuntime()
})

test('dispatch passes payload and call context, maps thrown codes', async () => {
  const dispatch = createDispatch({ endpoints: {
    'x/echo': async (payload, call) => ({ payload, hasRequest: call.request instanceof Request }),
    'x/fail': async () => { throw Object.assign(new Error('nope'), { code: 'x/denied' }) },
  } })
  const call = (body) => dispatch(new Request('http://h/api/flybot-workspace', { method: 'POST', body: JSON.stringify(body) })).then((r) => r.json())
  assert.deepEqual(await call({ endpoint: 'x/echo', payload: { a: 1 } }), { ok: true, value: { payload: { a: 1 }, hasRequest: true } })
  const failed = await call({ endpoint: 'x/fail' })
  assert.equal(failed.error.code, 'x/denied')
})
