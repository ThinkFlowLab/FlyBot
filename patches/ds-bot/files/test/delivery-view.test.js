// The delivery board view (#1173): five columns from one snapshot, a read-only card, and the
// header numbers with the CI counted caveat. #1211 added the four states: loading with a counter,
// failed with a reason and a retry, stale with the old board and the reason beside it, partial with
// the part that was not read named. #1227 made the countdown move and the retry hints name their
// condition. The host module is tested in delivery-board.test.js.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// A clock the new tests can move. `wall.t === null` means "use the real one", which is how every
// test written before #1227 keeps reading real time.
const wall = { t: null }
class FakeDate extends Date {
  static now() { return wall.t ?? Date.now() }
}

// The timers the component may start. Nothing but a component under test asks for one, and only the
// new countdown test moves them.
const timers = {
  seq: 0, pending: new Map(),
  setInterval(fn, ms) { const id = ++timers.seq; timers.pending.set(id, { fn, ms }); return id },
  clearInterval(id) { timers.pending.delete(id) },
  tick(ms) { wall.t = (wall.t ?? Date.now()) + ms; for (const timer of [...timers.pending.values()]) timer.fn() },
}

// A tiny React with real hook slots, so a re-render can be observed (#1227). A component called
// directly, as the older tests do, still gets the old no-op setter: nothing changes for them.
const live = { frame: null, frames: new Map(), frameIndex: 0, effects: [], dirty: false }
const reactStub = {
  createElement: (type, props, ...children) => {
    const kids = children.flat(Infinity)
    if (typeof type !== 'function') return { type, props: props ?? {}, children: kids }
    const key = live.frameIndex++
    let frame = live.frames.get(key)
    if (!frame) { frame = { hooks: [], cleanups: [] }; live.frames.set(key, frame) }
    const outer = live.frame
    live.frame = frame
    frame.i = 0
    try { return type({ ...(props ?? {}), children: kids }) } finally { live.frame = outer }
  },
  useState(initial) {
    const frame = live.frame
    const value = typeof initial === 'function' ? initial() : initial
    if (!frame) return [value, () => {}]
    const index = frame.i++
    if (!(index in frame.hooks)) frame.hooks[index] = { value }
    const slot = frame.hooks[index]
    return [slot.value, next => { slot.value = typeof next === 'function' ? next(slot.value) : next; live.dirty = true }]
  },
  useEffect(fn, deps) {
    const frame = live.frame
    if (!frame) return
    const index = frame.i++
    const previous = frame.hooks[index]
    const same = previous && deps && previous.deps && deps.length === previous.deps.length
      && deps.every((dep, at) => Object.is(dep, previous.deps[at]))
    if (same) return
    frame.hooks[index] = { deps }
    live.effects.push(() => {
      if (typeof frame.cleanups[index] === 'function') frame.cleanups[index]()
      const cleanup = fn()
      frame.cleanups[index] = typeof cleanup === 'function' ? cleanup : null
    })
  },
}

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/delivery-view.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'node', write: false,
  external: ['react'],
})
const module = { exports: {} }
runInNewContext(bundle.outputFiles[0].text, {
  module, exports: module.exports, setTimeout, clearTimeout, Date: FakeDate, Promise, Number, Math, String, Array, Object,
  setInterval: timers.setInterval, clearInterval: timers.clearInterval,
  require: (name) => {
    if (name !== 'react') throw new Error(`no platform module ${name}`)
    return reactStub
  },
})

// Mount a component under that little React: render, run the effects, and render again while a
// setter fired during the pass marked the tree dirty.
const mount = (Component, props) => {
  live.frames = new Map()
  const draw = () => {
    let out = null
    for (let pass = 0; pass < 5; pass += 1) {
      live.dirty = false
      live.frameIndex = 0
      live.effects = []
      out = reactStub.createElement(Component, props)
      for (const effect of live.effects) effect()
      if (!live.dirty) break
    }
    return out
  }
  draw()
  return { draw, rerender: draw }
}
const {
  createPoller, DELIVERY_COLUMNS, DeliveryBoard, badgeLabel, duration, metricRows, pollDelay, retryCountdown,
  loadingText, staleText, hintFor, missingText, probeText,
} = module.exports

