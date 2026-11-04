// #2302: Settings → Feedback offered Clear in a read-only window, and Clear truncates the shared
// `<home>/logs/diagnostics.jsonl` — the evidence a bug report is supposed to carry. The page now
// takes the roster the way the other locked screens do and draws no Clear while the window only
// reads; a writable window keeps it.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/feedback.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'node', write: false,
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const module = { exports: {} }
const effects = []
runInNewContext(bundle.outputFiles[0].text, {
  module, exports: module.exports, setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {}, Date, Promise,
  URL: { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} },
  require: (name) => {
    const platform = {
      react: {
        createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
        useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
        useEffect: fn => { effects.push(fn) }, useLayoutEffect: () => {}, useRef: current => ({ current }), useCallback: fn => fn, useMemo: fn => fn(), Fragment: 'fragment',
      },
      'react-dom': {},
      '@deepseek-ai/dsh-client-ui-primitives': {},
    }
    if (!(name in platform)) throw new Error(`no platform module ${name}`)
    return platform[name]
  },
})
const { FeedbackPage } = module.exports

const OWN = new Set(['Section', 'Row'])
const expand = (node) => {
  if (Array.isArray(node)) return node.flatMap(expand)
  if (node === null || typeof node !== 'object') return node
  if (OWN.has(node.type)) return expand(node.type({ ...node.props, children: node.children }))
  return { ...node, children: (node.children ?? []).flatMap(expand) }
}
const Section = ({ children }) => ({ type: 'Section', props: {}, children })
const Row = ({ children }) => ({ type: 'Row', props: {}, children })
const labels = (node, out = []) => {
  if (Array.isArray(node)) { node.forEach(item => labels(item, out)); return out }
  if (node === null || typeof node !== 'object') return out
  if (node.type === 'button' && typeof node.children?.[0] === 'string') out.push(node.children[0])
  labels(node.children, out)
  return out
}
const actions = {
  diagnostics: () => Promise.resolve({ entries: [], total: 0, markdown: '' }),
  diagnosticsClear: () => Promise.resolve({ ok: true }),
}
const draw = roster => labels(expand(FeedbackPage({ actions, run: () => undefined, Section, Row, roster })))

test('#2302: a read-only window draws no Clear in Settings → Feedback', () => {
  const locked = draw({ readOnly: 'The Bot team in this folder is open in another dsh window.' })
  assert.equal(locked.includes('Clear'), false, `a read-only window offers no Clear: ${locked.join(' | ')}`)
  assert.equal(locked.includes('Download'), true, 'Download is still a read')
})

test('#2302: a writable window keeps Clear', () => {
  for (const roster of [{ readOnly: '' }, { readOnly: '   ' }, {}]) {
    assert.equal(draw(roster).includes('Clear'), true, `a writable window keeps Clear (${JSON.stringify(roster)})`)
  }
})
