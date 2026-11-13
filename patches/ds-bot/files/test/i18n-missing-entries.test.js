// #3002: the sibling check (core/test/i18n-plugins.test.js) only sees a string whose text already
// exists in the zh dictionary — a sentence with **no** entry at all is invisible to it, so a plugin
// can draw untranslatable English in a zh window forever while every check stays green.
//
// This is the second scan, from the other side: it reads copy a plugin keeps in a `*_COPY` /
// `*_TEXT` table, a `text:` prop, and the `h(...)` copy attributes — `COPY_ATTRS` plus `hint` (see
// `MISSING_ATTRS` in `scripts/i18n-usage.mjs`; one definition, not a second hand-copied list) —
// then compares each value with the dictionary keys. A value with no zh key cannot be translated —
// it is the gap, and the baseline pins today's gaps by where the copy lives, `file:key`. Exactly two `placeholder`
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
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
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

// The same sentence drawn twice at one position — title: and aria-label: on one line — is one pin.
// The tail line is what a reader compares with the baseline file, so it must report that identity,
// the same number `--missing --json` prints and `--write` pins, not the raw draw array. On main the
// raw count reads 63 while the JSON and the file hold 61 (#3017).
test('--missing prints the identity count, not the raw draw count', () => {
  const script = fileURLToPath(new URL('../../scripts/i18n-usage.mjs', import.meta.url))
  const run = (...args) => {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout
  }
  const counted = JSON.parse(run('--missing', '--json')).entries.length
  const tail = run('--missing').trimEnd().split('\n').at(-1)
  assert.equal(Number.parseInt(tail, 10), counted, `the summary line must report what --json holds: ${tail}`)
  // Two draws, one pin: that is why the raw array and the identity disagree on main.
  const draws = missingCopy("h(Button, { title: 'A new untranslated line.', 'aria-label': 'A new untranslated line.' })", 'plugins/sample/client.js')
  assert.equal(draws.length, 2)
  assert.equal(baselineOf(draws).length, 1)
})

// The baseline is keyed by where the copy lives, not by the line it happens to sit on: an edit above
// a draw moves every line below it, and a rebase that only moved lines must not rewrite the pins
// (#3018 and #3020 each re-took a whole 19-line line-number delta). The walk still prints the line
// as a hint; the stored key does not carry it.
test('a line shift does not move a baseline pin', () => {
  const entries = scanMissing()
  const shifted = entries.map(entry => ({ ...entry, line: entry.line + 1 }))
  assert.deepEqual(baselineOf(shifted), baselineOf(entries))
})

// #3003's shape, on the missing side: one file drawing the same sentence at two positions keeps
// two pins, numbered `#1`/`#2`; the two draws at one position are still one pin. That keeps a second
// position from disappearing into the first, and keeps a new duplicate a growth `--write` refuses.
test('one sentence at two positions in a file is two numbered pins', () => {
  const source = [
    "h(Button, { title: 'One more untranslated.', 'aria-label': 'One more untranslated.' })",
    "h(Button, { title: 'One more untranslated.' })",
  ].join('\n')
  const draws = missingCopy(source, 'plugins/sample/client.js')
  assert.equal(draws.length, 3)
  assert.deepEqual(baselineOf(draws), [
    'plugins/sample/client.js:One more untranslated.#1',
    'plugins/sample/client.js:One more untranslated.#2',
  ])
})

// #3028: an `h()` child node is copy. The attribute half of the scan pins `title: 'Decline'`, but
// the visible text of `h('button', { class: … }, 'Decline')` was invisible to `missingCopy` — it
// accepted a table value, a copy prop and `text:` only — so a bare child string had no pin and no
// dictionary entry could ever make CI notice it. The child node now reuses `renderChild`, the one
// definition `bareCopy` already uses, so the two views of "a draw" cannot drift again.
test('an h() child node is a draw, not just its attributes', () => {
  const source = "h('div', null, 'Brand new sentence')"
  assert.equal(missingCopy(source, 'plugins/sample/client.js').length, 1)
  assert.deepEqual(baselineOf(missingCopy(source, 'plugins/sample/client.js')), [
    'plugins/sample/client.js:Brand new sentence',
  ])
})

// A glyph, a bare digit and a ` · ` separator are shapes, not sentences: copy a reader translates
// carries a letter. Accepting child nodes without this rule would pin 23 of them across the four
// plugin clients (#3028), and a new `▾` would keep growing the baseline.
test('glyphs, bare digits and separators drawn as children are not pins', () => {
  const source = [
    "h('span', null, '×')",
    "h('span', null, '…')",
    "h('span', null, '1')",
    "h('span', null, ' · ')",
  ].join('\n')
  assert.deepEqual(missingCopy(source, 'plugins/sample/client.js'), [])
})

// The same sentence drawn through an attribute and as a child is two positions in one file, so it
// keeps two pins in #3026's shape: the attribute `#1`, the child `#2`.
test('a sentence drawn as an attribute and as a child keeps two pins', () => {
  const source = [
    "h(Button, { title: 'Decline' })",
    "h(Button, null, 'Decline')",
  ].join('\n')
  assert.deepEqual(baselineOf(missingCopy(source, 'plugins/sample/client.js')), [
    'plugins/sample/client.js:Decline#1',
    'plugins/sample/client.js:Decline#2',
  ])
})

// The widening may only add. Every pin the baseline held before is still a sentence it holds, and
// the only existing pins that change spelling are the two sentences a new position renumbers
// `#1`: everything else in the 61 stays byte-identical, and no glyph can enter the file.
test('the widening only adds pins and never admits a glyph', () => {
  const current = new Set(baselineOf(scanMissing()))
  for (const entry of [
    'plugins/timeline/client.js:Timeline#1',
    'plugins/timeline/client.js:Timeline#2',
    'plugins/timeline/client.js:Timeline#3',
    'plugins/tree/client.js:Tree reorganized#1',
    'plugins/tree/client.js:Tree reorganized#2',
  ]) assert.ok(current.has(entry), `${entry} is pinned`)
  for (const pin of current) assert.match(pin, /\p{L}/u, `${pin} names a sentence, not a glyph`)
})