const text = (node) => {
  if (node === null || node === undefined || typeof node !== 'object') return String(node ?? '')
  return [node.props?.title ?? '', ...(node.children ?? []).map(text)].join(' ')
}
const walk = (node, out = []) => {
  if (node === null || typeof node !== 'object') return out
  out.push(node)
  for (const child of node.children ?? []) walk(child, out)
  return out
}
const buttons = (node) => walk(node).filter(item => item.type === 'button')

const snapshot = {
  asOf: '2026-10-25T04:00:00Z',
  columns: {
    raw: [{ kind: 'issue', number: 10, title: 'Untriaged', labels: ['bug'], url: 'https://x/10', owner: null }],
    ready: [{ kind: 'issue', number: 11, title: 'Ready', labels: ['agent-ready'], url: 'https://x/11', owner: 'Dev' }],
    working: [{ kind: 'issue', number: 12, title: 'Working', labels: ['agent-working'], url: 'https://x/12', linked: 41 }],
    review: [{ kind: 'pr', number: 41, title: 'Fix', labels: [], url: 'https://x/41', badge: 'inc', sha: 'abcdef1' }],
    'done-today': [{ kind: 'pr', number: 40, title: 'Merged', labels: [], url: 'https://x/40' }],
  },
  metrics: {
    dayStart: '2026-10-24T16:00:00.000Z',
    today: {
      newIssues: 4, closedIssues: 2, newPullRequests: 5, mergedPullRequests: 3,
      medianIssueCloseMs: 3_600_000, medianPullMergeMs: 90_000_000,
      ci: { failed: 2, total: 1200, counted: 1000, superseded: 3 },
    },
    week: {
      newIssues: 30, closedIssues: 20, newPullRequests: 40, mergedPullRequests: 25,
      medianIssueCloseMs: 7_200_000, medianPullMergeMs: 180_000_000,
      ci: { failed: 10, total: 10, counted: 10, superseded: 0 },
    },
    open: { issues: 54, pullRequests: 6, needsHuman: 4, medianIssueAgeMs: 259_200_000 },
  },
}

test('five delivery columns, localized labels, badge wording (#1173)', () => {
  assert.deepEqual([...DELIVERY_COLUMNS.map(column => column.id)], ['raw', 'ready', 'working', 'review', 'done-today'])
  assert.equal(badgeLabel('inc'), 'INC · rework')
  assert.equal(badgeLabel('pass-enqueue'), 'PASS · waiting for enqueue')
  assert.equal(badgeLabel('pass-merge'), 'PASS · waiting for merge')
  assert.equal(badgeLabel('ci-red'), 'CI red')
  assert.equal(badgeLabel('no-verdict'), 'No verdict')
  // Unreadable checks are their own badge, not "no verdict" (#1211).
  assert.equal(badgeLabel('checks-unknown'), 'Checks unknown')
  assert.equal(duration(45_000), '1m')
  assert.equal(duration(3_600_000), '1h')
  assert.equal(duration(90_000_000), '25h')
  assert.equal(duration(200_000_000), '2d')
  assert.equal(duration(null), '—')
})

