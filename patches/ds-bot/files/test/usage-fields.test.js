import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { extractIssuePr, foldCalls, install as installUsage, missingUsageFields, withUsageFields } from '../src/host/usage.js'

const header = (provider, model) => ({ type: 'request/header', data: { header: { config: { provider, model } }, reason: 'change' } })
const message = (turn, step, usage, time = 0) => ({ type: 'assistant/message', time, data: { turn, step, message: { role: 'assistant', content: [] }, stream: [], usage } })
const usage = (inputTokens, outputTokens, cacheReadTokens = 0) => ({ inputTokens, outputTokens, cacheReadTokens })
const here = dirname(fileURLToPath(import.meta.url))

test('withUsageFields fills harness, issue·PR, toolCalls, wallMs, and keeps tokens', () => {
  const row = withUsageFields({ input: 1, cacheRead: 0, cacheWrite: 0, output: 2 })
  assert.deepEqual(missingUsageFields(row), [])
  assert.equal(row.harness, 'default')
  assert.equal(row.issuePr, '')
  assert.equal(row.toolCalls, 0)
  assert.equal(row.wallMs, 0)
  assert.equal(row.input, 1)
  assert.equal(row.output, 2)
})

test('missing any of the five usage fields is red', () => {
  const base = withUsageFields({ input: 1, cacheRead: 0, cacheWrite: 0, output: 1 })
  assert.deepEqual(missingUsageFields({ ...base, harness: '' }), ['harness'])
  assert.deepEqual(missingUsageFields({ ...base, issuePr: undefined }), ['issuePr'])
  assert.deepEqual(missingUsageFields({ ...base, toolCalls: undefined }), ['toolCalls'])
  assert.deepEqual(missingUsageFields({ ...base, wallMs: undefined }), ['wallMs'])
  assert.deepEqual(missingUsageFields({ ...base, input: undefined }), ['tokens'])
})

test('foldCalls counts tool/call events and wall clock from the attempt', () => {
  const { rows } = foldCalls([
    { type: 'turn/start', time: 1000, data: { turn: 1 } },
    header('deepseek', 'v4-flash'),
    { type: 'user', time: 1001, data: { text: 'please implement #903 Step 0' } },
    { type: 'tool/call', time: 1100, data: { name: 'read_file' } },
    { type: 'tool/call', time: 1200, data: { name: 'edit_file' } },
    message(1, 0, usage(10, 2), 1500),
  ])
  assert.equal(rows.length, 1)
  assert.deepEqual(missingUsageFields(rows[0]), [])
  assert.equal(rows[0].toolCalls, 2)
  assert.equal(rows[0].wallMs, 500)
  assert.equal(rows[0].issuePr, '#903')
})

test('foldCalls records a routed harness and leaves the resume state unchanged', () => {
  const { rows, state } = foldCalls([
    { type: 'turn/start', time: 1000, data: { turn: 1 } },
    header('deepseek', 'v4-flash'),
    { type: 'user', time: 1001, data: { text: 'see PR #908 for #874' } },
    { type: 'tool/call', time: 1100, data: { name: 'read_file' } },
    message(1, 0, usage(10, 2), 1600),
  ], { harness: 'lite' })
  assert.equal(rows.length, 1)
  assert.deepEqual(missingUsageFields(rows[0]), [])
  assert.equal(rows[0].harness, 'lite')
  assert.equal(rows[0].issuePr, 'PR #908')
  assert.equal(rows[0].toolCalls, 1)
  assert.equal(rows[0].wallMs, 600)
  assert.deepEqual(state, { provider: 'deepseek', model: 'v4-flash', retry: null })
  assert.throws(() => foldCalls([message(1, 0, usage(1, 1), 1)], { harness: 'turbo' }), /unknown harness/)
})

test('noteUsageHarness keeps a triage label and clears back to default', () => {
  const rt = {
    home: '/tmp/unused-usage-home',
    state: { bots: {}, rooms: {}, agents: {} },
    ctx: { effect() {}, on() {} },
    warn() {},
  }
  installUsage(rt)
  assert.equal(rt.noteUsageHarness('s1', ['harness:medium']), 'medium')
  assert.equal(rt.noteUsageHarness('s1', { labels: [{ name: 'harness:heavy' }] }), 'heavy')
  assert.equal(rt.noteUsageHarness('s1', 'default'), 'default')
  assert.equal(rt.noteUsageHarness('s1', ['agent-ready']), 'default')
  assert.throws(() => rt.noteUsageHarness('s1', 'turbo'), /unknown harness/)
  assert.throws(() => rt.noteUsageHarness('s1', ['harness:lite', 'harness:heavy']), /one harness tier label/)
})

test('extractIssuePr prefers PR refs over bare issue numbers', () => {
  assert.equal(extractIssuePr('see PR #908 for #903'), 'PR #908')
  assert.equal(extractIssuePr('https://github.com/ThinkFlowLab/FlyBot/issues/903'), '#903')
})

test('fixture usage.sqlite has one real calls row with all five fields', () => {
  const dbPath = join(here, 'fixtures', 'usage-sample.sqlite')
  const script = `
import sqlite3, sys
db = sqlite3.connect(sys.argv[1])
row = db.execute(
  "SELECT harness, issue_pr, tool_calls, wall_ms, input, output FROM calls ORDER BY time DESC LIMIT 1"
).fetchone()
assert row is not None, "no calls row"
harness, issue_pr, tool_calls, wall_ms, input_tokens, output = row
assert harness == "default", harness
assert isinstance(issue_pr, str) and issue_pr != "", issue_pr
assert tool_calls >= 1, tool_calls
assert wall_ms >= 1, wall_ms
assert input_tokens >= 1 and output >= 1, (input_tokens, output)
print("|".join(map(str, row)))
`
  const result = spawnSync('python3', ['-c', script, dbPath], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.match(result.stdout.trim(), /^default\|#903\|/)
})
