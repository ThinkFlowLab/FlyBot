// The delivery board (#1173) is a read-only view of GitHub: five columns, one cached snapshot,
// metrics with an Asia/Shanghai day boundary, and no write request anywhere.
//
// #1211 added the failure half: a round answers `loading` at once and runs in the background, a
// part that cannot be read is named in `missing` instead of emptying the board, an unreadable
// number is never printed as zero, and every failure carries the endpoint, the status and the kind
// so the view can tell "no token" from "no permission" from "too slow".
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { createDeliveryBoard, DELIVERY_COLUMNS, describeResponse, install, median, probeGitHub, startOfDay, BUILD_BUDGET_MS, BACKOFF_MS } from '../src/host/delivery-board.js'
import { install as installAuthz } from '../src/host/authz.js'
import { install as installChannel } from '../src/host/channel.js'

const NOW = Date.parse('2026-10-25T04:00:00Z') // 12:00 in Asia/Shanghai
const AT = (iso) => Date.parse(iso)

// A response whose headers can be asked by name, the way `fetch` answers (#1211).
const respond = (body, status = 200, headerMap = {}) => ({
  ok: status < 400,
  status,
  headers: { get: name => headerMap[String(name).toLowerCase()] ?? (status < 400 ? 'etag-1' : null) },
  json: async () => body,
})

