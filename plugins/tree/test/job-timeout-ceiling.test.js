// #2811: the deadline one reorganization job may wait on the host is validated as "a finite number
// above 0", but Node's `setTimeout` cannot hold a delay above 2**31 - 1 ms (2147483647, about 24.8
// days): it silently rewrites the delay to 1 ms and prints `TimeoutOverflowWarning`. A user who
// writes 30 days to mean "effectively no deadline" therefore got the deadline on the next tick —
// every queued job reported abandoned on a healthy host, while the host call kept running and
// writing. These cases pin the ceiling: a healthy job must resolve, and the reported deadline must
// be the one the timer really uses.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createOrganizer } from '../src/organize.js'

const CEILING = 2 ** 31 - 1
const DEFAULT_JOB_TIMEOUT_MS = 10 * 60 * 1000
const TOO_LONG = 30 * 24 * 60 * 60 * 1000 // 2592000000ms

// The queue needs nothing from the tree itself: no job below reads a Bot or a snapshot, so the
// organizer is built with the smallest host that satisfies its constructor.
function organizerAt({ jobTimeoutMs } = {}) {
  const warnings = []
  const fields = new Map()
  const fb = {
    getField: (id, key) => fields.get(`${id}:${key}`),
    setField: (id, key, value) => { if (value == null) fields.delete(`${id}:${key}`); else fields.set(`${id}:${key}`, value) },
    getBot: id => ({ id, name: id }),
    listBots: () => [],
    setSystemPrompt: () => {},
    createBot: () => new Promise(() => {}),
    updateBot: async () => {},
    memoryRead: () => [],
    memoryAppend: async () => ({ ok: true }),
    isRemote: () => false,
    hasAnyGrant: () => false,
  }
  const organizer = createOrganizer({
    fb,
    limits: { maxChildren: 8, maxDepth: 4 },
    snapshot: () => ({}),
    childrenOf: () => [],
    depthOf: () => 0,
    warn: (...args) => warnings.push(args.map(String).join(' ')),
    refreshAll: () => {},
    writeBlock: () => {},
    findRootId: () => 'root',
    now: () => 1_700_000_000_000,
    classify: () => ({}),
    jobTimeoutMs,
  })
  return { organizer, warnings }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// Node reports the overflow as a process warning rather than an error, so a case that only reads
// the queue's own warning would miss the 1 ms timer behind it.
async function captureOverflowWarnings(run) {
  const overflow = []
  const onWarning = warning => { if (warning.name === 'TimeoutOverflowWarning') overflow.push(warning.message) }
  process.on('warning', onWarning)
  try {
    const value = await run()
    await sleep(0) // a warning is emitted on a later tick
    return { value, overflow }
  } finally {
    process.off('warning', onWarning)
  }
}

test('#2811 a deadline above the timer ceiling does not abandon a healthy job', { timeout: 10_000 }, async () => {
  const { organizer, warnings } = organizerAt({ jobTimeoutMs: TOO_LONG })
  const started = process.hrtime.bigint()
  let value, failure
  try {
    ;({ value } = await captureOverflowWarnings(() => organizer.shared.exclusive(async () => {
      await sleep(50)
      return 'host answered'
    })))
  } catch (error) {
    failure = error
  }
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6
  const warned = warnings.join('\n')

  assert.equal(
    failure,
    undefined,
    `the host answered in 50ms, but the job ${failure ? `was given up on after ${elapsedMs.toFixed(1)}ms: ${failure.message}` : ''}` +
      `; warnings: ${warned || '(none)'}`,
  )
  assert.equal(value, 'host answered')
  assert.ok(elapsedMs >= 40, `the job resolved after ${elapsedMs.toFixed(1)}ms, so its deadline fired almost at once`)
  assert.doesNotMatch(warned, /abandoned/, `a job the host answered must not be warned about as abandoned; warnings: ${warned}`)
})

test('#2811 a value above the ceiling is clamped, and the give-up names the deadline the timer uses', { timeout: 10_000 }, async () => {
  const { organizer, warnings } = organizerAt({ jobTimeoutMs: TOO_LONG })
  const atConstruction = warnings.slice()

  // A host that never answers: timers are capped so the case does not wait 24.8 days, but the
  // number in the give-up must still be the one the configured deadline really is.
  const realSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = (fn, ms, ...rest) => realSetTimeout(fn, Math.min(ms, 250), ...rest)
  let failure
  try {
    await organizer.shared.exclusive(async () => new Promise(() => {}))
  } catch (error) {
    failure = error
  } finally {
    globalThis.setTimeout = realSetTimeout
  }

  assert.equal(failure?.abandoned, true, `a host call that never answers must still be abandoned; got ${failure?.message ?? 'a resolved job'}`)
  assert.match(
    failure.message,
    new RegExp(`abandoned after ${CEILING}ms`),
    `the give-up must name the clamped deadline the timer uses, not the value it could not hold: ${failure.message}`,
  )
  const ceilingWarnings = atConstruction.filter(line => line.includes(String(CEILING)))
  assert.equal(ceilingWarnings.length, 1, `exactly one warning must name the effective deadline; warnings: ${atConstruction.join(' | ') || '(none)'}`)
  assert.match(ceilingWarnings[0], new RegExp(`jobTimeoutMs=${TOO_LONG}ms`), 'the warning also names the value the user configured')
})

test('#2811 the ceiling itself is a valid deadline, and one millisecond more is clamped', async () => {
  const atCeiling = organizerAt({ jobTimeoutMs: CEILING })
  assert.deepEqual(atCeiling.warnings, [], '2147483647ms is a deadline setTimeout can hold, so it needs no warning')

  const above = organizerAt({ jobTimeoutMs: CEILING + 1 })
  assert.equal(above.warnings.length, 1, `one warning above the ceiling; warnings: ${above.warnings.join(' | ') || '(none)'}`)
  assert.match(above.warnings[0], new RegExp(`${CEILING + 1}ms`))
  assert.match(above.warnings[0], new RegExp(`using ${CEILING}ms`))
})

test('#2811 values the docs already reject still fall back to ten minutes', async () => {
  for (const ignored of [0, -5, '30', Number.NaN, Infinity, null, undefined]) {
    const { warnings } = organizerAt({ jobTimeoutMs: ignored })
    assert.deepEqual(
      warnings,
      [],
      `jobTimeoutMs=${String(ignored)} falls back silently to the ten-minute default; warnings: ${warnings.join(' | ')}`,
    )
  }
  // The fallback is the default deadline, not the ceiling: a hanging job reports 600000ms.
  const { organizer, warnings } = organizerAt({ jobTimeoutMs: Infinity })
  const realSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = (fn, ms, ...rest) => realSetTimeout(fn, Math.min(ms, 50), ...rest)
  let failure
  try {
    await organizer.shared.exclusive(async () => new Promise(() => {}))
  } catch (error) {
    failure = error
  } finally {
    globalThis.setTimeout = realSetTimeout
  }
  assert.match(failure?.message ?? '', new RegExp(`abandoned after ${DEFAULT_JOB_TIMEOUT_MS}ms`), `warnings: ${warnings.join(' | ')}`)
})
