import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { historyEntry } from '../src/host/parts.js'

// #698: a kickoff line was the setup prompt a Bot got when it was made, never a message its
// parent sent. The earlier-part path (historyEntry, host) and the current part (cells.js,
// client) agree: both hide it, and both keep a real line from another Bot.

async function load(entry) {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL(`../src/client/${entry}`, import.meta.url))],
    bundle: true, format: 'cjs', platform: 'node', write: false,
    external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
  })
  const module = { exports: {} }
  runInNewContext(bundle.outputFiles[0].text, {
    module, exports: module.exports, setTimeout, clearTimeout,
    require: (name) => {
      const platform = {
        react: {
          createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
          useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}], useEffect: () => {}, useRef: current => ({ current }),
          useLayoutEffect: () => {}, useMemo: make => make(), useCallback: fn => fn, useSyncExternalStore: (sub, get) => get(), Fragment: 'fragment',
        },
        'react-dom': { createPortal: node => node },
        '@deepseek-ai/dsh-client-ui-primitives': { MarkdownText: function MarkdownText() { return null }, projectUserText: text => text },
      }
      if (!(name in platform)) throw new Error(`no platform module ${name}`)
      return platform[name]
    },
  })
  return module.exports
}

const { TriggerCell } = await load('cells.js')
const said = (text, source) => ({ type: 'user/message', data: { turn: 1, source, content: [{ type: 'text', text }] } })

test('a kickoff line is hidden in the earlier parts and in the current part (#698)', () => {
  const kickoff = said('[Bot team setup]\nhi', { kind: 'bot', role: 'kickoff' })
  assert.deepEqual(historyEntry(kickoff, false), { answer: false, who: 'bot', text: '', keepAnswers: false })
  const roster = { bots: [], byId: {}, exchangeTurns: {}, roomsById: {} }
  const draw = node => TriggerCell({
    node,
    sessionId: 'writer',
    useRoster: select => select(roster),
    useSessions: select => select({ byId: {}, projectionsBySession: {} }),
    useTurnClock: select => select({}),
    useUi: select => select({}),
    actions: { noteTurnPeer() {} },
  })
  assert.equal(draw(kickoff), null, 'the setup prompt is not a message the parent Bot sent')
  // A line another Bot really sent still shows in both paths.
  const reply = said('[Reply from W]\nok', { kind: 'bot', role: 'reply' })
  assert.equal(historyEntry(reply, false).text, '[Reply from W]\nok')
  assert.notEqual(draw(reply), null, 'a real Bot line is still drawn')
})
