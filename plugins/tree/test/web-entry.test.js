// Boots tree's browser entry (client.js) against the real Cordis 4 the DSH web shell runs, the
// way its module loader does: client.js registers a factory under its package name, the plugin is
// applied, and ds-bot's browser half provides `flybot` (possibly after tree loads). Replaces the
// tree half of ds-bot's test/web-entries.test.js (ThinkFlowLab/FlyBot#34). Uses only the interface
// layer (the core's flybot-registry.js slot registry) and public Cordis APIs.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'

async function loadCordis() {
  const tries = []
  if (process.env.CORDIS_PATH) tries.push(() => import(pathToFileURL(process.env.CORDIS_PATH).href))
  const harness = process.env.DSH_HARNESS
  if (harness) {
    for (const anchor of [join(harness, 'packages/bundle/base/package.json'), join(harness, 'package.json')]) {
      if (!existsSync(anchor)) continue
      const req = createRequire(anchor)
      tries.push(() => import(pathToFileURL(req.resolve('@deepseek-ai/cordis')).href))
      tries.push(() => import(pathToFileURL(createRequire(req.resolve('@deepseek-ai/dsh/package.json')).resolve('@deepseek-ai/cordis')).href))
    }
  }
  tries.push(() => import('@deepseek-ai/cordis'))
  for (const attempt of tries) {
    try { return await attempt() } catch {}
  }
  return undefined
}

function loadClient() {
  const modules = new Map()
  const react = { createElement() {}, useEffect() {}, useState: v => [v, () => {}], useCallback: f => f, useMemo: f => f(), useRef: v => ({ current: v }), Fragment: 'f' }
  const window = { __ModuleLoader__: { load: ({ id, factory }) => modules.set(id, factory(name => (name === 'react' ? react : {}))) } }
  new Function('window', readFileSync(new URL('../client.js', import.meta.url), 'utf8'))(window)
  return modules
}

test('tree web entry activates under real Cordis once ds-bot provides flybot, and exposes flybot.tree.forest', async (t) => {
  const cordis = await loadCordis()
  if (!cordis) return t.skip('Cordis 4 not installed (set CORDIS_PATH or DSH_HARNESS)')
  const { createRegistry } = await import(pathToFileURL(join(process.env.FLYBOT_CORE, 'src/client/flybot-registry.js')).href)
  const registry = createRegistry()
  globalThis.__flybot__ = { slots: registry, call: async () => ({}) }
  t.after(() => { delete globalThis.__flybot__ })
  const root = new cordis.Context()
  const failures = []
  const plugins = [...loadClient()]
  assert.deepEqual(plugins.map(([id]) => id), ['@flybot/tree'])
  const [[id, mod]] = plugins
  root.plugin({ name: id, inject: mod.inject, apply: (ctx) => { try { return mod.apply(ctx) } catch (error) { failures.push([id, error.message]); throw error } } })
  const bots = [{ id: 'a', name: 'Chief', isMain: true, fields: {} }, { id: 'b', name: 'Writer', fields: { 'flybot-tree': { parent: 'a' } } }]
  const flybot = { slots: registry, bots: async () => bots, fields: { on: () => () => {} }, call: async () => ({}) }
  assert.equal(flybot.tree, undefined) // not before flybot is provided
  root.plugin({ name: 'ds-bot', apply: ctx => ctx.provide('flybot', flybot) })
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.deepEqual(failures, [])
  // Tree registers no Tree sidebar section by default; it feeds ds-bot's Bot list through the
  // public 'flybot.sidebar.structure' slot and exposes its synchronous helper.
  // Its only section is the reorganization notice (#446), which draws nothing until a reorganization ran.
  assert.deepEqual(registry.entries('flybot.sidebar.section').map(e => e.id), ['flybot-tree-reorg'])
  assert.ok(registry.entries('flybot.sidebar.structure').length >= 1)
  assert.equal(typeof flybot.tree?.forest, 'function')
  assert.equal(typeof globalThis.__flybot__.tree?.forest, 'function')
  assert.ok(Array.isArray(flybot.tree.forest(bots)))
})
