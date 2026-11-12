// #2945 (P-622): a saved server choice that exists but cannot be read or parsed is still a refusal
// (#2717), but the refusal used to be thrown while the controller was being built — before any
// endpoint existed — so `apply()` threw, the page answered `Unknown FlyBot endpoint social/server`
// (drawn as "the plugin did not start") and the host's diagnostics log held nothing. The refusal
// stays a refusal; it now arrives on the plugin's own endpoints and in the warn channel, and
// `apply()` returns with nothing but its dispose.
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'

// A stand-in for the FlyBot service: every endpoint `apply` registers is kept with its options, and
// the host warn channel is recorded. Nothing here starts a network.
function fakeFlybot() {
  const handlers = new Map()
  const warns = []
  const logs = []
  const fb = {
    api: {
      handle: (name, fn, options) => {
        if (handlers.has(name)) throw new Error(`duplicate endpoint ${name}`)
        handlers.set(name, { fn, options })
        return () => { handlers.delete(name) }
      },
    },
    fields: { get: () => undefined, set: () => {} },
    grants: { of: () => [], set: async () => {}, has: () => false },
    bot: { list: () => [] },
    rooms: { list: () => [] },
    readOnly: () => false,
    warn: (...args) => { warns.push(args) },
    on: () => () => {},
  }
  return { fb, handlers, warns, logs, service: { ...fb, pluginEnabled: () => true, scope: () => fb } }
}

