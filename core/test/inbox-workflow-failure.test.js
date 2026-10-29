// #1706: a workflow run that fails writes its failure only into the workflow plugin's
// own state, so the Inbox — the one place the Owner looks — showed nothing. These
// tests seed the payload `workflow/state` returns (per-graph `runs` and `history`,
// both from present()) and ask the Inbox for its cards. The fixture shapes below were
// captured from a real service: a release/stop ending carries
// `failure:{code:'stopped'}`, a step failure carries
// `failure:{code:'step-failed',nodeName,text}`.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

const bundleOf = async (file) => {
  const built = await build({
    entryPoints: [fileURLToPath(new URL(file, import.meta.url))],
    bundle: true, format: 'cjs', platform: 'node', write: false,
    external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
  })
  return built.outputFiles[0].text
}

// A hook's effects are collected, never run: the one test that drives the workflow
// read calls them itself. Timers are stubs so a driven load arms no background poll.
const effects = []
const platform = {
  react: {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
    useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: fn => { effects.push(fn) }, useLayoutEffect: () => {}, useRef: current => ({ current }), useCallback: fn => fn, useMemo: fn => fn(), Fragment: 'fragment',
  },
  'react-dom': {},
  '@deepseek-ai/dsh-client-ui-primitives': {},
}
const load = async (source) => {
  const module = { exports: {} }
  runInNewContext(source, {
    module, exports: module.exports, setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {}, Date, Promise,
    window: { addEventListener: () => {}, removeEventListener: () => {} },
    require: (name) => {
      if (!(name in platform)) throw new Error(`no platform module ${name}`)
      return platform[name]
    },
  })
  return module.exports
}
const inbox = await load(await bundleOf('../src/client/inbox.js'))
const workflowPage = await load(await bundleOf('../src/client/workflows.js'))
const { inboxModel, needsCount, InboxCard, InboxDialog, openCard, workflowsOf, inboxAnswer, GROUPS } = inbox
const { readWorkflows } = workflowPage

const plain = value => JSON.parse(JSON.stringify(value))
const OWN = new Set(['InboxCard', 'Status', 'AnswerFields', 'ResultActions'])
const expand = (node) => {
  if (Array.isArray(node)) return node.flatMap(expand)
  if (node === null || typeof node !== 'object') return node
  if (OWN.has(node.type?.name)) return expand(node.type({ ...node.props, children: node.children }))
  return { ...node, children: node.children.map(expand) }
}
const all = (node, out = []) => {
  if (Array.isArray(node)) { for (const item of node) all(item, out); return out }
  if (node && typeof node === 'object') { out.push(node); all(node.children, out) }
  return out
}
const textOf = node => (typeof node === 'string' ? node : node && typeof node === 'object' ? node.children.map(textOf).join('') : '')
const byClass = (tree, name) => all(tree).filter(node => typeof node.props?.className === 'string' && node.props.className.split(' ').includes(name))
const buttons = tree => all(tree).filter(node => node.type === 'button')
const cardsIn = tree => all(tree).filter(node => node.type?.name === 'InboxCard')

// The clock is pinned to "now" so the 7-day window and the sidebar badge, which reads
// the real clock through its own default, agree on the same fixtures.
const NOW = Date.now()
const MIN = 60_000
const DAY = 86_400_000
const roster = {
  self: { memberId: 'm1' },
  bots: [
    { id: 'b1', name: 'Writer', role: 'dev', ownerId: 'm1', remote: false },
    { id: 'b2', name: 'Coder', role: 'dev', ownerId: 'm1', remote: false },
  ],
  rooms: [],
}
roster.byId = Object.fromEntries(roster.bots.map(bot => [bot.id, bot]))
roster.roomsById = {}
const work = {
  approvals: [{
    id: 'a1', botId: 'b1', roomId: 'r1', at: NOW - 2 * MIN, tool: 'Bash',
    detail: { text: 'rm -rf build' }, reason: 'Deletes the build output',
  }],
}

