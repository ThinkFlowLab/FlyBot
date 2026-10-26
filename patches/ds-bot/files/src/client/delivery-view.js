// Delivery board (#1173): the repository's GitHub issues and pull requests by delivery stage,
// in the same dialog as the per-Bot Tasks board. This is a view only — nothing here writes to
// GitHub, and the snapshot it renders is built host-side (src/host/delivery-board.js).
//
// #1211 makes the failure visible: four states instead of "no snapshot" for everything —
// `loading` counts the seconds, `failed` names the endpoint, the status and what to do about it,
// `stale` keeps the old board and hangs the reason beside it, `partial` says which part was not
// read. The poll is fast while a round is running (2 s) and slow once there is something to read.
import { createElement as h, useEffect, useState } from 'react'
import { t } from './i18n.js'
import { DeliveryMetrics, DELIVERY_CHART_CSS, todayPartial } from './delivery-chart.js'
import { githubCard } from '../shared/board-card.js'
import { BoardCard, DELIVERY_SKIN } from './board-card.js'

const POLL_MS = 60_000
// While the host is still building there is nothing to see, so ask often; once the board is up,
// asking often only burns GitHub reads (#1211).
const LOADING_POLL_MS = 2_000

// A failed or stale read carries the host's `retryAt` (#1211): the next read is scheduled for it
// instead of a fixed minute, so the host's 10 s → 30 s → 2 min backoff actually happens. The floor
// keeps a clock skew from spinning, and the ceiling keeps `setTimeout`'s 32-bit limit from turning a
// long wait into an immediate 0 ms re-fire.
const RETRY_FLOOR_MS = 1_000
const TIMER_MAX_MS = 2 ** 31 - 1
export function pollDelay(state, payload = null, now = Date.now()) {
  if (state === 'loading' || state === 'idle') return LOADING_POLL_MS
  const at = Number(payload?.retryAt)
  if ((state === 'failed' || state === 'stale') && Number.isFinite(at) && at > 0) {
    return Math.min(Math.max(at - now, RETRY_FLOOR_MS), TIMER_MAX_MS)
  }
  return POLL_MS
}

export const DELIVERY_COLUMNS = [
  { id: 'raw', label: 'Original issue' },
  { id: 'ready', label: 'Ready to start' },
  { id: 'working', label: 'In progress' },
  { id: 'review', label: 'In review' },
  { id: 'done-today', label: 'Done today' },
]

// The columns to draw for one payload, in one place (#1265 step 4). The snapshot names which
// columns exist (its own `columns` map) and DELIVERY_COLUMNS gives their order and labels; an id
// this build does not label still renders, under its own id. When a workflow definition becomes the
// source (#1272) it replaces this function's data, not the renderer.
export function stagesOf(view) {
  const columns = view?.columns
  if (columns === null || typeof columns !== 'object') return DELIVERY_COLUMNS
  const present = Object.keys(columns)
  if (present.length === 0) return DELIVERY_COLUMNS
  const known = DELIVERY_COLUMNS.filter(column => present.includes(column.id))
  const unlabelled = present.filter(id => !DELIVERY_COLUMNS.some(column => column.id === id)).map(id => ({ id, label: id }))
  return [...known, ...unlabelled]
}

const BADGES = {
  inc: 'INC · rework',
  'pass-enqueue': 'PASS · waiting for enqueue',
  'pass-merge': 'PASS · waiting for merge',
  'ci-red': 'CI red',
  'ci-running': 'CI running',
  'no-verdict': 'No verdict',
  // The checks could not be read: that is not "no verdict", and saying so blamed the pull request
  // for a permission the instance is missing (#1211).
  'checks-unknown': 'Checks unknown',
}

export const badgeLabel = (badge) => (badge ? t(BADGES[badge] ?? badge) : '')

export function duration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const hours = ms / 3_600_000
  if (hours < 1) return `${Math.max(1, Math.round(ms / 60_000))}m`
  if (hours < 48) return `${Math.round(hours)}h`
  return `${Math.round(hours / 24)}d`
}

const secondsOf = (ms) => String(Math.max(0, Math.round((Number(ms) || 0) / 1000)))

// The three states have three sentences, and none of them is "no snapshot yet" (#1211).
// Seconds until the host retries on its own (#1211). The number is the host's `retryAt`, so the line
// states a fact instead of promising a cadence the page would not keep.
export function retryCountdown(retryAt, now = Date.now()) {
  const at = Number(retryAt)
  if (!Number.isFinite(at) || at <= 0) return null
  return Math.max(0, Math.round((at - now) / 1000))
}

