// The delivery board (#1173) is a read-only view of GitHub: five columns, one cached snapshot,
// metrics with an Asia/Shanghai day boundary, and no write request anywhere.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { createDeliveryBoard, DELIVERY_COLUMNS, install, median, startOfDay } from '../src/host/delivery-board.js'

const NOW = Date.parse('2026-10-25T04:00:00Z') // 12:00 in Asia/Shanghai
const AT = (iso) => Date.parse(iso)

function fakeGitHub({ comments = {}, checks = {}, closedExtra = [], mergedExtra = [], openPullsExtra = [] } = {}) {
  const calls = []
  const write = (body, status = 200) => ({ ok: status < 400, status, headers: { get: () => 'etag-1' }, json: async () => body })
  const request = async (url, init = {}) => {
    const parsed = new URL(url)
    const path = parsed.pathname.replace('/repos/o/r', '')
    const page = Number(parsed.searchParams.get('page') ?? 1)
    calls.push({ path, method: init.method, headers: init.headers ?? {}, query: parsed.search })
    if (init.method !== 'GET') throw new Error(`the delivery board must not send ${init.method}`)
    if (path === '/issues' && parsed.searchParams.get('state') === 'open') {
      return write(page === 1 ? [
        { number: 10, title: 'Untriaged', html_url: 'https://x/10', labels: [{ name: 'bug' }], created_at: '2026-10-20T00:00:00Z', updated_at: '2026-10-24T00:00:00Z' },
        { number: 11, title: 'Ready', html_url: 'https://x/11', labels: [{ name: 'agent-ready' }, { name: 'enhancement' }], created_at: '2026-10-21T00:00:00Z', updated_at: '2026-10-23T00:00:00Z' },
        { number: 12, title: 'Working', html_url: 'https://x/12', labels: [{ name: 'agent-working' }, { name: 'agent-ready' }], created_at: '2026-10-19T00:00:00Z', updated_at: '2026-10-22T00:00:00Z' },
        { number: 13, title: 'Needs a human', html_url: 'https://x/13', labels: [{ name: 'needs-info' }], created_at: '2026-09-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' },
      ] : [])
    }
    if (path === '/pulls' && parsed.searchParams.get('state') === 'open') {
      return write(page === 1 ? [
        { number: 40, title: 'Pending verdict', html_url: 'https://x/40', body: 'Owner: Dev', head: { sha: 'aaaaaaa1' }, mergeable_state: 'unstable', created_at: '2026-10-24T00:00:00Z', updated_at: '2026-10-24T10:00:00Z', labels: [] },
        { number: 41, title: 'Fix the thing', html_url: 'https://x/41', body: 'Fixes #12', head: { sha: 'bbbbbbb2' }, mergeable_state: 'clean', created_at: '2026-10-23T00:00:00Z', updated_at: '2026-10-24T09:00:00Z', labels: [{ name: 'agent-pr' }] },
        ...openPullsExtra,
      ] : [])
    }
    if (path === '/pulls' && parsed.searchParams.get('state') === 'all') {
      return write(page === 1 ? [
        { number: 41, title: 'Fix the thing', html_url: 'https://x/41', created_at: '2026-10-23T00:00:00Z', merged_at: '2026-10-25T02:00:00Z', updated_at: '2026-10-25T02:00:00Z' },
        { number: 42, title: 'Older merge', html_url: 'https://x/42', created_at: '2026-10-22T00:00:00Z', merged_at: '2026-10-24T02:00:00Z', updated_at: '2026-10-24T02:00:00Z' },
      ] : [])
    }
    if (path === '/pulls' && parsed.searchParams.get('state') === 'closed') {
      return write(page === 1 ? [
        { number: 41, title: 'Fix the thing', html_url: 'https://x/41', created_at: '2026-10-23T00:00:00Z', merged_at: '2026-10-25T02:00:00Z', updated_at: '2026-10-25T02:00:00Z', merge_commit_sha: 'ccccccc3' },
        ...mergedExtra,
      ] : [])
    }
    if (path === '/issues' && parsed.searchParams.get('state') === 'all') {
      return write(page === 1 ? [
        { number: 10, title: 'Untriaged', created_at: '2026-10-20T00:00:00Z', closed_at: null, state_reason: null },
        { number: 11, title: 'Ready', created_at: '2026-10-21T00:00:00Z', closed_at: null, state_reason: null },
        { number: 12, title: 'Working', created_at: '2026-10-19T00:00:00Z', closed_at: null, state_reason: null },
        { number: 41, title: 'a PR, not an issue', pull_request: { url: 'x' }, created_at: '2026-10-23T00:00:00Z' },
        { number: 14, title: 'Closed today', created_at: '2026-10-20T00:00:00Z', closed_at: '2026-10-25T01:00:00Z', state_reason: 'completed' },
        { number: 15, title: 'Closed yesterday', created_at: '2026-10-21T00:00:00Z', closed_at: '2026-10-24T01:00:00Z', state_reason: 'not_planned' },
      ] : [])
    }
    if (path === '/issues' && parsed.searchParams.get('state') === 'closed') {
      return write(page === 1 ? [
        { number: 14, title: 'Closed today', html_url: 'https://x/14', created_at: '2026-10-20T00:00:00Z', closed_at: '2026-10-25T01:00:00Z', state_reason: 'completed', updated_at: '2026-10-25T01:00:00Z', labels: [] },
        // A merged pull as /issues?state=closed really returns it: the merge time lives on the
        // pull_request object, there is no top-level merged_at and no head (#1173).
        { number: 41, title: 'Fix the thing', html_url: 'https://x/41', pull_request: { url: 'x', html_url: 'https://x/41', diff_url: 'https://x/41.diff', patch_url: 'https://x/41.patch', merged_at: '2026-10-25T02:00:00Z' }, created_at: '2026-10-23T00:00:00Z', closed_at: '2026-10-25T02:00:00Z', updated_at: '2026-10-25T02:00:00Z', labels: [] },
        ...closedExtra,
      ] : [])
    }
    if (path.startsWith('/actions/runs')) {
      return write({
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
      return write(pagesOf[page - 1] ?? [])
    }
    if (/^\/commits\/.+\/check-runs$/.test(path)) {
      const sha = path.split('/')[2]
      return write({ check_runs: checks[sha] ?? [] })
    }
    return write({ message: 'not found' }, 404)
  }
  return { request, calls }
}

const build = (options = {}) => {
  const github = fakeGitHub(options)
  const board = createDeliveryBoard({ repo: 'o/r', token: 'SECRET-TOKEN', request: github.request, now: () => NOW })
  return { board, github }
}

test('the delivery board is read-only and the payload carries no credential (#1173)', async () => {
  const { board, github } = build()
  const snapshot = await board.read()
  assert.ok(github.calls.length > 0)
  assert.deepEqual([...new Set(github.calls.map(call => call.method))], ['GET'])
  for (const call of github.calls) assert.match(call.headers.Authorization ?? '', /^Bearer SECRET-TOKEN$/)
  assert.doesNotMatch(JSON.stringify(snapshot), /SECRET-TOKEN|Authorization/)
})

test('five columns come from one snapshot, an issue and its PR linked (#1173)', async () => {
  const { board } = build()
  const snapshot = await board.read()
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
  const snapshot = await board.read()
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
  const snapshot = await board.read()
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
  const snapshot = await board.read()
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
  const snapshot = await board.read()
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
  const snapshot = await board.read()
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
  const snapshot = await board.read()
  const card = snapshot.columns.review.find(item => item.number === 41)
  assert.equal(card.badge, 'inc')
  assert.ok(github.calls.some(call => call.path === '/issues/41/comments' && /[?&]page=2(&|$)/.test(call.query)))
})

test('the token is read per request, and install loads the secrets first (#1173)', async () => {
  // A token captured at install time is empty until the host loads secrets; every request must
  // resolve it again, and the first read must ask the host to load them (#1173 INC).
  const direct = fakeGitHub()
  let secret
  const board = createDeliveryBoard({ repo: 'o/r', token: () => secret, request: direct.request, now: () => NOW })
  await board.read()
  assert.ok(direct.calls.every(call => call.headers.Authorization === undefined))
  secret = 'SECRET-TOKEN'
  await board.read({ force: true })
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
  const snapshot = await installed.deliveryBoard()
  assert.equal(loads, 1)
  assert.equal(snapshot.ok, true)
  assert.ok(github.calls.length > 0)
  assert.ok(github.calls.every(call => call.headers.Authorization === 'Bearer SECRET-TOKEN'))
})

test('a PR badge reads the verdict at its own tip, and CI when there is none (#1173)', async () => {
  const { board } = build({
    comments: {
      40: [{ body: 'Verdict: PASS at deadbee\nAttestation: deadbee role=Reviewer2' }],
      41: [{ body: 'Verdict: PASS at bbbbbbb\nAttestation: bbbbbbb2 role=Reviewer' }],
    },
    checks: { aaaaaaa1: [{ status: 'in_progress', conclusion: null }], bbbbbbb2: [{ status: 'completed', conclusion: 'success' }] },
  })
  const snapshot = await board.read()
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
  const snapshot = await board.read()
  const { today, week, open } = snapshot.metrics
  assert.equal(today.newIssues, 0)
  assert.equal(today.closedIssues, 1)
  assert.equal(today.closedReasons.completed, 1)
  assert.equal(today.closedReasons.notPlanned, 0)
  assert.equal(today.mergedPullRequests, 1)
  assert.equal(today.medianPullMergeMs, AT('2026-10-25T02:00:00Z') - AT('2026-10-23T00:00:00Z'))
  assert.deepEqual(today.ci, { failed: 1, superseded: 1, counted: 3, total: 3 })
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
  const first = await board.read({ force: true })
  assert.equal(first.stale, undefined)
  const requestsAfterFirst = github.calls.length
  clock += 30_000
  const cached = await board.read()
  assert.equal(github.calls.length, requestsAfterFirst, 'a fresh cache makes no request')
  assert.equal(cached.asOf, first.asOf)
  // Past the TTL the old snapshot is served at once, and the refresh runs in the background.
  clock += 60_000
  const stale = await board.read()
  assert.equal(stale.stale, true)
  assert.equal(stale.refreshing, true)
  assert.equal(stale.asOf, first.asOf)
  await new Promise(resolve => setImmediate(resolve))
  await board.read({ force: true })
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
  await board.read()
  const runs = github.calls.filter(call => call.path.startsWith('/actions/runs'))
  assert.ok(runs.length > 0)
  for (const call of runs) {
    const created = new URLSearchParams(call.query).get('created')
    assert.match(created, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z\.\.\d{4}-\d{2}-\d{2}T[\d:.]+Z$/, `created=${created}`)
  }
})
