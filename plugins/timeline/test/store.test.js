import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openTrace, TraceLocked } from '../src/store.js'

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
