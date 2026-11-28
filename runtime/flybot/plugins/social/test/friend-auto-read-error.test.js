// A friend Bot's settings card reads the pair's Auto-send setting once, on mount, through
// `social/settings`. Its rejection branch was an empty function, so a read that failed left the
// checkbox at its initial `false` — drawn exactly like a setting that is off — while the switch stayed
// live: the person then reads "my Bots' replies go out without asking" as a state they chose. The
// failure is the card's answer while it lasts (the friends list and the paused card draw one the same
// way), one quiet status row, and the switch is not offered until the value is known, because a value
// nobody read is not a value to flip. A remount (reopen the card) retries; no button, no new copy.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { byMark, mount, nodes, rerender, scene, settle, textOf, unmount } from './client-harness.mjs'

const friendBot = { id: 'f1', name: 'Eve', remote: { home: '@eve.home', handle: '@eve.bot', homeName: 'Eve' } }
const settingsCard = app => mount(app, 'FriendChatSettings', { bot: friendBot })
const cardTree = (app, out) => rerender(app, 'FriendChatSettings', { bot: friendBot }, out)
const switchOf = tree => nodes(byMark(tree, 'friend-auto-send')[0] ?? {}).find(node => node?.type === 'input')

test('a settings read that fails is drawn as a failure, not as a setting', async () => {
  const s = scene({ answers: [new Error('offline')] })
  try {
    const { cleanups, out } = settingsCard(s.app)
    await settle()
    const tree = cardTree(s.app, out)
    assert.equal(byMark(tree, 'friend-auto-read-error').length, 1, 'the failed read is the card’s answer')
    unmount(cleanups)
  } finally { s.restore() }
})

test('a NETWORK failure names the reason the person can act on', async () => {
  const s = scene({ answers: [Object.assign(new Error('offline'), { code: 'NETWORK' })] })
  try {
    const { cleanups, out } = settingsCard(s.app)
    await settle()
    const tree = cardTree(s.app, out)
    assert.equal(textOf(byMark(tree, 'friend-auto-read-error')[0]), 'Could not reach FlyBot. Check that it is still running.')
    unmount(cleanups)
  } finally { s.restore() }
})

test('a setting nobody read is not offered as a switch to flip', async () => {
  const s = scene({ answers: [new Error('offline')] })
  try {
    const { cleanups, out } = settingsCard(s.app)
    await settle()
    const tree = cardTree(s.app, out)
    assert.equal(switchOf(tree).props.disabled, true, 'an unknown setting is not a checkbox')
    assert.equal(switchOf(tree).props.checked, false, 'and it claims nothing about the value')
    unmount(cleanups)
  } finally { s.restore() }
})

test('a read that says the setting is on still draws a checked, live switch', async () => {
  const s = scene({ answers: [{ autoAccept: { '@eve.home': true } }] })
  try {
    const { cleanups, out } = settingsCard(s.app)
    await settle()
    const tree = cardTree(s.app, out)
    assert.equal(switchOf(tree).props.checked, true, 'on is drawn as on')
    assert.equal(switchOf(tree).props.disabled, false, 'a value that was read is a switch to flip')
    assert.equal(byMark(tree, 'friend-auto-read-error').length, 0, 'a read that answered draws no failure')
    unmount(cleanups)
  } finally { s.restore() }
})

test('a read that says the setting is off still draws an unchecked switch', async () => {
  const s = scene({ answers: [{ autoAccept: { '@eve.home': false } }] })
  try {
    const { cleanups, out } = settingsCard(s.app)
    await settle()
    const tree = cardTree(s.app, out)
    assert.equal(switchOf(tree).props.checked, false, 'off is drawn as off')
    assert.equal(switchOf(tree).props.disabled, false, 'a value that was read is a switch to flip')
    unmount(cleanups)
  } finally { s.restore() }
})
