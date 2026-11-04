import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runHarnessTurn as actualRunHarnessTurn } from '../src/host/project-harness-turn.js'
const runHarnessTurn = (request, ports) => actualRunHarnessTurn(request, { validateCodex: async (_request, options) => ({ codexPathOverride: '/test/sdk-cli', env: options.env }), ...ports })
const request = { harness: 'codex', cwd: '/workspace/task', model: 'explicit-model', prompt: 'Implement only the frozen Task', env: { HOME: '/explicit/profile', CODEX_HOME: '/explicit/codex' } }
function codex(events, inspect = () => {}) {
  return async () => ({ Codex: class {
    constructor(options) { inspect(options) }
    startThread(options) { inspect(options); return this.thread() }
    resumeThread(id, options) { inspect({ id, ...options }); return this.thread() }
    thread() { return { runStreamed: async () => ({ events: (async function* () { yield* events })() }) } }
  } })
}

test('Codex adapter binds explicit environment and Session, and turn completion is separate from delivery', async () => {
  const observed = [], events = []
  const result = await runHarnessTurn(request, { emit: event => events.push(event), loadCodex: codex([
    { type: 'thread.started', thread_id: 'thread-one' }, { type: 'item.completed', item: { type: 'agent_message', text: 'OUTPUT implementation: changed code' } }, { type: 'turn.completed', usage: { input_tokens: 3 } },
  ], value => observed.push(value)) })
  assert.equal(result.sessionId, 'thread-one')
  assert.equal(result.text, 'OUTPUT implementation: changed code')
  assert.deepEqual(observed[0].env, request.env)
  assert.deepEqual(observed[0].configOverrides.slice(0, 3), ['mcp_servers={}', 'plugins={}', 'apps={_default={enabled=false}}'])
  assert.equal(observed[0].config.features.skill_mcp_dependency_install, false)
  assert.equal(observed[0].config.permissions['flybot-role'].extends, ':workspace')
  assert.equal(observed[0].config.features.network_proxy, true)
  assert.deepEqual(observed[0].config.permissions['flybot-role'].network.domains, {})
  assert.equal(observed[1].approvalPolicy, 'never')
  assert.equal(result.accepted, undefined)
  assert.equal(events.length, 3)
})

test('truncated, failed and aborted SDK streams never report completion', async () => {
  for (const events of [[{ type: 'thread.started', thread_id: 't' }], [{ type: 'error', message: 'auth failed' }], [{ type: 'turn.failed' }]]) {
    await assert.rejects(runHarnessTurn(request, { emit() {}, loadCodex: codex(events) }), /failed|without/)
  }
  const signal = AbortSignal.abort()
  await assert.rejects(runHarnessTurn(request, { signal, emit() {}, loadCodex: codex([{ type: 'thread.started', thread_id: 't' }, { type: 'turn.completed' }]) }), /without/)
})

test('continuation resumes the bound Codex thread, preserving resource cwd', async () => {
  const observed = []
  await runHarnessTurn({ ...request, sessionId: 'original' }, { emit() {}, loadCodex: codex([{ type: 'turn.completed' }], value => observed.push(value)) })
  assert.equal(observed[1].id, 'original')
  assert.equal(observed[1].workingDirectory, request.cwd)
})

test('the SDK cannot silently substitute a different thread for resume or reuse a reconstructed source identity', async () => {
  for (const mode of [{ sessionId: 'original', threadId: 'different' }, { forbiddenSessionId: 'original', threadId: 'original' }]) {
    const emitted = []
    await assert.rejects(runHarnessTurn({ ...request, ...mode }, { emit: event => emitted.push(event), loadCodex: codex([{ type: 'thread.started', thread_id: mode.threadId }, { type: 'turn.completed' }]) }), { code: 'bot/context-resume' })
    assert.equal(emitted.length, 0)
  }
})