export const loadingText = (elapsedMs) => t('First load in progress, {seconds} s elapsed', { seconds: secondsOf(elapsedMs) })

export const staleText = (asOf, error) => t('Showing the snapshot from {time} · refresh failed: {message}', {
  time: clockOf(asOf), message: String(error?.message ?? error ?? ''),
})

// What a person can do about the failure, by kind and by the part of GitHub that refused (#1211).
// A wait is printed only when GitHub itself gave one.
export function hintFor(error, { repo = null } = {}) {
  if (!error) return ''
  const scope = error.scope ?? null
  const kind = error.kind ?? null
  const target = repo ?? t('this repository')
  if (kind === 'no-repo') return t('Set delivery.repo in this instance\'s settings to the repository this instance works in.')
  if (kind === 'no-token') return t('Add a GITHUB_TOKEN in this instance\'s settings — one that can read {repo}.', { repo: target })
  if (kind === 'rate-limit') {
    return error.retryAfterMs === null || error.retryAfterMs === undefined
      // No number from GitHub means no number here: the backoff is a rule, not a measurement. The
      // retrying is the open page's job — the host installs no timer (#1173) (#1227).
      ? t('GitHub is rate-limiting this instance; while this page is open it retries on its own (10 s → 30 s → 2 min).')
      : t('GitHub is rate-limiting this instance; while this page is open it retries on its own in {seconds} s.', { seconds: secondsOf(error.retryAfterMs) })
  }
  if (kind === 'timeout') return t('GitHub did not answer in time; the next attempt happens while this page is open.')
  if (scope === 'actions' && (kind === 'not-found' || kind === 'forbidden')) return t('Give the token Actions: Read.')
  if (scope === 'checks' && (kind === 'not-found' || kind === 'forbidden')) return t('Give the token Checks: Read.')
  if ((scope === 'comments' || scope === 'issues') && (kind === 'not-found' || kind === 'forbidden')) return t('Give the token Issues: Read.')
  if (scope === 'pulls' && (kind === 'not-found' || kind === 'forbidden')) return t('Give the token Pull requests: Read.')
  if (scope === 'repo' || kind === 'not-found' || kind === 'forbidden' || kind === 'auth') {
    return t('Check the repository name, and that the token can see {repo}.', { repo: target })
  }
  if (kind === 'server' || kind === 'network') return t('GitHub is not answering this instance right now; retry in a moment.')
  return t('The next attempt happens while this page is open; the reason above names what failed.')
}

// A part that could not be read is named where it is missing, not hidden (#1211). With more than
// one repository the failing read is one repository's, so the line says which (#1265).
export function missingText(entry) {
  const status = entry?.status === null || entry?.status === undefined ? '' : ` · ${entry.status}`
  const part = entry?.part === 'ci' ? t('CI data')
    : entry?.part === 'budget' ? t('The rest of the board')
      : entry?.part ?? t('Part of the board')
  const where = entry?.repo ? `${entry.repo} · ` : ''
  return t('{part} was not fetched this time: {message}', { part: `${where}${part}`, message: `${String(entry?.message ?? '')}${status}` })
}

