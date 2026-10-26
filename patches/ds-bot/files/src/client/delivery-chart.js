// Delivery trend charts (#1212): one 7-day line per countable metric, drawn from `metrics.daily`.
// The host half builds the series (Asia/Shanghai days, the last entry carries `partial: true` until
// the day is over); this module only draws it, and a snapshot without the series says so instead of
// guessing. A day the host could not read breaks the line — an unknown is never drawn as zero.
import { createElement as h } from 'react'
import { t } from './i18n.js'

export const CHART_WIDTH = 168
export const CHART_HEIGHT = 28
const PAD = 3
const DOT_RADIUS = 2
// The dot that is not a measurement yet (today, still running) is drawn a touch larger so the
// hollow ring stays visible at this size.
const HOLLOW_RADIUS = 2.5
// The most days a chart draws; the host sends 7 today and a longer series is cut to its end.
export const CHART_DAYS = 7

// Keys line up with the rows `metricRows()` builds, in that order: the first five are countable and
// carry a line, the two medians after them cannot be added up and get no chart at all (#1212).
// The five countable metrics draw a line; the CI share draws one too but is a ratio, so it never
// takes a Σ total. Ties to the rows `metricRows()` builds, by key.
export const CHART_KEYS = ['newIssues', 'closedIssues', 'newPullRequests', 'mergedPullRequests', 'ci']
export const COUNTING_KEYS = ['newIssues', 'closedIssues', 'newPullRequests', 'mergedPullRequests']

// The days to draw, or null when the snapshot carries no series at all (host half not landed yet,
// or an older host) — that is the empty state, not seven zeros.
export function chartDays(daily) {
  if (!Array.isArray(daily)) return null
  const days = daily.filter(day => day && typeof day === 'object')
  return days.length ? days.slice(-CHART_DAYS) : null
}

// True while today is still running: the last day says `partial: true`.
export function todayPartial(daily) {
  const days = chartDays(daily)
  return Boolean(days && days.length && days[days.length - 1].partial === true)
}

// One day's number for one metric; null means the host did not get it, which is not a zero.
export function dayValue(day, key) {
  if (!day || typeof day !== 'object') return null
  if (key === 'ci') {
    const failed = day.ci?.failed
    const counted = day.ci?.counted
    const total = day.ci?.total
    // A superseded run is not in the denominator when the host counted them (#1212 contract).
    const denominator = Number.isFinite(counted) && counted > 0
      ? counted
      : (Number.isFinite(total) && total > 0 ? total : null)
    if (!Number.isFinite(failed) || denominator === null) return null
    return Math.min(1, Math.max(0, failed / denominator))
  }
  const value = day[key]
  return Number.isFinite(value) ? value : null
}

// The calendar date the day stands for, in the zone the host cuts days by (Asia/Shanghai, UTC+8,
// no DST). A start the host did not send leaves the date out of the title, never invents one.
export function dayLabel(day) {
  // The contract is a plain date: 'YYYY-MM-DD'; an older answer carried an ISO start, read the
  // same way so a host mid-upgrade still labels its days.
  if (typeof day?.date === 'string' && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(day.date)) return day.date
  const at = Date.parse(day?.start ?? '')
  if (!Number.isFinite(at)) return ''
  return new Date(at + 8 * 3_600_000).toISOString().slice(0, 10)
}

// `2026-10-26 · 12`, and `2026-10-26 · 未取到` for a day the host could not read.
export function pointTitle(day, key) {
  const date = dayLabel(day)
  const value = dayValue(day, key)
  const shown = value === null
    ? t('not available')
    : (key === 'ci' ? `${Math.round(value * 100)}%` : String(value))
  return date ? `${date} · ${shown}` : shown
}

// How many of the drawn days carry a number for this metric; fewer than the window means the total
// is incomplete and wears the star (#1212).
export function knownDays(daily, key) {
  const days = chartDays(daily) ?? []
  return days.filter(day => dayValue(day, key) !== null).length
}

const round = value => Math.round(value * 100) / 100

