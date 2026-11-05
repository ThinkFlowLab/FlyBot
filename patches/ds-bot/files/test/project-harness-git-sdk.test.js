// Opt-in actual SDK/CLI sandbox. Provider replies are fixtures; no live credentials.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { runHarnessTurn } from '../src/host/project-harness-turn.js'
import { validateCodexConfiguration } from '../src/host/project-codex-config.js'
const exec = promisify(execFile)
if (process.env.FLYBOT_TEST_CODEX_SDK_URL && process.env.FLYBOT_TEST_CODEX_EXECUTABLE) for (const role of ['developer', 'reviewer']) test('actual non-App SDK ' + role + ' respects isolated Git mutation capability', { timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'isolated-git-sdk-')), cwd = join(root, 'clone'), scratch = join(root, 'scratch'), home = join(root, 'home')
  await Promise.all([cwd, scratch, home].map(path => mkdir(path)))
  const git = async (...args) => (await exec('git', args, { cwd })).stdout.trim()
  await git('init', '-q'); await git('config', 'user.name', 'Fixture'); await git('config', 'user.email', 'fixture@localhost')
  await writeFile(join(cwd, 'code'), 'base\n'); await git('add', '.'); await git('commit', '-qm', 'Base')
  const base = await git('rev-parse', 'HEAD')
  let calls = 0, toolOutput = ''
  const command = role === 'developer'
    ? "git checkout -b fixture-change && printf 'changed\\n' > code && git add code && git commit -m 'Isolated SDK change' && echo GIT_MUTATION_OK"
    : "if git checkout -b forbidden-change; then echo GIT_BYPASS; else echo GIT_READ_ONLY_OK; fi; if touch forbidden-code; then echo CODE_BYPASS; else echo CODE_READ_ONLY_OK; fi"
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw); calls++
    toolOutput += (body.input ?? []).filter(row => row.type === 'function_call_output').map(row => row.output).join('\n')
    const item = calls === 1 ? { type: 'function_call', id: 'fc_git', call_id: 'call_git', name: 'exec_command', arguments: JSON.stringify({ cmd: command, login: false, max_output_tokens: 500 }) } : { id: 'message_' + calls, type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Fixture turn completed' }] }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const event of [{ type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response: { id: 'response_' + calls, status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }]) response.write('data: ' + JSON.stringify(event) + '\n\n')
    response.end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const request = { harness: 'codex', cwd, model: 'fixture-model', prompt: 'Execute only the scoped fixture tool request', scratchDirectory: scratch, writableRoots: role === 'developer' ? [join(cwd, '.git')] : [], readOnly: role !== 'developer', env: { HOME: home, CODEX_HOME: home, TMPDIR: scratch, PATH: dirname(process.execPath) + ':/usr/bin:/bin' }, config: { model_provider: 'fixture', model_providers: { fixture: { name: 'fixture', base_url: `http://127.0.0.1:${server.address().port}`, wire_api: 'responses', requires_openai_auth: false } } } }
    await runHarnessTurn(request, { signal: AbortSignal.timeout(45000), emit() {}, loadCodex: () => import(process.env.FLYBOT_TEST_CODEX_SDK_URL), validateCodex: (request, options) => validateCodexConfiguration(request, options, { executable: process.env.FLYBOT_TEST_CODEX_EXECUTABLE }) })
    if (role === 'developer') {
      assert.match(toolOutput, /GIT_MUTATION_OK/)
      assert.equal(await git('branch', '--show-current'), 'fixture-change'); assert.notEqual(await git('rev-parse', 'HEAD'), base)
      assert.equal(await readFile(join(cwd, 'code'), 'utf8'), 'changed\n'); assert.equal(await git('status', '--porcelain'), '')
    } else {
      assert.match(toolOutput, /GIT_READ_ONLY_OK/); assert.match(toolOutput, /CODE_READ_ONLY_OK/); assert.doesNotMatch(toolOutput, /GIT_BYPASS|CODE_BYPASS/)
      assert.equal(await git('rev-parse', 'HEAD'), base); assert.equal(await git('branch', '--list', 'forbidden-change'), '')
      assert.equal(await git('status', '--porcelain'), '')
    }
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }) }
})
