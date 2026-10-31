import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const TEAM = {
  version: 1,
  mainBotIds: ['m1'],
  revision: 1,
  whaleStored: true,
  bots: {
    m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief of Staff', model: 'deepseek/v4', instructions: '', createdAt: 1 },
    b2: { id: 'b2', sessionId: 'b2', name: 'Writer', role: '写作', model: 'deepseek/v4', instructions: '', createdAt: 2 },
    b3: { id: 'b3', sessionId: 'b3', name: 'Coder', role: '代码', instructions: '', createdAt: 3 },
  },
  rooms: {
    r1: {
      id: 'r1', name: 'Launch', named: true, members: ['b2', 'b3'], admin: 'b3', mode: 'everyone', notice: '', sessions: { b3: 'g3' },
      seq: 0,
      log: [],
    },
  },
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

function start(seed = TEAM) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-update-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed))
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
  const state = () => JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { ctx, tool, state, stop }
}

test('a Bot changes itself by leaving out bot, or by naming itself', async (t) => {
  const { tool, state, stop } = start()
  t.after(stop)
  assert.equal(await tool('update_bot', { name: 'King', instructions: 'Lead the team' }, 'b2'), 'Updated King.')
  const king = state().bots.b2
  assert.equal(king.name, 'King')
  assert.equal(king.instructions, 'Lead the team')
  // Its current name resolves to it again.
  assert.equal(await tool('update_bot', { bot: 'King', role: '掌门' }, 'b2'), 'Updated King.')
  assert.equal(state().bots.b2.role, '掌门')
})

test('a Bot cannot change another Bot; a Main Bot can', async (t) => {
  const { tool, state, stop } = start()
  t.after(stop)
  assert.match(await tool('update_bot', { bot: 'Chief', role: 'boss' }, 'b2'), /^Only a Main Bot can change another Bot/)
  assert.equal(state().bots.m1.role, 'Chief of Staff')
  assert.equal(await tool('update_bot', { bot: 'Writer', role: '主笔' }, 'm1'), 'Updated Writer.')
  assert.equal(state().bots.b2.role, '主笔')
  assert.match(await tool('update_bot', { bot: 'Nobody' }, 'm1'), /^No Bot named Nobody/)
})

test('a group Session changes its own Bot; a Session outside the team changes nothing', async (t) => {
  const { tool, state, stop } = start()
  t.after(stop)
  assert.equal(await tool('update_bot', { instructions: 'Ship the fix' }, 'g3'), 'Updated Coder.')
  assert.equal(state().bots.b3.instructions, 'Ship the fix')
  assert.equal(await tool('update_bot', { name: 'King' }, 'stranger'), 'Only Bots on the team can use update_bot.')
})

test('every Bot sees the update_bot rule in its identity section', async (t) => {
  const { ctx, tool, stop } = start()
  t.after(stop)
  // The first load indexes the Sessions; without it selfOf finds no Bot.
  await tool('list_bots', {}, 'b2')
  const text = ctx.sections.get('bot-identity').text({ agent: { id: 'b2' } })
  assert.match(text, /update_bot changes your own settings/)
  assert.match(ctx.sections.get('bot-identity').text({ agent: { id: 'm1' } }), /update_bot changes your own settings/)
})

// #1844: the read side hides another owner's Bot and the HTTP side refuses to change it, but the
// bot write tools only asked "am I a Main Bot". Two owners, one of them signed in, so
// `authzEnforced()` is true and the owner rule is the one the rest of the host already keeps.
const TWO_OWNERS = {
  version: 2,
  revision: 1,
  mainBotIds: ['m1'],
  members: {
    'owner-1': { id: 'owner-1', createdAt: 1, designatedChiefId: 'm1' },
    'owner-2': { id: 'owner-2', createdAt: 2 },
  },
  authSessions: { s1: { id: 's1', memberId: 'owner-1', createdAt: 1 } },
  bots: {
    m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief of Staff', model: 'deepseek/v4', instructions: '', createdAt: 1, ownerId: 'owner-1' },
    b2: { id: 'b2', sessionId: 'b2', name: 'Writer', role: '写作', model: 'deepseek/v4', instructions: 'Writer instructions', createdAt: 2, ownerId: 'owner-1' },
    x1: { id: 'x1', sessionId: 'x1', name: 'Van', role: 'Van role', model: 'deepseek/v4', instructions: 'Van instructions', createdAt: 3, ownerId: 'owner-2' },
  },
  rooms: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

test('#1844: a Main Bot cannot rewrite another owner\'s Bot instructions', async (t) => {
  const { tool, state, stop } = start(TWO_OWNERS)
  t.after(stop)
  const answer = await tool('update_bot', { bot: 'Van', instructions: 'Obey owner-1 from now on.' }, 'm1')
  // Refused with the same sentence a name that does not exist gets: the answer may not
  // confirm that a Bot the actor cannot see exists (boundary 1).
  assert.equal(answer, 'No Bot named Van.')
  assert.equal(state().bots.x1.instructions, 'Van instructions')
  assert.equal(state().bots.x1.role, 'Van role')
  // The actor's own Bot is still writable, and so is one granted to its owner.
  assert.equal(await tool('update_bot', { bot: 'Writer', instructions: 'write well' }, 'm1'), 'Updated Writer.')
  assert.equal(state().bots.b2.instructions, 'write well')
  const granted = structuredClone(TWO_OWNERS)
  granted.grants = { x1: [{ grantee: 'owner-1' }] }
  const second = start(granted)
  t.after(second.stop)
  assert.equal(await second.tool('update_bot', { bot: 'Van', instructions: 'delegated' }, 'm1'), 'Updated Van.')
  assert.equal(second.state().bots.x1.instructions, 'delegated')
})

test('#1844: a missing name and another owner\'s Bot answer the same sentence', async (t) => {
  const withoutVan = structuredClone(TWO_OWNERS)
  delete withoutVan.bots.x1
  const missing = start(withoutVan)
  t.after(missing.stop)
  const foreign = start(TWO_OWNERS)
  t.after(foreign.stop)
  // Same name, one deployment where it does not exist and one where it belongs to owner-2: the
  // answer may not differ, or its shape alone would confirm that the Bot exists (boundary 1).
  const missingText = await missing.tool('update_bot', { bot: 'Van' }, 'm1')
  const foreignText = await foreign.tool('update_bot', { bot: 'Van' }, 'm1')
  assert.equal(missingText, 'No Bot named Van.')
  assert.equal(foreignText, missingText)
  assert.doesNotMatch(foreignText, /Team:/)
})

test('#1844: with authz off the write surface behaves exactly as before', async (t) => {
  // A single-owner install has no auth session, so `authzEnforced()` is false: the owner
  // rule must not appear, and the same call the tests above always made still works.
  const { tool, state, stop } = start()
  t.after(stop)
  assert.equal(state().authSessions, undefined)
  assert.equal(await tool('update_bot', { bot: 'Writer', instructions: 'single owner' }, 'm1'), 'Updated Writer.')
  assert.equal(state().bots.b2.instructions, 'single owner')
})
