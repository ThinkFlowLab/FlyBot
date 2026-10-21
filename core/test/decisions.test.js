import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const TEAM = {
  version: 1, mainBotIds: ['a'],
  bots: { a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 } },
  rooms: {}, agents: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {}, revision: 0,
}

async function boot(config = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-decisions-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  const ctx = fakeContext()
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: { create: async () => ({ sessionId: 's1' }), resolveAgent: async id => ({ agent: { session: { id }, id, status: 'idle', cancel() {} } }), selectModel: async () => {}, page: async () => ({ records: [], hasMore: false }) },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  const rt = apply(ctx, { home, ...config })
  await ctx.flybot.ready()
  const events = []
  try { ctx.flybot.on('decision', payload => events.push(payload)) } catch { /* old core without the event */ }
  const tool = (name, args, id = 'a') => ctx.registeredTools.get(name).execute(args, { agent: { id } })
  const stop = async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) }
  return { ctx, rt, home, tool, events, stop }
}

test('#396: a Bot records a decision; the host logs it and fires a feed event (opt-in)', async (t) => {
  const { home, tool, events, stop } = await boot({ decisions: true })
  t.after(stop)
  const out = await tool('record_decision', { option: 'Delete the whole repo', choice: 'rejected', why: 'destructive' })
  assert.match(out, /Recorded: rejected "Delete the whole repo" — destructive\./)
  const log = readFileSync(join(home, 'decisions.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.equal(log.length, 1)
  assert.deepEqual([log[0].option, log[0].choice, log[0].bot, log[0].botName], ['Delete the whole repo', 'rejected', 'a', 'Chief'])
  assert.deepEqual(events.map(event => [event.option, event.choice, event.why]), [['Delete the whole repo', 'rejected', 'destructive']])
})

test('#396: bad input is refused, and a secret is never logged', async (t) => {
  const { home, tool, stop } = await boot({ decisions: true })
  t.after(stop)
  assert.match(await tool('record_decision', { option: '   ', choice: 'used' }), /Write the option/)
  await assert.rejects(tool('record_decision', { option: 'x', choice: 'maybe' }))
  const key = `sk-${'abcdefghijklmnopqrstuv'}`
  assert.match(await tool('record_decision', { option: `Leak ${key}`, choice: 'used' }), /never holds a key/)
  assert.equal(existsSync(join(home, 'decisions.jsonl')), false)
})

test('#396: with the flag off the tool is not registered and nothing is written', async (t) => {
  const { ctx, home, stop } = await boot()
  t.after(stop)
  assert.equal(ctx.registeredTools.get('record_decision'), undefined)
  assert.equal(existsSync(join(home, 'decisions.jsonl')), false)
})

test('#603: record trims the log on disk, keeping the newest entries', async (t) => {
  const { home, tool, stop } = await boot({ decisions: true })
  t.after(stop)
  for (let i = 0; i <= 2_000; i++) await tool('record_decision', { option: `decision ${i}`, choice: 'used' })
  const text = readFileSync(join(home, 'decisions.jsonl'), 'utf8')
  const log = text.trim().split('\n').map(line => JSON.parse(line))
  assert.equal(log.length, 2_000)
  assert.equal(log[0].option, 'decision 1')
  assert.equal(log.at(-1).option, 'decision 2000')
  assert.ok(Buffer.byteLength(text) < 1_000_000, `file is ${Buffer.byteLength(text)} bytes`)
})

test('#603: a byte cap bounds an oversized log left by an older build', async (t) => {
  const { home, tool, stop } = await boot({ decisions: true })
  t.after(stop)
  const big = 'x'.repeat(700_000)
  writeFileSync(join(home, 'decisions.jsonl'), `${JSON.stringify({ option: big })}\n${JSON.stringify({ option: big })}\n`)
  await tool('record_decision', { option: 'after the byte cap', choice: 'used' })
  const text = readFileSync(join(home, 'decisions.jsonl'), 'utf8')
  assert.ok(Buffer.byteLength(text) <= 1_000_000, `file is ${Buffer.byteLength(text)} bytes`)
  const log = text.trim().split('\n').map(line => JSON.parse(line))
  assert.equal(log.at(-1).option, 'after the byte cap')
  assert.equal(log.length, 2)
})
