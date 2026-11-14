// #3022: the forward i18n check stopped at `core/src/client/`. `core/test/i18n.test.js` reads that
// directory and nothing else, so a `tr('…')` in a plugin whose text has no `DICTIONARY.zh` entry
// fell back to the English key and no check noticed: in a zh window the workflow board drew
// English on 94 of its 169 draws (66 distinct keys), and one social string (`New group`) sat in
// the same gap.
//
// This is the forward scan over `plugins/*/client.js`: every `tr('…')` / `t('…')` literal draw is
// compared with the dictionary, and a draw with no zh entry fails unless it is pinned in
// `i18n-plugins-missing-zh.baseline.json`.
//
// The dictionary is core's `DICTIONARY.zh` **or the plugin's own table**, because a plugin's `tr()`
// falls back to one before it gives up: `fromHost !== key ? fromHost`
// `: zhUi() && Object.hasOwn(ZH, key) ? ZH[key] : key` (plugins/workflow/client.js:246). A key core
// does not know but that table translates already reads Chinese in a zh window, so pinning it was
// noise: 67 of the 68 workflow pins drew a key only that table knows and 66 of them render
// Chinese (#3041's `superseded by {id}` is the clean example — core has no entry, the plugin's
// table has 「已被 {id} 取代」). The table is read from the source the fallback itself names, never
// from a name or a list written here: a fallback pointing at a different table changes this scan in
// the same commit, and a table the scan cannot read fails loudly instead of quietly widening pins.
//
// An entry whose value is the key itself is not a translation: `Workflow: 'Workflow'` in
// workflow's table draws `Workflow` in a zh window, so it stays a pin. The contract this scan
// enforces is that no English shows in a zh window, and presence alone would hide exactly the
// entries the guard exists to catch — 69 pins were 3 real ones and 66 false ones.
//
// The sibling scans cover the other two directions —
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
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
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

// The table a plugin's own fallback reads: `Object.hasOwn(ZH, key) ? ZH[key] : key`
// (plugins/workflow/client.js:246). Reading the table the fallback names — instead of a name
// written here — is what keeps this honest: a fallback that moves to another table moves this
// scan in the same commit, and a table this file cannot read throws rather than quietly pinning
// its keys as missing.
const LOCAL_TABLE_FALLBACK = /Object\.hasOwn\(\s*([A-Za-z_$][\w$]*)\s*,\s*([A-Za-z_$][\w$]*)\s*\)\s*\?\s*\1\[\2\]/g

// The index just past the whitespace and comments starting at `index`.
function skipTrivia(source, index) {
  for (;;) {
    const char = source[index]
    if (char === undefined) return index
    if (/\s/.test(char)) {
      index += 1
      continue
    }
    if (char === '/' && source[index + 1] === '/') {
      const end = source.indexOf('\n', index)
      index = end === -1 ? source.length : end + 1
      continue
    }
    if (char === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2)
      index = end === -1 ? source.length : end + 2
      continue
    }
    return index
  }
}

// A quoted string at `index`, decoded enough for a table key (`\'`, `\"`, `\\`, `\n`, `\t`,
// `\uXXXX`). Returns its value and the index just past the closing quote.
function readQuoted(source, index) {
  const quote = source[index]
  let value = ''
  index += 1
  while (index < source.length) {
    const char = source[index]
    if (char === '\\') {
      const escaped = source[index + 1]
      if (escaped === 'u') {
        value += String.fromCharCode(Number.parseInt(source.slice(index + 2, index + 6), 16))
        index += 6
        continue
      }
      value += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped
      index += 2
      continue
    }
    if (char === quote) return { value, next: index + 1 }
    value += char
    index += 1
  }
  throw new Error('unterminated string literal in a plugin source')
}

