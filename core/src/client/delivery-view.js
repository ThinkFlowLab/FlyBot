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

const POLL_MS = 60_000
// While the host is still building there is nothing to see, so ask often; once the board is up,
// asking often only burns GitHub reads (#1211).
const LOADING_POLL_MS = 2_000

export const pollDelay = (state) => (state === 'loading' || state === 'idle' ? LOADING_POLL_MS : POLL_MS)

export const DELIVERY_COLUMNS = [
  { id: 'raw', label: 'Original issue' },
  { id: 'ready', label: 'Ready to start' },
  { id: 'working', label: 'In progress' },
  { id: 'review', label: 'In review' },
  { id: 'done-today', label: 'Done today' },
]

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
  if (kind === 'no-token') return t('Add a GITHUB_TOKEN in this instance\'s settings — one that can read {repo}.', { repo: target })
  if (kind === 'rate-limit') {
    return error.retryAfterMs === null || error.retryAfterMs === undefined
      // No number from GitHub means no number here: the backoff is a rule, not a measurement.
      ? t('GitHub is rate-limiting this instance; it retries on its own (10 s → 30 s → 2 min).')
      : t('GitHub is rate-limiting this instance; it retries on its own in {seconds} s.', { seconds: secondsOf(error.retryAfterMs) })
  }
  if (kind === 'timeout') return t('GitHub did not answer in time; the next attempt is automatic.')
  if (scope === 'actions' && (kind === 'not-found' || kind === 'forbidden')) return t('Give the token Actions: Read.')
  if (scope === 'checks' && (kind === 'not-found' || kind === 'forbidden')) return t('Give the token Checks: Read.')
  if ((scope === 'comments' || scope === 'issues') && (kind === 'not-found' || kind === 'forbidden')) return t('Give the token Issues: Read.')
  if (scope === 'pulls' && (kind === 'not-found' || kind === 'forbidden')) return t('Give the token Pull requests: Read.')
  if (scope === 'repo' || kind === 'not-found' || kind === 'forbidden' || kind === 'auth') {
    return t('Check the repository name, and that the token can see {repo}.', { repo: target })
  }
  if (kind === 'server' || kind === 'network') return t('GitHub is not answering this instance right now; retry in a moment.')
  return t('The next attempt is automatic; the reason above names what failed.')
}

