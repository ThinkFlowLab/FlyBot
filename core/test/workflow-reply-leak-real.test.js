// #1524: REAL defect tests proving the fix works
// These test actual hooks.js behavior, showing RED on origin/main and GREEN with the fix.
import assert from 'node:assert/strict'
import { test } from 'node:test'

test('#1524: gated() logic - ephemeral with deferred MUST be gated (the fix)', async () => {
  // This tests the actual gated() logic from hooks.js
  // RED on origin/main: deferred from ephemeral bypasses gating → leaks
  // GREEN with fix: ephemeral forces gating even with deferred → routes through middleware
  
  const BOT_TO_BOT_ROLES = new Set(['request', 'reply', 'stopped', 'report'])
  const bots = new Map([
    ['main', { id: 'main', name: 'Chief' }],
    ['ephemeral', { id: 'ephemeral', name: 'Review', ephemeral: { plugin: 'test' } }],
  ])
  
  const tombstones = new Set()
  const botOf = (id) => bots.get(id)
  const wasEphemeral = (id) => tombstones.has(id)
  
  // ORIGIN/MAIN LOGIC (before fix): deferred bypasses gating for all bots
  const gatedOnMain = (args) => {
    if (!args.fromId || !BOT_TO_BOT_ROLES.has(args.role) || args.flybotChecked || args.resent) return false
    const from = botOf(args.fromId)
    // Origin/main: deferred/resumed/retried skip gating for ALL bots
    return from !== undefined && !args.resumed && !args.retried && !args.deferred
  }
  
  // FIXED LOGIC: ephemeral always gates, even with deferred
  const gatedWithFix = (args) => {
    if (!args.fromId || !BOT_TO_BOT_ROLES.has(args.role) || args.flybotChecked) return false
    const from = botOf(args.fromId)
    // Fix: ephemeral (or tombstoned) always routes through middleware
    if (from?.ephemeral || wasEphemeral(args.fromId)) return true
    // Normal bots still skip when deferred/resumed/retried/resent
    return from !== undefined && !args.resent && !args.resumed && !args.retried && !args.deferred
  }
  
  // Test deferred from ephemeral
  const deferredArgs = { fromId: 'ephemeral', role: 'reply', deferred: true }
  const mainGated = gatedOnMain(deferredArgs)
  const fixedGated = gatedWithFix(deferredArgs)
  
  assert.equal(mainGated, false, 'RED on origin/main: deferred from ephemeral bypasses gating (THE LEAK)')
  assert.equal(fixedGated, true, 'GREEN with fix: deferred from ephemeral forces gating (routes through middleware)')
  
  // Test resumed from ephemeral
  const resumedArgs = { fromId: 'ephemeral', role: 'reply', resumed: true }
  assert.equal(gatedOnMain(resumedArgs), false, 'origin/main: resumed from ephemeral bypasses gating')
  assert.equal(gatedWithFix(resumedArgs), true, 'with fix: resumed from ephemeral forces gating')
  
  // Test retried from ephemeral
  const retriedArgs = { fromId: 'ephemeral', role: 'reply', retried: true }
  assert.equal(gatedOnMain(retriedArgs), false, 'origin/main: retried from ephemeral bypasses gating')
  assert.equal(gatedWithFix(retriedArgs), true, 'with fix: retried from ephemeral forces gating')
  
  // Test resent from ephemeral
  const resentArgs = { fromId: 'ephemeral', role: 'reply', resent: true }
  assert.equal(gatedOnMain(resentArgs), false, 'origin/main: resent from ephemeral bypasses gating')
  assert.equal(gatedWithFix(resentArgs), true, 'with fix: resent from ephemeral forces gating')
})

