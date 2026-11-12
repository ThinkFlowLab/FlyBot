// #2564: the owner's switch for the five feature plugins. The switch lives in FlyBot's
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
const runtime = (state, services) => {
  const dir = home()
  if (state !== undefined) writeFileSync(join(dir, 'state.json'), JSON.stringify(state))
  const ctx = fakeContext({ services })
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

test('plugins/list answers all five switches and plugins/set persists a flip', async () => {
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

// #2877: the switch says the owner left the feature on; only the plugin says the package is here
// and its apply() really ran. The browser needs that second bit to stop drawing the Project
// surfaces an absent package cannot back, so `plugins/list` reports it — `enabled` keeps its own
// meaning, and `plugins/set` answers the same rows, `loaded` included (P-721).
test('plugins/list says whether this start really attached each plugin', async () => {
  const { dir, rt } = runtime()
  try {
    const listed = await rt.flybotEndpoint('plugins/list')
    assert.deepEqual(listed.plugins.map(plugin => [plugin.id, plugin.enabled, plugin.loaded]), [
      ['social', true, false], ['tree', true, false], ['timeline', true, false], ['workflow', true, false], ['project', true, false],
    ], 'on, and not attached: nothing marked itself')

    assert.equal(rt.flybot.markPluginLoaded('project'), true)
    const after = await rt.flybotEndpoint('plugins/list')
    assert.deepEqual(after.plugins.filter(plugin => plugin.loaded).map(plugin => plugin.id), ['project'])
    assert.equal(after.plugins.find(plugin => plugin.id === 'project').enabled, true, 'loading does not change the switch')
    // A plugin that is not on the list cannot answer for one that is.
    assert.equal(rt.flybot.markPluginLoaded('not-a-plugin'), false)
    assert.equal(rt.flybot.markPluginLoaded(''), false)

    // Switching it off keeps the answer it attached; the two facts are independent.
    const saved = await rt.flybotEndpoint('plugins/set', { id: 'project', enabled: false })
    const project = saved.plugins.find(plugin => plugin.id === 'project')
    assert.equal(project.enabled, false)
    assert.equal(project.loaded, true, 'a flip answers the row the list answered, loaded included (P-721)')
    assert.deepEqual(Object.keys(project).sort(), ['enabled', 'id', 'loaded', 'name', 'package', 'purpose'], 'plugins/set answers the same row shape as plugins/list')
    const off = await rt.flybotEndpoint('plugins/list')
    assert.deepEqual([off.plugins.find(plugin => plugin.id === 'project').enabled, off.plugins.find(plugin => plugin.id === 'project').loaded], [false, true])
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

test('every id the five plugin bundles register maps to its own plugin', () => {
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

// P-710: the restart banner compares each switch with the value this start read, so a flip
// that ends where the start was needs no restart and must clear the banner.
test('P-710: switching a plugin off and back on leaves no restart pending', async () => {
  const { dir, rt } = runtime()
  try {
    const off = await rt.flybotEndpoint('plugins/set', { id: 'workflow', enabled: false })
    assert.equal(off.pendingRestart, true, 'the running session did not load what this start read')
    const back = await rt.flybotEndpoint('plugins/set', { id: 'workflow', enabled: true })
    assert.equal(back.pendingRestart, false, 'the switch answers what this start read again, so nothing needs a restart')
    const listed = await rt.flybotEndpoint('plugins/list')
    assert.equal(listed.pendingRestart, false, 'and the list agrees')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// P-710: the same comparison from the other side — a plugin that started off, turned on, then off.
test('P-710: a switch that started off is pending only while it differs from that start', async () => {
  // A team file this store accepts, with the switch already off: the shape a start loads
  // when the owner turned the plugin off before this process began.
  const dir = home()
  try {
    writeFileSync(join(dir, 'state.json'), JSON.stringify({
      version: 2, mainBotIds: [], members: {}, bots: {},
      flybot: { plugins: { tree: { enabled: false } } },
    }))
    const rt = createRuntime(fakeContext(), { home: dir, diagnosticsFile: false })
    const listed = await rt.flybotEndpoint('plugins/list')
    assert.equal(listed.pendingRestart, false, 'nothing changed since this start')
    const on = await rt.flybotEndpoint('plugins/set', { id: 'tree', enabled: true })
    assert.equal(on.pendingRestart, true, 'the next start would load what this one did not')
    const off = await rt.flybotEndpoint('plugins/set', { id: 'tree', enabled: false })
    assert.equal(off.pendingRestart, false, 'back to the value this start read')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// P-710: the restart answer comes from the same rows Settings reads. A flip must keep the
// profile's `installed` answer (and the list's `loaded`), so the new comparison cannot
// rebuild the rows from the snapshot alone and drop what the profile said (#2868).
test('P-710: a flip keeps the profile installed answer on every row it answers', async () => {
  const profileDir = mkdtempSync(join(tmpdir(), 'dsb-profile-'))
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-test', private: true, dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'ds-bot', '@flybot/workflow'] } },
  }))
  const { dir, rt } = runtime(undefined, { profileContext: { name: 'test', dir: profileDir } })
  try {
    const off = await rt.flybotEndpoint('plugins/set', { id: 'workflow', enabled: false })
    assert.equal(off.plugins.find(plugin => plugin.id === 'workflow').installed, true, 'a flip answers the profile too')
    assert.equal(off.pendingRestart, true)
    const back = await rt.flybotEndpoint('plugins/set', { id: 'workflow', enabled: true })
    assert.equal(back.plugins.find(plugin => plugin.id === 'workflow').installed, true)
    assert.equal(back.plugins.find(plugin => plugin.id === 'project').installed, false, 'and the package this profile never got')
    assert.equal(back.pendingRestart, false)
    const listed = await rt.flybotEndpoint('plugins/list')
    assert.equal(listed.plugins.find(plugin => plugin.id === 'workflow').installed, true)
    assert.equal(listed.plugins.find(plugin => plugin.id === 'workflow').loaded, false)
    assert.equal(listed.pendingRestart, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(profileDir, { recursive: true, force: true })
  }
})
