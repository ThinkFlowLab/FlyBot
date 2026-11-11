// The Bot-exchange sheet is a read surface: a stored line reaches it with its routing still on it —
// a leading `Chief → 助手` trace and an `<untrusted-message …>` fence — and a person must see and
// copy the words only. A reply is not one line: the paragraph breaks are content and stay (#<issue>).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

const bundle = async () => {
  const { build } = await import('esbuild')
  const { outputFiles } = await build({
    stdin: {
      contents: "export { ExchangeLine, exchangeText } from './src/client/exchange.js'",
      resolveDir: fileURLToPath(new URL('..', import.meta.url)),
    },
    bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
    external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
  })
  const h = (type, props, ...children) => ({ type, props: { ...props, children } })
  const state = []
  let hook = 0
  const react = {
    createElement: h,
    Fragment: Symbol('Fragment'),
    useEffect: () => {},
    useLayoutEffect: () => {},
    useState: (initial) => {
      const index = hook++
      if (!(index in state)) state[index] = typeof initial === 'function' ? initial() : initial
      return [state[index], value => { state[index] = typeof value === 'function' ? value(state[index]) : value }]
    },
    useRef: (current) => { const index = hook++; return (state[index] ??= { current }) },
    useId: () => 'id',
  }
  const written = []
  const displayed = []
  const module = { exports: {} }
  runInNewContext(outputFiles[0].text, {
    module, exports: module.exports,
    document: { hidden: false, body: {} },
    window: { innerWidth: 1200, innerHeight: 800, addEventListener() {}, removeEventListener() {} },
    navigator: { clipboard: { writeText: text => { written.push(text); return Promise.resolve() } } },
    setTimeout: () => 0, clearTimeout: () => {}, URL, Blob,
    require: (name) => {
      if (name === 'react') return react
      if (name === 'react-dom') return { createPortal: node => node }
      if (name === '@deepseek-ai/dsh-client-ui-primitives') return { MarkdownText: function MarkdownText({ text }) { displayed.push(text); return text } }
      throw new Error(`Unexpected platform module ${name}`)
    },
  })
  const expand = (node) => {
    if (node === null || node === undefined || typeof node === 'boolean') return null
    if (Array.isArray(node)) return node.map(expand)
    if (typeof node !== 'object') return node
    if (typeof node.type === 'function') return expand(node.type(node.props))
    return { ...node, props: { ...node.props, children: expand(node.props.children) } }
  }
  const render = (props) => { hook = 0; return expand(module.exports.ExchangeLine(props)) }
  return { ...module.exports, render, written, displayed }
}

const walk = (node, visit) => {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) { for (const child of node) walk(child, visit); return }
  visit(node)
  walk(node.props?.children, visit)
}
const byLabel = (tree, label) => {
  let found
  walk(tree, node => { if (!found && node.props?.['aria-label'] === label) found = node })
  return found
}
const byText = (tree, label) => {
  let found
  walk(tree, node => {
    const children = node.props?.children
    if (!found && Array.isArray(children) && children.includes(label)) found = node
  })
  return found
}

const chief = { id: 'chief', name: 'Chief', color: 'green' }
const assistant = { id: 'assistant', name: '助手', color: 'gray' }
const roster = { bots: [chief, assistant], byId: { chief, assistant } }
const row = (text) => ({ entry: { id: 'e1', from: 'chief', time: 1, text }, roster, actions: {} })

test('exchangeText reads a stored line: no trace, no fence, and the paragraph breaks stay', async () => {
  const { exchangeText } = await bundle()
  // A trace on its own first line is routing the tree prompt asked for.
  assert.equal(exchangeText('Chief → 助手\n\nB kick test 4 > hello', ['Chief', '助手']), 'B kick test 4 > hello')
  // A complete wrap: the marker is format, the inner text is the message.
  assert.equal(exchangeText('<untrusted-message from="User">\nfirst\n\nsecond\n</untrusted-message>'), 'first\n\nsecond')
  // Fragments of a fence an older write left behind.
  assert.equal(exchangeText('from="User"> a stored line'), 'a stored line')
  assert.equal(exchangeText('a stored line </untrusted-message'), 'a stored line')
  // A plain reply keeps its bytes, line breaks included — never folded to one line.
  assert.equal(exchangeText('one\n\ntwo\n\nthree'), 'one\n\ntwo\n\nthree')
  assert.equal(exchangeText('plain words\nsecond line'), 'plain words\nsecond line')
})

test('the row shows the words, and the copy path copies exactly what it shows', async () => {
  const { render, written, displayed } = await bundle()
  const stored = '<untrusted-message from="User">\nChief → 助手\n\nfirst para\n\nsecond para\n</untrusted-message>'
  const tree = render(row(stored))
  const shown = displayed[0]
  assert.equal(shown, 'first para\n\nsecond para')
  assert.match(shown, /first para\n\nsecond para/, 'the paragraph break survives the read')
  assert.doesNotMatch(shown, /<untrusted|from="|Chief → /)

  // The Copy item in the message tools writes that same string to the clipboard.
  byLabel(tree, 'More message actions').props.onClick({ currentTarget: { getBoundingClientRect: () => ({ left: 0, top: 0, right: 10, bottom: 10, width: 10, height: 10 }) } })
  const menu = render(row(stored))
  byText(menu, 'Copy').props.onClick()
  assert.deepEqual(written, ['first para\n\nsecond para'])
})