test('Claude Agent SDK uses explicit environment and forwards permission requests', async () => {
  let options, asked = false
  const result = await runHarnessTurn({ ...request, harness: 'claude-agent' }, { emit() {}, permission: async () => { asked = true; return { allow: false } },
    loadClaude: async () => ({ query(input) {
      options = input.options
      return (async function* () {
        assert.equal((await options.canUseTool('Bash', { command: 'echo test' }, { toolUseID: 'tool-1' })).behavior, 'deny')
        yield { type: 'system', session_id: 'claude-session' }; yield { type: 'result', subtype: 'success', result: 'OUTPUT review: findings', usage: {} }
      })()
    } }) })
  assert.equal(asked, true)
  assert.deepEqual(options.env, request.env)
  assert.deepEqual(options.settingSources, [])
  assert.equal(result.sessionId, 'claude-session')
})

test('SDK Chief disables runtime tools and connectors before proposing host-scoped actions', async () => {
  const observed = []
  await runHarnessTurn({ ...request, noTools: true, readOnly: true }, { emit() {}, loadCodex: codex([{ type: 'thread.started', thread_id: 'chief' }, { type: 'turn.completed' }], value => observed.push(value)) })
  assert.equal(observed[0].config.features.shell_tool, false)
  assert.equal(observed[0].config.tools.view_image, false)
  assert.equal(observed[0].config.apps._default.enabled, false)
  assert.deepEqual(observed[0].configOverrides, ['mcp_servers={}', 'plugins={}', 'apps={_default={enabled=false}}'])
  assert.equal(observed[0].config.hooks.PreToolUse[0].hooks[0].type, 'command')
  assert.equal(observed[1].sandboxMode, 'read-only')
})

test('only a developer turn passes host-selected Git writable roots to the official SDK', async () => {
  for (const mode of [{}, { readOnly: true }, { noTools: true }]) {
    const observed = [], roots = ['/registered/repo/.git/worktrees/task', '/registered/repo/.git/objects']
    await runHarnessTurn({ ...request, ...mode, writableRoots: roots }, { emit() {}, loadCodex: codex([{ type: 'thread.started', thread_id: 'git-probe' }, { type: 'turn.completed' }], options => observed.push(options)) })
    assert.deepEqual(observed[1].additionalDirectories, mode.readOnly || mode.noTools ? [] : roots)
    if (mode.noTools) assert.equal(observed[1].networkAccessEnabled, false)
    else { assert.equal(observed[1].networkAccessEnabled, undefined); assert.deepEqual(observed[0].config.permissions['flybot-role'].network.domains, {}); assert.equal(observed[0].config.permissions['flybot-role'].network.mode, 'limited') }
  }
})

test('Codex process IPC policy cannot be overridden into external access or writable review source', async () => {
  const observed = []
  await runHarnessTurn({ ...request, readOnly: true, config: { features: { network_proxy: false }, permissions: { 'flybot-role': { network: { mode: 'full', domains: { 'example.com': 'allow' } } } } } }, { emit() {}, loadCodex: codex([{ type: 'thread.started', thread_id: 'policy' }, { type: 'turn.completed' }], options => observed.push(options)) })
  const config = observed[0].config, policy = config.permissions['flybot-role']
  assert.equal(config.features.network_proxy, true); assert.equal(policy.extends, ':read-only')
  assert.equal(policy.network.mode, 'limited'); assert.deepEqual(policy.network.domains, {})
  assert.equal(policy.network.allow_local_binding, false); assert.equal(policy.network.dangerously_allow_all_unix_sockets, false)
  assert.match(observed[0].configOverrides.at(-1), /permissions\.flybot-role=/)
  assert.match(observed[0].configOverrides.at(-1), /":tmpdir"="write"/)
  assert.equal(observed[1].sandboxMode, undefined, 'Legacy flags cannot override the named constrained profile')
})

