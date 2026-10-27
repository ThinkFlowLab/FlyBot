// label-hygiene (#738): a status label answers "what is happening right now", so a closed issue or a
// merged pull request must not keep one. These tests drive main() with a fake `gh`, the way
// merge-gate.mjs is tested: the fixtures are real API pages, and every removal is a recorded call.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { main, plan, planItem, STALE_LABELS } from './label-hygiene.mjs'

const issue = (number, state, labels, title = `Item ${number}`) =>
  ({ number, state, title, labels: labels.map(name => ({ name })) })

// A fake API over a page store: `GET repos/x/y/issues?state=closed&labels=<name>` filters like GitHub
// (state and one label), and a DELETE removes that label from the item. Every call is recorded.
// `failures` maps `<number>/<label>` to a refusal: `stderr` is the status line `gh` writes, `stdout`
// the JSON body it writes, and `remove: false` keeps the label on the item like a real refusal does.
const fakeGh = (items, failures = {}) => {
  const store = items.map(item => ({ ...item, labels: item.labels }))
  const calls = []
  const gh = (...args) => {
    const path = args[args.length - 1]
    calls.push(args.join(' '))
    if (args.includes('DELETE')) {
      const m = /\/issues\/(\d+)\/labels\/(.+)$/.exec(path)
      const item = store.find(i => String(i.number) === m[1])
      const name = decodeURIComponent(m[2])
      const failure = failures[`${m[1]}/${name}`]
      if (failure?.remove !== false) item.labels = item.labels.filter(l => l.name !== name)
      if (failure) {
        const error = new Error(failure.stderr)
        error.stderr = failure.stderr
        error.stdout = failure.stdout ?? ''
        throw error
      }
      return ''
    }
    const url = new URL('https://api.github.com/' + path)
    const label = url.searchParams.get('labels')
    const state = url.searchParams.get('state')
    return store
      .filter(i => (state ? i.state === state : true))
      .filter(i => (label ? i.labels.some(l => l.name === label) : true))
      .map(i => JSON.stringify(i))
      .join('\n')
  }
  gh.calls = calls
  gh.store = store
  gh.deletes = () => calls.filter(c => c.includes('DELETE'))
  return gh
}

const run = (gh, apply) => main({ gh, env: { GH_REPO: 'ThinkFlowLab/FlyBot' }, repo: 'ThinkFlowLab/FlyBot', apply })

// Capture what the run prints: the failure line and the refusal's response body are the evidence, so
// the tests pin them the way the live log reads.
const capture = (fn) => {
  const lines = []
  const log = console.log
  console.log = (...args) => lines.push(args.join(' '))
  try { return { result: fn(), lines } } finally { console.log = log }
}

test('#738: a dry run prints what it would do and removes nothing', () => {
  const gh = fakeGh([issue(602, 'closed', ['agent-working', 'bug', 'risk:T1'])])
  const r = run(gh, false)
  assert.equal(gh.deletes().length, 0, 'a dry run never writes')
  assert.equal(r.applied, false)
  assert.deepEqual(r.items.map(i => [i.number, i.stale]), [[602, ['agent-working']]])
})

test('#738: a closed issue loses exactly its status labels, and keeps bug and risk:T1', () => {
  const gh = fakeGh([issue(602, 'closed', ['agent-working', 'agent-pr', 'bug', 'risk:T1', 'area:automation'])])
  const r = run(gh, true)
  assert.equal(r.ok, true)
  assert.deepEqual(gh.store[0].labels.map(l => l.name), ['bug', 'risk:T1', 'area:automation'])
  assert.equal(gh.deletes().length, 2)
  for (const call of gh.deletes()) assert.match(call, /agent-(working|pr)/)
})

test('#738: an open issue with a status label is not touched', () => {
  const gh = fakeGh([issue(700, 'open', ['agent-working', 'bug'])])
  const r = run(gh, true)
  assert.deepEqual(r.items, [])
  assert.equal(gh.deletes().length, 0)
  assert.deepEqual(gh.store[0].labels.map(l => l.name), ['agent-working', 'bug'])
})

test('#738: a merged pull request loses agent-pr', () => {
  const gh = fakeGh([{ ...issue(704, 'closed', ['agent-pr', 'bug']), pull_request: { merged_at: '2026-10-22T08:00:00Z' } }])
  const r = run(gh, true)
  assert.deepEqual(r.items.map(i => [i.number, i.stale]), [[704, ['agent-pr']]])
  assert.deepEqual(gh.store[0].labels.map(l => l.name), ['bug'])
})

