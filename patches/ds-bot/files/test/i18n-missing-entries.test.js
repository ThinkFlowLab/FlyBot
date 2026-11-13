// #3002: the sibling check (core/test/i18n-plugins.test.js) only sees a string whose text already
// exists in the zh dictionary — a sentence with **no** entry at all is invisible to it, so a plugin
// can draw untranslatable English in a zh window forever while every check stays green.
//
// This is the second scan, from the other side: it reads copy a plugin keeps in a `*_COPY` /
// `*_TEXT` table and a `text:` property it draws (a status line handed to the renderer, or an
// `h(...)` prop), then compares each value with the dictionary keys. A value with no zh key cannot
// be translated — it is the gap, and the baseline pins today's gaps as `file:line:key`.
//
// The baseline may only shrink: fixing a sentence adds its dictionary entry and deletes its line
// here; deleting the sentence from the code must delete its line too, or the entry is stale.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { baselineOf, missingCopy, scanMissing } from '../../scripts/i18n-usage.mjs'

const baselineFile = new URL('./i18n-missing-entries.baseline.json', import.meta.url)

test('a plugin string drawn as copy has a Chinese dictionary entry', () => {
  const current = baselineOf(scanMissing())
  const known = new Set(current)
  let baseline
  try {
    baseline = JSON.parse(readFileSync(baselineFile, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') {
      assert.fail(`core/test/i18n-missing-entries.baseline.json is missing; copy with no zh entry:\n${current.join('\n')}`)
    }
    throw error
  }
  assert.equal(baseline.version, 1, 'the baseline carries one version')
  const pinned = new Set(baseline.entries)
  const added = [...known].filter(entry => !pinned.has(entry))
  const stale = [...pinned].filter(entry => !known.has(entry))
  const problems = [
    ...added.map(entry => `drawn copy ${entry} has no zh dictionary entry — add one, or pin it in the baseline`),
    ...stale.map(entry => `baseline entry ${entry} is no longer drawn — delete that line`),
  ]
  assert.deepEqual(problems, [], problems.join('\n'))
})

test('the scan counts copy tables and text props, not data', () => {
  const source = [
    "const REFUSAL_COPY = { expired: 'Too late.', busy: 'Wait a moment.' }",
    "const STATE_TEXT = { connected: t => t('Connected') }",
    "const INVITE_UNSUPPORTED = 'Invites need a newer Bot Social.'",
    "setStatus({ tone: 'error', text: 'Enter a 6-digit number.' })",
    "setInvite({ status: { tone: 'error', text: INVITE_UNSUPPORTED } })",
    "h('div', { className: 'fs-status', role: status === 'done' ? 'status' : 'note' }, tr('Member'))",
    "const picked = row.status === 'done' ? 'done' : 'running'",
  ].join('\n')
  assert.deepEqual(missingCopy(source, 'plugins/sample/client.js').map(entry => entry.key), [
    'Too late.',
    'Wait a moment.',
    'Enter a 6-digit number.',
    'Invites need a newer Bot Social.',
  ])
})
