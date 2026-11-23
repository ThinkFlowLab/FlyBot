import assert from 'node:assert/strict'
import fs from 'node:fs'
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openTrace, TraceLocked } from '../src/store.js'
import { win32 } from './platform.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'flybot-timeline-store-'))
const files = dir => readdirSync(dir).sort()
const rec = (t, extra = {}) => ({ r: 'm', t, id: `x${t}`, ...extra })

test('records are written whole (temporary file, rename), read back by the next process', (t) => {
  const dir = tmp()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const first = openTrace({ dir, now: () => 10_000 })
  first.append(rec(9_000), { bots: { a: 'Chief' }, rooms: {} })
  first.append(rec(9_500))
  assert.equal(first.flush(), true)
  // No half-written file is left behind, and the lock is held while open.
  assert.deepEqual(files(dir), ['trace-000001.json', 'writer.lock'])
  first.close()
  assert.deepEqual(files(dir), ['trace-000001.json'])
  const second = openTrace({ dir, now: () => 10_000 })
  assert.deepEqual(second.records().map(r => r.t), [9_000, 9_500])
  assert.deepEqual(second.names().bots, { a: 'Chief' })
  second.close()
})

test('files and the directory are private', (t) => {
  const dir = join(tmp(), 'trace')
  t.after(() => rmSync(join(dir, '..'), { recursive: true, force: true }))
  const trace = openTrace({ dir })
  trace.append(rec(1_000))
  trace.flush()
  if (process.platform !== 'win32') {
    assert.equal(statSync(dir).mode & 0o077, 0)
    assert.equal(statSync(join(dir, 'trace-000001.json')).mode & 0o077, 0)
  }
  trace.close()
})

test('a full segment rotates; only the newest segments stay; the cap holds', (t) => {
  const dir = tmp()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const trace = openTrace({ dir, segmentRecords: 3, segments: 2, now: () => 100_000 })
  for (let i = 1; i <= 10; i++) trace.append(rec(90_000 + i))
  trace.flush()
  // 10 records, 3 per segment: segments 1-4 exist, only 3 and 4 are kept.
  assert.deepEqual(files(dir).filter(name => name.startsWith('trace-')), ['trace-000003.json', 'trace-000004.json'])
  assert.deepEqual(trace.records().map(r => r.t), [90_007, 90_008, 90_009, 90_010])
  assert.ok(trace.stats().records <= 2 * 3)
  assert.equal(trace.stats().segments, 2)
  trace.close()
})

test('records past the retention age are not read, and an expired segment is deleted at open', (t) => {
  const dir = tmp()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const day = 24 * 3600 * 1000
  const old = openTrace({ dir, segmentRecords: 2, now: () => day / 2 })
  old.append(rec(1_000)); old.append(rec(2_000)); old.append(rec(3 * day)); old.flush(); old.close()
  assert.deepEqual(files(dir), ['trace-000001.json', 'trace-000002.json'])
  // A day after the first segment's records: they are not read, and the file is deleted.
  const reopened = openTrace({ dir, now: () => 3 * day + day - 1 })
  assert.deepEqual(reopened.records().map(r => r.t), [3 * day])
  assert.deepEqual(files(dir), ['trace-000002.json', 'writer.lock'])
  reopened.close()
  // The newest segment stays as the place to write, but its expired records are not read.
  const later = openTrace({ dir, now: () => 5 * day })
  assert.deepEqual(later.records(), [])
  later.close()
})

test('one writer: a live holder is respected, a dead one is taken over, a second open in-process is refused', (t) => {
  const dir = tmp()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const trace = openTrace({ dir })
  assert.throws(() => openTrace({ dir }), TraceLocked)
  trace.close()
  // A lock left by a killed process (a pid that is gone) does not block the next start.
  writeFileSync(join(dir, 'writer.lock'), '2147483646\n')
  const taken = openTrace({ dir })
  taken.close()
  // The parent shell's pid is alive and not ours: it holds the lock.
  writeFileSync(join(dir, 'writer.lock'), `${process.ppid}\n`)
  assert.throws(() => openTrace({ dir }), TraceLocked)
  rmSync(join(dir, 'writer.lock'))
  const again = openTrace({ dir })
  again.close()
})

