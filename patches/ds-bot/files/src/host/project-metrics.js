// The board's numbers (#1829): seven metrics read from GitHub REST and the local task store, with a
// five-minute cache and one honest failure answer. A missing credential or an unreadable source is
// `unavailable` and every value reads `null`, never `0`: a zero claims "none today" and the board
// must not turn "cannot read" into a number. The reads are injected, so a test counts calls without
// a network, and the day boundary is the reader's own time zone, not the host's UTC clock.
export const METRICS_TTL_MS = 5 * 60 * 1000
export const METRIC_KEYS = [
  'prsOpenedToday', 'prsMergedToday', 'issuesOpenedToday', 'issuesClosedToday',
  'prMergeMedianMs', 'issueCloseMedianMs', 'taskDoneMedianMs',
]
const DAY_MS = 24 * 60 * 60 * 1000
const RECENT_MS = 7 * DAY_MS
const text = value => (typeof value === 'string' ? value.trim() : '')
const timeOf = value => {
  const ms = Date.parse(text(value))
  return Number.isFinite(ms) ? ms : null
}

// The natural day a timestamp falls in, in the caller's time zone. `en-CA` prints ISO order, which
// is what the comparison below needs; an unknown zone throws and the caller degrades.
export function dayKey(ms, timeZone = 'UTC') {
  if (!Number.isFinite(ms)) return ''
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
  return parts.format(new Date(ms))
}

// A median over the durations of records in the window: empty is `null`, which the client paints
// as `—`. Half a millisecond of rounding is not worth carrying into the view.
export function median(values) {
  const clean = values.filter(value => Number.isFinite(value)).sort((a, b) => a - b)
  if (clean.length === 0) return null
  const middle = Math.floor(clean.length / 2)
  return clean.length % 2 === 0 ? Math.round((clean[middle - 1] + clean[middle]) / 2) : clean[middle]
}

const countToday = (items, at, day) => items.reduce((count, item) => {
  const ms = timeOf(at(item))
  return ms !== null && dayKey(ms, day.timeZone) === day.key ? count + 1 : count
}, 0)

const durationInWindow = (items, from, to, now) => items.reduce((values, item) => {
  const start = timeOf(from(item))
  const end = timeOf(to(item))
  if (start === null || end === null || end < start) return values
  if (now - end > RECENT_MS) return values
  values.push(end - start)
  return values
}, [])

// The task half: a card that reached `done` inside the window. `completedAt` is the store's own
// stamp; a record written before the stamp reads `updatedAt` and is not counted as a duration the
// store never recorded.
const doneTaskDurations = (tasks, now) => Object.values(tasks ?? {}).reduce((values, task) => {
  if (task === null || typeof task !== 'object' || task.status !== 'done') return values
  const start = Number.isFinite(task.createdAt) ? task.createdAt : null
  const end = Number.isFinite(task.completedAt) ? task.completedAt : null
  if (start === null || end === null || end < start) return values
  if (now - end > RECENT_MS) return values
  values.push(end - start)
  return values
}, [])

// The running table (#1829): a claimed card is running, its age is the claim's own start, and the
// source is the board it belongs to — the same three sources the rows already carry.
export function runningOf(task, now) {
  if (task === null || typeof task !== 'object') return null
  if (task.status !== 'claimed' && task.status !== 'working') return null
  const who = text(task.claimedBy) || text(task.lease?.holder) || text(task.assignee)
  if (who === '') return null
  const since = Number.isFinite(task.claimedAt) ? task.claimedAt : (Number.isFinite(task.updatedAt) ? task.updatedAt : null)
  const last = Number.isFinite(task.updatedAt) ? task.updatedAt : (Number.isFinite(task.createdAt) ? task.createdAt : null)
  const source = task.kind === 'group' ? 'group' : text(task.ownerBotId) !== '' ? 'bot' : 'workflow'
  return {
    id: String(task.id),
    title: text(task.title),
    status: task.status,
    who,
    sinceMs: since === null ? null : Math.max(0, now - since),
    source,
    lastActivityAt: last,
  }
}

