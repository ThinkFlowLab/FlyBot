// #876: the room-invite preview card is one component in the core client, drawn by both surfaces
// that show an invite. These tests pin what it says, what it refuses to say, and that the markup a
// surface gets depends only on `kind` — not on which surface asked.
import assert from 'node:assert/strict'
import { test } from 'node:test'
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
