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
  assert.equal(landingPart({ byId: { chief } }, last, 'chief', { stay: true }), 'chief-2', 'the Bot is gone')
  assert.equal(landingPart(roster, null, 'chief', { stay: true }), 'chief-2')
  assert.equal(landingPart({ byId: {} }, null, 'chief'), 'chief', 'no roster entry for the Main Bot: its id')
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
