// Integration: attach the façade to a real unmodified v0.3.6 createRuntime() host.
// Requires the DSH test harness used by upstream's own suite (see package.json test:host).
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../../ds-bot-upstream/ds-bot/index.js'
import { fakeAttachments, fakeContext } from '../../ds-bot-upstream/ds-bot/test/fake-ctx.js'
import { applyOnRuntime, groupLedgerBook } from '../index.js'

const seed = {
  version: 1,
  mainBotIds: ['a'],
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
    b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2 },
  },
  rooms: {
    r1: { id: 'r1', name: 'Ops', members: ['a', 'b'], mode: 'admin', admin: 'a', named: true, sessions: { a: 'ga', b: 'gb' }, log: [], seq: 0, seen: {} },
  },
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  prefs: {},
  revision: 0,
}

function startHost(t, { social = {}, state = seed } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ot-social-host-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(state))
  const ctx = fakeContext({ services: { attachments: fakeAttachments() } })
  ctx.set = (name, value) => {
    ctx[name] = value
  }
  const rt = createRuntime(ctx, { home, github: false, diagnosticsFile: false })
  const { flybot } = applyOnRuntime(rt, ctx, {
    inboxPollMs: 0,
    facePollMs: 0,
    presence: false,
    onboard: false,
    credentialsPath: join(home, 'flybot-social.json'),
    ...social,
  })
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })
  return { rt, ctx, flybot, home }
}

test('createRuntime v0.3.6 host lists the seeded team through the façade', (t) => {
  const { flybot } = startHost(t)
  assert.deepEqual(flybot.bot.list().map(bot => bot.id).sort(), ['a', 'b'])
  assert.equal(flybot.bot.get('a').name, 'Chief')
  const room = flybot.rooms.list().find(entry => entry.id === 'r1')
  assert.equal(room.name, 'Ops')
  assert.equal(room.ledgerBook, groupLedgerBook('r1'))
})

test('group lines written through the façade land in the upstream ledger book', async (t) => {
  const { rt, flybot } = startHost(t)
  flybot.ledger.append('r1', { seq: 1, text: 'adapter on v0.3.6' })
  assert.equal(rt.ledger.record(groupLedgerBook('r1'), 1).text, 'adapter on v0.3.6')
  await rt.ledger.flush(groupLedgerBook('r1'))
  assert.equal(flybot.ledger.records('r1').at(-1).text, 'adapter on v0.3.6')
})

test('@flybot/social registers server endpoints on the live v0.3.6 host', async (t) => {
  const { flybot } = startHost(t)
  const status = await flybot.api.call('social/server')
  assert.equal(typeof status, 'object')
  assert.equal(typeof flybot._handlers.get('social/server-check')?.fn, 'function')
  assert.equal(typeof flybot._handlers.get('social/server-set')?.fn, 'function')
})
