// #3243 (#3114 cut 29). In a Chinese window the Connectors page's Feishu row was half English: the
// card's titles and buttons were translated, but the row's own state line and the sentence under a
// refused action were the host's wording — `Could not connect: Could not reach Feishu`, and
// `Feishu addresses must start with https://` as the line itself. `hostText()` is where a host
// sentence becomes Chinese, and neither place asked it. The Composio row's two leftovers ride the
// same path: `Composio answered 422…` and `Pick up to 40 apps`. A host error's own data (host,
// status code, open_id) is not copy: it stays exactly as the host wrote it, inside Chinese words.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const { outputFiles } = await build({
  stdin: {
    contents: "export { ConnectorsPage, AppPicker } from './src/client/connectors.js'; export { DICTIONARY, hostText, installLocale } from './src/client/i18n.js'",
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})

const h = (type, props, ...children) => ({ type, props: { ...props, children } })
// One component instance's hook slots, reused by every redraw. Effects run after a render, and a
// `useState` setter redraws at once, the way React would after a click or a landed promise — so
// what the row says after an action is what the test reads.
const instance = { cursor: 0, hooks: [], pending: [], rendering: false, rerun: false, effectStates: [], effectCursor: 0 }
let root = null
let live = null
const react = {
  createElement: h,
  Fragment: Symbol('F'),
  useLayoutEffect() {},
  useEffect(effect, deps) { instance.pending.push({ effect, deps }) },
  useRef(current) { const slot = instance.hooks[instance.cursor++] ??= { current }; return slot },
  useState(initial) {
    const slot = instance.hooks[instance.cursor++] ??= { value: typeof initial === 'function' ? initial() : initial }
    const set = next => {
      const value = typeof next === 'function' ? next(slot.value) : next
      if (Object.is(value, slot.value)) return
      slot.value = value
      render()
    }
    return [slot.value, set]
  },
  useMemo(factory) { instance.cursor += 1; return factory() },
  useCallback(fn) { instance.cursor += 1; return fn },
  useSyncExternalStore(_subscribe, get) { instance.cursor += 1; return get() },
}
const render = () => {
  if (instance.rendering) { instance.rerun = true; return }
  instance.rendering = true
  do {
    instance.rerun = false
    instance.cursor = 0
    instance.pending = []
    live = root.type(root.props)
    for (const { effect, deps } of instance.pending.splice(0)) {
      const at = instance.effectCursor
      instance.effectCursor += 1
      const state = instance.effectStates[at] ??= { ran: false, cleanup: null, deps: undefined }
      const changed = !state.ran || deps === undefined || (deps.length > 0 && !deps.every((dep, index) => Object.is(dep, state.deps?.[index])))
      if (!changed) continue
      state.cleanup?.()
      state.cleanup = effect() ?? null
      state.ran = true
      state.deps = deps
    }
    instance.effectCursor = 0
  } while (instance.rerun)
  instance.rendering = false
}

const sandbox = {
  module: { exports: {} },
  exports: {},
  document: { hidden: false, addEventListener() {}, removeEventListener() {} },
  navigator: { language: 'en' },
  localStorage: { getItem: () => null, setItem() {} },
  window: { matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }) },
  setTimeout,
  clearTimeout,
  requestAnimationFrame: run => { run(); return 0 },
  cancelAnimationFrame() {},
  require: (name) => {
    if (name === 'react') return react
    if (name === 'react-dom') return { createPortal: node => node }
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return {}
    throw new Error(`Unexpected platform module ${name}`)
  },
}
sandbox.module.exports = sandbox.exports
runInNewContext(outputFiles[0].text, sandbox)
const { ConnectorsPage, AppPicker, DICTIONARY, hostText, installLocale } = sandbox.module.exports

