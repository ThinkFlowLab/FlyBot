// P-698: the OTLP export interval is validated as "a finite number above 0" and handed straight to
// `setInterval`, which cannot hold a delay above 2**31 - 1 ms (2147483647, about 24.8 days): Node
// rewrites the delay to 1 ms and prints `TimeoutOverflowWarning`. A user who writes 30 days to mean
// "effectively never export" therefore got the opposite — the exporter ran on every tick, and each
// run reads and maps the whole trace (a full filter over every record) on the host's event loop.
// These cases pin the ceiling at the only place it can be seen: the delay actually given to
// `setInterval`.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createTimeline } from '../src/timeline.js'
import { mockAdapter } from './mock-adapter.js'

const CEILING = 2 ** 31 - 1
const DEFAULT_EXPORT_MS = 5000
const TOO_LONG = 30 * 24 * 60 * 60 * 1000 // 2592000000ms

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// A stand-in for the export timer: it records the delay the plugin asked for and answers a handle
// with the one method the plugin calls on it. When `run` is set the real `setInterval` is used
// underneath, so the case can see whether the timer fires; otherwise nothing is scheduled and the
// recorded delay is the whole measurement.
function watchIntervals({ run = false } = {}) {
  const realSetInterval = globalThis.setInterval
  const realClearInterval = globalThis.clearInterval
  const calls = []
  let fired = 0
  globalThis.setInterval = (fn, ms, ...rest) => {
    calls.push(ms)
    const body = () => { fired += 1; fn() }
    return run ? realSetInterval(body, ms, ...rest) : { unref() {} }
  }
  globalThis.clearInterval = handle => (run ? realClearInterval(handle) : undefined)
  return {
    calls,
    fired: () => fired,
    restore() {
      globalThis.setInterval = realSetInterval
      globalThis.clearInterval = realClearInterval
    },
  }
}

// Builds one timeline over an exporter at `intervalMs` and hands it to `fn`; the timer globals are
// restored and the timeline disposed however the case ends, so a failing assertion cannot leak a
// patched `setInterval` into the next file.
async function inTimeline({ intervalMs, run = false }, fn) {
  const adapter = mockAdapter()
  const timers = watchIntervals({ run })
  let timeline
  try {
    timeline = createTimeline(adapter, { persist: false, exporter: { send: async () => {}, intervalMs } })
    return await fn({ timeline, adapter, timers })
  } finally {
    timeline?.dispose()
    timers.restore()
  }
}

test('P-698 a deadline above the timer ceiling does not run the exporter on the next tick', { timeout: 10_000 }, async () => {
  await inTimeline({ intervalMs: TOO_LONG, run: true }, async ({ timers }) => {
    await sleep(60) // 60 ticks of a 1 ms timer, and none of a 24.8-day one
    const fired = timers.fired()
    const delay = timers.calls[0]
    assert.equal(fired, 0, `the exporter ran ${fired} time(s) within 60ms of a 30-day interval, because setInterval got ${delay}ms`)
    assert.equal(
      delay,
      CEILING,
      `setInterval was given ${delay}ms for exportMs=${TOO_LONG}ms; Node shortens anything above ${CEILING}ms to 1ms, so the deadline that was asked for is not the deadline the timer holds`,
    )
  })
})

test('P-698 a value above the ceiling is clamped, and the warning names the effective interval', async () => {
  await inTimeline({ intervalMs: TOO_LONG }, ({ adapter, timers }) => {
    const delay = timers.calls[0]
    const warnings = adapter.warnings.slice()

    assert.equal(delay, CEILING, `the export timer must be clamped to ${CEILING}ms, got ${delay}ms`)
    const ceilingWarnings = warnings.filter(line => line.includes('timer ceiling'))
    assert.equal(ceilingWarnings.length, 1, `exactly one warning must name the effective interval; warnings: ${warnings.join(' | ') || '(none)'}`)
    assert.match(ceilingWarnings[0], new RegExp(`exportMs=${TOO_LONG}ms`), 'the warning names the value the user configured')
    assert.match(ceilingWarnings[0], new RegExp(`using ${CEILING}ms`), 'the warning names the interval that is in force')
  })
})

test('P-698 the ceiling itself is a valid interval and is not warned about', async () => {
  await inTimeline({ intervalMs: CEILING }, ({ adapter, timers }) => {
    const delay = timers.calls[0]
    const warnings = adapter.warnings.slice()

    assert.equal(delay, CEILING, `${CEILING}ms is a delay setInterval can hold, so it must be used as given`)
    assert.deepEqual(warnings, [], `no warning is due at the ceiling; warnings: ${warnings.join(' | ')}`)
  })
})

test('P-698 one millisecond above the ceiling is clamped and warned once', async () => {
  await inTimeline({ intervalMs: CEILING + 1 }, ({ adapter, timers }) => {
    const delay = timers.calls[0]
    const warnings = adapter.warnings.slice()

    assert.equal(delay, CEILING, `one millisecond above the ceiling must still be clamped; got ${delay}ms`)
    assert.equal(warnings.length, 1, `one warning above the ceiling; warnings: ${warnings.join(' | ') || '(none)'}`)
    assert.match(warnings[0], new RegExp(`${CEILING + 1}ms`), 'the warning names the configured value')
    assert.match(warnings[0], new RegExp(`using ${CEILING}ms`), 'the warning names the interval that is in force')
  })
})

test('P-698 values the docs already reject still fall back to five seconds', async () => {
  for (const ignored of [0, -5, '30', Number.NaN, Infinity, null, undefined]) {
    await inTimeline({ intervalMs: ignored }, ({ adapter, timers }) => {
      const delay = timers.calls[0]
      const warnings = adapter.warnings.slice()

      assert.equal(delay, DEFAULT_EXPORT_MS, `exportMs=${String(ignored)} must fall back to ${DEFAULT_EXPORT_MS}ms, got ${delay}ms`)
      assert.deepEqual(warnings, [], `exportMs=${String(ignored)} falls back silently; warnings: ${warnings.join(' | ')}`)
    })
  }
})
