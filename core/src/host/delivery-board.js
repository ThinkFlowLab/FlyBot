// Delivery board (#1173): one read-only snapshot of the repository's GitHub issues, pull
// requests and CI runs, laid out by delivery stage. This module is a view over GitHub, not a
// writer: every request it makes is a GET, the token stays in this process, and the payload the
// client receives carries no credential. The snapshot is cached; a stale cache is still served
// while a refresh runs, and the payload says when it was taken.
//
// A round neither blocks the caller nor fails whole (#1211): the first read answers
// `state: 'loading'` at once and the round runs behind `inflight`; a part that cannot be read is
// named in `missing` and the rest of the board still comes back; a round that outlives its 90
// second budget lands as `partial` with what it has. Every failure carries
// `{ message, endpoint, status, kind, scope, at }` so the view can say what failed, where, and what
// to do about it. "No GitHub connection yet" is reserved for a host that has never tried.
import { repoSlug } from './update.js'

export const DELIVERY_COLUMNS = ['raw', 'ready', 'working', 'review', 'done-today']

// State labels first on a card, then the areas; the order is the order the board shows.
const STATE_LABELS = ['needs-human', 'needs-info', 'agent-ready', 'agent-working', 'agent-pr', 'awaiting-approval', 'hold']
const DAY_MS = 86_400_000
// Asia/Shanghai has no daylight saving; the day boundary the owner reads is its 00:00.
const SHANGHAI_OFFSET_MS = 8 * 3_600_000
const CACHE_TTL_MS = 5 * 60_000
const PAGE = 100
// GitHub caps a list at 1000 items per query; the CI payload says counted/total instead of
// pretending the tail does not exist.
const MAX_PAGES = 10
const REQUEST_TIMEOUT_MS = 20_000
const MAX_DONE = 40
// A round that runs past this lands as `partial` instead of reaching the browser as a timeout
// (#1211): the instance sits behind a reverse proxy that gives up long before an unbounded round
// would finish.
export const BUILD_BUDGET_MS = 90_000
// After a failed round the next one waits 10 s, then 30 s, then two minutes, and never longer than
// that. The fixed 60 second poll either hammered a broken instance or hid a recovery (#1211).
export const BACKOFF_MS = [10_000, 30_000, 120_000]

export const startOfDay = (now = Date.now()) => Math.floor((now + SHANGHAI_OFFSET_MS) / DAY_MS) * DAY_MS - SHANGHAI_OFFSET_MS

export function median(values) {
  const list = (values ?? []).filter(value => Number.isFinite(value)).sort((a, b) => a - b)
  if (list.length === 0) return null
  const middle = Math.floor(list.length / 2)
  return list.length % 2 === 0 ? (list[middle - 1] + list[middle]) / 2 : list[middle]
}

const labelNames = (row) => (row.labels ?? []).map(label => (typeof label === 'string' ? label : label?.name)).filter(Boolean)
const orderLabels = (names) => [...names].sort((a, b) => {
  const left = STATE_LABELS.indexOf(a), right = STATE_LABELS.indexOf(b)
  if (left !== -1 || right !== -1) return (left === -1 ? STATE_LABELS.length : left) - (right === -1 ? STATE_LABELS.length : right)
  return a.localeCompare(b)
})
// The issues endpoint returns pull requests too; the pulls endpoint never does, so the two
// lists are told apart by that field rather than by sniffing a PR's shape.
const isPull = (row) => row.pull_request !== undefined || row.merge_commit_sha !== undefined
// GitHub's closing keywords are the only mention that links a pull request to an issue (#1189).
// `also see #12`, `same as #12` or a changelog line quoting a number is prose, and a card that
// showed those as a link would claim a pull request that closes nothing.
const CLOSING_KEYWORD = /\b(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?)[ \t]*:?[ \t]*#(\d+)/gi
const closingLinks = (text) => [...String(text).matchAll(CLOSING_KEYWORD)].map(match => Number(match[1]))
const verdictOf = (comments) => {
  for (let index = (comments ?? []).length - 1; index >= 0; index -= 1) {
    const body = String(comments[index]?.body ?? '')
    const match = /^\s*Verdict:\s*(PASS|INC)\b(.*)$/im.exec(body)
    if (!match) continue
    // The Verdict line names the tip the conclusion is about, so its sha is the marker; an
    // Attestation line only stands in when the verdict line carries no sha. Reading them the other
    // way round would let an older attestation hide a verdict that names the current tip (#1173).
    const at = /^\s*Verdict:\s*(?:PASS|INC)\s+at\s+([0-9a-f]{7,40})/im.exec(body)?.[1] ?? null
    const attestation = at ?? /^\s*Attestation:\s*([0-9a-f]{7,40})/im.exec(body)?.[1] ?? null
    return { verdict: match[1].toUpperCase(), attestation }
  }
  return null
}

