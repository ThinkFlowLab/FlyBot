// #876: the room-invite preview card is one component in the core client, drawn by both surfaces
// that show an invite. These tests pin what it says, what it refuses to say, and that the markup a
// surface gets depends only on `kind` — not on which surface asked.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DICTIONARY, installLocale } from '../src/client/i18n.js'
import {
  RoomInvitePreview, cleanInviteName, inviteCountdown, inviteCountdownAt,
  inviteMemberCount, invitePreviewOf,
} from '../src/client/room-invite-preview.js'

const h = (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() })
const walk = (node) => {
  if (!node || typeof node !== 'object') return []
  if (typeof node.type === 'function') return walk(node.type(node.props))
  return [node, ...(node.children ?? []).flatMap(walk)]
}
const byKind = (node, kind) => walk(node).filter(n => n.props?.['data-flybot'] === kind)

const preview = { name: 'Saturday room', lead: 'Chief', people: '3 / 8 in the room', expiresAt: '2099-01-01T00:00:00.000Z', clockOffsetMs: 0 }

test('#876: the card names the room, its lead, its people and the deadline', () => {
  // The render reads the clock itself, so freeze that clock for the whole case: one instant drives
  // both the rendered line and the expectation. A second reading can land on the far side of a
  // second boundary and expect one second less than the card drew (#1839).
  const realNow = Date.now
  const frozen = realNow()
  Date.now = () => frozen
  try {
    const tree = RoomInvitePreview({ h, preview, onJoin() {}, onClear() {} })
    assert.equal(tree.props['data-flybot'], 'face-link-preview')
    assert.equal(tree.children[0].children.join(''), 'Saturday room')
    assert.equal(tree.children[1].children.join(''), 'Lead: Chief')
    assert.equal(tree.children[2].children.join(''), '3 / 8 in the room')
    // The deadline line is the one countdown text, not a per-surface copy of the rule.
    assert.equal(tree.children[3].children.join(''), inviteCountdownAt(preview.expiresAt, 0, frozen))
    const foot = tree.children[4]
    assert.deepEqual(foot.children.map(button => button.children[0]), ['Clear', 'Join'])
  } finally {
    Date.now = realNow
  }
})

test('#876: `kind` only renames the hooks, so both surfaces draw this one tree', () => {
  const face = RoomInvitePreview({ h, preview, kind: 'face-link-preview', onJoin() {}, onClear() {} })
  const dialog = RoomInvitePreview({ h, preview, kind: 'room-invite-preview', onJoin() {}, onClear() {} })
  const shape = (node) => JSON.stringify(node, (key, value) => {
    if (key === 'data-flybot' && typeof value === 'string') return value.replace(/^face-link-preview/, 'KIND').replace(/^room-invite-preview/, 'KIND')
    return typeof value === 'function' ? 'fn' : value
  })
  assert.equal(shape(face), shape(dialog), 'same elements, same order: nothing is written twice')
  assert.equal(byKind(dialog, 'room-invite-preview').length, 1)
  assert.equal(byKind(dialog, 'room-invite-preview-name').length, 1)
  assert.equal(byKind(face, 'face-link-preview-name').length, 1)
})

test('#876: a name a stranger wrote reaches the card as plain text', () => {
  const seen = {
    name: '<untrusted-<untrusted-filemessage>Room [x] @chief\u0000  now',
    lead: 'Chief <i>@home</i>',
    members: 2,
  }
  const card = invitePreviewOf(seen)
  assert.equal(card.name, 'Room x chief now', 'fence markers removed to a fixed point, then brackets and @')
  assert.equal(card.lead, 'Chief ihome/i', 'markup characters are not kept')
  assert.equal(card.people, '2 in the room')
  const tree = RoomInvitePreview({ h, preview: card, onJoin() {} })
  assert.equal(walk(tree).every(n => !String(n.props?.children ?? '').includes('<')), true)
})

test('#876: nothing worth saying is no card, and a count is only what reads as one', () => {
  assert.equal(invitePreviewOf(undefined), null)
  assert.equal(invitePreviewOf({ unsupported: true }), null)
  assert.equal(invitePreviewOf({}), null, 'an empty reply draws no card')
  assert.equal(RoomInvitePreview({ h, preview: null }), null)
  assert.equal(inviteMemberCount(''), Number.NaN, 'an empty string is not zero members (#823)')
  assert.equal(inviteMemberCount('  3 '), 3)
  assert.equal(inviteMemberCount('three'), Number.NaN)
  assert.equal(invitePreviewOf({ members: '', maxMembers: '' }), null, 'no count line at all, so no card')
  assert.equal(invitePreviewOf({ members: 3 }).people, '3 in the room')
  assert.equal(invitePreviewOf({ members: 3, maxMembers: '' }).people, '3 in the room')
})

