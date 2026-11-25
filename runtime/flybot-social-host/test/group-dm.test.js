import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { install, bookFile, parseBook } from '../../ds-bot-upstream/ds-bot/src/host/ledger.js'
import { createFlybotFacade, groupLedgerBook } from '../src/facade.js'

const host = (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ot-group-dm-'))
  const state = {
    bots: { a: { id: 'a', name: 'Chief', isMain: true } },
    rooms: { r1: { id: 'r1', name: 'Ops', members: ['a'] } },
    prefs: {},
  }
  const rt = { home, state, botOf: id => state.bots[id], roomOf: id => state.rooms[id], warn() {} }
  install(rt)
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  return { rt, home, flybot: createFlybotFacade(rt) }
}

test('group notices, human and remote lines land on the upstream ledger with rising seq', async (t) => {
  const { rt, home, flybot } = host(t)
  const notice = flybot.rooms.postNotice('r1', 'Alice joined')
  const human = flybot.rooms.postHuman('r1', { authorId: 'a', name: 'Chief', text: 'hello group' })
  const remote = flybot.rooms.postRemote('r1', { handle: '@bob.bot', name: 'Bob', text: 'hi back' })
  assert.equal(notice.seq, 1)
  assert.equal(human.seq, 2)
  assert.equal(remote.seq, 3)
  assert.equal(await flybot.rooms.takeLineSeq('r1'), 4)
  await rt.ledger.flush(groupLedgerBook('r1'))
  const records = parseBook(readFileSync(join(home, 'ledger', bookFile(groupLedgerBook('r1'))), 'utf8'))
  assert.deepEqual(records.map(row => row.text), ['Alice joined', 'hello group', 'hi back'])
  assert.equal(records[0].authorKind, 'system')
  assert.equal(records[1].authorKind, 'human')
  assert.equal(records[2].remote, true)
})

test('upsertFace hosts a face-to-face room; applyFaceLine is idempotent; dropFace leaves it', async (t) => {
  const { flybot } = host(t)
  const room = await flybot.rooms.upsertFace({
    roomId: 'face-1',
    name: 'Standup',
    status: 'open',
    joinCode: '123456',
    localBots: [{ id: 'a' }],
    members: [{ handle: '@sam.bot', displayName: 'Sam' }],
  })
  assert.equal(room.origin, 'face-to-face')
  assert.equal(room.face.roomId, 'face-1')
  assert.equal(room.face.status, 'open')
  assert.equal(room.joinCode, '123456')
  assert.equal(flybot.rooms.ofFace('face-1').id, room.id)
  assert.ok(room.participants.some(p => p.handle === '@sam.bot' && p.remote === true))
  assert.ok(room.members.includes('a'))

  const line = { eventId: 'evt-1', text: 'first', authorKind: 'human' }
  assert.equal(flybot.rooms.applyFaceLine(room.id, line).eventId, 'evt-1')
  assert.equal(flybot.rooms.applyFaceLine(room.id, line), undefined)

  const again = await flybot.rooms.upsertFace({ roomId: 'face-1', status: 'open', name: 'Standup (live)' })
  assert.equal(again.id, room.id)
  assert.equal(again.name, 'Standup (live)')

  const dropped = await flybot.rooms.dropFace(room.id)
  assert.equal(dropped.face.status, 'left')
  assert.equal(flybot.rooms.ofFace('face-1').face.status, 'left')
})

test('onFaceLine receives local human posts; a DM deliver is listed; publish stores remotes', async (t) => {
  const { flybot } = host(t)
  const seen = []
  const off = flybot.rooms.onFaceLine((room, line, extra) => {
    seen.push({ roomId: room.id, text: line.text, mentions: extra.mentions })
  })
  flybot.rooms.postHuman('r1', { text: 'ping @bob', mentions: ['@bob.bot'] })
  assert.equal(seen[0].text, 'ping @bob')
  assert.deepEqual(seen[0].mentions, ['@bob.bot'])
  off()
  flybot.rooms.postHuman('r1', { text: 'no listener' })
  assert.equal(seen.length, 1)

  flybot.remote.publish([{ handle: '@bob.bot', name: 'Bob' }])
  assert.equal(flybot.remote.publish()[0].handle, '@bob.bot')
  await flybot.remote.chats.deliver({ handle: '@bob.bot', text: 'dm hello' })
  assert.equal(flybot.remote.chats.list().at(-1).text, 'dm hello')
})

test('approvals providers, watched, and invite hooks are callable', async (t) => {
  const { flybot } = host(t)
  const changes = []
  const off = flybot.approvals.onChange((kind) => changes.push(kind))
  flybot.roomApprovals.setProvider((room) => room ? [{ id: 'r-hold' }] : [])
  flybot.chatApprovals.setProvider((bot) => bot ? [{ id: 'c-hold' }] : [])
  assert.equal(flybot.roomApprovals.of({ id: 'r1' })[0].id, 'r-hold')
  assert.equal(flybot.chatApprovals.of({ id: 'a' })[0].id, 'c-hold')
  flybot.chatApprovals.changed()
  flybot.roomApprovals.changed()
  assert.deepEqual(changes, ['chat', 'room'])
  off()
  assert.equal(flybot.watched(), false)
  flybot.setWatched(true)
  assert.equal(flybot.watched(), true)
  const offInvites = flybot.rooms.serveInvites({ mint: async () => ({ ticket: 't' }) })
  assert.equal(typeof offInvites, 'function')
  await flybot.rooms.seatOpenClaims()
  assert.deepEqual(flybot.rooms.ticketPeers(), [])
  offInvites()
})

test('read-only façade does not post group lines or upsert face rooms', async (t) => {
  const { rt } = host(t)
  rt.readOnly = () => 'another window holds this team'
  const flybot = createFlybotFacade(rt)
  assert.equal(flybot.rooms.postNotice('r1', 'nope'), undefined)
  assert.equal(await flybot.rooms.upsertFace({ roomId: 'face-x', name: 'Nope' }), undefined)
  assert.equal(await flybot.rooms.takeLineSeq('r1'), undefined)
})
