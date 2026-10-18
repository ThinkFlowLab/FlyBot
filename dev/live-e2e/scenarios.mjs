// The four #204 checks as app-independent code: everything here talks to an adapter
// (docs/interop/live-e2e-adapter.md) and never to FlyBot, DSH or a browser, so the same
// scenarios can run against any app that implements the contract, and the logic is
// covered keyless by test/scenarios.test.mjs with a fake adapter. The runner (run.mjs)
// owns time, budgets, classification and the report; scenarios only sequence and assert.
//
// Tasks go through the UI (uploadFile/sendTask/openPreview/reload); observation is the
// adapter's read-only side (readFile/deliveredFileNames/conversationLines), which for
// FlyBot reads the run's storage and the app's own state API. A filename echoed in the
// task reply is never evidence of delivery: assertions read the delivered bytes and the
// preview the UI shows.
import { createHash } from 'node:crypto'

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

// The fixture is fixed on purpose: the expected totals (4 / 400 and 2 / 140) depend on
// it, and freshness comes from a new run id and home per run, not from new data.
export const FIXTURE = 'orders.csv'

// What the checks ask for, in the app's own task language. The wording may change; the
// assertions below must not.
export const TASKS = {
  summarize: '把 orders.csv 里所有已支付（status 为 paid）的订单整理成 summary.json：包含每笔订单的完整信息（order_id、region、status、amount）、总笔数 count 和总金额 total。',
  refine: '重新整理：只要华东地区已支付的订单，另存为 summary-east.json（同样包含订单明细、count 和 total）。不要改动 orders.csv 和 summary.json。',
}

export function parseOrdersCsv(text) {
  const lines = String(text).split(/\r?\n/).filter(Boolean)
  const head = lines[0]?.split(',').map(name => name.trim())
  if (!head || !head.includes('order_id') || !head.includes('amount')) throw new Error(`unexpected CSV header: ${lines[0]}`)
  return lines.slice(1).map(line => {
    const cells = line.split(',').map(cell => cell.trim())
    const row = {}
    head.forEach((name, index) => { row[name] = cells[index] })
    row.amount = Number(row.amount)
    return row
  })
}

// The expected answers, derived from the fixture rather than copied, so a fixture edit
// that breaks the stated totals fails its own unit test instead of the nightly.
export function expectations(rows) {
  const paid = rows.filter(row => row.status === 'paid')
  const east = paid.filter(row => row.region === '华东')
  const shape = list => ({
    ids: list.map(row => row.order_id).sort(),
    count: list.length,
    total: list.reduce((sum, row) => sum + row.amount, 0),
    rows: [...list].sort((a, b) => a.order_id.localeCompare(b.order_id)),
  })
  return { paid: shape(paid), east: shape(east) }
}

export class AssertionError extends Error {}

const fail = message => { throw new AssertionError(message) }

// Delivered JSON is compared parsed, never by bytes: indentation, key order and \u
// escaping differ between writers. `count` and `total` must be real numbers.
export function parseSummary(name, text) {
  let json
  try { json = JSON.parse(String(text)) } catch (error) { fail(`${name} is not JSON: ${error.message}`) }
  if (typeof json.count !== 'number' || !Number.isFinite(json.count)) fail(`${name}.count is not a number: ${JSON.stringify(json.count)}`)
  if (typeof json.total !== 'number' || !Number.isFinite(json.total)) fail(`${name}.total is not a number: ${JSON.stringify(json.total)}`)
  if (!Array.isArray(json.orders) || json.orders.length === 0) fail(`${name}.orders is not a non-empty list`)
  return json
}

export function assertSummaryMatches(name, json, expected) {
  const problems = []
  const ids = json.orders.map(row => String(row.order_id)).sort()
  if (ids.join(',') !== expected.ids.join(',')) problems.push(`${name} ids ${ids.join(',')} != ${expected.ids.join(',')}`)
  if (json.count !== expected.count) problems.push(`${name}.count ${json.count} != ${expected.count}`)
  if (json.total !== expected.total) problems.push(`${name}.total ${json.total} != ${expected.total}`)
  for (const row of json.orders) {
    const want = expected.rows.find(candidate => candidate.order_id === String(row.order_id))
    if (!want) continue
    if (Number(row.amount) !== want.amount) problems.push(`${name} ${row.order_id} amount ${row.amount} != ${want.amount}`)
    if (String(row.region) !== want.region) problems.push(`${name} ${row.order_id} region ${row.region} != ${want.region}`)
    if (String(row.status) !== want.status) problems.push(`${name} ${row.order_id} status ${row.status} != ${want.status}`)
  }
  if (problems.length > 0) fail(problems.join('; '))
}

