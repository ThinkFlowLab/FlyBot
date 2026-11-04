import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { codexConfigArguments, validateCodexConfiguration, codexExecutable } from '../src/host/project-codex-config.js'
import { runHarnessTurn } from '../src/host/project-harness-turn.js'
const exec = promisify(execFile)

async function settings(request) {
  let options
  const stop = new Error('captured-before-model')
  await assert.rejects(runHarnessTurn({ harness: 'codex', model: 'unused', prompt: 'unused', ...request }, { emit() {}, loadCodex: async () => ({ Codex: class {} }), validateCodex: async (_request, value) => { options = value; throw stop } }), error => error === stop)
  return options
}
test('configuration check stops an invalid profile before creating a paid SDK thread', async () => {
  let created = false
  await assert.rejects(runHarnessTurn({ harness: 'codex' }, { loadCodex: async () => ({ Codex: class { constructor() { created = true } } }), validateCodex: async () => { throw Object.assign(new Error('not ready'), { code: 'bot/harness-capability' }) } }), { code: 'bot/harness-capability' })
  assert.equal(created, false)
  const options = await settings({ cwd: '/candidate', scratchDirectory: '/scratch', readOnly: true })
  assert.ok(options.configOverrides.at(-1).includes('\":tmpdir\"=\"write\"'))
  assert.ok(!options.configOverrides.at(-1).includes('\":tmp\"='))
  assert.deepEqual(codexConfigArguments({ features: { network_proxy: true }, hooks: [{ value: 'quoted' }] }, ['plugins={}']), ['--config', 'features.network_proxy=true', '--config', 'hooks=[{"value"="quoted"}]', '--config', 'plugins={}'])
})

test('CLI version failures expose no stderr or profile values', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'flybot-cli-fixture-'))
  try {
    const executable = join(directory, 'codex')
    await writeFile(executable, '#!/bin/sh\necho codex-cli 0.1.0\necho private-fixture-value >&2\n', { mode: 0o700 })
    const request = { cwd: directory, env: { PATH: process.env.PATH }, noTools: true }
    await assert.rejects(validateCodexConfiguration(request, { config: {}, configOverrides: [] }, { executable }), error => error.code === 'bot/harness-capability' && error.capability === 'unsupported-cli-version' && !error.message.includes('private-fixture-value'))
  } finally { await rm(directory, { recursive: true, force: true }) }
})

// Opt-in on the actual resource executable; basic CI needs no vendor SDK install.
if (process.env.FLYBOT_TEST_CODEX_EXECUTABLE) test('actual Codex 0.166 parses role policy, rejects bad profiles and legacy conflicts, and protects candidate writes offline', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'flybot-cli-offline-'))
  try {
    const home = join(directory, 'home'), scratch = join(directory, 'scratch'), cwd = join(directory, 'candidate')
    await Promise.all([home, scratch, cwd].map(path => mkdir(path)))
    const candidate = join(cwd, 'candidate.txt')
    await writeFile(candidate, 'sealed')
    const executable = process.env.FLYBOT_TEST_CODEX_EXECUTABLE
    if (process.env.FLYBOT_TEST_CODEX_SDK_URL) assert.equal(codexExecutable(process.env.FLYBOT_TEST_CODEX_SDK_URL).executable, executable)
    const env = { PATH: process.env.PATH, HOME: home, CODEX_HOME: home, TMPDIR: scratch, LANG: 'C.UTF-8' }
    for (const readOnly of [false, true]) {
      const request = { cwd, scratchDirectory: scratch, env, readOnly }
      const options = await settings(request)
      const validated = await validateCodexConfiguration(request, options, { executable })
      assert.equal(validated.codexPathOverride, executable)
      assert.equal(validated.capability.modelInvoked, false)
      const args = codexConfigArguments(options.config, options.configOverrides)
      await exec(executable, [...args, 'sandbox', '-P', 'flybot-role', '--', '/bin/sh', '-c', 'printf scratch > "$TMPDIR/probe"'], { env, cwd })
      assert.equal(await readFile(join(scratch, 'probe'), 'utf8'), 'scratch')
      const write = exec(executable, [...args, 'sandbox', '-P', 'flybot-role', '--', '/bin/sh', '-c', 'printf changed > candidate.txt'], { env, cwd })
      if (readOnly) await assert.rejects(write)
      else await write
      assert.equal(await readFile(candidate, 'utf8'), readOnly ? 'sealed' : 'changed')
      await writeFile(candidate, 'sealed')
      const invalid = { ...options, configOverrides: options.configOverrides.map(value => value.replaceAll(':tmpdir', ':tmp')) }
      await assert.rejects(validateCodexConfiguration(request, invalid, { executable }), { code: 'bot/harness-capability', capability: 'permission-profile-mismatch' })
      const badProfile = { ...options, configOverrides: options.configOverrides.map(value => value.replaceAll(readOnly ? ':read-only' : ':workspace', ':unsupported-profile')) }
      await assert.rejects(validateCodexConfiguration(request, badProfile, { executable }), { code: 'bot/harness-capability', capability: 'cli-configuration' })
      await writeFile(join(home, 'config.toml'), 'sandbox_mode="danger-full-access"\n')
      await assert.rejects(validateCodexConfiguration(request, options, { executable }), { code: 'bot/harness-capability', capability: 'legacy-sandbox-conflict' })
      await rm(join(home, 'config.toml'))
    }
    const chief = { cwd, env, noTools: true, readOnly: true }
    await validateCodexConfiguration(chief, await settings(chief), { executable })
  } finally { await rm(directory, { recursive: true, force: true }) }
})
