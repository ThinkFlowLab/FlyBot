// #1831: a decision card says what level it is and who it is addressed to, and a `severe` card
// never advances on its own — the host refuses it with the reason the board prints. The same
// board separates the three identities: the Bot holding a card, the card the Assistant speaks
// for a user, and a decision the project automation wrote.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { advanceRefusal, decisionLevel } from '../src/host/meetings.js'
import { decisionCardOf, install } from '../src/host/project-board.js'

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/project-board.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'node', write: false,
  external: ['react', 'react-dom'],
})

// A minimal hook runtime: the pane is a plain function, and these tests only draw it once.
const react = {
  // A function component is drawn where it is named, so one call reaches the rows and the record.
  createElement: (type, props, ...children) => (typeof type === 'function'
    ? type({ ...(props ?? {}), children: children.flat(Infinity) })
    : { type, props: props ?? {}, children: children.flat(Infinity) }),
  useCallback: fn => fn,
  useMemo: fn => fn(),
  useEffect: () => {},
  useRef: value => ({ current: value }),
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
}
const module = { exports: {} }
runInNewContext(bundle.outputFiles[0].text, {
  module,
  exports: module.exports,
  setTimeout,
  clearTimeout,
  setInterval: () => 0,
  clearInterval: () => {},
  Date,
  Promise,
  console,
  window: { location: { hash: '' }, addEventListener() {}, removeEventListener() {} },
  document: { visibilityState: 'visible' },
  require: (name) => {
    if (name === 'react') return react
    throw new Error(`no platform module ${name}`)
  },
})
const { ProjectBoardPane, projectBoardView } = module.exports

const all = (node, out = []) => {
  if (typeof node === 'string' || typeof node === 'number') { out.push(node); return out }
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const item of node) all(item, out)
    return out
  }
  out.push(node)
  for (const child of node.children ?? []) all(child, out)
  return out
}
const textOf = node => (typeof node === 'string' || typeof node === 'number' ? String(node) : '')

test('#1831: the level is validated, defaults to ordinary, and only severe refuses to advance', () => {
  assert.equal(decisionLevel(undefined), 'ordinary', 'a card with no level is ordinary')
  assert.equal(decisionLevel('major'), 'major')
  assert.throws(() => decisionLevel('critical'), /level must be one of ordinary, major, severe/)
  assert.equal(advanceRefusal({ level: 'ordinary' }), undefined)
  assert.equal(advanceRefusal({ level: 'major', participants: [{ position: { stance: 'dissent' } }] }), undefined, 'a major card advances by its own rule')
  assert.match(advanceRefusal({ level: 'severe', participants: [] }), /waits for the Owner/)
  assert.match(advanceRefusal({ level: 'severe', participants: [{ position: { stance: 'dissent' } }] }), /1 participant dissented/)
})

test('#1831: a severe card on the board carries the pause reason the host refused it with', () => {
  const severe = decisionCardOf({
    id: 'meeting-1', status: 'deliberating', level: 'severe', recipients: ['Chief', 'Dev'],
    participants: [{ name: 'Chief', position: { stance: 'dissent' } }],
  })
  assert.equal(severe.level, 'severe')
  assert.deepEqual(severe.recipients, ['Chief', 'Dev'])
  assert.equal(severe.advance.allowed, false)
  assert.match(severe.advance.reason, /waits for the Owner/)
  // A record written before this slice carries none of the three keys and reads as ordinary.
  assert.deepEqual(decisionCardOf({ id: 'meeting-0', status: 'open' }), { level: 'ordinary', recipients: [], advance: { allowed: true } })
})

test('#1831: the board read copies the level, the recipients and the identities it was given', async () => {
  const rt = {
    state: {
      tasks: {
        t1: { id: 't1', status: 'working', ownerBotId: 'b', assignee: 'Dev', claimedBy: 'Dev', speaksFor: 'alice', title: 'Ship it', createdAt: 1, updatedAt: 2 },
      },
      rooms: {}, bots: {}, meetings: {},
    },
    readProject: id => ({ id, name: 'P1', ownerUserIds: ['u1'] }),
    projectOfMember: (kind, id) => (kind === 'bot' && id === 'b' ? { id: 'project-p1' } : null),
    projectRunRefs: () => [],
    taskVisible: () => true,
    now: () => 1000,
  }
  install(rt)
  const board = await rt.projectBoard('project-p1', { name: 'Reader' })
  assert.equal(board.rows.length, 1)
  assert.equal(board.rows[0].holder, 'Dev')
  assert.equal(board.rows[0].speaksFor, 'alice')
})

test('#1831: a severe card is drawn with its badge, its recipients and the reason it is paused', () => {
  const props = {
    project: { id: 'project-1', name: 'FlyBot' },
    rows: [{ id: 't1', source: 'bot', column: 'in-progress', assignee: 'Dev', holder: 'Dev', speaksFor: 'alice', updatedAt: 2 }],
    tasks: [{ id: 't1', title: 'Ship it' }],
    canManage: false,
    meetings: {
      decided: [],
      pending: [{
        id: 'meeting-1', date: '2026-10-30', question: 'Adopt the shared store?', status: 'deliberating',
        level: 'severe', recipients: ['Chief'], advance: { allowed: false, reason: 'a severe decision waits for the Owner' },
      }],
    },
  }
  const view = projectBoardView(props)
  assert.equal(view.record.meetings.pending[0].level, 'severe')
  assert.equal(view.groups[0].rows[0].holder, 'Dev')
  assert.equal(view.groups[0].rows[0].speaksFor, 'alice')
  const tree = all(ProjectBoardPane(props))
  const text = tree.map(textOf).join(' | ')
  assert.match(text, /severe/i, 'the level badge is visible')
  assert.match(text, /@Chief/, 'the recipients are named on the card')
  assert.match(text, /waits for the Owner/, 'the pause reason is the host\u2019s own')
  assert.match(text, /@Dev/, 'the claim holder is named on the row')
  assert.match(text, /for alice/, 'a row that speaks for a user says so')
  assert.equal(tree.filter(node => node.props?.['data-level'] === 'severe').length > 0, true)
})