function fakeGitHub({ comments = {}, checks = {}, closedExtra = [], mergedExtra = [], openPullsExtra = [], failures = {}, hang = false } = {}) {
  const calls = []
  const request = async (url, init = {}) => {
    const parsed = new URL(url)
    const path = parsed.pathname.replace('/repos/o/r', '') || '/'
    const page = Number(parsed.searchParams.get('page') ?? 1)
    calls.push({ path, method: init.method, headers: init.headers ?? {}, query: parsed.search })
    if (init.method !== 'GET') throw new Error(`the delivery board must not send ${init.method}`)
    if (hang) return new Promise(() => {})
    for (const [key, failure] of Object.entries(failures)) {
      if (path.startsWith(key) || key === '*') {
        if (failure === 'timeout') throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
        return respond(failure.body ?? { message: 'failure' }, failure.status, failure.headers ?? {})
      }
    }
    if (path === '/') return respond({ full_name: 'o/r', default_branch: 'main' })
    if (path === '/commits' || path.startsWith('/commits?')) return respond([{ sha: 'aaaaaaa1' }])
    if (path === '/issues' && parsed.searchParams.get('state') === 'open') {
      return respond(page === 1 ? [
        { number: 10, title: 'Untriaged', html_url: 'https://x/10', labels: [{ name: 'bug' }], created_at: '2026-10-20T00:00:00Z', updated_at: '2026-10-24T00:00:00Z' },
        { number: 11, title: 'Ready', html_url: 'https://x/11', labels: [{ name: 'agent-ready' }, { name: 'enhancement' }], created_at: '2026-10-21T00:00:00Z', updated_at: '2026-10-23T00:00:00Z' },
        { number: 12, title: 'Working', html_url: 'https://x/12', labels: [{ name: 'agent-working' }, { name: 'agent-ready' }], created_at: '2026-10-19T00:00:00Z', updated_at: '2026-10-22T00:00:00Z' },
        { number: 13, title: 'Needs a human', html_url: 'https://x/13', labels: [{ name: 'needs-info' }], created_at: '2026-09-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' },
      ] : [])
    }
    if (path === '/pulls' && (parsed.searchParams.get('state') ?? 'open') === 'open') {
      return respond(page === 1 ? [
        { number: 40, title: 'Pending verdict', html_url: 'https://x/40', body: 'Owner: Dev', head: { sha: 'aaaaaaa1' }, mergeable_state: 'unstable', created_at: '2026-10-24T00:00:00Z', updated_at: '2026-10-24T10:00:00Z', labels: [] },
        { number: 41, title: 'Fix the thing', html_url: 'https://x/41', body: 'Fixes #12', head: { sha: 'bbbbbbb2' }, mergeable_state: 'clean', created_at: '2026-10-23T00:00:00Z', updated_at: '2026-10-24T09:00:00Z', labels: [{ name: 'agent-pr' }] },
        ...openPullsExtra,
      ] : [])
    }
    if (path === '/pulls' && parsed.searchParams.get('state') === 'all') {
      return respond(page === 1 ? [
        { number: 41, title: 'Fix the thing', html_url: 'https://x/41', created_at: '2026-10-23T00:00:00Z', merged_at: '2026-10-25T02:00:00Z', updated_at: '2026-10-25T02:00:00Z' },
        { number: 42, title: 'Older merge', html_url: 'https://x/42', created_at: '2026-10-22T00:00:00Z', merged_at: '2026-10-24T02:00:00Z', updated_at: '2026-10-24T02:00:00Z' },
      ] : [])
    }
    if (path === '/pulls' && parsed.searchParams.get('state') === 'closed') {
      return respond(page === 1 ? [
        { number: 41, title: 'Fix the thing', html_url: 'https://x/41', created_at: '2026-10-23T00:00:00Z', merged_at: '2026-10-25T02:00:00Z', updated_at: '2026-10-25T02:00:00Z', merge_commit_sha: 'ccccccc3' },
        ...mergedExtra,
      ] : [])
    }
    if (path === '/issues' && parsed.searchParams.get('state') === 'all') {
      return respond(page === 1 ? [
        { number: 10, title: 'Untriaged', created_at: '2026-10-20T00:00:00Z', closed_at: null, state_reason: null },
        { number: 11, title: 'Ready', created_at: '2026-10-21T00:00:00Z', closed_at: null, state_reason: null },
        { number: 12, title: 'Working', created_at: '2026-10-19T00:00:00Z', closed_at: null, state_reason: null },
        { number: 41, title: 'a PR, not an issue', pull_request: { url: 'x' }, created_at: '2026-10-23T00:00:00Z' },
        { number: 14, title: 'Closed today', created_at: '2026-10-20T00:00:00Z', closed_at: '2026-10-25T01:00:00Z', state_reason: 'completed' },
        { number: 15, title: 'Closed yesterday', created_at: '2026-10-21T00:00:00Z', closed_at: '2026-10-24T01:00:00Z', state_reason: 'not_planned' },
      ] : [])
    }
    if (path === '/issues' && parsed.searchParams.get('state') === 'closed') {
      return respond(page === 1 ? [
        { number: 14, title: 'Closed today', html_url: 'https://x/14', created_at: '2026-10-20T00:00:00Z', closed_at: '2026-10-25T01:00:00Z', state_reason: 'completed', updated_at: '2026-10-25T01:00:00Z', labels: [] },
        // A merged pull as /issues?state=closed really returns it: the merge time lives on the
        // pull_request object, there is no top-level merged_at and no head (#1173).
        { number: 41, title: 'Fix the thing', html_url: 'https://x/41', pull_request: { url: 'x', html_url: 'https://x/41', diff_url: 'https://x/41.diff', patch_url: 'https://x/41.patch', merged_at: '2026-10-25T02:00:00Z' }, created_at: '2026-10-23T00:00:00Z', closed_at: '2026-10-25T02:00:00Z', updated_at: '2026-10-25T02:00:00Z', labels: [] },
        ...closedExtra,
      ] : [])
    }
    if (path.startsWith('/actions/runs')) {
      return respond({
        total_count: 3,
        workflow_runs: [
          { conclusion: 'failure' }, { conclusion: 'cancelled' }, { conclusion: 'success' },
        ],
      })
    }
    if (/^\/issues\/\d+\/comments$/.test(path)) {
      const number = Number(path.split('/')[2])
      const value = comments[number] ?? []
      // A thread longer than one page is passed as pages; a flat array is page one (#1189).
      const pagesOf = Array.isArray(value[0]) ? value : [value]
      return respond(pagesOf[page - 1] ?? [])
    }
    if (/^\/commits\/.+\/check-runs$/.test(path)) {
      const sha = path.split('/')[2]
      return respond({ check_runs: checks[sha] ?? [] })
    }
    return respond({ message: 'not found' }, 404)
  }
  return { request, calls }
}

const build = (options = {}, boardOptions = {}) => {
  const github = fakeGitHub(options)
  const board = createDeliveryBoard({ repo: 'o/r', token: 'SECRET-TOKEN', request: github.request, now: () => NOW, ...boardOptions })
  return { board, github }
}
// The browser never waits; tests do, so one round is settled before its result is read.
const settle = (board, options = {}) => board.read({ wait: true, ...options })

test('the delivery board is read-only and the payload carries no credential (#1173)', async () => {
  const { board, github } = build()
  const snapshot = await settle(board)
  assert.ok(github.calls.length > 0)
  assert.deepEqual([...new Set(github.calls.map(call => call.method))], ['GET'])
  for (const call of github.calls) assert.match(call.headers.Authorization ?? '', /^Bearer SECRET-TOKEN$/)
  assert.doesNotMatch(JSON.stringify(snapshot), /SECRET-TOKEN|Authorization/)
})

