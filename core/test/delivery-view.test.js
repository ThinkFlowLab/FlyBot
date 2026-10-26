// The delivery board view (#1173): five columns from one snapshot, a read-only card, and the
// header numbers with the CI counted caveat. #1211 added the four states: loading with a counter,
// failed with a reason and a retry, stale with the old board and the reason beside it, partial with
// the part that was not read named. The host module is tested in delivery-board.test.js.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/delivery-view.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'node', write: false,
  external: ['react'],
})
const module = { exports: {} }
runInNewContext(bundle.outputFiles[0].text, {
  module, exports: module.exports, setTimeout, clearTimeout, setInterval, clearInterval, Date, Promise, Number, Math, String, Array, Object,
  require: (name) => {
    if (name !== 'react') throw new Error(`no platform module ${name}`)
    return {
      createElement: (type, props, ...children) => {
        const kids = children.flat(Infinity)
        if (typeof type === 'function') return type({ ...(props ?? {}), children: kids })
        return { type, props: props ?? {}, children: kids }
      },
      useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
      useEffect: () => {},
    }
  },
})
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
  assert.equal(rows.rows.length, 6)
  assert.deepEqual({ ...rows.rows[0] }, { label: 'New issues', today: '4', week: '30' })
  assert.deepEqual({ ...rows.rows[4] }, { label: 'Median issue close', today: '1h', week: '2h' })
  assert.equal(rows.ci.failed, 2)
  assert.equal(rows.ci.total, 1200)
  assert.equal(rows.ci.caveat, true)
  assert.equal(rows.ci.superseded, 3)
  assert.equal(rows.open.needsHuman, 4)
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
  assert.equal(pollDelay('failed', { retryAt: now + 120_000 }, now), 60_000, 'a retryAt further out is looked at once a minute, not skipped')
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
  // Four reads to reach the two-minute round: 10 s, 30 s, a 60 s look that starts nothing because the
  // host is still cooling down, and then the round at its own 160 s mark.
  for (let i = 0; i < 4; i += 1) await c.advance()

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
