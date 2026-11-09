// #2724: the decision log's atomic write named its temp file with one fixed name for every writer,
// so two writers on one home met on `<home>/decisions.jsonl.tmp`. One writer's trim renamed the
// other's temp away, the other write then failed with ENOENT mid-chain — the trim was lost and the
// caller was still told `Recorded: …`. And `record()` never asked `rt.readOnly()`, so the second,
// read-only host of one team folder wrote the log it must only read.
//
// Two writers and a read-only one, over the real module: the store and the home lock are not part of
// what these cases judge, so the runtime facts `install()` asks for are the ones supplied here.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { install } from '../src/host/decisions.js'

const KEPT = 2_000
const SITUATION = 'The Bot team in /data/example is open in another dsh (Web or Desktop, pid 4242). This window shows the team but cannot change it; close the other one and reload.'

const line = n => `${JSON.stringify({ time: 1_000 + n, bot: 'a', botName: 'Chief', option: `kept ${n}`, choice: 'used' })}\n`
const seed = () => Array.from({ length: KEPT }, (_, i) => line(i)).join('')

function writer(home, { readOnly } = {}) {
  const tools = new Map()
  const warnings = []
  const feed = []
  install({
    home,
    config: { decisions: true },
    ctx: { tools: { register: tool => tools.set(tool.name, tool) } },
    warn: (...args) => warnings.push(args.join(' ')),
    load: async () => {},
    selfOf: id => id,
    botOf: () => ({ id: 'a', name: 'Chief' }),
    fireFeed: (kind, payload) => feed.push({ kind, payload }),
    readOnly: () => readOnly,
  })
  return {
    warnings,
    feed,
    run: args => tools.get('record_decision').execute(args, { agent: { id: 'a' } }),
  }
}

function home(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-decisions-race-'))
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }))
  return dir
}

const optionsOnDisk = path => readFileSync(path, 'utf8').split('\n').filter(Boolean).map(text => JSON.parse(text).option)

// Both writers trim, so both take the temp path the fixed name gave to every writer on the home.
// Five pairs, because a single pair can meet or miss the collision window depending on timing: the
// answer is that no pair of them fails, over the same log, one after the other.
test('#2724: two writers on one home both record their decision, and no write fails on a shared temp name', async (t) => {
  const dir = home(t)
  const log = join(dir, 'decisions.jsonl')
  writeFileSync(log, seed())
  const one = writer(dir)
  const two = writer(dir)

  const recorded = []
  for (let pair = 0; pair < 5; pair++) {
    const [first, second] = await Promise.all([
      one.run({ option: `writer one, pair ${pair}`, choice: 'used' }),
      two.run({ option: `writer two, pair ${pair}`, choice: 'rejected' }),
    ])
    recorded.push([first, second])
  }

  const warnings = [...one.warnings, ...two.warnings]
  assert.deepEqual(warnings.filter(text => /a decision was not written/.test(text)), [],
    `no write may fail on the temp name, got: ${warnings.join(' | ')}`)
  for (const [first, second] of recorded) {
    assert.match(first, /^Recorded:/, `the first writer is told its decision is on disk, got: ${first}`)
    assert.match(second, /^Recorded:/, `the second writer is told its decision is on disk, got: ${second}`)
  }

  const kept = optionsOnDisk(log)
  for (let pair = 0; pair < 5; pair++) {
    assert.ok(kept.includes(`writer one, pair ${pair}`), `writer one's pair ${pair} is in the log`)
    assert.ok(kept.includes(`writer two, pair ${pair}`), `writer two's pair ${pair} is in the log`)
  }
  assert.ok(kept.length <= KEPT, `the log stays bounded at ${KEPT} lines, got ${kept.length}`)
  assert.deepEqual(readdirSync(dir).filter(name => name.endsWith('.tmp')), [], 'no temp file is left behind')
})

// The second host of one team folder is read-only. `record_decision` there must read the log and
// write nothing: no append, no trim, no feed event, and an answer that says so.
test('#2724: a read-only window records nothing, changes no byte and says why', async (t) => {
  const dir = home(t)
  const log = join(dir, 'decisions.jsonl')
  const before = seed()
  writeFileSync(log, before)
  const only = writer(dir, { readOnly: SITUATION })

  const answer = await only.run({ option: 'Delete the whole repo', choice: 'rejected', why: 'destructive' })

  assert.equal(readFileSync(log, 'utf8'), before, 'the log keeps its bytes: nothing was appended or trimmed')
  assert.doesNotMatch(answer, /^Recorded:/, 'the answer does not claim a record')
  assert.match(answer, /read-only/, 'the answer says the window is read-only')
  assert.ok(answer.includes(SITUATION), `the answer names the host's own reason, got: ${answer}`)
  assert.deepEqual(only.feed, [], 'a decision that is not on disk is not announced on the feed')
  assert.deepEqual(only.warnings, [], 'a read-only window has nothing to warn about')
})

// `rt.readOnly()`'s contract is the one the chat index reads (#2711): any value but `undefined`
// means this window is not the writer. A host that states no sentence still records nothing.
test('#2724: a read-only window with no host sentence still writes nothing', async (t) => {
  const dir = home(t)
  const log = join(dir, 'decisions.jsonl')
  const before = seed()
  writeFileSync(log, before)
  const only = writer(dir, { readOnly: '' })

  const answer = await only.run({ option: 'Ship without the tests', choice: 'rejected' })

  assert.equal(readFileSync(log, 'utf8'), before, 'the log keeps its bytes')
  assert.match(answer, /^Not recorded: this window is read-only/, `the answer refuses and says why, got: ${answer}`)
  assert.match(answer, /written\.$/, 'no dangling space where the host sentence would be')
  assert.deepEqual(only.feed, [], 'nothing is announced on the feed')
})

// The same window over a log that is over its bound: the trim is a write too, so the read-only
// window leaves the oversized log as it is instead of bounding it.
test('#2724: a read-only window does not trim an oversized log', async (t) => {
  const dir = home(t)
  const log = join(dir, 'decisions.jsonl')
  const before = seed()
  writeFileSync(log, before)
  const only = writer(dir, { readOnly: SITUATION })

  for (let i = 0; i < 3; i++) assert.match(await only.run({ option: `oversized ${i}`, choice: 'used' }), /read-only/)

  assert.equal(readFileSync(log, 'utf8'), before, 'the log is still the file the writer left')
  assert.deepEqual(readdirSync(dir).filter(name => name.endsWith('.tmp')), [], 'no temp file was written')
})
