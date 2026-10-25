// Delivery board (#1173): the repository's GitHub issues and pull requests by delivery stage,
// in the same dialog as the per-Bot Tasks board. This is a view only — nothing here writes to
// GitHub, and the snapshot it renders is built host-side (src/host/delivery-board.js).
import { createElement as h, useEffect, useState } from 'react'
import { t } from './i18n.js'

const POLL_MS = 60_000

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
}

export const badgeLabel = (badge) => (badge ? t(BADGES[badge] ?? badge) : '')

export function duration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const hours = ms / 3_600_000
  if (hours < 1) return `${Math.max(1, Math.round(ms / 60_000))}m`
  if (hours < 48) return `${Math.round(hours)}h`
  return `${Math.round(hours / 24)}d`
}

// The header rows the dialog renders; kept pure so the numbers can be checked without React.
export function metricRows(snapshot) {
  const today = snapshot?.today ?? {}
  const week = snapshot?.week ?? {}
  const ci = today.ci ?? {}
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
    ci: {
      failed: ci.failed ?? 0,
      total: ci.total ?? 0,
      counted: ci.counted ?? 0,
      caveat: Number.isFinite(ci.total) && Number.isFinite(ci.counted) && ci.counted < ci.total,
      superseded: ci.superseded ?? 0,
    },
    open: snapshot?.open ?? {},
  }
}

export function useDeliveryBoard(actions) {
  const [snapshot, setSnapshot] = useState(null)
  const [message, setMessage] = useState('')
  useEffect(() => {
    let stopped = false
    const load = () => {
      const job = Promise.resolve(actions?.deliveryBoard?.())
      void job.then((next) => {
        if (stopped || !next || typeof next !== 'object') return
        if (next.ok === false) {
          setMessage(next.reason === 'no-github' ? t('No GitHub connection yet; the board fills in once one is added.') : t('The delivery board is not ready yet.'))
          return
        }
        setSnapshot(next)
        setMessage(next.error ? t('Showing the last snapshot from {time}: {error}', { time: timeOf(next.asOf), error: next.error }) : '')
      }).catch((error) => { if (!stopped) setMessage(String(error?.message ?? error)) })
    }
    load()
    const timer = setInterval(load, POLL_MS)
    return () => { stopped = true; clearInterval(timer) }
  }, [actions])
  return { snapshot, message }
}

const timeOf = (iso) => {
  const at = Date.parse(iso ?? '')
  if (!Number.isFinite(at)) return '—'
  return new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
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
    card?.url ? h('a', { className: 'bt-del-open', href: card.url, target: '_blank', rel: 'noreferrer' }, t('Open')) : null)
}

export function DeliveryHeader({ snapshot }) {
  if (!snapshot) return null
  const { rows, ci, open } = metricRows(snapshot)
  return h('header', { className: 'bt-del-head' },
    h('div', { className: 'bt-del-metrics' },
      h('table', { className: 'bt-del-table' },
        h('thead', null, h('tr', null, h('th', null, ''), h('th', null, t('Today')), h('th', null, t('7 days')))),
        h('tbody', null, rows.map(row => h('tr', { key: row.label },
          h('th', { scope: 'row' }, row.label),
          h('td', null, row.today),
          h('td', null, row.week))))),
      h('p', { className: 'bt-del-ci' }, t('CI failed {failed} of {total}', { failed: ci.failed, total: ci.total }),
        ci.caveat ? ` · ${t('counted {counted} of {total}', { counted: ci.counted, total: ci.total })}` : '',
        ci.superseded ? ` · ${t('{count} superseded', { count: ci.superseded })}` : ''),
      h('p', { className: 'bt-del-open' }, t('Open: {issues} issues ({needs} need a human), {prs} pull requests', {
        issues: open.issues ?? 0, needs: open.needsHuman ?? 0, prs: open.pullRequests ?? 0,
      }), open.medianIssueAgeMs !== null && open.medianIssueAgeMs !== undefined
        ? ` · ${t('median open age {age}', { age: duration(open.medianIssueAgeMs) })}` : '')),
    h('p', { className: 'bt-del-asof' }, t('as of {time}', { time: timeOf(snapshot.asOf) }),
      snapshot.refreshing ? ` · ${t('refreshing…')}` : ''))
}

export function DeliveryBoard({ snapshot, message }) {
  if (!snapshot) {
    return h('div', { className: 'bt-del-body', 'data-view': 'delivery' },
      message
        ? h('p', { className: 'bt-board-error', role: 'alert' }, message)
        : h('p', { className: 'bt-board-empty' }, t('No snapshot yet.')))
  }
  const columns = snapshot.columns ?? {}
  return h('div', { className: 'bt-del-body', 'data-view': 'delivery' },
    message ? h('p', { className: 'bt-board-error', role: 'alert' }, message) : null,
    h(DeliveryHeader, { snapshot: snapshot.metrics ? { ...snapshot.metrics, asOf: snapshot.asOf, refreshing: snapshot.refreshing } : null }),
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
  const { snapshot, message } = useDeliveryBoard(actions)
  return h(DeliveryBoard, { snapshot, message })
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
.bt-del-asof{margin:0;font-size:11.5px;line-height:15px;color:var(--bt-ink-3)}
.bt-del-columns{flex:1 1 auto;min-height:0;display:flex;gap:10px;overflow:auto}
.bt-del-column{flex:1 1 0;min-width:200px;display:flex;flex-direction:column;gap:8px;padding:8px;border-radius:14px;background:var(--bt-hover);overflow:auto}
.bt-del-card{display:flex;flex-direction:column;gap:5px;padding:10px;border:.5px solid var(--bt-line-2);border-radius:12px;background:var(--bt-card,var(--bt-main))}
.bt-del-card-top{display:flex;align-items:center;gap:6px}
.bt-del-id{font-size:12px;line-height:16px;color:var(--bt-ink-3);font-variant-numeric:tabular-nums}
.bt-del-badge{margin-left:auto;font-size:10.5px;line-height:16px;padding:0 6px;border-radius:999px;background:var(--bt-hover);color:var(--bt-ink-2)}
.bt-del-badge[data-badge=inc]{background:rgba(224,33,53,.12);color:#c21d2e}
.bt-del-badge[data-badge=ci-red]{background:rgba(224,33,53,.12);color:#c21d2e}
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