// A delivery card is a GitHub issue or pull request, never a Bot task record (#1173 keeps the
// track_tasks board separate).
export function cardOf(row, { kind, linked = null, owner = null, badge = null, sha = null } = {}) {
  return {
    kind,
    number: row.number,
    title: String(row.title ?? ''),
    url: String(row.html_url ?? ''),
    labels: orderLabels(labelNames(row)),
    owner,
    created: row.created_at ?? null,
    updated: row.updated_at ?? null,
    linked,
    badge,
    sha,
    draft: row.draft === true,
  }
}

export function columnOfDelivery(row, { kind }) {
  const labels = labelNames(row)
  if (kind === 'pr') return 'review'
  if (labels.includes('agent-working')) return 'working'
  if (labels.includes('agent-ready')) return 'ready'
  return 'raw'
}

// Which part of the board a path belongs to. The view turns this into advice a person can act on
// ("give the token Actions: Read"), so it travels with every failure (#1211).
export function scopeOf(pathname) {
  const path = String(pathname ?? '')
  if (/\/actions\/runs/.test(path)) return 'actions'
  if (/\/check-runs/.test(path)) return 'checks'
  if (/\/comments/.test(path)) return 'comments'
  if (/\/pulls/.test(path)) return 'pulls'
  if (/\/issues/.test(path)) return 'issues'
  if (/^\/repos\/[^/]+\/[^/]+$/.test(path)) return 'repo'
  return null
}

const headerOf = (response, name) => {
  try {
    const value = response?.headers?.get?.(name)
    return typeof value === 'string' && value !== '' ? value : null
  } catch { return null }
}

// How long GitHub itself said to wait, or null when it said nothing usable. A number from here is
// the only time the view may print a wait (#1211): an invented "about 60 seconds" is disproved by
// the next rate limit.
export function retryAfterMsOf(response, now = Date.now) {
  const retryAfter = headerOf(response, 'retry-after')
  if (retryAfter !== null) {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000)
    const at = Date.parse(retryAfter)
    if (Number.isFinite(at)) return Math.max(0, at - now())
  }
  const reset = Number(headerOf(response, 'x-ratelimit-reset'))
  if (Number.isFinite(reset) && reset > 0) return Math.max(0, reset * 1000 - now())
  return null
}

// One failure, described well enough to tell five causes apart (#1211): a timeout is not a 404, a
// rate limit is not a missing permission, and neither is "no token at all".
export function describeResponse(response, pathname, { now = Date.now } = {}) {
  const status = Number(response?.status ?? 0)
  const remaining = headerOf(response, 'x-ratelimit-remaining')
  const wait = retryAfterMsOf(response, now)
  const rateLimited = status === 429 || (status === 403 && (wait !== null || remaining === '0'))
  const kind = rateLimited ? 'rate-limit'
    : status === 401 ? 'auth'
      : status === 403 ? 'forbidden'
        : status === 404 ? 'not-found'
          : status >= 500 ? 'server'
            : 'http'
  const scope = scopeOf(pathname)
  const message = rateLimited
    ? `GitHub rate-limited this request for ${pathname}${wait === null ? '' : ` (retry after ${Math.ceil(wait / 1000)} s)`}`
    : `GitHub answered ${status} for ${pathname}`
  return { message, endpoint: pathname, status, kind, scope, retryAfterMs: rateLimited ? wait : null }
}

export const failureOf = (message, detail = {}) => Object.assign(new Error(message), detail)

async function readJson(response) {
  if (!response.ok) throw new Error(`GitHub answered ${response.status}`)
  return response.json()
}

