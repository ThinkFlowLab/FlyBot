import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { readFileSync } from 'node:fs'
import { build } from 'esbuild'

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/cells.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'node', write: false,
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
function MarkdownText() { return null }
const effects = []
const module = { exports: {} }
runInNewContext(bundle.outputFiles[0].text, {
  module, exports: module.exports,
  require: (name) => {
    const platform = {
      react: {
        createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
        useState: initial => [initial, () => {}], useEffect: (run) => { effects.push(run) }, useRef: current => ({ current }),
        useLayoutEffect: () => {}, useMemo: make => make(), Fragment: 'fragment',
      },
      'react-dom': { createPortal: node => node },
      '@deepseek-ai/dsh-client-ui-primitives': { MarkdownText },
    }
    if (!(name in platform)) throw new Error(`no platform module ${name}`)
    return platform[name]
  },
})
const { AssistantCell, TurnTailCell, TurnProcessCell, movedOnSince, settledVisit, unseenSince } = module.exports

// Renders the named components of an element tree, leaving the rest as elements.
const expand = (node, names) => {
  if (Array.isArray(node)) return node.flatMap(child => expand(child, names))
  if (node === null || typeof node !== 'object') return node
  if (names.includes(node.type?.name)) return expand(node.type({ ...node.props, children: node.children }), names)
  return { ...node, children: node.children.map(child => expand(child, names)) }
}
const find = (node, match) => {
  if (Array.isArray(node)) return node.flatMap(child => find(child, match))
  if (node === null || typeof node !== 'object') return []
  return [...(match(node) ? [node] : []), ...find(node.children, match)]
}

const roster = { bots: [], byId: { b: { id: 'b', name: 'Writer' } }, roomsById: {}, exchangeTurns: {} }
const finished = { turn: 3, status: 'closed', end: { time: 2_000 } }
function cellProps({ closingSeq = 10, turn = finished } = {}) {
  const asked = []
  const links = { resolve: () => undefined }
  const props = {
    node: {
      key: 'n10',
      location: { kind: 'step', turn },
      data: { turn: 3, step: 1, seq: 10, status: 'done', finalNode: { seq: 10 }, blocks: [{ kind: 'text', text: 'The brief is in `/work/brief.md`.' }] },
    },
    sessionId: 'b',
    openFile: () => {},
    fileMentions: (owner) => { asked.push(owner); return links },
    useTurnData: key => (key === 'turn-tail' ? { closing: { finalNode: { seq: closingSeq } } } : undefined),
    useRoster: select => select(roster),
    useUi: () => null,
    useTurnSteps: () => [],
    useTurnContext: () => [],
    actions: { noteLive() {} },
  }
  return { props, asked, links }
}
const markdownOf = props => find(expand(AssistantCell(props), ['Bubbles']), node => node.type === MarkdownText)

test('a reply that closes its turn links the files the turn changed or delivered', () => {
  const { props, asked, links } = cellProps()
  const [markdown] = markdownOf(props)
  assert.equal(markdown.props.fileMentions, links)
  assert.equal(asked.length, 1)
  assert.equal(asked[0].turn, finished)
  assert.equal(asked[0].seq, 10)
  assert.equal(asked[0].openFile, props.openFile)
})

test('a reply that does not close its turn, or one still running, links nothing', () => {
  const earlier = cellProps({ closingSeq: 12 })
  assert.equal(markdownOf(earlier.props)[0].props.fileMentions, undefined)
  const running = cellProps({ turn: { turn: 3, status: 'open' } })
  assert.equal(markdownOf(running.props)[0].props.fileMentions, undefined)
  assert.equal(earlier.asked.length + running.asked.length, 0)
})

test('the turn tail entry notes when the turn ended and shows the pause before the next one', () => {
  effects.length = 0
  const noted = []
  const clock = { b: { 3: { first: 1_000, end: 2_000 }, 4: { first: 2_000 + 60 * 60 * 1000 } } }
  const out = TurnTailCell({
    turn: finished,
    sessionId: 'b',
    useTurnClock: select => select(clock),
    useUi: () => undefined,
    actions: { noteTurnTime: (...args) => noted.push(args) },
  })
  for (const run of effects) run()
  assert.deepEqual(noted, [['b', 3, 'end', 2_000]])
  assert.equal(find(out, node => node.props?.className === 'bt-time-sep').length, 1)
})

