// label-hygiene (#738): a status label answers "what is happening right now", so a closed issue or a
// merged pull request must not keep one. These tests drive main() with a fake `gh`, the way
// merge-gate.mjs is tested: the fixtures are real API pages, and every removal is a recorded call.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { main, plan, planItem, STALE_LABELS } from './label-hygiene.mjs'

const issue = (number, state, labels, title = `Item ${number}`) =>
  ({ number, state, title, labels: labels.map(name => ({ name })) })

// A fake API over a page store: `GET repos/x/y/issues?state=closed&labels=<name>` filters like GitHub
// (state and one label), and a DELETE removes that label from the item. Every call is recorded.
const fakeGh = (items) => {
  const store = items.map(item => ({ ...item, labels: item.labels }))
  const calls = []
  const gh = (...args) => {
    const path = args[args.length - 1]
    calls.push(args.join(' '))
    if (args.includes('DELETE')) {
      const m = /\/issues\/(\d+)\/labels\/(.+)$/.exec(path)
      const item = store.find(i => String(i.number) === m[1])
      const name = decodeURIComponent(m[2])
      item.labels = item.labels.filter(l => l.name !== name)
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
