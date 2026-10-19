import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatSessionReferenceMention, parseSessionReferenceText } from '@deepseek-ai/dsh-session-reference'
import { BOTS_SOURCE, CHATS_SOURCE, atSources, chatRows, mentionRows, sessionMention } from '../src/client/at-menu.js'
import { indexRoster } from '../src/client/sources.js'
import { remoteBotTitle } from '../src/shared/remote-label.js'

const roster = indexRoster({
  bots: [
    { id: 'chief', name: 'Chief', role: 'Lead', sessionId: 'chief-2', parts: ['chief'] },
    { id: 'king', name: 'King', sessionId: 'king' },
    { id: 'writer', name: 'Writer', sessionId: 'writer' },
  ],
  rooms: [{ id: 'room', name: 'Launch', members: ['chief', 'king'], parts: ['king-in-room'] }],
})
const names = rows => rows.map(row => row.bot?.name ?? 'everyone')

test('a session mention is the one DSH writes and reads back', () => {
  for (const [id, label] of [['s-1', 'Chat with King'], ['会话/ä"x', 'a ] b \\ c'], ['', '']]) {
    const mention = sessionMention(id, label)
    assert.equal(mention, formatSessionReferenceMention({ sessionId: id, label }))
    assert.deepEqual(parseSessionReferenceText(`see ${mention}`), { text: `see @${label}`, references: [{ sessionId: id, label }] })
  }
})

test('"@" in a shared room lists humans and Chiefs', () => {
  const shared = indexRoster({
    bots: [
      { id: 'chief-a', name: 'Chief A', sessionId: 'chief-a' },
      { id: 'chief-b', name: 'Chief B', sessionId: 'chief-b' },
    ],
    rooms: [{
      id: 'shared',
      name: 'War room',
      members: ['chief-a', 'chief-b'],
      participants: [
        { kind: 'human', id: 'owner-1', displayName: 'Alice', role: 'admin' },
        { kind: 'human', id: 'owner-2', displayName: 'Bob', role: 'member' },
      ],
    }],
  })
  assert.deepEqual(names(mentionRows(shared, 'shared')), ['Chief A', 'Chief B', 'Alice', 'Bob', 'everyone'])
})

test('"@" offers a group\'s members and everyone, or every other Bot in a Bot\'s chat', () => {
  assert.deepEqual(names(mentionRows(roster, 'room')), ['Chief', 'King', 'everyone'])
  assert.deepEqual(names(mentionRows(roster, 'chief-2')), ['King', 'Writer'])
  assert.deepEqual(names(mentionRows(roster, 'chief', 'wri')), ['Writer'])
  assert.deepEqual(names(mentionRows(roster, 'room', 'ev')), ['everyone'])
  assert.deepEqual(mentionRows(roster, 'room', 'k').map(row => row.text), ['@King '])
  assert.equal(mentionRows(roster, 'plain'), null)
  assert.equal(mentionRows(indexRoster({ bots: [], rooms: [] }), 'room'), null)
})

test('the chats are the other Bots\' current parts, then the latest Sessions outside the team', () => {
  const list = {
    ids: ['chief', 'chief-2', 'king', 'writer', 'room', 'king-in-room', 'old', 'new', 'child', 'blank'],
    byId: {
      king: { id: 'king', updatedAt: 5 },
      old: { id: 'old', displayTitle: 'Old work', updatedAt: 1 },
      new: { id: 'new', displayTitle: 'New work', updatedAt: 9 },
      child: { id: 'child', displayTitle: 'Child', origin: 'subagent', updatedAt: 10 },
      blank: { id: 'blank', displayTitle: 'Blank', blank: true, updatedAt: 11 },
    },
  }
  assert.deepEqual(chatRows(roster, list, 'chief-2').map(row => [row.sessionId, row.label]), [
    ['king', 'Chat with King'], ['writer', 'Chat with Writer'], ['new', 'New work'], ['old', 'Old work'],
  ])
  assert.deepEqual(chatRows(roster, list, 'room').map(row => row.sessionId), ['chief-2', 'king', 'writer', 'new', 'old'])
  assert.deepEqual(chatRows(roster, list, 'new'), [])
})

