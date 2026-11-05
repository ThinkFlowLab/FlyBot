import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DICTIONARY } from '../src/client/i18n.js'
import { LINK_REPLACED_NOTICE, announceStateLink, stateLinkNotice } from '../src/client/state-link-notice.js'

// P-556: the state answer carries the count of saves that replaced a linked `state.json`, together
// with the generation of the host process that counted them. A restarted host starts counting at 0
// again, so a count is only comparable with one from the same generation — and the first save after a
// restart can carry a smaller number than the one the window remembers, which a bare `count > known`
// would swallow (Chief, on review).

// Both orders a window can meet a restart in. (1) It polls the restarted host before the save that
// replaced a link: `{B,0}` first, then `{B,1}` — the save is said. (2) The restart and the save both
// land between two polls and the window sees `{B,1}` while it remembers `{A,2}` — that save is said
// too, which is what resetting to 0 (not to the answer's own count) buys.
test('a count from a new host process starts over and still says the save that came with it', () => {
  const afterRestart = stateLinkNotice({ stateFileLinkReplaced: { gen: 'B', count: 0 } }, { gen: 'A', count: 2 })
  assert.deepEqual(afterRestart, { seen: { gen: 'B', count: 0 }, announce: false },
    'a restarted host with no replaced link says nothing and the window forgets the old count')
  const thenSave = stateLinkNotice({ stateFileLinkReplaced: { gen: 'B', count: 1 } }, afterRestart.seen)
  assert.deepEqual(thenSave, { seen: { gen: 'B', count: 1 }, announce: true },
    'the save after the restart is said once')

  const bothAtOnce = stateLinkNotice({ stateFileLinkReplaced: { gen: 'B', count: 1 } }, { gen: 'A', count: 2 })
  assert.deepEqual(bothAtOnce, { seen: { gen: 'B', count: 1 }, announce: true },
    'a restart and its save seen in the same answer is said, not swallowed by the older, larger count')
})

test('within one host process the count is said once, and a later replaced link is news again', () => {
  const first = stateLinkNotice({ stateFileLinkReplaced: { gen: 'A', count: 1 } }, { gen: 'A', count: 0 })
  assert.deepEqual(first, { seen: { gen: 'A', count: 1 }, announce: true })
  // The next poll carries the same count: the window stays quiet and keeps what it knows.
  assert.deepEqual(stateLinkNotice({ stateFileLinkReplaced: { gen: 'A', count: 1 } }, first.seen),
    { seen: { gen: 'A', count: 1 }, announce: false })
  // A second save that replaced a link is news again.
  assert.deepEqual(stateLinkNotice({ stateFileLinkReplaced: { gen: 'A', count: 2 } }, first.seen),
    { seen: { gen: 'A', count: 2 }, announce: true })
  // An older answer from the same process never re-announces and never walks the window back.
  assert.deepEqual(stateLinkNotice({ stateFileLinkReplaced: { gen: 'A', count: 1 } }, { gen: 'A', count: 2 }),
    { seen: { gen: 'A', count: 2 }, announce: false })
})

// A window that has just loaded the page remembers nothing, and it must not replay what an older
// window already said: the count it meets is its baseline, not news (Security, on review of #2473).
test('a window with no memory takes the first count as its baseline and says nothing', () => {
  assert.deepEqual(stateLinkNotice({ stateFileLinkReplaced: { gen: 'A', count: 2 } }, null),
    { seen: { gen: 'A', count: 2 }, announce: false })
  assert.deepEqual(stateLinkNotice({ stateFileLinkReplaced: { gen: 'A', count: 2 } }, undefined),
    { seen: { gen: 'A', count: 2 }, announce: false })
  assert.deepEqual(stateLinkNotice({ stateFileLinkReplaced: { gen: 'A', count: 2 } }, { gen: '', count: 0 }),
    { seen: { gen: 'A', count: 2 }, announce: false }, 'an empty seed is no memory either')
  // From that baseline on, the ordinary same-generation rule applies again.
  assert.deepEqual(stateLinkNotice({ stateFileLinkReplaced: { gen: 'A', count: 3 } }, { gen: 'A', count: 2 }),
    { seen: { gen: 'A', count: 3 }, announce: true })
  assert.deepEqual(stateLinkNotice({ stateFileLinkReplaced: { gen: 'A', count: 2 } }, { gen: 'A', count: 2 }),
    { seen: { gen: 'A', count: 2 }, announce: false })
})

