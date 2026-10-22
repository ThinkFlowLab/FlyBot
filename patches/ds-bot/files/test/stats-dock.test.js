import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// The shell's run-stats footer keeps its own component; FlyBot only hands it a `t` with
// "1 turn" / "1 step" (#419).
const { outputFiles } = await build({
  stdin: {
    contents: "export * from './src/client/stats-dock.js'",
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react'],
})
const h = (type, props, ...children) => ({ type, props: { ...props, children } })
const react = { createElement: h, useMemo: make => make() }
const module = { exports: {} }
runInNewContext(outputFiles[0].text, { module, exports: module.exports, require: () => react })
const { STATS_DOCK, STATS_ID, STATS_IDS, pluralStats, statsDock, statsDocks } = module.exports

const ENGLISH = { 'stats.counts': '{turns} turns {steps} steps', 'stats.cacheHit': 'Cache hit {percent}%' }
const CHINESE = { 'stats.counts': '{turns} 轮 {steps} 步' }
const seat = dict => (key, params) => (dict[key] ?? key).replace(/\{(\w+)\}/g, (match, name) => (params && name in params ? String(params[name]) : match))

test('the English run counts say "1 turn" and "1 step"', () => {
  const t = pluralStats(seat(ENGLISH))
  assert.equal(t('stats.counts', { turns: 1, steps: 1 }), '1 turn 1 step')
  assert.equal(t('stats.counts', { turns: 1, steps: 3 }), '1 turn 3 steps')
  assert.equal(t('stats.counts', { turns: 9, steps: 9 }), '9 turns 9 steps')
  assert.equal(t('stats.counts', { turns: 0, steps: 0 }), '0 turns 0 steps')
})

test('other keys and translated copy pass through unchanged', () => {
  assert.equal(pluralStats(seat(ENGLISH))('stats.cacheHit', { percent: 1 }), 'Cache hit 1%')
  assert.equal(pluralStats(seat(CHINESE))('stats.counts', { turns: 1, steps: 1 }), '1 轮 1 步')
  assert.equal(pluralStats(seat({ 'stats.counts': 'Turns {turns} · Steps {steps}' }))('stats.counts', { turns: 1, steps: 1 }), 'Turns 1 · Steps 1')
})

test('the footer is the shell\'s own entry, drawn with the plural t and the shell\'s inject', () => {
  const Shell = () => null
  const performanceUsage = { subscribe: () => () => {}, getSnapshot: () => 'full' }
  const shellEntry = { component: Shell, options: { id: STATS_ID, order: 0 }, inject: () => ({ hooks: { performanceUsage } }), locale: 'chat' }
  const ledger = []
  const dock = statsDock(name => (name === STATS_DOCK ? ledger : []))
  ledger.push({ component: dock.component, options: { id: STATS_ID, order: 0, priority: -10 }, inject: dock.inject })
  // Before the shell registers its footer, nothing is drawn.
  assert.equal(dock.component({ t: seat(ENGLISH), usePerformanceUsage: () => 'full' }), null)
  assert.equal(Object.keys(dock.inject()).length, 0)
  ledger.push(shellEntry)
  assert.equal(dock.inject().hooks.performanceUsage, performanceUsage)
  const useChat = () => {}
  const drawn = dock.component({ t: seat(ENGLISH), usePerformanceUsage: () => 'full', useChat })
  assert.equal(drawn.type, Shell)
  assert.equal(drawn.props.useChat, useChat)
  assert.equal(drawn.props.t('stats.counts', { turns: 1, steps: 2 }), '1 turn 2 steps')
  // Without the shell's hooks the footer is left out rather than crashing.
  assert.equal(dock.component({ t: seat(ENGLISH) }), null)
})

// 0.2.1-alpha.1 moved the counts from the "stats" footer into an "activity" pill; a wrapper
// for the id the shell does not publish draws nothing, so one registration list covers both.
test('the counts pill is wrapped under every id a shell has used for it', () => {
  const Shell = () => null
  const ledger = [{ component: Shell, options: { id: 'activity', order: 0 }, inject: () => ({ hooks: {} }) }]
  const entriesOf = name => (name === STATS_DOCK ? ledger : [])
  const wrappers = statsDocks(entriesOf)
  assert.deepEqual(wrappers.map(w => w.id), STATS_IDS)
  const activity = wrappers.find(w => w.id === 'activity')
  assert.equal(activity.component({ t: seat(ENGLISH), usePerformanceUsage: () => 'full' }).type, Shell)
  // The "stats" wrapper finds no shell entry on that shell and draws nothing.
  assert.equal(wrappers.find(w => w.id === STATS_ID).component({ t: seat(ENGLISH), usePerformanceUsage: () => 'full' }), null)
})

test('the client registers the footer over the shell\'s run-stats dock entries', () => {
  const index = readFileSync(new URL('../src/client/index.js', import.meta.url), 'utf8')
  assert.match(index, /const runStats = statsDocks\(/)
  assert.match(index, /\.\.\.runStats\.map\(entry => shadow\(STATS_DOCK, \{ id: entry\.id, order: 0, priority: -10, locale: 'chat', inject: entry\.inject \}, entry\.component\)\)/)
})

// The rewrite matches the shell's exact English template and dock id; flag it if DSH changes them.
test('the harness still writes "{turns} turns {steps} steps" in a dock entry FlyBot wraps', (t) => {
  const harness = process.env.DSH_HARNESS
  let file
  try {
    file = createRequire(join(harness ?? '.', 'package.json')).resolve('@deepseek-ai/dsh-client-ui-chat/package.json')
  } catch {
    return t.skip('no @deepseek-ai/dsh-client-ui-chat in the harness')
  }
  const client = join(file, '..', 'lib', 'client.js')
  if (!existsSync(client)) return t.skip('no built dsh-client-ui-chat client')
  const text = readFileSync(client, 'utf8')
  assert.match(text, /"stats\.counts": "\{turns\} turns \{steps\} steps"/)
  const ids = [...text.matchAll(/name: "conversation\.composer\.dock",\s*id: "([^"]+)"/g)].map(m => m[1])
  assert.ok(ids.some(id => STATS_IDS.includes(id)), `the shell draws the run counts in a dock id FlyBot does not wrap: ${ids.join(', ')}; wrapped: ${STATS_IDS.join(', ')}`)
})