test('the header carries today, the 7-day comparison, the CI caveat and open ages (#1173)', () => {
  const rows = metricRows(snapshot.metrics)
  // #1212 adds the CI red share as a seventh row: it draws a line like the counts, but as a ratio
  // it never carries a Σ total.
  assert.equal(rows.rows.length, 7)
  // #1212: every row carries the metric key the chart looks its series up by, so the expectation
  // names all six — the shape change is deliberate, not something to hide from the assertion.
  assert.deepEqual({ ...rows.rows[0] }, { key: 'newIssues', label: 'New issues', today: '4', week: '30' })
  assert.deepEqual({ ...rows.rows[4] }, { key: 'ci', label: 'CI red share', today: '0%', week: '100%' })
  assert.deepEqual({ ...rows.rows[5] }, { key: 'medianIssueCloseMs', label: 'Median issue close', today: '1h', week: '2h' })
  assert.deepEqual([...rows.rows.map(row => row.key)],
    ['newIssues', 'closedIssues', 'newPullRequests', 'mergedPullRequests', 'ci', 'medianIssueCloseMs', 'medianPullMergeMs'])
  assert.equal(rows.ci.failed, 2)
  assert.equal(rows.ci.total, 1200)
  assert.equal(rows.ci.caveat, true)
  assert.equal(rows.ci.superseded, 3)
  assert.equal(rows.open.needsHuman, 4)
})

test('the CI red share reaches the page as a line, and the medians draw none (#1212)', () => {
  // A key the table has no row for would draw no line: the CI share has to be a row, not a key only
  // the chart knows about.
  const daily = [
    { date: '2026-10-19', newIssues: 1, closedIssues: 1, newPullRequests: 1, mergedPullRequests: 0, ci: { failed: 0, counted: 10 } },
    { date: '2026-10-20', newIssues: 2, closedIssues: 1, newPullRequests: 1, mergedPullRequests: 1, ci: { failed: 2, counted: 10 } },
    { date: '2026-10-21', newIssues: 0, closedIssues: 3, newPullRequests: 2, mergedPullRequests: 1, ci: { failed: 1, counted: 4 } },
    { date: '2026-10-22', newIssues: 4, closedIssues: 2, newPullRequests: 0, mergedPullRequests: 2, ci: { failed: null, counted: null } },
    { date: '2026-10-23', newIssues: 3, closedIssues: 3, newPullRequests: 1, mergedPullRequests: 1, ci: { failed: 0, counted: 8 } },
    { date: '2026-10-24', newIssues: 5, closedIssues: 4, newPullRequests: 3, mergedPullRequests: 2, ci: { failed: 3, counted: 12 } },
    { date: '2026-10-25', partial: true, newIssues: 4, closedIssues: 2, newPullRequests: 5, mergedPullRequests: 3, ci: { failed: 2, counted: 10 } },
  ]
  const board = DeliveryBoard({ snapshot: { ...snapshot, metrics: { ...snapshot.metrics, daily } }, message: '' })
  const charts = walk(board).filter(node => node.props?.className === 'bt-del-chart')
  assert.deepEqual([...charts.map(node => node.props['data-metric'])],
    ['newIssues', 'closedIssues', 'newPullRequests', 'mergedPullRequests', 'ci'])
  const rows = walk(board).filter(node => node.props?.className === 'bt-del-dm-row')
  const ciRow = rows.find(node => node.props['data-metric'] === 'ci')
  assert.ok(ciRow, 'the CI share is a row of the table, not only a chart key')
  // A share of the week, never a sum.
  assert.match(text(ciRow), /100%/)
  assert.equal(text(ciRow).includes('Σ'), false)
  // Medians cannot be added up and get no chart at all.
  for (const key of ['medianIssueCloseMs', 'medianPullMergeMs']) {
    const row = rows.find(node => node.props['data-metric'] === key)
    assert.equal(walk(row).some(node => node.props?.className === 'bt-del-chart'), false)
  }
})