const finishedAt = NOW - 12 * MIN
// One graph whose last run failed at a step: the card has to say which node.
const failedRun = {
  id: 'run-068d5bb9',
  workflowId: 'delivery',
  task: { id: '#1706', title: 'issue #1706: a failed run never reaches the Inbox', callerBotId: 'b1' },
  taskSummary: 'issue #1706: a failed run never reaches the Inbox',
  status: 'failed',
  nodeStatus: { planner: 'done', writer: 'done', coder: 'done', reviewer: 'failed', tester: 'queued', deployer: 'queued' },
  steps: 4,
  stepBudget: 10,
  doneCount: 3,
  nodeCount: 6,
  marks: [],
  running: [],
  history: [],
  startedAt: finishedAt - 9 * MIN,
  updatedAt: finishedAt,
  finishedAt,
  failure: { code: 'step-failed', at: finishedAt, nodeName: 'Reviewer', text: 'the reviewer Bot did not answer' },
}
// A run that is still going: it is not news and must never show up.
const runningRun = {
  id: 'run-67c9d9cb',
  workflowId: 'weekly',
  task: { id: '#1701', title: 'issue #1701: kanban slice 1' },
  taskSummary: 'issue #1701: kanban slice 1',
  status: 'running',
  nodeStatus: { collect: 'running', summarize: 'queued', send: 'queued' },
  steps: 1,
  stepBudget: 4,
  doneCount: 0,
  nodeCount: 3,
  marks: [],
  running: ['collect'],
  history: [],
  startedAt: NOW - MIN,
  updatedAt: NOW - 30_000,
  finishedAt: null,
  currentStep: { id: 'collect', name: 'Collector' },
}
// A run that failed after its task card was gone: `history` keeps it, and it
// must still reach the Inbox — the run is what failed, not the task row.
const orphanRun = {
  id: 'run-d6fd9f97',
  task: { title: 'Nightly digest' },
  status: 'failed',
  at: NOW - 5 * MIN,
  failure: { code: 'stopped', at: NOW - 5 * MIN },
}
const workflows = [
  { id: 'delivery', name: 'Delivery pipeline', runs: [], history: [{ ...failedRun, at: finishedAt }] },
  { id: 'weekly', name: 'Weekly digest', runs: [runningRun], history: [orphanRun] },
]

const modelOf = list => inboxModel({ roster, work: {}, tasks: [], workflows: list, now: NOW })
const cards = modelOf(workflows)
const allCards = [...cards.needs, ...cards.progress, ...cards.done]
const workflowCards = allCards.filter(card => card.kind === 'workflow')
const runOf = id => workflowCards.filter(card => card.run?.id === id)

test('#1706: a failed run reaches the Inbox as one card naming graph, node and reason', () => {
  const found = runOf(failedRun.id)
  assert.equal(found.length, 1, `cards for ${failedRun.id}`)
  const card = found[0]
  assert.equal(card.status, 'failed')
  assert.equal(card.workflow.id, 'delivery')
  assert.match(card.title, /Delivery pipeline/)
  assert.match(card.title, /Reviewer/)
  assert.match(card.reason, /reviewer Bot did not answer/)
  assert.equal(card.at, finishedAt)
})

test('#1706 control: a run that is still running is not Inbox news', () => {
  assert.deepEqual(runOf(runningRun.id), [])
  assert.equal(allCards.filter(card => card.workflow?.id === 'weekly' && card.status === 'running').length, 0)
})

test('#1706 control: a failed run whose task card is gone still reaches the Inbox', () => {
  const found = runOf(orphanRun.id)
  assert.equal(found.length, 1, `cards for ${orphanRun.id}`)
  assert.equal(found[0].status, 'failed')
  assert.match(found[0].title, /Weekly digest/)
  // A history row has no finishedAt: its own `at` is when the run ended.
  assert.equal(found[0].at, orphanRun.at)
  assert.equal(found[0].task, undefined)
})

test('#1706: one card per graph, its newest failure, inside the 7-day window Done uses', () => {
  const older = { ...failedRun, id: 'run-older', finishedAt: NOW - 3 * 60 * MIN, updatedAt: NOW - 3 * 60 * MIN }
  const newest = { ...failedRun, id: 'run-newest', finishedAt: NOW - 10 * MIN, updatedAt: NOW - 10 * MIN }
  // A history row has no finishedAt/updatedAt: its own `at` is the end it names.
  const historyRow = (run, at) => ({ id: run.id, task: run.task, status: run.status, at, failure: run.failure })
  const two = modelOf([
    { id: 'delivery', name: 'Delivery pipeline', runs: [], history: [historyRow(older, older.finishedAt), historyRow(newest, newest.finishedAt)] },
  ])
  const found = [...two.needs, ...two.progress, ...two.done].filter(card => card.kind === 'workflow')
  assert.equal(found.length, 1)
  assert.equal(found[0].run.id, 'run-newest')
  assert.equal(found[0].at, newest.finishedAt)

  // Older failures stay on that graph's Runs tab; they are not Inbox news.
  const stale = modelOf([
    { id: 'delivery', name: 'Delivery pipeline', runs: [], history: [historyRow(older, NOW - 9 * DAY)] },
  ])
  assert.equal([...stale.needs, ...stale.progress, ...stale.done].filter(card => card.kind === 'workflow').length, 0)
})