// The diagnostic entry (#1211): the same reads the board makes, once, with their statuses, so an
// instance that "does not come up" can be explained instead of guessed at. The UI button and the
// `--probe` CLI both call this function; there is no second implementation.
export async function probeGitHub({ repo, token, request = fetch, now = Date.now, sha = null, issue = null } = {}) {
  const base = `https://api.github.com/repos/${repo}`
  const bearer = typeof token === 'function' ? token() : token
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'flybot-delivery-board' }
  if (bearer) headers.Authorization = `Bearer ${bearer}`
  const rows = []
  const ask = async (key, url) => {
    const pathname = new URL(url).pathname
    try {
      const response = await request(url, { method: 'GET', headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
      if (!response.ok) {
        const detail = describeResponse(response, pathname, { now })
        rows.push({ key, ok: false, ...detail })
        return null
      }
      rows.push({ key, ok: true, endpoint: pathname, status: response.status, kind: null, scope: scopeOf(pathname), retryAfterMs: null, message: null })
      return await response.json().catch(() => null)
    } catch (error) {
      const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError'
      rows.push({
        key, ok: false, endpoint: pathname, status: null,
        kind: timedOut ? 'timeout' : 'network', scope: scopeOf(pathname), retryAfterMs: null,
        message: timedOut
          ? `GitHub did not answer within ${REQUEST_TIMEOUT_MS / 1000} seconds for ${pathname}`
          : `GitHub request failed for ${pathname}: ${error?.message ?? error}`,
      })
      return null
    }
  }
  // The pull request list is asked first because the checks read needs a sha to ask about.
  const pullsBody = await ask('pulls', `${base}/pulls?per_page=1`)
  const openPull = Array.isArray(pullsBody) ? pullsBody[0] : null
  await ask('repo', base)
  await ask('actions', `${base}/actions/runs?per_page=1`)
  const target = sha ?? openPull?.head?.sha ?? null
  if (target) await ask('checks', `${base}/commits/${target}/check-runs?per_page=1`)
  else rows.push({ key: 'checks', ok: false, endpoint: `/repos/${repo}/commits/{sha}/check-runs`, status: null, kind: 'skipped', scope: 'checks', retryAfterMs: null, message: 'no sha to read checks at' })
  await ask('comments', `${base}/issues/${issue ?? openPull?.number ?? 1}/comments?per_page=1`)
  // The order the view prints them in; the order they were asked in is an implementation detail.
  const order = ['repo', 'actions', 'checks', 'comments', 'pulls']
  rows.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key))
  return { ok: rows.every(row => row.ok), repo, at: new Date(now()).toISOString(), rows }
}