// The SVG geometry for one metric: one x per day, a y for each known day, and the path split at
// every unknown day. Pure, so the shape can be asserted without React (#1212).
export function chartGeometry(daily, key, { width = CHART_WIDTH, height = CHART_HEIGHT } = {}) {
  const days = chartDays(daily)
  if (!days) return null
  const values = days.map(day => dayValue(day, key))
  const known = values.filter(value => value !== null)
  const top = known.length ? Math.max(...known, 0) : 0
  // All-zero days still sit on the floor; a flat line on the baseline is the honest picture, and a
  // filled dot there is how a real zero stays apart from a missing day.
  const span = top > 0 ? top : 1
  const step = days.length > 1 ? (width - PAD * 2) / (days.length - 1) : 0
  const dots = days.map((day, i) => {
    const value = values[i]
    const last = i === days.length - 1
    const state = value === null ? 'missing' : (last && day.partial === true ? 'partial' : 'full')
    return {
      index: i,
      x: round(PAD + step * i),
      y: value === null ? null : round(PAD + (height - PAD * 2) * (1 - value / span)),
      today: last,
      // Only the day that is not over yet is drawn hollow; a finished day is a filled dot.
      hollow: state === 'partial',
      partial: state === 'partial',
      state,
      title: pointTitle(day, key),
      value,
    }
  })
  const segments = []
  let run = null
  for (const dot of dots) {
    if (dot.y === null) {
      if (run) { segments.push(run); run = null }
      continue
    }
    if (!run) run = { dots: [] }
    run.dots.push(dot)
  }
  if (run) segments.push(run)
  return {
    width,
    height,
    dots,
    known: known.length,
    segments: segments.map(segment => ({
      d: segment.dots.map((dot, i) => `${i ? 'L' : 'M'}${dot.x} ${dot.y}`).join(' '),
      // Only the stretch that ends today is the day that is not over yet.
      dashed: segment.dots.some(dot => dot.partial),
      today: segment.dots.some(dot => dot.today),
    })),
  }
}

// One metric's line: 168×28, 1.5px stroke, r=2 dots, a `title` on every point. Each dot says its
// own state (`full` / `partial`); a missing day has no dot at all, so a break can never be read as
// a zero, and a real zero is a filled dot on the baseline (#1212).
export function DeliveryChart({ daily, metricKey, label }) {
  const geo = chartGeometry(daily, metricKey)
  if (!geo || !geo.known) return null
  const name = label ? t('{label} over the last 7 days', { label }) : t('Last 7 days')
  return h('svg', {
    className: 'bt-del-chart',
    'data-flybot': 'delivery-chart',
    'data-metric': metricKey,
    width: geo.width,
    height: geo.height,
    viewBox: `0 0 ${geo.width} ${geo.height}`,
    role: 'img',
    'aria-label': name,
  },
  geo.segments.map((segment, i) => h('path', {
    key: `s${i}`,
    className: 'bt-del-chart-line',
    'data-today': segment.today ? 'true' : undefined,
    ...(segment.dashed ? { 'stroke-dasharray': '2 2' } : {}),
    d: segment.d,
  })),
  geo.dots.filter(dot => dot.y !== null).map(dot => h('circle', {
    key: `d${dot.index}`,
    className: 'bt-del-chart-dot',
    'data-state': dot.state,
    'data-hollow': dot.hollow ? 'true' : undefined,
    cx: dot.x,
    cy: dot.y,
    r: dot.hollow ? HOLLOW_RADIUS : DOT_RADIUS,
  }, h('title', null, dot.title))))
}