test('#1706: a missing Workflow plugin is the same Inbox, with no error line', async () => {
  const settled = await readWorkflows(() => Promise.reject(Object.assign(new Error('Unknown FlyBot endpoint workflow/state'), { code: 'bot/not-found' })))
  assert.equal(settled.phase, 'error')
  assert.equal(workflowsOf(settled).length, 0)
  assert.deepEqual(plain(modelOf(workflowsOf(settled))), plain(modelOf([])))
})

test('#1706: the sidebar badge counts the same failed run the dialog lists', () => {
  const listed = inboxModel({ roster, work, tasks: [], workflows, now: NOW })
  assert.equal(needsCount(roster, work, [], NOW, workflows), listed.needs.length)
  // Without the pack the badge would be short by exactly the run cards.
  assert.equal(needsCount(roster, work, [], NOW, []), listed.needs.length - runOf(failedRun.id).length - runOf(orphanRun.id).length)
})

test('#1706: a workflow row has no chat, opens the Workflow graphs page, and answers nothing', () => {
  const card = runOf(failedRun.id)[0]
  assert.equal(card.chat, undefined)
  assert.equal(card.place, undefined)
  assert.equal(card.bot?.name, 'Writer')

  const log = []
  const actions = {
    closeInbox: () => log.push('close'),
    openSettings: page => log.push(`settings ${page}`),
    openSession: id => log.push(`session ${id}`),
  }
  openCard(actions, card)
  assert.deepEqual(log, ['close', 'settings workflow'])
  assert.equal(inboxAnswer(actions, card, 'allow'), undefined)

  const rendered = expand(InboxCard({ card, roster, now: NOW, busy: false, error: '', onAnswer: () => { throw new Error('a workflow row has no answer field') }, onOpen: () => openCard(actions, card) }))
  const row = byClass(rendered, 'bt-inbox-card')[0]
  assert.equal(row.props['data-run'], failedRun.id)
  assert.equal(row.props['data-task'], undefined)
  assert.equal(byClass(rendered, 'bt-inbox-answer').length, 0)
  assert.deepEqual(buttons(rendered).map(textOf), ['Open'])

  // Every other card still opens its chat.
  const other = []
  openCard({ closeInbox: () => other.push('close'), openSettings: page => other.push(`settings ${page}`), openSession: id => other.push(`session ${id}`) }, { kind: 'task', chat: 'b1' })
  assert.deepEqual(other, ['close', 'session b1'])
})

test('#1706: failed workflow rows share the one Needs you list', async () => {
  const actions = {
    workflowState: () => Promise.resolve({ phase: 'ready', pack: { workflows } }),
    tasks: () => Promise.resolve([]),
    closeInbox: () => {},
    openSettings: () => {},
    openSession: () => {},
  }
  const render = () => InboxDialog({ roster, useWork: pick => pick(work), useSessions: pick => pick({ byId: {} }), actions })
  // The workflow read settles asynchronously; the second render sees the shared pack.
  effects.splice(0)
  render()
  for (const effect of effects.splice(0)) effect()
  await new Promise(resolve => setTimeout(resolve, 0))
  const tree = render()

  const lists = byClass(tree, 'bt-inbox-list')
  assert.equal(lists.length, 1, 'one list, not a second failure list')
  const ids = cardsIn(lists[0]).map(node => node.props.card.id)
  assert.ok(ids.includes('approval:a1'), `approval card in the list: ${ids}`)
  assert.ok(ids.includes(`workflow:delivery:${failedRun.id}`), `workflow card in the list: ${ids}`)
  const heads = byClass(tree, 'bt-inbox-head').map(node => textOf(node.children[0]))
  assert.deepEqual(plain(heads), plain(GROUPS.map(group => group.title)))
  assert.equal(all(tree).filter(node => node.type === 'section').length, GROUPS.length)
})
