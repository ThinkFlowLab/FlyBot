// #2868: `plugins/list` reported the owner's switch but never whether the package is in
// this profile at all. A profile that never installed @flybot/project still got a row with
// enabled: true, so Settings drew an ON switch for a domain the process does not have.
// `installed` comes from the profile's own bundle list — the list dsh loads — not from the
// catalogue in plugins.js.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const temp = name => mkdtempSync(join(tmpdir(), `dsb-${name}-`))

// A profile as dsh writes it: one package.json, and the packages this profile loads in
// dsh.profile.bundles. A package missing there is not installed, whatever its dependency says.
const profile = bundles => {
  const dir = temp('profile')
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-profile-test', private: true, dependencies: {}, dsh: { profile: { bundles } } }))
  return dir
}

const start = ({ state, profileDir } = {}) => {
  const home = temp('home')
  if (state !== undefined) writeFileSync(join(home, 'state.json'), JSON.stringify(state))
  const services = profileDir === undefined ? {} : { profileContext: { name: 'test', dir: profileDir } }
  const rt = createRuntime(fakeContext({ services }), { home, diagnosticsFile: false })
  return { home, rt }
}

test('a plugin the profile does not bundle is not installed, whatever its switch says (#2868)', async () => {
  const profileDir = profile(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'ds-bot'])
  const { home, rt } = start({ profileDir, state: { flybot: { plugins: { project: { enabled: true } } } } })
  try {
    const listed = await rt.flybotEndpoint('plugins/list')
    const project = listed.plugins.find(plugin => plugin.id === 'project')
    assert.equal(project.enabled, true, 'the switch still says what the owner asked for')
    assert.equal(project.installed, false, 'the profile does not load @flybot/project')
    // The row must not promise a domain this process never built.
    assert.equal(rt.projectBoard, undefined)
    assert.equal(rt.projectChief, undefined)
    assert.deepEqual(listed.plugins.filter(plugin => plugin.installed === false).map(plugin => plugin.id), ['social', 'tree', 'timeline', 'workflow', 'project'])
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(profileDir, { recursive: true, force: true })
  }
})

test('a plugin the profile bundles is installed (#2868)', async () => {
  const profileDir = profile(['@deepseek-ai/dsh-base', 'ds-bot', '@flybot/project'])
  const { home, rt } = start({ profileDir })
  try {
    const listed = await rt.flybotEndpoint('plugins/list')
    const project = listed.plugins.find(plugin => plugin.id === 'project')
    assert.equal(project.installed, true)
    assert.equal(project.enabled, true)
    assert.deepEqual(listed.plugins.filter(plugin => plugin.installed === true).map(plugin => plugin.id), ['project'])
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(profileDir, { recursive: true, force: true })
  }
})

test('plugins/set answers with installed too, so a flip cannot erase it (#2868)', async () => {
  const profileDir = profile(['@deepseek-ai/dsh-base', 'ds-bot', '@flybot/workflow'])
  const { home, rt } = start({ profileDir })
  try {
    const saved = await rt.flybotEndpoint('plugins/set', { id: 'workflow', enabled: false })
    const workflow = saved.plugins.find(plugin => plugin.id === 'workflow')
    assert.equal(workflow.enabled, false)
    assert.equal(workflow.installed, true)
    const reRead = await rt.flybotEndpoint('plugins/list')
    assert.equal(reRead.plugins.find(plugin => plugin.id === 'workflow').installed, true)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(profileDir, { recursive: true, force: true })
  }
})

test('a host with no profile answers no installation, rather than claiming none (#2868)', async () => {
  const { home, rt } = start()
  try {
    const listed = await rt.flybotEndpoint('plugins/list')
    for (const plugin of listed.plugins) assert.equal(Object.hasOwn(plugin, 'installed'), false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
