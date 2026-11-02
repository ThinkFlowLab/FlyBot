// The shared directory-entry check (#2055). `readdir`, `stat` and a leaf `lstat` all follow a
// directory symlink, so one rule decides what an entry beside a reader's own files is, in three
// states: a real directory here, nothing there at all, or something else that must not be read
// through. `#2056` / `#2057` call the same function instead of writing the check again.
import assert from 'node:assert/strict'
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { dirKind, dirKindSync, fileKind, fileKindSync, tempWritable } from '../src/host/real-dir.js'

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

// #2079: the same three states, asked about the leaf a writer appends to. `lstat` does not follow
// the last component, so a link here is `other` rather than the file it names.
test('#2079: a leaf file is real, absent, or other, and a link is never a file here', async () => {
  const { dir, outside, done } = bench()
  try {
    writeFileSync(join(dir, 'plain.jsonl'), 'x\n')
    assert.equal(await fileKind(join(dir, 'plain.jsonl')), 'real', 'a plain non-link file is the one a writer may append to')
    assert.equal(fileKindSync(join(dir, 'plain.jsonl')), 'real')
    assert.equal(await fileKind(join(dir, 'missing.jsonl')), 'absent', 'a missing file is still a writer\'s to create')
    assert.equal(fileKindSync(join(dir, 'missing.jsonl')), 'absent')
    symlinkSync(join(outside, 'target.jsonl'), join(dir, 'linked.jsonl'))
    assert.equal(await fileKind(join(dir, 'linked.jsonl')), 'other', 'the link itself is not a file, so nothing is written through it')
    assert.equal(fileKindSync(join(dir, 'linked.jsonl')), 'other')
    mkdirSync(join(dir, 'a-folder'))
    assert.equal(await fileKind(join(dir, 'a-folder')), 'other', 'a directory where a file belongs is refused too')
    assert.equal(fileKindSync(join(dir, 'a-folder')), 'other')
  } finally { done() }
})

// The temp name a write lands through is asked in one place (temp-name sweep). A missing name is the
// writer's to create and the plain leftover of this host's own crash is replaceable, so a rejected
// write never leaves a name that locks the file forever; a link, a folder, or a file another name
// also holds (`nlink 2`, which `lstat` reports as a plain file) refuses before the first byte.
test('#P-hardlink: a temp name is writable only when it is absent or a plain file of its own', () => {
  const { dir, outside, done } = bench()
  try {
    const temp = join(dir, 'state.json.123.tmp')
    assert.equal(tempWritable(temp), true, 'absent is a writer\'s to create')
    writeFileSync(join(dir, 'not-a-dir'), 'x')
    assert.equal(tempWritable(join(dir, 'not-a-dir', 'state.json.123.tmp')), false, 'a check that cannot run (ENOTDIR) is not a licence')
    writeFileSync(temp, 'left by a crash\n')
    assert.equal(tempWritable(temp), true, 'a plain leftover under this host\'s own pid is replaceable')
    const shared = join(outside, 'shared.md')
    writeFileSync(shared, 'OUTSIDE\n')
    linkSync(shared, join(dir, 'shared.json.123.tmp'))
    assert.equal(tempWritable(join(dir, 'shared.json.123.tmp')), false, 'a hard link shares its bytes with a name outside this home')
    assert.equal(tempWritable(shared), false, 'and the other name is the same inode, both report nlink 2')
    symlinkSync(shared, join(dir, 'linked.json.123.tmp'))
    assert.equal(tempWritable(join(dir, 'linked.json.123.tmp')), false, 'a link is not a file here')
    mkdirSync(join(dir, 'folder.json.123.tmp'))
    assert.equal(tempWritable(join(dir, 'folder.json.123.tmp')), false, 'a folder where a file belongs is refused too')
  } finally { done() }
})