test('#738: an issue with only kept labels produces no removal call', () => {
  const gh = fakeGh([issue(710, 'closed', ['bug', 'area:ui', 'risk:T2', 'status:done'])])
  const r = run(gh, true)
  assert.deepEqual(r.items, [])
  assert.equal(gh.deletes().length, 0, 'a kept label is never removed')
  // Two read passes and nothing else: one list call per status label to find the work, and the same
  // again to read the repository back after applying. A DELETE here would be the bug this pins.
  assert.equal(gh.calls.length, 2 * STALE_LABELS.length, 'list calls only, one per status label per pass')
  for (const call of gh.calls) assert.match(call, /issues\?state=closed&labels=/, 'no write before or after')
})

test('#738: a second run on a clean repository reports 0 items and writes nothing', () => {
  const gh = fakeGh([issue(602, 'closed', ['agent-working', 'bug'])])
  run(gh, true)
  const before = gh.calls.length
  const r = run(gh, true)
  assert.equal(r.ok, true)
  assert.deepEqual(r.items, [])
  assert.equal(gh.deletes().length, 1, 'the first run removed one label, the second none')
  assert.ok(gh.calls.length > before)
})

test('#738: the plan dedupes an item that carries two status labels, and only counts closed ones', () => {
  const pages = [issue(1, 'closed', ['agent-working', 'agent-pr']), issue(1, 'closed', ['agent-working']), issue(2, 'open', ['agent-pr'])]
  assert.deepEqual(plan(pages).map(i => [i.number, i.stale]), [[1, ['agent-working', 'agent-pr']]])
  assert.equal(planItem(issue(3, 'closed', ['bug'])).stale.length, 0)
})

test('#738: the keep-list is a closed set, so a new label is not removed by accident', () => {
  // Only these five are ever removed; everything else is a record (bug, area:*, risk:*, hold, needs-*,
  // status:done). A status label added to the list without a test would widen the blast radius.
  assert.deepEqual(STALE_LABELS, ['agent-working', 'agent-pr', 'agent-ready', 'agent-task', 'awaiting-approval'])
  for (const keep of ['bug', 'area:ui', 'risk:T3', 'hold', 'needs-human', 'status:done']) assert.equal(STALE_LABELS.includes(keep), false)
})

test('#1401: a closed item that still carries hold loses only its status label', () => {
  const gh = fakeGh([issue(800, 'closed', ['hold', 'agent-working', 'bug', 'area:automation'])])
  const r = run(gh, true)
  assert.deepEqual(r.items.map(i => [i.number, i.stale]), [[800, ['agent-working']]])
  assert.deepEqual(gh.store[0].labels.map(l => l.name), ['hold', 'bug', 'area:automation'], 'hold is human-only, in both directions')
  assert.deepEqual(gh.deletes(), ['api -X DELETE repos/ThinkFlowLab/FlyBot/issues/800/labels/agent-working'])
})

test('#1401: closing an item is a trigger, and the daily sweep stays', () => {
  const wf = readFileSync(new URL('../workflows/label-hygiene.yml', import.meta.url), 'utf8')
  const triggers = wf.slice(wf.indexOf('\non:\n'), wf.indexOf('\nconcurrency:'))
  assert.match(triggers, /^ {2}issues:\n {4}types: \[closed\]$/m, 'a closed issue runs the same cleanup')
  assert.match(triggers, /^ {2}pull_request_target:\n {4}types: \[closed\]$/m, 'a closed pull request too, with the write token')
  // A `pull_request` run from a fork is read-only and could not remove the label it came for.
  assert.doesNotMatch(triggers, /^ {2}pull_request:\s*$/m)
  assert.match(triggers, /^ {2}schedule:\n {4}- cron: '30 19 \* \* \*'/m, 'the daily sweep stays')
  assert.match(triggers, /^ {2}workflow_dispatch:$/m, 'and the manual backfill stays')
  const perms = wf.slice(wf.indexOf('\npermissions:\n'), wf.indexOf('\njobs:')).trim().split('\n').map(line => line.trim())
  assert.deepEqual(perms, ['permissions:', 'contents: read', 'issues: write', 'pull-requests: write'], 'the close event adds no permission')
  assert.match(wf, /^ {2}group: label-hygiene$/m, 'one sweep at a time')
  assert.match(wf, /^ {2}cancel-in-progress: false$/m, 'a close must not cancel the sweep it needs')
  assert.match(wf, /run: node \.github\/scripts\/label-hygiene\.mjs --apply$/m, 'the close event runs the same --apply as the sweep')
})

