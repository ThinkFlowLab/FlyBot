import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createLoadTracker, loadLine, loadWord } from '../src/load.js'

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
