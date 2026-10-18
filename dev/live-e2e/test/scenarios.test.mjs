// Keyless coverage of the #204 scenario logic (node --test, no network, no browser,
// no key). Each case breaks the fake app in one specific way and the matching assertion
// must name it.
import { strict as assert } from 'node:assert'
import test from 'node:test'
import { FakeAdapter, fixtureCsv } from './fake-adapter.mjs'
import { expectations, parseOrdersCsv, parseSummary, runScenarios, sha256, TASKS } from '../scenarios.mjs'
import { buildReport, budgetsFrom, classify, guardRun, OUTCOMES, providerFailures, usageOf } from '../report.mjs'
import { scanText } from '../sanitize.mjs'

test('the fixture derives the totals the issue states', () => {
  const expected = expectations(parseOrdersCsv(fixtureCsv().toString('utf8')))
  assert.deepEqual(expected.paid.ids, ['A001', 'A002', 'A004', 'A005'])
  assert.equal(expected.paid.count, 4)
  assert.equal(expected.paid.total, 400)
  assert.deepEqual(expected.east.ids, ['A001', 'A004'])
  assert.equal(expected.east.count, 2)
  assert.equal(expected.east.total, 140)
})

test('a correct app passes all four checks', async () => {
  const { results, stopped } = await runScenarios(new FakeAdapter(), { checkMs: 1000 })
  assert.equal(stopped, undefined)
  assert.deepEqual(results.map(result => result.outcome), ['pass', 'pass', 'pass', 'pass'])
  for (const result of results) assert.ok(result.durationMs >= 0)
})

test('wrong ids fail the first check as an assertion, not as a crash', async () => {
  const { results } = await runScenarios(new FakeAdapter({ breakIds: true }), { checkMs: 1000 })
  assert.equal(results[0].outcome, 'assertion_failed')
  assert.match(results[0].problems.join('; '), /A099/)
  // The corrupted summary still exists, so the run continues and the later checks say so.
  assert.equal(results[1].outcome, 'assertion_failed')
})

test('touching summary.json during the refinement fails the immutability assertion', async () => {
  const { results } = await runScenarios(new FakeAdapter({ mutateSummary: true }), { checkMs: 1000 })
  assert.equal(results[0].outcome, 'pass')
  assert.equal(results[1].outcome, 'assertion_failed')
  assert.match(results[1].problems.join('; '), /summary\.json changed/)
})

test('a stale preview fails the fourth check, not the file read', async () => {
  const { results } = await runScenarios(new FakeAdapter({ stalePreview: true }), { checkMs: 1000 })
  assert.equal(results[3].outcome, 'assertion_failed')
  assert.match(results[3].problems.join('; '), /preview does not show/)
})

test('a bench that never settles surfaces as an adapter failure for the runner to classify', async () => {
  const { results } = await runScenarios(new FakeAdapter({ neverSettle: true }), { checkMs: 1000 })
  assert.equal(results[0].outcome, 'assertion_failed')
  assert.match(results[0].problems.join('; '), /did not settle/)
})

test('the token budget stops the run between checks', async () => {
  let calls = 0
  const { results, stopped } = await runScenarios(new FakeAdapter(), {
    checkMs: 1000,
    betweenChecks: () => { calls += 1; return calls === 1 ? { stop: true, reason: 'cap' } : {} },
  })
  assert.equal(stopped, 'cap')
  assert.equal(results.length, 1)
  assert.equal(results[0].outcome, 'pass')
})

test('summaries must be JSON with numeric count and total', () => {
  assert.throws(() => parseSummary('x', 'not json'), /is not JSON/)
  assert.throws(() => parseSummary('x', '{"orders": [{}], "count": "4", "total": 400}'), /count is not a number/)
  assert.throws(() => parseSummary('x', '{"orders": [{}], "count": 4, "total": null}'), /total is not a number/)
  const parsed = parseSummary('x', '{"orders": [{"order_id": "A001"}], "count": 1, "total": 100}')
  assert.equal(parsed.count, 1)
})