test('the chats join only the menu that "+" opened, and a pick inserts a session reference', async () => {
  let open = false
  const [bots, chats] = atSources({
    roster: { getSnapshot: () => roster },
    sessions: { list: { getSnapshot: () => ({ ids: [], byId: {} }) } },
    launched: () => open,
    iconFor: () => 'session',
  })
  assert.deepEqual([bots.name, chats.name], [BOTS_SOURCE, CHATS_SOURCE])
  assert.ok(bots.order < chats.order && chats.order < 0)
  const session = { sessionId: 'chief-2' }
  assert.deepEqual(await chats.candidates(session, { query: '' }), [])
  open = true
  const rows = await chats.candidates(session, { query: '' })
  assert.deepEqual(rows.map(row => row.name), ['King', 'Writer'])
  const picked = chats.onPick({ candidate: rows[0] })
  assert.deepEqual(picked.insert, {
    source: CHATS_SOURCE, ref: sessionMention('king', 'Chat with King'), label: 'Chat with King', appearance: 'session', clipboardText: sessionMention('king', 'Chat with King'),
  })
  assert.equal(await chats.codec.serialize(picked.insert.ref), picked.insert.ref)

  const mentions = await bots.candidates({ sessionId: 'room' }, { query: '' })
  assert.deepEqual(mentions.map(row => [row.name, row.description]), [['Chief', 'Lead'], ['King', undefined], ['Everyone', '2 members']])
  assert.deepEqual(bots.onPick({ candidate: mentions[1] }), { text: '@King ' })
  assert.deepEqual(await bots.candidates({ sessionId: 'plain' }, { query: '' }), [])
})

test('#305: a face room offers each of its Bots once, named Bot (Person), and no friend\'s Bot from outside', async () => {
  const face = indexRoster({
    self: { memberId: 'm1', displayName: 'SelfB' },
    bots: [{ id: 'chief', name: 'Chief', role: 'Chief of Staff', sessionId: 'chief' }],
    rooms: [{
      id: 'face', name: 'Face-to-face · SelfA, SelfB · 482913', origin: 'face-to-face', members: ['chief'],
      participants: [
        { kind: 'bot', id: 'chief', handle: '@chief.selfb.home', displayName: 'Chief' },
        { kind: 'bot', remote: true, id: '@chief.selfa.home', handle: '@chief.selfa.home', displayName: 'Chief', ownerName: 'SelfA' },
        // The same seat twice (a replayed join) is still one row.
        { kind: 'bot', remote: true, id: '@chief.selfa.home', handle: '@chief.selfa.home', displayName: 'Chief', ownerName: 'SelfA' },
        { kind: 'bot', remote: true, id: '@coder.gone.home', handle: '@coder.gone.home', displayName: 'Coder', ownerName: 'Gone', leftSeq: 4 },
      ],
    }],
    remoteBots: [{ handle: '@chief.selfa.home', name: 'Chief', home: '@selfa.home', owner: 'SelfA' }, { handle: '@helper.other.home', name: 'Helper', home: '@other.home' }],
  })
  const rows = mentionRows(face, 'face')
  assert.equal(rows.filter(row => row.remote).length, 0, 'no published-friend rows in a face room')
  assert.deepEqual(rows.map(row => row.bot?.label ?? 'everyone'), ['Chief (you)', 'Chief (SelfA)', 'everyone'])
  // What is inserted is still the name the room routes on, never a handle.
  assert.deepEqual(rows.map(row => row.text), ['@Chief ', '@Chief (SelfA) ', '@Everyone '])
  assert.ok(rows.every(row => !/@[\w-]+\.[\w-]+\.home/.test(row.text)))
  assert.deepEqual(mentionRows(face, 'face', 'selfa').map(row => row.text), ['@Chief (SelfA) '])

  const [bots] = atSources({
    roster: { getSnapshot: () => face },
    sessions: { list: { getSnapshot: () => ({ ids: [], byId: {} }) } },
    launched: () => false,
    iconFor: () => 'bot',
  })
  const listed = await bots.candidates({ sessionId: 'face' }, { query: '' })
  assert.deepEqual(listed.map(row => [row.name, row.description]), [
    ['Chief (you)', undefined],
    ['Chief (SelfA)', undefined],
    ['Everyone', 'Every Bot in this room'],
  ])
  // Without a member-session actor (roster.self is null) the seat's own owner name is used, as Members does.
  const legacy = indexRoster({ ...face, self: null, rooms: [{ ...face.rooms[0], participants: [{ ...face.rooms[0].participants[0], ownerName: 'SelfB' }, ...face.rooms[0].participants.slice(1)] }] })
  assert.equal(mentionRows(legacy, 'face')[0].bot.label, 'Chief (you)')
  // Outside a face room the published friends' Bots still join the menu.
  const group = indexRoster({ ...face, rooms: [{ ...face.rooms[0], origin: undefined }] })
  // A friend's Bot already seated in the group is offered once, by its seat (#384).
  assert.deepEqual(mentionRows(group, 'face').filter(row => row.remote).map(row => row.remote.handle), ['@helper.other.home'])
  // That seat is still found by its handle, the second line of its row (#384).
  assert.deepEqual(mentionRows(group, 'face', 'chief.selfa').map(row => row.text), ['@Chief (SelfA) '])
})