// The DSH locale service, as the app hands it to `installLocale`.
function fakeLocale(active) {
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
const inLang = (active, run) => {
  const off = installLocale(fakeLocale(active))
  try { return run() } finally { off() }
}
// A raised action answers on a promise: the language stays bound until it lands.
const inLangAsync = async (active, run) => {
  const off = installLocale(fakeLocale(active))
  try { return await run() } finally { off() }
}

const mount = (type, props) => {
  instance.hooks = []
  instance.effectStates = []
  instance.effectCursor = 0
  root = { type, props }
  render()
  return { node: () => live }
}
const all = (node, out = []) => {
  if (Array.isArray(node)) { for (const child of node) all(child, out); return out }
  if (node && typeof node === 'object') { out.push(node); all(node.props?.children, out) }
  return out
}
const texts = (node, out = []) => {
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const child of node) texts(child, out); return out }
  if (node && typeof node === 'object') texts(node.props?.children, out)
  return out
}
const byClass = (node, className) => all(node).find(element => element.props?.className === className)
const labelOf = button => texts(button.props?.children).join('')
const buttonsOf = node => all(node).filter(element => element.type === 'button')
const buttonNamed = (node, label) => buttonsOf(node).find(button => labelOf(button) === label)
const settle = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms))

const roster = { bots: [], connectors: [], self: { memberId: 'me' } }
// `ConnectorsPage` draws one `ConnectorRow` element per connector; the row is where the hooks and
// the failure text live, so the row is what a test mounts.
const mountRow = (connector, acts) => {
  const page = ConnectorsPage({ roster: { ...roster, connectors: [connector] }, actions: acts })
  const row = all(page).find(element => typeof element.type === 'function')
  return mount(row.type, row.props)
}
const actions = () => ({ connectorRetry: () => Promise.resolve(), connectorDisconnect: () => Promise.resolve() })
const feishu = (over = {}) => ({ id: 'feishu', name: 'Feishu', kind: 'channel', mode: 'webhook', state: 'off', modes: [{ id: 'webhook', label: 'Custom bot webhook', credentials: [] }], ...over })

// Every fixed sentence this screen can show, with the Chinese it must read as. A host sentence with
// data in it is not here: it goes through one of the patterns, and its data is checked below.
const FIXED = [
  ['Could not reach Feishu', '连不上飞书'],
  ['Feishu addresses must start with https://', '飞书地址必须以 https:// 开头'],
  ['A Feishu App ID and App Secret are both needed before the long connection can dial.', '自建应用的长连接需要飞书 App ID 和 App Secret 才能拨号'],
  ['the Feishu long connection did not open', '飞书长连接没有建立'],
  ['Paste the webhook URL Feishu gave you', '请粘贴飞书给你的 webhook 地址'],
  ['Feishu did not answer in time — the test message may already be in the chat; check before connecting again', '飞书没有及时答复——测试消息可能已经发到群里；再连接前先确认一下'],
  ['Feishu is rate-limiting this webhook; try again in a minute', '飞书正在限流这个 webhook；请过一分钟再试'],
  ['Paste the App ID and App Secret Feishu gave the app', '请粘贴飞书给这个应用的 App ID 和 App Secret'],
  ['Feishu did not accept this App ID and App Secret', '飞书不接受这个 App ID 和 App Secret'],
  ['Choose how to connect Feishu first', '请先选择飞书的连接方式'],
  ['This connector has no allowed senders', '这个连接器没有允许发送的人'],
  ['Paste the open_id of the sender to allow', '请粘贴要允许的发送者 open_id'],
  ['Connect Feishu as an app first', '请先把飞书按自建应用连接'],
  ['Type a message first', '请先输入消息'],
  ['Not sent: could not reach Feishu', '没发出去：连不上飞书'],
  ['Not sent: Feishu refused the app token while sending the answer', '没发出去：发送时飞书不认这个应用 token'],
  ['Not sent: this answer has no Feishu chat to go to.', '没发出去：这条回答没有可去的飞书群。'],
  ['Not sent: connect Feishu first, so the answer has a way out.', '没发出去：请先连接飞书，回答才有出去的路。'],
  ['Connect Feishu first', '请先连接飞书'],
  ['Feishu did not answer in time — the message may already be in the chat; check before sending again', '飞书没有及时答复——消息可能已经发到群里；再发送前先确认一下'],
]

