import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createLoadTracker, loadLine, loadWord, STALLED_AFTER_MS } from '../src/load.js'

test('the load tracker counts open turns and floors at zero', () => {
  const load = createLoadTracker()
  assert.equal(load.of('a'), 0)
  load.start('a'); load.start('a')
  assert.equal(load.of('a'), 2)
  assert.deepEqual(load.snapshot(), { a: 2 })
  load.end('a')
  assert.equal(load.of('a'), 1)
  load.end('a'); load.end('a')
  assert.equal(load.of('a'), 0, 'an extra end never goes negative')
  load.start(''); load.end(undefined)
  assert.deepEqual(load.snapshot(), {})
})

test('loadWord and loadLine read plainly, and loadLine is undefined with no children', () => {
  assert.equal(loadWord(0), 'idle')
  assert.equal(loadWord(1), 'working')
  assert.equal(loadWord(3), 'busy (3 running)')
  assert.equal(loadLine([], () => 0), undefined)
  const line = loadLine([{ id: 'a', name: 'Work' }, { id: 'b', name: 'Travel' }], id => (id === 'a' ? 2 : 0))
  assert.match(line, /Work: busy \(2 running\), Travel: idle/)
})

test('#624: openFor is the age of the oldest open turn, and end clears it', () => {
  let clock = 1_000_000
  const load = createLoadTracker({ now: () => clock })
  assert.equal(load.openFor('a'), 0, 'idle has no age')
  load.start('a')
  clock += 3 * 60_000
  load.start('a')
  clock += 44 * 60_000
  assert.equal(load.of('a'), 2)
  assert.equal(load.openFor('a'), 47 * 60_000, 'the oldest turn, not the newer one')
  assert.equal(load.openFor('a', clock + 60_000), 48 * 60_000, 'a reader may pass its own clock')
  load.end('a')
  assert.equal(load.of('a'), 1)
  assert.equal(load.openFor('a'), 44 * 60_000, 'the newer turn is now the oldest')
  load.end('a')
  assert.equal(load.openFor('a'), 0)
})

test('#624: loadLine names the age only past the threshold, and never calls a child idle', () => {
  assert.equal(STALLED_AFTER_MS, 12 * 60_000)
  const children = [{ id: 'a', name: 'Dev' }]
  assert.match(loadLine(children, () => 1, () => 3 * 60_000), /Dev: working\. Send/)
  assert.match(loadLine(children, () => 1, () => 47 * 60_000), /Dev: working \(47 min, no turn ended\)/)
  assert.match(loadLine(children, () => 2, () => 47 * 60_000), /Dev: busy \(2 running, oldest open 47 min\)/)
  assert.match(loadLine(children, () => 0, () => 47 * 60_000), /Dev: idle/, 'an idle Bot is never stalled')
  // The third argument is optional, so a caller with only a count keeps the old line.
  assert.match(loadLine(children, () => 1), /Dev: working\. Send/)
})

test('#696: an end closes its own turn, not just the oldest open one', () => {
  let clock = 0
  const load = createLoadTracker({ now: () => clock })
  load.start('a', 's#1')
  clock += 10 * 60_000
  load.start('a', 's#2')
  clock += 2 * 60_000
  assert.equal(load.of('a'), 2)
  // The later turn is the one that ended, so the age left behind must be the earlier turn's.
  load.end('a', 's#2')
  assert.equal(load.of('a'), 1)
  assert.equal(load.openFor('a'), 12 * 60_000, 'the turn that really ended is gone, the older one stays')
  // An id we never saw still drops exactly one turn — the oldest — so the count cannot drift.
  load.start('a', 's#3')
  clock += 60_000
  load.end('a', 'never-seen')
  assert.equal(load.of('a'), 1)
  assert.equal(load.openFor('a'), 60_000, 'the unknown end dropped the oldest, not the newest')
  // An end with no id at all is the same fallback.
  load.start('a', 's#4')
  load.end('a')
  assert.equal(load.of('a'), 1)
  load.end('a', 's#4')
  assert.equal(load.of('a'), 0, 'the named turn is closed and nothing is left')
})