// #2629: an open that refuses after it took the writer lock must give the lock back. A directory
// that exists but cannot be listed takes the lock (creating `writer.lock` needs only `+wx`) and
// then throws on the listing; the only release used to be `close()`, which that path never reached,
// so the process held the directory for good and the lock file stayed for every later process.
test(`a refused open releases the writer lock for the next open in this process${win32 ? ' (skipped on Windows: chmod cannot make a folder unlistable for its owner, so nothing refuses the open once the writer lock is taken)' : ''}`, {
  // The open has to take the writer lock and then fail in the listing. POSIX reaches that with a
  // folder whose mode removes the read bit; Windows has no such bit (chmod only sets the read-only
  // attribute, and its owner still lists the folder), so this one shape cannot be built there (#3298).
  skip: win32 ? 'Windows has no POSIX mode bits: a folder cannot be made unlistable for its owner, so an open cannot be refused after it took the writer lock' : undefined,
}, (t) => {
  const root = mkdtempSync(join(tmpdir(), 'flybot-timeline-store-'))
  const dir = join(root, 'trace')
  mkdirSync(dir, { recursive: true })
  t.after(() => {
    chmodSync(dir, 0o700)
    rmSync(root, { recursive: true, force: true })
  })
  chmodSync(dir, 0o300)
  // (a) the open throws instead of answering a trace that cannot read its own directory.
  assert.throws(() => openTrace({ dir }), (error) => error?.code === 'EACCES', 'the open fails on the unlistable directory')
  chmodSync(dir, 0o700)
  const lockLeft = existsSync(join(dir, 'writer.lock'))
  const reopened = (() => { try { return openTrace({ dir, now: () => 10_000 }) } catch (error) { return error } })()
  // (b) the directory is not still held in this process: the same open succeeds once it is listable.
  assert.ok(!(reopened instanceof Error), `the same process opens the directory again: ${reopened?.message}`)
  // (c) and the failed open left no lock file behind for the next process.
  assert.equal(lockLeft, false, 'the refused open left writer.lock on disk')
  reopened.append(rec(9_000))
  assert.equal(reopened.flush(), true)
  reopened.close()
})

test('a corrupt or foreign segment is set aside, never crashes the start, and is not read again', (t) => {
  const dir = tmp()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const first = openTrace({ dir, now: () => 10_000 })
  first.append(rec(9_000)); first.flush(); first.close()
  writeFileSync(join(dir, 'trace-000002.json'), '{"version":1,"records":[{"r":"m"')
  writeFileSync(join(dir, 'trace-000003.json'), JSON.stringify({ version: 99, records: [] }))
  writeFileSync(join(dir, 'trace-000001.json.tmp'), 'half a write')
  const warnings = []
  const trace = openTrace({ dir, now: () => 10_000, warn: (...args) => warnings.push(args.join(' ')) })
  assert.deepEqual(trace.records().map(r => r.t), [9_000])
  assert.equal(warnings.length, 2)
  assert.ok(existsSync(join(dir, 'trace-000002.json.corrupt')))
  assert.ok(existsSync(join(dir, 'trace-000003.json.corrupt')))
  trace.close()
})

test('a write failure is reported once and recording goes on in memory', (t) => {
  const dir = tmp()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const warnings = []
  const trace = openTrace({ dir, warn: (...args) => warnings.push(args.join(' ')) })
  trace.append(rec(Date.now() - 1_000))
  rmSync(dir, { recursive: true, force: true })
  assert.equal(trace.flush(), false)
  trace.append(rec(Date.now()))
  assert.equal(trace.flush(), false)
  assert.equal(warnings.length, 1)
  assert.equal(trace.records().length, 2)
  assert.equal(trace.stats().failing, true)
  trace.close()
})

test('persist: false never touches the disk', () => {
  const trace = openTrace({ persist: false })
  trace.append(rec(Date.now()))
  assert.equal(trace.flush(), true)
  assert.equal(trace.records().length, 1)
  assert.equal(trace.stats().persist, false)
  trace.close()
})

test('the segment file holds records and names only', (t) => {
  const dir = tmp()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const trace = openTrace({ dir })
  trace.append({ r: 'ks', t: 1_000, id: 'c1', tid: 's#1', nm: 'bash' })
  trace.flush(); trace.close()
  const data = JSON.parse(readFileSync(join(dir, 'trace-000001.json'), 'utf8'))
  assert.deepEqual(Object.keys(data).sort(), ['names', 'records', 'segment', 'startedAt', 'version'])
})

