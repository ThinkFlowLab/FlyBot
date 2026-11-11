// #2564: the owner's switch for the four feature plugins. The switch lives in FlyBot's
// own state.json, is read at the plugin's apply() on start, and hides that plugin's slot
// entries in the interface.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { FEATURE_PLUGIN_IDS, pluginEnabledAtStart, pluginSwitches, setPluginSwitch } from '../src/host/plugins.js'
import { createRegistry, pluginOfSlot, registry, setDisabledPlugins } from '../src/client/flybot-registry.js'
import { fakeContext } from './fake-ctx.js'

const home = () => mkdtempSync(join(tmpdir(), 'dsb-plugins-'))
const runtime = (state) => {
  const dir = home()
  if (state !== undefined) writeFileSync(join(dir, 'state.json'), JSON.stringify(state))
  const ctx = fakeContext()
  const rt = createRuntime(ctx, { home: dir, diagnosticsFile: false })
  return { dir, rt, ctx }
}

test('every switch is on until state.json says otherwise', () => {
  assert.deepEqual(FEATURE_PLUGIN_IDS, ['social', 'tree', 'timeline', 'workflow', 'project'])
  assert.deepEqual(pluginSwitches({}).map(plugin => plugin.enabled), [true, true, true, true, true])
  assert.deepEqual(pluginSwitches({ flybot: { plugins: { workflow: { enabled: false } } } }).map(plugin => [plugin.id, plugin.enabled]), [
    ['social', true], ['tree', true], ['timeline', true], ['workflow', false], ['project', true],
  ])
})

test('a switch only takes a known id, and true/false only', () => {
  const state = {}
  assert.equal(setPluginSwitch(state, 'social', false).find(plugin => plugin.id === 'social').enabled, false)
  assert.deepEqual(state.flybot.plugins.social, { enabled: false })
  assert.throws(() => setPluginSwitch(state, 'core', false), /unknown plugin "core"/)
  assert.throws(() => setPluginSwitch(state, 'tree', 'off'), /takes true or false/)
})

test('the host reads the switch from the file the last run wrote', () => {
  const dir = home()
  try {
    assert.equal(pluginEnabledAtStart(join(dir, 'state.json'), 'social'), true, 'no file means on')
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ flybot: { plugins: { social: { enabled: false } } } }))
    assert.equal(pluginEnabledAtStart(join(dir, 'state.json'), 'social'), false)
    assert.equal(pluginEnabledAtStart(join(dir, 'state.json'), 'tree'), true)
    writeFileSync(join(dir, 'state.json'), '{ not json')
    assert.equal(pluginEnabledAtStart(join(dir, 'state.json'), 'social'), true, 'an unreadable file means on')
    assert.equal(pluginEnabledAtStart(join(dir, 'state.json'), 'not-a-plugin'), true, 'an unknown id keeps loading')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('plugins/list answers all four switches and plugins/set persists a flip', async () => {
  const { dir, rt } = runtime()
  try {
    const listed = await rt.flybotEndpoint('plugins/list')
    assert.equal(listed.pendingRestart, false)
    assert.deepEqual(listed.plugins.map(plugin => plugin.id), [...FEATURE_PLUGIN_IDS])
    assert.equal(listed.plugins.find(plugin => plugin.id === 'workflow').package, '@flybot/workflow')

    const saved = await rt.flybotEndpoint('plugins/set', { id: 'workflow', enabled: false })
    assert.equal(saved.pendingRestart, true)
    assert.equal(saved.plugins.find(plugin => plugin.id === 'workflow').enabled, false)
    await rt.save()
    const onDisk = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))
    assert.deepEqual(onDisk.flybot.plugins.workflow, { enabled: false })
    // The running process keeps what it loaded; only the next start reads this.
    assert.equal(rt.flybot.pluginEnabled('workflow'), false)
    assert.equal(rt.flybot.pluginEnabled('social'), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a disabled plugin keeps no slot entry visible, and the other plugins stay', () => {
  const slots = createRegistry()
  slots.register('flybot.sidebar.section', { id: 'social' })
  slots.register('flybot.sidebar.section', { id: 'workflow' })
  slots.register('flybot.sidebar.section', { id: 'flybot-tree' })
  slots.register('flybot.settings.page', { id: 'timeline' })
  slots.register('flybot.sidebar.section', { id: 'core-thing' })
  assert.deepEqual(slots.entries('flybot.sidebar.section').map(entry => entry.id), ['social', 'workflow', 'flybot-tree', 'core-thing'])

  slots.setDisabledPlugins(['social', 'tree'])
  assert.deepEqual(slots.entries('flybot.sidebar.section').map(entry => entry.id), ['workflow', 'core-thing'])
  assert.deepEqual(slots.entries('flybot.settings.page').map(entry => entry.id), ['timeline'])
  slots.setDisabledPlugins([])
  assert.equal(slots.entries('flybot.sidebar.section').length, 4)
})

test('every id the four plugin bundles register maps to its own plugin', () => {
  // The ids the plugin client bundles use today; a new one here has to map too, which is
  // what keeps the filter honest when a plugin grows a panel.
  const known = {
    social: ['social', 'social-approval', 'social-face', 'social-group-strip', 'social-handle', 'social-held-reply', 'social-invite', 'social-paused', 'social-room-end', 'social-room-invite', 'social-thinking'],
    tree: ['flybot-tree', 'flybot-tree-archived', 'flybot-tree-reorg'],
    timeline: ['timeline'],
    workflow: ['workflow'],
  }
  for (const [id, ids] of Object.entries(known)) for (const slot of ids) assert.equal(pluginOfSlot(slot), id, slot)
  assert.equal(pluginOfSlot('core-thing'), undefined)
})

test('the live registry is the one Settings flips', () => {
  setDisabledPlugins(['workflow'])
  assert.equal(registry().entries('flybot.sidebar.section').length, 0)
  setDisabledPlugins([])
})
