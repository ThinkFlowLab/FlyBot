import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// Test connection (#409), client side: the copy for each outcome and the row's
// billing note. The request itself is a stub; nothing reaches a model.
const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/model-test.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'node', write: false,
  external: ['react', 'react-dom'],
})
const module = { exports: {} }
runInNewContext(bundle.outputFiles[0].text, {
  module, exports: module.exports,
  require: (name) => {
    if (name === 'react') {
      return {
        createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
        useState: initial => [initial, () => {}],
        useEffect: () => {},
        useRef: initial => ({ current: initial }),
      }
    }
    throw new Error(`no platform module ${name}`)
  },
})
const { ModelTestRow } = module.exports
// Copied into this realm, so deepEqual compares values, not the vm's prototypes.
const testOutcome = (...args) => ({ ...module.exports.testOutcome(...args) })

const textOf = node => (node === null || node === undefined || node === false ? '' : typeof node !== 'object' ? String(node) : node.children.map(textOf).join(' '))
const find = (node, match) => {
  if (node === null || typeof node !== 'object') return undefined
  if (match(node)) return node
  for (const child of node.children) {
    const found = find(child, match)
    if (found) return found
  }
  return undefined
}

test('a passing test names the model and how long it took', () => {
  assert.deepEqual(testOutcome({ ok: true, ref: 'p/m', ms: 1234 }, 'Kimi K3'), { ok: true, text: 'Works. Kimi K3 answered in 1.2 s.' })
  assert.deepEqual(testOutcome({ ok: true }, 'Kimi K3'), { ok: true, text: 'Works. Kimi K3 answered.' })
})

test('each failure code reads as a short, actionable reason, and an unknown code stays generic', () => {
  assert.match(testOutcome({ ok: false, code: 'AUTH' }).text, /API key was rejected/)
  assert.match(testOutcome({ ok: false, code: 'NO_KEY' }).text, /no API key yet/)
  assert.match(testOutcome({ ok: false, code: 'TRANSPORT' }).text, /endpoint/)
  assert.match(testOutcome({ ok: false, code: 'MODEL_NOT_FOUND' }).text, /model name/)
  assert.match(testOutcome({ ok: false, code: 'TIMEOUT' }).text, /30 seconds/)
  assert.match(testOutcome({ ok: false, code: 'RATE_LIMIT' }).text, /Too many requests/)
  assert.deepEqual(testOutcome({ ok: false, code: 'sk-secret-<b>' }), { ok: false, code: 'UNKNOWN', text: 'The test failed.' })
})

test('the row offers Test connection and says the request may be billed', () => {
  const row = ModelTestRow({ bot: { id: 'b1', model: 'p/m' }, modelName: 'M', test: async () => ({ ok: true }) })
  assert.match(textOf(row), /may be billed/)
  const button = find(row, node => node.type === 'button')
  assert.equal(textOf(button).trim(), 'Test connection')
  assert.equal(button.props.disabled, false)
  assert.equal(find(row, node => node.props?.role === 'status')?.props['aria-live'], 'polite')
})