// A temporary name that is a link or a directory is not the writer's to replace: the write
// would land outside (a link) or crash (a directory), and the rename after it would put the
// link where the segment belongs. The refusal names the name and touches nothing.
const OUTSIDE = 'outside keeps its own bytes\n'
const GOOD_SEGMENT = JSON.stringify({ version: 1, segment: 1, startedAt: 1, names: {}, records: [{ r: 'm', t: 1, id: 'old' }] })
const refusedWrite = ({ shape, seed }) => {
  const root = mkdtempSync(join(tmpdir(), 'flybot-timeline-store-'))
  const dir = join(root, 'trace')
  mkdirSync(dir)
  const outside = join(root, 'outside.txt')
  writeFileSync(outside, OUTSIDE)
  const temporary = join(dir, 'trace-000001.json.tmp')
  const segment = join(dir, 'trace-000001.json')
  if (seed) writeFileSync(segment, seed)
  if (shape === 'symlink') symlinkSync(outside, temporary)
  else if (shape === 'hardlink') linkSync(outside, temporary)
  else mkdirSync(temporary)
  const warnings = []
  const trace = openTrace({ dir, now: () => 10_000, warn: (...args) => warnings.push(args.join(' ')) })
  trace.append(rec(9_000))
  const flushed = trace.flush()
  const facts = {
    flushed,
    warnings,
    outside: readFileSync(outside, 'utf8'),
    segment: existsSync(segment) ? readFileSync(segment, 'utf8') : null,
    temp: (() => { try { const info = lstatSync(temporary); return { link: info.isSymbolicLink(), dir: info.isDirectory() } } catch { return null } })(),
  }
  trace.close()
  rmSync(root, { recursive: true, force: true })
  return facts
}

for (const shape of ['symlink', 'hardlink', 'directory']) {
  test(`a ${shape} at the temporary name refuses the write and changes nothing`, () => {
    // Nothing made yet: the segment is not created, and the bytes behind the name are untouched.
    const absent = refusedWrite({ shape })
    assert.equal(absent.flushed, false)
    assert.equal(absent.segment, null)
    assert.equal(absent.outside, OUTSIDE)
    assert.equal(absent.warnings.length, 1)
    assert.match(absent.warnings[0], /trace-000001\.json\.tmp is not a plain file of its own/)
    // The refused name is left exactly as it was, not cleaned up and not replaced.
    assert.ok(absent.temp?.link === (shape === 'symlink') && absent.temp?.dir === (shape === 'directory'))
    // A segment already there keeps its bytes: the rename never happens either.
    const existing = refusedWrite({ shape, seed: GOOD_SEGMENT })
    assert.equal(existing.flushed, false)
    assert.equal(existing.segment, GOOD_SEGMENT)
    assert.equal(existing.outside, OUTSIDE)
    assert.equal(existing.warnings.length, 1)
    assert.match(existing.warnings[0], /is not a plain file of its own/)
  })
}

test('a missing temporary name is a writer’s to create', (t) => {
  const dir = tmp()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const trace = openTrace({ dir, now: () => 10_000 })
  trace.append(rec(9_000))
  assert.equal(trace.flush(), true)
  assert.equal(JSON.parse(readFileSync(join(dir, 'trace-000001.json'), 'utf8')).records.length, 1)
  assert.ok(!existsSync(join(dir, 'trace-000001.json.tmp')))
  trace.close()
})