function homeOf(t) {
  const home = mkdtempSync(join(tmpdir(), 'flybot-social-refusal-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  mkdirSync(join(home, 'bot'), { recursive: true })
  return home
}

// Runs `apply` with its data root at `home`, the way `dsh-home.test.js` does: the credentials path
// `apply` defaults to is `$DSH_HOME/bot/flybot-social.json`, so the server choice sits next to it.
async function appliedAt(home, config = {}) {
  const saved = { DSH_HOME: process.env.DSH_HOME, HOME: process.env.HOME }
  process.env.DSH_HOME = home
  const fake = fakeFlybot()
  const ctx = {
    flybot: fake.service,
    effect(execute) { this.off = execute() },
    logger: { warn: (...args) => { fake.logs.push(args) } },
  }
  let ready
  try {
    ready = apply(ctx, {
      server: 'https://a.test',
      inboxPollMs: 0,
      // The `absent` control starts the social layer for real; a fetch that cannot reach anything
      // keeps the test off the network without changing what the page is answered.
      fetch: async () => { throw new Error('no network in this test') },
      ...config,
    })
  } finally {
    if (saved.DSH_HOME === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = saved.DSH_HOME
    if (saved.HOME === undefined) delete process.env.HOME
    else process.env.HOME = saved.HOME
  }
  return { ...fake, ctx, ready }
}

// The refusal itself, so the test can read the sentence the page would show.
const refusalOf = async (handlers, name) => {
  const handler = handlers.get(name)
  assert.ok(handler, `${name} is registered while the plugin refuses`)
  try {
    await handler.fn()
  } catch (error) {
    assert.equal(error.code, 'bot/refused', `${name} refuses`)
    return error
  }
  assert.fail(`${name} answered instead of refusing`)
}

test('#2945: a damaged Settings server file leaves the plugin installed and says why', async (t) => {
  const home = homeOf(t)
  const override = join(home, 'bot', 'flybot-social-server.json')
  writeFileSync(override, '{"server":"https://picked-in-settings.test","savedAt":"')
  const { handlers, warns, logs } = await appliedAt(home)

  // 1. The install itself no longer throws, and the page keeps exactly the endpoints a healthy
  //    start registers: the three `social/server*` ones plus SOCIAL_UI_ENDPOINTS.
  assert.equal(handlers.size, 38, `every endpoint of a healthy start exists (saw ${handlers.size})`)
  // 2. The page's first request is `social/server` (client.js:3766); it is not in SOCIAL_UI_ENDPOINTS.
  const server = await refusalOf(handlers, 'social/server')
  assert.ok(server.message.includes(override), `the refusal names the path: ${server.message}`)
  assert.match(server.message, /does not parse as JSON/i)
  assert.match(server.message, /^Social is not running:/, 'the page reads it as the plugin-down sentence')
  // `social/server-check` makes the host fetch an address: a write, like the ready path's.
  assert.equal(handlers.get('social/server').options?.read, true)
  await refusalOf(handlers, 'social/server-check')
  assert.notEqual(handlers.get('social/server-check').options?.read, true, 'the check is still a write')
  await refusalOf(handlers, 'social/server-set')
  assert.notEqual(handlers.get('social/server-set').options?.read, true, 'a switch is still a write')
  // 3. The rest of the page reads the same sentence, and Feedback gets exactly one line.
  const settings = await refusalOf(handlers, 'social/settings')
  assert.equal(settings.message, server.message, 'every endpoint answers the same refusal')
  const lines = warns.map(args => args.map(value => String(value)).join(' '))
  assert.equal(lines.filter(line => line.includes(override)).length, 1, `one warn line names the path, saw ${JSON.stringify(lines)}`)
  assert.match(lines.find(line => line.includes(override)), /does not parse as JSON/i)
  // The host logger gets the same sentence (the third channel is the process log).
  const logged = logs.map(args => args.map(value => String(value)).join(' '))
  assert.equal(logged.filter(line => line.includes(override)).length, 1, 'one logger line names the path')
})

test('#2945: an unreadable Settings server file is the same refusal', async (t) => {
  if (process.getuid?.() === 0) return t.skip('root reads a file chmod 000, so this arm cannot run here')
  const home = homeOf(t)
  const override = join(home, 'bot', 'flybot-social-server.json')
  writeFileSync(override, JSON.stringify({ server: 'https://picked-in-settings.test' }))
  chmodSync(override, 0o000)
  assert.throws(() => readFileSync(override, 'utf8'), 'the file really is unreadable to this process')
  const { handlers, warns } = await appliedAt(home)
  const refused = await refusalOf(handlers, 'social/server')
  assert.ok(refused.message.includes(override), `the refusal names the path: ${refused.message}`)
  assert.match(refused.message, /cannot be read/i)
  assert.equal(warns.map(args => args.join(' ')).filter(line => line.includes(override)).length, 1, 'one warn line')
})

test('#2945: with no saved server choice the plugin starts as before', async (t) => {
  const home = homeOf(t)
  const { handlers, warns, ready } = await appliedAt(home)
  // The healthy path settles its start; a failed start answers the UI list, so the endpoint set is
  // the same one the damaged-file refusal registers.
  await ready
  assert.equal(handlers.size, 38, `a healthy start registers the same 38 endpoints (saw ${handlers.size})`)
  const view = await handlers.get('social/server').fn()
  assert.equal(view.server, 'https://a.test', 'the configured default server is used')
  assert.equal(view.source, 'config', 'no choice saved means the profile default, not a refusal')
  // A start that cannot reach anything still reports itself once; the point here is that the
  // damaged-file warning is absent, not that the control stays silent.
  assert.equal(warns.map(args => args.join(' ')).filter(line => /does not parse as JSON/.test(line)).length, 0)
})

// ---- the page half: what Settings → Bot Social draws for this refusal --------------------------
// Same tiny hook renderer the other client tests use (no jsdom): the real client.js is mounted and
// `social/server` is answered with the refusal `apply()` registered. #2946 (Dev-3) draws the other
// state on this same panel — a saved address that cannot be used, `… cannot be used … Using the
// profile default` — so this asserts the damaged file never lands on that sentence: the refusal
// has no view and no `saved` field, it is drawn as its own full sentence.
const live = { inst: null, idx: 0 }
const reactStub = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  Fragment: 'F',
  Component: class {},
  useState(init) {
    const { inst } = live
    const i = live.idx++
    if (!(i in inst.hooks)) inst.hooks[i] = { value: typeof init === 'function' ? init() : init }
    const slot = inst.hooks[i]
    return [slot.value, next => { slot.value = typeof next === 'function' ? next(slot.value) : next; inst.dirty = true }]
  },
  useEffect(fn, deps) {
    const { inst } = live
    const i = live.idx++
    if (!(i in inst.hooks)) inst.hooks[i] = { deps: undefined }
    inst.effects.push([i, fn, deps])
  },
  useRef(value) {
    const { inst } = live
    const i = live.idx++
    if (!(i in inst.hooks)) inst.hooks[i] = { current: value }
    return inst.hooks[i]
  },
}
for (const name of ['useMemo', 'useCallback', 'useLayoutEffect', 'useContext', 'useReducer', 'useId', 'useSyncExternalStore', 'useTransition', 'useDeferredValue', 'memo', 'forwardRef', 'createContext', 'createPortal', 'cloneElement', 'isValidElement', 'startTransition']) reactStub[name] = value => value

globalThis.document ??= { createElement: () => ({ setAttribute() {} }), head: { appendChild() {} }, getElementById: () => null, addEventListener() {}, removeEventListener() {} }

function loadApp() {
  const modules = new Map()
  const window = { __ModuleLoader__: { load: ({ id, factory }) => modules.set(id, factory(name => (name === 'react' ? reactStub : {}))) } }
  new Function('window', readFileSync(new URL('../client.js', import.meta.url), 'utf8'))(window)
  return modules.get('@flybot/social')
}

function render(Component, inst) {
  live.inst = inst
  live.idx = 0
  inst.effects = []
  return Component(inst.props ?? {})
}
const runEffects = inst => { for (const [, fn] of inst.effects) fn() }
const tick = () => new Promise(resolve => setTimeout(resolve, 0))
const textOf = node => {
  if (node == null || node === false || node === true) return ''
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (typeof node.type === 'function') return textOf(node.type(node.props ?? {}))
  return textOf(node.children ?? [])
}
const byTag = (node, tag, found = []) => {
  if (node == null || node === false || node === true) return found
  if (Array.isArray(node)) { for (const child of node) byTag(child, tag, found); return found }
  if (typeof node === 'string' || typeof node === 'number') return found
  if (node.props?.['data-flybot'] === tag) found.push(node)
  byTag(node.children ?? [], tag, found)
  return found
}

test('#2945: the settings page draws the refusal sentence, and not the unusable-address one', async (t) => {
  const home = homeOf(t)
  const override = join(home, 'bot', 'flybot-social-server.json')
  writeFileSync(override, '{"server":"https://picked-in-settings.test","savedAt":"')
  const { handlers } = await appliedAt(home)

  // The exact error the page's first request receives.
  let refusal
  try { await handlers.get('social/server').fn() } catch (error) { refusal = error }
  assert.ok(refusal, 'social/server refuses')
  assert.equal('saved' in refusal, false, 'a damaged file answers no view, so there is no saved address to name')

  const saved = globalThis.__flybot__
  globalThis.__flybot__ = {
    slots: { register: () => () => {} },
    call: async endpoint => {
      if (endpoint === 'social/server') throw refusal
      if (endpoint === 'social/server-check') throw refusal
      return {}
    },
  }
  try {
    const app = loadApp()
    const inst = { hooks: {}, effects: [], props: { Section: 'section', Row: 'row', t: (text, params) => String(text).replace(/\{(\w+)\}/g, (_, key) => String(params?.[key] ?? '')) } }
    render(app.SocialServerSettings, inst)
    runEffects(inst)
    await tick()
    await tick()
    const tree = render(app.SocialServerSettings, inst)
    const [statusLine] = byTag(tree, 'social-server')
    assert.ok(statusLine, 'the panel draws its status line instead of staying on "Loading…"')
    assert.equal(statusLine.props['data-tone'], 'error', 'it reads as an error, not a spinner')
    const drawn = textOf(statusLine)
    assert.ok(drawn.includes(override), `the page shows the full path: ${drawn}`)
    assert.match(drawn, /does not parse as JSON/i)
    assert.match(drawn, /^Social is not running:/, 'the refusal is drawn whole, not as "the plugin did not start"')
    assert.doesNotMatch(drawn, /cannot be used|Using the profile default/, 'a damaged file never reads as a saved address that cannot be used')
  } finally {
    if (saved === undefined) delete globalThis.__flybot__
    else globalThis.__flybot__ = saved
  }
})
