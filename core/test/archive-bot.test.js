import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { forestOf } from '../../plugins/tree/src/forest.js'
import { fakeContext } from './fake-ctx.js'

// #638: a Main Bot retires a Bot instead of deleting it. The tree reads
// fields['flybot-tree'].retired, so the slot is free again; the chat, its parts and its memory
// stay where they are. Deletion stays the owner's own click in the UI.

const bot = (id, name, createdAt, fields) => ({
  id, sessionId: id, name, role: `${name} role`, model: 'deepseek/v4', instructions: `${name} instructions`, createdAt,
  ...(fields ? { fields: { 'flybot-tree': fields } } : {}),
})

const team = (bots) => ({
  version: 1,
  mainBotIds: ['m1'],
  revision: 1,
  whaleStored: true,
  bots,
  rooms: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
})

const TEAM = team({
  m1: bot('m1', 'Chief', 1, { treeRole: 'root' }),
  b2: bot('b2', 'Writer', 2, { parent: 'm1' }),
  b3: bot('b3', 'Coder', 3, { parent: 'm1' }),
})

function start(state = TEAM) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-archive-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(state))
  const ctx = fakeContext()
  // A delivery to a live Bot lands on this agent; the calls it records are what proves a
  // message reached its inbox (or, for a retired Bot, that nothing was delivered at all).
  const delivered = []
  let groupSessions = 0
  const agent = sessionId => ({
    session: { id: sessionId, seq: 1, requestHeader: () => undefined },
    id: sessionId,
    delivered,
    status: 'idle',
    followup(message) { delivered.push(['followup', sessionId, message]) },
    steer(message) { delivered.push(['steer', sessionId, message]) },
    inject(message) { delivered.push(['inject', sessionId, message]) },
    cancel(cause) { delivered.push(['cancel', sessionId, cause]) },
    async whenIdle() {},
    async runMaintenance(fn) { return fn(AbortSignal.timeout(60_000)) },
    inbox: { nextStep: [], nextTurn: [], remove() {} },
    hideBlockingQuestion() {},
  })
  Object.assign(ctx, {
    llm: {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => [{ id: 'v4' }],
      resolveModelInfo: async () => ({}),
    },
    sessionController: {
      // A group's own Session id keys the room, so each creation needs its own.
      create: async () => ({ sessionId: `gs${++groupSessions}` }),
      resolveAgent: async sessionId => ({ agent: agent(sessionId) }),
      selectModel: async () => {},
      page: async () => ({ records: [], hasMore: false }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
  })
  apply(ctx, { home })
  const tool = (name, args, sessionId) => ctx.registeredTools.get(name).execute(args, { agent: { id: sessionId } })
  const saved = () => JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { ctx, tool, saved, stop, delivered }
}

test('a Main Bot archives a Bot: it leaves the team list, and its history stays readable', async (t) => {
  const { tool, saved, stop } = start()
  t.after(stop)
  assert.match(await tool('list_bots', {}, 'm1'), /- Writer/)
  assert.match(await tool('archive_bot', { bot: 'Writer', reason: 'team leaner' }, 'm1'), /^Archived Writer\./)
  const state = saved()
  // Marked retired for the tree and hidden from the default Bot list; nothing deleted.
  assert.equal(state.bots.b2.fields['flybot-tree'].retired, true)
  assert.equal(state.bots.b2.hidden, true)
  assert.equal(state.bots.b2.sessionId, 'b2')
  assert.equal(state.bots.b2.instructions, 'Writer instructions')
  assert.equal(state.bots.b2.archivedReason, 'team leaner')
  // The default Bot list no longer names it.
  const roster = await tool('list_bots', {}, 'm1')
  assert.doesNotMatch(roster, /- Writer/)
  assert.match(roster, /- Coder/)
  // Its own chat is still readable: being out of the list is not losing the history.
  const own = await tool('read_own_chat', {}, 'b2')
  assert.doesNotMatch(own, /Only Bots on the team/)
  assert.equal(typeof own, 'string')
})

test('archive frees the tree maxChildren slot the tree counts', async (t) => {
  const bots = { m1: bot('m1', 'Chief', 1, { treeRole: 'root' }) }
  for (let i = 2; i <= 9; i += 1) bots[`b${i}`] = bot(`b${i}`, `Bot ${i}`, i, { parent: 'm1' })
  const { tool, saved, stop } = start(team(bots))
  t.after(stop)
  const members = state => forestOf(Object.values(state.bots).map(record => ({ id: record.id, name: record.name, createdAt: record.createdAt, fields: record.fields ?? {} })))
  const childrenOf = state => members(state)[0].children.length
  assert.equal(childrenOf(saved()), 8, 'the tree starts at maxChildren (8)')
  assert.match(await tool('archive_bot', { bot: 'Bot 5' }, 'm1'), /^Archived Bot 5\./)
  assert.equal(childrenOf(saved()), 7, 'the retired Bot no longer counts against maxChildren')
})

// #1700: retirement took the Bot out of the tree and the default list, but the lookup the
// team tools use did not know about it, so message_bot could still wake a retired Bot.
test('#1700: a retired Bot is not addressable by any tool that resolves a Bot by name', async (t) => {
  const { tool, saved, stop, delivered } = start()
  t.after(stop)
  assert.match(await tool('archive_bot', { bot: 'Writer' }, 'm1'), /^Archived Writer\./)
  // A live group for the update_group cases, so their refusal is about the member only.
  assert.match(await tool('create_group', { members: ['Coder'], name: 'Duo' }, 'm1'), /^Created group "Duo"/)
  // The tools that resolve a Bot name through findTeamBot all refuse it.
  const answered = {
    message_bot: await tool('message_bot', { to: 'Writer', message: 'are you there?' }, 'm1'),
    stop_bot: await tool('stop_bot', { bot: 'Writer', reason: 'check' }, 'm1').then(() => 'no refusal', error => error.message),
    update_bot: await tool('update_bot', { bot: 'Writer', instructions: 'speak up' }, 'm1'),
    create_group: await tool('create_group', { members: ['Coder', 'Writer'], name: 'Trio' }, 'm1'),
    add_members: await tool('update_group', { group: 'Duo', add_members: ['Writer'] }, 'm1'),
    admin: await tool('update_group', { group: 'Duo', admin: 'Writer' }, 'm1'),
  }
  const noSuchBot = 'No Bot named Writer. Team: Chief, Coder'
  assert.deepEqual(answered, {
    message_bot: noSuchBot,
    stop_bot: noSuchBot,
    update_bot: 'No Bot named Writer.',
    create_group: noSuchBot,
    add_members: noSuchBot,
    admin: noSuchBot,
  })
  // Nothing was delivered, no turn was started, and the retired record is untouched.
  assert.deepEqual(saved().exchanges, [], 'nothing was delivered to the retired Bot')
  assert.deepEqual(delivered, [], 'no turn was started on the retired Bot')
  for (const room of Object.values(saved().rooms)) assert.ok(!room.members?.includes('b2'), 'no group gained the retired Bot')
  assert.equal(saved().bots.b2.fields['flybot-tree'].retired, true)
  assert.equal(saved().bots.b2.name, 'Writer')
  assert.equal(saved().bots.b2.instructions, 'Writer instructions')
})

test('#1700: the same tools still reach a live Bot', async (t) => {
  const { tool, saved, stop, delivered } = start()
  t.after(stop)
  assert.match(await tool('message_bot', { to: 'Coder', message: 'still there?' }, 'm1'), /^Delivered to Coder\./)
  assert.equal(saved().exchanges.length, 1)
  assert.deepEqual(delivered.map(call => call.slice(0, 2)), [['steer', 'b3']], 'the live Bot was woken')
  assert.equal(await tool('update_bot', { bot: 'Coder', role: 'Builder' }, 'm1'), 'Updated Coder.')
  assert.equal(saved().bots.b3.role, 'Builder')
  // Found, so stop_bot answers the "nothing to stop" line instead of "No Bot named".
  await assert.rejects(tool('stop_bot', { bot: 'Coder' }, 'm1'), /^Error: Coder is not running right now/)
  // A live Bot is still archived by the same tool.
  assert.match(await tool('archive_bot', { bot: 'Coder' }, 'm1'), /^Archived Coder\./)
})

test('only a Main Bot archives; a Main Bot and the caller itself are refused', async (t) => {
  const { tool, saved, stop } = start()
  t.after(stop)
  assert.equal(await tool('archive_bot', { bot: 'Writer' }, 'b3'), 'Only a Main Bot can archive another Bot.')
  assert.equal(saved().bots.b2.fields['flybot-tree'].retired, undefined)
  assert.equal(await tool('archive_bot', { bot: 'Chief' }, 'm1'), 'You cannot archive yourself.')
  assert.equal(await tool('archive_bot', { bot: 'Nobody' }, 'm1'), 'No Bot named Nobody. Team: Chief, Writer, Coder')
  // A Main Bot cannot be retired through this path; the role goes first (roster.setMain).
  const twoMains = JSON.parse(JSON.stringify(TEAM))
  twoMains.mainBotIds = ['m1', 'b3']
  const second = start(twoMains)
  t.after(second.stop)
  assert.match(await second.tool('archive_bot', { bot: 'Coder' }, 'm1'), /^Could not archive the Bot: A Main Bot cannot be archived/)
  assert.equal(second.saved().bots.b3.fields['flybot-tree'].retired, undefined)
})