test('the board renders all five columns and a card with labels, owner and link (#1173)', () => {
  const board = DeliveryBoard({ snapshot: { ...snapshot, columns: snapshot.columns }, message: '' })
  const sections = walk(board).filter(node => node.type === 'section' && node.props?.['data-column'])
  assert.deepEqual([...sections.map(node => node.props['data-column'])], ['raw', 'ready', 'working', 'review', 'done-today'])
  const review = sections.find(node => node.props['data-column'] === 'review')
  assert.equal(review.children[0].children[1].children[0], '1')
  const card = walk(review).find(node => node.props?.['data-badge'] === 'inc')
  const words = text(card)
  assert.match(words, /Fix/)
  assert.match(words, /INC · rework/)
  assert.match(words, /abcdef1/)
  const workingCard = walk(sections.find(node => node.props['data-column'] === 'working')).find(node => node.type === 'article')
  assert.match(text(workingCard), /linked to #41/)
  assert.ok(walk(workingCard).some(node => node.type === 'a' && node.props.href === 'https://x/12'))
  // A person is rendered as a person, not as a Bot.
  const owner = walk(workingCard).concat(walk(sections.find(node => node.props['data-column'] === 'ready'))).find(node => node.props?.className === 'bt-del-owner')
  assert.equal(owner.props['data-kind'], 'human')
})

test('an honest message replaces the board when there is no GitHub connection (#1173)', () => {
  const board = DeliveryBoard({ snapshot: null, message: 'No GitHub connection yet; the board fills in once one is added.' })
  assert.match(text(board), /No GitHub connection yet/)
  assert.equal(walk(board).some(node => node.type === 'section'), false)
})

test('"no snapshot yet" belongs to a host that has never tried (#1211)', () => {
  const idle = DeliveryBoard({ view: { state: 'idle' } })
  assert.match(text(idle), /No snapshot yet\./)
  assert.equal(idle.props['data-state'], 'idle')
  // Every other state has its own words; none of them says "no snapshot".
  for (const state of ['loading', 'failed', 'stale', 'partial']) {
    const view = state === 'loading' ? { state, elapsedMs: 12_000 }
      : state === 'failed' ? { state, error: { message: 'GitHub answered 404 for /repos/o/r/issues', status: 404, kind: 'not-found', scope: 'issues' } }
        : state === 'stale' ? { ...snapshot, state, error: { message: 'GitHub answered 404 for /repos/o/r/actions/runs', status: 404, kind: 'not-found', scope: 'actions' } }
          : { ...snapshot, state, missing: [{ part: 'ci', message: 'GitHub answered 404 for /repos/o/r/actions/runs', status: 404, kind: 'not-found', scope: 'actions' }] }
    assert.doesNotMatch(text(DeliveryBoard({ view })), /No snapshot yet/, `${state} must not reuse it`)
  }
})

test('loading counts the seconds and promises the columns (#1211)', () => {
  const board = DeliveryBoard({ view: { state: 'loading', elapsedMs: 12_000 } })
  assert.equal(loadingText(12_000), 'First load in progress, 12 s elapsed')
  assert.match(text(board), /First load in progress, 12 s elapsed/)
  assert.equal(walk(board).some(node => node.type === 'section'), false, 'no half-built columns')
  assert.equal(pollDelay('loading'), 2_000)
  assert.equal(pollDelay('idle'), 2_000)
  // A failed read is scheduled by the host's `retryAt`, not by a fixed minute (#1211): the old
  // assertion here pinned 60_000 for `failed`, which is what made the 10 s / 30 s levels dead code.
  const now = Date.parse('2026-10-25T04:00:00Z')
  assert.equal(pollDelay('failed', { retryAt: now + 10_000 }, now), 10_000)
  assert.equal(pollDelay('failed', { retryAt: now + 120_000 }, now), 120_000, 'the 2 min level is not flattened to a minute')
  assert.equal(pollDelay('stale', { retryAt: now + 30_000 }, now), 30_000, 'a stale board waits for the same retry')
  assert.equal(pollDelay('failed', { retryAt: now - 5_000 }, now), 1_000, 'a past retryAt does not spin')
  for (const state of ['fresh', 'stale', 'partial', 'failed']) assert.equal(pollDelay(state, { retryAt: null }, now), 60_000, `${state} polls slowly`)
})

test('a failed round names the endpoint, the advice and a retry button (#1211)', () => {
  const error = { message: 'GitHub answered 404 for /repos/o/r/actions/runs', endpoint: '/repos/o/r/actions/runs', status: 404, kind: 'not-found', scope: 'actions', at: '2026-10-25T04:00:00Z' }
  let retried = 0
  const board = DeliveryBoard({ view: { state: 'failed', error }, repo: 'o/r', onRetry: () => { retried += 1 } })
  const words = text(board)
  assert.match(words, /GitHub answered 404 for \/repos\/o\/r\/actions\/runs/)
  assert.match(words, /Give the token Actions: Read\./)
  const retry = buttons(board).find(button => text(button).trim() === 'Retry')
  assert.ok(retry, 'there is a retry button')
  retry.props.onClick()
  assert.equal(retried, 1)
  assert.equal(board.props['data-state'], 'failed')
})

test('the five failures do not borrow each other\'s words (#1211)', () => {
  const hint = (error) => hintFor(error, { repo: 'o/r' })
  assert.match(hint({ kind: 'no-token' }), /GITHUB_TOKEN/)
  assert.match(hint({ kind: 'no-token' }), /o\/r/)
  assert.match(hint({ kind: 'not-found', scope: 'repo' }), /Check the repository name, and that the token can see o\/r/)
  assert.match(hint({ kind: 'not-found', scope: 'actions' }), /Actions: Read/)
  assert.match(hint({ kind: 'not-found', scope: 'checks' }), /Checks: Read/)
  assert.match(hint({ kind: 'not-found', scope: 'comments' }), /Issues: Read/)
  assert.match(hint({ kind: 'timeout' }), /did not answer in time/)
  // A wait is printed only when GitHub gave one: no invented "60 seconds".
  assert.match(hint({ kind: 'rate-limit', retryAfterMs: null }), /10 s → 30 s → 2 min/)
  assert.doesNotMatch(hint({ kind: 'rate-limit', retryAfterMs: null }), /\b60\b/)
  assert.match(hint({ kind: 'rate-limit', retryAfterMs: 30_000 }), /in 30 s/)
})

test('a stale board keeps the columns and hangs the reason beside them (#1211)', () => {
  const error = { message: 'GitHub answered 404 for /repos/o/r/actions/runs', endpoint: '/repos/o/r/actions/runs', status: 404, kind: 'not-found', scope: 'actions' }
  const view = { ...snapshot, state: 'stale', error, stale: true }
  const board = DeliveryBoard({ view, repo: 'o/r', onRetry: () => {} })
  assert.equal(walk(board).filter(node => node.type === 'section' && node.props?.['data-column']).length, 5, 'the old board is still rendered')
  const words = text(board)
  assert.match(words, /Showing the snapshot from/)
  assert.match(words, /refresh failed: GitHub answered 404 for \/repos\/o\/r\/actions\/runs/)
  assert.match(staleText('2026-10-25T04:00:00Z', error), /Showing the snapshot from /)
})

test('a partial board names the part that was not read, and CI says unknown not zero (#1211)', () => {
  const missing = [{ part: 'ci', message: 'GitHub answered 404 for /repos/o/r/actions/runs', status: 404, kind: 'not-found', scope: 'actions' }]
  const metrics = { ...snapshot.metrics, today: { ...snapshot.metrics.today, ci: null } }
  const view = { ...snapshot, metrics, state: 'partial', missing, partial: true }
  const board = DeliveryBoard({ view })
  const words = text(board)
  assert.match(words, /CI data was not fetched this time/)
  assert.match(words, /CI not available this time/)
  assert.doesNotMatch(words, /CI failed 0 of 0/)
  assert.equal(walk(board).filter(node => node.type === 'section' && node.props?.['data-column']).length, 5)
  // The rows whose numbers were read still show; the CI one is the only unknown.
  const rows = metricRows(metrics)
  assert.equal(rows.ci, null)
  assert.equal(rows.rows[0].today, '4')
  assert.match(missingText(missing[0]), /\/repos\/o\/r\/actions\/runs/)
})

test('the diagnostic report prints the five lines the CLI prints (#1211)', () => {
  const report = {
    repo: 'o/r', at: '2026-10-25T04:00:00Z',
    rows: [
      { key: 'repo', ok: true, status: 200, endpoint: '/repos/o/r' },
      { key: 'actions', ok: false, status: 404, endpoint: '/repos/o/r/actions/runs', kind: 'not-found' },
    ],
  }
  const output = probeText(report)
  assert.match(output, /ok 200 {2}\/repos\/o\/r/)
  assert.match(output, /FAIL 404 {2}\/repos\/o\/r\/actions\/runs {2}not-found/)
})

// A fake clock and a fake timer queue: the cadence is read off the timers the poller asks for, not
// off the wall clock, so the test is about the schedule and nothing else (#1211).
function clock(start = Date.parse('2026-10-25T04:00:00Z')) {
  let at = start
  let seq = 0
  const timers = new Map()
  return {
    now: () => at,
    setTimer: (fn, ms) => { const id = ++seq; timers.set(id, { at: at + ms, fn }); return id },
    clearTimer: id => { timers.delete(id) },
    pending: () => [...timers.values()].map(timer => timer.at - at),
    // Advance to the earliest due timer, run it, and report how far time moved.
    advance: async () => {
      const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0]
      if (!next) return null
      const [id, timer] = next
      timers.delete(id)
      at = Math.max(at, timer.at)
      timer.fn()
      await new Promise(resolve => setImmediate(resolve))
      return at - start
    },
  }
}

