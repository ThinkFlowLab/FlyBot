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
  Object.assign(ctx, {
    llm: {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => [{ id: 'v4' }],
      resolveModelInfo: async () => ({}),
    },
    sessionController: {
      resolveAgent: async sessionId => ({ agent: { session: { id: sessionId, seq: 1 } } }),
      selectModel: async () => {},
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
    workspaceRegistry: { archiveSession: async () => {} },
  })
  apply(ctx, { home })
  const tool = (name, args, sessionId) => ctx.registeredTools.get(name).execute(args, { agent: { id: sessionId } })
  const saved = () => JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { ctx, tool, saved, stop }
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