test('#384: a friend\'s Bot with its own chat is offered once in a Bot\'s chat, by its handle, named Bot (owner)', async () => {
  const remote = { handle: '@coder.bob.home', name: 'Coder', home: '@bob.home', owner: 'Bob', homeName: 'Family Workspace' }
  const chat = indexRoster({
    bots: [
      { id: 'chief', name: 'Chief', sessionId: 'chief' },
      { id: 'coder-chat', name: 'Coder', sessionId: 'coder-chat', remote: { ...remote, displayName: 'Coder' } },
      { id: 'helper-chat', name: 'Helper', sessionId: 'helper-chat', remote: { handle: '@helper.ann.home', displayName: 'Helper', owner: 'Ann' } },
    ],
    rooms: [],
    remoteBots: [remote],
  })
  const rows = mentionRows(chat, 'chief')
  assert.equal(rows.filter(row => (row.remote ?? row.bot?.remote)?.handle === '@coder.bob.home').length, 1)
  assert.deepEqual(rows.map(row => row.text), ['@Helper ', '@coder.bob.home '])
  const [bots] = atSources({
    roster: { getSnapshot: () => chat },
    sessions: { list: { getSnapshot: () => ({ ids: [], byId: {} }) } },
    launched: () => false,
    iconFor: () => 'bot',
  })
  const listed = await bots.candidates({ sessionId: 'chief' }, { query: '' })
  // The human owner names the Bot, not the home's label; the handle is the second line.
  assert.deepEqual(listed.slice(0, 2).map(row => [row.name, row.description]), [
    ['Helper (Ann)', '@helper.ann.home'],
    ['Coder (Bob)', '@coder.bob.home'],
  ])
  assert.equal(remoteBotTitle({ displayName: 'Coder', owner: 'Bob', homeName: 'Family Workspace' }), 'Coder (Bob)')
  assert.equal(remoteBotTitle({ displayName: 'Coder', homeName: 'Family Workspace' }), 'Coder (Family Workspace)')
})

test('#305: "Everyone" in a group counts the Bots it reaches, seated friends\' Bots too, in the right number', async () => {
  const room = (participants) => indexRoster({
    bots: [{ id: 'chief', name: 'Chief', sessionId: 'chief' }],
    rooms: [{ id: 'g', name: 'Launch', members: ['chief'], participants }],
  })
  const everyone = async (roster) => {
    const [bots] = atSources({ roster: { getSnapshot: () => roster }, sessions: { list: { getSnapshot: () => ({ ids: [], byId: {} }) } }, launched: () => false, iconFor: () => 'bot' })
    return (await bots.candidates({ sessionId: 'g' }, { query: 'every' })).find(row => row.name === 'Everyone')?.description
  }
  assert.equal(await everyone(room([{ kind: 'human', id: 'ann', displayName: 'Ann' }])), '1 member')
  assert.equal(await everyone(room([{ kind: 'bot', remote: true, id: '@coder.bob.home', handle: '@coder.bob.home', displayName: 'Coder', ownerName: 'Bob' }])), '2 members')
})
