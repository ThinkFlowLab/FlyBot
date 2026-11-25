// Personal agent profile, kept in the user's own DS-Bot (moved from personal.py).
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fail } from '../../src/store.js'

const DEFAULTS = Object.freeze({ name: 'My assistant', instructions: '', recall: 'all' })

export default function personal(host) {
  const file = () => join(host.featureDir(), 'profile.json')
  const read = () => {
    try { return { ...DEFAULTS, ...JSON.parse(readFileSync(file(), 'utf8')) } } catch { return { ...DEFAULTS } }
  }
  return {
    endpoints: {
      async get() { return read() },
      async set(payload) {
        if (!payload || typeof payload !== 'object') fail('personal/invalid', 'Object payload required')
        const next = read()
        if (payload.name !== undefined) {
          if (typeof payload.name !== 'string' || !payload.name.trim() || payload.name.length > 60) fail('personal/invalid', 'Name must be 1–60 characters')
          next.name = payload.name.trim()
        }
        if (payload.instructions !== undefined) {
          if (typeof payload.instructions !== 'string' || payload.instructions.length > 4000) fail('personal/invalid', 'Instructions must be at most 4000 characters')
          next.instructions = payload.instructions
        }
        if (payload.recall !== undefined) {
          if (!['all', 'off'].includes(payload.recall)) fail('personal/invalid', 'recall must be all or off')
          next.recall = payload.recall
        }
        writeFileSync(file() + '.tmp', JSON.stringify(next), { mode: 0o600 })
        renameSync(file() + '.tmp', file())
        return next
      },
    },
  }
}