// The index of the `,` or `}` ending the value that starts at `index`, so a string value holding
// a comma, a colon or a bracket does not end the entry early.
function skipValue(source, index) {
  let depth = 0
  for (;;) {
    index = skipTrivia(source, index)
    const char = source[index]
    if (char === undefined) throw new Error("unterminated value in a plugin's local table")
    if (char === '"' || char === "'" || char === '`') {
      index = readQuoted(source, index).next
      continue
    }
    if (char === '{' || char === '[' || char === '(') {
      depth += 1
      index += 1
      continue
    }
    if (char === '}' || char === ']' || char === ')') {
      if (depth === 0) return index
      depth -= 1
      index += 1
      continue
    }
    if (char === ',' && depth === 0) return index
    index += 1
  }
}

// Every entry of the object literal opening at `open` — a flat table of quoted or bare keys. The
// value is its text when the value is one quoted literal and `null` otherwise, which is what the
// identity test needs: a table entry whose value is the key itself translates nothing.
function tableEntriesAt(source, open) {
  const entries = new Map()
  let index = open + 1
  for (;;) {
    index = skipTrivia(source, index)
    const char = source[index]
    if (char === '}') return entries
    let key
    if (char === '"' || char === "'") {
      const quoted = readQuoted(source, index)
      key = quoted.value
      index = quoted.next
    } else {
      const bare = /^[A-Za-z_$][\w$]*/.exec(source.slice(index))
      if (bare === null) throw new Error(`cannot read a local-table key at offset ${index}`)
      key = bare[0]
      index += key.length
    }
    index = skipTrivia(source, index)
    if (source[index] !== ':') throw new Error(`cannot read the value of "${key}" in a local table`)
    const valueStart = skipTrivia(source, index + 1)
    const valueChar = source[valueStart]
    const value =
      valueChar === '"' || valueChar === "'" ? readQuoted(source, valueStart).value : null
    index = skipValue(source, valueStart)
    entries.set(key, value)
    index = skipTrivia(source, index)
    if (source[index] === ',') {
      index += 1
      continue
    }
    if (source[index] !== '}') throw new Error(`cannot find the end of "${key}" in a local table`)
  }
}

// Every entry of the table a plugin's own fallback reads. A plugin with no local table returns an
// empty map, so its scan is exactly the scan it was before.
export function localDictionaryOf(source) {
  const entries = new Map()
  for (const match of source.matchAll(LOCAL_TABLE_FALLBACK)) {
    const name = match[1]
    const declaration = new RegExp(`(?:const|let|var)\\s+${name}\\s*=\\s*\\{`).exec(source)
    if (declaration === null) {
      throw new Error(`the fallback reads \`${name}\` but this file has no \`const ${name} = {\` table`)
    }
    for (const [key, value] of tableEntriesAt(source, declaration.index + declaration[0].length - 1))
      entries.set(key, value)
  }
  return entries
}

// The keys that table really translates: an entry whose value is the key itself renders English,
// so it is not a translation. `Workflow: 'Workflow'` in a plugin's table is the case — a zh window
// shows `Workflow`, and counting it as translated would hide exactly what this guard exists to
// catch.
function translatedByTable(entries) {
  const translated = new Set()
  for (const [key, value] of entries) if (value !== key) translated.add(key)
  return translated
}