export function createDeliveryBoard({ repo, token, request = fetch, now = Date.now, ttl = CACHE_TTL_MS, warn = () => {}, budgetMs = BUILD_BUDGET_MS } = {}) {
  // Secrets are read asynchronously after install, so the token is resolved per request: a value
  // captured at install time is empty until the next restart (#1173).
  const tokenNow = () => (typeof token === 'function' ? token() : token)
  const base = `https://api.github.com/repos/${repo}`
  const cache = new Map()
  let snapshot = null
  let lastError = null
  let inflight = null
  let since = null
  let attempt = 0
  let nextAttemptAt = 0
  // The round in progress: the deadline every request checks, and the parts that could not be read
  // this time. Null outside a round.
  let round = null

  const note = (part, error) => {
    if (round === null) return
    const detail = error !== null && typeof error === 'object' ? error : { message: String(error) }
    round.missing.push({
      part,
      scope: detail.scope ?? null,
      endpoint: detail.endpoint ?? null,
      status: detail.status ?? null,
      kind: detail.kind ?? 'unknown',
      retryAfterMs: detail.retryAfterMs ?? null,
      message: detail.message ?? String(error),
    })
  }

  // Every URL this board asks for is a read. A write would be a bug, so the shape is refused
  // here rather than trusted from the call sites (#1173 read-only invariant).
  async function get(url) {
    const pathname = new URL(url).pathname
    if (round !== null && now() > round.deadline) {
      throw failureOf(`the round used its ${Math.round(budgetMs / 1000)} second budget`, { budget: true, endpoint: pathname, kind: 'budget', scope: scopeOf(pathname) })
    }
    const cached = cache.get(url)
    const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'flybot-delivery-board' }
    const bearer = tokenNow()
    if (bearer) headers.Authorization = `Bearer ${bearer}`
    if (cached?.etag) headers['If-None-Match'] = cached.etag
    let response
    try {
      response = await request(url, { method: 'GET', headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    } catch (error) {
      const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError'
      throw failureOf(
        timedOut
          ? `GitHub did not answer within ${REQUEST_TIMEOUT_MS / 1000} seconds for ${pathname}`
          : `GitHub request failed for ${pathname}: ${error?.message ?? error}`,
        { endpoint: pathname, scope: scopeOf(pathname), status: null, kind: timedOut ? 'timeout' : 'network' },
      )
    }
    if (response.status === 304 && cached !== undefined) {
      cache.set(url, { ...cached, at: now() })
      return cached.body
    }
    if (!response.ok) {
      const detail = describeResponse(response, pathname, { now })
      throw failureOf(detail.message, detail)
    }
    const body = await readJson(response)
    cache.set(url, { etag: response.headers?.get?.('etag') ?? null, body, at: now() })
    return body
  }

  async function pages(path, { max = MAX_PAGES, stop = null } = {}) {
    const rows = []
    for (let page = 1; page <= max; page += 1) {
      const separator = path.includes('?') ? '&' : '?'
      const chunk = await get(`${base}${path}${separator}per_page=${PAGE}&page=${page}`)
      if (!Array.isArray(chunk)) break
      rows.push(...chunk)
      if (chunk.length < PAGE || (stop !== null && chunk.some(stop))) break
    }
    return rows
  }

  // Every page, not only the first (#1189). Past 100 comments — ordinary on this repository
  // (#1170, #1183) — the newest verdict sat on a page nothing read, and the badge fell back to
  // "no verdict at this tip" while one existed. The cap is the same MAX_PAGES as every other list
  // and each page is a cached GET (ETag), so a long thread costs up to MAX_PAGES reads of one URL
  // and a normal one still costs one.
  async function commentsOf(number) {
    return pages(`/issues/${number}/comments`)
  }

  async function runsOfDay(from, to) {
    // GitHub reads `created` as a date-time range in ISO 8601; epoch milliseconds are accepted
    // silently and match nothing, which reads as "no CI today" rather than an error (#1173).
    const created = `${new Date(from).toISOString()}..${new Date(to).toISOString()}`
    let total = null
    let counted = 0
    let failed = 0
    let superseded = 0
    let truncated = false
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const body = await get(`${base}/actions/runs?created=${created}&per_page=${PAGE}&page=${page}`)
      if (total === null) total = Number(body?.total_count ?? 0)
      const runs = Array.isArray(body?.workflow_runs) ? body.workflow_runs : []
      counted += runs.length
      for (const run of runs) {
        if (run.conclusion === 'failure' || run.conclusion === 'timed_out' || run.conclusion === 'startup_failure') failed += 1
        else if (run.conclusion === 'cancelled') superseded += 1
      }
      if (runs.length < PAGE) break
      // The page cap is not the end of the day: a day whose runs outnumber MAX_PAGES * PAGE has a
      // tail nobody counted, and its number is unknown rather than "no failures" (#1211).
      if (page === MAX_PAGES) truncated = true
    }
    return { failed, superseded, counted, total: total ?? counted, truncated }
  }

  const windowOf = (from) => ({ from, to: from + DAY_MS })

  // The CI half of a window, kept apart from the issue and pull counts: `/actions/runs` missing a
  // permission is one unknown number in the header, not an empty board (#1211).
  async function ciFor(from, ciDays) {
    const ci = { failed: 0, superseded: 0, counted: 0, total: 0, unknownDays: [] }
    for (let day = 0; day < ciDays; day += 1) {
      const window = windowOf(from - day * DAY_MS)
      const runs = await runsOfDay(window.from, window.to)
      if (runs.truncated) {
        // The tail was not read, so this day's number is unknown: it is named and left out rather
        // than added as a partial truth (#1211).
        note('ci', failureOf(`the workflow runs for ${new Date(window.from).toISOString()} were truncated at ${MAX_PAGES * PAGE}`, { kind: 'truncated', scope: 'actions', endpoint: '/actions/runs', status: null }))
        ci.unknownDays.push(new Date(window.from).toISOString())
        continue
      }
      ci.failed += runs.failed
      ci.superseded += runs.superseded
      ci.counted += runs.counted
      ci.total += runs.total
    }
    return ci
  }

  async function metricsFor(from, { days = 1, ciDays = 1 } = {}) {
    const to = from + days * DAY_MS
    const [issues, pulls] = await Promise.all([
      pages(`/issues?state=all&since=${new Date(from - DAY_MS).toISOString()}`, { max: 4, stop: row => row.created_at !== undefined && Date.parse(row.created_at) < from - DAY_MS }),
      pages('/pulls?state=all&sort=created&direction=desc', { max: 4, stop: row => Date.parse(row.created_at ?? 0) < from }),
    ])
    const plainIssues = issues.filter(row => !isPull(row))
    const inWindow = (value) => { const at = Date.parse(value ?? ''); return Number.isFinite(at) && at >= from && at < to }
    const newIssues = plainIssues.filter(row => inWindow(row.created_at)).length
    const closedIssues = plainIssues.filter(row => inWindow(row.closed_at))
    const newPrs = pulls.filter(row => inWindow(row.created_at)).length
    const merged = pulls.filter(row => inWindow(row.merged_at))
    // A CI window that cannot be read leaves `ci: null` — the header says unknown, never zero.
    let ci = null
    if (ciDays > 0) {
      try { ci = await ciFor(from, ciDays) } catch (error) {
        if (error?.budget) throw error
        note('ci', error)
      }
    }
    return {
      newIssues,
      closedIssues: closedIssues.length,
      closedReasons: {
        completed: closedIssues.filter(row => row.state_reason === 'completed').length,
        notPlanned: closedIssues.filter(row => row.state_reason === 'not_planned').length,
        duplicate: closedIssues.filter(row => row.state_reason === 'duplicate').length,
      },
      newPullRequests: newPrs,
      mergedPullRequests: merged.length,
      medianIssueCloseMs: median(closedIssues.map(row => Date.parse(row.closed_at) - Date.parse(row.created_at))),
      medianPullMergeMs: median(merged.map(row => Date.parse(row.merged_at) - Date.parse(row.created_at))),
      ci,
    }
  }

  function badgeFor(pr, verdict, checks) {
    const head = pr.head?.sha ?? ''
    const atTip = verdict !== null && verdict.attestation !== null && (head.startsWith(verdict.attestation) || verdict.attestation.startsWith(head))
    // A verdict only counts at the tip it names; an older one is history, so CI speaks.
    if (atTip) {
      if (verdict.verdict === 'INC') return { badge: 'inc', basis: 'INC at this tip' }
    } else {
      // `checks === null` is "could not be read", not "none ran": calling that "no verdict" would
      // blame the pull request for a permission the instance is missing (#1211).
      if (checks === null) return { badge: 'checks-unknown', basis: 'check-runs could not be read' }
      const states = (checks ?? []).map(run => run.status === 'completed' ? run.conclusion : run.status)
      if (states.some(state => state === 'in_progress' || state === 'queued' || state === 'requested' || state === 'waiting')) {
        return { badge: 'ci-running', basis: 'checks running' }
      }
      if (states.some(state => state === 'failure' || state === 'timed_out')) return { badge: 'ci-red', basis: 'checks failed' }
      return { badge: 'no-verdict', basis: verdict === null ? 'no verdict at this tip' : `verdict at ${verdict.attestation?.slice(0, 7) ?? 'another tip'} is older than this tip` }
    }
    // GitHub's REST API does not expose the merge queue. A clean, green PR is waiting to be
    // enqueued; one that is blocked or still waiting on checks is waiting for its merge.
    if (pr.mergeable_state === 'clean') return { badge: 'pass-enqueue', basis: 'PASS, mergeable, not queued yet' }
    return { badge: 'pass-merge', basis: `PASS, ${pr.mergeable_state ?? 'unknown'}` }
  }

  async function ownerOf(row, kind, comments = null) {
    const assignee = (row.assignees ?? [])[0]?.login
    if (typeof assignee === 'string' && assignee !== '') return { owner: assignee, ownerKind: 'human' }
    if (kind === 'pr') {
      const body = String(row.body ?? '')
      const who = /^\s*(?:Written-by|Owner):\s*([^\n]+)$/im.exec(body)?.[1]?.trim()
      if (who) return { owner: who, ownerKind: /bot/i.test(who) ? 'bot' : 'human' }
    }
    const list = comments ?? await commentsOf(row.number)
    for (let index = list.length - 1; index >= 0; index -= 1) {
      const claim = /^\s*Claimed by\s+([^\n]+)$/im.exec(String(list[index]?.body ?? ''))?.[1]?.trim()
      if (claim) return { owner: claim, ownerKind: /bot/i.test(claim) ? 'bot' : 'human' }
    }
    return { owner: null, ownerKind: null }
  }

  // One part of the round: a failure is noted by name and the fallback is used, except the budget,
  // which ends the whole round as a partial snapshot (#1211).
  async function part(name, work, fallback) {
    try { return await work() } catch (error) {
      if (error?.budget) throw error
      note(name, error)
      return fallback
    }
  }

  async function snapshotFromGitHub({ startedAt }) {
    const today = startOfDay(startedAt)
    const weekStart = today - 7 * DAY_MS
    let openIssues = []
    let openPulls = []
    let closedToday = []
    let mergedToday = []
    let todayMetrics = null
    let weekMetrics = null
    const columns = { raw: [], ready: [], working: [], review: [], 'done-today': [] }
    try {
      // The two open lists are the board itself: when they cannot be read there is no board to
      // show, so that failure is the round's, not a part's (#1211).
      ;[openIssues, openPulls] = await Promise.all([
        pages('/issues?state=open&sort=updated&direction=desc'),
        pages('/pulls?state=open&sort=updated&direction=desc'),
      ])
      // Two windows, settled separately: a week that cannot be read must not take today with it.
      const metricsResults = await Promise.allSettled([
        metricsFor(today),
        metricsFor(weekStart, { days: 7, ciDays: 7 }),
      ])
      const settle = (result, name) => {
        if (result.status === 'fulfilled') return result.value
        if (result.reason?.budget) throw result.reason
        note(name, result.reason)
        return null
      }
      todayMetrics = settle(metricsResults[0], 'metrics.today')
      weekMetrics = settle(metricsResults[1], 'metrics.week')
      closedToday = await part('closed-today', () => pages(`/issues?state=closed&since=${new Date(today - DAY_MS).toISOString()}`, { max: 3 }), [])
      mergedToday = await part('merged-today', () => pages('/pulls?state=closed&sort=updated&direction=desc', { max: 3, stop: row => Date.parse(row.updated_at ?? 0) < today - 2 * DAY_MS }), [])
    } catch (error) {
      // The budget is not a failure: everything read so far is assembled and the snapshot lands as
      // `partial`, so the view has something to show and the reason it is incomplete (#1211).
      if (!error?.budget) throw error
      note('budget', error)
    }
    const issues = openIssues.filter(row => !isPull(row))
    const pullRows = openPulls
    const linkedTo = new Map()
    for (const pr of pullRows) {
      for (const number of closingLinks(`${pr.title ?? ''}\n${pr.body ?? ''}`)) {
        if (!linkedTo.has(number)) linkedTo.set(number, pr.number)
      }
    }
    // A card whose owner cannot be read loses its owner, not the board (#1211).
    for (const issue of issues) {
      const column = columnOfDelivery(issue, { kind: 'issue' })
      let owner = null
      let ownerKind = null
      if (column !== 'raw') {
        try { ({ owner, ownerKind } = await ownerOf(issue, 'issue')) } catch (error) {
          if (error?.budget) { note('budget', error); break }
          note(`comments:${issue.number}`, error)
        }
      }
      columns[column].push(cardOf(issue, { kind: 'issue', linked: linkedTo.get(issue.number) ?? null, owner, ownerKind }))
    }
    for (const pr of pullRows) {
      let verdictComments = null
      try { verdictComments = await commentsOf(pr.number) } catch (error) {
        if (error?.budget) { note('budget', error); break }
        note(`comments:${pr.number}`, error)
      }
      // `null` is "could not be read"; an empty list is "none ran". The badge says which (#1211).
      let checks = null
      if (pr.head?.sha) {
        try {
          const body = await get(`${base}/commits/${pr.head.sha}/check-runs?per_page=100`)
          checks = body?.check_runs ?? []
        } catch (error) {
          if (error?.budget) { note('budget', error); break }
          note(`checks:${pr.number}`, error)
        }
      } else {
        note(`checks:${pr.number}`, failureOf('this pull request has no head sha', { kind: 'skipped', scope: 'checks', endpoint: '/commits/{sha}/check-runs', status: null }))
      }
      const verdict = verdictOf(verdictComments ?? [])
      const { badge, basis } = badgeFor(pr, verdict, checks)
      let owner = null
      let ownerKind = null
      try { ({ owner, ownerKind } = await ownerOf(pr, 'pr', verdictComments)) } catch (error) {
        if (error?.budget) { note('budget', error); break }
        note(`comments:${pr.number}`, error)
      }
      columns.review.push({ ...cardOf(pr, { kind: 'pr', owner, ownerKind, badge, sha: String(pr.head?.sha ?? '').slice(0, 7) }), badgeBasis: basis })
    }
    const closedInDay = (row) => Date.parse(row.closed_at ?? '') >= today
    const doneIssues = closedToday.filter(row => !isPull(row) && closedInDay(row))
    const donePulls = mergedToday.filter(row => Date.parse(row.merged_at ?? '') >= today)
    // A pull request closed today without a merge is finished work too, so it is done today and not
    // nowhere (#1173). The issues endpoint describes its pull requests by the `pull_request` object
    // and gives no top-level `merged_at` and no `head`: reading either would count a merged pull
    // twice and name a commit this endpoint never returns. The numbers already counted as merged
    // settle it even when that row carries no merge time.
    const mergedNumbers = new Set(donePulls.map(row => row.number))
    const abandonedPulls = closedToday.filter(row => isPull(row) && !row.pull_request?.merged_at && !mergedNumbers.has(row.number) && closedInDay(row))
    for (const row of donePulls) columns['done-today'].push(cardOf(row, { kind: 'pr', sha: String(row.merge_commit_sha ?? '').slice(0, 7) || null }))
    for (const row of abandonedPulls) columns['done-today'].push(cardOf(row, { kind: 'pr' }))
    for (const row of doneIssues) columns['done-today'].push(cardOf(row, { kind: 'issue' }))
    columns['done-today'] = columns['done-today'].slice(0, MAX_DONE)
    const needsHuman = issues.filter(row => labelNames(row).includes('needs-human') || labelNames(row).includes('needs-info')).length
    const openPrs = pullRows.length
    return {
      ok: true,
      repo,
      asOf: new Date(startedAt).toISOString(),
      computedMs: now() - startedAt,
      columns,
      counts: Object.fromEntries(DELIVERY_COLUMNS.map(column => [column, columns[column].length])),
      metrics: {
        dayStart: new Date(today).toISOString(),
        timeZone: 'Asia/Shanghai',
        today: todayMetrics,
        week: weekMetrics,
        open: {
          issues: issues.length,
          pullRequests: openPrs,
          needsHuman,
          medianIssueAgeMs: median(issues.map(row => startedAt - Date.parse(row.created_at))),
        },
      },
    }
  }

  function view(extra = {}) {
    const elapsedMs = since === null ? 0 : Math.max(0, now() - Date.parse(since))
    if (snapshot === null) {
      if (inflight !== null) return { ok: true, state: 'loading', repo, since, attempt, elapsedMs, error: lastError, retryAt: null, ...extra }
      if (lastError !== null) return { ok: true, state: 'failed', repo, since, attempt, elapsedMs, error: lastError, retryAt: nextAttemptAt || null, ...extra }
      // Never tried: the one case where the view may say there is no snapshot yet (#1211).
      return { ok: false, state: 'idle', repo, since: null, attempt: 0, elapsedMs: 0, error: null, retryAt: null, ...extra }
    }
    const state = lastError !== null || inflight !== null ? 'stale' : (snapshot.missing?.length ? 'partial' : 'fresh')
    return {
      ok: true,
      ...snapshot,
      state,
      stale: lastError !== null || inflight !== null,
      refreshing: inflight !== null,
      error: lastError,
      since,
      attempt,
      elapsedMs,
      retryAt: lastError !== null ? nextAttemptAt || null : null,
      ...extra,
    }
  }

  // The round runs behind `inflight`; nobody awaits it. The first read starts it and answers
  // `loading` at once, so the browser is never parked on a whole round (#1211).
  function start() {
    if (inflight !== null) return
    const startedAt = now()
    since = new Date(startedAt).toISOString()
    attempt += 1
    const current = { deadline: startedAt + budgetMs, missing: [] }
    round = current
    inflight = (async () => {
      try {
        const built = await snapshotFromGitHub({ startedAt })
        const missing = []
        const seen = new Set()
        for (const entry of current.missing) {
          if (seen.has(entry.part)) continue
          seen.add(entry.part)
          missing.push(entry)
        }
        snapshot = { ...built, partial: missing.length > 0, missing }
        lastError = null
        nextAttemptAt = 0
        attempt = 0
      } catch (error) {
        const detail = error !== null && typeof error === 'object' ? error : {}
        const message = String(error?.message ?? error)
        warn('ds-bot: delivery board refresh failed: %s', message)
        // Kept for the next read: throwing the reason away is what made a failed instance look
        // like one that was never connected (#1211).
        lastError = {
          message,
          endpoint: detail.endpoint ?? null,
          status: detail.status ?? null,
          kind: detail.kind ?? 'unknown',
          scope: detail.scope ?? null,
          retryAfterMs: detail.retryAfterMs ?? null,
          at: new Date(now()).toISOString(),
        }
        if (snapshot !== null) snapshot = { ...snapshot, error: message }
        const delay = BACKOFF_MS[Math.min(Math.max(attempt, 1) - 1, BACKOFF_MS.length - 1)]
        nextAttemptAt = now() + delay
      } finally {
        inflight = null
        round = null
      }
    })()
  }

  return {
    columns: DELIVERY_COLUMNS,
    // `wait` awaits the round in progress and is for diagnostics and tests; the browser never
    // passes it, because parking a request on a whole round is the bug this fixed (#1211).
    async read({ force = false, wait = false } = {}) {
      if (force) nextAttemptAt = 0
      const age = snapshot === null ? Infinity : now() - Date.parse(snapshot.asOf)
      if (inflight === null && now() >= nextAttemptAt && (force || age >= ttl)) start()
      if (wait && inflight !== null) {
        await inflight.catch(() => {
          // The round stores its own failure in `error`; a read must not throw it (#1211).
        })
      }
      return view()
    },
    // Tests and the host's own diagnostics read the cache without touching GitHub.
    cached: () => snapshot,
    probe: () => probeGitHub({ repo, token: tokenNow, request, now }),
  }
}