test('a reply to a line the friend typed themselves is drawn as the person, not as the Bot', () => {
  const { props } = cellProps()
  const typed = { ...props, useRoster: select => select({ ...roster, remoteTypedTurns: { b: { 3: 'Bob' } } }) }
  const drawn = expand(AssistantCell(typed), ['PersonMessage', 'PersonMark', 'Bubbles'])
  const [person] = find(drawn, node => node.props?.['data-person'] !== undefined)
  assert.equal(person.props['data-person'], 'Bob')
  assert.equal(find(drawn, node => node.props?.className === 'bt-person-mark').length, 1)
  assert.equal(find(drawn, node => node.props?.className === 'bt-group-name' && node.children.includes('Bob')).length, 1)
  assert.equal(find(drawn, node => node.type === MarkdownText).length, 1, 'the text is still rendered as markdown')
  // Another turn, or no mark at all: the Bot\'s own bubble.
  const other = { ...props, useRoster: select => select({ ...roster, remoteTypedTurns: { b: { 9: 'Bob' } } }) }
  assert.equal(find(expand(AssistantCell(other), ['PersonMessage', 'PersonMark', 'Bubbles']), node => node.props?.['data-person'] !== undefined).length, 0)
  assert.equal(find(expand(AssistantCell(props), ['PersonMessage', 'PersonMark', 'Bubbles']), node => node.props?.['data-person'] !== undefined).length, 0)
})

// #275: a friend's line in my Bot's own chat came while I was away. The NEW divider marks it; once
// the divider has been on screen and the chat moves on (the friend's next line, my own message),
// the visit settles and every divider of the visit goes, as on leaving and coming back.
const dividers = node => find(expand(node, ['NewDivider']), item => item.props?.className === 'bt-new-sep').length
const tailOf = (clock, visit, turn = finished) => TurnTailCell({
  turn, sessionId: 'b', useTurnClock: select => select(clock), useUi: select => select({ visits: { b: visit } }), actions: { noteTurnTime() {} },
})
const processOf = (clock, visit, turn = 4) => TurnProcessCell({
  node: { location: { turn: { turn, start: { time: clock.b[turn].first } } }, data: { turn } },
  sessionId: 'b', useRoster: select => select(roster), useUi: select => select({ visits: { b: visit } }), useTurnClock: select => select(clock), actions: { noteTurnTime() {} },
})

test('#275: a friend\'s line that came while away has the NEW divider; the settled visit has none', () => {
  // Turn 3 ended before I left (1_500); the friend's line opened turn 4 at 3_000; I came back at 5_000.
  const clock = { b: { 3: { first: 1_000, end: 2_000 }, 4: { first: 3_000, end: 3_500 } } }
  const visit = { seen: 2_500, entered: 5_000 }
  assert.equal(dividers(tailOf(clock, visit)), 1, 'divider above the line')
  assert.equal(unseenSince(visit, 3_000), true)
  const settled = settledVisit(visit)
  assert.deepEqual([settled.seen, settled.entered], [5_000, 5_000])
  assert.equal(dividers(tailOf(clock, settled)), 0)
  assert.equal(unseenSince(settled, 3_000), false)
})

test('#275: the reply to a line I saw begin, finished while away, loses its divider when the visit settles', () => {
  const clock = { b: { 4: { first: 2_000, end: 3_000 } } }
  const visit = { seen: 2_500, entered: 5_000 }
  assert.equal(dividers(processOf(clock, visit)), 1)
  assert.equal(dividers(processOf(clock, settledVisit(visit))), 0)
})

test('#275: only a shown turn that began after the visit opened moves the chat on', () => {
  const visit = { seen: 2_500, entered: 5_000 }
  assert.equal(movedOnSince(visit, { 3: { first: 1_000, end: 2_000 }, 4: { first: 3_000 } }), false, 'only earlier turns: not yet')
  assert.equal(movedOnSince(visit, { 4: { first: 3_000 }, 5: { end: 6_000 } }), false, 'a turn with no start drawn yet')
  assert.equal(movedOnSince(visit, { 4: { first: 3_000 }, 5: { first: 6_000 } }), true, 'the friend\'s next line')
  assert.equal(movedOnSince(visit, { 5: { first: 6_000 } }, [5]), false, 'a hidden exchange turn is not something I saw')
  assert.equal(movedOnSince(undefined, { 5: { first: 6_000 } }), false, 'no visit')
})

test('#275: a visit with nothing unread, or no record, is left as it is', () => {
  const caught = { seen: 5_000, entered: 5_000 }
  assert.equal(settledVisit(caught), caught)
  const none = { seen: null, entered: 5_000 }
  assert.equal(settledVisit(none), none)
  assert.equal(settledVisit(undefined), undefined)
})

test('#275: the new-message pills settle the visit once the divider was seen and the chat moved on', () => {
  const header = readFileSync(new URL('../src/client/header.js', import.meta.url), 'utf8')
  assert.match(header, /movedOnSince\(visit, state\[sessionId\], hiddenTurns\)/)
  assert.match(header, /if \(above\.seen && movedOn\) actions\?\.settleVisit\?\.\(sessionId\)/)
  const index = readFileSync(new URL('../src/client/index.js', import.meta.url), 'utf8')
  assert.match(index, /settleVisit: id => ui\.set/)
})