// A host sentence that carries data: the words become Chinese, the data is copied through.
const WITH_DATA = [
  ['Feishu answered 500', '飞书返回了 500', '500'],
  ['A Feishu webhook must be https on https://open.feishu.cn', '飞书 webhook 必须是 https://open.feishu.cn 上的 https 地址', 'https://open.feishu.cn'],
  ['Feishu did not accept the webhook (feishu/19024)', '飞书不接受这个 webhook（feishu/19024）', 'feishu/19024'],
  ['Not sent: Feishu refused the answer (feishu/99991663)', '没发出去：飞书拒收（feishu/99991663）', 'feishu/99991663'],
  ['Composio answered 422: the apps are wrong', 'Composio 返回了 422: the apps are wrong', '422: the apps are wrong'],
  ['Pick up to 40 apps', '最多选 40 个应用', '40'],
  ['Feishu refused the message (feishu/99991663)', '飞书拒收这条消息（feishu/99991663）', 'feishu/99991663'],
  // `connector-send` falls back to this literal when the notifier names neither an error nor a
  // reason; it is the host's data, so it is copied through inside the Chinese words.
  ['Feishu refused the message (no answer)', '飞书拒收这条消息（no answer）', 'no answer'],
]

test('#3243: every fixed Feishu row failure is a Chinese sentence in a zh window', () => {
  for (const [raw, zh] of FIXED) {
    assert.equal(DICTIONARY.zh[raw], zh, `the dictionary holds "${raw}"`)
    assert.match(zh, /[\u4e00-\u9fff]/, `"${raw}" reads Chinese, not a copied English line`)
  }
  inLang('zh', () => {
    for (const [raw, zh] of FIXED) assert.equal(hostText(raw), zh, `hostText reads "${raw}" in Chinese`)
  })
})

test('#3243: an English window reads every one of them unchanged', () => {
  inLang('en', () => {
    for (const [raw] of FIXED) assert.equal(hostText(raw), raw)
    for (const [raw] of WITH_DATA) assert.equal(hostText(raw), raw)
  })
})

test('#3243: a host sentence keeps its own data inside the Chinese words', () => {
  inLang('zh', () => {
    for (const [raw, zh, data] of WITH_DATA) {
      const read = hostText(raw)
      assert.equal(read, zh, `"${raw}" reads Chinese`)
      assert.equal(read.includes(data), true, `"${data}" is copied through, not translated`)
    }
    // The one data word that is also an adjective in the copy: open_id stays the field's name.
    assert.equal(hostText('Paste the open_id of the sender to allow').includes('open_id'), true)
  })
})

test('#3243: the Feishu row states its own failure in the window’s language', () => {
  const statusOf = connector => texts(byClass(mountRow(connector, actions()).node(), 'bt-connector-status')).join('')
  inLang('zh', () => {
    assert.equal(statusOf(feishu({ state: 'error', error: 'Could not reach Feishu' })), '连接失败：连不上飞书')
    assert.equal(statusOf(feishu({ state: 'error', error: 'Feishu addresses must start with https://' })), '连接失败：飞书地址必须以 https:// 开头')
  })
  inLang('en', () => {
    assert.equal(statusOf(feishu({ state: 'error', error: 'Could not reach Feishu' })), 'Could not connect: Could not reach Feishu')
  })
})

test('#3243: a refused action inside the row reads in the window’s language too', async () => {
  const refusing = (error) => ({
    connectorRetry: () => Promise.resolve(),
    connectorDisconnect: () => Promise.reject(new Error(error)),
    connectorSend: () => Promise.reject(new Error(error)),
  })
  await inLangAsync('zh', async () => {
    const view = mountRow(feishu({ state: 'ready' }), refusing('Could not reach Feishu'))
    buttonNamed(view.node(), '断开').props.onClick()
    await settle()
    assert.equal(texts(byClass(view.node(), 'bt-connector-error')).join(''), '连不上飞书')
  })
  await inLangAsync('en', async () => {
    const view = mountRow(feishu({ state: 'ready' }), refusing('Could not reach Feishu'))
    buttonNamed(view.node(), 'Disconnect').props.onClick()
    await settle()
    assert.equal(texts(byClass(view.node(), 'bt-connector-error')).join(''), 'Could not reach Feishu')
  })
})