test('the first read answers loading and does not wait for the round (#1211)', async () => {
  const github = fakeGitHub({ hang: true })
  const board = createDeliveryBoard({ repo: 'o/r', token: 't', request: github.request, now: () => NOW })
  // The request never settles; the read must still answer, and it must say what it is doing.
  const first = await board.read()
  assert.equal(first.state, 'loading')
  assert.equal(first.ok, true)
  assert.equal(first.attempt, 1)
  assert.equal(typeof first.since, 'string')
  assert.equal(first.elapsedMs, 0)
  assert.equal(first.columns, undefined, 'a loading answer carries no half-built board')
})

test('a 404 is described, not reported as "no GitHub connection" (#1211)', async () => {
  const { board } = build({ failures: { '/issues': { status: 404 } } })
  const result = await settle(board)
  assert.equal(result.state, 'failed')
  assert.equal(result.ok, true)
  assert.equal(result.error.status, 404)
  assert.equal(result.error.kind, 'not-found')
  assert.equal(result.error.scope, 'issues')
  assert.match(result.error.message, /GitHub answered 404 for \/repos\/o\/r\/issues/)
  assert.equal(typeof result.error.at, 'string')
})

test('a timeout keeps the endpoint and the kind, and is not a 404 (#1211)', async () => {
  const { board } = build({ failures: { '/pulls': 'timeout' } })
  const result = await settle(board)
  assert.equal(result.state, 'failed')
  assert.equal(result.error.kind, 'timeout')
  assert.equal(result.error.status, null)
  assert.equal(result.error.scope, 'pulls')
  assert.match(result.error.message, /did not answer within 20 seconds for \/repos\/o\/r\/pulls/)
})

test('a 403 rate limit carries only the wait GitHub gave (#1211)', async () => {
  const limited = build({ failures: { '/actions/runs': { status: 403, headers: { 'retry-after': '30' } } } })
  const result = await settle(limited.board)
  assert.equal(result.state, 'partial')
  assert.equal(result.error, null, 'a named part failing is a partial board, not a failed one')
  const entry = result.missing.find(item => item.part === 'ci')
  assert.equal(entry.kind, 'rate-limit')
  assert.equal(entry.retryAfterMs, 30_000)
  assert.match(entry.message, /retry after 30 s/)

  // No header, no number: the view must not invent a wait it cannot keep.
  const silent = build({ failures: { '/actions/runs': { status: 403 } } })
  const quiet = await settle(silent.board)
  assert.equal(quiet.missing.find(item => item.part === 'ci').kind, 'forbidden')
  assert.doesNotMatch(quiet.missing.find(item => item.part === 'ci').message, /retry after/)

  const raw = describeResponse(respond({}, 403, { 'x-ratelimit-remaining': '0' }), '/repos/o/r/issues', { now: () => NOW })
  assert.equal(raw.kind, 'rate-limit')
  assert.equal(raw.retryAfterMs, null)
  assert.doesNotMatch(raw.message, /retry after/)
})

test('an unreadable /actions/runs leaves the board, and the CI number unknown not zero (#1211)', async () => {
  const { board } = build({ failures: { '/actions/runs': { status: 404 } } })
  const result = await settle(board)
  assert.equal(result.state, 'partial')
  assert.equal(result.partial, true)
  assert.equal(result.ok, true)
  // The board is still there: one failed request empties nothing.
  assert.deepEqual(result.columns.working.map(card => card.number), [12])
  assert.deepEqual(result.counts.review, 2)
  // Unknown is null, never 0 — and the reason is named.
  assert.equal(result.metrics.today.ci, null)
  assert.equal(result.metrics.week.ci, null)
  const entry = result.missing.find(item => item.part === 'ci')
  assert.equal(entry.status, 404)
  assert.equal(entry.scope, 'actions')
})

test('unreadable check-runs read as unknown, not as "no verdict" (#1211)', async () => {
  const { board } = build({ failures: { '/commits/bbbbbbb2/check-runs': { status: 404 } } })
  const result = await settle(board)
  const card = result.columns.review.find(item => item.number === 41)
  assert.equal(card.badge, 'checks-unknown')
  assert.equal(result.state, 'partial')
  const entry = result.missing.find(item => item.part === 'checks:41')
  assert.equal(entry.scope, 'checks')
})