// One entry per literal draw whose key has no zh entry: where it is drawn, and the key it falls
// back to. Sorted by file and line so two machines compare the same list. A key counts as
// translated when core's dictionary has it, or when the plugin's own table maps it to a value of
// its own.
export function forwardMissing(
  source,
  file,
  dictionary = DICTIONARY.zh,
  translated = translatedByTable(localDictionaryOf(source)),
) {
  const entries = []
  const lines = withoutCommentLines(source)
  for (const match of lines.matchAll(DRAW)) {
    const key = match[2].replace(/\\'/g, "'").replace(/\\"/g, '"')
    if (Object.hasOwn(dictionary, key) || translated.has(key)) continue
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

test('a key the plugin\'s own table translates is not a missing entry', () => {
  const source = readFileSync(new URL('../../plugins/workflow/client.js', import.meta.url), 'utf8')
  const table = localDictionaryOf(source)
  for (const key of ['superseded by {id}', 'retry of {id}']) {
    assert.notEqual(table.get(key), key, `the plugin's own table translates ${key}`)
    assert.equal(Object.hasOwn(DICTIONARY.zh, key), false, `core has no entry for ${key}`)
  }
  const keys = forwardMissing(source, 'plugins/workflow/client.js').map((entry) => entry.key)
  assert.deepEqual(
    keys.filter((key) => table.has(key) && table.get(key) !== key),
    [],
    'a key the plugin itself translates is not reported as missing',
  )
  const scanned = forwardBaselineOf(scanPlugins())
  assert.equal(scanned.includes('plugins/workflow/client.js:superseded by {id}'), false)
  assert.equal(scanned.includes('plugins/workflow/client.js:retry of {id}'), false)
  const reallyEnglish =
    'This host does not pass task writes to Workflows, so a card on the board cannot start a run.'
  assert.equal(table.has(reallyEnglish), false, 'the one really-English workflow key is not in the table')
  assert.ok(keys.includes(reallyEnglish), 'and it is still reported')
})

test('a local entry whose value is the key itself is not a translation', () => {
  const source = readFileSync(new URL('../../plugins/workflow/client.js', import.meta.url), 'utf8')
  const table = localDictionaryOf(source)
  assert.equal(table.get('Workflow'), 'Workflow', "workflow's table maps Workflow to itself")
  assert.equal(Object.hasOwn(DICTIONARY.zh, 'Workflow'), false, 'and core has no entry for it')
  assert.ok(
    forwardMissing(source, 'plugins/workflow/client.js').some((entry) => entry.key === 'Workflow'),
    'so a zh window still draws Workflow, and the scan reports it',
  )
  assert.ok(
    forwardBaselineOf(scanPlugins()).includes('plugins/workflow/client.js:Workflow'),
    'the pin is the record of that English',
  )
  const synthetic = "const WORDS = { Same: 'Same', Kept: '保留' }\ntr('Same'); tr('Kept')"
  const tr = "const tr = (key) => Object.hasOwn(WORDS, key) ? WORDS[key] : key"
  assert.deepEqual(
    forwardMissing(`${synthetic}\n${tr}`, 'plugins/sample/client.js').map((entry) => entry.key),
    ['Same'],
  )
})

test('the local table is the one the fallback names, and a shape it cannot read fails loudly', () => {
  const source = [
    'const WORDS = {',
    "  'Only in the plugin': '只在插件里',",
    "  Kept: '保留',",
    '}',
    "const UNUSED = { 'Not translated': '不算' }",
    'const tr = (key) => Object.hasOwn(WORDS, key) ? WORDS[key] : key',
    "tr('Only in the plugin'); tr('Kept'); tr('Not translated'); tr('Nowhere')",
  ].join('\n')
  assert.deepEqual(
    localDictionaryOf(source),
    new Map([
      ['Only in the plugin', '只在插件里'],
      ['Kept', '保留'],
    ]),
  )
  assert.deepEqual(forwardMissing(source, 'plugins/sample/client.js').map((entry) => entry.key), [
    'Not translated',
    'Nowhere',
  ])
  assert.throws(
    () => localDictionaryOf("const tr = (key) => Object.hasOwn(MISSING, key) ? MISSING[key] : key"),
    /no `const MISSING = \{` table/,
    'a fallback naming a table this file cannot read is a failure, not an empty dictionary',
  )
})

test('the local table is read per plugin file, never shared across plugins', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flybot-i18n-plugins-local-'))
  try {
    mkdirSync(join(dir, 'a'))
    mkdirSync(join(dir, 'b'))
    writeFileSync(
      join(dir, 'a', 'client.js'),
      [
        "const WORDS = { 'Only in a': '只在 a' }",
        'const tr = (key) => Object.hasOwn(WORDS, key) ? WORDS[key] : key',
        "tr('Only in a')",
      ].join('\n'),
    )
    writeFileSync(join(dir, 'b', 'client.js'), "const tr = (key) => key\ntr('Only in a')")
    assert.deepEqual(forwardBaselineOf(scanPlugins(pathToFileURL(`${dir}/`))), ['plugins/b/client.js:Only in a'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
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