test('a failed round retries on the host backoff, not on a fixed minute (#1211)', async () => {
  const c = clock()
  // A host that refuses for three rounds — 10 s, then 30 s, then two minutes — and counts the
  // rounds it actually started. The client may read more often; only the rounds matter.
  const backoff = [10_000, 30_000, 120_000]
  let rounds = 0
  let nextAt = 0
  const started = []
  const load = async () => {
    const now = c.now()
    if (now < nextAt) return { state: 'failed', error: { message: 'still cooling down', kind: 'network', endpoint: null, status: null, at: null }, retryAt: nextAt }
    started.push(now - Date.parse('2026-10-25T04:00:00Z'))
    nextAt = now + (backoff[Math.min(rounds, backoff.length - 1)])
    rounds += 1
    return { state: 'failed', error: { message: 'GitHub answered 503', kind: 'server', endpoint: '/repos/o/r', status: 503, at: null }, retryAt: nextAt }
  }
  const views = []
  const poller = createPoller({ load, onView: view => views.push(view.state), now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer })
  poller.start()
  await new Promise(resolve => setImmediate(resolve))
  // Three advances is exactly the three backoff levels: 10 s, 30 s, then the two-minute one.
  for (let i = 0; i < 3; i += 1) await c.advance()

  // The rounds the host really started: now, 10 s, 40 s (30 s later), 160 s (2 min later).
  assert.deepEqual(started, [0, 10_000, 40_000, 160_000], 'each backoff level produces its own request')
  assert.equal(rounds, 4)
  // The screen was told about every read, and a failed read always renders as failed, never as fresh.
  assert.ok(views.length >= 4)
  assert.ok(views.every(state => state === 'failed'))
  poller.stop()
})

