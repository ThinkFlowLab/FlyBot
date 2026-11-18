// #261: the main view jumped to the Main Bot's chat on its own. When the view empties while the chat
// it held is still the Bot's current part, it goes back to that chat; only a part archived for a fresh
// one, or a view the user left, ends elsewhere. A move with no click behind it is written down.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { landingPart } from '../src/client/text.js'
import { clearClientErrors, clientErrors, noteNavigation } from '../src/client/diagnostics.js'

const chief = { id: 'chief', sessionId: 'chief-2' }
const friend = { id: 'friend', sessionId: 'friend-1', remote: { handle: '@helper.uib.home' } }
const roster = { byId: { chief, 'chief-2': chief, friend, 'friend-1': friend } }
const last = { botId: 'friend', sessionId: 'friend-1' }

test('an emptied view returns to the friend chat it held, not the Main Bot', () => {
  assert.equal(landingPart(roster, last, 'chief', { stay: true }), 'friend-1')
})

test('a part archived for a fresh one goes on in the fresh part', () => {
  const next = { ...friend, sessionId: 'friend-2' }
  assert.equal(landingPart({ byId: { friend: next, chief } }, last, 'chief', { stay: true }), 'friend-2')
  assert.equal(landingPart({ byId: { friend: next, chief } }, last, 'chief'), 'friend-2')
})

test('a blank New Session the user opened, a removed Bot, or no last chat goes to the Main Bot', () => {
  assert.equal(landingPart(roster, last, 'chief'), 'chief-2', 'not an emptied view')
  assert.equal(landingPart({ byId: { chief } }, last, 'chief', { stay: true }), 'chief-2', 'the Bot is gone and its session with it')
  assert.equal(landingPart(roster, null, 'chief', { stay: true }), 'chief-2')
  assert.equal(landingPart({ byId: {} }, null, 'chief'), 'chief', 'no roster entry for the Main Bot: its id')
})

// #261: the session list, not the roster, says whether that conversation still exists. The roster
// drops a Bot when a friend revokes the share or removes it, while the chat itself stays open.
const sessions = { byId: { 'friend-1': { id: 'friend-1' }, 'chief-2': { id: 'chief-2' } } }

test('#261: a roster that lost the Bot keeps the held chat whose session still exists', () => {
  assert.equal(landingPart({ byId: { chief } }, last, 'chief', { stay: true, sessions }), 'friend-1', 'the view emptied, the chat is still there')
  assert.equal(landingPart({ byId: { chief } }, last, 'chief', { stay: false, view: 'friend-1', sessions }), 'friend-1', 'a blank chat of that same session stays')
})

test('#261: a session that is gone, or a New Session the user opened, still goes to the Main Bot', () => {
  const gone = { byId: { 'chief-2': { id: 'chief-2' } } }
  assert.equal(landingPart({ byId: { chief } }, last, 'chief', { stay: true, sessions: gone }), 'chief-2', 'the session went with the Bot')
  assert.equal(landingPart({ byId: { chief } }, last, 'chief', { stay: false, view: 'new-1', sessions }), 'chief-2', 'a New Session is a different destination')
  assert.equal(landingPart({ byId: { chief } }, last, 'chief', { stay: false, sessions }), 'chief-2', 'no view: not a held chat')
  assert.equal(landingPart(roster, last, 'chief', { stay: true, sessions }), 'friend-1', 'with the roster intact nothing moves')
})

test('a navigation with no user activation behind it is noted, with where it went and from where; a click is not', () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const warn = console.warn
  const warned = []
  console.warn = (line) => warned.push(line)
  const withActivation = (isActive) => Object.defineProperty(globalThis, 'navigator', { value: { userActivation: { isActive } }, configurable: true })
  try {
    clearClientErrors()
    withActivation(true)
    noteNavigation('openSession', 'chief-2')
    assert.deepEqual(clientErrors(), [])
    withActivation(false)
    noteNavigation('landOn', 'chief-2', 'friend-1')
    const [entry] = clientErrors()
    assert.equal(entry.level, 'warn')
    assert.match(entry.text, /^navigation: landOn to chief-2 from friend-1 with no click \(/)
    assert.equal(warned.length, 1)
    // A browser that does not report activation is not blamed.
    Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true })
    noteNavigation('landOn', 'x')
    assert.equal(clientErrors().length, 1)
  } finally {
    console.warn = warn
    if (saved) Object.defineProperty(globalThis, 'navigator', saved)
    else delete globalThis.navigator
    clearClientErrors()
  }
})

// #1306: the landing runs from a 400 ms timer with no click behind it, and the shell throws
// synchronously on an id its session list does not know (`sessions.retain: unknown session`) —
// the two uncaught errors in the report. When the caller passes the list, a destination that
// list does not know is never returned: a fresh part the list has not caught up with falls back
// to the chat it replaced, and with nothing known there is no destination at all.
test('#1306: a destination the session list does not know is never handed to the shell', () => {
  const pending = { byId: {}, phase: 'pending' }
  assert.equal(landingPart(roster, null, 'chief', { sessions: pending }), undefined, 'a session list that has not loaded: no destination')
  assert.equal(landingPart(roster, last, 'chief', { stay: true, sessions: pending }), undefined, 'the held chat is not in the list either')
  const fresh = { ...friend, sessionId: 'friend-2' }
  const gone = { byId: { 'chief-2': { id: 'chief-2' } } }
  assert.equal(landingPart({ byId: { friend: fresh, chief } }, last, 'chief', { stay: true, sessions: gone }), 'chief-2', 'a fresh part the list has not caught up with, the chat it replaced gone: the Main Bot')
  assert.equal(landingPart({ byId: { friend: fresh, chief } }, last, 'chief', { stay: true, sessions }), 'friend-1', 'the fresh part is unknown, the chat it replaced is known: stay on that chat')
})

// #3114: a message row names the part it was said in. That part opens only when the chat owns
// it and the shell's session list holds it; a part that fails either test is not opened at all,
// and the row falls back to the chat's current part with no seek — the same turn number there
// is a different message. An id the roster does not hold keeps the id fallback it always had.
// The fix exports this, so it is resolved here: a missing export fails this case alone.
test('#3114: a named part is opened only when the chat owns it and the shell lists it', async () => {
  const { openTarget } = await import('../src/client/text.js')
  const bot = { id: 'friend', sessionId: 'friend-2', parts: ['friend-1'] }
  const at = (id, part, known = sessions) => openTarget({ byId: { ...roster.byId, friend: bot } }, known, id, part)
  assert.deepEqual(at('friend', 'friend-1'), { target: 'friend-1', seek: true }, 'a part the chat owns and the list holds')
  assert.deepEqual(at('friend', 'friend-2'), { target: 'friend-2', seek: true }, 'the part that is already open')
  assert.deepEqual(at('friend'), { target: 'friend-2', seek: true }, 'no part: the current part, as before')
  assert.deepEqual(at('friend', 'chief-2'), { target: 'friend-2', seek: false }, 'a part another chat owns: no seek')
  assert.deepEqual(at('friend', 'friend-1', { byId: {} }), { target: 'friend-2', seek: false }, 'a part the shell does not list: no seek')
  assert.deepEqual(at('gone', 'friend-1'), { target: 'gone', seek: true }, 'an id the roster does not hold')
})
