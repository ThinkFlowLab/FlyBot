import { createHash } from 'node:crypto'

const sha = value => createHash('sha256').update(value).digest('hex')
const relative = value => typeof value === 'string' && value.length > 0 && value.length <= 500 && !/^[\\/]|^[A-Za-z]:|[\0\r\n\\]/.test(value) && value.split('/').every(part => part && part !== '.' && part !== '..')
const argv = value => Array.isArray(value) && value.length > 0 && value.length <= 30 && value.every(part => typeof part === 'string' && part.length <= 4000 && !part.includes('\0')) && value[0].trim()
export function dependencyEnvironment(settings) {
  const spec = settings.dependencyEnvironment
  if (spec === undefined) return null
  const invalid = () => { throw Object.assign(new Error('Repository dependencyEnvironment is invalid; check operator provisioning'), { code: 'bot/repository-config', field: 'dependencyEnvironment' }) }
  if (!spec || typeof spec !== 'object' || Array.isArray(spec) || Object.keys(spec).some(key => !['packageManager', 'lockFiles', 'tools', 'requiredPaths', 'npmCachePath', 'network', 'timeoutMs'].includes(key))) invalid()
  if (spec.packageManager !== undefined && (typeof spec.packageManager !== 'string' || spec.packageManager.length > 100)) invalid()
  for (const key of ['lockFiles', 'requiredPaths']) if (spec[key] !== undefined && (!Array.isArray(spec[key]) || spec[key].length > 32 || !spec[key].every(relative))) invalid()
  if (spec.npmCachePath !== undefined && !relative(spec.npmCachePath)) invalid()
  if (spec.tools !== undefined && (!Array.isArray(spec.tools) || spec.tools.length > 16 || spec.tools.some(tool => !tool || !argv(tool.argv) || tool.expectedOutput !== undefined && (typeof tool.expectedOutput !== 'string' || tool.expectedOutput.length > 500)))) invalid()
  if (spec.network !== undefined && !['offline', 'operator-preparation'].includes(spec.network)) invalid()
  if (spec.timeoutMs !== undefined && (!Number.isSafeInteger(spec.timeoutMs) || spec.timeoutMs < 1 || spec.timeoutMs > 120_000)) invalid()
  return spec
}

export function executionOutcome(error, output = '', { stage = 'tests', remote = false } = {}) {
  if (!error) return { status: 'passed', reason: 'command-completed', exitConfirmed: true }
  const timedOut = error.killed === true || error.code === 'ETIMEDOUT' || error.signal === 'SIGTERM' || error.signal === 'SIGKILL'
  if (remote && (timedOut || typeof error.code !== 'number' || [125, 255].includes(error.code))) return { status: 'execution-unknown', reason: 'resource-command-exit-unconfirmed', exitConfirmed: false }
  if (timedOut) return { status: 'execution-timeout', reason: 'command-deadline', exitConfirmed: true }
  if (stage === 'preparation') return { status: 'environment-blocked', reason: 'preparation-command-failed', exitConfirmed: true }
  if (['ENOENT', 'EACCES'].includes(error.code) || /\b(?:ENOTCACHED|only-if-cached|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|EAI_AGAIN|ENOTFOUND|ENETUNREACH|ECONNREFUSED)\b|Cannot find (?:module|package)|command not found|network (?:is unreachable|access.*denied)|registry.*(?:denied|unavailable)/i.test(output)) return { status: 'environment-blocked', reason: 'dependency-tool-cache-or-network-unavailable', exitConfirmed: true }
  if (typeof error.code !== 'number') return { status: 'execution-unknown', reason: 'test-exit-unconfirmed', exitConfirmed: false }
  return { status: /AssertionError|ERR_ASSERTION|assertion failed/i.test(output) ? 'assertion-failed' : 'test-process-failed', reason: 'nonzero-test-exit', exitConfirmed: true }
}

// Executed on the workspace's own executor. Paths cannot cross checkout boundaries.
export const environmentSnapshotScript = `const fs=require('node:fs'),p=require('node:path'),c=require('node:crypto');
const s=JSON.parse(process.argv[1]),root=fs.realpathSync(process.cwd()),out={locks:{},paths:[]};
function path(name){const a=p.resolve(root,name),b=fs.realpathSync(a);if(b!==a||!b.startsWith(root+p.sep))throw Error('dependency-path-scope');return b}
for(const name of s.lockFiles||[]){const f=path(name);if(!fs.statSync(f).isFile()||fs.statSync(f).size>8*1024*1024)throw Error('dependency-lock-unavailable');out.locks[name]=c.createHash('sha256').update(fs.readFileSync(f)).digest('hex')}
for(const name of s.requiredPaths||[]){fs.accessSync(path(name),fs.constants.R_OK);out.paths.push(name)}
if(s.npmCachePath){const f=path(s.npmCachePath);if(!fs.statSync(f).isDirectory())throw Error('dependency-cache-unavailable');out.cache=s.npmCachePath}
console.log(JSON.stringify(out));`

