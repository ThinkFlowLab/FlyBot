import { roleGithubRuntime } from './project-role-github-runtime.mjs'
// Resource-side JSONL worker. No credentials in command arguments or persistent stdin logs.
import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runHarnessTurn } from './project-harness-turn.js'
import { registerSdkExit, acknowledgeSdkStop, SDK_EXIT_VERSION } from './project-sdk-exit.mjs'
const exitIdentity = process.argv[2] ? JSON.parse(process.argv[2]) : null
if (exitIdentity) await registerSdkExit(exitIdentity)
const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
let githubRuntime
let outputClosed = false
const write = value => { if (!outputClosed) process.stdout.write(JSON.stringify(githubRuntime ? githubRuntime.redact(value) : value) + '\n') }
process.stdout.on('error', () => { outputClosed = true; void shutdown() })
const answers = new Map(), credentials = new Map()
let controller, sessionId, settings, busy = false, shuttingDown = false
const completedTurns = new Map()
const permission = request => new Promise(resolve => {
  const id = randomUUID(); answers.set(id, resolve); write({ type: 'permission', id, request })
})
async function turn(message) {
  if (shuttingDown) return
  if (message.turnId && completedTurns.has(message.turnId)) { write(completedTurns.get(message.turnId)); return }
  if (busy) { write({ type: 'failure', reason: 'SDK Session is already answering' }); return }
  busy = true; controller = new AbortController()
  try {
    settings ??= message.settings
    sessionId ??= settings.sessionId
    if (settings.roleGithub && !githubRuntime) {
      githubRuntime = await roleGithubRuntime({ metadata: settings.roleGithub, scratchDirectory: settings.scratchDirectory, env: settings.env, credential: () => new Promise((resolve, reject) => {
        const id = randomUUID(), timer = setTimeout(() => { credentials.delete(id); reject(Error('Role authorization timed out')) }, 30000)
        credentials.set(id, { resolve, reject, timer }); write({ type: 'github-auth-request', id })
      }) })
      settings = { ...settings, env: githubRuntime.env, githubAuthDirectory: githubRuntime.authDirectory }
    }
    const emit = value => write({ ...value, ...(message.turnId ? { turnId: message.turnId } : {}) })
    const result = await runHarnessTurn({ ...settings, sessionId, protocolCorrection: message.protocolCorrection === true, prompt: message.prompt }, { emit, permission, signal: controller.signal })
    sessionId = result.sessionId
    const response = { type: 'completed', ...result, ...(message.turnId ? { turnId: message.turnId } : {}) }
    if (message.turnId) { completedTurns.set(message.turnId, response); if (completedTurns.size > 16) completedTurns.delete(completedTurns.keys().next().value) }
    busy = false
    write(response)
    if (settings.probe) void shutdown()
  } catch (error) { write({ type: 'failure', ...(message.turnId ? { turnId: message.turnId } : {}), ...(error?.code === 'bot/harness-auth' ? { authenticationFailure: error.authenticationFailure } : {}), reason: ['bot/harness-capability', 'bot/context-resume', 'bot/harness-auth'].includes(error?.code) ? error.message : 'SDK execution failed; inspect the redacted event evidence and resource environment', ...(error?.code === 'bot/context-resume' ? { contextFailure: { code: error.code, kind: 'backend-session-mismatch', contextPreserved: true } } : {}), ...(error?.code === 'bot/harness-capability' ? { capabilityFailure: { code: error.code, kind: error.capability, stage: 'configuration', modelInvoked: false } } : {}) }) }
  finally { busy = false }
}
input.on('line', line => {
  try {
    const message = JSON.parse(line)
    if (message.type === 'start' || message.type === 'input') void turn(message)
    else if (message.type === 'permission') { const resolve = answers.get(message.id); answers.delete(message.id); resolve?.({ allow: message.allow === true }) }
    else if (message.type === 'github-auth-response') { const pending = credentials.get(message.id); credentials.delete(message.id); if (pending) { clearTimeout(pending.timer); if (message.denied) pending.reject(Error('Role authority refused')); else pending.resolve(message.value) } }
    else if (message.type === 'stop') void shutdown()
  } catch { write({ type: 'failure', reason: 'Invalid worker protocol input' }) }
})
async function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  controller?.abort()
  for (const value of credentials.values()) { clearTimeout(value.timer); value.reject(Error('Role credential channel closed')) }; credentials.clear()
  if (githubRuntime) { await githubRuntime.close(); githubRuntime = null }
  for (const resolve of answers.values()) resolve({ allow: false })
  for (let n = 0; busy && n < 100; n++) await new Promise(resolve => setTimeout(resolve, 50))
  if (busy) return // No exit claim while the SDK has not settled; host retains capacity.
  if (exitIdentity) await acknowledgeSdkStop(exitIdentity)
  write({ type: 'stopped', released: true })
  input.close(); process.stdin.pause(); setTimeout(() => process.exit(0), 50)
}
input.on('close', () => { void shutdown() })
process.on('SIGTERM', () => { void shutdown() })
function sdkVersion(name) {
  try {
    let directory = dirname(fileURLToPath(import.meta.resolve(name)))
    for (let n = 0; n < 5; n++) {
      const path = join(directory, 'package.json')
      if (existsSync(path)) { const data = JSON.parse(readFileSync(path, 'utf8')); if (data.name === name) return data.version }
      directory = dirname(directory)
    }
  } catch { /* Missing SDK is an explicit failed handshake, not a simulated version. */ }
  return null
}
write({ type: 'ready', roleGithub: 'role-github/v1', receiptCorrection: 'input-correction/v1', exitRecovery: exitIdentity ? SDK_EXIT_VERSION : null, pid: process.pid, sdk: { codex: sdkVersion('@openai/codex-sdk'), 'claude-agent': sdkVersion('@anthropic-ai/claude-agent-sdk') } })
