// A refused write in Settings: the sentence the host sends back is the only thing that
// tells a person why the switch did not move, and it was drawn as the first child of the page's
// scrolling area. After scrolling to the card that was pressed the refusal lands above the
// viewport, so the window looks like it ignored the click. It belongs outside that scroll box.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const { outputFiles } = await build({
  stdin: {
    contents: [
      "export { SettingsDialog } from './src/client/settings.js'",
      "export { CapabilitiesPage } from './src/client/capability-settings.js'",
      "export { hostText, installLocale } from './src/client/i18n.js'",
    ].join('\n'),
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const h = (type, props, ...children) => ({ type, props: { ...props, children: children.flat(Infinity) } })
// A hook runtime that survives a re-render, so a pressed control can answer and the dialog can
// be drawn again with the refusal it stored.
let slots = []
let index = 0
let effects = []
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
  useEffect: (fn) => { const at = index++; if (!(at in slots)) { slots[at] = true; effects.push(fn) } },
  useLayoutEffect() {},
  useSyncExternalStore: (_subscribe, get) => get(),
}
const win = { location: { hash: '' }, addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) }
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports, console, setTimeout, clearTimeout, requestAnimationFrame: () => 0, cancelAnimationFrame() {},
  document: { hidden: false, addEventListener() {}, removeEventListener() {} },
  navigator: { language: 'en' },
  localStorage: { getItem: () => null, setItem() {} },
  window: win,
  require: (name) => {
    if (name === 'react') return react
    if (name === 'react-dom') return { createPortal: node => node }
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return {}
    throw new Error(`Unexpected platform module ${name}`)
  },
})
const { SettingsDialog, CapabilitiesPage, hostText, installLocale } = module.exports

const render = (component, props) => { index = 0; return component(props) }
const flush = async () => {
  const queued = effects
  effects = []
  for (const fn of queued) await fn()
  await new Promise(resolve => setTimeout(resolve, 0))
}
const all = (node, out = []) => {
  if (Array.isArray(node)) { for (const item of node) all(item, out); return out }
  if (node && typeof node === 'object') { out.push(node); all(node.props?.children, out) }
  return out
}
const text = (node) => {
  if (Array.isArray(node)) return node.map(text).join('')
  if (typeof node === 'string') return node
  if (node && typeof node === 'object') return text(node.props?.children)
  return ''
}
const inside = (target, root) => all(root).some(node => node === target)

const bot = { id: 'a', name: 'Chief', pinned: false, hidden: false, model: '', instructions: '', workDir: '' }
const roster = { bots: [bot], rooms: [], byId: { a: bot }, roomsById: {}, prefs: {}, mainBotIds: ['a'], connectors: [], memory: false }
const REFUSAL = 'This window shows the team but cannot change it.'
const actions = { openSettings() {}, closeSettings() {}, setFlags: () => Promise.reject(new Error(REFUSAL)) }

test('a refused write in Settings stays in view instead of scrolling away with the page (#2194)', async () => {
  const props = { page: 'bots', id: 'a', roster, actions, useUpdate: () => ({}) }
  let tree = render(SettingsDialog, props)
  // The form the dialog draws for this Bot is what hands a failed write back through the dialog's
  // own `run`, so a rejection here is the same path a pressed switch takes.
  const form = all(tree).find(node => node?.props?.roster === roster && node?.props?.bot === bot && typeof node.props.run === 'function')
  assert.ok(form, 'the page is the Bot form, which reports through the dialog')
  form.props.run(Promise.reject(new Error(REFUSAL)))
  await flush()
  tree = render(SettingsDialog, props)
  const nodes = all(tree)
  const alert = nodes.find(node => node.props?.role === 'alert')
  assert.ok(alert, 'the refusal is on screen')
  assert.equal(text(alert), REFUSAL)
  const scrolling = nodes.find(node => typeof node.props?.className === 'string' && node.props.className.includes('bt-settings-scroll'))
  assert.ok(scrolling, 'the page is the scrolling box under the dialog heading')
  assert.equal(inside(alert, scrolling), false, 'the refusal must sit outside the scrolling page, not above it')
})

// #3114 cut 31: the Capabilities form and the fixed refusals its save can leave. The page
// already draws `t(label)` (capability-settings.js:19) and the host sentence is translated before it
// is thrown (api.js:38), so the dictionary is the only place these cases can be red.
const REFUSALS = [
  ['Use a capability name with lowercase letters, digits, and single hyphens; "github" and "composio" are reserved.',
    '能力名只能用小写字母、数字和单个连字符；「github」和「composio」是保留名。'],
  ['Enter a command for the MCP server.', '请填写 MCP 服务器的命令。'],
  ['Enter a valid HTTP or HTTPS URL.', '请填写有效的 HTTP 或 HTTPS 地址。'],
  // #3273: the seventh refusal, from the security read at 6b401ebb.
  ['Enter the URL without a username or password. Save the credential as a secret and reference it in a header.',
    '地址里不要写用户名或密码。请把凭据保存为密钥，并在请求头里引用它。'],
  ['A capability cannot change its kind. Delete it and save a new one.', '能力类型不能改。请删掉它，再新建一个。'],
  ['Environment variables must contain text values.', '环境变量里只能填文本值。'],
  ['Headers must contain text values.', '请求头里只能填文本值。'],
]

