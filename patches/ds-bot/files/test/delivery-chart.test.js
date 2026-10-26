// The delivery trend chart (#1212): one x per day, a line that breaks at an unknown day instead of
// drawing through zero, a real zero as a filled dot on the baseline, today hollow only while it is
// still running, and no SVG at all when the snapshot carries no series. The chart is pure, so the
// geometry is asserted without a browser; the component tree is read the way delivery-view.test.js
// reads its view.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/delivery-chart.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'node', write: false,
  external: ['react'],
})
const module = { exports: {} }
runInNewContext(bundle.outputFiles[0].text, {
  module, exports: module.exports, setTimeout, clearTimeout, setInterval, clearInterval, Date, Promise, Number, Math, String, Array, Object,
  require: (name) => {
    if (name !== 'react') throw new Error(`no platform module ${name}`)
    return {
      createElement: (type, props, ...children) => {
        const kids = children.flat(Infinity)
        if (typeof type === 'function') return type({ ...(props ?? {}), children: kids })
        return { type, props: props ?? {}, children: kids }
      },
    }
  },
})
const {
  CHART_WIDTH, CHART_HEIGHT, CHART_DAYS, CHART_KEYS, chartDays, chartGeometry, dayValue,
  dayLabel, pointTitle, knownDays, todayPartial, DeliveryChart, DeliveryMetrics, DELIVERY_CHART_CSS,
} = module.exports

const walk = (node, out = []) => {
  if (node === null || typeof node !== 'object') return out
  out.push(node)
  for (const child of node.children ?? []) walk(child, out)
  return out
}
const textOf = (node) => {
  if (node === null || node === undefined || typeof node !== 'object') return String(node ?? '')
  return [node.props?.title ?? '', ...(node.children ?? []).map(textOf)].join(' ')
}

// Seven Asia/Shanghai days, 2026-10-20 … 2026-10-26; the last one is today and still running. The
// contract the host half is written against: { date, partial?, <four counts>, ci: { failed, counted, total } }.
const daily = [
  { date: '2026-10-20', newIssues: 2, closedIssues: 1, newPullRequests: 3, mergedPullRequests: 0, ci: { failed: 1, total: 10, counted: 10 } },
  { date: '2026-10-21', newIssues: 4, closedIssues: 2, newPullRequests: 1, mergedPullRequests: 2, ci: { failed: 0, total: 8, counted: 8 } },
  { date: '2026-10-22', newIssues: 1, closedIssues: 3, newPullRequests: 2, mergedPullRequests: 1, ci: { failed: 3, total: 9, counted: 9 } },
  { date: '2026-10-23', newIssues: 6, closedIssues: 0, newPullRequests: 0, mergedPullRequests: 4, ci: { failed: 0, total: 0, counted: 0 } },
  { date: '2026-10-24', newIssues: 3, closedIssues: 5, newPullRequests: 4, mergedPullRequests: 2, ci: { failed: 2, total: 5, counted: 4 } },
  { date: '2026-10-25', newIssues: 0, closedIssues: 1, newPullRequests: 1, mergedPullRequests: 3, ci: { failed: 1, total: 6, counted: 6 } },
  { date: '2026-10-26', newIssues: 5, closedIssues: 2, newPullRequests: 2, mergedPullRequests: 1, ci: { failed: 1, total: 4, counted: 4 }, partial: true },
]

test('#1212: seven days, the rightmost is today, and a longer series keeps its end', () => {
  assert.equal(CHART_DAYS, 7)
  const days = chartDays(daily)
  assert.equal(days.length, 7)
  assert.equal(dayLabel(days[6]), '2026-10-26', 'the contract carries the date itself')
  assert.equal(dayLabel({ start: '2026-10-25T16:00:00.000Z' }), '2026-10-26', 'an older ISO start still labels a day')
  assert.equal(chartDays(undefined), null, 'no series is null, not seven zeros')
  assert.equal(chartDays([]), null)
  assert.equal(chartDays([...daily, { date: '2026-10-27', newIssues: 9 }]).length, 7)
  assert.equal(todayPartial(daily), true)
  assert.equal(todayPartial(daily.map(day => ({ ...day, partial: undefined }))), false)
})

