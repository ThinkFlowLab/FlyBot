// #3040: a plugin drew `superseded by ${item.supersededBy}` as a template literal, so both i18n scans
// were blind to it — `bareCopy` matches only text that already has a zh entry, `missingCopy` reads a
// keyless literal, and the token walk dropped every template with a `${}` hole. Nothing was red; a
// reader found it. This is the third view of the same walk: a draw whose copy is such a template,
// reported with one `{}` per hole, so the fix has one shape — `tr('superseded by {id}', { id })`.
// The baseline is intake like the missing-entry one (#3008, #3009): it pins the 43 draws the plugins
// already have, a pin leaves when its sentence goes through `tr()`, and a new draw still fails.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { baselineOf, scanTemplateDraws, templateDraws } from '../../scripts/i18n-usage.mjs'

const keysOf = (...lines) => templateDraws(lines.join('\n'), 'plugins/sample/client.js').map(entry => entry.key)

test('a copy draw through a ${} template is reported, one {} per hole', () => {
  assert.deepEqual(keysOf(
    "h('span', { className: 'wf-hist-retry' }, `superseded by ${item.supersededBy}`)",
    "h('button', { 'aria-label': `Auto-send ${bot}'s room messages` })",
    "setStatus({ tone: 'warn', text: `Waiting for ${who} to let you in.` })",
    "const FACE_COPY = { busy: `Model ${name} is busy.` }",
  ), ['superseded by {}', "Auto-send {}'s room messages", 'Waiting for {} to let you in.', 'Model {} is busy.'])
})

test('a template drawn as data, through tr(), or as a comparison operand is not copy', () => {
  assert.deepEqual(keysOf(
    "h('div', { className: `fs-${kind}` }, 'Join')",
    "h('span', { 'data-kind': `fs-${kind}` })",
    "h('span', {}, tr(`Scanned ${digits}.`))",
    "const short = mode === `fs-${kind}` ? 'a' : 'b'",
    "h('span', {}, `${a} · ${b}`)",
  ), [])
})

// #3049: the Approve-all label is a const, so the draw is the name the button reads, not the literal.
test('a template assigned to a name is copy where the name is drawn', () => {
  assert.deepEqual(keysOf(
    "const approveAllTitle = approveRecipients.length ? `${n} 条 · to ${who}` : `${n} 条`",
    "const approveAllLabel = `Approve all (${n})`",
    "h('button', { title: approveAllTitle }, approveAllLabel)",
  ), ['{} 条 · to {}', '{} 条', 'Approve all ({})'])
  // A statement that merely carries templates — a map over rows, a class name — binds nothing.
  assert.deepEqual(keysOf(
    "const bars = items.map(item => h('g', { key: `bar-${item.id}`, className: `tl-${item.kind}` }))",
    "h('div', null, bars)",
  ), [])
})

test('the plugins on main are pinned, and a template draw nobody pinned fails', () => {
  const current = new Set(baselineOf(scanTemplateDraws()))
  const pins = JSON.parse(readFileSync(new URL('./i18n-template-draws.baseline.json', import.meta.url), 'utf8'))
  assert.equal(pins.version, 1, 'the baseline carries one version')
  const added = [...current].filter(entry => !pins.entries.includes(entry))
  const stale = pins.entries.filter(entry => !current.has(entry))
  assert.deepEqual(added, [], `template draws with no pin (draw them through tr('… {name}', { name })):\n${added.join('\n')}`)
  assert.deepEqual(stale, [], `pins no longer drawn — delete them:\n${stale.join('\n')}`)
  const script = fileURLToPath(new URL('../../scripts/i18n-usage.mjs', import.meta.url))
  const out = spawnSync(process.execPath, [script, '--template-draws'], { encoding: 'utf8' })
  assert.equal(out.status, 0, out.stderr)
  assert.equal(Number.parseInt(out.stdout.trimEnd().split('\n').at(-1), 10), current.size, 'the summary line counts the pins')
})

// Acceptance: the list names the Approve-all row on main, and its identity is the skeleton the reader
// sees, never the line a comment above it happens to move.
test('the Approve-all template on main is a member, and 12 comment lines leave the set identical', () => {
  const file = fileURLToPath(new URL('../../plugins/social/client.js', import.meta.url))
  const source = readFileSync(file, 'utf8')
  const member = scanTemplateDraws().filter(entry => entry.file === 'plugins/social/client.js' && entry.key === '{} 条 · to {}')
  assert.equal(member.length, 1, 'the Approve-all row names its two holes')
  const shifted = `${'// a comment above the draw\n'.repeat(12)}${source}`
  const keys = entries => entries.map(entry => `${entry.file}\u0000${entry.key}`).sort()
  const before = templateDraws(source, 'plugins/social/client.js')
  const after = templateDraws(shifted, 'plugins/social/client.js')
  assert.deepEqual(keys(after), keys(before), 'the member set is the skeleton, not the line')
  assert.equal(after[0].line, before[0].line + 12, 'the shift really moved the draws')
})

// The two keyed scans stay as wide as they were, and say how much they could not judge.
test('--missing and --check each end by counting the template draws they leave out', () => {
  const script = fileURLToPath(new URL('../../scripts/i18n-usage.mjs', import.meta.url))
  const run = args => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' })
  const draws = baselineOf(scanTemplateDraws()).length
  for (const flag of ['--missing', '--check']) {
    const out = run([flag])
    assert.equal(out.status, 0, out.stderr)
    assert.equal(out.stdout.trimEnd().split('\n').at(-1), `${draws} interpolated template draws are out of scope (--template-draws)`, flag)
  }
})