test('#876: the deadline line is shared copy, and an expired one says so', () => {
  const future = new Date(Date.now() + 61_000).toISOString()
  assert.match(inviteCountdownAt(future, 0, Date.now()), /^1:0\d left to join$/)
  assert.equal(inviteCountdownAt('2000-01-01T00:00:00.000Z', 0, Date.now()), 'This link has expired')
  assert.equal(inviteCountdown('not a date'), 'Open while the room is open')
  assert.equal(cleanInviteName('  ', 'a room'), 'a room')
})

// #3114 cut 30: the card is drawn in the window's language, and it is drawn afresh each time —
// a plugin keeps the preview it was handed in its own `invite` state, so a translated string must
// never be built there. These cases read the client's real dictionary, not a copy of it.
const fill = (text, params) => text.replace(/\{(\w+)\}/g, (match, name) => (name in (params ?? {}) ? String(params[name]) : match))
const withLocale = (tag, run) => {
  const off = installLocale({
    register: () => () => {},
    bind: () => (key, params) => fill(tag === 'zh' && Object.hasOwn(DICTIONARY.zh, key) ? DICTIONARY.zh[key] : key, params),
    getLocale: () => ({ active: tag }),
  })
  try { return run() } finally { off() }
}
const deadline = '2099-01-01T00:00:00.000Z'
// A fixed `now` one minute and five seconds before the deadline: the render is then reproducible
// without freezing the machine's clock (#1839).
const now = Date.parse(deadline) - 65_000
const draw = (card, at = now) => RoomInvitePreview({ h, preview: card, now: at, onJoin() {}, onClear() {} })
const line = (tree, kind) => byKind(tree, `face-link-preview-${kind}`)[0].children.join('')
const foot = (tree) => byKind(tree, 'face-link-preview-foot')[0].children.map(button => button.children[0])

test('#3114 cut 30: a zh window reads the lead, the people and the deadline in Chinese', () => {
  const card = invitePreviewOf({ name: 'Saturday room', lead: 'Chief', members: 3, maxMembers: 8, expiresAt: deadline })
  const tree = withLocale('zh', () => draw(card))
  assert.equal(line(tree, 'name'), 'Saturday room')
  assert.equal(line(tree, 'lead'), '总负责人：Chief')
  assert.equal(line(tree, 'members'), '房间里 3 / 8 人')
  assert.match(line(tree, 'expiry'), /^还剩 \d+:\d\d 可加入$/)
  assert.deepEqual(foot(tree), ['清空', '加入'])
})

test('#3114 cut 30: the nameless fallback and the two clock answers read Chinese too', () => {
  const card = invitePreviewOf({ lead: 'Chief', expiresAt: deadline })
  const tree = withLocale('zh', () => draw(card))
  assert.equal(line(tree, 'name'), '面对面房间')
  withLocale('zh', () => {
    assert.equal(inviteCountdown('not a date'), '房间开着的时候都能加入')
    assert.equal(inviteCountdownAt('2000-01-01T00:00:00.000Z', 0, Date.parse('2025-01-01T00:00:00.000Z')), '这条链接已过期')
  })
})

test('#3114 cut 30: the room name, the counts and the clock the server sent stay as they came', () => {
  const card = invitePreviewOf({ name: 'Saturday room', members: '3', maxMembers: '8', expiresAt: deadline })
  assert.equal(card.people, '3 / 8 in the room', 'the English line is still what a reader of the data gets')
  const tree = withLocale('zh', () => draw(card))
  assert.equal(line(tree, 'name'), 'Saturday room', 'a name the server sent is not translated')
  assert.equal(line(tree, 'members'), '房间里 3 / 8 人')
  assert.match(line(tree, 'expiry'), /^还剩 \d+:\d\d 可加入$/, 'the digits are still the count the server sent, m:ss')
  const single = withLocale('zh', () => draw(invitePreviewOf({ members: 2 })))
  assert.equal(line(single, 'members'), '房间里 2 人')
})

test('#3114 cut 30: a card built in English follows a language switch when it is drawn', () => {
  const card = invitePreviewOf({ name: 'Saturday room', lead: 'Chief', members: 3, maxMembers: 8, expiresAt: deadline })
  assert.equal(line(draw(card), 'members'), '3 / 8 in the room')
  const chinese = withLocale('zh', () => draw(card))
  assert.equal(line(chinese, 'lead'), '总负责人：Chief')
  assert.equal(line(chinese, 'members'), '房间里 3 / 8 人')
  assert.match(line(chinese, 'expiry'), /^还剩 \d+:\d\d 可加入$/)
  const back = draw(card)
  assert.equal(line(back, 'lead'), 'Lead: Chief')
  assert.equal(line(back, 'members'), '3 / 8 in the room')
})