const clockOf = (iso) => {
  const at = Date.parse(iso ?? '')
  if (!Number.isFinite(at)) return '—'
  return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

const timeOf = (iso) => {
  const at = Date.parse(iso ?? '')
  if (!Number.isFinite(at)) return '—'
  return new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

// The header rows the dialog renders; kept pure so the numbers can be checked without React.
export function metricRows(snapshot) {
  const today = snapshot?.today ?? {}
  const week = snapshot?.week ?? {}
  const ci = today.ci ?? null
  // The CI share is a ratio of the runs that counted, so it is written as a percentage and is
  // never summed. A day the host could only count by `total` still has a denominator — the one the
  // 7-day line beside this row draws — so the two halves read the same day the same way (#1244);
  // only a window with no runs at all reads '—', never 0%.
  const share = (entry) => {
    if (!entry || !Number.isFinite(entry.failed)) return '—'
    const denominator = Number.isFinite(entry.counted) && entry.counted > 0
      ? entry.counted
      : (Number.isFinite(entry.total) && entry.total > 0 ? entry.total : null)
    return denominator === null ? '—' : `${Math.round((entry.failed / denominator) * 100)}%`
  }
  const count = (value) => (value === null || value === undefined ? '—' : String(value))
  const rows = [
    { label: t('New issues'), key: 'newIssues' },
    { label: t('Closed issues'), key: 'closedIssues' },
    { label: t('New pull requests'), key: 'newPullRequests' },
    { label: t('Merged pull requests'), key: 'mergedPullRequests' },
    { key: 'ci', label: t('CI red share'), today: share(today.ci), week: share(week.ci) },
    { label: t('Median issue close'), key: 'medianIssueCloseMs', format: duration },
    { label: t('Median PR merge'), key: 'medianPullMergeMs', format: duration },
  ].map(row => {
    // The CI row already carries its own formatted share; every other row reads its number from
    // today/week by key.
    if (row.today !== undefined) return { key: row.key, label: row.label, today: row.today, week: row.week }
    const format = row.format ?? count
    // `key` travels with the row so the chart finds its own series by name, not by position.
    return { key: row.key, label: row.label, today: format(today[row.key]), week: format(week[row.key]) }
  })
  return {
    dayStart: snapshot?.dayStart ?? null,
    rows,
    // `null` is "not read this time", which the header prints as unknown; a real 0 stays a 0.
    ci: ci === null ? null : {
      failed: ci.failed ?? 0,
      total: ci.total ?? 0,
      counted: ci.counted ?? 0,
      caveat: Number.isFinite(ci.total) && Number.isFinite(ci.counted) && ci.counted < ci.total,
      superseded: ci.superseded ?? 0,
      unknownDays: ci.unknownDays ?? [],
    },
    open: snapshot?.open ?? {},
  }
}

// The poll loop, kept out of React so a fake clock can prove the cadence (#1211). A retry paints
// `loading` before the request leaves, so the button is not silent, and the schedule after a failure
// is the host's own `retryAt` rather than a minute of nothing.
export function createPoller({ load, onView, now = () => Date.now(), setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = id => clearTimeout(id) }) {
  let stopped = false
  let timer = null
  let state = 'idle'
  let last = null
  const schedule = () => {
    if (stopped) return
    if (timer !== null) clearTimer(timer)
    timer = setTimer(() => { timer = null; void run() }, pollDelay(state, last, now()))
  }
  const run = async (force = false) => {
    try {
      const next = await load(force)
      if (stopped) return
      if (next && typeof next === 'object') {
        last = next
        state = typeof next.state === 'string' ? next.state : 'fresh'
        onView(next)
      } else {
        state = 'failed'
        last = null
        onView({ state: 'failed', error: { message: 'The host did not answer', kind: 'network', endpoint: null, status: null, at: null } })
      }
      schedule()
    } catch (error) {
      if (stopped) return
      state = 'failed'
      last = null
      onView({ state: 'failed', error: { message: String(error?.message ?? error), kind: 'network', endpoint: null, status: null, at: null } })
      schedule()
    }
  }
  return {
    start: () => { void run() },
    // Retry: the screen changes now, then the force read runs; the old view is kept so its columns
    // do not flash away while the round starts.
    retry: (from = null) => {
      if (stopped) return
      state = 'loading'
      last = null
      onView({ ...(from && typeof from === 'object' ? from : {}), state: 'loading', since: new Date(now()).toISOString(), elapsedMs: 0, refreshing: false })
      if (timer !== null) { clearTimer(timer); timer = null }
      void run(true)
    },
    stop: () => { stopped = true; if (timer !== null) clearTimer(timer); timer = null },
  }
}

// Where the repository name came from (#1250). A bare source word is deliberate: the page says what
// the host read, not a sentence that hides the difference between a setting and a default.
export function repoSourceText(source) {
  if (source === 'config') return t('from config')
  if (source === 'remote') return t('from remote')
  if (source === 'package') return t('from the package (default)')
  return null
}

export function useDeliveryBoard(actions) {
  const [view, setView] = useState({ state: 'idle' })
  const [retry, setRetry] = useState(() => () => {})
  useEffect(() => {
    let current = { state: 'idle' }
    const poller = createPoller({
      load: force => (typeof actions?.deliveryBoard === 'function'
        ? actions.deliveryBoard(force ? { force: true } : {})
        : Promise.resolve(null)),
      onView: next => { current = next; setView(next) },
    })
    setRetry(() => () => poller.retry(current))
    poller.start()
    return () => poller.stop()
  }, [actions])
  return [view, retry]
}

// The diagnostic report as text, so the 诊断 button can show and copy the same five lines the
// `--probe` CLI prints (#1211).
export function probeText(report) {
  if (!report) return ''
  const repos = Array.isArray(report.repos) ? report.repos : []
  const head = report.repo ?? `${repos.length} repositories`
  const lines = [`${head}${report.repoSource ? ` · ${report.repoSource}` : ''} · ${timeOf(report.at)}`]
  for (const row of report.rows ?? []) {
    const status = row.status === null || row.status === undefined ? '—' : String(row.status)
    const where = report.repo === null && row.repo ? `${row.repo} ` : ''
    lines.push(`${where}${row.ok ? 'ok' : 'FAIL'} ${status.padEnd(4)} ${row.endpoint}${row.ok ? '' : `  ${row.kind ?? ''}`}`)
  }
  if (report.error) lines.push(String(report.error))
  return lines.join('\n')
}

function Diagnose({ onProbe }) {
  const [report, setReport] = useState(null)
  const [busy, setBusy] = useState(false)
  const run = () => {
    if (busy) return
    setBusy(true)
    Promise.resolve(onProbe?.())
      .then(next => { setReport(next ?? { rows: [], error: 'no answer' }) })
      .catch(error => setReport({ rows: [], error: String(error?.message ?? error) }))
      .finally(() => setBusy(false))
  }
  return h('span', { className: 'bt-del-diag' },
    h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: run, 'aria-label': t('Diagnose') }, busy ? t('Checking…') : t('Diagnose')),
    report
      ? h('div', { className: 'bt-del-diag-box' },
        h('pre', { className: 'bt-del-diag-text', 'data-probe': 'report' }, probeText(report)),
        h('button', {
          type: 'button', className: 'bt-soft bt-soft-sm',
          onClick: () => { try { globalThis.navigator?.clipboard?.writeText?.(probeText(report)) } catch { /* copy is a convenience */ } },
        }, t('Copy')),
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => setReport(null) }, t('Close')))
      : null)
}

