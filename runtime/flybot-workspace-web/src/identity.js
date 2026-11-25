// The identity of this DS-Bot runtime as FlyBot sees it. The manager sets
// FLYBOT_WORKSPACE_INSTANCE_ID (a 32-hex instance id, not a secret). Without it the
// plugin keeps a random per-volume id under /data/flybot-workspace, so two runtimes
// never report the same identity. The id is used for routing proofs only; it
// grants nothing.
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ID = /^[0-9a-f]{32}$/

export function loadIdentity({ env = {}, dataDir }) {
  const route = String(env.FLYBOT_WORKSPACE_ROUTING_INSTANCE_ID ?? '')
  const routing = ID.test(route) ? { routingInstanceId: route } : {}
  const fromEnv = String(env.FLYBOT_WORKSPACE_INSTANCE_ID ?? '')
  if (ID.test(fromEnv)) return Object.freeze({ instanceId: fromEnv, source: 'manager', ...routing })
  const dir = join(dataDir, 'flybot-workspace')
  const file = join(dir, 'instance.json')
  try {
    const stored = JSON.parse(readFileSync(file, 'utf8'))
    if (ID.test(String(stored?.instance_id ?? ''))) return Object.freeze({ instanceId: stored.instance_id, source: 'volume', ...routing })
  } catch { /* first start or unreadable: create below */ }
  const instanceId = randomBytes(16).toString('hex')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(file, JSON.stringify({ version: 1, instance_id: instanceId }) + '\n', { mode: 0o600 })
  return Object.freeze({ instanceId, source: 'volume', ...routing })
}
