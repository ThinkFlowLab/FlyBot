// The delivery board view (#1173): five columns from one snapshot, a read-only card, and the
// header numbers with the CI counted caveat. The host module is tested in delivery-board.test.js.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/delivery-view.js', import.meta.url))],
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
      useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
      useEffect: () => {},
    }
  },
})
const { DELIVERY_COLUMNS, DeliveryBoard, badgeLabel, duration, metricRows } = module.exports

const text = (node) => {
  if (node === null || node === undefined || typeof node !== 'object') return String(node ?? '')
  return [node.props?.title ?? '', ...(node.children ?? []).map(text)].join(' ')
}
const walk = (node, out = []) => {
  if (node === null || typeof node !== 'object') return out
  out.push(node)
  for (const child of node.children ?? []) walk(child, out)
  return out
}

const snapshot = {
  asOf: '2026-10-25T04:00:00Z',
  columns: {
    raw: [{ kind: 'issue', number: 10, title: 'Untriaged', labels: ['bug'], url: 'https://x/10', owner: null }],
    ready: [{ kind: 'issue', number: 11, title: 'Ready', labels: ['agent-ready'], url: 'https://x/11', owner: 'Dev' }],
    working: [{ kind: 'issue', number: 12, title: 'Working', labels: ['agent-working'], url: 'https://x/12', linked: 41 }],
    review: [{ kind: 'pr', number: 41, title: 'Fix', labels: [], url: 'https://x/41', badge: 'inc', sha: 'abcdef1' }],
    'done-today': [{ kind: 'pr', number: 40, title: 'Merged', labels: [], url: 'https://x/40' }],
  },
  metrics: {
    dayStart: '2026-10-24T16:00:00.000Z',
    today: {
      newIssues: 4, closedIssues: 2, newPullRequests: 5, mergedPullRequests: 3,
      medianIssueCloseMs: 3_600_000, medianPullMergeMs: 90_000_000,
      ci: { failed: 2, total: 1200, counted: 1000, superseded: 3 },
    },
    week: {
      newIssues: 30, closedIssues: 20, newPullRequests: 40, mergedPullRequests: 25,
      medianIssueCloseMs: 7_200_000, medianPullMergeMs: 180_000_000,
      ci: { failed: 10, total: 10, counted: 10, superseded: 0 },
    },
    open: { issues: 54, pullRequests: 6, needsHuman: 4, medianIssueAgeMs: 259_200_000 },
  },
}

test('five delivery columns, localized labels, badge wording (#1173)', () => {
  assert.deepEqual([...DELIVERY_COLUMNS.map(column => column.id)], ['raw', 'ready', 'working', 'review', 'done-today'])
  assert.equal(badgeLabel('inc'), 'INC · rework')
  assert.equal(badgeLabel('pass-enqueue'), 'PASS · waiting for enqueue')
  assert.equal(badgeLabel('pass-merge'), 'PASS · waiting for merge')
  assert.equal(badgeLabel('ci-red'), 'CI red')
  assert.equal(badgeLabel('no-verdict'), 'No verdict')
  assert.equal(duration(45_000), '1m')
  assert.equal(duration(3_600_000), '1h')
  assert.equal(duration(90_000_000), '25h')
  assert.equal(duration(200_000_000), '2d')
  assert.equal(duration(null), '—')
})

test('the header carries today, the 7-day comparison, the CI caveat and open ages (#1173)', () => {
  const rows = metricRows(snapshot.metrics)
  assert.equal(rows.rows.length, 6)
  assert.deepEqual({ ...rows.rows[0] }, { label: 'New issues', today: '4', week: '30' })
  assert.deepEqual({ ...rows.rows[4] }, { label: 'Median issue close', today: '1h', week: '2h' })
  assert.equal(rows.ci.failed, 2)
  assert.equal(rows.ci.total, 1200)
  assert.equal(rows.ci.caveat, true)
  assert.equal(rows.ci.superseded, 3)
  assert.equal(rows.open.needsHuman, 4)
})

test('the board renders all five columns and a card with labels, owner and link (#1173)', () => {
  const board = DeliveryBoard({ snapshot: { ...snapshot, columns: snapshot.columns }, message: '' })
  const sections = walk(board).filter(node => node.type === 'section' && node.props?.['data-column'])
  assert.deepEqual([...sections.map(node => node.props['data-column'])], ['raw', 'ready', 'working', 'review', 'done-today'])
  const review = sections.find(node => node.props['data-column'] === 'review')
  assert.equal(review.children[0].children[1].children[0], '1')
  const card = walk(review).find(node => node.props?.['data-badge'] === 'inc')
  const words = text(card)
  assert.match(words, /Fix/)
  assert.match(words, /INC · rework/)
  assert.match(words, /abcdef1/)
  const workingCard = walk(sections.find(node => node.props['data-column'] === 'working')).find(node => node.type === 'article')
  assert.match(text(workingCard), /linked to #41/)
  assert.ok(walk(workingCard).some(node => node.type === 'a' && node.props.href === 'https://x/12'))
  // A person is rendered as a person, not as a Bot.
  const owner = walk(workingCard).concat(walk(sections.find(node => node.props['data-column'] === 'ready'))).find(node => node.props?.className === 'bt-del-owner')
  assert.equal(owner.props['data-kind'], 'human')
})

test('an honest message replaces the board when there is no GitHub connection (#1173)', () => {
  const board = DeliveryBoard({ snapshot: null, message: 'No GitHub connection yet; the board fills in once one is added.' })
  assert.match(text(board), /No GitHub connection yet/)
  assert.equal(walk(board).some(node => node.type === 'section'), false)
})