// The metrics block #1212 draws: `label | line | today | 7 days`, one row per metric, the five
// countable lines and the CI share stacked. Rows keep the numbers `metricRows()` already formatted; a total is
// prefixed with Σ and muted so only one number per row is the day's, and it wears a star when the
// window has days the host could not read. The two median rows get no line, no placeholder and no
// total — a median cannot be added up. Below 900px the line moves under its row (DELIVERY_CHART_CSS).
export function DeliveryMetrics({ rows = [], daily }) {
  const days = chartDays(daily)
  const short = CHART_KEYS
    .map(key => knownDays(days, key))
    .filter(count => count < (days?.length ?? 0))
  const fewest = short.length ? Math.min(...short) : 0
  const head = h('div', { className: 'bt-del-dm-head', 'data-flybot': 'delivery-metrics-head' },
    h('span', { className: 'bt-del-dm-label' }, ''),
    h('span', { className: 'bt-del-dm-chart-head' }, ''),
    h('span', { className: 'bt-del-dm-value' }, t('Today')),
    h('span', { className: 'bt-del-dm-value bt-del-dm-week' }, t('7 days')))
  const body = rows.map((row, index) => {
    // The row names the series it belongs to, so reordering the rows cannot hand one metric
    // another metric's line; a row outside CHART_KEYS (a median) simply gets none.
    const key = CHART_KEYS.includes(row?.key) ? row.key : null
    const chart = days && key
      ? h(DeliveryChart, { key: `c-${key}`, daily: days, metricKey: key, label: row?.label })
      : null
    // A ratio is not a sum: the CI share keeps its week number plain, and the star marks an
    // incomplete count only.
    const counted = key !== null && COUNTING_KEYS.includes(key)
    const star = days && counted && knownDays(days, key) < days.length ? '*' : ''
    const cells = [
      h('span', { key: 'label', className: 'bt-del-dm-label' }, row?.label ?? ''),
      // A median row gets no chart cell at all: no line, no placeholder box, no total.
      ...(key ? [h('span', { key: 'chart', className: 'bt-del-dm-chart' }, chart)] : []),
      h('span', { key: 'today', className: 'bt-del-dm-value bt-del-dm-today' }, row?.today ?? '—'),
      h('span', { key: 'week', className: 'bt-del-dm-value bt-del-dm-week' }, counted ? `Σ ${row?.week ?? '—'}${star}` : (row?.week ?? '—')),
    ]
    return h('div', { key: row?.label ?? String(index), className: 'bt-del-dm-row', 'data-metric': key ?? undefined }, cells)
  })
  return h('div', { className: 'bt-del-dm', 'data-flybot': 'delivery-metrics' },
    head,
    body,
    days ? null : h('p', { className: 'bt-del-chart-empty', 'data-flybot': 'delivery-chart-empty' }, t('No 7-day data yet.')),
    days && short.length
      ? h('p', { className: 'bt-del-chart-foot', 'data-flybot': 'delivery-chart-foot' }, t('* {count} of {days} days had data', { count: fewest, days: days.length }))
      : null)
}

export const DELIVERY_CHART_CSS = `
.bt-del-dm{display:flex;flex-direction:column;gap:2px;min-width:0}
.bt-del-dm-head,.bt-del-dm-row{display:flex;align-items:center;gap:8px}
.bt-del-dm-head{font-size:12px;line-height:16px;font-weight:600;color:var(--bt-ink-3)}
.bt-del-dm-label{flex:1 1 auto;min-width:0;font-size:12px;line-height:16px;color:var(--bt-ink-2)}
.bt-del-dm-head .bt-del-dm-label{color:inherit}
.bt-del-dm-chart,.bt-del-dm-chart-head{flex:0 0 168px;display:flex;align-items:center;min-height:28px}
.bt-del-dm-value{flex:0 0 auto;min-width:56px;text-align:right;font-size:12px;line-height:16px;font-variant-numeric:tabular-nums;color:var(--bt-ink)}
.bt-del-dm-head .bt-del-dm-value{color:inherit;font-weight:inherit}
.bt-del-dm-today{color:var(--bt-ink);font-weight:600}
.bt-del-dm-week{color:var(--bt-ink-3);font-weight:400}
.bt-del-chart{display:block;overflow:visible}
.bt-del-chart-line{fill:none;stroke:var(--bt-accent);stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
.bt-del-chart-dot{fill:var(--bt-accent);stroke:none}
.bt-del-chart-dot[data-state=partial]{fill:none;stroke:var(--bt-accent);stroke-width:1.5}
.bt-del-chart-empty,.bt-del-chart-foot{margin:2px 0 0;font-size:12px;line-height:16px;color:var(--bt-ink-3)}
@media (max-width:899.98px){
  .bt-del-dm-head{display:none}
  .bt-del-dm-row{flex-wrap:wrap;gap:4px 8px;min-height:44px;align-content:center}
  .bt-del-dm-chart{order:5;flex:0 0 100%;min-height:0}
  .bt-del-dm-value{min-width:0}
}
`