test('unreadable comments cost that card its owner, not the board (#1211)', async () => {
  const { board } = build({ failures: { '/issues/12/comments': { status: 404 } } })
  const result = await settle(board)
  const card = result.columns.working.find(item => item.number === 12)
  assert.equal(card.owner, null)
  assert.equal(result.state, 'partial')
  assert.ok(result.missing.some(item => item.part === 'comments:12'))
})

test('a failed refresh keeps the old snapshot and its reason (#1211)', async () => {
  let clock = NOW
  let failing = false
  const github = fakeGitHub()
  const broken = fakeGitHub({ failures: { '*': { status: 404 } } })
  const request = async (url, init) => (failing ? broken.request : github.request)(url, init)
  const board = createDeliveryBoard({ repo: 'o/r', token: 't', request, now: () => clock, ttl: 60_000 })
  const first = await settle(board)
  assert.equal(first.state, 'fresh')
  failing = true
  clock += 120_000
  const stale = await settle(board, { force: true })
  assert.equal(stale.state, 'stale')
  assert.equal(stale.error.status, 404)
  assert.equal(stale.asOf, first.asOf, 'the old snapshot is still served')
  assert.equal(stale.columns.working.length, 1)
})

test('after a failure the next round waits 10 s, then 30 s, then two minutes (#1211)', async () => {
  let clock = NOW
  const github = fakeGitHub({ failures: { '*': { status: 500 } } })
  const board = createDeliveryBoard({ repo: 'o/r', token: 't', request: github.request, now: () => clock, ttl: 0 })
  const first = await settle(board)
  assert.equal(first.state, 'failed')
  assert.equal(first.retryAt, NOW + BACKOFF_MS[0])

  const afterFirst = github.calls.length
  clock += BACKOFF_MS[0] - 1
  const tooEarly = await settle(board)
  assert.equal(tooEarly.state, 'failed')
  assert.equal(github.calls.length, afterFirst, 'inside the backoff no request is made')

  clock += 1
  await settle(board)
  const afterSecond = github.calls.length
  assert.ok(afterSecond > afterFirst, 'the backoff expired, so the round ran')
  clock += BACKOFF_MS[0]
  await settle(board)
  assert.equal(github.calls.length, afterSecond, 'the second failure backs off for 30 s, not 10')

  // A person pressing retry skips the wait on purpose.
  clock += 1
  await settle(board, { force: true })
  assert.ok(github.calls.length > afterSecond)
})

test('a round past its budget lands as partial, not as a failure (#1211)', async () => {
  let clock = NOW
  const github = fakeGitHub()
  const request = async (url, init) => { clock += 60_000; return github.request(url, init) }
  const board = createDeliveryBoard({ repo: 'o/r', token: 't', request, now: () => clock, budgetMs: 100 })
  const result = await board.read({ wait: true })
  assert.equal(result.state, 'partial')
  assert.equal(result.ok, true)
  assert.equal(result.partial, true)
  assert.ok(Array.isArray(result.columns.raw))
  assert.equal(BUILD_BUDGET_MS, 90_000)
})

test('a workflow day truncated at the page cap is unknown, not zero failures (#1211)', async () => {
  const github = fakeGitHub()
  const fullPage = { total_count: 1000, workflow_runs: Array.from({ length: 100 }, () => ({ conclusion: 'success' })) }
  const request = async (url, init) => {
    const parsed = new URL(url)
    if (parsed.pathname.endsWith('/actions/runs')) return respond(fullPage)
    return github.request(url, init)
  }
  const board = createDeliveryBoard({ repo: 'o/r', token: 't', request, now: () => NOW })
  const result = await board.read({ wait: true })
  assert.equal(result.metrics.today.ci.unknownDays.length, 1)
  assert.equal(result.metrics.today.ci.failed, 0)
  assert.equal(result.metrics.today.ci.counted, 0, 'a truncated day is not counted as if it were read')
  assert.ok(result.missing.some(item => item.kind === 'truncated'))
})

test('the probe asks the five endpoints and says which one is refused (#1211)', async () => {
  const github = fakeGitHub({ failures: { '/actions/runs': { status: 404 } } })
  const report = await probeGitHub({ repo: 'o/r', token: 'SECRET-TOKEN', request: github.request, now: () => NOW })
  assert.deepEqual(report.rows.map(row => row.key), ['repo', 'actions', 'checks', 'comments', 'pulls'])
  assert.equal(report.ok, false)
  const actions = report.rows.find(row => row.key === 'actions')
  assert.equal(actions.status, 404)
  assert.equal(actions.scope, 'actions')
  assert.equal(actions.ok, false)
  for (const key of ['repo', 'pulls']) assert.equal(report.rows.find(row => row.key === key).ok, true)
  // The checks read is asked at a real sha taken from the pull list, never `//`.
  assert.equal(report.rows.find(row => row.key === 'checks').endpoint, '/repos/o/r/commits/aaaaaaa1/check-runs')
})

