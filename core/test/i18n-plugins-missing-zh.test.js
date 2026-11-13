// #3022: the forward i18n check stopped at `core/src/client/`. `core/test/i18n.test.js` reads that
// directory and nothing else, so a `tr('…')` in a plugin whose text has no `DICTIONARY.zh` entry
// fell back to the English key and no check noticed: in a zh window the workflow board drew
// English on 94 of its 169 draws (66 distinct keys), and one social string (`New group`) sat in
// the same gap.
//
// This is the forward scan over `plugins/*/client.js`: every `tr('…')` / `t('…')` literal draw is
// compared with the dictionary, and a draw with no zh entry fails unless it is pinned in
// `i18n-plugins-missing-zh.baseline.json`. The sibling scans cover the other two directions —
// `core/test/i18n.test.js` the same direction inside core, `core/test/i18n-plugins.test.js` a
// translated key still drawn bare — so the three close core and plugins together.
//
// A pin is `file:key`, the shape #3003 set, one per untranslatable sentence. A file drawing one
// key twice pins once — 94 + 1 draws over 66 + 1 keys are 67 pins, not 95 — because the second
// draw of the same sentence is the same gap, not a second one; that is why no `#n` suffix appears
// in this baseline. The line number stays a hint in the failure text and is never stored, so
// inserting a comment above a draw moves no pin. The baseline may only shrink: fixing a sentence
// adds its zh entry and deletes the pin (the 12 always-visible workflow chrome strings are P-784,
// on the bundle lane), and a draw deleted from the code deletes its pin in the same change.
// `--write` refuses to grow the set unless `--force` is passed, because a larger baseline is
// exactly what laundering a brand-new untranslated draw looks like (#3003).
//
// `node core/test/i18n-plugins-missing-zh.test.js --write [--force]` regenerates the baseline.
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { DICTIONARY } from '../src/client/i18n.js'

const baselineFile = new URL('./i18n-plugins-missing-zh.baseline.json', import.meta.url)

// `tr('…')` or `t('…')` with a single-quoted or double-quoted literal argument. A template literal
// with substitutions is not a dictionary key and is not matched; `hostText()` is the host's own
// reverse lookup and is not a plugin draw.
const DRAW = /\b(?:tr|t)\(\s*(['"])((?:\\.|(?!\1).)*)\1/g

// A draw inside a comment line is prose, not a draw. Replacing those lines with empty ones keeps
// every line number intact, so a failure still points at the source it names.
function withoutCommentLines(source) {
  return source
    .split('\n')
    .map((line) => {
      const trimmed = line.trimStart()
      return trimmed.startsWith('//') || trimmed.startsWith('*') ? '' : line
    })
    .join('\n')
}

// One entry per literal draw whose key has no zh entry: where it is drawn, and the key it falls
// back to. Sorted by file and line so two machines compare the same list.
export function forwardMissing(source, file, dictionary = DICTIONARY.zh) {
  const entries = []
  const lines = withoutCommentLines(source)
  for (const match of lines.matchAll(DRAW)) {
    const key = match[2].replace(/\\'/g, "'").replace(/\\"/g, '"')
    if (Object.hasOwn(dictionary, key)) continue
    const line = lines.slice(0, match.index).split('\n').length
    entries.push({ file, line, key })
  }
  return entries
}

export function scanPlugins(root = new URL('../../plugins/', import.meta.url)) {
  const entries = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    let source
    try {
      source = readFileSync(new URL(`./${entry.name}/client.js`, root), 'utf8')
    } catch {
      continue
    }
    entries.push(...forwardMissing(source, `plugins/${entry.name}/client.js`))
  }
  return entries.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1))
}

// The pinned set: one `file:key` per untranslatable sentence, sorted, whatever the draw count is.
export function forwardBaselineOf(entries) {
  return [...new Set(entries.map((entry) => `${entry.file}:${entry.key}`))].sort()
}

