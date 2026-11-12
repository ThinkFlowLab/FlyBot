// #2869: once the host reports `installed` (#2868), Settings → Plugins has to draw it — an ON
// switch still describes a plugin that is not in this profile, so the owner cannot tell a
// package that is here from one that was never installed. A Project whose record carries a
// failed `chief` is the other half: the host writes `chief.error` and nothing ever showed it.
// These cases draw the views the way the browser does (esbuild bundle + the same hook shim the
// other client tests use) and read the text and the switches back out of the element tree.
// The Project surfaces themselves are gated by `projectPresent()` (#2877), so this file does
// not draw a Projects page for a missing plugin: that answer removes the page instead.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const { outputFiles } = await build({
  stdin: {
    contents: "export { PluginsView, ProjectsList } from './src/client/settings.js'",
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})

const h = (type, props, ...children) => ({ type, props: { ...props, children: children.flat(Infinity) } })
// One hook index per draw; the views below are pure, but the shared pieces they nest may use one.
let slots = []
let index = 0
const react = {
  createElement: h, Component: class {}, Fragment: Symbol('F'),
  useMemo: (fn) => { const at = index++; if (!(at in slots)) slots[at] = fn(); return slots[at] },
  useState: (initial) => {
    const at = index++
    if (!(at in slots)) slots[at] = typeof initial === 'function' ? initial() : initial
    return [slots[at], (value) => { slots[at] = typeof value === 'function' ? value(slots[at]) : value }]
  },
  useCallback: (fn) => { const at = index++; if (!(at in slots)) slots[at] = fn; return slots[at] },
  useRef: (value) => { const at = index++; if (!(at in slots)) slots[at] = { current: value }; return slots[at] },
  useEffect: (fn) => { const at = index++; if (!(at in slots)) slots[at] = fn },
  useLayoutEffect() {},
  useId: () => 'id',
  useSyncExternalStore: (_subscribe, get) => get(),
}
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports, console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {},
  requestAnimationFrame: () => 0, cancelAnimationFrame() {},
  document: { hidden: false, addEventListener() {}, removeEventListener() {}, createElement: () => ({ getContext: () => ({}) }) },
  navigator: { language: 'en' },
  localStorage: { getItem: () => null, setItem() {} },
  window: { location: { hash: '' }, addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) },
  require: (name) => {
    if (name === 'react') return react
    if (name === 'react-dom') return { createPortal: node => node }
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return {}
    throw new Error(`Unexpected platform module ${name}`)
  },
})
const { PluginsView, ProjectsList } = module.exports

const draw = (node, out = [], depth = 0) => {
  if (Array.isArray(node)) { for (const item of node) draw(item, out, depth); return out }
  if (!node || typeof node !== 'object') return out
  if (typeof node.type === 'function' && depth < 8) {
    const saved = slots
    const savedIndex = index
    slots = []
    index = 0
    let rendered
    try { rendered = node.type({ ...node.props }) } catch { out.push(node); slots = saved; index = savedIndex; return out }
    slots = saved
    index = savedIndex
    return draw(rendered, out, depth + 1)
  }
  out.push(node)
  draw(node.props?.children, out, depth)
  return out
}
const text = (node) => {
  if (Array.isArray(node)) return node.map(text).join('')
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (node && typeof node === 'object') return text(node.props?.children)
  return ''
}
const byClass = (nodes, name) => nodes.filter(node => typeof node.props?.className === 'string' && node.props.className.split(' ').includes(name))
const switches = nodes => nodes.filter(node => node?.props?.role === 'switch')

const roster = { bots: [], rooms: [], prefs: {}, models: [], readOnly: '' }
const plugin = over => ({ id: 'project', name: 'Project', package: '@flybot/project', purpose: 'Run a Project.', enabled: true, installed: true, ...over })

test('a plugin the profile does not have is drawn as not installed, with no switch (#2869)', () => {
  const nodes = draw(PluginsView({
    answer: {
      plugins: [
        plugin({ installed: false }),
        plugin({ id: 'tree', name: 'Tree', package: '@flybot/tree', purpose: 'Run Bots as a tree.', installed: true }),
      ],
    },
  }))
  const page = text(nodes)
  assert.match(page, /Not installed in this profile/)
  // #2926: DSH refuses `dsh plugin add` on its own (`error: required option '--profile <name>'
  // not specified`), so the row has to name the profile too. #2931: it must be the profile this
  // runtime is in, not the `web` #2928 guessed — profiles/desktop is a sibling of profiles/web.
  // A host that answers no profile gets the literal placeholder, never a made-up `web`.
  assert.match(page, /dsh plugin --profile <profile> add @flybot\/project/)
  assert.doesNotMatch(page, /dsh plugin add /, 'the command never leaves the profile out')
  assert.doesNotMatch(page, /--profile web/, 'a host with no profile is not the web profile')
  assert.equal(switches(nodes).length, 1, 'only the installed plugin draws a switch')
  assert.equal(switches(nodes)[0].props['aria-checked'], true)
  const missing = nodes.find(node => node?.props?.['data-plugin'] === 'project')
  assert.equal(missing?.props?.['data-installed'], 'false')
})

test('the install command names the profile the host answered, never a guessed one (#2931)', () => {
  const command = profile => text(draw(PluginsView({ answer: { profile, plugins: [plugin({ installed: false })] } })))
  assert.match(command('deskprobe'), /dsh plugin --profile deskprobe add @flybot\/project/)
  assert.match(command('web'), /dsh plugin --profile web add @flybot\/project/)
  assert.notEqual(command('deskprobe'), command('web'), 'two profiles draw two different commands')
})

test('a plugin the profile has keeps today\'s switch (#2869)', () => {
  const nodes = draw(PluginsView({ answer: { plugins: [plugin({ installed: true, enabled: false })] } }))
  assert.doesNotMatch(text(nodes), /Not installed in this profile/)
  const [toggle] = switches(nodes)
  assert.equal(toggle?.props['aria-checked'], false, 'the switch still reports the stored answer')
})

test('a host that cannot say whether a package is installed keeps the switch (#2869)', () => {
  const nodes = draw(PluginsView({ answer: { plugins: [{ ...plugin(), installed: undefined }] } }))
  assert.doesNotMatch(text(nodes), /Not installed in this profile/)
  assert.equal(switches(nodes).length, 1, 'no answer is not the same as "not installed"')
})

test('a project whose Chief failed shows the host\'s error (#2869)', () => {
  slots = []
  index = 0
  const nodes = draw(ProjectsList({
    roster,
    projects: [{ id: 'p1', name: 'Website', chief: { error: 'this host has no Project Chief seam, so no Chief was created' } }],
    call: () => Promise.resolve({}),
  }))
  assert.match(text(nodes), /no Project Chief seam/)
  assert.equal(byClass(nodes, 'bt-project-chief-error').length, 1)
})

test('a project whose Chief was created draws no error line (#2869)', () => {
  const nodes = draw(ProjectsList({
    roster,
    projects: [{ id: 'p1', name: 'Website', chief: { name: 'Website Chief' } }],
    call: () => Promise.resolve({}),
  }))
  assert.equal(byClass(nodes, 'bt-project-chief-error').length, 0)
})