test('the guards fail closed', () => {
  assert.ok(guardRun({ apiKey: '', baseUrl: undefined }).problems.length > 0)
  assert.ok(guardRun({ apiKey: 'mock-key', baseUrl: undefined }).problems.length > 0)
  assert.ok(guardRun({ apiKey: 'short', baseUrl: undefined }).problems.length > 0)
  const loopback = guardRun({ apiKey: 'a'.repeat(32), baseUrl: 'http://127.0.0.1:8898/anthropic' })
  assert.equal(loopback.problems.length, 1)
  assert.match(loopback.problems[0], /loopback/)
  const tap = guardRun({ apiKey: 'a'.repeat(32), baseUrl: 'http://127.0.0.1:8898/anthropic', tapUpstream: 'https://api.deepseek.com' })
  assert.deepEqual(tap.problems, [])
  assert.equal(tap.endpoint.viaTap, true)
  const home = guardRun({ apiKey: 'a'.repeat(32), baseUrl: undefined, home: '/Users/me/.dsh', userHome: '/Users/me' })
  assert.match(home.problems.join('; '), /user's own DSH data/)
  assert.deepEqual(guardRun({ apiKey: 'a'.repeat(32), baseUrl: undefined, home: '/repo/.dsh-test-x', userHome: '/Users/me' }).problems, [])
})

test('classification follows the outcome order', () => {
  const budgets = budgetsFrom({})
  assert.deepEqual(budgets, { checkMs: 180_000, quietMs: 6_000, maxTokens: 250_000 })
  assert.equal(budgetsFrom({ LIVE_E2E_CHECK_MS: '5', LIVE_E2E_MAX_TOKENS: 'x' }).checkMs, 5)
  assert.equal(classify({ checkOutcomes: ['pass'], providerFailures: [], tokenUsage: { prompt: 0, output: 0 }, budgets }), 'pass')
  assert.equal(classify({ checkOutcomes: ['pass'], providerFailures: ['401 bad key'], tokenUsage: { prompt: 0, output: 0 }, budgets }), 'provider_failed')
  assert.equal(classify({ checkOutcomes: ['assertion_failed'], providerFailures: [], tokenUsage: { prompt: 0, output: 0 }, budgets }), 'assertion_failed')
  assert.equal(classify({ checkOutcomes: ['pass'], providerFailures: [], tokenUsage: { prompt: 250_001, output: 0 }, budgets }), 'budget_exceeded')
})

test('usage and provider failures come from the tap lines', () => {
  const usage = usageOf([{ tokens: { prompt: 100, cached: 40, output: 10 } }, { tokens: { prompt: 5, cached: 0, output: 5 } }, {}])
  assert.deepEqual(usage, { calls: 3, prompt: 105, cached: 40, output: 15 })
  assert.deepEqual(providerFailures([{ status: 200, text: 'ok' }, { status: 429, error: 'slow down' }]), ['429 slow down'])
  assert.deepEqual(providerFailures([{ text: 'fine' }]), [])
})

test('the report carries offsets, human times and exit codes', () => {
  const report = buildReport({
    runId: 'id', revision: 'deadbeef',
    config: { node: 'v24', dsh: '0.2.0-rc.2', model: 'deepseek-official/deepseek-flash' },
    endpoint: { host: 'api.deepseek.com', origin: 'default', viaTap: false },
    budgets: budgetsFrom({}),
    checks: [{ id: 'x', title: 't', outcome: 'pass', durationMs: 12.5, problems: [] }],
    usage: { calls: 1, prompt: 1, cached: 0, output: 1 }, providerFailures: [],
    startedAt: new Date('2026-10-18T00:30:00+08:00'), endedAt: new Date('2026-10-18T00:31:00+08:00'), tz: 'Asia/Shanghai',
  })
  assert.equal(report.outcome, 'pass')
  assert.equal(report.exitCode, 0)
  assert.equal(report.schema, 'flybot-live-e2e/1')
  assert.equal(report.startedAt.iso, '2026-10-17T16:30:00.000Z')
  assert.match(report.startedAt.offset, /^[+-]\d\d:\d\d$/)
  assert.equal(report.humanTimes.zone, 'Asia/Shanghai')
  assert.ok(!Number.isNaN(Date.parse(report.startedAt.iso)))
})

test('the sanitizer catches login URLs, cookies and the key itself — and never quotes the hit', () => {
  assert.deepEqual(scanText('plain text', 'secret'), [])
  assert.deepEqual(scanText('see http://127.0.0.1:3196/?token=abc123 now', undefined), ['login token URL'])
  assert.deepEqual(scanText('x-flybot-member-session: 1', undefined), ['cookie material'])
  assert.deepEqual(scanText('the key is sk12345678', 'sk12345678'), ['the API key value appears verbatim'])
  assert.deepEqual(scanText('the key is not here', 'sk12345678'), [])
  // The finding names the kind only: the matched text is what the scan exists to keep
  // out of reports and artifacts.
  const mixed = scanText(`set-cookie: a=1 and http://x/?token=zzz and sk12345678`, 'sk12345678').join('|')
  assert.ok(!mixed.includes('zzz') && !mixed.includes('abc123') && !mixed.includes('sk12345678'), mixed)
  assert.match(mixed, /login token URL/)
})

test('outcome names map to distinct exit codes', () => {
  const codes = Object.values(OUTCOMES)
  assert.deepEqual([...new Set(codes)].sort(), [0, 1, 2, 3, 4])
})

test('task wording stays intact for the reload check', () => {
  assert.ok(TASKS.summarize.length > 24 && TASKS.refine.length > 24)
  assert.ok(TASKS.summarize.includes('summary.json') && TASKS.refine.includes('summary-east.json'))
})

test('sha256 is stable for the immutability chain', () => {
  assert.equal(sha256(Buffer.from('abc')), sha256(Buffer.from('abc')))
  assert.notEqual(sha256(Buffer.from('abc')), sha256(Buffer.from('abd')))
})
