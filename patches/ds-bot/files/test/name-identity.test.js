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
import { drawnKey, nameKey } from '../src/shared/identity.js'
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

// #2879: `\p{Cf}` and `trim()` cover only part of what draws nothing. A braille blank, a Hangul
// filler and a combining grapheme joiner are neither, so a name made only of them renders as an
// empty name everywhere it is shown. Every entry point refuses it with the same sentence.
const DRAWS_NOTHING = [
  '\u2800', // BRAILLE PATTERN BLANK (So)
  '\u3164', // HANGUL FILLER (Lo, Default_Ignorable_Code_Point)
  '\u115f', // HANGUL CHOSEONG FILLER (Lo, Default_Ignorable_Code_Point)
  '\u034f', // COMBINING GRAPHEME JOINER (Mn)
  ' \u2800 ', // a blank the trim() at either end cannot see
  '\u2800\u034f', // two of them together
  '\u00a0\u2800', // a no-break space (which trim() does remove) around one it does not
]
const codePoints = name => JSON.stringify([...name].map(character => character.codePointAt(0).toString(16)))

test('#2879 a name that draws nothing is refused as empty, whichever characters hide it', () => {
  for (const name of DRAWS_NOTHING) {
    assert.equal(nameProblem(name), 'A Bot needs a name', codePoints(name))
  }
  const blank = '\u2800'
  // A name that draws something keeps the character and is still a name.
  assert.equal(nameProblem(`De${blank}v`), undefined)
  assert.equal(nameProblem('Dev\u2800'), undefined, 'a trailing blank after a drawn name is allowed')
  for (const name of ['Dev2', '新 Bot', 'De\u200bv']) assert.equal(nameProblem(name), undefined)
})

test('#2879 the create path refuses a name that draws nothing and stores none of them', async (t) => {
  const seed = TEAM()
  // No Bot draws the `De\u2800v` spelling created below: a blank beside drawn characters is a name,
  // but it may not sit next to the same drawn name (#2935).
  seed.bots.dev.name = 'Devx'
  const { rt, state } = setup(t, seed)
  await rt.load()
  for (const name of DRAWS_NOTHING) {
    await assert.rejects(rt.createBot({ name, pickModel: true }), /A Bot needs a name/, codePoints(name))
  }
  assert.deepEqual(Object.keys(state().bots).sort(), ['cafe', 'chief', 'dev', 'ops'], 'a refused create leaves no record behind')
  const created = await rt.createBot({ name: 'De\u2800v', pickModel: true })
  assert.equal(created.name, 'De\u2800v', 'a blank between two drawn characters is part of the name')
  assert.equal(state().bots[created.id].name, 'De\u2800v')
})

test('#2879 a rename to a name that draws nothing is refused, and a drawn rename still lands', async (t) => {
  const { rt, state } = setup(t)
  await rt.load()
  for (const name of DRAWS_NOTHING) {
    await assert.rejects(rt.updateBot('dev', { name }), /A Bot needs a name/, codePoints(name))
  }
  assert.equal(state().bots.dev.name, 'Dev', 'a refused rename leaves the stored name alone')
  await rt.updateBot('dev', { name: 'De\u2800vOps' })
  assert.equal(state().bots.dev.name, 'De\u2800vOps')
})

// #2935: "draws something, plus a character the screen does not draw" is still two Bots reading
// one name. `\p{Cf}` is gone before the key is built, but a combining grapheme joiner, a braille
// blank and the Hangul fillers survive it and `trim()`, so `Dev\u034f` keeps the key `dev\u034f`
// beside `dev` while both rows read `Dev` — and `@Dev` can only ever reach the key `dev`. These are
// the code points with no glyph of their own, listed one by one; a combining mark is not one of
// them, because the letter under it draws it.
const DRAWN_SAME_AS_DEV = [
  'Dev\u034f', // COMBINING GRAPHEME JOINER (Mn, zero width)
  'Dev\u2800', // BRAILLE PATTERN BLANK beside a drawn name
  'De\u3164v', // HANGUL FILLER (Default_Ignorable_Code_Point, Lo)
  'De\u115fv', // HANGUL CHOSEONG FILLER (Default_Ignorable_Code_Point, Lo)
]

