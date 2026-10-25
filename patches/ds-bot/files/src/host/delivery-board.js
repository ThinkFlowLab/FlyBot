// Delivery board (#1173): one read-only snapshot of the repository's GitHub issues, pull
// requests and CI runs, laid out by delivery stage. This module is a view over GitHub, not a
// writer: every request it makes is a GET, the token stays in this process, and the payload the
// client receives carries no credential. The snapshot is cached; a stale cache is still served
// while a refresh runs, and the payload says when it was taken.
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

async function readJson(response) {
  if (!response.ok) throw new Error(`GitHub answered ${response.status}`)
  return response.json()
}

export function createDeliveryBoard({ repo, token, request = fetch, now = Date.now, ttl = CACHE_TTL_MS, warn = () => {} } = {}) {
  // Secrets are read asynchronously after install, so the token is resolved per request: a value
  // captured at install time is empty until the next restart (#1173).
  const tokenNow = () => (typeof token === 'function' ? token() : token)
  const base = `https://api.github.com/repos/${repo}`
  const cache = new Map()
  let snapshot = null
  let inflight = null

  // Every URL this board asks for is a read. A write would be a bug, so the shape is refused
  // here rather than trusted from the call sites (#1173 read-only invariant).
  async function get(url) {
    const cached = cache.get(url)
    const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'flybot-delivery-board' }
    const bearer = tokenNow()
    if (bearer) headers.Authorization = `Bearer ${bearer}`
    if (cached?.etag) headers['If-None-Match'] = cached.etag
    const response = await request(url, { method: 'GET', headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    if (response.status === 304 && cached !== undefined) {
      cache.set(url, { ...cached, at: now() })
      return cached.body
    }
    if (!response.ok) throw new Error(`GitHub answered ${response.status} for ${new URL(url).pathname}`)
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

  async function commentsOf(number) {
    return get(`${base}/issues/${number}/comments?per_page=100&page=1`)
  }

  async function runsOfDay(from, to) {
    // GitHub reads `created` as a date-time range in ISO 8601; epoch milliseconds are accepted
    // silently and match nothing, which reads as "no CI today" rather than an error (#1173).
    const created = `${new Date(from).toISOString()}..${new Date(to).toISOString()}`
    let total = null
    let counted = 0
    let failed = 0
    let superseded = 0
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
    }
    return { failed, superseded, counted, total: total ?? counted }
  }

  const windowOf = (from) => ({ from, to: from + DAY_MS })

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
    const ci = { failed: 0, superseded: 0, counted: 0, total: 0 }
    for (let day = 0; day < ciDays; day += 1) {
      const window = windowOf(from - day * DAY_MS)
      const runs = await runsOfDay(window.from, window.to)
      ci.failed += runs.failed
      ci.superseded += runs.superseded
      ci.counted += runs.counted
      ci.total += runs.total
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

  async function ownerOf(row, kind) {
    const assignee = (row.assignees ?? [])[0]?.login
    if (typeof assignee === 'string' && assignee !== '') return { owner: assignee, ownerKind: 'human' }
    if (kind === 'pr') {
      const body = String(row.body ?? '')
      const who = /^\s*(?:Written-by|Owner):\s*([^\n]+)$/im.exec(body)?.[1]?.trim()
      if (who) return { owner: who, ownerKind: /bot/i.test(who) ? 'bot' : 'human' }
    }
    const comments = await commentsOf(row.number).catch(() => [])
    for (let index = comments.length - 1; index >= 0; index -= 1) {
      const claim = /^\s*Claimed by\s+([^\n]+)$/im.exec(String(comments[index]?.body ?? ''))?.[1]?.trim()
      if (claim) return { owner: claim, ownerKind: /bot/i.test(claim) ? 'bot' : 'human' }
    }
    return { owner: null, ownerKind: null }
  }

  async function snapshotFromGitHub() {
    const at = now()
    const today = startOfDay(at)
    const weekStart = today - 7 * DAY_MS
    const [openIssues, openPulls] = await Promise.all([
      pages('/issues?state=open&sort=updated&direction=desc'),
      pages('/pulls?state=open&sort=updated&direction=desc'),
    ])
    const issues = openIssues.filter(row => !isPull(row))
    const pullRows = openPulls
    const linkedTo = new Map()
    for (const pr of pullRows) {
      const text = `${pr.title ?? ''}\n${pr.body ?? ''}`
      for (const match of text.matchAll(/#(\d+)/g)) {
        const number = Number(match[1])
        if (!linkedTo.has(number)) linkedTo.set(number, pr.number)
      }
    }
    const [todayMetrics, weekMetrics] = await Promise.all([
      metricsFor(today),
      metricsFor(weekStart, { days: 7, ciDays: 7 }),
    ])
    const closedToday = await pages(`/issues?state=closed&since=${new Date(today - DAY_MS).toISOString()}`, { max: 3 })
    const mergedToday = await pages('/pulls?state=closed&sort=updated&direction=desc', { max: 3, stop: row => Date.parse(row.updated_at ?? 0) < today - 2 * DAY_MS })
    const columns = { raw: [], ready: [], working: [], review: [], 'done-today': [] }
    for (const issue of issues) {
      const column = columnOfDelivery(issue, { kind: 'issue' })
      const { owner, ownerKind } = column === 'raw' ? { owner: null, ownerKind: null } : await ownerOf(issue, 'issue')
      columns[column].push(cardOf(issue, { kind: 'issue', linked: linkedTo.get(issue.number) ?? null, owner, ownerKind }))
    }
    for (const pr of pullRows) {
      const [verdictComments, checks] = await Promise.all([
        commentsOf(pr.number).catch(() => []),
        get(`${base}/commits/${pr.head?.sha}/check-runs?per_page=100`).then(body => body?.check_runs ?? []).catch(() => []),
      ])
      const verdict = verdictOf(verdictComments)
      const { badge, basis } = badgeFor(pr, verdict, checks)
      const { owner, ownerKind } = await ownerOf(pr, 'pr')
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
      asOf: new Date(at).toISOString(),
      computedMs: Date.now() - at,
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
          medianIssueAgeMs: median(issues.map(row => at - Date.parse(row.created_at))),
        },
      },
    }
  }

  function view(extra = {}) {
    if (snapshot === null) return { ok: false, reason: 'no-github', asOf: null, columns: {}, metrics: null, ...extra }
    return { ...snapshot, ...extra }
  }

  async function refresh() {
    if (inflight !== null) return inflight
    inflight = (async () => {
      try {
        snapshot = await snapshotFromGitHub()
        return snapshot
      } catch (error) {
        const message = String(error?.message ?? error)
        warn('ds-bot: delivery board refresh failed: %s', message)
        if (snapshot !== null) snapshot = { ...snapshot, error: message }
        else snapshot = null
        return snapshot
      } finally {
        inflight = null
      }
    })()
    return inflight
  }

  return {
    columns: DELIVERY_COLUMNS,
    async read({ force = false } = {}) {
      if (snapshot === null) return view(await refresh() ? {} : {})
      const age = now() - Date.parse(snapshot.asOf)
      if (force || age >= ttl) {
        void refresh()
        return view({ refreshing: true, stale: true })
      }
      return view()
    },
    // Tests and the host's own diagnostics read the cache without touching GitHub.
    cached: () => snapshot,
  }
}

export function install(rt) {
  const repo = (() => {
    try { return rt.repoSlug?.() ?? repoSlug() } catch { return repoSlug() }
  })()
  const tokenOf = () => {
    try { return rt.secretValue?.('GITHUB_TOKEN') } catch { return undefined }
  }
  const board = createDeliveryBoard({
    repo,
    token: tokenOf,
    request: (url, init) => (rt.fetch ?? fetch)(url, init),
    warn: (...args) => rt.warn?.(...args),
  })
  rt.deliveryBoard = async (payload = {}) => {
    // The channel answers before a host restart would; load once so the first read is signed.
    await rt.loadSecrets?.().catch(error => rt.warn?.('ds-bot: delivery board: secrets did not load: %s', error?.message ?? error))
    return board.read({ force: payload?.force === true })
  }
}
