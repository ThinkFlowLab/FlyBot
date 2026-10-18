// Boots timeline's browser entry (client.js) against the real Cordis 4 the DSH web shell runs, the
// way its module loader does: client.js registers a factory under its package name, the plugin is
// applied, and ds-bot's browser half provides `flybot` (possibly after timeline loads). Uses only
// public Cordis APIs.
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

test('timeline web entry activates under real Cordis once ds-bot provides flybot, and exposes flybot.timeline', async (t) => {
  const cordis = await loadCordis()
  if (!cordis) return t.skip('Cordis 4 not installed (set CORDIS_PATH or DSH_HARNESS)')
  globalThis.__flybot__ = {}
  t.after(() => { delete globalThis.__flybot__ })
  const root = new cordis.Context()
  const failures = []
  const plugins = [...loadClient()]
  assert.deepEqual(plugins.map(([id]) => id), ['@flybot/timeline'])
  const [[id, mod]] = plugins
  root.plugin({ name: id, inject: mod.inject, apply: (ctx) => { try { return mod.apply(ctx) } catch (error) { failures.push([id, error.message]); throw error } } })
  const asked = []
  const flybot = { call: async (endpoint, body) => { asked.push([endpoint, body]); return {} } }
  assert.equal(flybot.timeline, undefined) // not before flybot is provided
  root.plugin({ name: 'ds-bot', apply: ctx => ctx.provide('flybot', flybot) })
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.deepEqual(failures, [])
  assert.equal(typeof flybot.timeline?.open, 'function')
  assert.equal(globalThis.__flybot__.timeline, flybot.timeline)
  assert.deepEqual(asked, []) // nothing is polled until a panel opens
  await root.dispose?.()
})
