// A repository runtime is an operator capability, not granted by typing its name.
import { isAbsolute, resolve, dirname, join, delimiter } from 'node:path'
import { access, stat, realpath } from 'node:fs/promises'
import { constants } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { ownEntry } from './store.js'
import { executionProfile } from './project-execution-profile.js'
const exec = promisify(execFile)
const invalid = field => Object.assign(new Error(`Repository ${field} is missing, invalid or unavailable; ask the operator to check provisioning`), { code: 'bot/repository-config', field })
const argument = value => typeof value === 'string' && !value.includes('\0')
const relativePath = value => argument(value) && value.length > 0 && value === value.trim() && !isAbsolute(value) && !/\\|[\r\n*?\[\]]|^[A-Za-z]:/.test(value) && value.split('/').every((part, index, all) => part !== '..' && part !== '.' && (part !== '' || index === all.length - 1))
export const repositoryAllowed = (settings, memberId) => Array.isArray(settings?.allowedProjectOwnerIds)
  ? settings.allowedProjectOwnerIds.includes(memberId) : memberId === 'owner-1'
export function repositorySettings(rt, project) {
  if (project.repository === null && project.executionKind === 'decision') return { model: rt.config.projectModel, allowedPaths: [], testCommand: [] }
  const settings = ownEntry(rt.config.projectRepositories ?? {}, project.repository)
  if (!settings || !repositoryAllowed(settings, project.ownerUserId)) throw Object.assign(new Error('Project repository/test capability is not provisioned for this owner'), { code: 'bot/delivery' })
  if (!argument(settings.path) || !isAbsolute(settings.path)) throw invalid('path')
  if (!Array.isArray(settings.allowedPaths) || !settings.allowedPaths.length || !settings.allowedPaths.every(relativePath)) throw invalid('allowedPaths')
  if (!Array.isArray(settings.testCommand) || !settings.testCommand.length || !settings.testCommand.every(argument) || !settings.testCommand[0].trim()) throw invalid('testCommand')
  if (settings.workspacePrepareCommand !== undefined && (!Array.isArray(settings.workspacePrepareCommand) || !settings.workspacePrepareCommand.length || !settings.workspacePrepareCommand.every(argument) || !settings.workspacePrepareCommand[0].trim())) throw invalid('workspacePrepareCommand')
  if (settings.testTimeoutMs !== undefined && (!Number.isSafeInteger(settings.testTimeoutMs) || settings.testTimeoutMs < 1)) throw invalid('testTimeoutMs')
  if (settings.testDependencies !== undefined && (!Array.isArray(settings.testDependencies) || settings.testDependencies.some(path => !relativePath(path)))) throw invalid('testDependencies')
  return settings
}
async function executable(command, cwd) {
  const paths = isAbsolute(command) ? [command] : command.includes('/') ? [resolve(cwd, command)] : (process.env.PATH ?? '').split(delimiter).filter(Boolean).map(path => resolve(path, command))
  const candidates = process.platform === 'win32' ? paths.flatMap(path => [path, `${path}.exe`, `${path}.com`]) : paths
  for (const path of candidates) {
    try { if ((await stat(path)).isFile()) { await access(path, constants.X_OK); return } }
    catch { /* Try the next operator PATH entry; no process is started by this check. */ }
  }
  throw invalid('testCommand')
}
async function writableDirectory(path) {
  let current = resolve(path)
  while (true) {
    try { if (!(await stat(current)).isDirectory()) throw invalid('workspace'); await access(current, constants.W_OK | constants.X_OK); return }
    catch (error) { if (error.code !== 'ENOENT') throw invalid('workspace') }
    const parent = dirname(current)
    if (parent === current) throw invalid('workspace')
    current = parent
  }
}
// Metadata-only preflight: never run tests, install dependencies, infer or allocate a worker.
export async function preflightRepository(rt, project) {
  executionProfile(rt.config)
  const settings = repositorySettings(rt, project)
  if (project.repository === null && project.executionKind === 'decision') return settings
  let path
  try { path = await realpath(settings.path); if (!(await stat(path)).isDirectory()) throw invalid('path'); await access(path, constants.R_OK | constants.W_OK | constants.X_OK) }
  catch { throw invalid('path') }
  try {
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }
    const options = { cwd: path, timeout: 5000, maxBuffer: 16384, env }
    const top = (await exec('git', ['rev-parse', '--show-toplevel'], options)).stdout.trim()
    if (await realpath(top) !== path) throw invalid('git')
    await exec('git', ['rev-parse', '--verify', 'HEAD^{commit}'], options)
  } catch { throw invalid('git') }
  await executable(settings.testCommand[0], path)
  for (const dependency of settings.testDependencies ?? []) {
    try { await access(resolve(path, dependency), constants.R_OK) }
    catch { throw invalid('testDependencies') }
  }
  if (rt.home) await writableDirectory(rt.home)
  const root = rt.config.projectWorkspaceRoot ?? (rt.dshHome ? join(dirname(rt.dshHome), 'flybot-workspaces') : null)
  if (root) await writableDirectory(root)
  return settings
}
const observations = new WeakMap()
export async function repositoryReadiness(rt, project) {
  let rows = observations.get(rt)
  if (!rows) { rows = new Map(); observations.set(rt, rows) }
  const key = JSON.stringify([project.id, project.ownerUserId, rt.config.projectExecutionProfile, rt.config.projectRepositories?.[project.repository]])
  const cached = rows.get(project.id)
  if (cached?.key === key && cached.until > Date.now()) return cached.promise
  const promise = preflightRepository(rt, project).then(settings => ({ configured: true, status: 'ready', name: project.repository, model: settings.model ?? rt.config.projectModel ?? null, tests: 'not-run' }),
    error => ({ configured: false, status: 'blocked', reason: error.message, code: error.code, field: error.field ?? null, tests: 'not-run' }))
  rows.set(project.id, { key, until: Date.now() + 3000, promise })
  return promise
}