export function install(rt) {
  const repo = (() => {
    try { return rt.repoSlug?.() ?? repoSlug() } catch { return repoSlug() }
  })()
  const tokenOf = () => {
    try { return rt.secretValue?.('GITHUB_TOKEN') } catch { return undefined }
  }
  const request = (url, init) => (rt.fetch ?? fetch)(url, init)
  const board = createDeliveryBoard({
    repo,
    token: tokenOf,
    request,
    warn: (...args) => rt.warn?.(...args),
  })
  rt.deliveryBoard = async (payload = {}) => {
    // The channel answers before a host restart would; load once so the first read is signed.
    // The answer is `loading` either way — the round runs behind `inflight` (#1211).
    await rt.loadSecrets?.().catch(error => rt.warn?.('ds-bot: delivery board: secrets did not load: %s', error?.message ?? error))
    return board.read({ force: payload?.force === true, wait: payload?.wait === true })
  }
  // The 诊断 button and `--probe` run this one function (#1211): same reads, same statuses.
  rt.deliveryProbe = async () => {
    await rt.loadSecrets?.().catch(error => rt.warn?.('ds-bot: delivery probe: secrets did not load: %s', error?.message ?? error))
    try { return await board.probe() } catch (error) {
      return { ok: false, repo, at: new Date().toISOString(), rows: [], error: String(error?.message ?? error) }
    }
  }
}