test('#1418: a 422 is a refusal, not "already gone": the sweep continues and the read-back keeps the run red', () => {
  // The live shape from #1418: the label is still on the item after a 422 (job 122128075345, #1359).
  const gh = fakeGh([
    issue(1356, 'closed', ['agent-working']),
    issue(1359, 'closed', ['agent-pr']),
    issue(1400, 'closed', ['agent-working', 'bug']),
  ], {
    '1356/agent-working': {
      remove: false,
      stderr: 'gh: Validation Failed (HTTP 422)',
      stdout: '{"message":"Validation Failed","errors":[{"resource":"Issue","field":"labels","code":"unprocessable"}]}',
    },
  })
  const { result: r, lines } = capture(() => run(gh, true))
  assert.equal(gh.deletes().length, 3, 'the first refusal must not abandon the items behind it')
  assert.deepEqual(gh.store.find(i => i.number === 1356).labels.map(l => l.name), ['agent-working'], 'a 422 leaves its label on the item')
  assert.deepEqual(gh.store.filter(i => i.number !== 1356).map(i => i.labels.map(l => l.name)), [[], ['bug']], 'the other items are still cleaned')
  assert.deepEqual(r.skipped, [], 'a 422 is never reported as already gone')
  assert.deepEqual(r.failed.map(f => [f.number, f.name]), [[1356, 'agent-working']])
  assert.equal(r.ok, false, 'the label is still stale at the read-back')
  const text = lines.join('\n')
  assert.match(text, /label-hygiene: FAILED #1356 agent-working: Validation Failed \(HTTP 422\)/)
  assert.match(text, /"message":"Validation Failed"/, 'the response body is printed, not only the status line')
  assert.doesNotMatch(text, /label-hygiene: skip #1356/)
  assert.match(text, /label-hygiene: FAILED: #1356 \(agent-working:/, 'the failed summary is printed before the read-back')
  assert.match(text, /STILL STALE: #1356 \(agent-working\)/)
})

test('#1418: a 404 means the label is already gone: one skip line and a clean board is green', () => {
  const gh = fakeGh([
    issue(1356, 'closed', ['agent-working']),
    issue(1359, 'closed', ['agent-pr']),
  ], {
    '1356/agent-working': {
      stderr: 'gh: Not Found (HTTP 404)',
      stdout: '{"message":"Not Found","documentation_url":"https://docs.github.com/rest"}',
    },
  })
  const { result: r, lines } = capture(() => run(gh, true))
  assert.equal(gh.deletes().length, 2)
  assert.deepEqual(r.skipped.map(s => [s.number, s.name]), [[1356, 'agent-working']])
  assert.deepEqual(r.failed, [])
  assert.equal(r.ok, true, 'a label that was gone before the call does not fail the sweep')
  const text = lines.join('\n')
  assert.match(text, /label-hygiene: skip #1356 agent-working: already gone/)
  assert.doesNotMatch(text, /STILL STALE/)
})

test('#1418: an unexpected write failure is collected, the rest is cleaned, and the run names it and exits non-zero', () => {
  const gh = fakeGh([1354, 1356, 1358].map(n => issue(n, 'closed', ['agent-working', 'bug'])), {
    '1356/agent-working': {
      remove: false,
      stderr: 'gh: Server Error (HTTP 500)',
      stdout: '{"message":"Server Error"}',
    },
  })
  const { result: r, lines } = capture(() => run(gh, true))
  assert.equal(gh.deletes().length, 3)
  assert.deepEqual(r.failed.map(f => [f.number, f.name]), [[1356, 'agent-working']])
  assert.deepEqual(r.skipped, [])
  assert.equal(r.ok, false)
  assert.deepEqual(r.after.map(i => i.number), [1356], 'the label that really failed stays on the board')
  assert.deepEqual(gh.store.filter(i => i.number !== 1356).map(i => i.labels.map(l => l.name)), [['bug'], ['bug']])
  const text = lines.join('\n')
  assert.match(text, /FAILED #1356 agent-working: Server Error \(HTTP 500\)/)
  assert.match(text, /label-hygiene: FAILED: #1356 \(agent-working:/)
  assert.match(text, /STILL STALE: #1356 \(agent-working\)/)
})
