// The pill's page effects (#803) are installed once over the main-view Session instead of
// riding the pill's own hooks, because the seat the pill sits in is one the shell hides on a
// blank Session. That makes them follow two sources that answer at different times: the
// sessions list knows the Session first, the roster names it only once it has loaded, and
// `blank` flips on that same Session when the first message arrives. A single "did the
// Session change" guard drops every one of those transitions, which is exactly the class of
// bug this split was meant to end: a friend's empty chat would never get its hint, and the
// local run stats would keep showing in a friend's chat.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { test } from 'node:test'

const { JSDOM } = createRequire(join(process.env.DSH_HARNESS, 'package.json'))('jsdom')
const { installHeaderEffects } = await import('../src/client/header-effects.js')

/** A source with the createSource shape the installer subscribes to. */
function source(initial) {
  let value = initial
  const listeners = new Set()
  return {
    getSnapshot: () => value,
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn) },
    set: (next) => { value = next; for (const fn of listeners) fn() },
  }
}

test('the header effects follow each source as it answers', () => {
  const doc = new JSDOM('<body></body>').window.document
  const sessions = source({ byId: { s1: { id: 's1', retainedBy: { mainView: 1 }, blank: true } } })
  const roster = source({ byId: {}, roomsById: {} })
  const visits = []
  const actions = {
    beginVisit: (id) => visits.push(['begin', id]),
    endVisit: (id) => visits.push(['end', id]),
  }
  const off = installHeaderEffects({ sessions, roster, actions, doc })
  assert.equal(doc.body.dataset.btFriendChat, undefined, 'nothing is a friend chat before the roster answers')

  // The roster catches up: the main view is a friend's Bot, and its chat is still empty.
  roster.set({ byId: { s1: { id: 's1', remote: true, name: 'Helper' } }, roomsById: {} })
  assert.equal(doc.body.dataset.btFriendChat, '', 'the friend-chat flag follows the roster')
  assert.equal(doc.body.dataset.btRemoteChat, 'empty', 'the empty-chat hint appears once the roster names the friend')
  assert.ok(doc.body.style.getPropertyValue('--bt-remote-empty'), 'the hint text is set')

  // The first message arrives: the same Session stops being blank.
  sessions.set({ byId: { s1: { id: 's1', retainedBy: { mainView: 1 }, blank: false } } })
  assert.equal(doc.body.dataset.btRemoteChat, undefined, 'the hint goes when the chat is no longer empty')
  assert.equal(doc.body.style.getPropertyValue('--bt-remote-empty'), '', 'the hint text goes with it')
  assert.equal(doc.body.dataset.btFriendChat, '', 'a friend chat still hides the local stats')

  // One visit per Session, however many times a source answers.
  assert.deepEqual(visits, [['begin', 's1']], 'the visit opens once, not once per source answer')
  off()
  assert.deepEqual(visits, [['begin', 's1'], ['end', 's1']], 'teardown ends the visit')
})

test('moving to another Session moves the effects, and a group chat sets the room flag', () => {
  const doc = new JSDOM('<body></body>').window.document
  const sessions = source({ byId: { s1: { id: 's1', retainedBy: { mainView: 1 }, blank: true } } })
  const roster = source({ byId: {}, roomsById: {} })
  const visits = []
  const actions = {
    beginVisit: (id) => visits.push(['begin', id]),
    endVisit: (id) => visits.push(['end', id]),
  }
  const off = installHeaderEffects({ sessions, roster, actions, doc })
  roster.set({ byId: {}, roomsById: { s1: { id: 's1', name: 'Room', origin: 'group' } } })
  assert.equal(doc.body.dataset.btRoom, '', 'a group chat sets the room flag')

  // The user opens an ordinary Bot chat: no room behind it, so the room flag goes.
  sessions.set({ byId: { s1: { id: 's1', retainedBy: {}, blank: true }, s2: { id: 's2', retainedBy: { mainView: 1 }, blank: true } } })
  roster.set({ byId: {}, roomsById: { s1: { id: 's1', name: 'Room', origin: 'group' } } })
  assert.equal(doc.body.dataset.btRoom, undefined, 'the old Session\'s room flag is gone')
  assert.deepEqual(visits, [['begin', 's1'], ['end', 's1'], ['begin', 's2']], 'the visit moved with the view')

  // And back into a face room: the flag returns, and the visit moves again.
  roster.set({ byId: {}, roomsById: { s2: { id: 's2', name: 'Face', origin: 'face-to-face' } } })
  assert.equal(doc.body.dataset.btRoom, '', 'a face room is a room too')
  off()
  assert.equal(doc.body.dataset.btRoom, undefined, 'teardown clears the last Session\'s flags')
  assert.deepEqual(visits, [['begin', 's1'], ['end', 's1'], ['begin', 's2'], ['end', 's2']], 'teardown ends the open visit')
})

test('a face room whose "@" watcher notifies the sessions source does not re-enter apply', () => {
  // Warming the trigger controller retains the Session and publishes the retention
  // synchronously, so `apply()` runs again while it is still setting up the face "@"
  // filter (#979). That re-entry used to construct a second controller, notify again
  // and run about 300 turns deep until V8 threw `RangeError: Maximum call stack size
  // exceeded` — in the UI the room's history lost the notification it was waiting on.
  const doc = new JSDOM('<body></body>').window.document
  const sessions = source({ byId: { s1: { id: 's1', retainedBy: { mainView: 1 }, blank: false } } })
  const roster = source({ byId: {}, roomsById: {} })
  let calls = 0
  const actions = {
    beginVisit: () => {},
    endVisit: () => {},
    filterFaceAtMenu: () => {
      calls += 1
      // The shape `publishRetention` has: listeners are told inside the call, before it returns.
      const snapshot = sessions.getSnapshot()
      sessions.set({ byId: { ...snapshot.byId } })
      return () => {}
    },
  }
  const off = installHeaderEffects({ sessions, roster, actions, doc })
  assert.doesNotThrow(
    () => roster.set({ byId: {}, roomsById: { s1: { id: 's1', name: 'Face', origin: 'face-to-face' } } }),
    'the retention notification must not run apply back into itself',
  )
  assert.equal(calls, 1, 'the filter is installed once for the Session, not once per notification')
  off()
})
