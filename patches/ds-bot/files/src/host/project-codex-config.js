import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { dirname, join, delimiter } from 'node:path'
import { createInterface } from 'node:readline'

const failure = code => Object.assign(new Error('Codex configuration is not ready; verify the selected resource CLI version and remove conflicting legacy sandbox settings before retrying'), { code: 'bot/harness-capability', capability: code })
const sameRules = (actual, expected) => JSON.stringify(Object.entries(actual ?? {}).sort()) === JSON.stringify(Object.entries(expected).sort())
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const toml = value => object(value) ? '{' + Object.entries(value).filter(([, child]) => child !== undefined).map(([key, child]) => `${JSON.stringify(key)}=${toml(child)}`).join(',') + '}' : Array.isArray(value) ? '[' + value.map(toml).join(',') + ']' : JSON.stringify(value)
export function codexConfigArguments(config, overrides = []) {
  const values = []
  function flatten(value, prefix = '') {
    for (const [key, child] of Object.entries(value)) {
      if (child === undefined) continue
      const path = prefix ? `${prefix}.${key}` : key
      if (object(child) && Object.keys(child).length) flatten(child, path)
      else values.push(`${path}=${toml(child)}`)
    }
  }
  flatten(config)
  return [...values, ...overrides].flatMap(value => ['--config', value])
}

// Resolve from the same installed SDK dependency graph, never global PATH.
export function codexExecutable(sdkUrl) {
  try {
    const sdkRequire = createRequire(sdkUrl ?? import.meta.resolve('@openai/codex-sdk'))
    const cliRequire = createRequire(sdkRequire.resolve('@openai/codex/package.json'))
    const target = { linux: { x64: 'x86_64-unknown-linux-musl', arm64: 'aarch64-unknown-linux-musl' }, darwin: { x64: 'x86_64-apple-darwin', arm64: 'aarch64-apple-darwin' }, win32: { x64: 'x86_64-pc-windows-msvc', arm64: 'aarch64-pc-windows-msvc' } }[process.platform]?.[process.arch]
    if (!target) throw failure('unsupported-platform')
    const platform = { linux: 'linux', darwin: 'darwin', win32: 'win32' }[process.platform]
    const vendor = join(dirname(cliRequire.resolve(`@openai/codex-${platform}-${process.arch}/package.json`)), 'vendor', target)
    const name = process.platform === 'win32' ? 'codex.exe' : 'codex'
    if (existsSync(join(vendor, 'codex-package.json')) && existsSync(join(vendor, 'bin', name))) return { executable: join(vendor, 'bin', name), pathDirectory: join(vendor, 'codex-path') }
    if (existsSync(join(vendor, 'codex', name))) return { executable: join(vendor, 'codex', name), pathDirectory: join(vendor, 'path') }
    throw failure('missing-cli')
  } catch { throw failure('missing-cli') }
}

function cli(executable, args, { env, cwd, signal, rpc = false }) {
  return new Promise((resolve, reject) => {
    let child, timer, bytes = 0, result, invalid = false, stdout = ''
    const stop = () => { invalid = true; child?.kill('SIGKILL') }
    try { child = spawn(executable, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] }) } catch { reject(failure('cli-unavailable')); return }
    timer = setTimeout(stop, 10_000)
    signal?.addEventListener('abort', stop, { once: true })
    if (signal?.aborted) stop()
    child.stdin.on('error', stop)
    child.stderr.on('data', data => { bytes += data.length; if (bytes > 2 * 1024 * 1024) stop() })
    child.stdout.on('data', data => { bytes += data.length; if (bytes > 2 * 1024 * 1024) stop(); if (!rpc) stdout += data })
    if (rpc) {
      const lines = createInterface({ input: child.stdout })
      lines.on('line', line => {
        try {
          const value = JSON.parse(line)
          if (value.id === 1) {
            if (value.error) { stop(); return }
            child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n')
            child.stdin.write(JSON.stringify({ id: 2, method: 'config/read', params: { includeLayers: true, cwd } }) + '\n')
          }
          if (value.id === 2) { result = value.result; if (!result || value.error) invalid = true; child.kill('SIGTERM') }
        } catch { stop() }
      })
      child.stdin.write(JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'flybot-config-check', version: '1' } } }) + '\n')
    } else child.stdin.end()
    child.once('error', () => { invalid = true })
    child.once('close', code => {
      clearTimeout(timer); signal?.removeEventListener('abort', stop)
      if (invalid || (rpc ? !result : code !== 0)) reject(failure('cli-configuration'))
      else resolve(rpc ? result : stdout)
    })
  })
}

export async function validateCodexConfiguration(request, options, { executable, pathDirectory } = codexExecutable()) {
  const declared = options.configOverrides.find(value => value.startsWith('permissions.flybot-role='))
  if (!request.noTools && (!declared || /":tmp"\s*=/.test(declared))) throw failure('permission-profile-mismatch')
  const env = { ...request.env }
  if (pathDirectory && existsSync(pathDirectory)) env.PATH = pathDirectory + delimiter + (env.PATH ?? '')
  const context = { env, cwd: request.cwd, signal: request.signal }
  const version = (await cli(executable, ['--version'], context)).trim()
  if (version !== 'codex-cli 0.166.0') throw failure('unsupported-cli-version')
  const args = codexConfigArguments(options.config, [...options.configOverrides,
    ...(options.baseUrl ? [`openai_base_url=${JSON.stringify(options.baseUrl)}`] : []),
    'web_search="disabled"', 'approval_policy="never"',
    ...(request.noTools ? ['sandbox_mode="read-only"', 'sandbox_workspace_write.network_access=false'] : [])])
  await cli(executable, [...args, 'app-server', '--print-startup-config'], context)
  if (!request.noTools) {
    const resolved = await cli(executable, [...args, 'app-server'], { ...context, rpc: true })
    // Defaults in config/read contain legacy fields too; only explicitly loaded
    // layers establish a conflict. Never log their values or credential material.
    if (!Array.isArray(resolved.layers) || resolved.layers.some(layer => Object.hasOwn(layer.config ?? {}, 'sandbox_mode') || Object.hasOwn(layer.config ?? {}, 'sandbox_workspace_write')) || resolved.config?.default_permissions !== 'flybot-role') throw failure('legacy-sandbox-conflict')
    const profile = resolved.config?.permissions?.['flybot-role']
    if (profile?.extends !== (request.readOnly ? ':read-only' : ':workspace') || profile.filesystem?.[':tmpdir'] !== 'write' || Object.keys(profile.filesystem ?? {}).some(key => key.startsWith(':') && key !== ':tmpdir') || profile.network?.mode !== 'limited' || !sameRules(profile.network?.domains, request.roleGithub ? { 'github.com': 'allow', 'api.github.com': 'allow' } : {}) || !sameRules(profile.network?.unix_sockets, {}) || resolved.config?.features?.network_proxy !== true) throw failure('permission-profile-mismatch')
  }
  return { codexPathOverride: executable, env, capability: { kind: 'codex-cli-config/v1', version: '0.166.0', profile: request.noTools ? 'chief-read-only' : 'flybot-role', modelInvoked: false } }
}