test('a host that replaced no link says nothing, and a window that knows nothing stays quiet', () => {
  assert.deepEqual(stateLinkNotice({ stateFileLinkReplaced: { gen: 'A', count: 0 } }, { gen: 'A', count: 0 }),
    { seen: { gen: 'A', count: 0 }, announce: false })
  assert.deepEqual(stateLinkNotice({ stateFileLinkReplaced: { gen: 'A', count: 0 } }, { gen: '', count: 0 }),
    { seen: { gen: 'A', count: 0 }, announce: false }, 'a first answer with nothing to say still records its generation')
  assert.deepEqual(stateLinkNotice({}, { gen: 'A', count: 1 }), { seen: { gen: 'A', count: 1 }, announce: false })
  assert.deepEqual(stateLinkNotice(undefined, { gen: 'A', count: 1 }), { seen: { gen: 'A', count: 1 }, announce: false })
})

test('junk is not a count and leaves what the window knows alone', () => {
  const known = { gen: 'A', count: 1 }
  assert.deepEqual(stateLinkNotice({ stateFileLinkReplaced: { gen: 'B', count: 'many' } }, known),
    { seen: known, announce: false })
  assert.deepEqual(stateLinkNotice({ stateFileLinkReplaced: { gen: 'B', count: -1 } }, known),
    { seen: known, announce: false })
  assert.deepEqual(stateLinkNotice({ stateFileLinkReplaced: { count: 3 } }, known),
    { seen: known, announce: false }, 'a count with no generation cannot be compared with anything')
  assert.deepEqual(stateLinkNotice({ stateFileLinkReplaced: 3 }, known),
    { seen: known, announce: false }, 'the old bare number is not a count either')
})

// The sentence a person reads is interface copy, so it lives in the dictionary with a zh entry.
test('the link-replaced notice is one dictionary line in both languages', () => {
  assert.equal(LINK_REPLACED_NOTICE, 'Saved as a separate file; the file the link pointed at was not changed.')
  assert.equal(DICTIONARY.zh[LINK_REPLACED_NOTICE], '已保存为独立文件，原链接指向的内容未改动。')
})

// P-556: the window says it once. The count is remembered between polls, and the sentence it shows
// is the dictionary line, translated where the window draws it.
test('the announce step says the sentence once and keeps the count it remembers', () => {
  const said = []
  const say = text => said.push(text)
  let seen = announceStateLink({ stateFileLinkReplaced: { gen: 'A', count: 1 } }, { gen: 'A', count: 0 }, say)
  assert.deepEqual(said, [LINK_REPLACED_NOTICE], 'the first answer says it once')
  seen = announceStateLink({ stateFileLinkReplaced: { gen: 'A', count: 1 } }, seen, say)
  assert.deepEqual(said, [LINK_REPLACED_NOTICE], 'the same count again says nothing')
  seen = announceStateLink({ stateFileLinkReplaced: { gen: 'B', count: 1 } }, seen, say)
  assert.equal(said.length, 2, 'the save after a restart is news again')
  assert.deepEqual(seen, { gen: 'B', count: 1 })
  assert.deepEqual(announceStateLink({}, seen, say), { gen: 'B', count: 1 }, 'an answer with no count keeps what the window knows')
  assert.equal(said.length, 2, 'and says nothing')
  // A window that cannot draw says nothing and still remembers, so it does not repeat later.
  assert.deepEqual(announceStateLink({ stateFileLinkReplaced: { gen: 'B', count: 2 } }, seen), { gen: 'B', count: 2 })
})
