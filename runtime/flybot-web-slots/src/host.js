import { callFlybot } from './call.js'
import { createSlotRegistry } from './slots.js'

// record.retry === false is a terminal failure; anything else may be retried.
export function canRetry(record) {
  return record?.retry !== false
}

export function defaultNames() {
  return {
    friendBotOwner: (bot) => String(bot?.remote?.owner || bot?.owner || bot?.remote?.homeName || '').trim(),
    remoteMentionLabel: (friend) => {
      const name = String(friend?.name || '').trim()
      const owner = String(friend?.owner || friend?.homeName || '').trim()
      return name && owner && owner !== name ? `${name} (${owner})` : name
    },
  }
}

// Idempotent. Social's client waits a few seconds if this is not ready yet.
export function installFlybotHost(options = {}) {
  const existing = globalThis.__flybot__
  if (existing?.slots && typeof existing.call === 'function' && options.replace !== true) {
    return existing
  }
  const slots = options.slots ?? createSlotRegistry()
  const call = options.call ?? callFlybot
  const host = {
    slots,
    call,
    canRetry,
    names: options.names ?? defaultNames(),
    api: { call },
  }
  globalThis.__flybot__ = host
  return host
}

export function uninstallFlybotHost(expected) {
  if (expected && globalThis.__flybot__ !== expected) return
  if (globalThis.__flybot__) delete globalThis.__flybot__
}
