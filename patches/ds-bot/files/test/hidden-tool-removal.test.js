import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// ContextCell lives next to ToolCell; bundle it the same way so the DSH
// "Tool removed: ask_user_question" hide can be checked without a browser.
const { outputFiles } = await build({
  stdin: {
    contents: "export { ContextCell, isHiddenToolRemoval, HIDDEN_REMOVED_TOOLS, ToolCell } from './src/client/cells.js'",
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const Fragment = Symbol('Fragment')
const h = (type, props, ...children) => ({ type, props: { ...props, children } })
const react = {
  createElement: h, Fragment,
  useEffect: () => {}, useLayoutEffect: () => {},
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useMemo: make => make(), useRef: current => ({ current }), useId: () => 'id',
}
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports,
  document: { hidden: false },
  setTimeout: () => 0, clearTimeout: () => {},
  require: (name) => {
    if (name === 'react') return react
    if (name === 'react-dom') return { createPortal: node => node }
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return { MarkdownText: ({ text }) => text }
    throw new Error(`Unexpected platform module ${name}`)
  },
})
const { ContextCell, isHiddenToolRemoval, HIDDEN_REMOVED_TOOLS, ToolCell } = module.exports

const expand = (node) => {
  if (node === null || node === undefined || typeof node === 'boolean') return null
  if (Array.isArray(node)) return node.map(expand)
  if (typeof node !== 'object') return node
  if (typeof node.type === 'function') return expand(node.type(node.props))
  return { ...node, props: { ...node.props, children: expand(node.props.children) } }
}
const text = (node) => {
  if (node === null || node === undefined) return ''
  if (Array.isArray(node)) return node.map(text).join('')
  return typeof node === 'object' ? text(node.props.children) : String(node)
}

const writer = { id: 'writer', name: 'Writer', color: 'blue' }
const chief = { id: 'chief', name: 'Chief', color: 'green' }
const roster = {
  bots: [writer, chief], byId: { writer, chief }, rooms: [], roomsById: {},
  exchangeTurns: {}, questions: {}, secretRequests: {}, secrets: [],
}
const showTool = (root) => text(expand(ToolCell({
  node: { key: 'node', data: { root }, location: { turn: { turn: 1 } } },
  sessionId: chief.id,
  useRoster: select => select(roster),
  useUi: select => select({ reactions: {}, visits: {} }),
  actions: {},
})))

test('#140: the context row hides FlyBot-removed tools, not other tool cells', () => {
  const index = readFileSync(new URL('../src/client/index.js', import.meta.url), 'utf8')
  assert.match(index, /key: 'context'/)
  assert.match(index, /ContextCell/)
  assert.equal(HIDDEN_REMOVED_TOOLS.has('ask_user_question'), true)
  const removal = toolName => ({ data: { content: [{ type: 'tool-removal', toolName }] } })
  assert.equal(isHiddenToolRemoval(removal('ask_user_question')), true)
  assert.equal(isHiddenToolRemoval(removal('bash')), false)
  assert.equal(isHiddenToolRemoval({ data: { content: [{ type: 'tool-addition', toolName: 'web_search' }] } }), false)
  assert.equal(ContextCell({ node: removal('ask_user_question') }), null)
  assert.equal(text(expand(ContextCell({ node: removal('ask_user_question') }))), '')
  assert.match(text(expand(ContextCell({ node: removal('bash') }))), /Tool removed: bash/)
  assert.match(text(expand(ContextCell({ node: { data: { content: [{ type: 'tool-addition', toolName: 'web_search' }] } } }))), /Tool added: web_search/)
  const mixed = {
    data: {
      content: [
        { type: 'tool-removal', toolName: 'ask_user_question' },
        { type: 'tool-addition', toolName: 'web_search' },
      ],
    },
  }
  assert.equal(isHiddenToolRemoval(mixed), false)
  const mixedText = text(expand(ContextCell({ node: mixed })))
  assert.match(mixedText, /Tool added: web_search/)
  assert.doesNotMatch(mixedText, /ask_user_question/)
  const native = {
    kind: 'tool-result', name: 'message_bot', callId: 'direct',
    call: { name: 'message_bot', argsRaw: JSON.stringify({ to: 'Writer' }) },
    content: [{ type: 'text', text: '' }], isError: false, subCalls: [],
  }
  assert.match(showTool(native), /Messaged.*Writer/)
})
