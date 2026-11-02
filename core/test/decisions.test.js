import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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

test('#1912: an option cut at an emoji boundary stays well formed in the log', async (t) => {
  const { home, tool, stop } = await boot({ decisions: true })
  t.after(stop)
  // The 200-unit cut lands inside the emoji, so a code-unit slice stores half a surrogate pair.
  const option = `${'a'.repeat(199)}😀tail`
  await tool('record_decision', { option, choice: 'used' })
  const text = readFileSync(join(home, 'decisions.jsonl'), 'utf8')
  const [entry] = text.trim().split('\n').map(line => JSON.parse(line))
  assert.equal(entry.option.isWellFormed(), true, `the stored option must stay well formed, got: ${JSON.stringify(entry.option.slice(-4))}`)
  assert.equal(entry.option.length <= 200, true, `the stored option must stay within 200 units, got ${entry.option.length}`)
  assert.equal(option.startsWith(entry.option), true, 'the stored option must be a prefix of the recorded one')
})

// The log is one leaf file beside the home, so a link there is not a place to write: the rule the
// journal keeps (#2074) and the memory side record keeps (#2079). A refusal drops the line, warns
// once, and tells the Bot it was not recorded rather than claiming a line that is not on disk.
test('a linked decision log is refused, not written through', async (t) => {
  const { ctx, home, tool, events, stop } = await boot({ decisions: true })
  t.after(stop)
  const elsewhere = mkdtempSync(join(tmpdir(), 'ds-bot-decisions-target-'))
  t.after(() => rmSync(elsewhere, { recursive: true, force: true, maxRetries: 5 }))
  const target = join(elsewhere, 'decisions.jsonl')
  const before = 'PRE-EXISTING LINE\n'
  writeFileSync(target, before)
  const leaf = join(home, 'decisions.jsonl')
  symlinkSync(target, leaf)

  const warnings = []
  ctx.logger.warn = (...args) => warnings.push(args.join(' '))
  const first = await tool('record_decision', { option: 'Keep the link', choice: 'rejected' })
  const second = await tool('record_decision', { option: 'Keep it again', choice: 'used' })
  assert.equal(readFileSync(target, 'utf8'), before, 'the file behind the link is not written through')
  assert.equal(lstatSync(leaf).isSymbolicLink(), true, 'the link is still the leaf')
  assert.equal(readlinkSync(leaf), target)
  assert.match(first, /Not recorded/, 'the Bot is told the decision is not on disk')
  assert.match(second, /Not recorded/)
  assert.equal(warnings.length, 1, 'one warning, not one for every refused record')
  assert.match(warnings[0], /not a plain file/)
  assert.deepEqual(events, [], 'a decision that is not on disk is not announced on the feed')

  // A real leaf afterwards: the refusal is about this file, not a latch that stops the log.
  rmSync(leaf)
  assert.match(await tool('record_decision', { option: 'Write it now', choice: 'used' }), /^Recorded:/)
  assert.equal(readFileSync(leaf, 'utf8').trim().split('\n').length, 1)
})

// Housekeeping writes a temp name beside the log and renames it over the log, so the temp name is a
// place this code writes (#2103). A link left there must be refused before the write, not taken:
// otherwise the retained log is written through it and the log itself becomes a link.
test('#2103: a linked temp name does not take the trim; the log stays a plain file', async (t) => {
  const line = (n) => `${JSON.stringify({ time: 1_000 + n, bot: 'a', botName: 'Chief', option: `kept ${n}`, choice: 'used' })}\n`
  const full = (n) => Array.from({ length: n }, (_, i) => line(i)).join('')

  const { ctx, home, tool, stop } = await boot({ decisions: true })
  t.after(stop)
  const elsewhere = mkdtempSync(join(tmpdir(), 'ds-bot-decisions-tmp-target-'))
  t.after(() => rmSync(elsewhere, { recursive: true, force: true, maxRetries: 5 }))
  const target = join(elsewhere, 'outside.txt')
  const before = 'PRE-EXISTING BYTES\n'
  writeFileSync(target, before)
  const log = join(home, 'decisions.jsonl')
  writeFileSync(log, full(2_000))
  symlinkSync(target, `${log}.tmp`)

  const warnings = []
  ctx.logger.warn = (...args) => warnings.push(args.join(' '))
  const first = await tool('record_decision', { option: 'Trigger the trim', choice: 'used' })
  const second = await tool('record_decision', { option: 'Trigger it again', choice: 'rejected' })

  assert.equal(readFileSync(target, 'utf8'), before, 'the file behind the temp link is not written through')
  assert.equal(lstatSync(log).isSymbolicLink(), false, 'the log is still a plain file, not the link')
  const lines = readFileSync(log, 'utf8').split('\n').filter(Boolean)
  assert.equal(lines.length, 2_002, 'the refused trim leaves the log as it was, plus the two new lines')
  for (const lineText of lines) assert.doesNotThrow(() => JSON.parse(lineText), 'every line stays a valid entry')
  assert.equal(JSON.parse(lines.at(-1)).option, 'Trigger it again')
  assert.doesNotMatch(first, /^Recorded:/, 'the answer does not claim a clean record when the trim was refused')
  assert.doesNotMatch(second, /^Recorded:/)
  assert.equal(warnings.length, 1, 'one warning for the temp name, not one per record')
  assert.match(warnings[0], /decisions\.jsonl\.tmp/)
  assert.match(warnings[0], /not a plain file/)

  // The healthy path is untouched: with a normal temp name the trim still bounds the log.
  const healthy = await boot({ decisions: true })
  t.after(healthy.stop)
  const plain = join(healthy.home, 'decisions.jsonl')
  writeFileSync(plain, full(2_000))
  const healthyWarnings = []
  healthy.ctx.logger.warn = (...args) => healthyWarnings.push(args.join(' '))
  assert.match(await healthy.tool('record_decision', { option: 'Trim normally', choice: 'used' }), /^Recorded:/)
  const kept = readFileSync(plain, 'utf8').split('\n').filter(Boolean)
  assert.equal(kept.length, 2_000, 'the trim keeps the newest KEPT lines')
  assert.equal(JSON.parse(kept.at(-1)).option, 'Trim normally')
  assert.equal(existsSync(`${plain}.tmp`), false, 'the healthy trim renames its temp name away')
  assert.deepEqual(healthyWarnings, [])
})
