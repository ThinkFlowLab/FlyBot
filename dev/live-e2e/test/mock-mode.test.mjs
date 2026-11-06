// Keyless coverage of the mock mode and the browser smoke (#2565): the mode split in the
// guards, the smoke's two checks against a fake app, and the report line that tells a run
// that measured something from one that did not. No network, no browser, no key.
import { strict as assert } from 'node:assert'
import test from 'node:test'
import { FakeAdapter } from './fake-adapter.mjs'
import { runSmoke } from '../smoke.mjs'
import { buildReport, budgetsFrom, guardRun, readMode, summaryLines } from '../report.mjs'

const MOCK_ENDPOINT = 'http://127.0.0.1:8765'

test('mock mode needs no key and takes the scripted mock endpoint', () => {
  const guard = guardRun({ apiKey: '', baseUrl: MOCK_ENDPOINT, mode: 'mock' })
  assert.deepEqual(guard.problems, [])
  assert.equal(guard.endpoint.mock, true)
  assert.equal(guard.endpoint.viaTap, false)
})

test('mock mode refuses an endpoint that is not the loopback mock', () => {
  assert.match(guardRun({ apiKey: '', baseUrl: 'https://api.deepseek.com', mode: 'mock' }).problems.join('; '), /loopback/)
  assert.match(guardRun({ apiKey: '', baseUrl: undefined, mode: 'mock' }).problems.join('; '), /DEEPSEEK_BASE_URL/)
})

test('the live guard still refuses a keyless loopback run', () => {
  const guard = guardRun({ apiKey: '', baseUrl: MOCK_ENDPOINT })
  assert.match(guard.problems.join('; '), /DEEPSEEK_API_KEY is missing/)
  assert.match(guard.problems.join('; '), /loopback/)
  assert.match(guardRun({ apiKey: 'a'.repeat(32), baseUrl: MOCK_ENDPOINT }).problems.join('; '), /loopback/)
  assert.deepEqual(guardRun({ apiKey: 'a'.repeat(32), baseUrl: undefined }).problems, [])
})

test('an unknown mode is a problem, and no variable means live', () => {
  assert.equal(readMode(undefined), 'live')
  assert.equal(readMode('mock'), 'mock')
  assert.match(guardRun({ apiKey: 'a'.repeat(32), baseUrl: undefined, mode: 'nope' }).problems.join('; '), /LIVE_E2E_MODE is nope/)
})

test('the smoke passes against an app that replies', async () => {
  const { results, stopped } = await runSmoke(new FakeAdapter({ chatOnly: true }), { checkMs: 1000 })
  assert.equal(stopped, undefined)
  assert.deepEqual(results.map(result => result.id), ['message-and-reply', 'survive-reload'])
  assert.deepEqual(results.map(result => result.outcome), ['pass', 'pass'])
})

test('the smoke fails when the reply never arrives', async () => {
  const { results } = await runSmoke(new FakeAdapter({ chatOnly: true, noReply: true }), { checkMs: 1000 })
  assert.equal(results[0].outcome, 'assertion_failed')
  assert.match(results[0].problems.join('; '), /no reply/)
})

test('the reload check fails when the conversation does not come back', async () => {
  const { results } = await runSmoke(new FakeAdapter({ chatOnly: true, forgetOnReload: true }), { checkMs: 1000 })
  assert.equal(results[0].outcome, 'pass')
  assert.equal(results[1].outcome, 'assertion_failed')
  assert.match(results[1].problems.join('; '), /message is gone/)
})

test('the report says which mode ran, so a mock green is not a live green', () => {
  const report = buildReport({
    runId: 'r', revision: 'abc',
    config: { node: 'v22', dsh: '0.2.1-rc.2', model: 'deepseek-official/deepseek-flash', mode: 'mock' },
    endpoint: { host: '127.0.0.1:8765', origin: MOCK_ENDPOINT, viaTap: false, mock: true },
    budgets: budgetsFrom({}), checks: [], usage: { calls: 0, prompt: 0, cached: 0, output: 0 },
    startedAt: new Date(), endedAt: new Date(), tz: 'UTC',
  })
  assert.match(summaryLines(report).join('\n'), /mode mock \(scripted model, no key\)/)
})