test('#1212: 168×28, one point per day, x across the box, the largest day at the top', () => {
  assert.equal(CHART_WIDTH, 168)
  assert.equal(CHART_HEIGHT, 28)
  const geo = chartGeometry(daily, 'newIssues')
  assert.equal(geo.width, CHART_WIDTH)
  assert.equal(geo.height, CHART_HEIGHT)
  assert.equal(geo.dots.length, 7)
  const xs = geo.dots.map(dot => dot.x)
  assert.deepEqual(xs, [...xs].sort((a, b) => a - b), 'x rises with the day')
  assert.equal(xs[0], 3)
  assert.equal(xs[6], CHART_WIDTH - 3)
  assert.equal(Math.min(...geo.dots.map(dot => dot.y)), 3, 'the largest value sits on the top padding')
  assert.equal(Math.max(...geo.dots.map(dot => dot.y)), CHART_HEIGHT - 3, 'a zero day sits on the bottom padding')
  assert.equal(geo.segments.length, 1)
  assert.equal(geo.dots[6].title, '2026-10-26 · 5')
})

test('#1212: an unknown day breaks the line instead of drawing through zero', () => {
  const gapped = daily.map((item, i) => (i === 3 ? { ...item, newIssues: null } : item))
  const geo = chartGeometry(gapped, 'newIssues')
  assert.equal(geo.dots[3].state, 'missing', 'the day is known to be missing')
  assert.equal(geo.dots[3].y, null, 'and has no point')
  assert.equal(geo.known, 6)
  assert.equal(geo.segments.length, 2)
  assert.equal(geo.segments[0].d.split('L').length, 3, 'first stretch: three days')
  assert.equal(geo.segments[1].d.split('L').length, 3, 'second stretch: the three days after the gap')
  assert.equal(geo.dots[3].title, '2026-10-23 · not available')
  // A real zero connects and keeps a filled dot on the baseline: never the same picture as a gap.
  const zeroed = daily.map((item, i) => (i === 3 ? { ...item, newIssues: 0 } : item))
  const flat = chartGeometry(zeroed, 'newIssues')
  assert.equal(flat.segments.length, 1, 'a real zero still connects')
  assert.equal(flat.dots[3].state, 'full')
  assert.equal(flat.dots[3].y, CHART_HEIGHT - 3, 'the zero dot sits on the baseline')
})

test('#1212: today is hollow and dashed only while it is still running', () => {
  const partial = chartGeometry(daily, 'newIssues')
  assert.equal(partial.dots[6].state, 'partial')
  assert.equal(partial.dots[6].hollow, true)
  assert.equal(partial.segments[0].dashed, true)
  assert.equal(partial.dots.filter(dot => dot.state === 'partial').length, 1, 'only today is partial')
  const finished = chartGeometry(daily.map(day => ({ ...day, partial: undefined })), 'newIssues')
  assert.equal(finished.dots[6].state, 'full', 'a finished day is a filled dot')
  assert.equal(finished.dots[6].hollow, false)
  assert.equal(finished.segments[0].dashed, false, 'and a solid line')
})

test('#1212: the CI metric is the red share of the runs that counted', () => {
  assert.equal(dayValue(daily[0], 'ci'), 0.1)
  assert.equal(dayValue(daily[4], 'ci'), 0.5, 'counted 4 of 5 runs: 2/4')
  assert.equal(dayValue(daily[3], 'ci'), null, 'no runs that day is unknown, not 0%')
  const geo = chartGeometry(daily, 'ci')
  assert.equal(geo.dots[3].state, 'missing')
  assert.equal(geo.dots[0].title, '2026-10-20 · 10%')
  assert.equal(knownDays(daily, 'ci'), 6)
})

