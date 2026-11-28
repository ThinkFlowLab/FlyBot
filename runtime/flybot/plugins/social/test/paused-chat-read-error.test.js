// A friend chat Bot Social paused (#404) draws a quiet card from a 5 s `social/paused` read. Its
// rejection branch was an empty function, so a read that failed printed nothing — drawn exactly like
// "this chat is not paused": a card on screen disappeared when the read failed, and one read before a
// failure stayed there quoting an answer that no longer succeeds. The failure is the card's answer
// while it lasts (the friends list draws a failed read the same way), and the 5 s poll is the retry:
// still quiet, still no buttons (owner 2026-10-19).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { byMark, mount, rerender, scene, settle, textOf, unmount } from './client-harness.mjs'

const friendBot = { id: 'f1', name: 'Pal', remote: { handle: '@pal.home' } }
const pausedAnswer = { paused: { reason: 'loop detected' } }
const pausedChat = app => mount(app, 'PausedChat', { bot: friendBot })
const cardTree = (app, out) => rerender(app, 'PausedChat', { bot: friendBot }, out)

test('a paused-chat read that fails writes one quiet error row', async () => {
  const s = scene({ answers: [new Error('offline')] })
  try {
    const { cleanups, out } = pausedChat(s.app)
    await settle()
    const tree = cardTree(s.app, out)
    assert.equal(byMark(tree, 'social-paused-error').length, 1, 'the failed read is the card’s answer')
    assert.equal(byMark(tree, 'chat-paused').length, 0, 'a failed read is not a paused chat')
    unmount(cleanups)
  } finally { s.restore() }
})

test('a NETWORK failure names the reason the person can act on', async () => {
  const s = scene({ answers: [Object.assign(new Error('offline'), { code: 'NETWORK' })] })
  try {
    const { cleanups, out } = pausedChat(s.app)
    await settle()
    const tree = cardTree(s.app, out)
    assert.equal(textOf(byMark(tree, 'social-paused-error')[0]), 'Could not reach FlyBot. Check that it is still running.')
    unmount(cleanups)
  } finally { s.restore() }
})

test('a card read before the failure is dropped when the next read fails', async () => {
  const s = scene({ answers: [pausedAnswer, new Error('offline')] })
  try {
    const { cleanups, out } = pausedChat(s.app)
    await settle()
    let tree = cardTree(s.app, out)
    assert.equal(byMark(tree, 'chat-paused').length, 1, 'the first answer draws the card')
    s.timers.tick()
    await settle()
    tree = cardTree(s.app, out)
    assert.equal(byMark(tree, 'chat-paused').length, 0, 'a stale card is not an answer')
    assert.equal(byMark(tree, 'social-paused-error').length, 1, 'the failure replaces it')
    unmount(cleanups)
  } finally { s.restore() }
})

test('the next read that succeeds clears the error and draws the card again', async () => {
  const s = scene({ answers: [new Error('offline'), pausedAnswer] })
  try {
    const { cleanups, out } = pausedChat(s.app)
    await settle()
    let tree = cardTree(s.app, out)
    assert.equal(byMark(tree, 'social-paused-error').length, 1)
    s.timers.tick()
    await settle()
    tree = cardTree(s.app, out)
    assert.equal(byMark(tree, 'chat-paused').length, 1, 'a later success draws the card')
    assert.equal(byMark(tree, 'social-paused-error').length, 0, 'and drops the error')
    unmount(cleanups)
  } finally { s.restore() }
})

test('the failed read draws no button, input or form', async () => {
  const s = scene({ answers: [new Error('offline')] })
  try {
    const { cleanups, out } = pausedChat(s.app)
    await settle()
    const tree = cardTree(s.app, out)
    const interactive = byMark(tree, 'social-paused-error')
      .flatMap(node => node.children ?? [])
      .filter(child => child?.type === 'button' || child?.type === 'input' || child?.type === 'form')
    assert.deepEqual(interactive, [], 'the quiet notice is all this state draws (owner 2026-10-19)')
    unmount(cleanups)
  } finally { s.restore() }
})
