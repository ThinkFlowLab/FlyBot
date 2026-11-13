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
// The baseline pins today's remaining draws as `file:line:key`; it may only shrink. A new bare
// draw must go through tr(), and a fixed one must delete its baseline line in the same change.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { bareCopy, baselineOf, scanPlugins } from '../../scripts/i18n-usage.mjs'

const baselineFile = new URL('./i18n-plugins.baseline.json', import.meta.url)

test('a plugin string with a Chinese entry is drawn through tr()', () => {
  const current = baselineOf(scanPlugins())
  const known = new Set(current)
  let baseline
  try {
    baseline = JSON.parse(readFileSync(baselineFile, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') {
      assert.fail(`core/test/i18n-plugins.baseline.json is missing; today's bare draws are:\n${current.join('\n')}`)
    }
    throw error
  }
  assert.equal(baseline.version, 1, 'the baseline carries one version')
  const pinned = new Set(baseline.entries)
  const added = [...known].filter(entry => !pinned.has(entry))
  const stale = [...pinned].filter(entry => !known.has(entry))
  const problems = [
    ...added.map(entry => `bare draw ${entry} — pass it through tr()`),
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
