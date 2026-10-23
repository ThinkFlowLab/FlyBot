import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// #818: an entry whose component renders null leaves an empty `div.bt-flybot-section`, and that
// wrapper drew the sidebar separator unconditionally, so a fresh install showed two 1 px lines 8 px
// apart with nothing between them. The fix belongs to the host rule, keyed on emptiness rather than on
// the section id, so the next null-rendering section is covered too.
const { outputFiles } = await build({
  stdin: {
    contents: "export { FlyBotSections, FLYBOT_CSS } from './src/client/flybot-slots.js'",
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})

const h = (type, props, ...children) => ({ type, props: { ...props, children: children.flat() }, children: children.flat() })
class Component {
  constructor(props) { this.props = props }
}
const react = {
  createElement: h, Fragment: Symbol('F'), Component,
  useState: value => [value, () => {}], useEffect() {}, useLayoutEffect() {}, useMemo: fn => fn(), useRef: value => ({ current: value }), useCallback: fn => fn(),
}

// A slot registry as narrow as the host needs it: the section list, a subscribe that never fires in a
// render, and a version.
const slotsOf = entries => ({ entries: () => entries, subscribe: () => () => {}, version: () => 0 })

const load = (entries = []) => {
  const module = { exports: {} }
  runInNewContext(outputFiles[0].text, {
    module, exports: module.exports, console, __flybot__: { slots: slotsOf(entries) },
    require: (name) => {
      if (name === 'react') return react
      if (name === 'react-dom') return { createPortal: node => node }
      if (name === '@deepseek-ai/dsh-client-ui-primitives') return {}
      throw new Error(`Unexpected platform module ${name}`)
    },
  })
  return module.exports
}

const expand = (node) => {
  if (node === null || node === undefined || typeof node === 'boolean') return null
  if (Array.isArray(node)) return node.map(expand)
  if (typeof node !== 'object') return node
  if (typeof node.type === 'function') {
    if (node.type.prototype instanceof Component) return expand(new node.type(node.props).render())
    return expand(node.type(node.props))
  }
  return { type: node.type, props: { ...node.props, children: node.children.map(expand) } }
}
const all = (node, out = []) => {
  if (node && typeof node === 'object') {
    if (Array.isArray(node)) node.forEach(child => all(child, out))
    else { out.push(node); all(node.props?.children, out) }
  }
  return out
}
const empty = value => value === null || value === undefined || (Array.isArray(value) && value.every(empty))
const nullSection = id => ({ id, order: 0, component: () => null })
const render = entries => expand(load(entries).FlyBotSections({ roster: { bots: [] }, actions: { flybotSlotEntries: () => [] }, renderBot: () => null }))

test('#818: the slot host leaves the wrapper empty for a section that renders null', () => {
  const tree = render([nullSection('flybot-tree-archived'), nullSection('flybot-tree-reorg')])
  const wrappers = all(tree).filter(node => node.props?.className === 'bt-flybot-section')
  assert.equal(wrappers.length, 2)
  for (const wrapper of wrappers) {
    assert.ok(empty(wrapper.props.children), `${wrapper.props['data-flybot']} draws a wrapper with nothing in it`)
  }
})

test('#818: an empty wrapper draws no separator, and a section with content keeps it', () => {
  // The rule keys on emptiness: the same class keeps its border, margin and padding as soon as the
  // wrapper has a child, so a section that renders content is untouched.
  const { FLYBOT_CSS } = load([])
  const rule = FLYBOT_CSS.match(/\.bt-flybot-section:empty\s*\{([^}]*)\}/)
  assert.ok(rule, 'an :empty rule exists for the slot wrapper')
  for (const property of ['margin-top: 0', 'border-top: 0', 'padding-top: 0']) {
    assert.ok(rule[1].includes(property), `the :empty rule zeroes ${property}`)
  }
  assert.doesNotMatch(rule[0], /data-flybot|flybot-tree-archived/, 'the rule is keyed on emptiness, not on a section id')
  const base = FLYBOT_CSS.match(/\n\.bt-flybot-section\s*\{([^}]*)\}/)
  assert.ok(base, 'the base rule still styles a section with content')
  for (const property of ['margin-top: 8px', 'border-top: 1px solid', 'padding-top: 6px']) {
    assert.ok(base[1].includes(property), `the base rule keeps ${property}`)
  }
})

test('#818: the host still draws a wrapper for a section that has rows', () => {
  const tree = render([{
    id: 'flybot-tree-archived',
    order: 88,
    component: () => h('section', { className: 'flybot-tree-archived' }, h('span', null, 'Archived (1)')),
  }])
  const wrapper = all(tree).find(node => node.props?.className === 'bt-flybot-section')
  assert.equal(empty(wrapper.props.children), false, 'a section with content is not emptied out')
  assert.ok(all(tree).some(node => node.props?.className === 'flybot-tree-archived'))
})