const fakeLocale = (active) => {
  const dicts = new Map()
  return {
    register: (ns, locale, dict) => { dicts.set(`${ns}:${locale}`, dict); return () => dicts.delete(`${ns}:${locale}`) },
    bind: ns => (key, params) => {
      const text = (active === 'zh' ? dicts.get(`${ns}:zh`)?.[key] : undefined) ?? key
      return params ? text.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match)) : text
    },
    getLocale: () => ({ active }),
  }
}

// The locale service is global to the bundled i18n module: open the window, then close it again.
const inLang = async (active, body) => {
  const off = installLocale(fakeLocale(active))
  try { await body() } finally { off() }
}

// A fresh hook board for the component under test, so one case cannot read the last one's state.
const expand = (component, props) => { slots = []; index = 0; effects = []; return render(component, props) }

// A field is a component: its label is on screen only once the field itself is drawn.
const nameOf = (root, label) => all(root)
  .filter(node => typeof node?.type === 'function' && typeof node?.props?.label === 'string').some(node => text(node.type(node.props)) === label)

const capabilityProps = (saveCapability) => ({
  roster: { ...roster, capabilities: [] },
  actions: { saveCapability, deleteCapability: async () => {}, approveCapability: async () => {} },
  run: () => {},
})

// React is handed the form as a component, and this harness draws only what a test names: press
// Add capability, take the node the page drew, and draw that component by hand.
const capabilityForm = (saveCapability) => {
  const props = capabilityProps(saveCapability)
  const add = all(expand(CapabilitiesPage, props)).find(node => node?.props?.onClick)
  assert.ok(add, 'the page draws its Add capability button')
  add.props.onClick()
  const opened = all(render(CapabilitiesPage, props)).find(node => node?.props?.draft && typeof node.props.setDraft === 'function')
  assert.ok(opened, 'Add capability opens the form')
  return opened
}

// A save the host refused. api.js:38 translates the host's sentence before it throws, so the stub
// does the same and the form draws what it drew in the window: the refusal, not the raw host text.
const refusedForm = async (raw) => {
  const opened = capabilityForm(async () => { throw new Error(hostText(raw)) })
  const form = all(expand(opened.type, opened.props)).find(node => node?.type === 'form')
  assert.ok(form, 'the form draws itself')
  await form.props.onSubmit({ preventDefault() {} })
  const alert = all(render(opened.type, opened.props)).find(node => node?.props?.role === 'alert')
  return alert ? text(alert) : ''
}

test('#3114 cut 31: a zh window reads the capability form labels in Chinese', async () => {
  await inLang('zh', async () => {
    const opened = capabilityForm(async () => {})
    const tree = expand(opened.type, opened.props)
    assert.equal(nameOf(tree, '描述'), true, 'the Description label is a Chinese word')
    assert.equal(nameOf(tree, '参数（每行一个）'), true, 'the rest of the form reads Chinese too')
    assert.equal(nameOf(tree, 'Description'), false, 'no English Description label is left')
  })
})

test('#3114 cut 31: a zh window reads every fixed host refusal on the form in Chinese', async () => {
  await inLang('zh', async () => {
    for (const [raw, chinese] of REFUSALS) {
      assert.equal(await refusedForm(raw), chinese, `"${raw}" reads Chinese where the host wrote it`)
    }
  })
})

test('#3114 cut 31: an English window reads the same form and the same refusals unchanged', async () => {
  const opened = capabilityForm(async () => {})
  const tree = expand(opened.type, opened.props)
  assert.equal(nameOf(tree, 'Description'), true, 'the Description label is still English')
  assert.equal(nameOf(tree, 'Arguments (one per line)'), true, 'the rest of the form is still English')
  for (const [raw] of REFUSALS) {
    assert.equal(hostText(raw), raw, `"${raw}" is untouched without a zh window`)
    assert.equal(await refusedForm(raw), raw, `"${raw}" draws exactly as the host wrote it`)
  }
})

// #3114 cut 33: a pack refusal names the child capability that is gone; the name is data and is copied untouched.
test('#3114 cut 33: a zh window reads the pack refusal with the child name untouched', async () => {
  await inLang('zh', async () => {
    assert.equal(await refusedForm('Packs can include only saved MCP servers and skills. web-search is not one.'),
      '能力包里只能放已保存的 MCP 服务和技能；web-search 不是其中之一。')
    assert.equal(await refusedForm('Packs can include only saved MCP servers and skills. 报告.2026 is not one.'),
      '能力包里只能放已保存的 MCP 服务和技能；报告.2026 不是其中之一。')
  })
})

// #3114 cut 33: the two refusals a stale row leaves on the same page (another window, or a Bot's own delete_capability), which land in the dialog's own `run`.
test('#3114 cut 33: a zh window reads the stale-row capability refusals where the dialog shows them', async () => {
  await inLang('zh', async () => {
    const props = { page: 'capabilities', roster, actions, useUpdate: () => ({}) }
    let tree = expand(SettingsDialog, props)
    const page = all(tree).find(node => node?.type === CapabilitiesPage)
    assert.ok(page, 'the dialog draws the Capabilities page')
    for (const [raw, chinese] of [
      ['No capability named web-search.', '找不到叫 web-search 的能力。'],
      ['No unapproved stdio MCP named web-search.', '找不到叫 web-search 的待批准 stdio MCP 服务。'],
    ]) {
      // api.js translated the host sentence before it threw, so the stub hands over what it threw.
      page.props.run(Promise.reject(new Error(hostText(raw))))
      await flush()
      tree = render(SettingsDialog, props)
      const alert = all(tree).find(node => node?.props?.role === 'alert')
      assert.ok(alert, `"${raw}" is on screen`)
      assert.equal(text(alert), chinese)
    }
  })
})
