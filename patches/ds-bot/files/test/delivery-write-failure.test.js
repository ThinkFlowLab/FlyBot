import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

// #1096: the two writes in `deliver()` sit *before* the agent has the line — the friend-line mark
// in `noteFriendLine` and the exchange record — so a write that fails there decides whether a
// message exists at all. A failed write must be visible, not fatal: the line still reaches the
// agent and exactly one warning names what could not be recorded.

const TEAM = {
  version: 1,
  mainBotIds: ['chief'],
  bots: { chief: { id: 'chief', sessionId: 'chief', name: 'Chief', role: 'Lead', instructions: '', createdAt: 1 } },
  rooms: {},
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  prefs: {},
  revision: 7,
}

// A loaded runtime whose agent records what it is handed, plus the warn lines the store prints.
async function rig(t) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-delivery-write-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  const ctx = fakeContext()
  const sent = new Map()
  const agentFor = async (id) => {
    if (!sent.has(id)) {
      const calls = []
      sent.set(id, calls)
      const agent = {
        id,
        session: { id },
        ctx: { tools: { restrict: () => {} }, effect: execute => execute() },
        followup: message => calls.push(['followup', message]),
        steer: message => calls.push(['steer', message]),
      }
      return agent
    }
    const calls = sent.get(id)
    return {
      id,
      session: { id },
      ctx: { tools: { restrict: () => {} }, effect: execute => execute() },
      followup: message => calls.push(['followup', message]),
      steer: message => calls.push(['steer', message]),
    }
  }
  Object.assign(ctx, {
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: { create: async () => ({ sessionId: 'new1' }), resolveAgent: async id => ({ agent: await agentFor(id) }) },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  const rt = createRuntime(ctx, { home, github: false, diagnosticsFile: false })
  t.after(() => ctx.dispose())
  await rt.load()
  const said = []
  ctx.logger.warn = (format, line) => said.push(line)
  // Every write fails, as it does when the lock was taken away (ELOCKLOST) or the disk refuses.
  rt.mutate = async () => { throw Object.assign(new Error('ELOCKLOST: the other dsh holds the team'), { code: 'ELOCKLOST' }) }
  return { rt, said, sent }
}

const textOf = message => (message?.content ?? []).map(block => block.text ?? '').join('\n')

test('#1096: a friend line whose write fails still reaches the Bot, with one warning', async (t) => {
  const { rt, said, sent } = await rig(t)

  await rt.deliver({ toId: 'chief', role: 'post', text: 'hello from Friend', remote: { handle: '@friend.home', name: 'Friend' }, flybotChecked: true })

  const calls = sent.get('chief') ?? []
  assert.equal(calls.length, 1, 'the line is handed to the agent instead of being dropped')
  assert.match(textOf(calls[0][1]), /hello from Friend/)
  assert.equal(said.length, 1, 'exactly one warning, not two and not none')
  assert.match(said[0], /the first line from @friend\.home was not recorded/)
  assert.match(said[0], /ELOCKLOST/)
})

test('#1096: an exchange whose write fails still reaches the Bot, with one warning', async (t) => {
  const { rt, said, sent } = await rig(t)

  await rt.deliver({ fromId: 'chief', toId: 'chief', role: 'reply', text: 'hello back' })

  const calls = sent.get('chief') ?? []
  assert.equal(calls.length, 1, 'the exchange still reaches the agent')
  assert.match(textOf(calls[0][1]), /hello back/)
  assert.equal(said.length, 1, 'exactly one warning for the failed record')
  assert.match(said[0], /the reply exchange was not recorded/)
  assert.match(said[0], /ELOCKLOST/)
})