test('Retry paints loading at once and forces the read (#1211)', async () => {
  const c = clock()
  const calls = []
  let release = null
  const load = async (force) => {
    calls.push(force)
    if (!force) return { state: 'failed', error: { message: 'GitHub answered 503', kind: 'server', endpoint: '/repos/o/r', status: 503, at: null }, retryAt: c.now() + 120_000 }
    await new Promise(resolve => { release = resolve })
    return { state: 'fresh', columns: {}, metrics: null }
  }
  const views = []
  const poller = createPoller({ load, onView: view => views.push(view.state), now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer })
  poller.start()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(views, ['failed'])
  assert.deepEqual(calls, [false])

  poller.retry({ state: 'failed', error: { message: 'GitHub answered 503' } })
  // The screen changes before the request comes back: that is what the button looked dead without.
  assert.equal(views.at(-1), 'loading')
  assert.deepEqual(calls, [false, true])
  release()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(views.at(-1), 'fresh')
  poller.stop()
})

test('the countdown is the host retryAt, and it says so when there is none (#1211)', () => {
  const now = Date.parse('2026-10-25T04:00:00Z')
  assert.equal(retryCountdown(now + 12_400, now), 12)
  assert.equal(retryCountdown(now - 1_000, now), 0)
  assert.equal(retryCountdown(null, now), null)
  // The component counts from the real clock, so the fixture's retryAt is relative to it too.
  const board = DeliveryBoard({
    view: { state: 'failed', error: { message: 'GitHub answered 503', kind: 'server', endpoint: '/repos/o/r', status: 503, at: null }, retryAt: Date.now() + 30_000 },
    onRetry: () => {},
  })
  assert.match(text(board), /Retrying in 30 s/)
  const withoutAt = DeliveryBoard({ view: { state: 'failed', error: { message: 'offline', kind: 'network' } }, onRetry: () => {} })
  assert.match(text(withoutAt), /retries on its own/)
  assert.doesNotMatch(text(withoutAt), /Retrying in/)
})