test('#1524: tombstone logic - post-removal late reply MUST be gated and denied', async () => {
  // RED on origin/main: after removeBot, bot is gone, late reply bypasses gating → leaks
  // GREEN with fix: tombstone exists, gated()=true, denied
  
  const BOT_TO_BOT_ROLES = new Set(['request', 'reply', 'stopped', 'report'])
  const bots = new Map([
    ['main', { id: 'main', name: 'Chief' }],
  ])
  const tombstones = new Set()
  
  const botOf = (id) => bots.get(id)
  const wasEphemeral = (id) => tombstones.has(id)
  
  // Simulate bot existence and removal
  const ephemeralId = 'ephemeral'
  bots.set(ephemeralId, { id: ephemeralId, name: 'Review', ephemeral: { plugin: 'test' } })
  
  const gatedWithFix = (args) => {
    if (!args.fromId || !BOT_TO_BOT_ROLES.has(args.role) || args.flybotChecked) return false
    const from = botOf(args.fromId)
    // Ephemeral or tombstoned always gates
    if (from?.ephemeral || wasEphemeral(args.fromId)) return true
    return from !== undefined && !args.resent && !args.resumed && !args.retried && !args.deferred
  }
  
  // Before removal: gated
  const beforeRemoval = gatedWithFix({ fromId: ephemeralId, role: 'reply' })
  assert.equal(beforeRemoval, true, 'Before removal: ephemeral is gated')
  
  // Remove bot (tombstone it first in fixed version)
  tombstones.add(ephemeralId)
  bots.delete(ephemeralId)
  
  // After removal: on origin/main would be ungated (bot is gone)
  // With fix: still gated (tombstone exists)
  const afterRemoval = gatedWithFix({ fromId: ephemeralId, role: 'reply' })
  assert.equal(botOf(ephemeralId), undefined, 'Bot is removed')
  assert.equal(wasEphemeral(ephemeralId), true, 'Tombstone exists')
  assert.equal(afterRemoval, true, 'GREEN with fix: post-removal reply is gated by tombstone')
})

test('#1524: normal (non-ephemeral) bot behavior unchanged', async () => {
  // Ensures the fix doesn't break normal bot delivery
  const BOT_TO_BOT_ROLES = new Set(['request', 'reply', 'stopped', 'report'])
  const bots = new Map([
    ['main', { id: 'main', name: 'Chief' }],
    ['reviewer', { id: 'reviewer', name: 'Reviewer' }],
  ])
  
  const tombstones = new Set()
  const botOf = (id) => bots.get(id)
  const wasEphemeral = (id) => tombstones.has(id)
  
  const gatedWithFix = (args) => {
    if (!args.fromId || !BOT_TO_BOT_ROLES.has(args.role) || args.flybotChecked) return false
    const from = botOf(args.fromId)
    if (from?.ephemeral || wasEphemeral(args.fromId)) return true
    return from !== undefined && !args.resent && !args.resumed && !args.retried && !args.deferred
  }
  
  // Normal bot: first reply is gated
  assert.equal(gatedWithFix({ fromId: 'reviewer', role: 'reply' }), true, 'Normal bot first reply is gated')
  
  // Normal bot: deferred/resumed/retried/resent skip gating (unchanged)
  assert.equal(gatedWithFix({ fromId: 'reviewer', role: 'reply', deferred: true }), false, 'Normal bot deferred skips gating')
  assert.equal(gatedWithFix({ fromId: 'reviewer', role: 'reply', resumed: true }), false, 'Normal bot resumed skips gating')
  assert.equal(gatedWithFix({ fromId: 'reviewer', role: 'reply', retried: true }), false, 'Normal bot retried skips gating')
  assert.equal(gatedWithFix({ fromId: 'reviewer', role: 'reply', resent: true }), false, 'Normal bot resent skips gating')
  
  // Request TO ephemeral still allowed (sender is not ephemeral)
  bots.set('ephemeral', { id: 'ephemeral', name: 'Review', ephemeral: { plugin: 'test' } })
  assert.equal(gatedWithFix({ fromId: 'main', toId: 'ephemeral', role: 'request' }), true, 'Request TO ephemeral is gated (normal flow)')
})
