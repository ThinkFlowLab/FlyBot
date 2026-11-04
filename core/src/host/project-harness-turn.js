import { sdkAuthenticationFailure, authenticationError } from './project-harness-auth.js'
import { fileURLToPath } from 'node:url'
import { validateCodexConfiguration } from './project-codex-config.js'
// One real SDK turn. The host owns Workflow completion and acceptance, never this driver.
async function executeHarnessTurn(request, { emit, permission, signal, validateCodex = validateCodexConfiguration, loadCodex = () => import('@openai/codex-sdk'), loadClaude = () => import('@anthropic-ai/claude-agent-sdk') }) {
  const toolsDisabled = request.noTools || request.protocolCorrection === true
  let text = '', completed = false, sessionId = request.sessionId ?? null, usage = null
  if (request.harness === 'codex') {
    const toolOutputTokens = request.toolOutputTokens ?? 2000
    if (!Number.isSafeInteger(toolOutputTokens) || toolOutputTokens < 1 || toolOutputTokens > 10_000_000) throw new Error('Invalid Codex tool output budget')
    const { Codex } = await loadCodex()
    const denyScript = fileURLToPath(new URL('./project-harness-deny-tool.mjs', import.meta.url))
    const quote = value => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('$', '\\$').replaceAll('`', '\\`')}"`
    const connectorPolicy = { remote_plugin: false, skill_mcp_dependency_install: false }
    const chiefConfig = toolsDisabled ? { features: { ...connectorPolicy, shell_tool: false }, tools: { view_image: false }, apps: { _default: { enabled: false } },
      hooks: { PreToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command: `node ${quote(denyScript)}` }] }] } } : { features: connectorPolicy }
    // Raw network denial also denies Unix pipe lifecycle syscalls in CLI 0.166,
    // breaking Node child_process despite a successful child exit. The limited
    // proxy keeps an empty outbound allowlist while allowing local process IPC.
    const roots = !request.readOnly && !request.noTools ? request.writableRoots ?? [] : []
    const processPolicy = request.noTools ? {} : { default_permissions: 'flybot-role', features: { ...connectorPolicy, network_proxy: true },
      permissions: { 'flybot-role': { extends: request.readOnly ? ':read-only' : ':workspace', filesystem: { ':tmpdir': 'write', ...(request.scratchDirectory ? { [request.scratchDirectory]: 'write' } : {}), ...(request.roleGithub && request.githubAuthDirectory ? { [request.githubAuthDirectory]: 'write' } : {}), ...Object.fromEntries(roots.map(path => [path, 'write'])) },
        network: { enabled: true, mode: 'limited', domains: request.roleGithub ? Object.fromEntries(['github.com', 'api.github.com', 'objects.githubusercontent.com', 'codeload.github.com', ...(request.roleGithub.downloadHosts ?? [])].map(host => [host, 'allow'])) : {}, unix_sockets: {}, allow_local_binding: false, allow_upstream_proxy: false, dangerously_allow_non_loopback_proxy: false, dangerously_allow_all_unix_sockets: false } } } }
    const inlineToml = value => value && typeof value === 'object' ? '{' + Object.entries(value).map(([key, child]) => `${JSON.stringify(key)}=${inlineToml(child)}`).join(',') + '}' : JSON.stringify(value)
    const rawPolicy = request.noTools ? [] : ['permissions.flybot-role=' + inlineToml(processPolicy.permissions['flybot-role'])]
    const configPolicy = request.noTools ? {} : { ...processPolicy, permissions: { 'flybot-role': { extends: processPolicy.permissions['flybot-role'].extends, network: processPolicy.permissions['flybot-role'].network } } }
    const clientOptions = { env: request.env, configOverrides: ['mcp_servers={}', 'plugins={}', 'apps={_default={enabled=false}}', ...rawPolicy], ...(request.baseUrl ? { baseUrl: request.baseUrl } : {}), config: { ...(request.config ?? {}), ...chiefConfig, ...configPolicy, ...(request.roleGithub ? { shell_environment_policy: { inherit: 'core', set: Object.fromEntries(Object.entries(request.env ?? {}).filter(([key]) => ['PATH', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL', 'GH_CONFIG_DIR'].includes(key))) } } : {}), features: { ...chiefConfig.features, ...configPolicy.features, ...(toolsDisabled ? { shell_tool: false } : {}) }, tool_output_token_limit: toolOutputTokens } }
    const validated = await validateCodex({ ...request, signal }, clientOptions)
    if (validated.capability) await emit({ type: 'configuration-checked', harness: 'codex', capability: validated.capability })
    const client = new Codex({ ...clientOptions, codexPathOverride: validated.codexPathOverride, env: validated.env })
    const options = { workingDirectory: request.cwd, model: request.model, approvalPolicy: 'never', additionalDirectories: roots, webSearchMode: 'disabled',
      ...(request.noTools ? { sandboxMode: 'read-only', networkAccessEnabled: false } : {}) }
    const thread = sessionId ? client.resumeThread(sessionId, options) : client.startThread(options)
    const { events } = await thread.runStreamed(request.prompt, { signal })
    for await (const event of events) {
      if (event.type === 'thread.started' && (request.sessionId && event.thread_id !== request.sessionId || request.forbiddenSessionId && event.thread_id === request.forbiddenSessionId)) throw Object.assign(new Error('Codex resumed a different Task-role thread'), { code: 'bot/context-resume' })
      if (['turn.failed', 'error'].includes(event.type)) { const auth = sdkAuthenticationFailure(event, request.harness); if (auth) throw authenticationError(auth) }
      await emit({ type: 'sdk-event', harness: request.harness, event })
      if (event.type === 'thread.started') sessionId = event.thread_id
      if (event.type === 'item.completed' && event.item?.type === 'agent_message') text = event.item.text
      if (event.type === 'turn.completed') { completed = true; usage = event.usage }
      if (event.type === 'turn.failed' || event.type === 'error') throw new Error('Codex SDK turn failed')
    }
  } else if (request.harness === 'claude-agent') {
    const { query } = await loadClaude()
    const controller = new AbortController()
    const abort = () => controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    const stream = query({ prompt: request.prompt, options: {
      cwd: request.cwd, model: request.model, env: request.env, abortController: controller,
      settingSources: [], mcpServers: {}, persistSession: true,
      ...(sessionId ? { resume: sessionId } : {}), maxTurns: request.probe ? 1 : 30, maxBudgetUsd: request.maxBudgetUsd ?? 1,
      permissionMode: 'default',
      tools: toolsDisabled ? [] : request.readOnly ? ['Read', 'Glob', 'Grep', 'Bash'] : ['Read', 'Glob', 'Grep', 'Bash', 'Edit', 'Write'],
      hooks: toolsDisabled ? { PreToolUse: [{ hooks: [async () => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Use FlyBot scoped action proposals only' } })] }] } : {},
      canUseTool: async (name, input, options) => {
        if (toolsDisabled) return { behavior: 'deny', message: 'Generic Chief tools are disabled' }
        const answer = await permission({ name, input, requestId: options.requestId ?? options.toolUseID })
        return answer.allow ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'FlyBot operator refused this action' }
      },
    } })
    try {
      for await (const event of stream) {
        if (event.session_id && (request.sessionId && event.session_id !== request.sessionId || request.forbiddenSessionId && event.session_id === request.forbiddenSessionId)) throw Object.assign(new Error('Claude returned an incompatible Task-role Session'), { code: 'bot/context-resume' })
        if (event.type === 'result' && event.is_error) { const auth = sdkAuthenticationFailure({ message: event.result, code: event.error }, request.harness); if (auth) throw authenticationError(auth) }
        await emit({ type: 'sdk-event', harness: request.harness, event })
        if (event.session_id) sessionId = event.session_id
        if (event.type === 'result') {
          if (event.is_error || event.subtype !== 'success') throw new Error('Claude Agent SDK turn failed')
          text = event.result ?? ''; usage = { usage: event.usage, totalCostUsd: event.total_cost_usd }; completed = true
        }
      }
    } finally { signal?.removeEventListener('abort', abort); stream.close?.() }
  } else throw new Error('Unknown SDK Harness')
  if (!completed || !sessionId || signal?.aborted) throw new Error('SDK stream ended without a completed turn and bound Session')
  return { text, sessionId, usage }
}

export async function runHarnessTurn(request, ports) {
  try { return await executeHarnessTurn(request, ports) }
  catch (error) { const auth = sdkAuthenticationFailure({ code: error?.authenticationFailure?.code }, request.harness) ?? sdkAuthenticationFailure(error, request.harness); if (auth) throw authenticationError(auth); throw error }
}
