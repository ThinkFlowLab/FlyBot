import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { OTHER, OWNER, SCHEDULED, combine, originOfSource, settled } from '../src/host/turn-origin.js'
import { othersInRoom, sharedWith } from '../src/host/reach.js'

// #369: whose request a Bot turn answers is read from the messages it took in. The table here is
// the whole rule; connector-access.test.js covers what the host does with it.

const bot = { id: 'writer', ownerId: 'me' }
const relay = extra => ({ kind: 'bot', form: 'relay', role: 'request', exchangeId: 'x', senderName: 'Chief', hop: 0, ...extra })

test('each kind of message has one verdict, and a stamp the host did not write is not believed', () => {
  assert.equal(originOfSource({ kind: 'user' }, bot), OWNER)
  assert.equal(originOfSource({ kind: 'user', authorId: 'me' }, bot), OWNER)
  assert.equal(originOfSource({ kind: 'user', authorId: 'ann' }, bot), OTHER)
  assert.equal(originOfSource({ kind: 'user', authorId: 'me' }, { id: 'writer' }), OTHER, 'a Bot with no known owner cannot vouch for an author')
  assert.equal(originOfSource({ kind: 'user-question-reply' }, bot), OWNER)
  assert.equal(originOfSource({ kind: 'schedule' }, bot), SCHEDULED)
  assert.equal(originOfSource(relay({ origin: 'owner' }), bot), OWNER)
  assert.equal(originOfSource(relay({ origin: 'scheduled' }), bot), SCHEDULED)
  assert.equal(originOfSource(relay({ origin: 'other' }), bot), OTHER)
  assert.equal(originOfSource(relay({}), bot), OTHER, 'no stamp: fail closed')
  assert.equal(originOfSource(relay({ origin: 'admin' }), bot), OTHER, 'an unknown stamp is no stamp')
  assert.equal(originOfSource(relay({ origin: 'owner', remote: { handle: '@bob.home' } }), bot), OTHER, 'a friend\'s message is never the owner\'s')
  assert.equal(originOfSource(relay({ origin: 'owner', form: 'remote-chat' }), bot), OTHER)
  assert.equal(originOfSource(undefined, bot), OTHER)
  assert.equal(originOfSource(null, bot), OTHER)
  // No one's request: DSH's own notices, a receipt, the note a part switch hands on.
  for (const source of [{ kind: 'tool' }, { kind: 'system-prompt' }, { kind: 'plan-mode' }, { kind: 'user-approval' }, relay({ role: 'mention' }), relay({ role: 'handoff', handoff: true })]) {
    assert.equal(originOfSource(source, bot), undefined, JSON.stringify(source))
  }
  // #626: the contexts the host and DSH inject into ordinary owner turns carry nobody's request
  // either, so they must not flip a turn to `other` (that dropped the standing grant of #608).
  for (const kind of [
    'ds-bot-time-context',
    'time-context',
    'session-reference',
    'agent-instructions',
    'model-selection',
    'working-directory',
    'ptc-mode',
    'cordis-host-runner',
    'subagent-settled',
    'compact-checkpoint',
    'skill-invocation',
  ]) {
    assert.equal(originOfSource({ kind }, bot), undefined, kind)
    assert.equal(originOfSource({ kind, form: 'snapshot' }, bot), undefined, `${kind} snapshot`)
  }
  // #626: `form` alone cannot decide this. A webhook declares `form: 'notice'` but is an outside
  // delivery, and an agent's relay or a team message carries somebody's words.
  for (const source of [
    { kind: 'webhook', form: 'notice', summary: 'push to main' },
    { kind: 'agent-message', form: 'relay' },
    { kind: 'team-message' },
  ]) {
    assert.equal(originOfSource(source, bot), OTHER, JSON.stringify(source))
  }
  // #626: a goal round continues a goal this Session already has, like a due task.
  assert.equal(originOfSource({ kind: 'goal', goalId: 'g1', revision: 1, round: 2 }, bot), SCHEDULED)
  // #620: a source kind this version does not recognise is not a no-request message: the host
  // cannot vouch for who is behind it, so it fails closed.
  assert.equal(originOfSource({ kind: 'some-future-kind' }, bot), OTHER, 'an unrecognised kind is other')
  assert.equal(originOfSource({ kind: 'some-future-kind', authorId: 'me' }, bot), OTHER, 'even one that claims an author')
  assert.equal(originOfSource({ kind: '' }, bot), OTHER)
  // A handoff that goes on with a stopped turn is that turn's request, so it carries the turn's stamp.
  assert.equal(originOfSource(relay({ role: 'handoff', handoff: true, resume: true, origin: 'owner' }), bot), OWNER)
  assert.equal(originOfSource(relay({ role: 'handoff', handoff: true, resume: true }), bot), OTHER)
})

