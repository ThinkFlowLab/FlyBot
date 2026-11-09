import assert from 'node:assert/strict'
import { existsSync, linkSync, lstatSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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
// place this code writes (#2103) — but it is the writing host's own name now, `<log>.<pid>.<uuid>.tmp`
// like the resume notes (#2724), not the fixed `<home>/decisions.jsonl.tmp` every writer on the home
// shared. A link planted at that old name is not a name this code takes: it keeps its bytes and its
// target, the trim bounds the log, and the log itself stays a plain file.
test('#2724: the trim writes its own temp name, so a link at the old fixed name is left alone', async (t) => {
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
  const planted = `${log}.tmp`
  symlinkSync(target, planted)

  const warnings = []
  ctx.logger.warn = (...args) => warnings.push(args.join(' '))
  const first = await tool('record_decision', { option: 'Trigger the trim', choice: 'used' })
  const second = await tool('record_decision', { option: 'Trigger it again', choice: 'rejected' })

  assert.equal(readFileSync(target, 'utf8'), before, 'the file behind the planted link is not written through')
  assert.equal(lstatSync(planted).isSymbolicLink(), true, 'the planted link is still there')
  assert.equal(readlinkSync(planted), target, 'the planted link still names the same file')
  assert.equal(lstatSync(log).isSymbolicLink(), false, 'the log is a plain file of its own')
  const lines = readFileSync(log, 'utf8').split('\n').filter(Boolean)
  assert.equal(lines.length, 2_000, 'the trim bounds the log at KEPT lines')
  for (const lineText of lines) assert.doesNotThrow(() => JSON.parse(lineText), 'every line stays a valid entry')
  assert.equal(JSON.parse(lines.at(-1)).option, 'Trigger it again')
  assert.match(first, /^Recorded:/, 'the trim went through, so the answer is clean')
  assert.match(second, /^Recorded:/)
  assert.deepEqual(warnings, [], 'nothing is refused: the planted name is not one this code writes')
  const leftovers = readdirSync(home).filter(name => name.endsWith('.tmp') && name !== 'decisions.jsonl.tmp')
  assert.deepEqual(leftovers, [], 'the trim renames its own temp name away')
})

// The temp name is a leaf like the log itself (temp-name sweep): a hard link there is a plain file to
// `lstat` while the write would land in the inode the other name holds. The guard still refuses that,
// and a hard link at the old fixed name is no way to reach it: the outside bytes stay, and the log is
// bounded by a temp name of its own.
test('#2724: a hard link at the old fixed temp name does not take the trim', async (t) => {
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
  const planted = `${log}.tmp`
  linkSync(target, planted)

  const warnings = []
  ctx.logger.warn = (...args) => warnings.push(args.join(' '))
  const first = await tool('record_decision', { option: 'Trigger the trim', choice: 'used' })

  assert.equal(readFileSync(target, 'utf8'), before, 'the shared inode keeps its bytes')
  assert.equal(lstatSync(target).nlink, 2, 'the outside file still carries the planted name')
  const lines = readFileSync(log, 'utf8').split('\n').filter(Boolean)
  assert.equal(lines.length, 2_000, 'the trim bounds the log at KEPT lines')
  assert.equal(JSON.parse(lines.at(-1)).option, 'Trigger the trim')
  assert.match(first, /^Recorded:/, 'the trim went through, so the answer is clean')
  assert.deepEqual(warnings, [])
})

// #2159: a hard link at the log is a plain file to `lstat` while its bytes are also a name outside
// the home, so an append would land in the shared inode. The leaf is asked with the same predicate
// as the trim's temp name (#2114): the line is dropped, one warning names the file, the Bot is told
// it was not recorded, and the other name keeps its bytes.
test('#2159: a hard-linked decision log is refused, not written through', async (t) => {
  const { ctx, home, tool, events, stop } = await boot({ decisions: true })
  t.after(stop)
  const elsewhere = mkdtempSync(join(tmpdir(), 'ds-bot-decisions-hardlink-'))
  t.after(() => rmSync(elsewhere, { recursive: true, force: true, maxRetries: 5 }))
  const target = join(elsewhere, 'decisions.jsonl')
  const before = 'PRE-EXISTING LINE\n'
  writeFileSync(target, before)
  const leaf = join(home, 'decisions.jsonl')
  linkSync(target, leaf)

  const warnings = []
  ctx.logger.warn = (...args) => warnings.push(args.join(' '))
  const first = await tool('record_decision', { option: 'Keep the shared inode', choice: 'rejected' })
  const second = await tool('record_decision', { option: 'Try it again', choice: 'used' })
  assert.equal(readFileSync(target, 'utf8'), before, 'the shared inode keeps its bytes')
  assert.equal(lstatSync(leaf).nlink, 2, 'the log is still another name of the same file')
  assert.match(first, /Not recorded/, 'the Bot is told the decision is not on disk')
  assert.match(second, /Not recorded/)
  assert.match(first, /not a plain file of its own/, 'a hard link is a plain file, so the answer says whose it is not')
  assert.equal(warnings.length, 1, 'one warning, not one for every refused record')
  assert.match(warnings[0], /not a plain file of its own/)
  assert.deepEqual(events, [], 'a decision that is not on disk is not announced on the feed')

  // The control: with one name the log records again, so the refusal is about this file, not a latch.
  rmSync(leaf)
  assert.match(await tool('record_decision', { option: 'Write it now', choice: 'used' }), /^Recorded:/)
  assert.equal(readFileSync(leaf, 'utf8').trim().split('\n').length, 1)
})
