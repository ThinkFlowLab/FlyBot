// #2998: core/test/i18n.test.js only checks the forward direction — every `t('…')` in
// core/src/client has a zh entry. It never looks at plugins/*/client.js, so a string that
// already has a zh entry could be drawn bare in a plugin forever while CI stayed green; that is
// how four friend-card labels kept reading English in a zh window (#2994).
//
// This scans the plugin clients for a dictionary key drawn as a bare string in a **render
// position** (an h() child, or a copy attribute such as title / aria-label / placeholder), and
// for `const NAME = '…'` used bare in one of those positions. Data is not copy and is never
// counted: comparisons (`run.status === 'done'`), object keys, state ids, selectors and URLs are
// excluded, and `tr()`/`t()`/`hostText()` arguments are already translated.
//
// The baseline pins today's remaining draws; it may only shrink. A new bare draw must go through
// tr(), and a fixed one must delete its baseline entry in the same change.
//
// #3003: an entry is keyed by **where the copy lives**, not by the line it happens to sit on —
// `file:key`, and `#n` when one file draws the same key more than once (so the two
// "Waiting for approval" draws stay two entries). Inserting a comment in a plugin client changes
// no entry; the line is printed in the failure text as a hint and never stored. `--write` refuses
// to grow the set unless `--force` is passed, because regenerating a larger baseline is exactly
// how a genuinely new bare draw would be laundered.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { bareCopy, drawBaselineOf, drawEntries, scanPlugins, writeBaseline } from '../../scripts/i18n-usage.mjs'

const baselineFile = new URL('./i18n-plugins.baseline.json', import.meta.url)

test('a plugin string with a Chinese entry is drawn through tr()', () => {
  const current = drawEntries(scanPlugins())
  const known = new Set(current.map(entry => entry.id))
  let baseline
  try {
    baseline = JSON.parse(readFileSync(baselineFile, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') {
      assert.fail(`core/test/i18n-plugins.baseline.json is missing; today's bare draws are:\n${[...known].join('\n')}`)
    }
    throw error
  }
  assert.equal(baseline.version, 1, 'the baseline carries one version')
  const pinned = new Set(baseline.entries)
  const added = current.filter(entry => !pinned.has(entry.id))
  const stale = [...pinned].filter(entry => !known.has(entry))
  const problems = [
    ...added.map(entry => `bare draw ${entry.id} (${entry.file}:${entry.line}) — pass it through tr()`),
    ...stale.map(entry => `baseline entry ${entry} is no longer drawn bare — delete that line`),
  ]
  assert.deepEqual(problems, [], problems.join('\n'))
})

test('the scan counts render positions, not data', () => {
  const source = [
    "const TITLE = 'Your Bots'",
    "h('div', { title: TITLE, 'aria-label': 'Copy link' }, 'Accept', status === 'done' ? 'Retry' : 'Cancel', tr('Member'))",
    "const status = row.status === 'done' ? 'done' : 'running'",
  ].join('\n')
  assert.deepEqual(bareCopy(source, 'plugins/sample/client.js').map(entry => entry.key), [
    'Your Bots', 'Copy link', 'Accept', 'Retry', 'Cancel',
  ])
})

test('a line shift in a plugin client moves no baseline entry', () => {
  const source = ["h('div', null, 'Accept')", "h('div', null, 'Retry')"].join('\n')
  const shifted = ['// one new comment', '', source].join('\n')
  assert.equal(bareCopy(shifted, 'plugins/sample/client.js')[0].line, 3)
  assert.deepEqual(drawBaselineOf(bareCopy(shifted, 'plugins/sample/client.js')), [
    'plugins/sample/client.js:Accept',
    'plugins/sample/client.js:Retry',
  ])
  assert.deepEqual(drawBaselineOf(bareCopy(shifted, 'plugins/sample/client.js')), drawBaselineOf(bareCopy(source, 'plugins/sample/client.js')))
})

test('one file drawing the same key twice keeps two ordered entries', () => {
  const source = ["h('div', null, 'Waiting for approval')", "h('div', null, 'Waiting for approval')"].join('\n')
  assert.deepEqual(drawBaselineOf(bareCopy(source, 'plugins/sample/client.js')), [
    'plugins/sample/client.js:Waiting for approval#1',
    'plugins/sample/client.js:Waiting for approval#2',
  ])
})

test('--write refuses to grow the baseline unless forced, and still allows a shrink', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flybot-i18n-baseline-'))
  try {
    const target = join(dir, 'baseline.json')
    const seed = bareCopy("h('div', null, 'Accept')", 'plugins/sample/client.js')
    const grown = bareCopy("h('div', null, 'Accept')\nh('div', null, 'Retry')", 'plugins/sample/client.js')
    writeFileSync(target, `${JSON.stringify({ version: 1, entries: drawBaselineOf(seed) }, null, 2)}\n`)

    const refused = writeBaseline(target, grown)
    assert.equal(refused.written, false)
    assert.deepEqual(refused.added, ['plugins/sample/client.js:Retry'])
    assert.deepEqual(JSON.parse(readFileSync(target, 'utf8')).entries, ['plugins/sample/client.js:Accept'], 'a refused write leaves the file alone')

    const forced = writeBaseline(target, grown, { force: true })
    assert.equal(forced.written, true)
    assert.deepEqual(JSON.parse(readFileSync(target, 'utf8')).entries, ['plugins/sample/client.js:Accept', 'plugins/sample/client.js:Retry'])

    const shrunk = writeBaseline(target, seed)
    assert.equal(shrunk.written, true)
    assert.deepEqual(shrunk.removed, ['plugins/sample/client.js:Retry'])

    const fresh = writeBaseline(join(dir, 'fresh.json'), grown)
    assert.equal(fresh.written, true, 'a missing baseline is created, not refused')

    const twins = bareCopy(["h('div', null, 'Approve')", "h('div', null, 'Approve')"].join('\n'), 'plugins/sample/client.js')
    const survivor = bareCopy("h('div', null, 'Approve')", 'plugins/sample/client.js')
    writeFileSync(target, `${JSON.stringify({ version: 1, entries: drawBaselineOf(twins) }, null, 2)}\n`)
    const renamed = writeBaseline(target, survivor)
    assert.equal(renamed.written, true, 'fixing one of two identical draws shrinks the set, so the survivor may renumber')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
