// #2699: a room line is not local. `spawnShare` fans every stored line to the room's remote seats
// (`room-membership.js` `fanoutRoomLine`), so whatever this host writes into a line is read on the
// other side. Two builders used to put this host's own detail there: the unread-image placeholder
// named the attachment's absolute path, and a crashed external process's line carried the last 200
// bytes of the child's stderr (a child that dies at startup names the file it could not open, and
// may have printed a token). What is asserted below is the decoded room-share envelope the far side
// receives — never the local log, which may keep the detail for the owner.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { install as installStore } from '../src/host/store.js'
import { install as installMemberAuth } from '../src/host/member-auth.js'
import { install as installAuthz } from '../src/host/authz.js'
import { install as installRooms } from '../src/host/room-membership.js'
import { install as installReach } from '../src/host/reach.js'
import { install as installRoster } from '../src/host/roster.js'
import { install as installGroups } from '../src/host/groups.js'
import { attachmentObjectPath, imagePlaceholder, install as installImages } from '../src/host/images.js'
import { createExternalRoomParticipant } from '../src/host/room-participant-external.js'
import { parseRoomShare } from '../src/shared/room-share.js'

// What the child could not open — it only has to look like this host's layout.
const HOST_PATH = '/data/dsh/bot/home/state.json'
const TOKEN = 'ghp_FAKE2699FAKE2699FAKE2699FAKE2699'

