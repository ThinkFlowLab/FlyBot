import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { SCHEDULE_BUNDLE, offerBundle } from '../src/host/automation-default.js'
import { fakeContext } from './fake-ctx.js'

// A stand-in for DSH's plugin manager: one optional bundle, switched on and off like the Plugins page does.
function manager({ enabled = false, listed = true, error, refuse } = {}) {
  const calls = []
  let on = enabled
  return {
    calls,
    get on() { return on },
    set on(value) { on = value },
    async listBundles() {
      calls.push('list')
      return listed ? [{ name: '@deepseek-ai/dsh-base', enabled: true }, { name: SCHEDULE_BUNDLE, enabled: on, optional: true, error }] : [{ name: '@deepseek-ai/dsh-base', enabled: true }]
    },
    async setBundleEnabled(name, value) {
      calls.push(`set ${name} ${value}`)
      if (refuse) return { changed: false, application: 'failed', stage: 'enable', target: name, error: { code: 'operation-error' } }
      on = value
      return { changed: true, application: 'applied', stage: 'enable', target: name, enabled: value }
    },
  }
}

const scratch = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsb-automation-'))
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }))
  return join(dir, 'dsh-defaults.json')
}

test('a profile that has the bundle off gets it switched on once, and the offer is written down', async (t) => {
  const file = scratch(t)
  const plugins = manager()
  assert.equal(await offerBundle({ manager: plugins, profile: 'web', file }), 'enabled')
  assert.equal(plugins.on, true)
  assert.deepEqual(plugins.calls, ['list', `set ${SCHEDULE_BUNDLE} true`])
  assert.equal(typeof JSON.parse(readFileSync(file, 'utf8')).offers[SCHEDULE_BUNDLE].web, 'string')
})

test('a person who switches it off keeps it off: the next start does not ask again', async (t) => {
  const file = scratch(t)
  const plugins = manager()
  await offerBundle({ manager: plugins, profile: 'web', file })
  plugins.on = false
  plugins.calls.length = 0
  assert.equal(await offerBundle({ manager: plugins, profile: 'web', file }), 'decided')
  assert.equal(plugins.on, false)
  assert.deepEqual(plugins.calls, [])
})

test('a bundle that is on already is noted, so turning it off later sticks', async (t) => {
  const file = scratch(t)
  const plugins = manager({ enabled: true })
  assert.equal(await offerBundle({ manager: plugins, profile: 'desktop', file }), 'already-on')
  assert.deepEqual(plugins.calls, ['list'])
  plugins.on = false
  assert.equal(await offerBundle({ manager: plugins, profile: 'desktop', file }), 'decided')
  assert.equal(plugins.on, false)
})

test('each profile is offered once, on its own', async (t) => {
  const file = scratch(t)
  const web = manager()
  const desktop = manager()
  assert.equal(await offerBundle({ manager: web, profile: 'web', file }), 'enabled')
  assert.equal(await offerBundle({ manager: desktop, profile: 'desktop', file }), 'enabled')
  assert.equal(await offerBundle({ manager: web, profile: 'web', file }), 'decided')
})

test('a DSH that does not offer the bundle, or cannot read it, is left alone and asked again later', async (t) => {
  const file = scratch(t)
  assert.equal(await offerBundle({ manager: manager({ listed: false }), profile: 'web', file }), 'unavailable')
  assert.equal(await offerBundle({ manager: manager({ error: { code: 'operation-error' } }), profile: 'web', file }), 'unavailable')
  assert.equal(await offerBundle({ manager: undefined, profile: 'web', file }), 'unavailable')
  assert.equal(await offerBundle({ manager: {}, profile: 'web', file }), 'unavailable')
  assert.equal(existsSync(file), false)
})

test('a refusal is not remembered, so the next start tries again', async (t) => {
  const file = scratch(t)
  assert.equal(await offerBundle({ manager: manager({ refuse: true }), profile: 'web', file }), 'failed')
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).offers[SCHEDULE_BUNDLE], {})
  assert.equal(await offerBundle({ manager: manager(), profile: 'web', file }), 'enabled')
})

test('a manager that throws is a refusal, not a crash', async (t) => {
  const file = scratch(t)
  const plugins = manager()
  plugins.setBundleEnabled = async () => { throw new Error('pnpm is missing') }
  assert.equal(await offerBundle({ manager: plugins, profile: 'web', file }), 'failed')
})

test('an unreadable record changes nothing: an unknown history never reads as "not offered"', async (t) => {
  const file = scratch(t)
  writeFileSync(file, '{ not json')
  const plugins = manager()
  assert.equal(await offerBundle({ manager: plugins, profile: 'web', file }), 'unrecorded')
  assert.deepEqual(plugins.calls, [])
  assert.equal(readFileSync(file, 'utf8'), '{ not json')
})

test('a record that is not a file (a directory in its place) is an unknown history too', async (t) => {
  const file = scratch(t)
  const plugins = manager()
  assert.equal(await offerBundle({ manager: plugins, profile: 'web', file: dirname(file) }), 'unrecorded')
  assert.equal(plugins.on, false)
})

function setup(t, { config = {}, services = {} } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dsb-automation-host-'))
  const ctx = fakeContext({ services })
  const rt = createRuntime(ctx, { home, ...config })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  return { ctx, rt, home }
}

test('the host offers the bundle through the plugin manager under the profile name', async (t) => {
  const plugins = manager()
  const { ctx, rt, home } = setup(t, { services: { pluginManager: plugins, profileContext: { name: 'web' } } })
  assert.ok(ctx.calls.includes('effect ds-bot: automation tasks default'))
  await rt.offerAutomationTasks()
  assert.equal(plugins.on, true)
  assert.ok(JSON.parse(readFileSync(join(home, 'dsh-defaults.json'), 'utf8')).offers[SCHEDULE_BUNDLE].web)
})

test('a window that only shows the team leaves the profile to the other dsh', async (t) => {
  const plugins = manager()
  const { rt } = setup(t, { services: { pluginManager: plugins } })
  rt.readOnly = () => 'open in another dsh'
  await rt.offerAutomationTasks()
  assert.deepEqual(plugins.calls, [])
})

test('config.automationTasks = false never offers it', (t) => {
  const { ctx, rt } = setup(t, { config: { automationTasks: false }, services: { pluginManager: manager() } })
  assert.equal(ctx.calls.includes('effect ds-bot: automation tasks default'), false)
  assert.equal(rt.offerAutomationTasks, undefined)
})
