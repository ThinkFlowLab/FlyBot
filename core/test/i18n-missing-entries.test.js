// #3002: the sibling check (core/test/i18n-plugins.test.js) only sees a string whose text already
// exists in the zh dictionary — a sentence with **no** entry at all is invisible to it, so a plugin
// can draw untranslatable English in a zh window forever while every check stays green.
//
// This is the second scan, from the other side: it reads copy a plugin keeps in a `*_COPY` /
// `*_TEXT` table, a `text:` prop, and the `h(...)` copy attributes — `COPY_ATTRS` plus `hint` (see
// `MISSING_ATTRS` in `scripts/i18n-usage.mjs`; one definition, not a second hand-copied list) —
// then compares each value with the dictionary keys. A value with no zh key cannot be translated —
// it is the gap, and the baseline pins today's gaps as `file:line:key`. Exactly two `placeholder`
// values on main name an example of the expected input (`https://social.example`,
// `github, composio`); those two literals are data, not copy, and are not reported. The skip is
// that exact set, not a pattern: any other URL- or list-shaped placeholder is still reported.
//
// Measured widening on main `3caf20dc`, on top of the 36 pins #3008 left: `title` +11,
// `aria-label` +15, `placeholder` +3, `alt` / `aria-description` / `aria-placeholder` +0. The
// union is 27 new pins, not the 29 their sum gives, because two sentences are drawn through two
// attributes at once and pin once. Two of the three `placeholder` hits are example values and are
// skipped by the rule above, so this file ships a 61-entry baseline (+25) (#3009).
//
// The baseline may only shrink: fixing a sentence adds its dictionary entry and deletes its line
// here; deleting the sentence from the code must delete its line too, or the entry is stale. The
// 33 -> 36 growth #3008 took and the growth this change takes are intake, not relaxation: every
// pin is a sentence that already existed on main untranslated, and each leaves the baseline when
// its zh entry lands — never by editing the baseline. A new untranslated draw still fails.
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

test('the scan counts copy tables and copy props, not data', () => {
  const source = [
    "const REFUSAL_COPY = { expired: 'Too late.', busy: 'Wait a moment.' }",
    "const STATE_TEXT = { connected: t => t('Connected') }",
    "const INVITE_UNSUPPORTED = 'Invites need a newer Bot Social.'",
    "setStatus({ tone: 'error', text: 'Enter a 6-digit number.' })",
    "setInvite({ status: { tone: 'error', text: INVITE_UNSUPPORTED } })",
    "h('div', { className: 'fs-status', role: status === 'done' ? 'status' : 'note' }, tr('Member'))",
    "h(QrImage, { text: qrText, kind: 'face-qr', label: 'QR code for this room', hint: 'Scan this to join' })",
    "const shape = { hint: 'A shape, not a draw', label: 'so this one is data' }",
    "const picked = row.status === 'done' ? 'done' : 'running'",
  ].join('\n')
  assert.deepEqual(missingCopy(source, 'plugins/sample/client.js').map(entry => entry.key), [
    'Too late.',
    'Wait a moment.',
    'Enter a 6-digit number.',
    'Invites need a newer Bot Social.',
    'QR code for this room',
    'Scan this to join',
  ])
})

test('the widened scan names every copy attribute and skips placeholder examples', () => {
  const source = [
    "h(Button, { title: 'Archive this room', 'aria-label': 'Archive this room' })",
    "h('input', { placeholder: 'Paste invite link or code' })",
    "h('input', { placeholder: 'https://social.example' })",
    "h('input', { placeholder: 'github, composio' })",
    "h(Picture, { alt: 'A picture of the room' })",
    "h('input', { 'aria-placeholder': 'Type a name' })",
    "h(Row, { 'aria-description': 'Explains the row' })",
  ].join('\n')
  const keys = missingCopy(source, 'plugins/sample/client.js').map(entry => entry.key)
  assert.deepEqual(keys, [
    'Archive this room',
    'Archive this room',
    'Paste invite link or code',
    'A picture of the room',
    'Type a name',
    'Explains the row',
  ])
  // Two attributes drawing one sentence are two draws, not a duplicate.
  assert.equal(keys.filter(key => key === 'Archive this room').length, 2)
  // The two example values are data, so neither is reported.
  assert.equal(keys.includes('https://social.example'), false)
  assert.equal(keys.includes('github, composio'), false)
  // Two literals, not a pattern: another URL-shaped placeholder is copy and is named.
  assert.deepEqual(
    missingCopy("h('input', { placeholder: 'https://example.org/room/42' })", 'plugins/sample/client.js').map(entry => entry.key),
    ['https://example.org/room/42'],
  )
})
