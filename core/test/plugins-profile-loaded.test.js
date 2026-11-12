// #2931: Settings → Plugins prints the command that installs a package a profile does not
// have, and `dsh` refuses that command without `--profile <name>` (#2926). #2928 supplied the
// name by hand as `web`, which is only true on the Web profile: profiles/desktop is a sibling
// of profiles/web, so a Desktop reader is told to install into the wrong profile. The runtime
// already knows its own name (`profileContext.name`), so both plugin endpoints answer it and
// the client stops guessing. A host with no profileContext answers no name at all rather than
// inventing one.
//
// P-721 is the second half: `plugins/list` answered rows with a boolean `loaded`, while
// `plugins/set` answered the bare switches, so the same row came back with `loaded: undefined`
// although docs/subsystems/plugin-runtime.md says both endpoints answer the same rows.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const temp = name => mkdtempSync(join(tmpdir(), `dsb-${name}-`))

// A profile as dsh writes it, so `installed` has a manifest to read (#2868).
const profile = bundles => {
  const dir = temp('profile')
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-profile-test', private: true, dependencies: {}, dsh: { profile: { bundles } } }))
  return dir
}

const start = ({ state, profileContext } = {}) => {
  const home = temp('home')
  if (state !== undefined) writeFileSync(join(home, 'state.json'), JSON.stringify(state))
  const services = profileContext === undefined ? {} : { profileContext }
  const rt = createRuntime(fakeContext({ services }), { home, diagnosticsFile: false })
  return { home, rt }
}

test('a host with no profile answers no profile name rather than guessing one (#2931)', async () => {
  const { home, rt } = start()
  try {
    const listed = await rt.flybotEndpoint('plugins/list')
    assert.equal(Object.hasOwn(listed, 'profile'), false, 'the field stays out when there is no profileContext')
    const saved = await rt.flybotEndpoint('plugins/set', { id: 'workflow', enabled: false })
    assert.equal(Object.hasOwn(saved, 'profile'), false, 'a flip does not invent a name either')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('both plugin endpoints answer the profile this runtime is in (#2931)', async () => {
  const dir = profile(['@deepseek-ai/dsh-base', 'ds-bot', '@flybot/workflow'])
  const { home, rt } = start({ profileContext: { name: 'deskprobe', dir } })
  try {
    const listed = await rt.flybotEndpoint('plugins/list')
    assert.equal(listed.profile, 'deskprobe', 'the list answer names the runtime profile')
    const saved = await rt.flybotEndpoint('plugins/set', { id: 'workflow', enabled: false })
    assert.equal(saved.profile, 'deskprobe', 'the set answer names the same one')
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
  }
})

test('plugins/set answers the rows plugins/list answers, loaded included (P-721)', async () => {
  const dir = profile(['@deepseek-ai/dsh-base', 'ds-bot', '@flybot/workflow'])
  const { home, rt } = start({ profileContext: { name: 'deskprobe', dir } })
  try {
    const listed = await rt.flybotEndpoint('plugins/list')
    const saved = await rt.flybotEndpoint('plugins/set', { id: 'workflow', enabled: false })
    const before = new Map(listed.plugins.map(row => [row.id, row]))
    assert.equal(saved.plugins.length, listed.plugins.length, 'the set answer carries every row')
    for (const row of saved.plugins) {
      const listedRow = before.get(row.id)
      assert.ok(listedRow, `list answered ${row.id}`)
      assert.equal(Object.hasOwn(row, 'loaded'), true, `${row.id} answers loaded, like the list row`)
      assert.equal(typeof row.loaded, 'boolean', `${row.id} answers loaded as a boolean`)
      assert.equal(row.loaded, listedRow.loaded, `${row.id} keeps the value the list answered`)
      assert.equal(Object.hasOwn(row, 'installed'), true, `${row.id} keeps installed too`)
      assert.equal(row.installed, listedRow.installed, `${row.id} keeps the installed value`)
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
  }
})
