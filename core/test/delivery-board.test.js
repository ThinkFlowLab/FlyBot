// The delivery board (#1173) is a read-only view of GitHub: five columns, one cached snapshot,
// metrics with an Asia/Shanghai day boundary, and no write request anywhere.
//
// #1211 added the failure half: a round answers `loading` at once and runs in the background, a
// part that cannot be read is named in `missing` instead of emptying the board, an unreadable
// number is never printed as zero, and every failure carries the endpoint, the status and the kind
// so the view can tell "no token" from "no permission" from "too slow".
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cardOf, combineRepos, createDeliveryBoard, dailySeries, DELIVERY_COLUMNS, describeResponse, install, median, probeGitHub, startOfDay, BUILD_BUDGET_MS, BACKOFF_MS } from '../src/host/delivery-board.js'
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

function fakeGitHub({ comments = {}, checks = {}, closedExtra = [], mergedExtra = [], openPullsExtra = [], failures = {}, hang = false, runsTruncated = false, listsCapped = false, listsStale = false, listsStopLate = false, slug = 'o/r' } = {}) {
  const calls = []
  const request = async (url, init = {}) => {
    const parsed = new URL(url)
    const path = parsed.pathname.replace(`/repos/${slug}`, '') || '/'
    const page = Number(parsed.searchParams.get('page') ?? 1)
    calls.push({ path, url, method: init.method, headers: init.headers ?? {}, query: parsed.search })
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
    // The two list calls that feed the counts (#1222), when the page cap is what ends them:
    // `listsCapped` answers four full pages of rows dated inside the week the board asks for, so a
    // window's walk only stops at the cap; `listsStale` answers full pages of rows older than every
    // window, so the walk ends on its first page and nothing was in fact left unread.
    // `listsStopLate` is the same full walk with the `stop` row on page four: four full pages, and
    // the only old row is the last one, so the walk ends because the window was read whole, not
    // because it ran out of pages.
    if ((path === '/issues' || path === '/pulls') && parsed.searchParams.get('state') === 'all' && listsStopLate) {
      return respond(Array.from({ length: 100 }, (_, index) => ({
        number: 700 + page * 100 + index,
        title: 'a row on a full page',
        created_at: page === 4 && index === 99 ? '2026-10-01T00:00:00Z' : '2026-10-20T00:00:00Z',
        closed_at: null,
        ...(path === '/pulls' ? { merged_at: page === 4 && index === 99 ? '2026-10-01T00:00:00Z' : '2026-10-20T01:00:00Z' } : {}),
      })))
    }
    if ((path === '/issues' || path === '/pulls') && parsed.searchParams.get('state') === 'all' && (listsCapped || listsStale)) {
      const created = listsStale ? '2026-10-01T00:00:00Z' : '2026-10-20T00:00:00Z'
      return respond(Array.from({ length: 100 }, (_, index) => ({
        number: 900 + page * 100 + index,
        title: 'a row on a full page',
        created_at: created,
        closed_at: null,
        ...(path === '/pulls' ? { merged_at: listsStale ? '2026-10-01T01:00:00Z' : '2026-10-20T01:00:00Z' } : {}),
      })))
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
      // A day whose runs outnumber the page cap: every page is full, so the tail is never read.
      if (runsTruncated) {
        return respond({ total_count: 1000, workflow_runs: Array.from({ length: 100 }, () => ({ conclusion: 'success' })) })
      }
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
  // The column keeps its cards and the two open pull requests; only CI is missing.
  assert.deepEqual(result.columns['in-progress'].map(card => card.number), [12, 40, 41])
  assert.deepEqual(result.counts['in-progress'], 3)
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
  const card = result.columns['in-progress'].find(item => item.number === 41)
  assert.equal(card.badge, 'checks-unknown')
  assert.equal(result.state, 'partial')
  const entry = result.missing.find(item => item.part === 'checks:41')
  assert.equal(entry.scope, 'checks')
})

test('unreadable comments cost that card its owner, not the board (#1211)', async () => {
  const { board } = build({ failures: { '/issues/12/comments': { status: 404 } } })
  const result = await settle(board)
  const card = result.columns['in-progress'].find(item => item.number === 12)
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
  assert.equal(stale.columns['in-progress'].length, 3)
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
  assert.ok(Array.isArray(result.columns['not-started']))
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

test('three workflow columns from one snapshot, an issue and its PR linked (#1173, #1326)', async () => {
  const { board } = build()
  const snapshot = await settle(board)
  assert.deepEqual(Object.keys(snapshot.columns), DELIVERY_COLUMNS)
  // #1326: Three workflow columns. Issues map to not-started, PRs to in-progress, done-today in done.
  assert.deepEqual(snapshot.columns['not-started'].map(card => card.number).sort((a, b) => a - b), [10, 11, 13])
  assert.deepEqual(snapshot.columns['in-progress'].map(card => card.number).sort((a, b) => a - b), [12, 40, 41])
  assert.deepEqual(snapshot.columns.done.filter(c => c.stage === 'done-today').map(card => card.number).sort((a, b) => a - b), [14, 41])
  const progress = snapshot.columns['in-progress'].find(c => c.number === 12)
  assert.equal(progress.linked, 41)
  assert.equal(progress.owner, null)
  const notStarted = snapshot.columns['not-started'].find(c => c.number === 11)
  assert.deepEqual(notStarted.labels, ['agent-ready', 'enhancement'])
  assert.deepEqual(snapshot.counts, { 'not-started': 3, 'in-progress': 3, done: 2 })
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
  assert.equal(card('not-started', 10).linked, null)
  assert.equal(card('in-progress', 12).linked, 41)
  // A closing keyword with a colon counts; nothing else does.
  assert.equal(card('not-started', 13).linked, 44)
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
  const done = snapshot.columns.done
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
  assert.equal(snapshot.counts.done, done.length)
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
  const done = snapshot.columns.done
  for (const number of [41, 44, 14, 52]) assert.equal(done.filter(card => card.number === number).length, 1, `#${number} is done today once`)
  assert.equal(done.some(card => card.number === 15), false)
  assert.equal(snapshot.counts.done, done.length)
})

test('a verdict with no Attestation still counts at the sha it names (#1173)', async () => {
  const { board } = build({
    comments: { 41: [{ body: 'Verdict: PASS at bbbbbbb2' }] },
    checks: { bbbbbbb2: [{ status: 'completed', conclusion: 'success' }] },
  })
  const snapshot = await settle(board)
  const card = snapshot.columns['in-progress'].find(item => item.number === 41)
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
  const card = snapshot.columns['in-progress'].find(item => item.number === 41)
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
  const card = snapshot.columns['in-progress'].find(item => item.number === 41)
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
    config: { deliveryRepo: 'o/r' },
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
  assert.equal(loading.repo, 'o/r')
  assert.equal(loading.repoSource, 'config')
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
  assert.equal(probe.repo, 'o/r')
  assert.equal(probe.repoSource, 'config')
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
  const badges = Object.fromEntries(snapshot.columns['in-progress'].map(card => [card.number, card.badge]))
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

test('metrics.daily is seven Shanghai days ending today, and only today is partial (#1222)', async () => {
  const { board, github } = build()
  const snapshot = await settle(board)
  const daily = snapshot.metrics.daily
  // Seven days, oldest first, the last one today: the window the chart draws is the same one the
  // header's Today column sits at the end of.
  assert.equal(daily.length, 7)
  assert.deepEqual([...daily.map(day => day.date)],
    ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25'])
  assert.equal(daily[6].partial, true)
  assert.equal(daily.slice(0, 6).some(day => 'partial' in day), false, 'only today is a part of a day')
  const byDate = Object.fromEntries(daily.map(day => [day.date, day]))
  // A day nobody counted is 0, and 0 is a measurement: 10-22 opened and closed nothing.
  assert.deepEqual({ ...byDate['2026-10-22'] }, {
    date: '2026-10-22',
    newIssues: 0,
    closedIssues: 0,
    newPullRequests: 1,
    mergedPullRequests: 0,
    ci: { failed: 1, counted: 2, total: 3 },
  })
  assert.equal(byDate['2026-10-19'].newIssues, 1)
  assert.equal(byDate['2026-10-20'].newIssues, 2)
  assert.equal(byDate['2026-10-21'].newIssues, 2)
  assert.equal(byDate['2026-10-24'].closedIssues, 1)
  assert.equal(byDate['2026-10-24'].mergedPullRequests, 1)
  // Today is the same day the Today column counts, not a day behind it.
  assert.equal(byDate['2026-10-25'].closedIssues, snapshot.metrics.today.closedIssues)
  assert.equal(byDate['2026-10-25'].mergedPullRequests, snapshot.metrics.today.mergedPullRequests)
  // A cancelled run never judged the code, so it is out of the denominator; the header keeps its
  // own aggregate, superseded included.
  assert.deepEqual(byDate['2026-10-25'].ci, { failed: 1, counted: 2, total: 3 })
  assert.deepEqual(snapshot.metrics.today.ci, { failed: 1, superseded: 1, counted: 3, total: 3, unknownDays: [] })
  // The series costs no request: it is built from the two windows the round already reads.
  assert.ok(github.calls.every(call => call.headers.Authorization === 'Bearer SECRET-TOKEN'))
  // The assembled series is the only thing the payload carries — no per-day buckets anywhere else.
  assert.equal('daily' in snapshot.metrics.today, false)
  assert.equal('daily' in snapshot.metrics.week, false)
})

test('the day boundary is Shanghai, not UTC: an evening in UTC is already tomorrow (#1222)', async () => {
  // 2026-10-24T17:00Z is 2026-10-25 01:00 in Shanghai, so the newest day is the 25th.
  const { board } = build({}, { now: () => AT('2026-10-24T17:00:00Z') })
  const snapshot = await settle(board)
  assert.equal(snapshot.metrics.dayStart, '2026-10-24T16:00:00.000Z')
  const daily = snapshot.metrics.daily
  assert.equal(daily[6].date, '2026-10-25')
  assert.equal(daily[6].partial, true)
  assert.equal(daily[0].date, '2026-10-19')
  assert.equal(daily.length, 7)
})

test('the seven-day CI share is read over the week its counts cover (#1222)', async () => {
  // The week window is [2026-10-17T16:00Z, 2026-10-24T16:00Z). Walking backwards from its start
  // read the seven days *before* it, so the CI row described a week the other numbers never saw.
  const { board, github } = build()
  await settle(board)
  const ranges = github.calls
    .filter(call => call.path.startsWith('/actions/runs'))
    .map(call => new URLSearchParams(call.query).get('created'))
  const starts = ranges.map(range => Date.parse(range.split('..')[0]))
  assert.equal(starts.length, 8, 'seven days for the week, one for today')
  assert.ok(starts.every(at => at >= AT('2026-10-17T16:00:00Z')), 'no window reaches back before the week it describes')
  assert.equal(starts.filter(at => at === AT('2026-10-17T16:00:00Z')).length, 1, 'the first day of the week is read')
  assert.equal(starts.filter(at => at === AT('2026-10-23T16:00:00Z')).length, 1, 'the week runs up to the day before today')
  assert.equal(starts.filter(at => at === AT('2026-10-24T16:00:00Z')).length, 1, 'today is its own window')
})

test('a day whose runs were truncated is unknown, and unknown is not zero (#1222)', async () => {
  const { board } = build({ runsTruncated: true })
  const snapshot = await settle(board)
  const daily = snapshot.metrics.daily
  assert.equal(daily.length, 7)
  // The tail of every day was unread, so no day may claim a CI share — including a quiet-looking 0%.
  assert.equal(daily.every(day => day.ci === null), true)
  // The counts are still numbers: a CI read that failed does not erase them.
  assert.equal(daily[0].newIssues, 1)
  assert.ok(snapshot.missing.some(item => item.part === 'ci'))
})

test('a count built from a list that stopped at the page cap is unknown, not smaller (#1222)', async () => {
  // Both lists answer four full pages, so the walk ends on the cap with a tail nobody read. The
  // week's window is capped; today's own window stops on its first page because these rows are
  // already older than it, so today keeps its measurements and the cap reaches only the six days
  // whose list it truncated.
  const { board, github } = build({ listsCapped: true })
  const snapshot = await settle(board)
  const daily = snapshot.metrics.daily
  assert.equal(daily.length, 7)
  for (const day of daily.slice(0, 6)) {
    assert.equal(day.newIssues, null, `${day.date} sits in a list that stopped at the page cap`)
    assert.equal(day.closedIssues, null, `${day.date} has no issue count to show`)
    assert.equal(day.newPullRequests, null, `${day.date} has no pull count to show`)
    assert.equal(day.mergedPullRequests, null)
  }
  // Today read its own window whole: an unknown day never costs a day that was measured.
  assert.equal(typeof daily[6].newIssues, 'number')
  assert.equal(typeof daily[6].closedIssues, 'number')
  assert.equal(typeof daily[6].newPullRequests, 'number')
  assert.equal(typeof daily[6].mergedPullRequests, 'number')
  // The header counts are built from the same lists but are not per-day: the cap nulls the series
  // entry, never the number a reader compares across the week.
  assert.equal(typeof snapshot.metrics.today.newIssues, 'number')
  assert.equal(typeof snapshot.metrics.week.newIssues, 'number')
  assert.equal(daily[6].newIssues, snapshot.metrics.today.newIssues)
  const issueCalls = github.calls.filter(call => call.path === '/issues' && new URLSearchParams(call.query).get('state') === 'all')
  assert.equal(issueCalls.filter(call => new URLSearchParams(call.query).get('page') === '4').length >= 1, true, 'the week really walked into the page cap')
})

test('a window that stopped early on an old row is complete, not unknown (#1222)', async () => {
  // A full first page of rows older than the window ends the walk with nothing left unread. The
  // page-count heuristic reads that as "the list had more to give"; it must not, or a quiet week
  // would drift into permanent unknowns.
  const { board, github } = build({ listsStale: true })
  const snapshot = await settle(board)
  const daily = snapshot.metrics.daily
  assert.equal(daily.length, 7)
  // Nothing was opened or merged inside the seven days, and that is a measurement: 0, never null.
  for (const day of daily) {
    assert.equal(day.newIssues, 0, `${day.date} was read whole`)
    assert.equal(day.closedIssues, 0)
    assert.equal(day.newPullRequests, 0)
    assert.equal(day.mergedPullRequests, 0)
  }
  // One page per window, not four: the walk stopped on the old row rather than at the cap.
  const issueCalls = github.calls.filter(call => call.path === '/issues' && new URLSearchParams(call.query).get('state') === 'all')
  assert.equal(issueCalls.length, 2, 'week plus today, one page each')
  assert.equal(issueCalls.some(call => new URLSearchParams(call.query).get('page') === '2'), false)
  assert.equal(snapshot.missing.some(item => item.part === 'issues' || item.part === 'pulls'), false)
})

test('a full page four that stopped on an old row is a complete window, not a capped one (#1240)', async () => {
  // The page count cannot tell these apart: four full pages either hit the cap or ended because the
  // stop row was on page four. Only the walk knows, so the flag has to come from it.
  const { board } = build({ listsStopLate: true })
  const snapshot = await settle(board)
  const daily = snapshot.metrics.daily
  assert.equal(daily.length, 7)
  const byDate = Object.fromEntries(daily.map(day => [day.date, day]))
  // 300 rows on pages one to three plus 99 on page four; the hundredth is the old row that stopped
  // the walk. Every one of them was measured, so none of these days is unknown.
  assert.equal(byDate['2026-10-20'].newIssues, 399)
  assert.equal(byDate['2026-10-20'].newPullRequests, 399)
  assert.equal(daily.every(day => day.newIssues !== null && day.newPullRequests !== null), true)
  assert.equal(typeof snapshot.metrics.week.newIssues, 'number')
})

test('CI that cannot be read leaves every day at null, never at a zero share (#1222)', async () => {
  const { board } = build({ failures: { '/actions/runs': { status: 403, headers: { 'retry-after': '30' } } } })
  const snapshot = await settle(board)
  const daily = snapshot.metrics.daily
  assert.equal(daily.every(day => day.ci === null), true)
  assert.equal(daily[6].closedIssues, 1)
})

test('no week, no series: a window nobody read is null, not seven zero days (#1222)', () => {
  // The series is assembled from the two windows the round read; without the week there is nothing
  // to draw, and the view says so instead of drawing a flat line at zero.
  assert.equal(dailySeries(null, null, AT('2026-10-24T16:00:00Z')), null)
  const today = AT('2026-10-24T16:00:00Z')
  const only = { daily: [{ start: today, newIssues: 1, closedIssues: 0, newPullRequests: 0, mergedPullRequests: 0, ci: null }] }
  assert.equal(dailySeries(null, only, today), null, 'six days without a bucket are six unknown days')
  assert.equal(dailySeries({ daily: [] }, only, today), null)
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

// #1250: the host resolves which repository it reads before any board exists, says where the name
// came from, and keeps one board per repository. The resolver's own levels are in
// delivery-repo.test.js; these tests hold the host wiring around it.
const hostWith = (github, extra = {}) => {
  const rt = {
    config: {},
    secretValue: () => 'SECRET-TOKEN',
    loadSecrets: async () => {},
    fetch: github.request,
    warn: () => {},
    ...extra,
  }
  const installed = Object.assign({}, rt)
  install(installed)
  return installed
}

test('the instance setting names the repository for the board and the probe, and says "config" (#1250)', async () => {
  const github = fakeGitHub({ slug: 'acme/widget' })
  const installed = hostWith(github, { config: { deliveryRepo: 'acme/widget' } })
  const loading = await installed.deliveryBoard()
  assert.equal(loading.repo, 'acme/widget')
  assert.equal(loading.repoSource, 'config')
  const settled = await installed.deliveryBoard({ wait: true })
  assert.equal(settled.state, 'fresh')
  assert.equal(settled.repo, 'acme/widget')
  assert.equal(settled.repoSource, 'config')
  // Every read, not only the repo call, went to the repository the instance named.
  assert.ok(github.calls.length > 0)
  for (const call of github.calls) assert.match(call.url, /^https:\/\/api\.github\.com\/repos\/acme\/widget(\/|$|\?)/, call.url)
  const probe = await installed.deliveryProbe()
  assert.equal(probe.repo, 'acme/widget')
  assert.equal(probe.repoSource, 'config')
  assert.ok(probe.rows.every(row => row.ok))
})

test('a dotted or nested delivery.repo names the repository too, as a user writes it (#1258)', async () => {
  // The hint says `delivery.repo`, so that is what a profile carries — as a literal dotted key or
  // nested; a literal key wins nowhere, it is simply read. The flat `deliveryRepo` is the third.
  for (const config of [{ 'delivery.repo': 'acme/widget' }, { delivery: { repo: 'acme/widget' } }]) {
    const github = fakeGitHub({ slug: 'acme/widget' })
    const installed = hostWith(github, { config })
    const settled = await installed.deliveryBoard({ wait: true })
    assert.equal(settled.repo, 'acme/widget', JSON.stringify(config))
    assert.equal(settled.repoSource, 'config', JSON.stringify(config))
    assert.equal(settled.state, 'fresh')
    for (const call of github.calls) assert.match(call.url, /^https:\/\/api\.github\.com\/repos\/acme\/widget(\/|$|\?)/, call.url)
  }
})

test('the workspace git remote names the repository when there is no setting (#1250)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'delivery-install-'))
  try {
    mkdirSync(join(dir, '.git'))
    writeFileSync(join(dir, '.git', 'config'), '[remote "origin"]\n\turl = git@github.com:acme/widget.git\n')
    const github = fakeGitHub({ slug: 'acme/widget' })
    const installed = hostWith(github, {
      // The team folder is the instance's workspace, which is where the board's one repository lives.
      ctx: { workspaceRegistry: { get: id => (id === 'team' ? { path: dir } : undefined) } },
      state: { workspaceId: 'team' },
    })
    const settled = await installed.deliveryBoard({ wait: true })
    assert.equal(settled.repo, 'acme/widget')
    assert.equal(settled.repoSource, 'remote')
    assert.equal(settled.state, 'fresh')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a changed setting re-resolves, and the new repository starts at loading (#1250)', async () => {
  // The cache is keyed by repository, so the previous repository's snapshot can never answer for
  // the new name: the new board's first read is its own `loading`.
  const one = fakeGitHub({ slug: 'o/r' })
  const two = fakeGitHub({ slug: 'acme/widget' })
  const request = (url, init) => (url.includes('/repos/acme/widget') ? two.request(url, init) : one.request(url, init))
  const config = { deliveryRepo: 'o/r' }
  const installed = hostWith({ request, calls: [] }, { config })
  const before = await installed.deliveryBoard({ wait: true })
  assert.equal(before.state, 'fresh')
  assert.equal(before.repo, 'o/r')

  config.deliveryRepo = 'acme/widget'
  const loading = await installed.deliveryBoard()
  assert.equal(loading.state, 'loading')
  assert.equal(loading.repo, 'acme/widget')
  assert.equal(loading.columns, undefined, 'the old repository columns must not be served for the new name')
  const after = await installed.deliveryBoard({ wait: true })
  assert.equal(after.state, 'fresh')
  assert.equal(after.repo, 'acme/widget')
  assert.ok(two.calls.length > 0)
  assert.ok(two.calls.every(call => call.path === '/' || call.path.startsWith('/repos/acme/widget') || !call.path.startsWith('/repos/')))
})

test('the package repository answers only last, labelled a default, and says so in the log (#1250)', async () => {
  const github = fakeGitHub({ slug: 'ThinkFlowLab/FlyBot' })
  const warnings = []
  const installed = hostWith(github, {
    packageRepository: 'git+https://github.com/ThinkFlowLab/FlyBot.git',
    // The host's warning log is printf-shaped; substitute so the assertion reads the message a person sees.
    warn: (format, ...rest) => { let index = 0; warnings.push(String(format).replace(/%s/g, () => String(rest[index++] ?? ''))) },
  })
  const settled = await installed.deliveryBoard({ wait: true })
  assert.equal(settled.repo, 'ThinkFlowLab/FlyBot')
  assert.equal(settled.repoSource, 'package')
  // A default is acceptable only while it is visible as one, in the log as well as on the page.
  assert.equal(warnings.filter(line => /package repository ThinkFlowLab\/FlyBot \(default\)/.test(line)).length, 1)
  const again = await installed.deliveryBoard()
  assert.equal(again.repoSource, 'package')
  assert.equal(warnings.filter(line => /\(default\)/.test(line)).length, 1, 'the default is recorded once, not on every read')
})

test('with nothing to read, the board and the probe refuse before any request (#1250)', async () => {
  let requests = 0
  const installed = hostWith({ request: async () => { requests += 1; throw new Error('must not be asked') } }, {
    packageRepository: '',
  })
  const answer = await installed.deliveryBoard()
  assert.equal(answer.state, 'failed')
  assert.equal(answer.repo, null)
  assert.equal(answer.repoSource, null)
  assert.equal(answer.error.kind, 'no-repo')
  assert.equal(answer.error.message, 'no repository — set delivery.repo')
  const probe = await installed.deliveryProbe()
  assert.equal(probe.ok, false)
  assert.equal(probe.repo, null)
  assert.equal(probe.error, 'no repository — set delivery.repo')
  // Not `/repos/null`, not a probe of nothing: the resolution refuses first.
  assert.equal(requests, 0)
})

test('a repository the token cannot read fails naming the repository and the endpoint (#1250)', async () => {
  const github = fakeGitHub({ slug: 'acme/widget', failures: { '/issues': { status: 404 } } })
  const installed = hostWith(github, { config: { deliveryRepo: 'acme/widget' } })
  const answer = await installed.deliveryBoard({ wait: true })
  assert.equal(answer.state, 'failed')
  assert.equal(answer.repo, 'acme/widget')
  assert.equal(answer.error.status, 404)
  assert.equal(answer.error.endpoint, '/repos/acme/widget/issues')
  // The same failure shape as #1211/#1232, now naming whose 404 it is.
  assert.match(answer.error.message, /acme\/widget/)
  assert.match(answer.error.message, /\/repos\/acme\/widget\/issues/)
})

// #1265 step 4: one board with more than one repository. Each name resolves with its own source,
// each repository keeps its own snapshot and cache, and one that cannot be read no longer takes the
// board with it.
test('two repositories are two blocks of one board, each with its own source (#1265)', async () => {
  const one = fakeGitHub({ slug: 'acme/one' })
  const two = fakeGitHub({ slug: 'acme/two' })
  const request = (url, init) => (url.includes('/repos/acme/two') ? two.request(url, init) : one.request(url, init))
  const installed = hostWith({ request, calls: [] }, { config: { delivery: { repos: ['acme/one', 'acme/two'] } } })
  const loading = await installed.deliveryBoard()
  assert.equal(loading.state, 'loading')
  assert.equal(loading.repo, null, 'no single repository owns a shared board')
  assert.deepEqual(loading.repos.map(entry => [entry.repo, entry.repoSource, entry.state]),
    [['acme/one', 'config', 'loading'], ['acme/two', 'config', 'loading']])
  const settled = await installed.deliveryBoard({ wait: true })
  assert.equal(settled.state, 'fresh')
  assert.equal(settled.repo, null)
  assert.equal(settled.repoSource, null)
  assert.deepEqual(settled.repos.map(entry => [entry.repo, entry.repoSource, entry.state]),
    [['acme/one', 'config', 'fresh'], ['acme/two', 'config', 'fresh']])
  // Each repository's reads went to its own API path: one board, two sources, never one line.
  assert.ok(one.calls.length > 0 && two.calls.length > 0)
  assert.ok(one.calls.every(call => call.url.startsWith('https://api.github.com/repos/acme/one')))
  assert.ok(two.calls.every(call => call.url.startsWith('https://api.github.com/repos/acme/two')))
  // The union carries both repositories' cards: the same issue number in two repositories is two
  // cards, and the second one does not disappear behind the first.
  assert.deepEqual(settled.repos[0].columns['not-started'].map(card => card.number).sort(), [10, 11, 13])
  assert.deepEqual(settled.repos[1].columns['not-started'].map(card => card.number).sort(), [10, 11, 13])
  assert.equal(settled.columns['not-started'].length, 6, 'the same number from each repository is its own card')
  // The header's numbers are the repositories' sums; a median across repositories is not a median,
  // so it is unknown instead of invented.
  assert.equal(settled.metrics.today.newIssues,
    settled.repos[0].metrics.today.newIssues + settled.repos[1].metrics.today.newIssues)
  assert.equal(settled.metrics.open.issues,
    settled.repos[0].metrics.open.issues + settled.repos[1].metrics.open.issues)
  assert.equal(settled.metrics.today.medianIssueCloseMs, null)
  assert.equal(settled.metrics.open.medianIssueAgeMs, null)
  // The probe asks each repository and names it on every row, so a status can be acted on.
  const probe = await installed.deliveryProbe()
  assert.equal(probe.repo, null)
  assert.deepEqual(probe.repos.map(entry => entry.repo), ['acme/one', 'acme/two'])
  assert.ok(probe.rows.length > 0)
  assert.deepEqual([...new Set(probe.rows.map(row => row.repo))].sort(), ['acme/one', 'acme/two'])
})

test('one repository that cannot be read leaves the other on the board as partial (#1265)', async () => {
  const one = fakeGitHub({ slug: 'acme/one' })
  const two = fakeGitHub({ slug: 'acme/two', failures: { '/issues': { status: 404 } } })
  const request = (url, init) => (url.includes('/repos/acme/two') ? two.request(url, init) : one.request(url, init))
  const installed = hostWith({ request, calls: [] }, { config: { delivery: { repos: ['acme/one', 'acme/two'] } } })
  const settled = await installed.deliveryBoard({ wait: true })
  assert.equal(settled.state, 'partial', 'a failed repository is partial, not a failed board')
  const good = settled.repos.find(entry => entry.repo === 'acme/one')
  const bad = settled.repos.find(entry => entry.repo === 'acme/two')
  assert.equal(good.state, 'fresh')
  assert.ok(good.columns)
  assert.equal(bad.state, 'failed')
  assert.equal(bad.columns, undefined)
  assert.equal(bad.error.kind, 'not-found')
  // The failure names its own repository, so the page can say whose read it was.
  assert.match(bad.error.endpoint, /\/repos\/acme\/two\//)
  assert.equal(settled.error.kind, 'not-found')
  assert.equal(settled.missing.length, 0, 'a failed round answers its error, not a partial list')
  assert.equal(settled.columns, undefined, 'a partial union is not passed off as a whole one')
})

test('a one-repository instance answers the payload it always answered (#1265)', async () => {
  const github = fakeGitHub({ slug: 'acme/widget' })
  const installed = hostWith(github, { config: { delivery: { repos: ['acme/widget'] } } })
  const settled = await installed.deliveryBoard({ wait: true })
  assert.equal(settled.repo, 'acme/widget')
  assert.equal(settled.repoSource, 'config')
  assert.equal(settled.state, 'fresh')
  // One entry in the list, so the view can tell one repository from many without guessing.
  assert.equal(settled.repos.length, 1)
  assert.deepEqual(Object.keys(settled.columns), DELIVERY_COLUMNS)
})

test('the aggregation rules: oldest snapshot, partial body, and no invented median (#1265)', () => {
  const stamp = '2026-10-25T04:00:00Z'
  const view = (repo, extra = {}) => ({
    ok: true, state: 'fresh', repo, repoSource: 'config', asOf: stamp, since: stamp, attempt: 1, elapsedMs: 10,
    computedMs: 10, columns: { 'not-started': [], 'in-progress': [], done: [] },
    counts: { 'not-started': 0, 'in-progress': 0, done: 0 },
    metrics: {
      dayStart: stamp, timeZone: 'Asia/Shanghai',
      today: { newIssues: 1, closedIssues: 0, newPullRequests: 0, mergedPullRequests: 0, medianIssueCloseMs: 1, medianPullMergeMs: 2, ci: { failed: 0, total: 1, counted: 1, superseded: 0 } },
      week: null, daily: null,
      open: { issues: 1, pullRequests: 0, needsHuman: 0, medianIssueAgeMs: 3 },
    },
    ...extra,
  })
  const single = combineRepos([view('acme/one')])
  assert.equal(single.state, 'fresh')
  assert.equal(single.repo, 'acme/one', 'one repository answers with today\'s payload')
  assert.equal(single.repos.length, 1)

  const mixed = combineRepos([
    view('acme/one', { state: 'stale', stale: true, asOf: '2026-10-25T03:00:00Z', retryAt: 5_000 }),
    view('acme/two', { asOf: '2026-10-25T02:00:00Z' }),
  ])
  assert.equal(mixed.state, 'stale')
  assert.equal(mixed.asOf, '2026-10-25T02:00:00Z', 'the oldest snapshot, never a fresher claim')
  assert.equal(mixed.metrics.today.newIssues, 2)
  // Nothing that could not be read becomes a zero, and no median is invented from two medians.
  assert.equal(mixed.metrics.today.medianIssueCloseMs, null)
  assert.equal(mixed.metrics.week, null)
  assert.equal(mixed.metrics.daily, null)
  assert.equal(mixed.metrics.open.medianIssueAgeMs, null)

  const partial = combineRepos([
    view('acme/one'),
    { ok: false, state: 'failed', repo: 'acme/two', repoSource: 'config', since: null, attempt: 0, elapsedMs: 0, error: { message: 'GitHub answered 404 for /repos/acme/two/issues', kind: 'not-found' }, retryAt: 10_000 },
  ])
  assert.equal(partial.state, 'partial')
  assert.equal(partial.partial, true)
  assert.ok(partial.repos[0].columns)
  assert.equal(partial.repos[1].columns, undefined)
  // Nothing readable is left out.
  assert.equal(partial.columns, undefined)
  assert.equal(partial.retryAt, 10_000)
  // A partial board prints no total it can only half count (#1297 INC): one repository read and
  // one did not, so the sums are unknown. Printing the readable half under "2 repositories" is the
  // very "a number that looks like a fact" failure the null rule in this file exists to prevent.
  assert.equal(partial.metrics, null)
  assert.equal(partial.repos[0].metrics.today.newIssues, 1, 'the readable repository keeps its own numbers')
  // While every repository reads, the sums are the board's and stay numbers, medians excepted.
  assert.equal(mixed.metrics.open.issues, 2)
  assert.equal(mixed.metrics.open.medianIssueAgeMs, null)

  // A part that could not be read names its repository too, so one line cannot be read as another's.
  const withMissing = combineRepos([
    view('acme/one', { state: 'partial', partial: true, missing: [{ part: 'ci', message: 'GitHub answered 404' }] }),
    view('acme/two'),
  ])
  assert.equal(withMissing.state, 'partial')
  assert.deepEqual(withMissing.missing.map(entry => [entry.repo, entry.part]), [['acme/one', 'ci']])
})

// A card names its workflow and its node with two labels (#1272 step 3, acceptance 8): a card that
// carries them can be laid in its workflow's column, and a card that carries none is exactly today's
// card — the same fields, the five columns it always had, nothing invented.
test('a card reads its workflow and node from its labels, and a card without them is unchanged (#1272 step 3)', () => {
  const tagged = cardOf({ number: 5, title: 'tagged', html_url: 'u', labels: [{ name: 'workflow:repo-dev' }, { name: 'node:build' }, { name: 'bug' }] }, { kind: 'issue' })
  assert.equal(tagged.workflow, 'repo-dev')
  assert.equal(tagged.node, 'build')
  assert.deepEqual([...tagged.labels], ['bug', 'node:build', 'workflow:repo-dev'])
  const plain = cardOf({ number: 6, title: 'plain', html_url: 'u', labels: [{ name: 'bug' }] }, { kind: 'issue' })
  assert.equal(plain.workflow, null)
  assert.equal(plain.node, null)
  // A label with the prefix and nothing after it names no workflow rather than an empty one.
  assert.equal(cardOf({ number: 7, labels: [{ name: 'workflow:' }] }, { kind: 'issue' }).workflow, null)
})