export function DeliveryHeader({ view, snapshot, repo = null, onRetry = null, onProbe = null }) {
  const payload = view ?? snapshot
  if (!payload) return null
  const metricsPayload = payload.metrics ?? payload
  const { rows, ci, open } = metricRows(metricsPayload)
  const error = payload.error ?? null
  const state = payload.state ?? 'fresh'
  const repoName = payload.repo ?? repo ?? null
  const repoSource = payload.repoSource ?? null
  const sourceText = repoSourceText(repoSource)
  // More than one repository has no single name to print, so the line carries the count instead
  // (#1265 step 4); each repository block names itself below.
  const repoCount = Array.isArray(payload.repos) ? payload.repos.length : 0
  const shared = repoCount > 1
  const openCount = value => (value === null || value === undefined ? '—' : String(value))
  // One time, one source (#1244): while today is still running the hint follows the time, so the
  // paragraph prints the zone-clocked time once instead of repeating a local-clock rendering of the
  // same instant — the two can disagree, not merely repeat.
  const partial = state !== 'loading' && todayPartial(metricsPayload.daily)
  return h('header', { className: 'bt-del-head' },
    // Whose numbers these are, and where the name came from (#1250): a package default that looks
    // like a fact is what showed one instance another repository's board.
    h('p', { className: 'bt-del-repo', 'data-repo': shared ? undefined : repoName ?? undefined, 'data-repo-source': shared ? undefined : repoSource ?? undefined, 'data-repos': shared ? String(repoCount) : undefined },
      shared ? t('{count} repositories', { count: repoCount }) : repoName === null ? t('no repository — set delivery.repo') : repoName,
      shared || sourceText === null ? '' : ` · ${sourceText}`),
    h('div', { className: 'bt-del-metrics' },
      h(DeliveryMetrics, { rows, daily: metricsPayload.daily }),
      // An unreadable CI number is "unknown", never "0 of 0" (#1211).
      h('p', { className: 'bt-del-ci', 'data-ci': ci === null ? 'unknown' : 'read' },
        ci === null ? t('CI not available this time') : t('CI failed {failed} of {total}', { failed: ci.failed, total: ci.total }),
        ci !== null && ci.caveat ? ` · ${t('counted {counted} of {total}', { counted: ci.counted, total: ci.total })}` : '',
        ci !== null && ci.superseded ? ` · ${t('{count} superseded', { count: ci.superseded })}` : '',
        ci !== null && ci.unknownDays?.length ? ` · ${t('{count} day(s) not read', { count: ci.unknownDays.length })}` : ''),
      h('p', { className: 'bt-del-open' }, t('Open: {issues} issues ({needs} need a human), {prs} pull requests', {
        issues: openCount(open.issues), needs: openCount(open.needsHuman), prs: openCount(open.pullRequests),
      }), open.medianIssueAgeMs !== null && open.medianIssueAgeMs !== undefined
        ? ` · ${t('median open age {age}', { age: duration(open.medianIssueAgeMs) })}` : '')),
    h('p', { className: 'bt-del-asof' },
      state === 'loading' ? loadingText(payload.elapsedMs) : t('as of {time}', { time: partial ? clockOf(payload.asOf) : timeOf(payload.asOf) }),
      partial ? ` · ${t('today is partial')}` : '',
      payload.refreshing ? ` · ${t('refreshing…')}` : '',
      error ? ` · ${hintFor(error, { repo })}` : '',
      onRetry ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm bt-del-retry', onClick: onRetry }, t('Retry')) : null,
      onProbe ? h(Diagnose, { onProbe }) : null))
}

