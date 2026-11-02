import assert from 'node:assert/strict'
import { test } from 'node:test'
import { memoryBlockedNotice, memoryEmptyNotice } from '../src/client/memory-empty.js'

// The suite has no React renderer, so the empty state's decision is a pure helper: it says nothing
// for an ordinary empty view, and names the folder for a view whose scopes were refused (#2101).
test('#2101: a blocked empty view says which folder could not be read', () => {
  const view = { entries: [], blocked: [{ scope: 'own', path: '/home/u/.flybot/memory' }] }
  assert.equal(memoryEmptyNotice(view),
    'The memory folder /home/u/.flybot/memory is not a plain directory, so it cannot be read.')
})

test('#2101: an ordinary empty view adds nothing', () => {
  assert.equal(memoryEmptyNotice({ entries: [], blocked: [] }), null)
  assert.equal(memoryEmptyNotice({ entries: [] }), null, 'a view from a host that reports no blocked scopes')
  assert.equal(memoryEmptyNotice({}), null)
  assert.equal(memoryEmptyNotice(undefined), null)
})

test('#2101: one broken folder behind both scopes is named once', () => {
  const view = { entries: [], blocked: [{ scope: 'own', path: '/p' }, { scope: 'team', path: '/p' }] }
  assert.equal(memoryEmptyNotice(view), 'The memory folder /p is not a plain directory, so it cannot be read.')
})

test('#2101: entries are not the empty state, however the folder was read', () => {
  assert.equal(memoryEmptyNotice({ entries: [{ text: 'x' }], blocked: [{ scope: 'team', path: '/p' }] }), null)
})

// Above the list the shortcut above cannot be used: `entries` is own and team merged, so one scope's
// entries used to silence the other scope's refusal and a half-read memory looked whole again. This
// answer reads `blocked` only, and says nothing when nothing was refused.
test('#2101: a refused scope is named above the list, whatever the other scope holds', () => {
  const view = { entries: [{ scope: 'team', text: 'x' }], blocked: [{ scope: 'own', path: '/home/u/.flybot/memory' }] }
  assert.equal(memoryBlockedNotice(view),
    'The memory folder /home/u/.flybot/memory is not a plain directory, so it cannot be read.')
})

test('#2101: a list with nothing refused adds nothing', () => {
  assert.equal(memoryBlockedNotice({ entries: [{ scope: 'team', text: 'x' }], blocked: [] }), null)
  assert.equal(memoryBlockedNotice({ entries: [{ scope: 'team', text: 'x' }] }), null, 'a view from a host that reports no blocked scopes')
  assert.equal(memoryBlockedNotice({ entries: [] }), null)
  assert.equal(memoryBlockedNotice(undefined), null)
})
