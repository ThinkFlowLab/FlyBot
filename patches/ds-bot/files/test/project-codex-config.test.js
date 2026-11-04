import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:http'
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

if (process.env.FLYBOT_TEST_CODEX_SDK_URL && process.env.FLYBOT_TEST_CODEX_EXECUTABLE) test('actual SDK and CLI resume the same thread in a new cwd with retained history and enforced read-only permissions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'flybot-sdk-cwd-'))
  let count = 0, previousSeen = false, toolCwdSeen = false, toolOutputs = []
  const first = join(root, 'first'), second = join(root, 'second'), home = join(root, 'home'), scratch = join(root, 'scratch')
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw)
    toolOutputs.push(...(body.input ?? []).filter(item => item.type === 'function_call_output').map(item => item.output))
    count++; previousSeen ||= raw.includes('fixture-original-conclusion')
    toolCwdSeen ||= (body.input ?? []).some(item => item.type === 'function_call_output' && typeof item.output === 'string' && item.output.replaceAll('\\n', '\n').split('\n').includes(second))
    const item = count === 2 ? { type: 'function_call', id: 'fc_fixture', call_id: 'call_fixture', name: 'exec_command', arguments: JSON.stringify({ cmd: 'pwd; printf changed > candidate.txt', max_output_tokens: 200 }) } : { id: `message_${count}`, type: 'message', role: 'assistant', content: [{ type: 'output_text', text: count === 1 ? 'fixture-original-conclusion' : 'fixture-resumed-conclusion' }] }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const event of [{ type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response: { id: `response_${count}`, status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }]) response.write('data: ' + JSON.stringify(event) + '\n\n')
    response.end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    await Promise.all([first, second, home, scratch].map(path => mkdir(path)))
    for (const path of [first, second]) { await exec('git', ['init', '-q', path]); await writeFile(join(path, 'candidate.txt'), 'sealed') }
    const executable = process.env.FLYBOT_TEST_CODEX_EXECUTABLE, sdkUrl = process.env.FLYBOT_TEST_CODEX_SDK_URL
    assert.equal(codexExecutable(sdkUrl).executable, executable)
    const request = { harness: 'codex', cwd: first, model: 'fixture-model', prompt: 'First isolated fixture turn', readOnly: true, scratchDirectory: scratch, env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home, TMPDIR: scratch }, config: { model_provider: 'fixture', model_providers: { fixture: { name: 'fixture', base_url: `http://127.0.0.1:${server.address().port}`, wire_api: 'responses', requires_openai_auth: false } } } }
    const events = [], ports = { signal: AbortSignal.timeout(30_000), emit: event => events.push(event), loadCodex: () => import(sdkUrl), validateCodex: (request, options) => validateCodexConfiguration(request, options, { executable }) }
    const initial = await runHarnessTurn(request, ports)
    const resumed = await runHarnessTurn({ ...request, cwd: second, sessionId: initial.sessionId, prompt: 'Continue original Task in the new admitted cwd' }, ports)
    assert.equal(initial.sessionId, resumed.sessionId)
    assert.equal(previousSeen, true); assert.equal(toolCwdSeen, true); assert.equal(count, 3)
    assert.equal(await readFile(join(second, 'candidate.txt'), 'utf8'), 'sealed')
    assert.equal(await readFile(join(first, 'candidate.txt'), 'utf8'), 'sealed')
    assert.ok(toolOutputs.some(output => typeof output === 'string' && output.includes(second) && /Process exited with code 1/.test(output) && /Read-only file system|Permission denied/.test(output)))
    assert.equal(events.filter(row => row.type === 'configuration-checked').length, 2)
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }) }
})
