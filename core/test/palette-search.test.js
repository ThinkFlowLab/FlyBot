import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PALETTE_FILTERS, PALETTE_MESSAGE_MIN, paletteEmptyKind, paletteFilterAllows } from '../src/shared/palette-search.js'

test('the public palette filters are all, chats, messages, and commands', () => {
  assert.deepEqual(PALETTE_FILTERS, ['all', 'chats', 'messages', 'commands'])
  assert.equal(PALETTE_MESSAGE_MIN, 2)
  assert.equal(PALETTE_FILTERS.includes('artifacts'), false)
  assert.equal(PALETTE_FILTERS.includes('files'), false)
})

test('each filter keeps only kinds the palette can actually search', () => {
  assert.equal(paletteFilterAllows('all', 'chats'), true)
  assert.equal(paletteFilterAllows('all', 'messages'), true)
  assert.equal(paletteFilterAllows('chats', 'chats'), true)
  assert.equal(paletteFilterAllows('chats', 'messages'), false)
  assert.equal(paletteFilterAllows('messages', 'commands'), false)
  assert.equal(paletteFilterAllows('commands', 'commands'), true)
})

test('empty kind distinguishes a blank query, a short message query, and no matches', () => {
  assert.equal(paletteEmptyKind('', 'all'), 'empty')
  assert.equal(paletteEmptyKind('  ', 'chats'), 'empty')
  assert.equal(paletteEmptyKind('h', 'messages'), 'short')
  assert.equal(paletteEmptyKind('hi', 'messages'), 'none')
  assert.equal(paletteEmptyKind('h', 'all'), 'none')
})
