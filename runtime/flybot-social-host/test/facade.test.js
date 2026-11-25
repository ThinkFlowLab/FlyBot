import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply as applySocial } from '../../flybot/plugins/social/index.js'
import { attachFlybot, createFlybotFacade, groupLedgerBook } from '../src/facade.js'
import { fakeContext } from '../../flybot/plugins/social/test/fake-ctx.js'

const isolatedHome = (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ot-social-facade-'))
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(() => {
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  return home
}

const stubRuntime = ({ readOnly } = {}) => {
  const state = {
    bots: {
      a: { id: 'a', name: 'Chief' },
      b: { id: 'b', name: 'Writer' },
    },
    rooms: {
      r1: { id: 'r1', name: 'Ops', members: ['a', 'b'], mode: 'admin', admin: 'a' },
    },
    prefs: {},
  }
  const updates = []
  return {
    state,
    botOf: id => state.bots[id],
    roomOf: id => state.rooms[id],
    readOnly: () => readOnly,
    updateRoom: async (id, patch) => { updates.push({ id, patch }); return patch },
    updateBot: async (id, patch) => { Object.assign(state.bots[id], patch); return state.bots[id] },
    updates,
  }
}

test('group ledger book names follow upstream 0.3.5+ group-{id}', () => {
  assert.equal(groupLedgerBook('r1'), 'group-r1')
})

test('façade lists upstream bots and rooms, with ledger book on each room', () => {
  const flybot = createFlybotFacade(stubRuntime())
  assert.deepEqual(flybot.bot.list().map(bot => bot.id), ['a', 'b'])
  assert.equal(flybot.bot.get('b').name, 'Writer')
  const rooms = flybot.rooms.list()
  assert.equal(rooms.length, 1)
  assert.equal(rooms[0].id, 'r1')
  assert.equal(rooms[0].ledgerBook, 'group-r1')
  assert.deepEqual(rooms[0].participants.map(p => p.id), ['a', 'b'])
  assert.equal(flybot.rooms.ofFace('r1').name, 'Ops')
})

test('removeParticipant for a local bot calls upstream updateRoom({ remove })', async () => {
  const rt = stubRuntime()
  const flybot = createFlybotFacade(rt)
  await flybot.rooms.removeParticipant('r1', { kind: 'bot', id: 'b', remote: false })
  assert.deepEqual(rt.updates, [{ id: 'r1', patch: { remove: ['b'] } }])
})

test('removeParticipant for a remote member does not call updateRoom', async () => {
  const rt = stubRuntime()
  rt.state.rooms.r1.remoteParticipants = [{ id: '@bob.bot', handle: '@bob.bot', name: 'Bob' }]
  const flybot = createFlybotFacade(rt)
  await flybot.rooms.removeParticipant('r1', { kind: 'bot', id: '@bob.bot', remote: true })
  assert.deepEqual(rt.updates, [])
  assert.deepEqual(rt.state.rooms.r1.remoteParticipants, [])
})

test('pluginEnabled defaults to on and can be turned off in prefs', () => {
  const rt = stubRuntime()
  assert.equal(createFlybotFacade(rt).pluginEnabled('social'), true)
  rt.state.prefs.plugins = { social: false }
  assert.equal(createFlybotFacade(rt).pluginEnabled('social'), false)
})

test('api.handle registers endpoints the social plugin can call', async () => {
  const flybot = createFlybotFacade(stubRuntime())
  flybot.api.handle('social/ping', async () => ({ ok: true }), { read: true })
  assert.deepEqual(await flybot.api.call('social/ping'), { ok: true })
})

test('@flybot/social apply() starts on the façade and registers server endpoints', async (t) => {
  const home = isolatedHome(t)
  const ctx = fakeContext()
  const flybot = attachFlybot(stubRuntime(), ctx)
  assert.equal(ctx.flybot, flybot)
  applySocial(ctx, { inboxPollMs: 0, facePollMs: 0, presence: false, onboard: false, credentialsPath: join(home, 'flybot-social.json') })
  assert.equal(typeof flybot._handlers.get('social/server')?.fn, 'function')
  assert.equal(typeof flybot._handlers.get('social/server-check')?.fn, 'function')
  assert.equal(typeof flybot._handlers.get('social/server-set')?.fn, 'function')
  const status = await flybot.api.call('social/server')
  assert.equal(typeof status, 'object')
  await ctx.dispose()
})

test('pluginEnabled false leaves social endpoints unregistered', (t) => {
  isolatedHome(t)
  const ctx = fakeContext()
  const rt = stubRuntime()
  rt.state.prefs.plugins = { social: false }
  const flybot = attachFlybot(rt, ctx)
  applySocial(ctx, { inboxPollMs: 0, onboard: false, presence: false })
  assert.equal(flybot._handlers.get('social/server'), undefined)
})

test('attachFlybot declares flybot through cordis provide when the context has it', (t) => {
  isolatedHome(t)
  const provided = []
  const ctx = {
    provide(name, value) { provided.push([name, value]); this[name] = value },
    set() { throw new Error('cannot set property "flybot" without provide') },
  }
  const flybot = attachFlybot(stubRuntime(), ctx)
  assert.equal(provided.length, 1)
  assert.equal(provided[0][0], 'flybot')
  assert.equal(provided[0][1], flybot)
  assert.equal(ctx.flybot, flybot)
})

test('bot.send.use, transports.add and tools.register are present so social can start', async () => {
  const flybot = createFlybotFacade(stubRuntime())
  const seen = []
  const offSend = flybot.bot.send.use({
    name: 'test',
    priority: 10,
    async handle(msg) {
      seen.push(msg.text)
      return { ok: true }
    },
  })
  const result = await flybot.bot.send({ text: 'hello' })
  assert.deepEqual(result, { ok: true })
  assert.deepEqual(seen, ['hello'])
  offSend()
  assert.equal(await flybot.bot.send({ text: 'later' }), undefined)
  assert.equal(typeof flybot.bot.send.priority.APPROVAL, 'number')
  assert.equal(flybot.bot.find('Writer')?.id, 'b')

  const offTransport = flybot.transports.add('bot-social', { async send() { return { id: 'x' } } })
  assert.equal(typeof flybot.transports.get('bot-social').send, 'function')
  offTransport()
  assert.equal(flybot.transports.get('bot-social'), undefined)

  const offTool = flybot.tools.register({ name: 'list_friend_bots', async execute() { return [] } })
  assert.equal(flybot.tools.list()[0].name, 'list_friend_bots')
  offTool()
  assert.equal(flybot.tools.list().length, 0)

  await flybot.grants.set('a', [{ grantee: '@bob.home' }])
  assert.equal(flybot.grants.has('a', '@bob.home'), true)
  assert.equal(flybot.bot.hasAnyGrant(), true)

  const offChat = flybot.remote.chats.onSend(async () => {})
  assert.equal(typeof offChat, 'function')
  await flybot.remote.chats.deliver({ handle: '@bob.home', text: 'hi' })
  assert.equal(flybot.remote.chats.list().at(-1).text, 'hi')
  offChat()
})