test('#1212: the component draws a 168×28 svg with a state and a title on every point', () => {
  const node = DeliveryChart({ daily, metricKey: 'newIssues', label: 'New issues' })
  assert.equal(node.type, 'svg')
  assert.equal(node.props.width, 168)
  assert.equal(node.props.height, 28)
  assert.equal(node.props.viewBox, '0 0 168 28')
  const all = walk(node)
  const circles = all.filter(item => item.type === 'circle')
  assert.equal(circles.length, 7)
  assert.equal(circles[6].props['data-state'], 'partial')
  assert.equal(circles[6].props['data-hollow'], 'true')
  assert.equal(circles[6].props.r, 2.5, 'the hollow today dot is drawn larger')
  assert.equal(circles[0].props.r, 2, 'a measured day keeps the small dot')
  assert.equal(circles[6].props.fill, undefined, 'hollow comes from CSS, not a hard-coded colour')
  assert.equal(all.find(item => item.type === 'path').props['stroke-dasharray'], '2 2')
  const titles = all.filter(item => item.type === 'title').map(item => item.children.join(''))
  assert.equal(titles[6], '2026-10-26 · 5')
  assert.equal(titles[3], '2026-10-23 · 6')
  // A missing day is not a dot at all, so no circle can stand in for it.
  const gapped = walk(DeliveryChart({ daily: daily.map((item, i) => (i === 3 ? { ...item, newIssues: null } : item)), metricKey: 'newIssues' }))
  const gappedCircles = gapped.filter(item => item.type === 'circle')
  assert.equal(gappedCircles.length, 6)
  assert.equal(gappedCircles.some(circle => circle.props['data-state'] === 'missing'), false)
  assert.equal(gappedCircles.filter(circle => circle.props['data-state'] === 'full').length, 5)
})

test('#1212: a metric with no readable day draws nothing', () => {
  assert.equal(pointTitle({ date: '2026-10-23' }, 'newIssues'), '2026-10-23 · not available')
  assert.equal(DeliveryChart({ daily: daily.map(item => ({ ...item, mergedPullRequests: null })), metricKey: 'mergedPullRequests' }), null)
})

test('#1212: one grey line instead of an empty chart when the snapshot has no series', () => {
  const rows = CHART_KEYS.map(key => ({ key, label: key, today: '4', week: '30' }))
  for (const missing of [undefined, null, [], 'nope']) {
    const all = walk(DeliveryMetrics({ rows, daily: missing }))
    assert.equal(all.some(item => item.type === 'svg'), false, 'no svg without data')
    assert.equal(all.some(item => item.type === 'circle'), false)
    const empty = all.find(item => item.props?.['data-flybot'] === 'delivery-chart-empty')
    assert.ok(empty, 'the empty state is drawn')
    assert.match(textOf(empty), /No 7-day data yet\.|7 天数据未取到/)
    assert.equal(all.filter(item => item.props?.['data-metric'] && item.type === 'div').length, 5)
  }
})