test('a rotation whose flush fails does not prune the last durable segment', (t) => {
  const dir = tmp()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const trace = openTrace({ dir, segmentRecords: 2, segments: 2, flushMs: 60_000, now: () => 1_000_000 })
  const disk = () => files(dir).filter(name => /^trace-\d{6}\.json$/.test(name))
    .map(name => [name, JSON.parse(readFileSync(join(dir, name), 'utf8')).records.map(r => r.t)])
  trace.append(rec(1)); trace.append(rec(2))
  assert.equal(trace.flush(), true)
  assert.deepEqual(disk(), [['trace-000001.json', [1, 2]]])
  trace.append(rec(3)); trace.append(rec(4))
  // The next write is refused: a link sits where the new segment's temporary file goes.
  symlinkSync(join(dir, 'outside'), join(dir, 'trace-000002.json.tmp'))
  trace.append(rec(5))
  // The page still shows what it holds, and the durable segment is still there for a restarted host.
  assert.deepEqual(trace.records().map(r => r.t).filter(t => t >= 3), [3, 4, 5])
  assert.deepEqual(disk(), [['trace-000001.json', [1, 2]]])
  rmSync(join(dir, 'trace-000002.json.tmp'), { force: true })
  trace.append(rec(6)); trace.append(rec(7))
  assert.equal(trace.flush(), true)
  // The next successful rotation applies the cap again, and the newest segments are on disk.
  assert.deepEqual(trace.records().map(r => r.t), [5, 6, 7])
  assert.deepEqual(disk(), [['trace-000003.json', [5, 6]], ['trace-000004.json', [7]]])
  trace.close()
})

test('a plain temporary file a crashed writer left behind (one name) is overwritten', (t) => {
  const dir = tmp()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const temporary = join(dir, 'trace-000001.json.tmp')
  writeFileSync(temporary, 'half a write')
  assert.equal(lstatSync(temporary).nlink, 1)
  const trace = openTrace({ dir, now: () => 10_000 })
  trace.append(rec(9_000))
  assert.equal(trace.flush(), true)
  assert.ok(!existsSync(temporary))
  assert.equal(JSON.parse(readFileSync(join(dir, 'trace-000001.json'), 'utf8')).records.length, 1)
  trace.close()
})

// Windows refuses `fsync` on a directory handle (EPERM from FlushFileBuffers; EINVAL on a filesystem
// without directory flushes). It is the last step of `writeWhole`, after the temporary file was
// synced and renamed, so the segment's bytes are already durable when it throws: the write must
// count as saved, or the published segment is rewritten on every flush and the cap and the lock
// hand-off never settle (#3298). A Linux directory fsync is a no-op success, so the case replaces
// the `fsyncSync` binding `store.js` imports (node:module keeps that binding live) for as long as it
// runs, and refuses only directory handles: the file sync stays real, and a failing *file* sync
// would still reach the caller instead of being swallowed.
const refuseDirectorySync = (t, code) => {
  const real = fs.fsyncSync
  const seen = { files: 0 }
  fs.fsyncSync = (fd) => {
    if (fs.fstatSync(fd).isDirectory()) throw Object.assign(new Error(`${code}: fsync failed`), { code })
    seen.files += 1
    return real(fd)
  }
  syncBuiltinESMExports()
  t.after(() => {
    fs.fsyncSync = real
    syncBuiltinESMExports()
  })
  return seen
}

test('a directory fsync the platform refuses still saves the segment (Windows EPERM)', (t) => {
  const dir = tmp()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const seen = refuseDirectorySync(t, 'EPERM')
  const trace = openTrace({ dir, now: () => 10_000 })
  trace.append(rec(9_000))
  assert.equal(trace.flush(), true, 'the bytes are durable once the file was synced and renamed')
  assert.equal(trace.stats().failing, false, 'a refused directory sync is not a failed write')
  assert.equal(seen.files, 1, 'the segment itself was synced before the directory was')
  assert.equal(trace.flush(), true, 'a flush with nothing new succeeds too')
  assert.equal(seen.files, 1, 'a saved segment is not rewritten by the next flush')
  trace.close()
  const reopened = openTrace({ dir, now: () => 10_000 })
  assert.deepEqual(reopened.records().map(r => r.t), [9_000])
  reopened.close()
})

test('a directory fsync refused with EINVAL is tolerated the same way', (t) => {
  const dir = tmp()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const seen = refuseDirectorySync(t, 'EINVAL')
  const trace = openTrace({ dir, now: () => 10_000 })
  trace.append(rec(9_000))
  assert.equal(trace.flush(), true)
  assert.equal(trace.stats().failing, false)
  assert.equal(seen.files, 1)
  trace.close()
  const reopened = openTrace({ dir, now: () => 10_000 })
  assert.deepEqual(reopened.records().map(r => r.t), [9_000])
  reopened.close()
})