// One cache for the whole host: the key carries the time zone, because the four day counts move
// with it. A hit answers the same object and spends no source call, which is what the issue's
// "cache hit reads the source once" case is about.
const cache = new Map()

const emptyMetrics = () => Object.fromEntries(METRIC_KEYS.map(key => [key, null]))

// `source` is `{ ok, pullRequests, issues, reason }`; a failed half is answered as unavailable for
// the metrics it feeds and never as zero.
export function summarizeMetrics({ now = Date.now(), timeZone = 'UTC', source, tasks } = {}) {
  const unavailable = (reason) => ({ ok: false, reason, timeZone, generatedAt: now, metrics: emptyMetrics(), running: [] })
  if (source === undefined || source === null) return unavailable('no-source')
  if (source.ok !== true) return unavailable(text(source.reason) || 'source-unavailable')
  const pullRequests = Array.isArray(source.pullRequests) ? source.pullRequests : []
  const issues = Array.isArray(source.issues) ? source.issues : []
  const key = dayKey(now, timeZone)
  const day = { key, timeZone }
  return {
    ok: true,
    timeZone,
    generatedAt: now,
    metrics: {
      prsOpenedToday: countToday(pullRequests, item => item.created_at, day),
      prsMergedToday: countToday(pullRequests, item => item.merged_at, day),
      issuesOpenedToday: countToday(issues, item => item.created_at, day),
      issuesClosedToday: countToday(issues, item => item.closed_at, day),
      prMergeMedianMs: median(durationInWindow(pullRequests, item => item.created_at, item => item.merged_at, now)),
      issueCloseMedianMs: median(durationInWindow(issues, item => item.created_at, item => item.closed_at, now)),
      taskDoneMedianMs: median(doneTaskDurations(tasks, now)),
    },
    running: Object.values(tasks ?? {}).map(task => runningOf(task, now)).filter(row => row !== null),
  }
}

// The read the endpoint calls. `fetchImpl` and `token` are seams: no token answers unavailable
// without a request, and one failed request answers unavailable for this tick rather than a cache
// entry that would keep the failure for five minutes.
export async function readMetrics({ repo, token, fetchImpl, timeZone = 'UTC', now = Date.now(), tasks, ttlMs = METRICS_TTL_MS, cacheStore = cache } = {}) {
  const bearer = text(token)
  if (bearer === '') return { ...summarizeMetrics({ now, timeZone, source: { ok: false, reason: 'no-credentials' } }), cache: 'miss' }
  if (typeof fetchImpl !== 'function') return { ...summarizeMetrics({ now, timeZone, source: { ok: false, reason: 'no-fetch' } }), cache: 'miss' }
  const key = `${repo}|${timeZone}|${Math.floor(now / ttlMs)}`
  const hit = cacheStore.get(key)
  if (hit !== undefined && hit.expiresAt > now) return { ...hit.value, cache: 'hit' }
  const since = new Date(now - RECENT_MS).toISOString()
  const headers = { Authorization: `Bearer ${bearer}`, Accept: 'application/vnd.github+json', 'User-Agent': 'flybot-project-metrics' }
  const get = async (path) => {
    const response = await fetchImpl(`https://api.github.com${path}`, { headers })
    if (!response.ok) throw new Error(`${path} answered ${response.status}`)
    return response.json()
  }
  let source
  try {
    const [pullRequests, issues] = await Promise.all([
      get(`/repos/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=100&since=${since}`),
      get(`/repos/${repo}/issues?state=all&sort=updated&direction=desc&per_page=100&since=${since}`),
    ])
    source = { ok: true, pullRequests, issues: issues.filter(item => item.pull_request === undefined) }
  } catch (error) {
    return { ...summarizeMetrics({ now, timeZone, source: { ok: false, reason: `read-failed: ${error.message}` } }), cache: 'miss' }
  }
  const value = summarizeMetrics({ now, timeZone, source, tasks })
  cacheStore.set(key, { expiresAt: now + ttlMs, value })
  return { ...value, cache: 'miss' }
}
