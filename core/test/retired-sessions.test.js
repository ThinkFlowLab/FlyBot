import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

// #1453: deleting a Bot is how its owner takes the team tools away from it. The Sessions that
// the deletion empties — its own chat, its earlier parts, its group Session, and the parts of
// that group Session — must be refused every connector afterwards, also for a call already in
// flight; the refusal is decided by the team file, so a reload keeps it. A Session that never
// belonged to a Bot (the owner's own, an unknown id, no Agent at all) keeps the tools, and a
// live Bot or room holding one of those ids wins over the record of the deleted one.

const COMPOSIO = ['mcp__composio__COMPOSIO_SEARCH_TOOLS', 'mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL']
const GITHUB = ['mcp__github__create_issue', 'mcp__github__get_me']
const ALL = [...COMPOSIO, ...GITHUB]
// A room mounts github's read half only (#1234), so these two answer differently there.
const GITHUB_READ = 'mcp__github__get_me'
const GITHUB_WRITE = 'mcp__github__create_issue'
const ROOM_GITHUB = /not available in a group room \(#1234\)/
const REFUSED = /could not be determined/
const RETIRED = ['writer', 'writer-2', 'room-writer', 'room-writer-old']

// chief (Main Bot); writer with the current own chat 'writer-2' and the earlier part 'writer';
// room 'room' with the writer's group Session 'room-writer' and its earlier part
// 'room-writer-old'.
const team = () => ({
  version: 1,
  mainBotIds: ['chief'],
  bots: {
    chief: { id: 'chief', sessionId: 'chief', name: 'Chief', role: 'Lead', instructions: '', createdAt: 1 },
    writer: { id: 'writer', sessionId: 'writer-2', name: 'Writer', role: 'Write', instructions: '', createdAt: 2, segments: [{ sessionId: 'writer' }] },
  },
  rooms: {
    room: { id: 'room', name: 'Desk', members: ['chief', 'writer'], sessions: { writer: 'room-writer' }, segments: { writer: [{ sessionId: 'room-writer-old' }] }, admin: 'chief', mode: 'everyone' },
  },
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  revision: 1,
})

function context() {
  const ctx = fakeContext()
  Object.assign(ctx, {
    sessions: { get: () => undefined, flush: async () => {} },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: { create: async () => ({ sessionId: 'new1' }), resolveAgent: async id => ({ agent: { id, session: { id, header: {} } } }), selectModel: async () => {} },
    sessionTitle: { rename: async () => {} },
    llm: { listProviders: () => [] },
  })
  return ctx
}

async function open(home) {
  const ctx = context()
  const rt = createRuntime(ctx, { home, github: false, composio: false, diagnosticsFile: false })
  await rt.load()
  return { ctx, rt }
}

async function setup() {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-retired-sessions-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(team()))
  const first = await open(home)
  return { ...first, home }
}

// What the installed connector guard answers: undefined = allowed, a sentence = refused.
const reason = (guards, name, id) => guards.map(check => check({ name, agent: { id, session: { id, header: {} } } })).find(answer => answer !== undefined)

const refusal = (guards, id) => ALL.map(name => reason(guards, name, id))

test('a deleted Bot\'s own chat, its parts, its group Session and that Session\'s parts lose every connector, and the refusal survives a reload (#1453)', async (t) => {
  const { ctx, rt, home } = await setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await rt.deleteBot('writer')
  // Before the fix every one of these is undefined, so the guard reads the deleted Bot's
  // Session as a plain one and the in-flight call keeps the owner's connectors.
  for (const id of RETIRED) {
    for (const answer of refusal(ctx.guards, id)) assert.match(answer, REFUSED, id)
  }
  // The team file keeps who owned them: one entry per Session the deletion emptied, for a reload to use.
  assert.deepEqual(rt.state.retiredSessions, Object.fromEntries(RETIRED.map(id => [id, 'writer'])))
  // The refusal is the team file's, not this process's: a host that reads the saved team again refuses too.
  await ctx.dispose()
  const second = await open(home)
  t.after(async () => { await second.ctx.dispose() })
  for (const id of RETIRED) {
    for (const answer of refusal(second.ctx.guards, id)) assert.match(answer, REFUSED, id)
  }
})

test('the owner\'s own Session, an unknown id, no Agent, and a live Bot or room holding a retired id keep the connectors (#1453)', async (t) => {
  const { ctx, rt, home } = await setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await rt.deleteBot('writer')
  // This narrows the team; it must not close the owner out of their own Sessions.
  for (const id of ['plain', 'never-a-bot']) {
    for (const answer of refusal(ctx.guards, id)) assert.equal(answer, undefined, id)
  }
  for (const name of ALL) assert.equal(reason(ctx.guards, name, undefined), undefined, name)
  // A live Bot or room that holds one of those ids wins over the record of the deleted Bot.
  const ownerId = Object.keys(rt.state.members)[0]
  rt.state.bots.reader = { id: 'reader', sessionId: 'writer-2', name: 'Reader', role: 'Read', instructions: '', createdAt: 3, ownerId }
  rt.state.rooms.desk2 = { id: 'desk2', name: 'Desk 2', members: ['chief', 'reader'], sessions: { chief: 'room-writer' }, admin: 'chief', mode: 'everyone' }
  await rt.save()
  for (const answer of [...GITHUB].map(name => reason(ctx.guards, name, 'writer-2'))) assert.equal(answer, undefined, 'the live Bot\'s own chat')
  assert.equal(reason(ctx.guards, GITHUB_READ, 'room-writer'), undefined, 'the live room\'s Session keeps github\'s read tools')
  const roomWrite = reason(ctx.guards, GITHUB_WRITE, 'room-writer')
  assert.match(roomWrite, ROOM_GITHUB, 'the live room carries the #1234 read-only rule')
  assert.doesNotMatch(roomWrite, REFUSED, 'and it is not the deleted-Bot sentence')
  // The room rule (#1237) still refuses composio there, and it is that sentence — not this fix's.
  for (const answer of COMPOSIO.map(name => reason(ctx.guards, name, 'room-writer'))) assert.doesNotMatch(answer, REFUSED)
  await ctx.dispose()
  const second = await open(home)
  t.after(async () => { await second.ctx.dispose() })
  assert.deepEqual(GITHUB.map(name => reason(second.ctx.guards, name, 'writer-2')).filter(answer => answer !== undefined), [], 'the live Bot still wins after a reload')
  assert.equal(reason(second.ctx.guards, GITHUB_READ, 'room-writer'), undefined, 'the live room still wins after a reload')
  assert.match(reason(second.ctx.guards, GITHUB_WRITE, 'room-writer'), ROOM_GITHUB, 'the live room still carries the #1234 rule after a reload')
  for (const id of RETIRED.filter(id => id !== 'writer-2' && id !== 'room-writer')) {
    for (const answer of refusal(second.ctx.guards, id)) assert.match(answer, REFUSED, id)
  }
})
