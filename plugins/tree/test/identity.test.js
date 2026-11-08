// #2692: the tree ships as its own package, so it cannot import core/src/shared/identity.js. Its
// copy of the name key and the core's must answer the same for every spelling, or one sibling name
// would be one identity inside the tree and another in the roster it creates the child through.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { nameKey } from '../src/identity.js'
import { nameKey as coreKey } from '../../../core/src/shared/identity.js'

// The two spellings of one visible name, a lower that composes (U+0130), and the format characters
// `trim()` keeps: every one of them has to key the same in both copies.
const CASES = [
  'Caf\u00e9', 'Cafe\u0301', 'CAF\u00c9', ' Cafe\u0301 ', 'Caf\u00e9\u200b', '\u200bCaf\u00e9',
  '\u0130lker', 'i\u0307lker', '\uac00', '\u1100\u1161', '\u1100\u1161\u11a8', '\uac01',
  '', '  ', '\ufeffDev', 'Dev',
]

test('#2692 the plugin name key and core/src/shared/identity.js agree', () => {
  for (const value of CASES) assert.equal(nameKey(value), coreKey(value), JSON.stringify(value))
  // The cases that must be one identity are one, and the ones that must not are not.
  assert.equal(nameKey('Cafe\u0301'), nameKey('Caf\u00e9'))
  assert.equal(nameKey('\u1100\u1161'), nameKey('\uac00'))
  assert.notEqual(nameKey('Dev'), nameKey('Ops'))
})