const TEAM = {
  version: 2,
  revision: 1,
  mainBotIds: ['chief-a'],
  members: { 'owner-1': { id: 'owner-1', createdAt: 1, designatedChiefId: 'chief-a' } },
  bots: {
    'chief-a': { id: 'chief-a', sessionId: 'chief-a', name: 'Chief A', instructions: '', createdAt: 1, ownerId: 'owner-1' },
    'chief-b': { id: 'chief-b', sessionId: 'chief-b', name: 'Chief B', instructions: '', createdAt: 2, ownerId: 'owner-1' },
    'spec-a': { id: 'spec-a', sessionId: 'spec-a', name: 'Writer A', instructions: '', createdAt: 3, ownerId: 'owner-1' },
    'spec-b': { id: 'spec-b', sessionId: 'spec-b', name: 'Writer B', instructions: '', createdAt: 4, ownerId: 'owner-1' },
  },
  rooms: {
    war: {
      id: 'war',
      name: 'War room',
      members: ['chief-a', 'chief-b'],
      admin: 'chief-a',
      named: true,
      log: [],
      seq: 0,
      seen: {},
      participants: [
        { kind: 'human', id: 'owner-1', role: 'admin', displayName: 'Alice', joinedSeq: 0, joinedAt: 1 },
        { kind: 'bot', id: 'chief-a', role: 'admin', displayName: 'Chief A', joinedSeq: 0, joinedAt: 1 },
        { kind: 'bot', id: 'chief-b', role: 'member', displayName: 'Chief B', joinedSeq: 0, joinedAt: 1 },
      ],
    },
  },
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

const CODER = { handle: '@coder.bob.home', name: 'Coder', home: '@bob.home', homeName: 'Bob', owner: 'Bob', plugin: 'social', remote: true }

function host(t, saved = TEAM) {
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-room-line-'))
  writeFileSync(join(dir, 'state.json'), typeof saved === 'string' ? saved : JSON.stringify(saved))
  const warnings = []
  const disposers = []
  const ctx = {
    logger: { warn: (...args) => warnings.push(args.join(' ')) },
    effect(execute) {
      const dispose = execute()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    on: () => () => {},
    tools: { register: () => {} },
    systemPrompt: { section: () => () => {} },
    sessions: {},
    get: () => undefined,
    set: () => {},
  }
  const sent = []
  const rt = {
    ctx,
    home: dir,
    statePath: join(dir, 'state.json'),
    autoRoomName: () => 'Room',
    retitleRoom: async () => {},
    dropGroupSession: () => {},
    warn: (...args) => warnings.push(args.join(' ')),
    flybotSend: async (msg) => { sent.push(msg); return { action: 'sent' } },
  }
  installStore(rt)
  installMemberAuth(rt)
  installAuthz(rt)
  installRooms(rt)
  installReach(rt)
  installRoster(rt)
  installGroups(rt)
  t.after(async () => {
    await Promise.all(disposers.splice(0).map(cleanup => cleanup()))
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
  })
  return { rt, sent, dir, warnings }
}

const publish = (rt, list = [CODER]) => { rt.state.flybot ??= {}; rt.state.flybot.remote = { social: list } }

async function grantToFriend(rt, botId, grantee = '@bob.home') {
  const current = rt.grantsOf?.(botId) ?? []
  if (current.some(g => g.grantee === grantee)) return
  await rt.setGrants(botId, [...current, { grantee }])
}

// A room of this home with one seat on another home, which is the surface the leak crossed.
async function withRemoteSeat(rt) {
  const room = rt.state.rooms.war
  room.participants = room.participants.filter(p => p.id !== 'chief-b')
  room.members = room.members.filter(id => id !== 'chief-b')
  publish(rt)
  await grantToFriend(rt, 'chief-a')
  await grantToFriend(rt, 'chief-b')
  const invite = await rt.createInvitation({ createdByMemberId: 'owner-1' })
  const alice = await rt.redeemInvitation(invite.token, { displayName: 'Alice' })
  const actor = await rt.authenticate(alice.sessionToken)
  await rt.addRoomParticipant('war', { kind: 'bot', remote: true, handle: '@coder.bob.home' }, actor)
  return { room, actor }
}

// The wire: the envelope the other home decodes.
const wire = (sent) => {
  const last = sent.at(-1)
  return last === undefined ? undefined : { to: last.to, ...parseRoomShare(last.text) }
}

// A room line may name a person, a Bot and an attachment; it may not name this host's folders and it
// may not carry a credential — not even one that only looks like one (#2699).
const localDetail = [
  [/(?:^|[\s("'`=:,[)])\.?\/[A-Za-z]/u, 'an absolute path'],
  [/ghp_[A-Za-z0-9]+/, 'a token-shaped string'],
  [/token=/i, 'a token assignment'],
]

function assertNoLocalDetail(text, dir, label = 'the room line') {
  for (const [pattern, what] of localDetail) {
    assert.doesNotMatch(String(text), pattern, `${label} must not carry ${what}: ${text}`)
  }
  if (dir !== undefined) assert.equal(String(text).includes(dir), false, `${label} names this home's folder: ${text}`)
}

test('#2699: an unread image in a group names the attachment and its size, never this host\'s path', async (t) => {
  const { rt, sent, dir } = host(t)
  await rt.load()
  await withRemoteSeat(rt)

  rt.config = { textOnlyModels: [] }
  rt.catalog = async () => []
  rt.defaultRef = () => undefined
  rt.ownRequest = () => false
  installImages(rt)

  // The attachment store's layout, a real file so `attachmentFilePath` would answer a path.
  const id = `sha256:${'ab'.repeat(32)}`
  const objectPath = attachmentObjectPath(rt.home, id)
  mkdirSync(join(objectPath, '..'), { recursive: true })
  writeFileSync(objectPath, 'fake-bytes')
  const attachment = { attachmentId: id, name: 'holiday.png', mediaType: 'image/png', bytes: 9 }

  const [text] = await rt.imagesForGroup([attachment], 'war')
  assert.match(text, /\[Image "holiday\.png" \(image\/png, 9 bytes\): it could not be read right now\./, 'the room still says which attachment and how big it is')
  assert.equal(text.includes(dir), false, `the group placeholder names this home: ${text}`)
  assertNoLocalDetail(text, dir, 'the group placeholder')
  // The placeholder alone never names a path, even when one is offered: only the local reader may.
  assertNoLocalDetail(imagePlaceholder(attachment, { path: objectPath, group: true }), dir, 'the group form with a path')

  sent.length = 0
  await rt.fanoutRoomLine(rt.state.rooms.war, { seq: 1, who: 'Alice', text, authorKind: 'human', authorId: 'owner-1' })
  const out = wire(sent)
  assert.equal(out?.to, '@coder.bob.home', 'the line still reaches the far side')
  assertNoLocalDetail(out.text, dir, "the friend's Bot")
  assert.match(out.text, /holiday\.png/)

  // The reader that is this host may still be told where the bytes are (#779): a Bot chat keeps it.
  const local = imagePlaceholder(attachment, { path: objectPath })
  assert.ok(local.includes(`"${objectPath}"`), local)
})

test('#2699: a crashed external Bot reports how it ended, and keeps its stderr in this host\'s log', async (t) => {
  const { rt, sent, dir, warnings } = host(t)
  await rt.load()
  await withRemoteSeat(rt)

  const lines = []
  const realExternalRoomLine = rt.externalRoomLine
  rt.externalRoomLine = async (room, line) => {
    const stored = await realExternalRoomLine(room, line)
    lines.push(stored)
    return stored
  }

  const room = rt.state.rooms.war
  // A child that dies at startup: it names a file it could not open and prints a token-shaped string.
  const CRASH = `process.stderr.write(${JSON.stringify(`Error: ENOENT: no such file or directory, open '${HOST_PATH}' token=${TOKEN}\n`)});setTimeout(() => process.exit(1), 10)`
  const member = { id: 'chief-a', name: 'Chief A', external: { driver: 'subprocess', command: [process.execPath, '-e', CRASH], cwd: rt.home } }
  const participant = createExternalRoomParticipant(rt)
  t.after(() => participant.close())
  await participant.open({ room, member })

  for (let i = 0; i < 60 && lines.length === 0; i += 1) await new Promise(r => setTimeout(r, 50))
  assert.equal(lines.length, 1, 'one crash line for the room')
  const line = lines[0].text
  assert.match(line, /crashed/, line)
  assert.match(line, /\(exit 1\)/, `the room reads how the process ended: ${line}`)
  assertNoLocalDetail(line, dir, 'the crash line')

  const out = wire(sent)
  assert.equal(out?.to, '@coder.bob.home')
  assertNoLocalDetail(out.text, dir, "the friend's Bot")
  assert.match(out.text, /crashed/)

  // The diagnosis stays where the owner can read it and the far side cannot.
  const logged = warnings.join('\n')
  assert.ok(logged.includes(HOST_PATH), `the local log keeps the crash detail: ${logged}`)
  assert.ok(logged.includes(TOKEN), 'the local log keeps what the child printed')
})

test('#2699: a process that cannot start says so to this host, not the room', async (t) => {
  const { rt, sent, dir, warnings } = host(t)
  await rt.load()
  await withRemoteSeat(rt)

  const lines = []
  const realExternalRoomLine = rt.externalRoomLine
  rt.externalRoomLine = async (room, line) => {
    const stored = await realExternalRoomLine(room, line)
    lines.push(stored)
    return stored
  }

  const room = rt.state.rooms.war
  const command = join(dir, 'gone', 'agent-2699')
  const member = { id: 'chief-a', name: 'Chief A', external: { driver: 'subprocess', command: [command] } }
  const participant = createExternalRoomParticipant(rt)
  t.after(() => participant.close())
  await participant.open({ room, member })

  for (let i = 0; i < 60 && lines.length === 0; i += 1) await new Promise(r => setTimeout(r, 50))
  assert.equal(lines.length, 1, 'the room hears that it crashed')
  assertNoLocalDetail(lines[0].text, dir, 'the crash line')
  assert.equal(wire(sent)?.to, '@coder.bob.home')
  assertNoLocalDetail(wire(sent).text, dir, "the friend's Bot")
  assert.ok(warnings.join('\n').includes(command), 'this host\'s log names the path that could not be started')
})

// The one seam every stored room line passes, whichever writer made it (#1251): whatever the host
// redacts must not survive into the log or the wire. `rt.redactSecrets` is what `secrets.js` installs
// (`redactSecrets: text => redact(text)`); this fixture answers with the same shape.
test('#2699: every stored room line goes through the host redactor, whichever writer made it', async (t) => {
  const { rt, sent } = host(t)
  await rt.load()
  const { room, actor } = await withRemoteSeat(rt)
  rt.redactSecrets = text => String(text).replace(/ghp_[A-Za-z0-9]+/g, '[secret:GITHUB_TOKEN]')

  sent.length = 0
  await rt.postRoomMessage('war', { text: `the deploy key is ${TOKEN}, keep it out of the room` }, actor)

  const stored = (room.log ?? []).at(-1)
  assert.match(stored.text, /\[secret:GITHUB_TOKEN\]/, `the stored line is redacted: ${stored.text}`)
  assert.equal(stored.text.includes(TOKEN), false, stored.text)
  const out = wire(sent)
  assert.equal(out?.to, '@coder.bob.home')
  assert.match(out.text, /\[secret:GITHUB_TOKEN\]/, out.text)
  assert.equal(out.text.includes(TOKEN), false, "the friend's Bot never reads the value")
})
