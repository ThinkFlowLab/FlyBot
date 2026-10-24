import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { lookOf } from '../src/client/characters.js'
import { clusterOrder } from '../src/client/cluster-order.js'
import { mentionCss } from '../src/client/mention-style.js'
import { botByName, indexRoster, rosterBot } from '../src/client/sources.js'
import { linkMentions, MENTION_ORIGIN } from '../src/client/text.js'

const local = {
  id: 'chief',
  name: 'Chief',
  color: 'deepseek',
  avatar: { shape: 'whale' },
  sessionId: 'chief-now',
  parts: ['chief'],
}
const friend = {
  id: 'remote-1',
  name: 'Chief',
  color: '#ff5eb1',
  avatar: { shape: 'moon' },
  remote: { handle: '@chief.flybot98b8ecba.home' },
  // A friend's chat indexed under the local Bot's own id and current session.
  sessionId: 'chief-now',
  parts: ['chief'],
}

test('a friend chat does not take a local Bot\'s id or session in the roster index (#963)', () => {
  const roster = indexRoster({ bots: [local, friend], rooms: [], mainBotIds: ['chief'] })
  assert.equal(roster.byId.chief, local)
  assert.equal(roster.byId['chief-now'], local)
  assert.equal(roster.byId['remote-1'], friend)
  assert.equal(lookOf(roster.byId.chief).color, 'deepseek')
  assert.equal(lookOf(roster.byId.chief).shape, 'whale')
  assert.equal(lookOf(roster.byId['remote-1']).color, '#ff5eb1')
  // The friend's chat is listed first: the local Bot still owns its keys.
  const flipped = indexRoster({ bots: [friend, local], rooms: [] })
  assert.equal(flipped.byId.chief, local)
  assert.equal(flipped.byId['chief-now'], local)
})

test('a member id resolves to the local Bot when a friend shares that key (#963)', () => {
  const roster = indexRoster({ bots: [local, friend], rooms: [] })
  assert.equal(rosterBot(roster, 'chief').color, 'deepseek')
  assert.equal(rosterBot(roster, 'chief-now').avatar.shape, 'whale')
  assert.equal(rosterBot(roster, 'remote-1').id, 'remote-1')
  assert.equal(botByName(roster.bots, 'Chief').id, 'chief')
  assert.equal(botByName([friend, local], 'Chief').id, 'chief')
  assert.equal(botByName([friend], 'Chief').id, 'remote-1')
})

test('an @Name chip keeps the local Bot\'s look when a friend has the same name (#963)', () => {
  const css = mentionCss([local, friend])
  const chip = css.split('\n').filter(line => line.includes('title="@Chief"'))
  assert.ok(chip.length > 0)
  assert.ok(chip.every(line => line.includes('var(--bt-ink-deepseek)') || line.includes('whale') || !line.includes('#ff5eb1')))
  assert.equal(chip.some(line => line.includes('#ff5eb1')), false)
  assert.equal(chip.some(line => line.includes('var(--bt-ink-deepseek)')), true)
  // The friend's own mention anchor stays the friend's color.
  assert.match(css, new RegExp(`a\\[href="${MENTION_ORIGIN}remote-1"\\]\\{color:#ff5eb1`))
  assert.match(css, new RegExp(`a\\[href="${MENTION_ORIGIN}chief"\\]\\{color:var\\(--bt-ink-deepseek\\)`))
  // A name only a friend has still wears that friend's look.
  const only = mentionCss([{ id: 'h', name: 'Helper', color: '#ff5eb1', remote: { handle: '@helper.other.home' } }])
  assert.match(only, /title="@Helper"/)
  assert.match(only, /#ff5eb1/)
  // Friend listed first: the local Bot still owns the shared chip.
  const flipped = mentionCss([friend, local]).split('\n').filter(line => line.includes('title="@Chief"'))
  assert.equal(flipped.some(line => line.includes('#ff5eb1')), false)
})

test('@Chief in a bubble names the local Bot when a friend is listed first (#963)', () => {
  const linked = linkMentions('@Chief hello', [friend, local], 'someone-else')
  assert.equal(linked, `[Chief](${MENTION_ORIGIN}chief) hello`)
})

test('a friend seat does not cover the local Bot in a group icon (#963)', () => {
  const you = null
  assert.deepEqual(clusterOrder([local, you]).map(bot => bot?.id ?? 'you'), ['chief', 'you'])
  assert.deepEqual(clusterOrder([local, friend]).map(bot => bot.id), ['remote-1', 'chief'])
  const many = clusterOrder([local, { id: 'b', name: 'B' }, friend, { id: 'r2', name: 'C', remote: { handle: '@c' } }, { id: 'r3', name: 'D', remote: { handle: '@d' } }])
  assert.deepEqual(many.map(bot => bot.id), ['chief', 'b', 'remote-1', 'r2', 'r3'])
  const mark = readFileSync(new URL('../src/client/mark.js', import.meta.url), 'utf8')
  assert.match(mark, /clusterOrder\(roomAvatarPeople/)
  const client = readFileSync(new URL('../src/client/index.js', import.meta.url), 'utf8')
  assert.match(client, /mentionCss\(/)
  const cells = readFileSync(new URL('../src/client/cells.js', import.meta.url), 'utf8')
  assert.match(cells, /botByName\(roster\.bots/)
  assert.match(cells, /rosterBot\(roster, reply\.botId\)/)
})
