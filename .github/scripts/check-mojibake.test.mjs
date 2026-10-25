import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { isBinary, render, scanBuffer, scanTree } from './check-mojibake.mjs'

const ROOT = join(import.meta.dirname, '..', '..')
const SCRIPT = join(import.meta.dirname, 'check-mojibake.mjs')
const TRIPLE = Buffer.from([0xef, 0xbf, 0xbd])
const GIF = 'docs/images/demo-tree.gif'
const SQLITE = 'core/test/fixtures/usage-sample.sqlite'

const tempTree = (files) => {
  const root = mkdtempSync(join(tmpdir(), 'check-mojibake-'))
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true })
    writeFileSync(join(root, rel), content)
  }
  return root
}

test('scanBuffer: one triple is one occurrence, a line holding two counts once', () => {
  assert.deepEqual(scanBuffer(Buffer.from('a')), { occurrences: 0, lines: 0 })
  assert.deepEqual(scanBuffer(Buffer.from([0x61, ...TRIPLE, 0x62])), { occurrences: 1, lines: 1 })
  // The damaged i18n line from 9a033cef: two triples, on one line, inside a Chinese string.
  const damaged = Buffer.concat([Buffer.from('x: \u8fde'), TRIPLE, TRIPLE, Buffer.from('\u5e94\u7528\n')])
  assert.deepEqual(scanBuffer(damaged), { occurrences: 2, lines: 1 })
  const twoLines = Buffer.concat([TRIPLE, Buffer.from('\n'), TRIPLE, Buffer.from('\n')])
  assert.deepEqual(scanBuffer(twoLines), { occurrences: 2, lines: 2 })
})

test('isBinary: the repository assets are binary by content, a source file is not', () => {
  const gif = readFileSync(join(ROOT, GIF))
  const sqlite = readFileSync(join(ROOT, SQLITE))
  assert.equal(isBinary(gif), true)
  assert.equal(isBinary(sqlite), true)
  assert.equal(isBinary(readFileSync(join(ROOT, 'core/src/client/i18n.js'))), false)
  // Why the skip is the rule and not a nicety: decoded as UTF-8, this gif alone reports
  // six figures of U+FFFD on a clean tree — the same false red the gate would have on main.
  const naive = (gif.toString('utf8').match(/\uFFFD/g) ?? []).length
  assert.ok(naive > 300_000, `the gif reads ${naive} replacement characters when decoded, so a decode-first scan is red on main`)
  assert.deepEqual(scanBuffer(gif), undefined)
})

test('scanTree: the repository is clean and the binary assets are skipped by name', () => {
  const result = scanTree(ROOT)
  assert.deepEqual(result.hits, [])
  assert.ok(result.text > 500, `scanned ${result.text} text files`)
  // Tested, not assumed: both copies of the sqlite fixture and the images never enter the scan.
  assert.ok(result.skipped.includes(SQLITE), `skipped: ${result.skipped.join(', ')}`)
  assert.ok(result.skipped.includes(GIF))
  assert.ok(result.skipped.length >= 20, `skipped ${result.skipped.length} binary files`)
})

test('scanTree: a text file with a damaged line is named with its count, next to clean files', () => {
  const root = tempTree({
    'src/good.js': 'const ok = "\u8fde\u63a5\u5e94\u7528"\n',
    'src/bad.md': 'line one\n连\uFFFD\uFFFD应\u7528\nline three\n',
    'assets/pixel.bin': Buffer.from([0x00, 0x01, 0xef, 0xbf, 0xbd]),
  })
  try {
    const result = scanTree(root)
    assert.deepEqual(result.hits, [{ path: 'src/bad.md', occurrences: 2, lines: 1 }])
    assert.deepEqual(result.skipped, ['assets/pixel.bin'])
    assert.equal(result.text, 2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('render and the CLI: red names the file, occurrences and lines; clean answers ok', () => {
  const root = tempTree({
    'docs/note.md': 'one\n\u8fde\ufffd\ufffd\u5e94\u7528 and \ufffd\n',
    'img.bin': Buffer.from([0x00, 0xef, 0xbf, 0xbd]),
  })
  try {
    const red = spawnSync(process.execPath, [SCRIPT, '--check', root], { encoding: 'utf8' })
    assert.equal(red.status, 1)
    assert.match(red.stdout, /3 occurrence\(s\) of U\+FFFD .* on 1 line\(s\) in 1 file\(s\)/u)
    assert.match(red.stdout, /docs\/note.md — 3 occurrence\(s\) on 1 line\(s\)/u)
    assert.match(red.stdout, /Regenerate each file from its source/u)
    assert.doesNotMatch(red.stdout, /img\.bin —/u)

    writeFileSync(join(root, 'docs/note.md'), 'one\ntwo\n')
    const green = spawnSync(process.execPath, [SCRIPT, '--check', root], { encoding: 'utf8' })
    assert.equal(green.status, 0, green.stdout)
    assert.match(green.stdout, /mojibake: ok — 0 occurrences of U\+FFFD in 1 text file\(s\) \(1 skipped as binary: img\.bin\)/u)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('render: the binary skip is visible in the ok line, and a hit list ends with the remedy', () => {
  const ok = render({ hits: [], skipped: ['a.gif', 'b.sqlite'], text: 3 })
  assert.match(ok, /0 occurrences of U\+FFFD in 3 text file\(s\) \(2 skipped as binary: a\.gif, b\.sqlite\)/u)
  const fail = render({ hits: [{ path: 'x.js', occurrences: 4, lines: 2 }], skipped: [], text: 1 })
  assert.match(fail, /FAIL — 4 occurrence\(s\).* on 2 line\(s\) in 1 file\(s\):/u)
  assert.match(fail, /  x\.js — 4 occurrence\(s\) on 2 line\(s\)/u)
})
