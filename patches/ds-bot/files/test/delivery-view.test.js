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
  createPoller, DELIVERY_COLUMNS, DeliveryBoard, DeliveryHeader, badgeLabel, duration, metricRows, pollDelay, retryCountdown,
  loadingText, staleText, hintFor, missingText, probeText, stagesOf,
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

// #1326: the host draws the definition's three lanes; `review` and `done-today` are stages a card
// carries, not lanes of their own.
const threeLane = {
  ...snapshot,
  columns: {
    'not-started': [
      { kind: 'issue', number: 10, title: 'Untriaged', labels: ['bug'], url: 'https://x/10', owner: null },
      { kind: 'issue', number: 11, title: 'Ready', labels: ['agent-ready'], url: 'https://x/11', owner: 'Dev' },
    ],
    'in-progress': [
      { kind: 'issue', number: 12, title: 'Working', labels: ['agent-working'], url: 'https://x/12', linked: 41 },
      { kind: 'pr', number: 41, title: 'Fix', labels: [], url: 'https://x/41', badge: 'inc', sha: 'abcdef1', stage: 'review' },
    ],
    done: [{ kind: 'pr', number: 40, title: 'Merged', labels: [], url: 'https://x/40', stage: 'done-today' }],
  },
}

test('three delivery columns, localized labels, badge wording (#1173, #1326)', () => {
  assert.deepEqual([...DELIVERY_COLUMNS.map(column => column.id)], ['not-started', 'in-progress', 'done'])
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

test('a day the host could only count by total reads the same share in the row as on the line (#1244)', () => {
  // The header row required `counted`, so a day with `counted: 0, total: 5` printed '—' while the
  // 7-day line beside it drew a dot from `total`: one day, two answers. The row now uses the same
  // denominator the chart draws.
  const countedByTotal = { date: '2026-10-25', partial: true, newIssues: 3, closedIssues: 1, newPullRequests: 0, mergedPullRequests: 0, ci: { failed: 1, counted: 0, total: 5 } }
  const metrics = {
    ...snapshot.metrics,
    today: { ...snapshot.metrics.today, ci: countedByTotal.ci },
    daily: [countedByTotal],
  }
  const rows = metricRows(metrics)
  assert.equal(rows.rows[4].today, '20%', 'one red run of five is 20%, not unknown')
  // The denominator the chart uses for that same day (delivery-chart.test.js pins the number).
  assert.equal(countedByTotal.ci.failed / countedByTotal.ci.total, 0.2)
  // A window with no runs at all still has no share: unknown is not 0%, and it is not a dot either.
  assert.equal(metricRows({ ...metrics, today: { ...snapshot.metrics.today, ci: { failed: 0, counted: 0, total: 0 } } }).rows[4].today, '—')
})

test('a partial day prints its time once, in the task zone, instead of twice (#1244)', async () => {
  // #1244: the paragraph printed `as of {timeOf}` and then appended a hint carrying its own
  // `clockOf` of the same instant — the time twice, and from two different renderings. The hint now
  // follows the single time, and that time is the hint's own zone rendering.
  const daily = [
    { date: '2026-10-19', newIssues: 1, closedIssues: 1, newPullRequests: 1, mergedPullRequests: 0, ci: { failed: 0, counted: 10 } },
    { date: '2026-10-20', newIssues: 2, closedIssues: 1, newPullRequests: 1, mergedPullRequests: 1, ci: { failed: 2, counted: 10 } },
    { date: '2026-10-21', newIssues: 0, closedIssues: 3, newPullRequests: 2, mergedPullRequests: 1, ci: { failed: 1, counted: 4 } },
    { date: '2026-10-22', newIssues: 4, closedIssues: 2, newPullRequests: 0, mergedPullRequests: 2, ci: { failed: null, counted: null } },
    { date: '2026-10-23', newIssues: 3, closedIssues: 3, newPullRequests: 1, mergedPullRequests: 1, ci: { failed: 0, counted: 8 } },
    { date: '2026-10-24', newIssues: 5, closedIssues: 4, newPullRequests: 3, mergedPullRequests: 2, ci: { failed: 3, counted: 12 } },
    { date: '2026-10-25', partial: true, newIssues: 4, closedIssues: 2, newPullRequests: 5, mergedPullRequests: 3, ci: { failed: 2, counted: 10 } },
  ]
  const snapshotWith = dailySeries => ({ ...snapshot, metrics: { ...snapshot.metrics, daily: dailySeries } })
  const asOfText = (Component, input) => {
    const paragraph = walk(Component({ snapshot: input })).find(node => node.props?.className === 'bt-del-asof')
    assert.ok(paragraph, 'the header carries an as-of line')
    return text(paragraph).replace(/\s+/g, ' ').trim()
  }
  const times = words => [...words.matchAll(/\d{1,2}:\d{2}/g)].length

  const english = asOfText(DeliveryHeader, snapshotWith(daily))
  assert.equal(times(english), 1, `one time string, got: ${english}`)
  assert.match(english, /today is partial/)
  // The same paragraph in Chinese, through the same bundled module: the duplicate 截至 is gone too.
  const { DeliveryHeader: DeliveryHeaderZh, installLocale } = await build({
    stdin: {
      contents: `export { DeliveryHeader } from ${JSON.stringify(fileURLToPath(new URL('../src/client/delivery-view.js', import.meta.url)))}\nexport { installLocale } from ${JSON.stringify(fileURLToPath(new URL('../src/client/i18n.js', import.meta.url)))}`,
      resolveDir: fileURLToPath(new URL('../src/client/', import.meta.url)),
      loader: 'js',
    },
    bundle: true, format: 'cjs', platform: 'node', write: false, external: ['react'],
  }).then(async out => {
    const module = { exports: {} }
    runInNewContext(out.outputFiles[0].text, {
      module, exports: module.exports, setTimeout, clearTimeout, Date: FakeDate, Promise, Number, Math, String, Array, Object,
      setInterval: timers.setInterval, clearInterval: timers.clearInterval,
      require: (name) => {
        if (name !== 'react') throw new Error(`no platform module ${name}`)
        return reactStub
      },
    })
    return module.exports
  })
  const dictionaries = new Map()
  const off = installLocale({
    register: (namespace, locale, dict) => { dictionaries.set(`${namespace}:${locale}`, dict); return () => dictionaries.delete(`${namespace}:${locale}`) },
    bind: namespace => (key, params) => {
      const words = dictionaries.get(`${namespace}:zh`)?.[key] ?? key
      return params ? words.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match)) : words
    },
    getLocale: () => ({ active: 'zh' }),
  })
  try {
    const chinese = asOfText(DeliveryHeaderZh, snapshotWith(daily))
    assert.equal(times(chinese), 1, `one time string, got: ${chinese}`)
    assert.match(chinese, /今天为部分日/)
    assert.equal((chinese.match(/截至/g) ?? []).length, 1, 'the hint no longer repeats 截至')
  } finally {
    off()
  }
  // A finished day keeps the local-clock rendering and gains no hint at all.
  const finished = asOfText(DeliveryHeader, snapshotWith(daily.map(day => ({ ...day, partial: false }))))
  assert.equal(times(finished), 1)
  assert.equal(finished.includes('today is partial'), false)
})