test('the failure countdown moves every second, and only while a retry is scheduled (#1227)', () => {
  wall.t = Date.parse('2026-10-25T04:00:00Z')
  timers.pending.clear()
  const failed = {
    state: 'failed',
    error: { message: 'GitHub answered 503', kind: 'server', endpoint: '/repos/o/r', status: 503, at: null },
    retryAt: wall.t + 120_000,
  }
  const board = mount(DeliveryBoard, { view: failed, onRetry: () => {} })
  assert.match(text(board.draw()), /Retrying in 120 s/, 'the host gave two minutes, so the screen says 120')
  timers.tick(1_000)
  assert.match(text(board.draw()), /Retrying in 119 s/, 'the number moves when the second passes')
  // One timer, one second: the countdown is a promise about the screen, not about the request.
  assert.equal(timers.pending.size, 1, 'exactly one timer while a retry is scheduled')
  assert.equal([...timers.pending.values()][0].ms, 1_000, 'the countdown timer is a one-second one')

  timers.tick(118_000)
  assert.match(text(board.draw()), /Retrying in 1 s/, 'and it keeps moving down to the last second')

  // A screen with nothing scheduled gets no timer at all, so a fresh board does not tick.
  timers.pending.clear()
  const fresh = mount(DeliveryBoard, { view: { ...snapshot, state: 'fresh' } })
  fresh.draw()
  assert.equal(timers.pending.size, 0, 'a fresh board does not tick')
  wall.t = null
})

test('the rate-limit and timeout hints name the page as the condition (#1227)', () => {
  const rateLimitNoNumber = hintFor({ kind: 'rate-limit', retryAfterMs: null })
  assert.match(rateLimitNoNumber, /while this page is open it retries on its own/)
  const rateLimitNumber = hintFor({ kind: 'rate-limit', retryAfterMs: 30_000 })
  assert.match(rateLimitNumber, /while this page is open it retries on its own in 30 s/)
  const timeout = hintFor({ kind: 'timeout' })
  assert.match(timeout, /the next attempt happens while this page is open/)

  // Every "retries on its own" the client can print says who is doing the retrying: the open page.
  // Nobody else does — the host installs no timer (#1173).
  for (const file of ['src/client/delivery-view.js', 'src/client/i18n.js']) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
    for (const line of source.split('\n')) {
      if (!/retries on its own|next attempt/.test(line)) continue
      if (/^\s*\/\//.test(line)) continue
      assert.match(line, /this page is open|页面开着时|页面开着/, `${file}: ${line.trim()}`)
    }
  }
})