test('#1212: five lines, Σ totals, medians with no line and no total, 900px breakpoint', () => {
  const rows = [
    { key: 'newIssues', label: 'New issues', today: '5', week: '21' },
    { key: 'closedIssues', label: 'Closed issues', today: '2', week: '14' },
    { key: 'newPullRequests', label: 'New pull requests', today: '2', week: '13' },
    { key: 'mergedPullRequests', label: 'Merged pull requests', today: '1', week: '13' },
    { key: 'ci', label: 'CI red share', today: '25%', week: '18%' },
    { key: 'medianIssueCloseMs', label: 'Median issue close', today: '1h', week: '2h' },
    { key: 'medianPullMergeMs', label: 'Median PR merge', today: '3h', week: '25h' },
  ]
  const all = walk(DeliveryMetrics({ rows, daily }))
  const rowNodes = all.filter(item => item.props?.className === 'bt-del-dm-row')
  assert.equal(rowNodes.length, 7)
  assert.equal(all.filter(item => item.type === 'svg').length, 5, 'the five countable metrics carry a line')
  // The two median rows keep their numbers and get no line, no placeholder cell and no Σ.
  const median = rowNodes[5]
  assert.equal(median.children.length, 3, 'label, today, 7 days — no chart cell at all')
  assert.equal(median.children.some(child => child.props.className === 'bt-del-dm-chart'), false)
  assert.equal(median.children[2].children.join(''), '2h', 'a median is not summed')
  assert.equal(rowNodes[6].children[2].children.join(''), '25h')
  // One primary number per row: today is bold ink, the total is muted and prefixed.
  assert.equal(rowNodes[0].children[2].props.className, 'bt-del-dm-value bt-del-dm-today')
  assert.equal(rowNodes[0].children[3].props.className, 'bt-del-dm-value bt-del-dm-week')
  assert.equal(rowNodes[0].children[3].children.join(''), 'Σ 21')
  // A day the host could not read makes the total incomplete: it wears the star.
  const gapped = walk(DeliveryMetrics({ rows, daily: daily.map((item, i) => (i === 2 ? { ...item, newIssues: null } : item)) }))
  const gappedRows = gapped.filter(item => item.props?.className === 'bt-del-dm-row')
  assert.equal(gappedRows[0].children[3].children.join(''), 'Σ 21*')
  const foot = gapped.find(item => item.props?.['data-flybot'] === 'delivery-chart-foot')
  assert.ok(foot, 'the star is explained')
  assert.match(textOf(foot), /\* [0-9]+ of [0-9]+ days|天中/)
  // Headers: the two value columns say today and the 7-day total; today names itself as partial.
  const head = all.find(item => item.props?.['data-flybot'] === 'delivery-metrics-head')
  const labels = head.children.map(child => (child.children ?? []).join(''))
  // The partial day is named once, on the as-of line; the shared header keeps one word.
  assert.equal(labels[2], 'Today')
  assert.equal(labels[3], '7 days', 'no Σ in the shared header')
  assert.match(DELIVERY_CHART_CSS, /max-width:899\.98px/, 'the line moves under its row below 900px')
  assert.match(DELIVERY_CHART_CSS, /\.bt-del-dm-chart\{order:5;flex:0 0 100%/, 'the line takes its own line there')
  assert.match(DELIVERY_CHART_CSS, /min-height:44px/, 'the row grows to 44px there')
  assert.match(DELIVERY_CHART_CSS, /flex:0 0 168px/, 'the line does not shrink')
  assert.match(DELIVERY_CHART_CSS, /stroke-width:1\.5/)
  assert.match(DELIVERY_CHART_CSS, /fill:var\(--bt-accent\)/)
  assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(DELIVERY_CHART_CSS), false, 'no hard-coded colour')
})

test('#1212: a row finds its series by key, not by its position', () => {
  const rows = [
    { key: 'ci', label: 'CI red share', today: '25%', week: '18%' },
    { key: 'newIssues', label: 'New issues', today: '5', week: '21' },
    { key: 'medianIssueCloseMs', label: 'Median issue close', today: '1h', week: '2h' },
  ]
  const all = walk(DeliveryMetrics({ rows, daily }))
  const rowNodes = all.filter(item => item.props?.className === 'bt-del-dm-row')
  assert.deepEqual(rowNodes.map(node => node.props['data-metric']), ['ci', 'newIssues', undefined])
  assert.equal(rowNodes[0].children.length, 4, 'the countable row keeps its line')
  assert.equal(rowNodes[0].children[2].children.join(''), '25%')
  // A ratio is not a sum: the CI row keeps its number plain, while a count wears the star.
  assert.equal(rowNodes[0].children[3].children.join(''), '18%', 'the CI share is a ratio, never summed')
  assert.equal(rowNodes[1].children[3].children.join(''), 'Σ 21', 'the count keeps its Σ')
  assert.equal(rowNodes[2].children.length, 3, 'a median row stays without a line, wherever it sits')
  const svgs = all.filter(item => item.type === 'svg')
  assert.equal(svgs.length, 2)
})