test('read-only Codex verification grants only the host-bound scratch directory for temporary files', async () => {
  const observed = [], scratchDirectory = '/registered/resource/.flybot-scratch-unique'
  await runHarnessTurn({ ...request, readOnly: true, scratchDirectory, env: { ...request.env, TMPDIR: scratchDirectory } }, { emit() {}, loadCodex: codex([{ type: 'thread.started', thread_id: 'scratch' }, { type: 'turn.completed' }], options => observed.push(options)) })
  const raw = observed[0].configOverrides.at(-1)
  assert.ok(raw.includes(JSON.stringify(scratchDirectory) + '="write"'))
  assert.equal(observed[0].config.permissions['flybot-role'].extends, ':read-only')
  assert.deepEqual(observed[1].additionalDirectories, [])
  assert.equal(observed[0].env.TMPDIR, scratchDirectory)
})

test('Codex tool history has a host-selected limit without replacing SDK compaction or Session identity', async () => {
  const observed = []
  await runHarnessTurn({ ...request, sessionId: 'kept-thread', toolOutputTokens: 1536 }, { emit() {}, loadCodex: codex([{ type: 'turn.completed' }], value => observed.push(value)) })
  assert.equal(observed[0].config.tool_output_token_limit, 1536)
  assert.equal(observed[0].config.model_auto_compact_token_limit, undefined)
  assert.equal(observed[0].config.model_context_window, undefined)
  assert.equal(observed[1].id, 'kept-thread')
  for (const limit of [0, -1, 1.5, '1536']) await assert.rejects(runHarnessTurn({ ...request, toolOutputTokens: limit }, { loadCodex: async () => { throw new Error('Must validate before loading SDK') } }), /output budget/)
})

test('receipt correction resumes the original SDK Session without tools or changing its role filesystem profile', async () => {
  const observed = []
  await runHarnessTurn({ ...request, sessionId: 'original', protocolCorrection: true }, { emit() {}, loadCodex: codex([{ type: 'thread.started', thread_id: 'original' }, { type: 'turn.completed' }], value => observed.push(value)) })
  assert.equal(observed[1].id, 'original'); assert.equal(observed[0].config.features.shell_tool, false)
  assert.equal(observed[0].config.permissions['flybot-role'].extends, ':workspace')
  assert.equal(observed[1].sandboxMode, undefined)
  assert.equal(observed[0].config.hooks.PreToolUse[0].hooks[0].type, 'command')
  let asked = false
  await runHarnessTurn({ ...request, harness: 'claude-agent', sessionId: 'original', protocolCorrection: true }, { emit() {}, permission: () => { asked = true }, loadClaude: async () => ({ query({ options }) {
    assert.deepEqual(options.tools, []); assert.equal(options.resume, 'original')
    return (async function* () { assert.equal((await options.canUseTool('Bash', {}, {})).behavior, 'deny'); yield { type: 'result', subtype: 'success', session_id: 'original', result: 'receipt patch' } })()
  } }) })
  assert.equal(asked, false)
})

test('Codex refresh-token reuse is a safe authentication failure before provider error text reaches evidence', async () => {
  const emitted = [], secret = 'fixture-private-provider-material'
  for (const event of [{ type: 'turn.failed', error: { message: 'Your refresh token has already been used. Please log in again. ' + secret } }, { type: 'error', message: 'refresh_token_reused ' + secret }]) {
    await assert.rejects(runHarnessTurn(request, { emit: value => emitted.push(value), loadCodex: codex([event]) }), error => error.code === 'bot/harness-auth' && error.authenticationFailure.code === 'refresh_token_reused' && !error.message.includes(secret))
  }
  assert.equal(emitted.length, 0)
  await assert.rejects(runHarnessTurn(request, { emit() {}, loadCodex: codex([{ type: 'turn.failed', error: { message: 'Network connection timed out' } }]) }), error => error.code !== 'bot/harness-auth')
})

test('a tool command reporting its own authentication failure does not invalidate the model login', async () => {
  const result = await runHarnessTurn(request,{emit(){},loadCodex:codex([{type:'thread.started',thread_id:'tool-scope'},{type:'item.completed',item:{type:'command_execution',exit_code:1,aggregated_output:'refresh_token_reused in a tool integration'}},{type:'turn.completed'}])})
  assert.equal(result.sessionId,'tool-scope')
})