test('#3243: a refused send says so in the window’s language, data untouched', async () => {
  await inLangAsync('zh', async () => {
    const view = mountRow(feishu({ state: 'ready' }), {
      connectorRetry: () => Promise.resolve(),
      connectorDisconnect: () => Promise.resolve(),
      connectorSend: () => Promise.reject(new Error('Not sent: Feishu refused the answer (feishu/99991663)')),
    })
    const field = all(view.node()).find(element => element.props?.['aria-label'] === '要发到飞书的消息')
    assert.ok(field, 'the send field is drawn in the row')
    field.props.onChange({ target: { value: 'hello' } })
    buttonNamed(view.node(), '发送').props.onClick()
    await settle()
    assert.equal(texts(byClass(view.node(), 'bt-connector-error')).join(''), '没发出去：飞书拒收（feishu/99991663）')
  })
})

// `connector-send` (the row's send button) raises its own two sentences, separate from the room's
// `Not sent: …` answer: the notifier's refusal and its timeout.
test('#3243: a message the row could not send says so in the window’s language', async () => {
  const sendFails = (error, labels) => {
    const view = mountRow(feishu({ state: 'ready' }), {
      connectorRetry: () => Promise.resolve(),
      connectorDisconnect: () => Promise.resolve(),
      connectorSend: () => Promise.reject(new Error(error)),
    })
    const field = all(view.node()).find(element => element.props?.['aria-label'] === labels.field)
    field.props.onChange({ target: { value: 'hello' } })
    buttonNamed(view.node(), labels.send).props.onClick()
    return view
  }
  const zh = { field: '要发到飞书的消息', send: '发送' }
  const en = { field: 'Message to send to Feishu', send: 'Send' }
  const errorLine = view => texts(byClass(view.node(), 'bt-connector-error')).join('')
  await inLangAsync('zh', async () => {
    const refused = sendFails('Feishu refused the message (feishu/99991663)', zh)
    await settle()
    assert.equal(errorLine(refused), '飞书拒收这条消息（feishu/99991663）')
    const noAnswer = sendFails('Feishu refused the message (no answer)', zh)
    await settle()
    assert.equal(errorLine(noAnswer), '飞书拒收这条消息（no answer）')
    const timedOut = sendFails('Feishu did not answer in time — the message may already be in the chat; check before sending again', zh)
    await settle()
    assert.equal(errorLine(timedOut), '飞书没有及时答复——消息可能已经发到群里；再发送前先确认一下')
  })
  await inLangAsync('en', async () => {
    const view = sendFails('Feishu refused the message (feishu/99991663)', en)
    await settle()
    assert.equal(errorLine(view), 'Feishu refused the message (feishu/99991663)')
    const timedOut = sendFails('Feishu did not answer in time — the message may already be in the chat; check before sending again', en)
    await settle()
    assert.equal(errorLine(timedOut), 'Feishu did not answer in time — the message may already be in the chat; check before sending again')
  })
})

// The Composio row's search hint is the one place `Composio answered 422…` surfaced unread.
test('#3243: the Composio search hint reads its host sentence in the window’s language', async () => {
  const search = () => Promise.reject(new Error('Composio answered 422: the apps are wrong'))
  const typed = () => {
    const view = mount(AppPicker, { apps: [], onChange: () => {}, search })
    const field = all(view.node()).find(element => element.props?.className === 'bt-input' && element.props?.type === 'search')
    field.props.onChange({ target: { value: 'gmail' } })
    return view
  }
  const hintOf = view => texts(all(view.node()).find(element => element.props?.className === 'bt-set-hint')).join('')
  // The search is debounced and answers on a promise: the language stays bound until the hint is
  // drawn, the way the window keeps its language while a row waits for the host.
  await inLangAsync('zh', async () => {
    const view = typed()
    await settle(350)
    assert.equal(hintOf(view), '无法搜索 Composio：Composio 返回了 422: the apps are wrong')
  })
  await inLangAsync('en', async () => {
    const view = typed()
    await settle(350)
    assert.equal(hintOf(view), 'Could not search Composio: Composio answered 422: the apps are wrong')
  })
})
