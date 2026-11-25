// #2971: renaming the home on the server you are already on had no way to be submitted — when the
// checked server was the same one, the action row drew only `Check` and the one button that sends
// `social/server-set` was drawn only for a different server, so the typed name went nowhere.
//
// The suite's own Settings cases live in social.test.js, which another pull request holds (#2968), so
// this file drives the same form on its own: it mounts the real client.js with the small hook renderer
// the other client tests use (no jsdom) and reads the action row it draws.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

const pageProps = { Section: 'section', Row: 'row', t: (text, params) => String(text).replace(/\{(\w+)\}/g, (_, key) => String(params?.[key] ?? '')) }
const serverView = (extra = {}) => ({ server: 'https://a.test', source: 'config', defaultServer: 'https://a.test', displayName: 'Me', state: 'connected', handle: '@me.home', error: null, canChange: true, known: [], ...extra })
const text = node => (typeof node === 'string' ? node : (node?.props?.children ?? []).map(text).join(''))

// The page reads its state in one fixed order: view, loadError, live, form, address, name, checked,
// busy, error, circle, circleError, shareBots. Each case scripts the first seven.
function page(initial, { onCall = async () => ({}) } = {}) {
  const registered = []
  const sandbox = { window: { __ModuleLoader__: { load: r => registered.push(r) } }, setTimeout, clearTimeout, console, navigator: {}, URL }
  sandbox.globalThis = sandbox
  sandbox.__flybot__ = { slots: { register: () => () => {} }, call: onCall }
  runInNewContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), sandbox)
  let i = 0
  const h = (type, props, ...children) => ({ type, props: { ...props, children: children.flat() } })
  const plugin = registered[0].factory(() => ({ createElement: h, Fragment: 'F', useEffect() {}, useState: v => [i < initial.length ? initial[i++] : v, () => {}], useRef: v => ({ current: v }), useMemo: f => f() }))
  const all = (node, out = []) => { if (node && typeof node === 'object') { out.push(node); for (const c of node.props?.children ?? []) all(c, out) } return out }
  const nodes = all(plugin.SocialServerSettings(pageProps))
  return { nodes, byTag: id => nodes.find(node => node.props?.['data-flybot'] === id) }
}

const SAME = { server: 'https://a.test', name: 'Bot Social', version: '0.2.0', features: [], same: true, known: true }

test('#2971: a home name typed for the server already in use can be submitted', async () => {
  const calls = []
  const { byTag } = page([serverView(), null, null, true, 'https://a.test', ' Desk ', SAME], {
    onCall: async (endpoint, payload) => { calls.push([endpoint, payload]); return { ok: true } },
  })
  assert.equal(byTag('server-check'), undefined, 'the same server offers the save, not another Check')
  const submit = byTag('server-confirm')
  assert.ok(submit, 'a changed name offers a submit')
  assert.equal(text(submit), 'Save changes')
  submit.props.onClick()
  await new Promise(resolve => setTimeout(resolve, 0))
  // The payload is built inside client.js's own realm, so spread it into this one before comparing.
  const sent = calls.filter(([endpoint]) => endpoint === 'social/server-set').map(([, payload]) => ({ ...payload }))
  assert.deepEqual(sent, [{ server: 'https://a.test', displayName: 'Desk', confirm: true }])
})

test('#2971: only a changed name on the same server turns Check into the save', () => {
  const row = (extra, name, checked) => page([serverView(extra), null, null, true, 'https://a.test', name, checked])
  {
    // Nothing typed: still Check. The page does not offer a save that would carry no name.
    const { byTag } = row({}, '', SAME)
    assert.ok(byTag('server-check'))
    assert.equal(byTag('server-confirm'), undefined)
  }
  {
    // The name the home already has: nothing changed, so still Check.
    const { byTag } = row({}, 'Me', SAME)
    assert.ok(byTag('server-check'))
    assert.equal(byTag('server-confirm'), undefined)
  }
  {
    // Another server keeps its switch wording and its identity warning.
    const { byTag } = row({}, 'Desk', { ...SAME, server: 'https://b.test', same: false, known: false })
    assert.equal(text(byTag('server-confirm')), 'Switch to this server')
    assert.ok(byTag('server-warning'))
  }
})
