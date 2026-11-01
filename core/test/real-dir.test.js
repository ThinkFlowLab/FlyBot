// The shared directory-entry check (#2055). `readdir`, `stat` and a leaf `lstat` all follow a
// directory symlink, so one rule decides what an entry beside a reader's own files is, in three
// states: a real directory here, nothing there at all, or something else that must not be read
// through. `#2056` / `#2057` call the same function instead of writing the check again.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { dirKind, dirKindSync } from '../src/host/real-dir.js'

function bench() {
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-real-dir-'))
  const outside = mkdtempSync(join(tmpdir(), 'ds-bot-real-dir-outside-'))
  return { dir, outside, done: () => { rmSync(dir, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }) } }
}

test('#2055: a link to a real directory is other, not a directory here', async () => {
  const { dir, outside, done } = bench()
  try {
    symlinkSync(outside, join(dir, 'decisions'))
    assert.equal(await dirKind(join(dir, 'decisions')), 'other', 'readdir would follow it, so the entry itself decides')
    assert.equal(dirKindSync(join(dir, 'decisions')), 'other', 'and the sync form answers the same')
  } finally { done() }
})

test('#2055: a link to a path that does not exist is other, not absent', async () => {
  const { dir, done } = bench()
  try {
    symlinkSync(join(dir, 'nowhere'), join(dir, 'decisions'))
    assert.equal(await dirKind(join(dir, 'decisions')), 'other', 'the link is there and is not a directory: never read through it, never mkdir over it')
    assert.equal(dirKindSync(join(dir, 'decisions')), 'other')
  } finally { done() }
})

test('#2055: a plain file is other', async () => {
  const { dir, done } = bench()
  try {
    writeFileSync(join(dir, 'decisions'), 'not a folder\n')
    assert.equal(await dirKind(join(dir, 'decisions')), 'other')
    assert.equal(dirKindSync(join(dir, 'decisions')), 'other')
  } finally { done() }
})

test('#2055: a real directory is real, and a path that is not there is absent', async () => {
  const { dir, done } = bench()
  try {
    mkdirSync(join(dir, 'decisions'))
    assert.equal(await dirKind(join(dir, 'decisions')), 'real', 'the control: the entry the reader means is the one it reads')
    assert.equal(dirKindSync(join(dir, 'decisions')), 'real')
    assert.equal(await dirKind(join(dir, 'no-such-entry')), 'absent', 'a missing path is the state a writer may create and a reader skips')
    assert.equal(dirKindSync(join(dir, 'no-such-entry')), 'absent')
  } finally { done() }
})
