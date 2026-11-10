// #2758: `jobTimeoutMs` is a plugin config key — the deadline one reorganization job may wait on
// the host before the queue gives up on it (#2751). The bound itself lives in src/organize.js; what
// this file pins is the wire from `apply(ctx, { jobTimeoutMs })` down to it, because the value is
// silent when it is dropped: the only difference is 30ms against the ten-minute default.
//
// `create_team` is the queueing path a caller actually uses: it runs its work through the
// organizer's `exclusive()` queue, and the lead it creates is the host call that hangs here. The
// deadline the queue reports is the configured value, so the warning text tells the two apart. A
// dropped value would leave the suite waiting ten minutes, so every timer below is capped.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as plugin from '../index.js'
import { createMockFlybot } from './mock-flybot.js'

const DEFAULT_JOB_TIMEOUT_MS = 10 * 60 * 1000

// A host that never answers, a caller that queues a team, and the warnings the plugin logged.
// Timers are capped at 250ms for the duration of the call: the ten-minute default then fires
// inside the test instead of parking the suite, and its warning still names 600000ms.
async function hangTeamCreate(config) {
  const m = createMockFlybot()
  m.addBot({ name: 'Chief', isMain: true, systemPrompt: 'Chief own prompt' })
  const warnings = []
  // The adapter keeps the API object `flybot.scope('flybot-tree')` hands it at apply time, so the
  // hanging host call is injected into that scope before the plugin is built.
  let hostCalls = 0
  const scope = m.flybot.scope.bind(m.flybot)
  m.flybot.scope = name => {
    const api = scope(name)
    if (name === 'flybot-tree') api.bot = { ...api.bot, create: () => { hostCalls++; return new Promise(() => {}) } }
    return api
  }
  const { tree } = plugin.apply(
    { flybot: m.flybot, logger: { warn: (...args) => warnings.push(args.map(String).join(' ')) } },
    { adoptExisting: false, ...config },
  )
  const root = await tree.ensureRoot()

  const realSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = (fn, ms, ...rest) => realSetTimeout(fn, Math.min(ms, 250), ...rest)
  let result
  try {
    result = await m.call(root, 'create_team', { team: 'FlyBot', members: ['Dev: writes the FlyBot code', 'Test: runs the FlyBot tests'] })
  } finally {
    globalThis.setTimeout = realSetTimeout
  }
  return { hostCalls, warnings, result, tree, m }
}

test('#2758 jobTimeoutMs from the plugin config bounds a queued create_team job', { timeout: 20_000 }, async () => {
  const { hostCalls, warnings, result } = await hangTeamCreate({ jobTimeoutMs: 30 })

  assert.equal(hostCalls, 1, 'create_team reached the host to create "FlyBot Lead"')

  const warned = warnings.join('\n')
  assert.match(
    warned,
    /abandoned after 30ms/,
    `jobTimeoutMs in the plugin config was ignored; warnings: ${warned || '(none)'}`,
  )
  assert.match(String(result?.error ?? ''), /abandoned after 30ms/, 'the give-up reaches the tool result')
})

test('#2758 jobTimeoutMs only accepts a finite positive number; anything else falls back to ten minutes', { timeout: 30_000 }, async () => {
  for (const ignored of [0, -5, '30', Number.NaN, Infinity, null]) {
    const { hostCalls, warnings } = await hangTeamCreate({ jobTimeoutMs: ignored })
    assert.equal(hostCalls, 1, `the team path still ran with jobTimeoutMs=${String(ignored)}`)
    const warned = warnings.join('\n')
    assert.match(
      warned,
      new RegExp(`abandoned after ${DEFAULT_JOB_TIMEOUT_MS}ms`),
      `jobTimeoutMs=${String(ignored)} must fall back to the default deadline; warnings: ${warned || '(none)'}`,
    )
  }
})