// One repository's columns (#1265 step 4). The card key carries the repository, so the same issue
// number in two repositories is two cards and neither is mistaken for the other.
function DeliveryColumns({ view, repo = null }) {
  const columns = view?.columns ?? {}
  return h('div', { className: 'bt-del-columns' },
    stagesOf(view).map(column => h('section', { key: column.id, className: 'bt-del-column', 'data-column': column.id },
      h('h3', { className: 'bt-board-column-head' },
        h('span', null, t(column.label)),
        h('span', { className: 'bt-board-count' }, String((columns[column.id] ?? []).length))),
      (columns[column.id] ?? []).length === 0
        ? h('p', { className: 'bt-board-empty' }, t('Nothing here.'))
        : (columns[column.id] ?? []).map(card => h(DeliveryCard, { key: `${repo ?? ''}-${card.kind}-${card.number}`, card, repo })))))
}

// A repository that cannot be read keeps its block and says so; the readable ones are drawn beside
// it, which is why one failure no longer empties the board (#1265, #1211).
function DeliveryRepoBlock({ entry }) {
  const state = entry?.state ?? 'fresh'
  const source = repoSourceText(entry?.repoSource)
  return h('section', { className: 'bt-del-repo-block', 'data-repo': entry?.repo ?? undefined, 'data-state': state },
    h('h3', { className: 'bt-del-repo-head' }, entry?.repo ?? t('no repository — set delivery.repo'),
      source === null ? '' : ` · ${source}`),
    entry?.columns === undefined
      ? h('p', { className: 'bt-del-block-state', role: 'status' },
        state === 'loading' ? loadingText(entry?.elapsedMs) : String(entry?.error?.message ?? t('The delivery board is not ready yet.')),
        entry?.error ? ` · ${hintFor(entry.error, { repo: entry.repo })}` : '')
      : h(DeliveryColumns, { view: entry, repo: entry.repo }))
}

