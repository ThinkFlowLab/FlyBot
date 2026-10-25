import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

// #1048: the writers that still change `state` inline and then `void rt.save()` must go
// through `rt.mutate(fn)` instead. A window that was read-only only because the other dsh
// had the team open takes the free lock on its next write (#1027), and that write must not
// replace what the other host left with this window's older copy (#1032): the change goes
// *after* the adopt, with every record re-resolved inside the callback.

const TEAM = {
  version: 1,
  mainBotIds: ['chief'],
  bots: { chief: { id: 'chief', sessionId: 'chief', name: 'Chief', role: 'Lead', instructions: '', createdAt: 1 } },
  rooms: {},
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  revision: 7,
}

const tempHome = (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-mutate-writers-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  return home
}

// A runtime playing the reading host: another live dsh holds the team, so this window
// loads the team and cannot change it. `takeOver` is what the other host's exit looks
// like — it saves once more, then closes, without this window having read since.
async function readingWindow(t) {
  const home = tempHome(t)
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  writeFileSync(join(home, 'state.lock'), JSON.stringify({ pid: process.ppid, host: hostname(), token: 'other' }))
  const ctx = fakeContext()
  const agents = new Map()
  let sessions = 0
  const agentFor = async (id) => {
    if (agents.has(id)) return agents.get(id)
    const agent = {
      id,
      session: { id },
      ctx: { tools: { restrict: () => {} }, effect: execute => execute() },
      followup: () => {},
    }
    agents.set(id, agent)
    return agent
  }
  Object.assign(ctx, {
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: {
      create: async () => ({ sessionId: `new${++sessions}` }),
      resolveAgent: async id => ({ agent: await agentFor(id) }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  const rt = createRuntime(ctx, { home, github: false, diagnosticsFile: false })
  t.after(() => ctx.dispose())
  await rt.load()
  assert.match(rt.readOnly(), /open in another dsh/, 'the rig starts on the reading side')

  // The other host writes a change this window has not seen, then closes.
  writeFileSync(join(home, 'state.json'), JSON.stringify({ ...TEAM, revision: 8, prefs: { theme: 'light' } }))
  rmSync(join(home, 'state.lock'))
  const saved = () => JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  return { ctx, rt, home, saved, sessionsMade: () => sessions }
}

test('#1048 delivery: a friend line written from a window that was read-only keeps what the other host left', async (t) => {
  const { rt, saved } = await readingWindow(t)

  // A friend's first line in the Bot's own chat: noteFriendLine records the contact and
  // marks the row unread, then saves — an inline writer today.
  // `flybotChecked`: the approval that let the line in; this test is about the write below it.
  await rt.deliver({ toId: 'chief', role: 'request', text: 'hi', remote: { handle: '@friend.home', name: 'Friend' }, flybotChecked: true })
  // The exchange record is the second inline writer in the same request.
  await rt.deliver({ fromId: 'chief', toId: 'chief', role: 'reply', text: 'hello back' })
  // The writers save without being awaited, so settle the write chain before reading.
  await rt.save()

  const file = saved()
  assert.equal(file.prefs.theme, 'light', 'the change the other host left survives')
  assert.equal(typeof file.remoteContacts.chief['@friend.home'], 'number', 'the first contact is written')
  assert.equal(typeof file.bots.chief.friendLineAt, 'number', 'the unread mark is written')
  assert.ok(file.exchanges.some(exchange => exchange.role === 'reply'), 'the exchange is written')
})

test('#1048 agents: adding the DSH Agent from a window that was read-only keeps what the other host left', async (t) => {
  const { rt, saved, sessionsMade } = await readingWindow(t)

  const agent = await rt.addAgent()

  const file = saved()
  assert.equal(file.prefs.theme, 'light', 'the change the other host left survives')
  assert.equal(sessionsMade(), 1, 'one Session is created for the new Agent')
  assert.deepEqual(file.agents[agent.id].sessions, ['new1'], 'the Agent and its Session are written')
  assert.equal(rt.readOnly(), undefined, 'the free lock is taken over')
})
