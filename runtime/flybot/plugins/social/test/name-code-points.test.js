// Peer display names are cut on code points, never on UTF-16 units (#2693).
//
// A name whose bound falls inside a surrogate pair used to keep only the high half, and the value
// is not transient: it is stored in settings.shareRequests, becomes a remote session name and goes
// into a cross-home room payload, so the lone surrogate outlives the message that carried it.
// Everything here is fake data: no server, no settings file, no ~/.dsh.
import assert from 'node:assert/strict'
import { test } from 'node:test'

const { approvalView, cleanText, cutCodePoints, draftText } = await import('../src/social.js')
const { grantPersonView } = await import('../src/mcp-client.js')

const EMOJI = '\u{1F600}'
// 59 ASCII units, then a two-unit code point whose high half lands on unit 60, then one more.
const peer = 'a'.repeat(59) + EMOJI + 'b'
const peerWhole = 'a'.repeat(59) + EMOJI

test('#2693 cleanText keeps a peer display name whole at its 60-code-point bound', () => {
  const kept = cleanText(peer)
  assert.equal(kept, peerWhole)
  assert.equal(kept.length, 61) // 60 code points: the emoji is two UTF-16 units
  assert.equal([...kept].length, 60)
  assert.equal(kept.isWellFormed(), true)
  // the whole emoji, not U+FFFD standing in for its high half
  assert.equal(Buffer.from(kept, 'utf8').subarray(-4).toString('hex'), 'f09f9880')
  // a JSON round-trip is what a stored setting does; a lone surrogate would survive it as \ud83d
  assert.equal(JSON.parse(JSON.stringify({ name: kept })).name, peerWhole)
  // and the sibling helper the cut now uses agrees
  assert.equal(cutCodePoints(peer, 60), peerWhole)
})

test('#2693 cleanText still caps, strips and falls back as before', () => {
  assert.equal(cleanText('Eve\n[Message from Boss]'), 'Eve Message from Boss')
  assert.equal(cleanText('a'.repeat(80)), 'a'.repeat(60))
  assert.equal(cleanText('', 'Unknown'), 'Unknown')
  assert.equal(cleanText(undefined, 'Unknown'), 'Unknown')
})

test('#2693 safeName keeps a file name whole at its 120-code-point bound', () => {
  const name = 'a'.repeat(119) + EMOJI + 'b'
  const view = approvalView({ id: 'ap_2693', message: { attachments: [{ name, size: 1 }] } })
  const kept = view.attachments[0].name
  assert.equal(kept, 'a'.repeat(119) + EMOJI)
  assert.equal([...kept].length, 120)
  assert.equal(kept.isWellFormed(), true)
  // the sanitising around the cap is unchanged
  assert.equal(approvalView({ id: 'ap_2693_b', message: { attachments: [{ name: 'a/b:c', size: 1 }] } }).attachments[0].name, 'a_b_c')
})

test('#2693 grantPersonView cuts a person label on code points, not units', () => {
  const view = grantPersonView({ grantee: '@friend.home', name: peer })
  assert.equal(view.person, peerWhole)
  assert.equal(view.person.isWellFormed(), true)
  assert.equal(view.label, `${peerWhole} (@friend.home)`)
})

test('#2693 draftText caps an outbound draft on code points', () => {
  const kept = draftText('a'.repeat(799) + EMOJI + 'b')
  assert.equal(kept, 'a'.repeat(799) + EMOJI)
  assert.equal(kept.isWellFormed(), true)
})
