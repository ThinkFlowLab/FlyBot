// #2321: a host bound judges in code points, not in UTF-16 units. A character outside the BMP
// costs one of the budget, so a text that is under its own limit is never cut. Every row names the
// consumer that judges: a later change back to `text.length > max` fails here at that `file:line`.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { clip, codePoints, excerpt } from '../src/host/text.js'
import * as boundary from '../src/shared/text-boundary.js'

const read = (path) => readFileSync(fileURLToPath(new URL(`../src/${path}`, import.meta.url)), 'utf8')
const lineOf = (source, needle) => {
  const at = source.indexOf(needle)
  return at === -1 ? undefined : source.slice(0, at).split('\n').length
}
const locate = (path, needle) => {
  const line = lineOf(read(path), needle)
  return line === undefined ? `core/src/${path}` : `core/src/${path}:${line}`
}

// The table: a limit, the text it judges, and the consumer that owns the judgment. Each text is
// under `limit` characters and over it in UTF-16 units, which is the shape #2321 is about.
const LIMITS = [
  { consumer: 'clip', path: 'host/text.js', declaration: 'export const clip =', limit: 400, text: '😀'.repeat(300) },
  { consumer: 'clip', path: 'host/text.js', declaration: 'export const clip =', limit: 400, text: '😀'.repeat(201) },
  { consumer: 'excerpt', path: 'host/text.js', declaration: 'export const excerpt =', limit: 400, text: '😀'.repeat(300) },
]

const run = (row) => (row.consumer === 'clip' ? clip(row.text, row.limit, 'r') : excerpt(row.text, '', row.limit))

for (const row of LIMITS) {
  test(`#2321: ${row.consumer} keeps a text under its own limit (${locate(row.path, row.declaration)})`, () => {
    const kept = `${codePoints(row.text)} characters / ${row.text.length} UTF-16 units, limit ${row.limit}`
    assert.equal(run(row), row.text, `a text of ${kept} is under its limit, so ${row.consumer} must not cut it`)
  })
}

// The judgment itself: each consumer must ask `fits`, so reverting one to `text.length > max` names
// only that consumer's own file:line and the table cannot rot silently.
for (const row of LIMITS) {
  test(`#2321: ${row.consumer} judges with fits, not with UTF-16 units (${locate(row.path, row.declaration)})`, () => {
    const where = locate(row.path, row.declaration)
    const source = read(row.path)
    const from = source.indexOf(row.declaration)
    const block = source.slice(from)
    const body = row.consumer === 'clip' ? block.slice(0, block.indexOf('\n')) : block.slice(0, block.indexOf('\n}') + 2)
    assert.equal(body.includes('fits('), true, `${where} judges in UTF-16 units: it must judge with fits(...) from shared/text-boundary.js`)
  })
}

test('#2321: an over-limit clip still cuts and says so', () => {
  const out = clip('😀'.repeat(201), 200, 'r')
  assert.equal(out.endsWith('… (cut; r)'), true, out.slice(-24))
  assert.equal(codePoints(out.slice(0, -'… (cut; r)'.length)) <= 200, true, `it keeps at most 200 characters: ${codePoints(out)}`)
})

test('#2321: fits counts code points, not UTF-16 units (core/src/shared/text-boundary.js)', () => {
  assert.equal(typeof boundary.fits, 'function', 'shared/text-boundary.js must export fits(text, max)')
  assert.equal(boundary.fits('', 0), true)
  assert.equal(boundary.fits('abc', 3), true)
  assert.equal(boundary.fits('abcd', 3), false)
  assert.equal(boundary.fits('😀'.repeat(201), 400), true, '201 characters are under a 400-character limit, though 402 UTF-16 units are not')
  assert.equal(boundary.fits('😀'.repeat(401), 400), false)
  assert.equal(boundary.fits('a😀b', 3), true)
})

test('#2321: the memory review clip is the shared one, not a third copy (core/src/host/memory.js)', () => {
  const source = read('host/memory.js')
  const duplicate = lineOf(source, 'const clip = (text, max) =>')
  assert.equal(duplicate, undefined, `core/src/host/memory.js:${duplicate} keeps its own clip: import the one from ./text.js`)
  assert.match(source, /import \{[^}]*\bclip\b[^}]*\} from '\.\/text\.js'/, 'core/src/host/memory.js must import clip from ./text.js')
})
