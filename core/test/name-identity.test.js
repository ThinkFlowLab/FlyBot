// #2691: one visible name is one identity. The key folds canonically equivalent spellings
// (NFC/NFD) and drops the invisible format characters a name can carry, and the guards that
// admit a Bot or a room use the same key as the lookup. Fake data in a temp home only.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { nameProblem } from '../src/shared/mentions.js'
import { normalize } from '../src/host/text.js'
import { fakeContext } from './fake-ctx.js'

const TEAM = () => ({
  version: 1,
  mainBotIds: ['chief'],
  bots: {
    chief: { id: 'chief', sessionId: 'chief', name: 'Chief', role: 'Lead', instructions: '', createdAt: 1 },
    cafe: { id: 'cafe', sessionId: 'cafe', name: 'Caf\u00e9', role: '', instructions: '', createdAt: 2 },
    dev: { id: 'dev', sessionId: 'dev', name: 'Dev', role: '', instructions: '', createdAt: 3 },
    ops: { id: 'ops', sessionId: 'ops', name: 'Ops', role: '', instructions: '', createdAt: 4 },
  },
  rooms: {
    room: {
      id: 'room', name: 'Caf\u00e9', named: true, members: ['chief', 'dev'], admin: 'chief', mode: 'everyone',
      seq: 0, log: [],
    },
  },
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  revision: 1,
})

function setup(t, seed = TEAM()) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-name-identity-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed))
  let sessions = 0
  const agents = new Map()
  const ctx = fakeContext()
  const agentFor = async (id) => {
    if (!agents.has(id)) agents.set(id, { id, session: { id, seq: 1 }, followup: () => {}, ctx: { tools: { restrict: () => () => {} }, effect: execute => execute() } })
    return agents.get(id)
  }
  Object.assign(ctx, {
    llm: {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => [{ id: 'deepseek-v4-flash' }],
      resolveModelInfo: async () => ({}),
    },
    workspaceRegistry: {
      get: () => undefined,
      resolveByPath: async () => undefined,
      create: async path => ({ id: 'w1', path }),
      archiveSession: async () => {},
    },
    sessionController: {
      create: async () => ({ sessionId: `new${++sessions}` }),
      resolveAgent: async id => ({ agent: await agentFor(id) }),
      selectModel: async () => {},
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  const rt = createRuntime(ctx, { home, github: false, diagnosticsFile: false })
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  const state = () => JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  return { ctx, rt, state, home }
}

test('#2691 the name key folds canonical spellings and drops invisible format characters', () => {
  const nfc = 'Caf\u00e9'
  const nfd = 'Cafe\u0301'
  assert.notEqual(nfc, nfd)
  assert.equal(normalize(nfd), normalize(nfc))
  // The invisible spellings a name can carry: zero-width space / non-joiner / joiner,
  // byte-order mark, soft hyphen, word joiner.
  for (const hidden of ['Dev\u200b', 'De\u200cv', 'D\u200dev', '\ufeffDev', 'Dev\u00ad', '\u2060Dev']) {
    assert.equal(normalize(hidden), 'dev', JSON.stringify([...hidden].map(c => c.codePointAt(0))))
  }
  assert.equal(normalize('  Dev\u200b '), 'dev', 'invisible characters go before trim, so the space they hid is trimmed')
  // Lowercasing can compose a new sequence (U+0130), so the NFC pass runs once more after it.
  assert.equal(normalize('\u0130lker'), normalize('i\u0307lker'))
  assert.equal(normalize(null), '')
})

test('#2691 a name of only invisible characters is refused as empty', () => {
  assert.equal(nameProblem('\u200b\u200c\u200d\ufeff\u00ad'), 'A Bot needs a name')
  assert.equal(nameProblem(' \u200b '), 'A Bot needs a name')
  // A visible name with an invisible character is a valid name; the stored name drops the character.
  assert.equal(nameProblem('Dev\u200b'), undefined)
})

test('#2691 a stored name is found by either canonical spelling or with an invisible character', async (t) => {
  const { rt } = setup(t)
  await rt.load()
  assert.equal(rt.findBot('Caf\u00e9')?.id, 'cafe')
  assert.equal(rt.findBot('Cafe\u0301')?.id, 'cafe', 'NFD spelling of the stored NFC name')
  assert.equal(rt.findBot('Dev\u200b')?.id, 'dev', 'the stored name with a zero-width space')
  assert.deepEqual(rt.findRooms('Cafe\u0301').map(room => room.id), ['room'])
})

test('#2691 a name stored before this change still resolves by its NFC spelling', async (t) => {
  const seed = TEAM()
  seed.bots.cafe.name = 'Cafe\u0301'
  seed.rooms.room.name = 'Cafe\u0301'
  const { rt, state } = setup(t, seed)
  await rt.load()
  assert.equal(rt.findBot('Caf\u00e9')?.id, 'cafe')
  assert.deepEqual(rt.findRooms('Caf\u00e9').map(room => room.id), ['room'])
  assert.equal(state().bots.cafe.name, 'Cafe\u0301', 'the stored name is left exactly as it was')
})

test('#2691 the duplicate guard refuses a second Bot and a second room with the same key', async (t) => {
  const { rt } = setup(t)
  await rt.load()
  await assert.rejects(rt.createBot({ name: 'Cafe\u0301', pickModel: true }), /already exists/)
  await assert.rejects(rt.createBot({ name: 'Dev\u200b', pickModel: true }), /already exists/)
  await assert.rejects(rt.createRoom({ name: 'Cafe\u0301', members: ['chief', 'dev'] }), /already called/)
})

test('#2691 a name is stored without the invisible characters it was written with', async (t) => {
  const { rt, state } = setup(t)
  await rt.load()
  const created = await rt.createBot({ name: 'Ne\u200bw', pickModel: true })
  assert.equal(created.name, 'New')
  assert.equal(state().bots[created.id].name, 'New')
  await rt.updateBot('dev', { name: 'Dev\u200bO\u200bps' })
  assert.equal(state().bots.dev.name, 'DevOps')
  const room = await rt.createRoom({ name: 'De\u200bsk', members: ['chief', 'dev'] })
  assert.equal(room.name, 'Desk')
  await rt.updateRoom(room.id, { name: 'Desk\u200b 2' })
  assert.equal(state().rooms[room.id].name, 'Desk 2')
})