test('the --probe CLI is a shell over probeGitHub, not a second implementation (#1211)', () => {
  const source = readFileSync(new URL('../scripts/delivery-probe.mjs', import.meta.url), 'utf8')
  assert.match(source, /import \{ probeGitHub \} from '\.\.\/src\/host\/delivery-board\.js'/)
  assert.doesNotMatch(source, /api\.github\.com/, 'the CLI makes no request of its own')
})

test('five columns come from one snapshot, an issue and its PR linked (#1173)', async () => {
  const { board } = build()
  const snapshot = await settle(board)
  assert.deepEqual(Object.keys(snapshot.columns), DELIVERY_COLUMNS)
  assert.deepEqual(snapshot.columns.raw.map(card => card.number), [10, 13])
  assert.deepEqual(snapshot.columns.ready.map(card => card.number), [11])
  assert.deepEqual(snapshot.columns.working.map(card => card.number), [12])
  assert.deepEqual(snapshot.columns.review.map(card => card.number), [40, 41])
  assert.deepEqual(snapshot.columns['done-today'].map(card => card.number), [41, 14])
  const working = snapshot.columns.working[0]
  assert.equal(working.linked, 41)
  assert.equal(working.owner, null)
  const ready = snapshot.columns.ready[0]
  assert.deepEqual(ready.labels, ['agent-ready', 'enhancement'])
  assert.deepEqual(snapshot.counts, { raw: 2, ready: 1, working: 1, review: 2, 'done-today': 2 })
})

test('only a closing keyword links a pull request to an issue (#1189)', async () => {
  const { board } = build({
    openPullsExtra: [
      { number: 43, title: 'Related work', html_url: 'https://x/43', body: 'also see #10, same as #12', head: { sha: 'ddddddd4' }, mergeable_state: 'clean', created_at: '2026-10-22T00:00:00Z', updated_at: '2026-10-24T08:00:00Z', labels: [] },
      { number: 44, title: 'Close it', html_url: 'https://x/44', body: 'Closes: #13', head: { sha: 'eeeeeee5' }, mergeable_state: 'clean', created_at: '2026-10-22T00:00:00Z', updated_at: '2026-10-24T08:00:00Z', labels: [] },
    ],
  })
  const snapshot = await settle(board)
  const card = (column, number) => snapshot.columns[column].find(item => item.number === number)
  // "also see #10, same as #12" is prose: #10 links to nothing, and #12 keeps the pull request
  // that closes it (41), not the one that only mentions it.
  assert.equal(card('raw', 10).linked, null)
  assert.equal(card('working', 12).linked, 41)
  // A closing keyword with a colon counts; nothing else does.
  assert.equal(card('raw', 13).linked, 44)
})

test('a pull request closed today without a merge is done today, not nowhere (#1173)', async () => {
  const { board } = build({
    closedExtra: [
      // The shape /issues?state=closed gives a closed pull: no top-level merged_at, no head.
      { number: 52, title: 'Closed, never merged', html_url: 'https://x/52', pull_request: { url: 'x', html_url: 'https://x/52', diff_url: 'https://x/52.diff', patch_url: 'https://x/52.patch', merged_at: null }, created_at: '2026-10-22T00:00:00Z', closed_at: '2026-10-25T03:00:00Z', updated_at: '2026-10-25T03:00:00Z', labels: [] },
      { number: 53, title: 'Closed yesterday, never merged', html_url: 'https://x/53', pull_request: { url: 'x', html_url: 'https://x/53', diff_url: 'https://x/53.diff', patch_url: 'https://x/53.patch', merged_at: null }, created_at: '2026-10-22T00:00:00Z', closed_at: '2026-10-24T03:00:00Z', updated_at: '2026-10-24T03:00:00Z', labels: [] },
    ],
  })
  const snapshot = await settle(board)
  const done = snapshot.columns['done-today']
  // Acceptance 2.5: today's merges plus today's closures, and a closed pull request counts even
  // though it never merged. Yesterday's closure stays off the board.
  assert.equal(done.filter(card => card.number === 41).length, 1)
  assert.equal(done.filter(card => card.number === 52).length, 1)
  assert.equal(done.filter(card => card.number === 14).length, 1)
  const closed = done.find(card => card.number === 52)
  assert.equal(closed.kind, 'pr')
  // /issues?state=closed returns no head for a pull, so this card carries no merge commit.
  assert.equal(closed.sha, null)
  assert.equal(done.some(card => card.number === 53), false)
  assert.equal(snapshot.counts['done-today'], done.length)
})