test('a rotation still prunes to the cap when the directory fsync is refused', (t) => {
  const dir = tmp()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  refuseDirectorySync(t, 'EPERM')
  const trace = openTrace({ dir, segmentRecords: 2, segments: 2, flushMs: 60_000, now: () => 1_000_000 })
  for (const at of [1, 2, 3, 4, 5, 6]) trace.append(rec(at))
  assert.equal(trace.flush(), true)
  assert.deepEqual(files(dir).filter(name => /^trace-\d{6}\.json$/.test(name)), ['trace-000002.json', 'trace-000003.json'])
  assert.deepEqual(trace.records().map(r => r.t), [3, 4, 5, 6])
  trace.close()
})

// The tolerance above is for a directory handle the platform refuses, and for nothing else. A file
// sync that fails is a write that never reached the disk: reading it as the tolerated refusal (both
// syncs inside one `try`) would report bytes as saved while the segment is not there. The case
// replaces the same binding, refuses only file handles, and leaves the directory sync real.
const refuseFileSync = (t, code) => {
  const real = fs.fsyncSync
  const seen = { files: 0 }
  fs.fsyncSync = (fd) => {
    if (fs.fstatSync(fd).isDirectory()) return real(fd)
    seen.files += 1
    throw Object.assign(new Error(`${code}: fsync failed`), { code })
  }
  syncBuiltinESMExports()
  t.after(() => {
    fs.fsyncSync = real
    syncBuiltinESMExports()
  })
  return seen
}

test('a file fsync that fails with EIO still fails the write', (t) => {
  const dir = tmp()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const seen = refuseFileSync(t, 'EIO')
  const warnings = []
  const trace = openTrace({ dir, now: () => 10_000, warn: (...args) => warnings.push(args.join(' ')) })
  trace.append(rec(9_000))
  assert.equal(trace.flush(), false, 'a failed file sync is not the platform refusing the directory')
  assert.equal(seen.files, 1, 'the file sync is the one that failed')
  assert.equal(trace.stats().failing, true)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /EIO/)
  assert.ok(!existsSync(join(dir, 'trace-000001.json')), 'the segment was not published')
  assert.deepEqual(trace.records().map(r => r.t), [9_000], 'the record stays in memory')
  trace.close()
})

test('a directory fsync refused with EACCES is still a failed write', (t) => {
  const dir = tmp()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  refuseDirectorySync(t, 'EACCES')
  const warnings = []
  const trace = openTrace({ dir, now: () => 10_000, warn: (...args) => warnings.push(args.join(' ')) })
  trace.append(rec(9_000))
  assert.equal(trace.flush(), false, 'only the refusals the platform gives are tolerated, never any error')
  assert.equal(trace.stats().failing, true)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /EACCES/)
  assert.deepEqual(trace.records().map(r => r.t), [9_000])
  trace.close()
})

// A second recorder on a directory another writer holds collects in memory (`retryLock`) and asks
// for the lock again when there is something to write. The directory sync is the last step of that
// save: refusing it must not stop the lock from being adopted, the records from landing once, or the
// next open from reading them back (#3298 measured the hand-over never settling).
test('a deferred writer takes the lock and saves once when the directory fsync is refused', (t) => {
  const dir = tmp()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const seen = refuseDirectorySync(t, 'EPERM')
  const first = openTrace({ dir, now: () => 10_000 })
  const warnings = []
  const second = openTrace({ dir, retryLock: true, now: () => 10_000, warn: (...args) => warnings.push(args.join(' ')) })
  assert.equal(second.stats().deferred, true, 'the live writer keeps the lock')
  second.append(rec(9_000))
  assert.equal(second.flush(), false, 'the lock is still the other writer’s')
  assert.equal(second.stats().deferred, true)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /not writable yet/)
  first.close()
  const synced = seen.files
  assert.equal(second.flush(), true, 'the adopted lock plus a refused directory sync still saves')
  assert.equal(seen.files - synced, 1, 'the deferred records are written once')
  assert.equal(second.stats().persist, true)
  assert.ok(!('deferred' in second.stats()))
  assert.equal(second.flush(), true)
  assert.equal(seen.files - synced, 1, 'a saved segment is not rewritten by the next flush')
  second.close()
  const reopened = openTrace({ dir, now: () => 10_000 })
  assert.deepEqual(reopened.records().map(r => r.t), [9_000])
  reopened.close()
})
