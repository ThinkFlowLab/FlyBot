import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// #2972: the "Scheduled task:" and "Update" lines show text a person wrote, and they cut it at 80.
// A UTF-16 slice cut through an emoji at that bound (the line then ended in a lone surrogate, which
// renders as U+FFFD) and dropped the rest without a `…`, so two prompts that differ only after the
// bound drew the same line. The cut is now by code point and always marked.

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
const roster = { bots: [], byId: {}, exchangeTurns: {}, roomsById: {} }
const trigger = (text, source) => ({ type: 'user/message', data: { turn: 1, source, content: [{ type: 'text', text }] } })
const draw = node => TriggerCell({
  node,
  sessionId: 'writer',
  useRoster: select => select(roster),
  useSessions: select => select({ byId: {}, projectionsBySession: {} }),
  useTurnClock: select => select({}),
  useUi: select => select({}),
  actions: { noteTurnPeer() {} },
})
const line = node => draw(node)?.children.join('')
// A lone surrogate is a code point in Cs and renders as U+FFFD.
const loneSurrogate = value => /\p{Cs}/u.test(value)
const scheduleOf = prompt => trigger(`reminder_prompt_json: ${JSON.stringify(prompt)}`, { kind: 'schedule' })

test('a Scheduled task line keeps the emoji at the bound whole and marks the cut (#2972)', () => {
  // Both prompts are the same through UTF-16 unit 79; the first then starts an emoji at the bound.
  const withEmoji = line(scheduleOf('x'.repeat(79) + '📌 先看客户那封'))
  const plain = line(scheduleOf('x'.repeat(79) + '再看财务那封'))
  assert.equal(loneSurrogate(withEmoji), false, 'the emoji is not cut in half: no lone surrogate reaches the line')
  assert.equal(loneSurrogate(plain), false, 'the plain prompt has no lone surrogate either')
  assert.ok(withEmoji.includes('📌'), 'the whole emoji is kept at the bound')
  assert.ok(withEmoji.endsWith('…'), 'the dropped tail is marked')
  assert.ok(plain.endsWith('…'), 'the dropped tail is marked')
  assert.notEqual(withEmoji, plain, 'two prompts that differ only after the bound still draw two different lines')
})

test('a batched Scheduled task line marks where it cut instead of ending in a silent fragment (#2972)', () => {
  const first = 'a'.repeat(60)
  const second = 'b'.repeat(60)
  const drawn = line(trigger(`reminders_json: ${JSON.stringify([{ reminder_prompt: first }, { reminder_prompt: second }])}`, { kind: 'schedule' }))
  assert.ok(drawn.includes(`${first} · `), 'the first prompt stays whole, and the join is kept')
  assert.ok(drawn.endsWith('…'), 'the cut through the second prompt is marked')
  assert.ok(drawn.length < first.length + second.length + 20, 'the line is still bounded')
})

test('an Update line keeps the emoji at the bound whole, marks the cut, and leaves short text alone (#2972)', () => {
  const drawn = line(trigger('y'.repeat(79) + '📌 tail', { kind: 'user' }))
  assert.ok(drawn.includes('📌'), 'the whole emoji is kept at the bound')
  assert.equal(loneSurrogate(drawn), false, 'no lone surrogate reaches the line')
  assert.ok(drawn.endsWith('…'), 'the dropped tail is marked')
  assert.equal(line(trigger('short update', { kind: 'user' })), 'short update', 'text that fits is untouched — no `…`')
})
