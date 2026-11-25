// Provisioning can seed the personal agent before the DS-Bot runtime is ready.
import { readFileSync } from 'node:fs'

const DEFAULT_FILE = '/run/secrets/flybot-workspace-runtime-key.json'

export function loadPersonalAgentBootstrap(env = process.env, reader = readFileSync) {
  const path = env.FLYBOT_WORKSPACE_RUNTIME_KEY_FILE || DEFAULT_FILE
  let raw
  try {
    raw = reader(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
  if (!raw || !raw.trim()) return null
  const doc = JSON.parse(raw)
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error('Personal agent provisioning file must contain a JSON object')
  }
  return doc.agent_bootstrap ?? null
}
