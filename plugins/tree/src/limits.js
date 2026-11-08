import { readFileSync } from 'node:fs'
import { nameKey } from './identity.js'

const FILE = JSON.parse(readFileSync(new URL('../limits.json', import.meta.url), 'utf8'))
export const DEFAULT_LIMITS = Object.freeze({ maxDepth: FILE.maxDepth ?? 5, maxChildren: FILE.maxChildren ?? 8 })

/** Plugin config wins over limits.json. Depth counts the root as 1. */
export function resolveLimits(config = {}) {
  const pick = (v, d) => (Number.isInteger(v) && v > 0 ? v : d)
  return { maxDepth: pick(config.maxDepth, DEFAULT_LIMITS.maxDepth), maxChildren: pick(config.maxChildren, DEFAULT_LIMITS.maxChildren) }
}

export const MAX_NAME_LENGTH = 40 // ds-bot roster truncates names to 40 characters

/** Returns null when allowed, else the rejection reason. */
export function checkCreate({ parentName, parentDepth, siblings, name, limits }) {
  if (!String(name ?? '').trim()) return 'name required'
  if (String(name).trim().length > MAX_NAME_LENGTH) return `name must be at most ${MAX_NAME_LENGTH} characters`
  // #2692: a sibling name is compared by the shared name key, so either canonical spelling of one
  // visible name is one sibling instead of two children that render the same.
  if (siblings.some(s => nameKey(s.name) === nameKey(name))) return `a child named "${String(name).trim()}" already exists under ${parentName}; delegate to it instead of creating a duplicate`
  if (siblings.length >= limits.maxChildren) return `limit reached: ${parentName} already has ${siblings.length} children (maxChildren=${limits.maxChildren})`
  if (parentDepth + 1 > limits.maxDepth) return `limit reached: a child of ${parentName} would be at depth ${parentDepth + 1} (maxDepth=${limits.maxDepth})`
  return null
}
