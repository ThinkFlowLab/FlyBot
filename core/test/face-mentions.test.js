// Who "@" calls in a face-to-face room, read from one home (#287). Home B owns "Friend"; its Chief
// is @chief.friend.home and its other Bot is Writer. Danyang's Chief lives on the other home.
import assert from 'node:assert/strict'
import test from 'node:test'
import { faceMentions } from '../src/host/face-mentions.js'
import { mentionSpans, unmatchedMentions } from '../src/shared/mentions.js'

const bots = {
  chief: { id: 'chief', name: 'Chief' },
  writer: { id: 'writer', name: '技术文档' },
}
const botOf = id => bots[id]
const room = {
  members: ['chief', 'writer'],
  participants: [
    { kind: 'bot', id: 'chief', handle: '@chief.friend.home', displayName: 'Chief', ownerName: 'Friend' },
    { kind: 'bot', id: 'writer', handle: '@writer.friend.home', displayName: '技术文档', ownerName: 'Friend' },
    { kind: 'bot', id: '@chief.danyang.home', remote: true, handle: '@chief.danyang.home', displayName: 'Chief', ownerName: 'Danyang' },
    { kind: 'bot', id: '@analyst.danyang.home', remote: true, handle: '@analyst.danyang.home', displayName: '数据分析师', ownerName: 'Danyang' },
  ],
}
const called = text => faceMentions(room, text, botOf)

test('a picker label calls the local Bot it names, however the other home drew it', () => {
  assert.deepEqual(called("@Friend's Chief 你好，你是干嘛的").bots.map(bot => bot.id), ['chief'])
  assert.deepEqual(called("@技术文档 · Friend's Bot 写一下").bots.map(bot => bot.id), ['writer'])
  assert.deepEqual(called('@技术文档 · Friend hi').bots.map(bot => bot.id), ['writer'])
  assert.deepEqual(called('@技术文档 hi').bots.map(bot => bot.id), ['writer'])
  assert.deepEqual(called('@Chief hi').bots.map(bot => bot.id), ['chief'])
})

test('a handle calls exactly that Bot, even when two homes both have a Chief', () => {
  assert.deepEqual(called('@chief.friend.home ping').bots.map(bot => bot.id), ['chief'])
  const other = called('@chief.danyang.home ping')
  assert.deepEqual(other.bots, [])
  assert.deepEqual(other.friends.map(p => p.handle), ['@chief.danyang.home'])
})

test("the other home's labels name their Bots, never a local one", () => {
  const said = called("@Danyang's Chief 你好 @数据分析师 · Danyang's Bot 看下")
  assert.deepEqual(said.bots, [])
  assert.deepEqual(said.friends.map(p => p.handle), ['@chief.danyang.home', '@analyst.danyang.home'])
  assert.deepEqual(said.unmatched, [])
})

test('@all is read as all, and an @ that names nobody is listed (code, links and addresses are not)', () => {
  assert.equal(called('@all 大家好').all, true)
  assert.deepEqual(called('hi @Nobody and @Ghost2, ok').unmatched, ['@Nobody', '@Ghost2'])
  assert.deepEqual(called('mail a@b.com or `@x` or [@y](http://z) or @').unmatched, [])
  assert.deepEqual(unmatchedMentions('@Ann hi', [{ name: 'Ann' }]), [])
  assert.deepEqual(mentionSpans('@Ann hi', [{ name: 'Ann' }]).map(span => span.start), [0])
})

test("a friend's bare @Chief is theirs when their Chief is in the room; a label or handle still calls mine", () => {
  const fromFriend = text => faceMentions(room, text, botOf, { fromFriend: true })
  assert.deepEqual(fromFriend('@Chief hi').bots, [])
  assert.deepEqual(fromFriend("@Friend's Chief hi").bots.map(bot => bot.id), ['chief'])
  assert.deepEqual(fromFriend('@chief.friend.home hi').bots.map(bot => bot.id), ['chief'])
  assert.deepEqual(fromFriend('@技术文档 hi').bots.map(bot => bot.id), ['writer'])
})