test('a pull merged today is done once although the closed page lists it too (#1173)', async () => {
  const { board } = build({
    mergedExtra: [
      { number: 44, title: 'Merged today', html_url: 'https://x/44', created_at: '2026-10-23T00:00:00Z', merged_at: '2026-10-25T02:30:00Z', updated_at: '2026-10-25T02:30:00Z', merge_commit_sha: 'fffffff6' },
    ],
    // The closed page returns the same pull, and a row there can reach us without a merge time on
    // its pull_request object, so reading that object alone would count it twice. A pull closed
    // without merging sits on that page too and must still reach the board.
    closedExtra: [
      { number: 44, title: 'Merged today', html_url: 'https://x/44', pull_request: { url: 'x' }, created_at: '2026-10-23T00:00:00Z', closed_at: '2026-10-25T02:30:00Z', updated_at: '2026-10-25T02:30:00Z', labels: [] },
      { number: 52, title: 'Closed, never merged', html_url: 'https://x/52', pull_request: { url: 'x' }, created_at: '2026-10-22T00:00:00Z', closed_at: '2026-10-25T03:00:00Z', updated_at: '2026-10-25T03:00:00Z', labels: [] },
    ],
  })
  const snapshot = await settle(board)
  const done = snapshot.columns['done-today']
  for (const number of [41, 44, 14, 52]) assert.equal(done.filter(card => card.number === number).length, 1, `#${number} is done today once`)
  assert.equal(done.some(card => card.number === 15), false)
  assert.equal(snapshot.counts['done-today'], done.length)
})

test('a verdict with no Attestation still counts at the sha it names (#1173)', async () => {
  const { board } = build({
    comments: { 41: [{ body: 'Verdict: PASS at bbbbbbb2' }] },
    checks: { bbbbbbb2: [{ status: 'completed', conclusion: 'success' }] },
  })
  const snapshot = await settle(board)
  const card = snapshot.columns.review.find(item => item.number === 41)
  assert.equal(card.badge, 'pass-enqueue')
})

test('a verdict line wins over an Attestation that names an older sha (#1173)', async () => {
  // Two markers, two tips: the Attestation points at #40's sha, the Verdict line at this PR's.
  // Reading Attestation first would hide a verdict that names the current tip (#1173 INC).
  const { board } = build({
    comments: { 41: [{ body: 'Verdict: PASS at bbbbbbb2\nAttestation: aaaaaaa1 role=Reviewer' }] },
    checks: { aaaaaaa1: [{ status: 'in_progress', conclusion: null }], bbbbbbb2: [{ status: 'completed', conclusion: 'success' }] },
  })
  const snapshot = await settle(board)
  const card = snapshot.columns.review.find(item => item.number === 41)
  assert.equal(card.badge, 'pass-enqueue')
})

test('a verdict on a later page of comments still decides the badge (#1189)', async () => {
  // 120 comments with the newest verdict at index 101: on a board that reads one page it never
  // appears, and the card says "no verdict at this tip" while the tip has one.
  const firstPage = Array.from({ length: 100 }, (_, index) => ({ body: `note ${index}` }))
  const secondPage = [
    { body: 'note 100' },
    { body: 'Verdict: INC at bbbbbbb2' },
    ...Array.from({ length: 18 }, (_, index) => ({ body: `note ${102 + index}` })),
  ]
  const { board, github } = build({
    comments: { 41: [firstPage, secondPage] },
    checks: { bbbbbbb2: [{ status: 'completed', conclusion: 'success' }] },
  })
  const snapshot = await settle(board)
  const card = snapshot.columns.review.find(item => item.number === 41)
  assert.equal(card.badge, 'inc')
  assert.ok(github.calls.some(call => call.path === '/issues/41/comments' && /[?&]page=2(&|$)/.test(call.query)))
})