function assertSameJson(shown, actual, name) {
  let left
  let right
  try {
    left = JSON.parse(String(shown))
    right = JSON.parse(String(actual))
  } catch (error) { fail(`${name} preview or file is not JSON: ${error.message}`) }
  if (JSON.stringify(left) !== JSON.stringify(right)) fail(`${name}: the preview does not show the file's JSON`)
}

const read = async (adapter, name) => {
  const bytes = await adapter.readFile(name)
  if (bytes === undefined) fail(`${name} was not found in the run's storage`)
  return bytes
}

// Runs the four checks against one adapter, in one conversation. Each check records its
// own monotonic duration; `betweenChecks(entry)` runs after each and may stop the run
// ({ stop: true, reason }) — the runner uses it for the token budget. Classification of
// the run as a whole stays with the runner (report.mjs).
export async function runScenarios(adapter, { checkMs, betweenChecks }) {
  const csv = await read(adapter, FIXTURE)
  const csvSha = sha256(csv)
  const expected = expectations(parseOrdersCsv(csv.toString('utf8')))
  const checks = []
  let summarySha

  const check = (id, title) => {
    const entry = { id, title, problems: [] }
    checks.push(entry)
    return entry
  }
  let stopped
  const step = async (id, title, run) => {
    const entry = check(id, title)
    const started = performance.now()
    try { await run() } catch (error) { entry.problems.push(error.message) }
    entry.durationMs = performance.now() - started
    const verdict = betweenChecks ? await betweenChecks(entry) : undefined
    if (verdict?.stop) { stopped = verdict.reason ?? 'stopped between checks'; return false }
    return true
  }

  if (!await step('upload-and-summarize', 'upload the CSV; summary.json lists the paid orders', async () => {
    await adapter.uploadFile(FIXTURE, csv)
    await adapter.sendTask(TASKS.summarize)
    await adapter.settle(checkMs)
    if (!(await adapter.deliveredFileNames()).includes('summary.json')) fail('the UI does not list summary.json as delivered')
    const summary = await read(adapter, 'summary.json')
    assertSummaryMatches('summary.json', parseSummary('summary.json', summary.toString('utf8')), expected.paid)
    summarySha = sha256(summary)
  })) return finish()

  if (!await step('refine-and-preserve', 'summary-east.json narrows to 华东 paid; earlier files keep their bytes', async () => {
    await adapter.sendTask(TASKS.refine)
    await adapter.settle(checkMs)
    if (!(await adapter.deliveredFileNames()).includes('summary-east.json')) fail('the UI does not list summary-east.json as delivered')
    const east = await read(adapter, 'summary-east.json')
    assertSummaryMatches('summary-east.json', parseSummary('summary-east.json', east.toString('utf8')), expected.east)
    if (sha256(await read(adapter, 'summary.json')) !== summarySha) fail('summary.json changed during the refinement')
    if (sha256(await read(adapter, FIXTURE)) !== csvSha) fail('the uploaded orders.csv changed during the run')
  })) return finish()

  if (!await step('survive-reload', 'a reload keeps the conversation and both artifact cards', async () => {
    await adapter.reload()
    const visible = await adapter.conversationLines()
    for (const text of [TASKS.summarize, TASKS.refine]) {
      if (!visible.some(line => text.slice(0, 24) && line.text.includes(text.slice(0, 24)))) fail(`after reload the task is gone from the conversation: ${text.slice(0, 24)}…`)
    }
    if (visible.filter(line => line.who !== 'user').length === 0) fail('after reload no reply is visible')
    const names = await adapter.deliveredFileNames()
    for (const name of ['summary.json', 'summary-east.json']) {
      if (!names.includes(name)) fail(`after reload the UI no longer lists ${name} as delivered`)
    }
  })) return finish()

  await step('open-previews', 'the sidebar previews show the delivered files\' JSON', async () => {
    for (const name of ['summary.json', 'summary-east.json']) {
      const shown = await adapter.openPreview(name)
      const actual = await read(adapter, name)
      assertSameJson(shown, actual.toString('utf8'), name)
    }
  })

  function finish() {
    const results = checks.map(({ problems, ...entry }) => ({ ...entry, outcome: problems.length === 0 ? 'pass' : 'assertion_failed', problems }))
    return { results, stopped }
  }
  return finish()
}
