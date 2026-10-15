// The generated patch format (scripts/ds-bot-patches.mjs): header lines carry no per-edit data.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeDiff } from '../../scripts/ds-bot-patches.mjs'

const lines = (n, edits = {}) => Array.from({ length: n }, (_, i) => edits[i + 1] ?? `line ${i + 1}`).join('\n') + '\n'

// What generate does for one file: `git diff --no-index` of ds-bot/x against core/x, then normalize.
function diffOf(before, after, opts) {
  const dir = mkdtempSync(join(tmpdir(), 'patch-fmt-'))
  try {
    mkdirSync(join(dir, 'ds-bot'))
    mkdirSync(join(dir, 'core'))
    writeFileSync(join(dir, 'ds-bot', 'x.js'), before)
    writeFileSync(join(dir, 'core', 'x.js'), after)
    let raw
    try { raw = execFileSync('git', ['diff', '--no-index', '--no-color', '--', 'ds-bot/x.js', 'core/x.js'], { cwd: dir, encoding: 'utf8' }) } catch (error) { raw = error.stdout }
    return normalizeDiff(raw, opts)
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

function applies(before, patch) {
  const dir = mkdtempSync(join(tmpdir(), 'patch-fmt-'))
  try {
    writeFileSync(join(dir, 'x.js'), before)
    writeFileSync(join(dir, 'p.patch'), patch)
    execFileSync('git', ['apply', '--whitespace=nowarn', '-p1', 'p.patch'], { cwd: dir, stdio: 'pipe' })
    return readFileSync(join(dir, 'x.js'), 'utf8')
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

const base = lines(200)
const top = { 3: 'line 3\nadded at the top\nand a second line' }
const bottom = { 190: 'line 190\nadded at the bottom' }

test('no index line, no ds-bot/ or core/ prefix, no per-file counts of other edits', () => {
  const patch = diffOf(base, lines(200, top))
  assert.doesNotMatch(patch, /^index /m)
  assert.match(patch, /^diff --git a\/x\.js b\/x\.js$/m)
  assert.match(patch, /^--- a\/x\.js$/m)
  assert.match(patch, /^\+\+\+ b\/x\.js$/m)
})

test('a hunk header does not depend on edits in other hunks', () => {
  const both = { ...top, ...bottom }
  const hunks = text => text.split('\n').filter(l => l.startsWith('@@'))
  const alone = hunks(diffOf(base, lines(200, bottom)))
  const withTop = hunks(diffOf(base, lines(200, both)))
  assert.equal(alone.length, 1)
  assert.ok(withTop.includes(alone[0]), `${alone[0]} not in ${withTop}`)
  // the exact form shifts the new-side start, which is what made two branches conflict
  const exact = diffOf(base, lines(200, both), { exact: true }).split('\n').filter(l => l.startsWith('@@'))
  assert.ok(!exact.includes(alone[0]))
})

test('the stored form still applies, and gives the new file', () => {
  const both = { ...top, ...bottom }
  assert.equal(applies(base, diffOf(base, lines(200, both))), lines(200, both))
  assert.equal(applies(base, diffOf(base, lines(200, both), { exact: true })), lines(200, both))
})

test('hunk bodies are never rewritten, even when they look like headers', () => {
  const tricky = ['--- a/ds-bot/x.js', '+++ b/core/x.js', 'index abc..def 100644', '@@ -1,2 +9,9 @@', 'ctx']
  const before = tricky.join('\n') + '\n'
  const after = ['ctx', ...tricky.slice(0, 4)].join('\n') + '\n'
  const patch = diffOf(before, after)
  for (const l of tricky.slice(0, 4)) assert.ok(patch.includes(l), `lost: ${l}`)
  assert.equal(applies(before, patch), after)
})