test('the token is read per request, and install loads the secrets before the round (#1173)', async () => {
  // A token captured at install time is empty until the host loads secrets; every request must
  // resolve it again, and the first read must ask the host to load them (#1173 INC).
  const direct = fakeGitHub()
  let secret
  const board = createDeliveryBoard({ repo: 'o/r', token: () => secret, request: direct.request, now: () => NOW })
  await settle(board)
  assert.ok(direct.calls.every(call => call.headers.Authorization === undefined))
  secret = 'SECRET-TOKEN'
  await settle(board, { force: true })
  assert.ok(direct.calls.slice(-10).some(call => call.headers.Authorization === 'Bearer SECRET-TOKEN'))

  const github = fakeGitHub()
  let loads = 0
  let loaded
  const rt = {
    repoSlug: () => 'o/r',
    // The secrets file is read asynchronously, so at install time there is nothing to read yet.
    secretValue: name => (name === 'GITHUB_TOKEN' ? loaded : undefined),
    loadSecrets: async () => { loads += 1; loaded = 'SECRET-TOKEN' },
    fetch: github.request,
    warn: () => {},
  }
  const installed = Object.assign({}, rt)
  install(installed)
  // The first answer is loading (#1211): the round runs behind it, and the secrets were loaded
  // before any request went out.
  const loading = await installed.deliveryBoard()
  assert.equal(loading.state, 'loading')
  assert.equal(loads, 1)
  const settled = await installed.deliveryBoard({ wait: true })
  assert.equal(settled.state, 'fresh')
  assert.equal(settled.ok, true)
  assert.ok(github.calls.length > 0)
  assert.ok(github.calls.every(call => call.headers.Authorization === 'Bearer SECRET-TOKEN'))
  // The 诊断 entry runs the same probe, through the host's own token.
  const probe = await installed.deliveryProbe()
  assert.ok(Array.isArray(probe.rows))
  assert.ok(probe.rows.every(row => row.ok))
})

test('a PR badge reads the verdict at its own tip, and CI when there is none (#1173)', async () => {
  const { board } = build({
    comments: {
      40: [{ body: 'Verdict: PASS at deadbee\nAttestation: deadbee role=Reviewer2' }],
      41: [{ body: 'Verdict: PASS at bbbbbbb\nAttestation: bbbbbbb2 role=Reviewer' }],
    },
    checks: { aaaaaaa1: [{ status: 'in_progress', conclusion: null }], bbbbbbb2: [{ status: 'completed', conclusion: 'success' }] },
  })
  const snapshot = await settle(board)
  const badges = Object.fromEntries(snapshot.columns.review.map(card => [card.number, card.badge]))
  // Verdict names an older sha: it does not count at this tip, so CI speaks.
  assert.equal(badges[40], 'ci-running')
  assert.equal(badges[41], 'pass-enqueue')
})

test('metrics use the Shanghai day boundary, medians, and the CI counted/total caveat (#1173)', async () => {
  assert.equal(startOfDay(NOW), AT('2026-10-24T16:00:00Z'))
  assert.equal(median([5, 1, 3]), 3)
  assert.equal(median([4, 1, 3, 2]), 2.5)
  const { board } = build()
  const snapshot = await settle(board)
  const { today, week, open } = snapshot.metrics
  assert.equal(today.newIssues, 0)
  assert.equal(today.closedIssues, 1)
  assert.equal(today.closedReasons.completed, 1)
  assert.equal(today.closedReasons.notPlanned, 0)
  assert.equal(today.mergedPullRequests, 1)
  assert.equal(today.medianPullMergeMs, AT('2026-10-25T02:00:00Z') - AT('2026-10-23T00:00:00Z'))
  assert.deepEqual(today.ci, { failed: 1, superseded: 1, counted: 3, total: 3, unknownDays: [] })
  assert.equal(week.newIssues, 5)
  assert.equal(week.closedIssues, 1)
  assert.equal(week.closedReasons.notPlanned, 1)
  assert.equal(open.issues, 4)
  assert.equal(open.pullRequests, 2)
  assert.equal(open.needsHuman, 1)
  assert.equal(open.medianIssueAgeMs, median([
    NOW - AT('2026-10-20T00:00:00Z'), NOW - AT('2026-10-21T00:00:00Z'),
    NOW - AT('2026-10-19T00:00:00Z'), NOW - AT('2026-09-01T00:00:00Z'),
  ]))
})

