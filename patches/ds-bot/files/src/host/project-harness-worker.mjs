// Resource-side JSONL worker. No credentials in command arguments or persistent stdin logs.
import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runHarnessTurn } from './project-harness-turn.js'
const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
const write = value => process.stdout.write(JSON.stringify(value) + '\n')
const answers = new Map()
let controller, sessionId, settings, busy = false, shuttingDown = false
const permission = request => new Promise(resolve => {
  const id = randomUUID(); answers.set(id, resolve); write({ type: 'permission', id, request })
})
async function turn(message) {
  if (busy) { write({ type: 'failure', reason: 'SDK Session is already answering' }); return }
  busy = true; controller = new AbortController()
  try {
    settings ??= message.settings
    sessionId ??= settings.sessionId
    const result = await runHarnessTurn({ ...settings, sessionId, prompt: message.prompt }, { emit: write, permission, signal: controller.signal })
    sessionId = result.sessionId
    write({ type: 'completed', ...result })
    if (settings.probe) void shutdown()
  } catch (error) { write({ type: 'failure', reason: error.code === 'bot/harness-capability' ? error.message : 'SDK execution failed; inspect the redacted event evidence and resource environment', ...(error.code === 'bot/harness-capability' ? { capabilityFailure: { code: error.code, kind: error.capability, stage: 'configuration', modelInvoked: false } } : {}) }) }
  finally { busy = false }
}
input.on('line', line => {
  try {
    const message = JSON.parse(line)
    if (message.type === 'start' || message.type === 'input') void turn(message)
    else if (message.type === 'permission') { const resolve = answers.get(message.id); answers.delete(message.id); resolve?.({ allow: message.allow === true }) }
    else if (message.type === 'stop') void shutdown()
  } catch { write({ type: 'failure', reason: 'Invalid worker protocol input' }) }
})
async function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  controller?.abort()
  for (const resolve of answers.values()) resolve({ allow: false })
  for (let n = 0; busy && n < 100; n++) await new Promise(resolve => setTimeout(resolve, 50))
  if (busy) return // No exit claim while the SDK has not settled; host retains capacity.
  write({ type: 'stopped', released: true })
  input.close(); process.stdin.pause(); setTimeout(() => process.exit(0), 50)
}
input.on('close', () => { void shutdown() })
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
write({ type: 'ready', pid: process.pid, sdk: { codex: sdkVersion('@openai/codex-sdk'), 'claude-agent': sdkVersion('@anthropic-ai/claude-agent-sdk') } })
