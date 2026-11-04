// Opt-in: actual installed SDK/CLI and sandbox; provider/App/GitHub responses are fixtures.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { runHarnessTurn } from '../src/host/project-harness-turn.js'
import { validateCodexConfiguration } from '../src/host/project-codex-config.js'
import { roleGithubRuntime } from '../src/host/project-role-github-runtime.mjs'
const exec = promisify(execFile)
if (process.env.FLYBOT_TEST_CODEX_SDK_URL && process.env.FLYBOT_TEST_CODEX_EXECUTABLE) for (const role of ['developer', 'reviewer']) test('actual SDK ' + role + ' uses only its scoped App credential channel and filesystem rights', { timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'role-app-sdk-')), cwd = join(root, 'repo'), scratch = join(root, 'scratch'), home = join(root, 'home'), tools = join(root, 'tools')
  await Promise.all([cwd, scratch, home, tools].map(path => mkdir(path)))
  await writeFile(join(scratch, 'host-tests.log'), 'HOST_TEST_LOG_FIXTURE\n');
  await exec('git', ['init', '-q', cwd]); await writeFile(join(cwd, 'code'), 'Actual scoped SDK work')
  await writeFile(join(tools, 'gh'), `#!${process.execPath}\nif(process.env.GH_TOKEN!=='ghs_isolated_sdk_app_token')process.exit(9);console.log('APP_SCOPE_OK');\n`, { mode: 0o700 })
  const metadata = { version: 'project-role-github/v1', policyRole: role, repository: 'org/repo', branch: 'flybot/fixture', baseBranch: 'main', number: null, identity: { appId: 7, login: 'app-7[bot]' }, author: { name: 'app-7[bot]', email: '107+app-7[bot]@users.noreply.github.com' }, publicationMarker: '<!-- fixture -->', sha256: 'a'.repeat(64) }
  let issued = 0, calls = 0, toolOutput = ''
  const env = { HOME: home, CODEX_HOME: home, TMPDIR: scratch, PATH: tools + ':' + dirname(process.execPath) + ':/usr/bin:/bin' }
  const runtime = await roleGithubRuntime({ metadata, scratchDirectory: scratch, env, credential: async () => { issued++; return { token: 'ghs_isolated_sdk_app_token', metadata, expiresAt: Date.now() + 3600000 } } })
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw); calls++
    toolOutput += (body.input ?? []).filter(row => row.type === 'function_call_output').map(row => row.output).join('\n')
    const item = calls === 1 ? { type: 'function_call', id: 'fc_role_app', call_id: 'call_role_app', name: 'exec_command', arguments: JSON.stringify({ cmd: role === 'developer' ? "git add code && git commit -m 'Actual SDK App identity' && gh api repos/org/repo/pulls" : "gh run view 123 --json jobs,headSha; head -c 200 \"$TMPDIR/host-tests.log\"; if touch unauthorized-code; then echo WRITE_BYPASS; else echo READ_ONLY_OK; fi", login: false, max_output_tokens: 500 }) } : { id: 'message_' + calls, type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'SDK fixture complete; host must independently verify the remote artifact' }] }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const event of [{ type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response: { id: 'response_' + calls, status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }]) response.write('data: ' + JSON.stringify(event) + '\n\n')
    response.end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const events = [], request = { harness: 'codex', cwd, model: 'fixture-model', prompt: 'Execute only the current scoped fixture', scratchDirectory: scratch, writableRoots: role === 'developer' ? [join(cwd, '.git')] : [], readOnly: role === 'reviewer', roleGithub: metadata, githubAuthDirectory: runtime.authDirectory, env: runtime.env, config: { model_provider: 'fixture', model_providers: { fixture: { name: 'fixture', base_url: `http://127.0.0.1:${server.address().port}`, wire_api: 'responses', requires_openai_auth: false } } } }
    await runHarnessTurn(request, { signal: AbortSignal.timeout(45000), emit: value => events.push(runtime.redact(value)), loadCodex: () => import(process.env.FLYBOT_TEST_CODEX_SDK_URL), validateCodex: (request, options) => validateCodexConfiguration(request, options, { executable: process.env.FLYBOT_TEST_CODEX_EXECUTABLE }) })
    assert.match(toolOutput, /APP_SCOPE_OK/, `The actual sandbox command must use the scoped broker; grants=${issued}; final model text is not evidence`)
    assert.ok(issued >= 1)
    if (role === 'developer') {
    const commit = (await exec('git', ['log', '-1', '--format=%an|%ae|%cn|%ce'], { cwd })).stdout.trim()
    assert.equal(commit, 'app-7[bot]|107+app-7[bot]@users.noreply.github.com|app-7[bot]|107+app-7[bot]@users.noreply.github.com')
    } else { assert.match(toolOutput, /HOST_TEST_LOG_FIXTURE/); assert.match(toolOutput, /READ_ONLY_OK/); assert.ok(!toolOutput.includes('WRITE_BYPASS')); assert.ok(!(await readdir(cwd)).includes('unauthorized-code')) }
    assert.ok(!JSON.stringify(events).includes('ghs_isolated_sdk_app_token'))
    for (const path of await readdir(home, { recursive: true })) if (path.endsWith('.jsonl')) assert.ok(!(await readFile(join(home, path), 'utf8')).includes('ghs_isolated_sdk_app_token'), 'SDK persisted history must not contain the fixture credential')
  } finally { await runtime.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }) }
})
