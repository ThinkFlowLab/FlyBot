// #2868: `installed` is the profile's answer, read fresh on every call — `core/src/host/hooks.js`
// and `docs/subsystems/plugin-runtime.md` both say a package installed while this host runs
// stops being reported as missing, and nothing in `core/test/**` held that. This pins the fresh
// read: same runtime, the profile file rewritten between calls, the answers follow the file.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const temp = name => mkdtempSync(join(tmpdir(), `dsb-${name}-`))

// A profile as dsh writes it: one package.json whose dsh.profile.bundles is the list this
// profile loads. Only that list decides `installed`, so only that list is rewritten here.
const writeProfile = (dir, bundles) => writeFileSync(join(dir, 'package.json'), JSON.stringify({
  name: 'dsh-profile-test', private: true, dependencies: {}, dsh: { profile: { bundles } },
}))

test('plugins/list reads installed again on every call, not once at start (#2868)', async () => {
  const profileDir = temp('profile')
  const home = temp('home')
  writeProfile(profileDir, ['@deepseek-ai/dsh-base', 'ds-bot'])
  const rt = createRuntime(
    fakeContext({ services: { profileContext: { name: 'test', dir: profileDir } } }),
    { home, diagnosticsFile: false },
  )
  try {
    const before = await rt.flybotEndpoint('plugins/list')
    assert.equal(before.plugins.find(plugin => plugin.id === 'workflow').installed, false, 'the profile has not installed @flybot/workflow')

    // The package arrives while this host runs: the next answer must follow the file, not a
    // list this start read once.
    writeProfile(profileDir, ['@deepseek-ai/dsh-base', 'ds-bot', '@flybot/workflow'])
    const installed = await rt.flybotEndpoint('plugins/list')
    assert.equal(installed.plugins.find(plugin => plugin.id === 'workflow').installed, true, 'a package installed while this host runs is reported as installed')

    // And one removed the same way stops being reported as here.
    writeProfile(profileDir, ['@deepseek-ai/dsh-base', 'ds-bot'])
    const removed = await rt.flybotEndpoint('plugins/list')
    assert.equal(removed.plugins.find(plugin => plugin.id === 'workflow').installed, false, 'a package removed while this host runs is no longer reported as installed')
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(profileDir, { recursive: true, force: true })
  }
})
