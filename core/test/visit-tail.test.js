// Leaving a chat used to write the whole Session read up to *now* (`leaveVisits` in
// `index.js` did `seenAt[seenKey(id)] = Date.now()`), including turns that had never been
// scrolled into view, so the NEW divider never came back for them. A leave, a `pagehide` or
// a close now writes only the newest turn the view actually reported on screen, falls back
// to `now` only for a Session that never reported one (a browser's first answer, an empty
// chat), and never moves the mark backwards (#3079).
//
// The decision is `leftSeen` in `cells.js`, next to `movedOnSince`/`settledVisit`, the other
// turn-time rule the divider and the leave path share; the wiring is pinned in `header.js`
// (which measures the visible tail) and `index.js` (which writes it).
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
const module = { exports: {} }
runInNewContext(bundle.outputFiles[0].text, {
  module, exports: module.exports,
  require: (name) => {
    const platform = {
      react: {
        createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
        useState: initial => [initial, () => {}], useEffect: () => {}, useRef: current => ({ current }),
        useLayoutEffect: () => {}, useMemo: make => make(), Fragment: 'fragment',
      },
      'react-dom': { createPortal: node => node },
      '@deepseek-ai/dsh-client-ui-primitives': { MarkdownText },
    }
    if (!(name in platform)) throw new Error(`no platform module ${name}`)
    return platform[name]
  },
})
const { leftSeen } = module.exports

const index = readFileSync(new URL('../src/client/index.js', import.meta.url), 'utf8')
const header = readFileSync(new URL('../src/client/header.js', import.meta.url), 'utf8')
/** Non-comment source lines only, so a comment cannot satisfy a pin. */
const code = src => src.split('\n').filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n')

// t0 is the turn that was on screen when the chat was last left; t1 a turn that arrived below
// the viewport, or after the user had scrolled up, so it was never drawn on screen.
const T0 = 2_500
const T1 = 3_000
const NOW = 9_000

test('#3079: a leave keeps the mark at the newest turn that was on screen, never the clock', () => {
  assert.equal(leftSeen(T0, T0, NOW), T0, 'the turn below the fold stays unread')
})

test('#3079: a turn seen in the viewport and settled still advances the mark when the chat is left', () => {
  assert.equal(leftSeen(T0, T1, NOW), T1)
  assert.ok(leftSeen(T0, T1, NOW) > T0, 'the settled turn does not lose what the divider said was seen')
})

test('#3079: a chat that never reported a visible turn still advances to now, so a leave always marks something', () => {
  assert.equal(leftSeen(T0, undefined, NOW), NOW, 'no visible tail: the old fallback')
  assert.equal(leftSeen(undefined, undefined, NOW), NOW, 'a browser with no record yet')
})

test('#3079: the mark only moves forward: an older tail cannot reopen turns that were already read', () => {
  assert.equal(leftSeen(NOW, T0, NOW + 1_000), NOW)
  assert.equal(leftSeen(T1, T0, T1), T1)
})

test('#3079: index.js records the newest visible tail per Session and writes it on a leave', () => {
  assert.match(code(index), /const visitTails = \{\}/, 'the per-Session visible tails')
  assert.match(code(index), /noteVisitTail: \(id, tail\) =>/, 'the view reports the tail through an action')
  assert.match(code(index), /seenAt\[key\] = leftSeen\(/, 'leaveVisits writes the rule, not the clock')
  assert.doesNotMatch(code(index), /seenAt\[seenKey\(id\)\] = now/, 'the clock write is gone')
})

test('#3079: every way out of a chat (close, page hide) goes through the same leave path', () => {
  assert.match(code(index), /endVisit: \(id\) => \{\s*leaveVisits\(\[id\]\)/, 'a close leaves through leaveVisits')
  assert.match(code(index), /onPageHide = \(\) => leaveVisits\(Object\.keys\(ui\.getSnapshot\(\)\.visits \?\? \{\}\)\)/, 'a page hide does too')
  assert.match(code(index), /const seen = Math\.max\(seenAt\[key\] \?\? 0, visits\[id\]\?\.seen \?\? 0\)/, 'a settled visit keeps what it saw')
})

test('#3079: the view measures the newest turn on screen and reports it, not the unread count', () => {
  const view = code(header).slice(code(header).indexOf('function useTranscriptView()'), code(header).indexOf('function NewMessagePills('))
  assert.match(view, /querySelectorAll\('\[data-chat-turn\]'\)/, 'the rendered turn rows')
  assert.match(view, /tail/, 'the view carries the newest visible turn')
  assert.match(view, /at\.bottom > box\.top && at\.top < box\.bottom/, 'only a row inside the viewport counts')
  assert.match(code(header), /actions\?\.noteVisitTail\?\.\(sessionId, /, 'the pills report it for their Session')
})