// A part that could not be read is named where it is missing, not hidden (#1211).
export function missingText(entry) {
  const status = entry?.status === null || entry?.status === undefined ? '' : ` · ${entry.status}`
  const part = entry?.part === 'ci' ? t('CI data')
    : entry?.part === 'budget' ? t('The rest of the board')
      : entry?.part ?? t('Part of the board')
  return t('{part} was not fetched this time: {message}', { part, message: `${String(entry?.message ?? '')}${status}` })
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
  const count = (value) => (value === null || value === undefined ? '—' : String(value))
  const rows = [
    { label: t('New issues'), key: 'newIssues' },
    { label: t('Closed issues'), key: 'closedIssues' },
    { label: t('New pull requests'), key: 'newPullRequests' },
    { label: t('Merged pull requests'), key: 'mergedPullRequests' },
    { label: t('Median issue close'), key: 'medianIssueCloseMs', format: duration },
    { label: t('Median PR merge'), key: 'medianPullMergeMs', format: duration },
  ].map(row => {
    const format = row.format ?? count
    return { label: row.label, today: format(today[row.key]), week: format(week[row.key]) }
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

export function useDeliveryBoard(actions) {
  const [view, setView] = useState({ state: 'idle' })
  useEffect(() => {
    let stopped = false
    let timer = null
    let state = 'idle'
    const schedule = () => {
      if (stopped) return
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(() => { timer = null; load() }, pollDelay(state))
    }
    const load = (force = false) => {
      const job = Promise.resolve(actions?.deliveryBoard?.(force ? { force: true } : {}))
      void job.then((next) => {
        if (stopped || !next || typeof next !== 'object') return
        state = typeof next.state === 'string' ? next.state : 'fresh'
        setView(next)
        schedule()
      }).catch((error) => {
        if (stopped) return
        state = 'failed'
        setView({ state: 'failed', error: { message: String(error?.message ?? error), kind: 'network', endpoint: null, status: null, at: null } })
        schedule()
      })
    }
    load()
    return () => { stopped = true; if (timer !== null) clearTimeout(timer) }
  }, [actions])
  return view
}

// The diagnostic report as text, so the 诊断 button can show and copy the same five lines the
// `--probe` CLI prints (#1211).
export function probeText(report) {
  if (!report) return ''
  const lines = [`${report.repo ?? ''} · ${timeOf(report.at)}`]
  for (const row of report.rows ?? []) {
    const status = row.status === null || row.status === undefined ? '—' : String(row.status)
    lines.push(`${row.ok ? 'ok' : 'FAIL'} ${status.padEnd(4)} ${row.endpoint}${row.ok ? '' : `  ${row.kind ?? ''}`}`)
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
  const { rows, ci, open } = metricRows(payload.metrics ?? payload)
  const error = payload.error ?? null
  const state = payload.state ?? 'fresh'
  return h('header', { className: 'bt-del-head' },
    h('div', { className: 'bt-del-metrics' },
      h('table', { className: 'bt-del-table' },
        h('thead', null, h('tr', null, h('th', null, ''), h('th', null, t('Today')), h('th', null, t('7 days')))),
        h('tbody', null, rows.map(row => h('tr', { key: row.label },
          h('th', { scope: 'row' }, row.label),
          h('td', null, row.today),
          h('td', null, row.week))))),
      // An unreadable CI number is "unknown", never "0 of 0" (#1211).
      h('p', { className: 'bt-del-ci', 'data-ci': ci === null ? 'unknown' : 'read' },
        ci === null ? t('CI not available this time') : t('CI failed {failed} of {total}', { failed: ci.failed, total: ci.total }),
        ci !== null && ci.caveat ? ` · ${t('counted {counted} of {total}', { counted: ci.counted, total: ci.total })}` : '',
        ci !== null && ci.superseded ? ` · ${t('{count} superseded', { count: ci.superseded })}` : '',
        ci !== null && ci.unknownDays?.length ? ` · ${t('{count} day(s) not read', { count: ci.unknownDays.length })}` : ''),
      h('p', { className: 'bt-del-open' }, t('Open: {issues} issues ({needs} need a human), {prs} pull requests', {
        issues: open.issues ?? 0, needs: open.needsHuman ?? 0, prs: open.pullRequests ?? 0,
      }), open.medianIssueAgeMs !== null && open.medianIssueAgeMs !== undefined
        ? ` · ${t('median open age {age}', { age: duration(open.medianIssueAgeMs) })}` : '')),
    h('p', { className: 'bt-del-asof' },
      state === 'loading' ? loadingText(payload.elapsedMs) : t('as of {time}', { time: timeOf(payload.asOf) }),
      payload.refreshing ? ` · ${t('refreshing…')}` : '',
      error ? ` · ${hintFor(error, { repo })}` : '',
      onRetry ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm bt-del-retry', onClick: onRetry }, t('Retry')) : null,
      onProbe ? h(Diagnose, { onProbe }) : null))
}

export function DeliveryBoard({ view, snapshot, message = '', repo = null, onRetry = null, onProbe = null }) {
  const payload = view ?? (snapshot ? { ...snapshot, state: 'fresh' } : { state: 'idle' })
  const state = payload.state ?? 'fresh'
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
  if (state === 'failed' || !payload.columns) {
    const error = payload.error ?? null
    return h('div', { className: 'bt-del-body', 'data-view': 'delivery', 'data-state': state },
      h('div', { className: 'bt-board-error', role: 'alert' },
        h('p', null, String(error?.message ?? message ?? t('The delivery board is not ready yet.'))),
        error ? h('p', { className: 'bt-del-hint' }, hintFor(error, { repo })) : null,
        h('p', { className: 'bt-del-hint' }, t('It retries on its own (10 s → 30 s → 2 min).')),
        onRetry ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm bt-del-retry', onClick: onRetry }, t('Retry')) : null))
  }
  const columns = payload.columns ?? {}
  const missing = payload.missing ?? []
  return h('div', { className: 'bt-del-body', 'data-view': 'delivery', 'data-state': state },
    message ? h('p', { className: 'bt-board-error', role: 'alert' }, message) : null,
    state === 'stale' && payload.error
      ? h('p', { className: 'bt-del-stale', role: 'status' }, staleText(payload.asOf, payload.error),
        ` · ${hintFor(payload.error, { repo })}`)
      : null,
    state !== 'stale' && missing.length > 0
      ? h('p', { className: 'bt-del-partial', role: 'status' }, missing.map(entry => missingText(entry)).join(' · '))
      : null,
    h(DeliveryHeader, { view: payload, repo, onRetry, onProbe }),
    h('div', { className: 'bt-del-columns' },
      DELIVERY_COLUMNS.map(column => h('section', { key: column.id, className: 'bt-del-column', 'data-column': column.id },
        h('h3', { className: 'bt-board-column-head' },
          h('span', null, t(column.label)),
          h('span', { className: 'bt-board-count' }, String((columns[column.id] ?? []).length))),
        (columns[column.id] ?? []).length === 0
          ? h('p', { className: 'bt-board-empty' }, t('Nothing here.'))
          : (columns[column.id] ?? []).map(card => h(DeliveryCard, { key: `${card.kind}-${card.number}`, card }))))))
}

export function DeliveryView({ actions }) {
  const view = useDeliveryBoard(actions)
  const retry = () => { void actions?.deliveryBoard?.({ force: true }) }
  return h(DeliveryBoard, {
    view,
    repo: view?.repo ?? null,
    onRetry: actions?.deliveryBoard ? retry : null,
    onProbe: actions?.deliveryProbe ? () => actions.deliveryProbe() : null,
  })
}

function Label({ name }) {
  return h('span', { className: 'bt-del-label', 'data-label': name }, name)
}

export function DeliveryCard({ card }) {
  const badge = badgeLabel(card?.badge)
  return h('article', { className: 'bt-del-card', 'data-kind': card?.kind, 'data-number': card?.number, 'data-badge': card?.badge ?? undefined },
    h('span', { className: 'bt-del-card-top' },
      h('span', { className: 'bt-del-id' }, `#${card?.number ?? '?'}`),
      badge ? h('span', { className: 'bt-del-badge', 'data-badge': card?.badge }, badge) : null),
    h('span', { className: 'bt-del-title' }, card?.title ?? ''),
    card?.labels?.length ? h('span', { className: 'bt-del-labels' }, card.labels.map(name => h(Label, { key: name, name }))) : null,
    card?.owner ? h('span', { className: 'bt-del-owner', 'data-kind': card.ownerKind ?? 'human' }, card.owner) : null,
    card?.linked ? h('span', { className: 'bt-del-linked' }, t('linked to #{number}', { number: card.linked })) : null,
    card?.sha ? h('span', { className: 'bt-del-sha' }, card.sha) : null,
    card?.url ? h('a', { className: 'bt-del-sha', href: card.url, target: '_blank', rel: 'noreferrer' }, t('open on GitHub')) : null)
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
`
