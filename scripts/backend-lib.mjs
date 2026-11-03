// Source deployment of the existing DSH/FlyBot host; no second API or executor.
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { writeDurableStateFile } from '../core/src/host/project-state-storage.js'
import { linkPackages } from '../docker/profile.mjs'

export const root = resolve(import.meta.dirname, '..')
export const cliPath = join(root, 'core/dev/harness/node_modules/@deepseek-ai/dsh/lib/bin.js')
export const homeOf = options => resolve(options.home ?? process.env.FLYBOT_HOME ?? join(homedir(), '.flybot-backend'))
export function privateJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeDurableStateFile(path, JSON.stringify(value, null, 2) + '\n')
}
export const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
export function optionsOf(argv) {
  const [command = 'help', ...rest] = argv, options = {}, positional = []
  for (let i = 0; i < rest.length; ++i) {
    if (!rest[i].startsWith('--')) { positional.push(rest[i]); continue }
    const key = rest[i].slice(2)
    if (!['home', 'config', 'project', 'json', 'request-id', 'email', 'after'].includes(key) || options[key] !== undefined || !rest[i + 1] || rest[i + 1].startsWith('--')) throw new Error('Unknown, repeated or incomplete option')
    options[key] = rest[++i]
  }
  return { command, options, positional }
}
export function backendConfig(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['port', 'publicOrigin', 'bot'].includes(key))) throw new Error('Configuration accepts port, publicOrigin and bot only')
  const port = value.port ?? 3080
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('port must be between1 and65535')
  if (value.bot !== undefined && (!value.bot || typeof value.bot !== 'object' || Array.isArray(value.bot))) throw new Error('bot must be a FlyBot configuration object')
  const bot = { projectWorkbench: true, stateStorage: 'sqlite', projectDispatch: 'pools', ...value.bot }
  if (bot.projectWorkbench !== true || bot.projectDispatch !== 'pools' || !['json', 'sqlite'].includes(bot.stateStorage) || bot.home !== undefined) throw new Error('Backend uses projectWorkbench, pool dispatch and its own persistent home')
  if (value.publicOrigin !== undefined) {
    const url = new URL(value.publicOrigin)
    if (url.origin !== value.publicOrigin || url.protocol !== 'https:') throw new Error('publicOrigin must be one HTTPS origin')
  }
  return { port, ...(value.publicOrigin ? { publicOrigin: value.publicOrigin } : {}), bot }
}
export function installDependencies() {
  for (const directory of ['core', 'core/dev/harness']) {
    const manifest = readJson(join(root, directory, 'package.json'))
    const dependencies = { ...manifest.dependencies, ...manifest.devDependencies }
    const ready = Object.entries(dependencies).every(([name, version]) => {
      try { return readJson(join(root, directory, 'node_modules', name, 'package.json')).version === version } catch { return false }
    })
    if (ready) continue
    const result = spawnSync('npm', ['ci', '--no-fund', '--no-audit'], { cwd: join(root, directory), stdio: 'inherit' })
    if (result.status !== 0) throw new Error(`Dependency installation failed in ${directory}`)
  }
}
export function prepareBackend(home, config) {
  const profile = join(home, 'profiles/web')
  const packages = ['core', 'plugins/social', 'plugins/tree', 'plugins/timeline', 'plugins/workflow'].map(directory => ({ name: readJson(join(root, directory, 'package.json')).name, dir: join(root, directory) }))
  const manifest = join(profile, 'package.json')
  const linked = linkPackages(existsSync(manifest) ? readJson(manifest) : undefined, packages)
  const version = readJson(join(root, 'core/dev/harness/package.json')).dependencies['@deepseek-ai/dsh']
  for (const name of ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']) linked.dependencies[name] = version
  privateJson(manifest, linked)
  const workspace = join(profile, 'pnpm-workspace.yaml')
  if (!existsSync(workspace)) writeFileSync(workspace, `packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n\nonlyBuiltDependencies:\n  - '@deepseek-ai/dsh-subprocess-local'\n  - '@google/genai'\n  - koffi\n  - node-pty\n  - protobufjs\n`, { mode: 0o600 })
  mkdirSync(join(home, 'workspace'), { recursive: true })
  privateJson(join(home, 'backend.json'), config)
  writeFileSync(join(home, 'backend.patch.yml'), readFileSync(join(root, 'docker/web.patch.yml'), 'utf8') + '\n- id: bot\n  config: ' + JSON.stringify(config.bot) + '\n', { mode: 0o600 })
  chmodSync(join(home, 'backend.patch.yml'), 0o600)
  return profile
}
export async function connection(home, operator = false) {
  const transport = readJson(join(home, 'private/backend-transport.json'))
  const url = new URL(transport.loginUrl)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/' || !url.searchParams.get('token') || url.origin !== transport.upstreamOrigin) throw new Error('Invalid local DSH transport; restart this backend')
  const base = new URL(transport.baseUrl)
  if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || base.pathname !== '/' || base.search || base.username || base.password) throw new Error('Invalid local backend transport')
  if (!operator) return { baseUrl: transport.baseUrl, cookie: '', ...(transport.publicOrigin ? { publicOrigin: transport.publicOrigin } : {}) }
  const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10000) })
  const cookie = response.headers.getSetCookie().map(row => row.split(';')[0]).join('; ')
  if (!cookie) throw new Error('DSH transport sign-in failed; restart this backend')
  return { baseUrl: url.origin, cookie }
}
export async function callApi(transport, endpoint, payload, sessionToken) {
  const response = await fetch(`${transport.baseUrl}/api/bot`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
    headers: { 'content-type': 'application/json', cookie: transport.cookie, ...(transport.publicOrigin ? { host: new URL(transport.publicOrigin).host, origin: transport.publicOrigin } : {}), ...(sessionToken ? { 'x-flybot-member-session': sessionToken } : {}) }, body: JSON.stringify({ endpoint, payload }) })
  if (!response.ok) throw new Error(`Backend HTTP${response.status}`)
  const result = await response.json()
  if (!result.ok) throw new Error(`${result.error?.code ?? result.error ?? 'Backend request refused'}: ${result.error?.message ?? 'Check current permissions and request'} `)
  return result.value
}
export function requestBody(command, name, options) {
  const payload = options.json ? JSON.parse(options.json.startsWith('@') ? readFileSync(options.json.slice(1), 'utf8') : options.json) : {}
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('JSON payload must be an object')
  if (command === 'request') return { endpoint: name, payload }
  if (!options.project || command === 'command' && !options['request-id']) throw new Error('Use --project and a stable --request-id for commands')
  return { endpoint: 'project-development', payload: { version: 'project-development/v1', kind: command, name, projectId: options.project,
    ...(command === 'command' ? { requestId: options['request-id'] } : {}), payload } }
}