export function DeliveryBoard({ view, snapshot, message = '', repo = null, onRetry = null, onProbe = null }) {
  const payload = view ?? (snapshot ? { ...snapshot, state: 'fresh' } : { state: 'idle' })
  const state = payload.state ?? 'fresh'
  // The countdown promises a number that moves, so the screen redraws once a second while a retry
  // is actually scheduled — and only then: a fresh or loading board must not tick (#1227). The
  // timer lives in the browser, not in the host, which installs none (#1173).
  const retryAt = Number(payload.retryAt)
  const ticking = (state === 'failed' || state === 'stale') && Number.isFinite(retryAt) && retryAt > 0
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!ticking) return undefined
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [ticking, retryAt])
  const countdown = retryCountdown(payload.retryAt, now)
  // More than one repository is one block per repository; exactly one is today's single board.
  const entries = Array.isArray(payload.repos) && payload.repos.length > 1 ? payload.repos : null
  // "No snapshot yet." belongs to a host that has never tried; every attempt has a better word.
  if (state === 'idle') {
    return h('div', { className: 'bt-del-body', 'data-view': 'delivery', 'data-state': state },
      message
        ? h('p', { className: 'bt-board-error', role: 'alert' }, message)
        : h('p', { className: 'bt-board-empty' }, t('No snapshot yet.')))
  }
  if (state === 'loading') {
    return h('div', { className: 'bt-del-body', 'data-view': 'delivery', 'data-state': state },
      h('p', { className: 'bt-del-loading', role: 'status' }, loadingText(payload.elapsedMs)),
      h('p', { className: 'bt-del-hint' }, t('The first round reads the repository once; the columns appear as soon as it lands.')))
  }
  // A board exists when the payload carries its columns, or when at least one repository does; with
  // several repositories one failure is `partial`, not an empty page (#1265).
  const hasBoard = Boolean(payload.columns) || (entries !== null && entries.some(entry => entry.columns !== undefined))
  if (state === 'failed' || !hasBoard) {
    const error = payload.error ?? null
    return h('div', { className: 'bt-del-body', 'data-view': 'delivery', 'data-state': state },
      h('div', { className: 'bt-board-error', role: 'alert' },
        h('p', null, String(error?.message ?? message ?? t('The delivery board is not ready yet.'))),
        error ? h('p', { className: 'bt-del-hint' }, hintFor(error, { repo })) : null,
        h('p', { className: 'bt-del-hint', 'data-retry-at': payload.retryAt ?? undefined },
          countdown === null
            ? t('While this page is open it retries on its own; press Retry to try again now.')
            : t('Retrying in {seconds} s · press Retry to try again now', { seconds: countdown })),
        onRetry ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm bt-del-retry', onClick: onRetry }, t('Retry')) : null))
  }
  const missing = payload.missing ?? []
  return h('div', { className: 'bt-del-body', 'data-view': 'delivery', 'data-state': state },
    message ? h('p', { className: 'bt-board-error', role: 'alert' }, message) : null,
    state === 'stale' && payload.error
      ? h('p', { className: 'bt-del-stale', role: 'status' }, staleText(payload.asOf, payload.error),
        ` · ${hintFor(payload.error, { repo })}`,
        countdown === null ? '' : ` · ${t('Retrying in {seconds} s · press Retry to try again now', { seconds: countdown })}`)
      : null,
    state !== 'stale' && missing.length > 0
      ? h('p', { className: 'bt-del-partial', role: 'status' }, missing.map(entry => missingText(entry)).join(' · '))
      : null,
    h(DeliveryHeader, { view: payload, repo, onRetry, onProbe }),
    entries === null
      ? h(DeliveryColumns, { view: payload, repo: repo ?? payload.repo ?? null })
      : h('div', { className: 'bt-del-repos' },
        entries.map(entry => h(DeliveryRepoBlock, { key: entry.repo ?? 'unknown', entry }))))
}

export function DeliveryView({ actions }) {
  const [view, retry] = useDeliveryBoard(actions)
  return h(DeliveryBoard, {
    view,
    repo: view?.repo ?? null,
    onRetry: actions?.deliveryBoard ? retry : null,
    onProbe: actions?.deliveryProbe ? () => actions.deliveryProbe() : null,
  })
}

// A repository row as a card on the one board (#1265 step 1): the same component the task cards
// use, keyed `owner/name#number` so an issue and the pull request that closes it are one identity.
export function DeliveryCard({ card, repo = null }) {
  const model = githubCard(card, repo) ?? { source: 'github', key: null, title: card?.title ?? '', badge: card?.badge ?? null }
  return h(BoardCard, {
    card: model,
    skin: DELIVERY_SKIN,
    attrs: { 'data-kind': card?.kind, 'data-number': card?.number, 'data-badge': card?.badge ?? undefined },
    idText: `#${card?.number ?? '?'}`,
    badge: badgeLabel(card?.badge),
  })
}

export const DELIVERY_CSS = `
.bt-del-body{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;gap:10px;padding:12px 14px 16px}
.bt-del-head{display:flex;flex-direction:column;gap:6px;border-bottom:.5px solid var(--bt-line);padding-bottom:8px}
.bt-del-metrics{display:flex;flex-wrap:wrap;align-items:flex-start;gap:16px}
.bt-del-table{border-collapse:collapse;font-size:12px;line-height:16px;font-variant-numeric:tabular-nums}
.bt-del-table th,.bt-del-table td{padding:2px 8px;text-align:right;white-space:nowrap}
.bt-del-table th[scope=row]{text-align:left;font-weight:500;color:var(--bt-ink-2)}
.bt-del-table thead th{font-weight:600;color:var(--bt-ink-3)}
.bt-del-ci,.bt-del-open{margin:0;font-size:12px;line-height:16px;color:var(--bt-ink-2)}
.bt-del-asof{margin:0;font-size:11.5px;line-height:15px;color:var(--bt-ink-3);display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.bt-del-loading{margin:0;font-size:13px;line-height:18px;color:var(--bt-ink-2);font-variant-numeric:tabular-nums}
.bt-del-hint{margin:2px 0 0;font-size:12px;line-height:16px;color:var(--bt-ink-3)}
.bt-del-stale,.bt-del-partial{margin:0;font-size:12px;line-height:16px;color:var(--bt-ink-2)}
.bt-del-stale[role=status],.bt-del-partial[role=status]{padding:6px 8px;border-radius:10px;background:var(--bt-hover)}
.bt-del-diag{display:inline-flex;position:relative}
.bt-del-diag-box{position:absolute;top:100%;left:0;z-index:3;display:flex;flex-direction:column;gap:6px;padding:8px;border:.5px solid var(--bt-line-2);border-radius:10px;background:var(--bt-card,var(--bt-main));min-width:320px}
.bt-del-diag-text{margin:0;font-size:11px;line-height:15px;white-space:pre-wrap;word-break:break-all;color:var(--bt-ink-2);max-height:220px;overflow:auto}
.bt-del-columns{flex:1 1 auto;min-height:0;display:flex;gap:10px;overflow:auto}
.bt-del-column{flex:1 1 0;min-width:200px;display:flex;flex-direction:column;gap:8px;padding:8px;border-radius:14px;background:var(--bt-hover);overflow:auto}
.bt-del-repos{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;gap:14px;overflow:auto}
.bt-del-repo-block{display:flex;flex-direction:column;gap:8px;min-height:0}
.bt-del-repo-head{position:sticky;top:0;z-index:1;margin:0;padding:2px 4px;font-size:13px;line-height:18px;color:var(--bt-ink-2);background:var(--bt-main,var(--bt-card));border-radius:8px}
.bt-del-block-state{margin:0;padding:12px 8px;font-size:12px;line-height:16px;color:var(--bt-ink-3)}
.bt-del-card{display:flex;flex-direction:column;gap:5px;padding:10px;border:.5px solid var(--bt-line-2);border-radius:12px;background:var(--bt-card,var(--bt-main))}
.bt-del-card-top{display:flex;align-items:center;gap:6px}
.bt-del-id{font-size:12px;line-height:16px;color:var(--bt-ink-3);font-variant-numeric:tabular-nums}
.bt-del-badge{margin-left:auto;font-size:10.5px;line-height:16px;padding:0 6px;border-radius:999px;background:var(--bt-hover);color:var(--bt-ink-2)}
.bt-del-badge[data-badge=inc]{background:rgba(224,33,53,.12);color:#c21d2e}
.bt-del-badge[data-badge=ci-red]{background:rgba(224,33,53,.12);color:#c21d2e}
.bt-del-badge[data-badge=checks-unknown]{background:var(--bt-hover);color:var(--bt-ink-3)}
.bt-del-badge[data-badge=pass-enqueue],.bt-del-badge[data-badge=pass-merge]{background:color-mix(in srgb,var(--bt-green) 16%,transparent);color:color-mix(in srgb,var(--bt-green) 70%,var(--bt-ink))}
.bt-del-title{font-size:13.5px;line-height:19px;color:var(--bt-ink)}
.bt-del-labels{display:flex;flex-wrap:wrap;gap:4px}
.bt-del-label{font-size:10.5px;line-height:16px;padding:0 6px;border-radius:999px;background:var(--bt-hover);color:var(--bt-ink-2)}
.bt-del-owner{font-size:12px;line-height:16px;color:var(--bt-ink-2)}
.bt-del-owner[data-kind=human]{font-weight:600;color:var(--bt-ink)}
.bt-del-linked,.bt-del-sha{font-size:11.5px;line-height:15px;color:var(--bt-ink-3)}
.bt-del-open{align-self:flex-start;font-size:12px;line-height:16px;color:var(--bt-accent)}
@media (max-width:800px){
  .bt-del-columns{overflow:auto}
  .bt-del-column{min-width:220px}
}
@media (max-width:640px){
  .bt-del-columns{flex-direction:column}
  .bt-del-column{min-width:0}
}
` + DELIVERY_CHART_CSS