// `--write` may shrink the pinned set or replace it with one of the same size, but never grow it:
// a larger baseline is exactly what laundering a new untranslated draw looks like (#3003, #3009).
// `--force` is the explicit way to accept a larger set; a missing baseline file is created.
export function writeForwardBaseline(target, entries, { force = false } = {}) {
  const next = forwardBaselineOf(entries)
  let previous = null
  try {
    previous = JSON.parse(readFileSync(target, 'utf8')).entries
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const before = new Set(previous ?? [])
  const after = new Set(next)
  const added = next.filter((entry) => !before.has(entry))
  const removed = (previous ?? []).filter((entry) => !after.has(entry))
  if (previous !== null && added.length > 0 && next.length > previous.length && !force) {
    return { written: false, added, removed, entries: next }
  }
  writeFileSync(target, `${JSON.stringify({ version: 1, entries: next }, null, 2)}\n`)
  return { written: true, added, removed, entries: next }
}

if (process.argv.includes('--write')) {
  const result = writeForwardBaseline(baselineFile, scanPlugins(), {
    force: process.argv.includes('--force'),
  })
  if (!result.written) {
    for (const entry of result.added) console.log(`  + ${entry}`)
    for (const entry of result.removed) console.log(`  - ${entry}`)
    console.log(`refusing to grow the baseline: +${result.added.length}/-${result.removed.length}; pass --force to accept it`)
    process.exit(1)
  }
  console.log(`wrote ${result.entries.length} entries (+${result.added.length}/-${result.removed.length})`)
  process.exit(0)
}

test('every literal a plugin client translates has a Chinese dictionary entry', () => {
  const current = forwardBaselineOf(scanPlugins())
  const known = new Set(current)
  let baseline
  try {
    baseline = JSON.parse(readFileSync(baselineFile, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') {
      assert.fail(`core/test/i18n-plugins-missing-zh.baseline.json is missing; draws with no zh entry:\n${current.join('\n')}`)
    }
    throw error
  }
  assert.equal(baseline.version, 1, 'the baseline carries one version')
  const pinned = new Set(baseline.entries)
  const lines = new Map(scanPlugins().map((entry) => [`${entry.file}:${entry.key}`, entry.line]))
  const added = current.filter((entry) => !pinned.has(entry))
  const stale = [...pinned].filter((entry) => !known.has(entry))
  const problems = [
    ...added.map((entry) => `drawn copy ${entry} (${lines.get(entry)}) has no zh dictionary entry — add one, or pin it in the baseline`),
    ...stale.map((entry) => `baseline entry ${entry} is no longer drawn — delete that line`),
  ]
  assert.deepEqual(problems, [], problems.join('\n'))
})

test('the scan counts literal tr()/t() draws, not every string or a commented-out one', () => {
  const source = [
    "const DRAW = tr('Waiting for a task')",
    "const OTHER = t('New group')",
    "const KNOWN = t('Model')",
    "const note = 'A bare sentence that is never drawn'",
    "// tr('A commented-out draw') is prose, not a draw",
    "  * t('A star-prefixed comment line') is prose too",
    "h('div', { title: 'A copy attribute is the other scan\\'s job' }, tr('Brand new sentence'))",
  ].join('\n')
  assert.deepEqual(forwardMissing(source, 'plugins/sample/client.js').map((entry) => entry.key), [
    'Waiting for a task',
    'New group',
    'Brand new sentence',
  ])
  assert.deepEqual(forwardBaselineOf(forwardMissing(source, 'plugins/sample/client.js')), [
    'plugins/sample/client.js:Brand new sentence',
    'plugins/sample/client.js:New group',
    'plugins/sample/client.js:Waiting for a task',
  ])
})

test('one key drawn twice in a file pins once, and a line shift moves no pin', () => {
  const source = ["tr('Waiting for a task')", "tr('Waiting for a task')"].join('\n')
  assert.equal(forwardMissing(source, 'plugins/sample/client.js').length, 2)
  assert.deepEqual(forwardBaselineOf(forwardMissing(source, 'plugins/sample/client.js')), [
    'plugins/sample/client.js:Waiting for a task',
  ])
  const shifted = ['// one new comment', '', source].join('\n')
  assert.equal(forwardMissing(shifted, 'plugins/sample/client.js')[0].line, 3, 'the line is a hint, and it moves')
  assert.deepEqual(
    forwardBaselineOf(forwardMissing(shifted, 'plugins/sample/client.js')),
    forwardBaselineOf(forwardMissing(source, 'plugins/sample/client.js')),
  )
})

test('--write refuses to grow the baseline unless forced, and still allows a shrink', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flybot-i18n-plugins-baseline-'))
  try {
    const target = join(dir, 'baseline.json')
    const seed = forwardMissing("tr('Waiting for a task')", 'plugins/sample/client.js')
    const grown = forwardMissing(
      ["tr('Waiting for a task')", "tr('Brand new sentence')"].join('\n'),
      'plugins/sample/client.js',
    )
    writeFileSync(target, `${JSON.stringify({ version: 1, entries: forwardBaselineOf(seed) }, null, 2)}\n`)

    const refused = writeForwardBaseline(target, grown)
    assert.equal(refused.written, false)
    assert.deepEqual(refused.added, ['plugins/sample/client.js:Brand new sentence'])
    assert.deepEqual(
      JSON.parse(readFileSync(target, 'utf8')).entries,
      ['plugins/sample/client.js:Waiting for a task'],
      'a refused write leaves the file alone',
    )

    const forced = writeForwardBaseline(target, grown, { force: true })
    assert.equal(forced.written, true)
    assert.deepEqual(JSON.parse(readFileSync(target, 'utf8')).entries, [
      'plugins/sample/client.js:Brand new sentence',
      'plugins/sample/client.js:Waiting for a task',
    ])

    const shrunk = writeForwardBaseline(target, seed)
    assert.equal(shrunk.written, true)
    assert.deepEqual(shrunk.removed, ['plugins/sample/client.js:Brand new sentence'])

    const fresh = writeForwardBaseline(join(dir, 'fresh.json'), grown)
    assert.equal(fresh.written, true, 'a missing baseline is created, not refused')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