export const copyDependencyCacheScript = `const fs=require('node:fs'),p=require('node:path');
const root=fs.realpathSync(process.cwd()),source=p.resolve(root,process.argv[1]),target=process.argv[2];
if(fs.realpathSync(source)!==source||!source.startsWith(root+p.sep)||!fs.statSync(source).isDirectory())throw Error('dependency-cache-scope');
let count=0;function check(path){if(++count>100000)throw Error('dependency-cache-budget');const s=fs.lstatSync(path);if(s.isSymbolicLink()||!s.isFile()&&!s.isDirectory())throw Error('dependency-cache-entry');if(s.isDirectory())for(const entry of fs.readdirSync(path))check(p.join(path,entry))}
check(source);fs.cpSync(source,target,{recursive:true,errorOnExist:true,force:false});`

export async function prepareDependencyEnvironment({ settings, scope, run, preparationNetwork = 'offline' }) {
  const spec = dependencyEnvironment(settings)
  const receipt = { version: 'project-environment/v1', ...scope, status: 'not-declared', startedAt: Date.now(), configurationSha256: sha(JSON.stringify({ spec, command: settings.workspacePrepareCommand ?? null })), commands: [], logs: '' }
  const command = async (args, timeout) => {
    const entry = { commandSha256: sha(JSON.stringify(args)), executable: args[0], startedAt: Date.now() }
    receipt.commands.push(entry)
    try {
      const value = await run(args, timeout)
      entry.status = 'passed'; entry.outputSha256 = sha(String(value.stdout ?? '') + String(value.stderr ?? '')); entry.completedAt = Date.now()
      receipt.logs += String(value.stdout ?? '') + String(value.stderr ?? '')
      return value
    } catch (error) {
      const output = String(error.stdout ?? '') + String(error.stderr ?? '')
      Object.assign(entry, executionOutcome(error, output, { stage: 'preparation', remote: scope.executor === 'docker-resource' }), { completedAt: Date.now(), outputSha256: sha(output) })
      receipt.logs += output
      receipt.status = entry.status; receipt.reason = entry.reason; receipt.exitConfirmed = entry.exitConfirmed; receipt.completedAt = Date.now()
      error.environmentReceipt = receipt
      throw error
    }
  }
  try {
    if (spec?.network === 'operator-preparation' && preparationNetwork !== 'operator-preparation') throw Object.assign(new Error('Dependency preparation network capability is not provisioned'), { code: 'bot/execution-environment' })
    const timeout = spec?.timeoutMs ?? 30_000
    const before = spec ? JSON.parse((await command(['node', '-e', environmentSnapshotScript, JSON.stringify({ lockFiles: spec.lockFiles })], timeout)).stdout) : null
    if (settings.workspacePrepareCommand) await command(settings.workspacePrepareCommand, timeout)
    const tools = []
    for (const tool of spec?.tools ?? []) {
      const result = await command(tool.argv, timeout)
      const observed = String(result.stdout).trim()
      if (observed.length > 500 || tool.expectedOutput !== undefined && tool.expectedOutput !== observed) throw Object.assign(new Error('Required dependency tool version does not match'), { code: 'bot/execution-environment' })
      tools.push({ commandSha256: sha(JSON.stringify(tool.argv)), output: observed })
    }
    const after = spec ? JSON.parse((await command(['node', '-e', environmentSnapshotScript, JSON.stringify(spec)], timeout)).stdout) : null
    if (spec && JSON.stringify(before.locks) !== JSON.stringify(after.locks)) throw Object.assign(new Error('Dependency preparation changed a pinned lockfile'), { code: 'bot/execution-environment' })
    receipt.status = spec || settings.workspacePrepareCommand ? 'ready' : 'not-declared'
    receipt.exitConfirmed = true; receipt.completedAt = Date.now()
    if (after) { receipt.locks = after.locks; receipt.tools = tools; receipt.cache = after.cache ?? null; receipt.identitySha256 = sha(JSON.stringify({ projectId: scope.projectId, resourceId: scope.resourceId, executor: scope.executor, principalId: scope.principalId ?? null, configuration: receipt.configurationSha256, locks: after.locks, tools })) }
    return receipt
  } catch (error) {
    if (!error.environmentReceipt) { Object.assign(receipt, { status: 'environment-blocked', reason: 'dependency-contract-unavailable', exitConfirmed: true, completedAt: Date.now() }); error.environmentReceipt = receipt }
    throw error
  }
}