test('a turn takes the strictest verdict of its messages, and none yields to the other', () => {
  assert.equal(combine(undefined, undefined), undefined)
  assert.equal(combine(undefined, OWNER), OWNER)
  assert.equal(combine(OTHER, undefined), OTHER)
  assert.equal(combine(OWNER, OWNER), OWNER)
  assert.equal(combine(OWNER, OTHER), OTHER)
  assert.equal(combine(OTHER, OWNER), OTHER)
  assert.equal(combine(SCHEDULED, OWNER), SCHEDULED)
  assert.equal(combine(SCHEDULED, OTHER), OTHER)
})

test('settled: the verdict that holds now, from the team as it is now', () => {
  const state = {
    bots: { writer: { id: 'writer', ownerId: 'me' }, chief: { id: 'chief', ownerId: 'me' } },
    rooms: { room: { id: 'room', members: ['writer', 'chief'], participants: [{ kind: 'human', id: 'me' }, { kind: 'bot', id: 'writer' }, { kind: 'bot', id: 'chief' }] } },
    grants: {},
  }
  const live = new Map()
  const rt = {
    live,
    botOf: id => state.bots[id],
    selfOf: id => (id === 'chat' || id === 'room-session' ? 'writer' : undefined),
    groupOwners: new Map([['room-session', { botId: 'writer', roomId: 'room' }]]),
    roomOf: id => state.rooms[id],
    sharedWith: id => sharedWith(state, id),
    othersInRoom: (room, botId) => othersInRoom(state, room, state.bots[botId]),
  }
  const running = (id, origin) => live.set(id, { turn: 1, origin })
  assert.equal(settled(rt, 'chat'), undefined, 'no turn')
  running('chat')
  assert.equal(settled(rt, 'chat'), undefined, 'a turn that took in no message with a verdict')
  running('chat', OWNER)
  assert.equal(settled(rt, 'chat'), OWNER)
  running('chat', OTHER)
  assert.equal(settled(rt, 'chat'), OTHER)
  // A Bot that is gone, or whose Session is not its own, is no one's.
  assert.equal(settled({ ...rt, botOf: () => undefined }, 'chat', { turn: 1, origin: OWNER }), OTHER)

  // Sharing the Bot does not change its owner's own chat.
  state.grants.writer = [{ id: 'g', grantee: '@bob.home', name: 'Bob' }]
  running('chat', OWNER)
  assert.equal(settled(rt, 'chat'), OWNER)
  // ...but a scheduled task on a shared Bot is not the owner's.
  running('chat', SCHEDULED)
  assert.equal(settled(rt, 'chat'), OTHER)
  delete state.grants.writer
  assert.equal(settled(rt, 'chat'), OWNER)

  // A room's turn: the owner's while nobody else is in the room.
  running('room-session', OWNER)
  assert.equal(settled(rt, 'room-session'), OWNER)
  state.rooms.room.participants.push({ kind: 'human', id: 'ann', displayName: 'Ann' })
  assert.equal(settled(rt, 'room-session'), OTHER)
  state.rooms.room.participants.at(-1).leftSeq = 3
  assert.equal(settled(rt, 'room-session'), OWNER)
  state.rooms.room.participants.push({ kind: 'bot', remote: true, id: '@bob.home', handle: '@bob.home', displayName: 'Bob' })
  assert.equal(settled(rt, 'room-session'), OTHER)
  assert.equal(settled({ ...rt, roomOf: () => undefined }, 'room-session'), OTHER, 'a room that cannot be found')
})

// #626: the no-request list is derived from DSH's `MessageSourceMap`. A new DSH version can add a
// kind, and a kind nobody listed silently takes the connector tools away mid-turn — so a bump fails
// here, where the fix is to re-read the map, instead of showing up months later as a lost tool.
test('#626: the no-request kind list is derived from the DSH version the tests run against', () => {
  const harness = new URL('../dev/harness/package.json', import.meta.url)
  const pinned = JSON.parse(readFileSync(harness, 'utf8')).dependencies['@deepseek-ai/dsh']
  assert.equal(pinned, '0.2.0-rc.2', 'DSH moved: re-read MessageSourceMap and update NOTICE_KINDS in src/host/turn-origin.js')
})
