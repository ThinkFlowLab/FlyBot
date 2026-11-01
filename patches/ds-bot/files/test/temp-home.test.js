import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { cleanHome } from './temp-home.js'

// #1983: the teardown owner stops and awaits its writers, then removes the home once. What this
// helper must not do is try a few times and move on: a swallowed `ENOTEMPTY` is the only signal
// that a writer was still filling the directory. These three assertions pin the contract — the
// directory is gone, a remover that leaves it fails, and any other error surfaces unchanged.
test('the teardown removes the home once and asserts it is gone (#1983)', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-temp-home-'))
  const removals = []
  cleanHome(home, { remove: (path, options) => { removals.push([path, options]); rmSync(path, options) } })
  assert.equal(removals.length, 1, 'one removal, no retry loop')
  assert.deepEqual(removals[0], [home, { recursive: true, force: true }])
  assert.equal(existsSync(home), false, 'the directory is gone afterwards')
})

test('a remover that leaves the directory behind fails the teardown (#1983)', () => {
  assert.throws(
    () => cleanHome('still-there', { remove: () => {}, exists: () => true }),
    /still-there was still there after teardown/,
    'a silent remover is a failed teardown, never a green test',
  )
})

test('an error from the removal surfaces unchanged (#1983)', () => {
  const error = Object.assign(new Error('denied'), { code: 'EACCES' })
  assert.throws(
    () => cleanHome('ignored', { remove: () => { throw error }, exists: () => false }),
    error,
    'the real error belongs to the test, not a swallowed retry',
  )
})
