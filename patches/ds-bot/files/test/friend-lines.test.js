import assert from 'node:assert/strict'
import { test } from 'node:test'
import { friendLineNews } from '../src/client/friend-lines.js'

const closed = () => false

test("#420: a friend's line in a Bot's chat that is not open marks that Bot unread once", () => {
  const bots = [{ id: 'a', friendLineAt: 200 }, { id: 'b' }]
  const news = friendLineNews(bots, { a: 100 }, closed)
  assert.deepEqual(news.unread, ['a'])
  assert.deepEqual(news.known, { a: 200 })
  // The same stamp again (the next pull) marks nothing: opening the chat cleared the mark.
  assert.deepEqual(friendLineNews(bots, news.known, closed).unread, [])
})

test("#420: the first friend's line a Bot ever gets is news too, once this browser keeps a record", () => {
  assert.deepEqual(friendLineNews([{ id: 'a', friendLineAt: 50 }], {}, closed).unread, ['a'])
})

test('#420: a line that arrives while its chat is on screen was seen live', () => {
  const news = friendLineNews([{ id: 'a', friendLineAt: 300 }], { a: 100 }, bot => bot.id === 'a')
  assert.deepEqual(news.unread, [])
  assert.deepEqual(news.known, { a: 300 }, 'recorded, so leaving the chat does not mark it later')
})

test('#420: a browser with no record yet takes what is there as shown', () => {
  const news = friendLineNews([{ id: 'a', friendLineAt: 300 }, { id: 'b' }], null, closed)
  assert.deepEqual(news.unread, [])
  assert.deepEqual(news.known, { a: 300 })
  assert.deepEqual(friendLineNews([{ id: 'b' }], null, closed).known, {}, 'an empty record still starts tracking')
})

test("#420: a friend's Bot chat and another member's shared Bot are not marked here", () => {
  const bots = [{ id: 'r', remote: { handle: '@x.home' }, friendLineAt: 9 }, { id: 'theirs', ownerId: 'm2', friendLineAt: 9 }, { id: 'mine', ownerId: 'm1', friendLineAt: 9 }]
  assert.deepEqual(friendLineNews(bots, {}, closed, 'm1').unread, ['mine'])
})