test('a snapshot is cached, a stale one is served while it refreshes, and 304 reuses it (#1173)', async () => {
  let clock = NOW
  const github = fakeGitHub()
  const board = createDeliveryBoard({ repo: 'o/r', token: 't', request: github.request, now: () => clock, ttl: 60_000 })
  const first = await settle(board, { force: true })
  assert.equal(first.state, 'fresh')
  const requestsAfterFirst = github.calls.length
  clock += 30_000
  const cached = await board.read()
  assert.equal(github.calls.length, requestsAfterFirst, 'a fresh cache makes no request')
  assert.equal(cached.asOf, first.asOf)
  // Past the TTL the old snapshot is served at once, and the refresh runs in the background.
  clock += 60_000
  const stale = await board.read()
  assert.equal(stale.state, 'stale')
  assert.equal(stale.stale, true)
  assert.equal(stale.refreshing, true)
  assert.equal(stale.asOf, first.asOf)
  await board.read({ wait: true })
  const conditional = github.calls.filter(call => call.headers['If-None-Match'] !== undefined)
  assert.ok(conditional.length > 0, 'a refresh asks with If-None-Match')
})

test('the host installs no timer: nothing refreshes behind the browser (#1173)', () => {
  // A host-side interval would burn a turn's worth of GitHub reads with nobody looking; the
  // snapshot moves only when the browser asks. The client's own poll is tested in delivery-view.
  const source = readFileSync(new URL('../src/host/delivery-board.js', import.meta.url), 'utf8')
  assert.equal(/\bset(?:Interval|Timeout)\s*\(/.test(source), false)
})

test('CI counts ask GitHub for the day in ISO time, not epoch numbers (#1173)', async () => {
  // Epoch milliseconds answer 200 with no runs, so a wrong format reads as "CI never ran".
  const { board, github } = build()
  await settle(board)
  const runs = github.calls.filter(call => call.path.startsWith('/actions/runs'))
  assert.ok(runs.length > 0)
  for (const call of runs) {
    const created = new URLSearchParams(call.query).get('created')
    assert.match(created, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z\.\.\d{4}-\d{2}-\d{2}T[\d:.]+Z$/, `created=${created}`)
  }
})

test('the Diagnose entry is on the API route, and refused without a session (#1211)', async () => {
  // #1211: the probe has to be reachable the way the button reaches it — through the channel's
  // route, past authz — because calling `rt.deliveryProbe()` directly skips both and left
  // `delivery-probe` out of the allow list while every test stayed green (Reviewer, 03:30Z).
  let route
  const ctx = {
    effect: fn => { const dispose = fn(); return () => { if (typeof dispose === 'function') dispose() } },
    connection: { fetch: { register: registered => { route = registered; return () => { route = undefined } } } },
    logger: { warn: () => {} },
    sessionController: { prompt: async () => {} },
  }
  const state = {
    authSessions: { tok1: { memberId: 'owner-1' } },
    members: { 'owner-1': { id: 'owner-1', displayName: 'Owner' } },
    bots: {},
    rooms: {},
  }
  const probeRows = [{ name: '/repos/o/r', ok: true, status: 200, hint: '' }]
  const rt = {
    ctx,
    state,
    refresh: async () => {},
    readOnly: () => undefined,
    authenticate: async token => (token === 'tok1' ? { memberId: 'owner-1' } : null),
    load: async () => {},
    deliveryBoard: async () => ({ ok: true, state: 'fresh', columns: [] }),
    deliveryProbe: async () => ({ rows: probeRows }),
    ensureCapabilities: async () => {},
    warn: () => {},
  }
  installAuthz(rt)
  installChannel(rt)
  assert.ok(route !== undefined, 'the channel registered its /api/bot route')

  const post = async (payload, token) => {
    const headers = { 'content-type': 'application/json' }
    if (token) headers['x-flybot-member-session'] = token
    const response = await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', headers, body: JSON.stringify(payload) }))
    return response.json()
  }

  // Signed in: both reads answer, so the 诊断 button's endpoint is not "Unknown endpoint".
  for (const endpoint of ['delivery-board', 'delivery-probe']) {
    const answer = await post({ endpoint }, 'tok1')
    assert.equal(answer.ok, true, endpoint + ' should answer for a signed-in member: ' + JSON.stringify(answer))
  }
  // The channel wraps a successful answer as `{ ok: true, value }`.
  const probed = await post({ endpoint: 'delivery-probe' }, 'tok1')
  assert.deepEqual(probed.value.rows, probeRows)

  // No session: both are refused, not silently served.
  for (const endpoint of ['delivery-board', 'delivery-probe']) {
    const answer = await post({ endpoint })
    assert.equal(answer.ok, false, endpoint + ' must not answer without a session')
    assert.equal(answer.error.code, 'bot/unauthorized', JSON.stringify(answer))
  }
})