test('the board renders all five columns and a card with labels, owner and link (#1173)', () => {
  const board = DeliveryBoard({ snapshot: { ...snapshot, repo: 'o/r', columns: snapshot.columns }, message: '' })
  const sections = walk(board).filter(node => node.type === 'section' && node.props?.['data-column'])
  assert.deepEqual([...sections.map(node => node.props['data-column'])], ['raw', 'ready', 'working', 'review', 'done-today'])
  const review = sections.find(node => node.props['data-column'] === 'review')
  assert.equal(review.children[0].children[1].children[0], '1')
  const card = walk(review).find(node => node.props?.['data-badge'] === 'inc')
  // The card names its source and its repository-scoped identity (#1265 step 1): one issue is one
  // card, keyed `owner/name#number`, whichever row of the snapshot it arrived in.
  assert.equal(card.props['data-source'], 'github')
  assert.equal(card.props['data-key'], 'o/r#41')
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

test('the header says whose repository this is, and where the name came from (#1250)', () => {
  const lineOf = payload => walk(DeliveryBoard({ snapshot: { ...snapshot, ...payload }, message: '' }))
    .find(node => node.props?.className === 'bt-del-repo')
  const configured = lineOf({ repo: 'acme/widget', repoSource: 'config' })
  assert.equal(configured.props['data-repo'], 'acme/widget')
  assert.equal(configured.props['data-repo-source'], 'config')
  assert.match(text(configured), /acme\/widget/)
  assert.match(text(configured), /config/)
  // The remote is named as where the host looked, not as something the person set.
  const remote = lineOf({ repo: 'acme/widget', repoSource: 'remote' })
  assert.equal(remote.props['data-repo-source'], 'remote')
  assert.match(text(remote), /remote/)
  // A package default reaches the page labelled as one: that is the whole difference between an
  // instance showing its own numbers and showing ours.
  const packaged = lineOf({ repo: 'ThinkFlowLab/FlyBot', repoSource: 'package' })
  assert.equal(packaged.props['data-repo-source'], 'package')
  assert.match(text(packaged), /default/)
  // The Diagnose block names the same repository and source the header does.
  assert.match(probeText({ repo: 'acme/widget', repoSource: 'config', at: '2026-10-26T00:00:00Z', rows: [] }),
    /acme\/widget · config/)
})

test('an unknown open count is —, a real zero is 0 (#1297 INC)', () => {
  const zero = {
    ...snapshot,
    metrics: { ...snapshot.metrics, open: { issues: 0, pullRequests: 0, needsHuman: 0, medianIssueAgeMs: null } },
  }
  assert.match(text(DeliveryHeader({ view: zero })), /Open: 0 issues/)
  // A partial board answers `metrics: null` (#1297 INC): no repository could be counted, so the
  // header prints '—' rather than a zero it never read. Same rule as an unreadable CI number.
  const unknown = {
    ...snapshot,
    state: 'partial',
    partial: true,
    metrics: null,
    repos: [
      { ...snapshot, repo: 'acme/one', repoSource: 'config' },
      { ok: false, state: 'failed', repo: 'acme/two', repoSource: 'config' },
    ],
  }
  const words = text(DeliveryHeader({ view: unknown }))
  assert.match(words, /2 repositories/)
  assert.match(words, /Open: — issues/)
  assert.doesNotMatch(words, /Open: 0 issues/)
})

test('a host that cannot name a repository says so, and does not send the person to a token (#1250)', () => {
  const error = { message: 'no repository — set delivery.repo', kind: 'no-repo', scope: 'repo', endpoint: null, status: null, at: null }
  assert.equal(hintFor(error, { repo: null }),
    'Set delivery.repo in this instance\'s settings to the repository this instance works in.')
  const board = DeliveryBoard({ view: { state: 'failed', repo: null, repoSource: null, error, retryAt: null }, repo: null })
  const words = text(board)
  assert.match(words, /no repository — set delivery\.repo/)
  assert.match(words, /Set delivery\.repo/)
  // Missing settings is not a missing credential; pointing at GITHUB_TOKEN would be the wrong fix.
  assert.doesNotMatch(words, /GITHUB_TOKEN/)
})

// #1265 step 4: one board with more than one repository. A repository keeps its own block, its own
// columns and its own state, and one that cannot be read no longer empties the page.
const repoSample = (repo, extra = {}) => ({
  repo, repoSource: 'config', state: 'fresh', ok: true, asOf: '2026-10-25T04:00:00Z',
  columns: {
    'not-started': [{ kind: 'issue', number: 10, title: `${repo} untriaged`, labels: [], url: `https://x/${repo}/10`, repo }],
    'in-progress': [],
    'done': [],
  },
  metrics: {
    dayStart: '2026-10-24T16:00:00.000Z',
    today: { newIssues: 1, closedIssues: 0, newPullRequests: 0, mergedPullRequests: 0, medianIssueCloseMs: null, medianPullMergeMs: null, ci: { failed: 0, total: 2, counted: 2, superseded: 0 } },
    week: { newIssues: 2, closedIssues: 0, newPullRequests: 0, mergedPullRequests: 0, medianIssueCloseMs: null, medianPullMergeMs: null, ci: { failed: 0, total: 2, counted: 2, superseded: 0 } },
    daily: null,
    open: { issues: 1, pullRequests: 0, needsHuman: 0, medianIssueAgeMs: null },
  },
  ...extra,
})

test('the visible columns come from the payload through one entry point (#1265, #1326)', () => {
  // The payload names the columns it has; the default is the definition's three lanes.
  assert.equal(stagesOf({ columns: threeLane.columns }).map(column => column.id).join('|'), 'not-started|in-progress|done')
  // An id this build has no label for still renders under its own id rather than disappearing.
  assert.equal(stagesOf({ columns: { review: [], triage: [] } }).map(column => column.id).join('|'), 'review|triage')
  assert.equal(stagesOf({}).map(column => column.id).join('|'), DELIVERY_COLUMNS.map(column => column.id).join('|'))
})

test('#1326: the stages that draw no lane are filters, and a filter narrows without reordering', () => {
  const board = mount(DeliveryBoard, { snapshot: threeLane, message: '' })
  // The definition ships three lanes; review and done-today are stages, so no fourth or fifth lane.
  const lanes = (tree) => walk(tree).filter(node => node.type === 'section' && node.props?.['data-column']).map(node => node.props['data-column'])
  assert.deepEqual(lanes(board.draw()), ['not-started', 'in-progress', 'done'])
  const bar = walk(board.draw()).find(node => node.props?.className === 'bt-del-filters')
  assert.ok(bar, 'the board draws one filter bar')
  const filterButtons = walk(bar).filter(node => node.type === 'button')
  assert.deepEqual(filterButtons.map(node => node.props['data-filter']), ['all', 'review', 'done-today'])
  assert.deepEqual(filterButtons.map(node => node.props['aria-pressed']), ['true', 'false', 'false'])
  // A finished card keeps the stage it came with, so a stage assertion needs no fifth lane.
  const done = walk(board.draw()).find(node => node.type === 'section' && node.props?.['data-column'] === 'done')
  assert.equal(walk(done).some(node => node.props?.['data-stage'] === 'done-today'), true)
  // Pressing a filter narrows the cards and leaves the columns in their order.
  filterButtons[1].props.onClick()
  const reviewOnly = board.draw()
  assert.deepEqual(lanes(reviewOnly), ['not-started', 'in-progress', 'done'])
  const pressed = walk(reviewOnly).find(node => node.props?.className === 'bt-del-filters')
  assert.deepEqual(walk(pressed).filter(node => node.type === 'button').map(node => node.props['aria-pressed']), ['false', 'true', 'false'])
  const shown = walk(reviewOnly).filter(node => node.type === 'section' && node.props?.['data-column']).map(node => walk(node).filter(item => item.props?.['data-number']).map(item => item.props['data-number']))
  assert.deepEqual(shown, [[], [41], []])
})

test('#1326: a task card is the shared card, and a drop only asks the board to move it', () => {
  const moved = []
  const board = mount(DeliveryBoard, {
    view: { ...threeLane, state: 'fresh' },
    tasks: [{ id: 'task-abc123456', title: 'Draft the note', status: 'working', ownerBotId: 's', column: 'in-progress', priority: 'high' }],
    roster: { byId: { s: { name: 'Writer' } } },
    dragging: 'task-abc123456',
    onMove: (id, column) => moved.push([id, column]),
    onDrag: (id) => moved.push(['drag', id]),
  })
  const tree = board.draw()
  const card = walk(tree).find(node => node.props?.['data-task'] === 'task-abc123456')
  assert.equal(card.props['data-source'], 'task')
  assert.equal(card.props['data-key'], 'task:task-abc123456')
  assert.match(text(card), /Draft the note/)
  assert.match(text(card), /Writer/, 'the card names the Bot that has the task')
  assert.match(text(card), /High/)
  // Dragging reports the card, and the drop reports the column it landed on: the host decides, the
  // view never writes (#1326).
  card.props.onDragStart({ dataTransfer: { setData: () => {} } })
  const done = walk(tree).find(node => node.type === 'section' && node.props?.['data-column'] === 'done')
  done.props.onDrop({ preventDefault: () => {}, dataTransfer: { getData: () => 'task-abc123456' } })
  assert.deepEqual(moved, [['drag', 'task-abc123456'], ['task-abc123456', 'done'], ['drag', null]])
})

test('more than one repository draws one block each, one repository draws none (#1265)', () => {
  // One repository keeps today's shape: the header names it and no block wrapper is rendered.
  const single = DeliveryBoard({ snapshot: { ...snapshot, repo: 'acme/one' }, repo: 'acme/one', message: '' })
  assert.equal(walk(single).filter(node => node.props?.className === 'bt-del-repo-block').length, 0)
  assert.equal(walk(single).filter(node => node.type === 'section' && node.props?.['data-column']).length, 5)
  // The host always sends repos[] now, one entry included (#1265 step 4): that shape is still
  // today's single board, with the repository named in the header rather than counted.
  const singleView = repoSample('acme/one')
  const one = DeliveryBoard({ view: { ...singleView, repos: [singleView] } })
  assert.equal(walk(one).filter(node => node.props?.className === 'bt-del-repo-block').length, 0)
  assert.equal(walk(one).filter(node => node.type === 'section' && node.props?.['data-column']).length, 3, 'single-repo through repos[] uses workflow columns')
  const oneHead = walk(one).find(node => node.props?.className === 'bt-del-repo')
  assert.equal(oneHead.props['data-repo'], 'acme/one')
  assert.equal(oneHead.props['data-repos'], undefined)
  assert.doesNotMatch(text(oneHead), /1 repositories/)

  const board = DeliveryBoard({
    view: { state: 'fresh', repo: null, repoSource: null, asOf: '2026-10-25T04:00:00Z', repos: [repoSample('acme/one'), repoSample('acme/two')] },
  })
  // #1326: Successful repos merge into one shared column set, no per-repo blocks
  const blocks = walk(board).filter(node => node.props?.className === 'bt-del-repo-block')
  assert.equal(blocks.length, 0, 'no repo blocks for successful repos — all cards in one shared column set')
  const columns = walk(board).filter(node => node.type === 'section' && node.props?.['data-column'])
  assert.equal(columns.length, 3, 'one shared column set with 3 workflow columns')
  const cards = walk(board).filter(node => node.type === 'article')
  // Both repos' cards appear in the shared columns; each card keeps its repo identity
  const keys = cards.map(card => card.props['data-key']).sort()
  assert.ok(keys.includes('acme/one#10'), 'acme/one card present')
  assert.ok(keys.includes('acme/two#10'), 'acme/two card present')
  // The shared header counts repositories
  const head = walk(board).find(node => node.props?.className === 'bt-del-repo')
  assert.equal(head.props['data-repos'], '2')
  assert.equal(head.props['data-repo'], undefined)
  assert.match(text(head), /2 repositories/)
})

test('a failed repository keeps its block, and the readable repository still draws (#1265)', () => {
  const broken = repoSample('acme/two', {
    state: 'failed', columns: undefined,
    error: { message: 'GitHub answered 404 for /repos/acme/two/issues', kind: 'not-found', scope: 'issues', status: 404, endpoint: '/repos/acme/two/issues' },
  })
  const board = DeliveryBoard({
    view: {
      state: 'partial', partial: true, repo: null, repoSource: null,
      repos: [repoSample('acme/one'), broken],
      missing: [{ part: 'issues', repo: 'acme/two', message: 'GitHub answered 404 for /repos/acme/two/issues', status: 404, kind: 'not-found', scope: 'issues' }],
      asOf: '2026-10-25T04:00:00Z',
    },
  })
  // #1326: Successful repos merge into shared columns; failed repos shown as error blocks
  const blocks = walk(board).filter(node => node.props?.className === 'bt-del-repo-block')
  assert.equal(blocks.length, 1, 'only the failed repo has a block')
  assert.equal(blocks[0].props['data-state'], 'failed')
  assert.equal(blocks[0].props['data-repo'], 'acme/two')
  assert.equal(walk(blocks[0]).some(node => node.type === 'section' && node.props?.['data-column']), false)
  assert.match(text(blocks[0]), /GitHub answered 404 for \/repos\/acme\/two\/issues/)
  // The successful repo (acme/one) draws in shared columns outside the block
  const columns = walk(board).filter(node => node.type === 'section' && node.props?.['data-column'])
  assert.equal(columns.length, 3, 'shared columns for successful repo')
  // The partial line names whose part it was, so one repository's failure is not read as another's.
  assert.match(text(board), /acme\/two · issues was not fetched this time/)
})

test('multi-repo with tasks: each task appears exactly once (#1326)', () => {
  const task1 = { id: 'task-abc123', title: 'First task', status: 'open', ownerBotId: 'bot-one' }
  const task2 = { id: 'task-def456', title: 'Second task', status: 'working', ownerBotId: 'bot-one' }
  const roster = { byId: { 'bot-one': { id: 'bot-one', name: 'TestBot' } } }
  const board = DeliveryBoard({
    view: { 
      state: 'fresh', 
      repo: null, 
      repoSource: null, 
      asOf: '2026-10-27T05:00:00Z', 
      repos: [repoSample('acme/one'), repoSample('acme/two')] 
    },
    tasks: [task1, task2],
    roster,
  })
  // Each task should appear exactly once, not duplicated per repo
  const taskCards = walk(board).filter(node => node.props?.['data-task'])
  assert.equal(taskCards.length, 2, 'exactly 2 task cards, not duplicated')
  const taskIds = taskCards.map(card => card.props['data-task'])
  assert.deepEqual(taskIds.sort(), ['task-abc123', 'task-def456'].sort())
  // GitHub cards from both repos should also be present
  const githubCards = walk(board).filter(node => node.props?.['data-kind'])
  assert.ok(githubCards.length > 0, 'GitHub cards from repos are present')
})

test('no token names the GitHub side, never an empty board (#1211, #1265)', () => {
  const error = { message: 'no GITHUB_TOKEN', kind: 'no-token', scope: 'repo', endpoint: null, status: null, at: null }
  const board = DeliveryBoard({ view: { state: 'failed', repo: null, repos: [], error, retryAt: Date.now() + 10_000 }, onRetry: () => {} })
  const words = text(board)
  assert.match(words, /Add a GITHUB_TOKEN/)
  assert.match(words, /no GITHUB_TOKEN/)
  // A failed read is a sentence with a next step; it is not a board with nothing on it.
  assert.doesNotMatch(words, /Nothing here\./)
  assert.equal(board.props['data-state'], 'failed')
  // More than one repository with every read failed still says one failure, not an empty page.
  const all = DeliveryBoard({
    view: {
      state: 'failed', repo: null,
      error,
      repos: [repoSample('acme/one', { state: 'failed', columns: undefined, error }), repoSample('acme/two', { state: 'failed', columns: undefined, error })],
    },
  })
  assert.equal(all.props['data-state'], 'failed')
  assert.doesNotMatch(text(all), /Nothing here\./)
})

// A workflow's columns are the definition's (#1272 step 3, acceptance 1 and 2): the section draws its
// own columns beside the five legacy ones, every header names the workflow, and a card a section
// draws is not drawn a second time below it.
test('a workflow draws its own columns, named by the workflow, and its card once (#1272 step 3)', () => {
  const placed = { kind: 'issue', number: 21, title: 'Content card', labels: ['workflow:content', 'node:草稿'], url: 'https://x/21', repo: 'o/r' }
  const payload = {
    ...snapshot,
    repo: 'o/r',
    columns: { ...snapshot.columns, ready: [...snapshot.columns.ready, placed] },
    workflows: [{ id: 'content', name: 'Content', columns: [
      { id: '选题', label: '选题', cards: [] },
      { id: '草稿', label: '草稿', cards: [placed] },
    ], unplaced: [] }],
    placed: ['o/r#issue21'],
  }
  const board = DeliveryBoard({ snapshot: payload })
  const section = walk(board).find(node => node.props?.['data-workflow'] === 'content')
  assert.ok(section, 'the workflow section is drawn')
  assert.match(text(section), /Content/)
  const workflowColumns = walk(section).filter(node => node.props?.['data-column']).map(node => node.props['data-column'])
  assert.deepEqual([...workflowColumns], ['选题', '草稿'])
  // The legacy five are still there and still named.
  const legacy = walk(board).filter(node => node.type === 'section' && node.props?.['data-column'] && node.props['data-workflow'] === undefined)
  assert.deepEqual([...legacy.map(node => node.props['data-column'])], ['raw', 'ready', 'working', 'review', 'done-today'])
  // The card is in the definition's column, and only there: no column holds two workflows, and the
  // card is drawn once.
  const drawn = walk(board).filter(node => node.props?.['data-number'] === 21)
  assert.equal(drawn.length, 1)
  assert.ok(walk(section).includes(drawn[0]))
  const ready = legacy.find(node => node.props['data-column'] === 'ready')
  assert.equal(walk(ready).some(node => node.props?.['data-number'] === 21), false)
})