test('#2935 the drawn key drops what draws nothing, and keeps a mark NFC composes', () => {
  for (const name of DRAWN_SAME_AS_DEV) assert.equal(drawnKey(name), 'dev', codePoints(name))
  assert.equal(drawnKey('Dev'), 'dev')
  // NFC runs inside `nameKey`, so an accent a canonical composition draws with its letter is part
  // of the name and not one of the characters this key removes.
  assert.equal(nameKey('Cafe\u0301'), nameKey('Caf\u00e9'))
  assert.equal(drawnKey('Cafe\u0301'), 'caf\u00e9')
  // A combining mark that does not compose is drawn with the letter it sits on, so it stays in the
  // drawn form: the vowel in these two Thai names is visible, and they are two names (#2935).
  assert.equal(drawnKey('\u0e01\u0e34'), '\u0e01\u0e34')
  assert.notEqual(drawnKey('\u0e01\u0e34'), drawnKey('\u0e01\u0e35'))
})

// The counter-control for the narrowing: the fix may refuse only names that draw the same, so a
// combining mark — which draws on its letter — must leave two names apart. A class-wide `\p{Mn}`
// strip would collapse these two onto one drawn form and refuse the second as "already exists".
test('#2935 a combining mark is drawn with its letter, so both spellings are names', async (t) => {
  const { rt, state } = setup(t)
  await rt.load()
  const first = await rt.createBot({ name: '\u0e01\u0e34', pickModel: true })
  const second = await rt.createBot({ name: '\u0e01\u0e35', pickModel: true })
  assert.equal(state().bots[first.id].name, '\u0e01\u0e34')
  assert.equal(state().bots[second.id].name, '\u0e01\u0e35', 'the vowel is drawn, so this is a second drawn name')
})

test('#2935 the create path refuses a name whose drawn form is already taken', async (t) => {
  const { rt, state, home } = setup(t)
  await rt.load()
  const before = readFileSync(join(home, 'state.json'))
  for (const name of DRAWN_SAME_AS_DEV) {
    await assert.rejects(rt.createBot({ name, pickModel: true }), /A Bot named .* already exists/, codePoints(name))
  }
  assert.deepEqual(readFileSync(join(home, 'state.json')), before, 'a refused create writes nothing')
  assert.deepEqual(Object.keys(state().bots).sort(), ['cafe', 'chief', 'dev', 'ops'], 'a refused create leaves no record behind')
})

test('#2935 the rename path refuses a drawn name that is taken, and a free drawn name lands', async (t) => {
  const { rt, state, home } = setup(t)
  await rt.load()
  const before = readFileSync(join(home, 'state.json'))
  for (const name of DRAWN_SAME_AS_DEV) {
    await assert.rejects(rt.updateBot('ops', { name }), /Name .* is not available/, codePoints(name))
  }
  assert.deepEqual(readFileSync(join(home, 'state.json')), before, 'a refused rename writes nothing')
  assert.equal(state().bots.ops.name, 'Ops', 'a refused rename leaves the stored name alone')
  await rt.updateBot('ops', { name: 'De\u2800vOps' })
  assert.equal(state().bots.ops.name, 'De\u2800vOps', 'a drawn form no Bot holds is still a name')
})

test('#2935 a drawn blank beside drawn characters is a name, and it takes that drawn form', async (t) => {
  const seed = TEAM()
  seed.bots.dev.name = 'Devx'
  const { rt, state } = setup(t, seed)
  await rt.load()
  const created = await rt.createBot({ name: 'De\u2800v', pickModel: true })
  assert.equal(state().bots[created.id].name, 'De\u2800v', 'no Bot draws De\u2800v yet, so it is created')
  // Once that row exists, its drawn form is taken: a plain `Dev` would read as the same row and
  // no `@` can tell the two apart, so it is refused from either side.
  await assert.rejects(rt.createBot({ name: 'Dev', pickModel: true }), /A Bot named Dev already exists/)
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
