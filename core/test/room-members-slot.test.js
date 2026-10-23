import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// #876: the Members card of a group that lives here draws a plugin's rows (the social plugin's
// Invite by link), and hands them `host` for core endpoints, which the plugin's `call` cannot reach.

async function loadSlots() {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL('../src/client/flybot-slots.js', import.meta.url))],
    bundle: true, format: 'cjs', platform: 'node', write: false,
    external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
  })
  const module = { exports: {} }
  const sandbox = {
    module, exports: module.exports, setTimeout, clearTimeout, console,
    require: (name) => {
      const platform = {
        react: {
          Component: class {}, createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
          useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}], useEffect: () => {}, useRef: current => ({ current }),
          useLayoutEffect: () => {}, useMemo: make => make(), useCallback: fn => fn, useSyncExternalStore: (sub, get) => get(), Fragment: 'fragment',
        },
        'react-dom': { createPortal: node => node },
        '@deepseek-ai/dsh-client-ui-primitives': { MarkdownText: function MarkdownText() { return null }, projectUserText: text => text },
      }
      if (!(name in platform)) throw new Error(`no platform module ${name}`)
      return platform[name]
    },
  }
  sandbox.globalThis = sandbox
  runInNewContext(bundle.outputFiles[0].text, sandbox)
  return { ...module.exports, sandbox }
}

test('#876: a plugin row in the Members card gets the room and a host call for core endpoints', async () => {
  const { FlyBotRoomMembers, registry, sandbox } = await loadSlots()
  const slots = registry()
  assert.equal(typeof sandbox.__flybot__.host, 'function', 'the registry also carries the core call')
  const Row = () => null
  slots.register('flybot.room.members', { id: 'social-room-invite', order: 50, component: Row })
  const room = { id: 'r1', name: 'Trip plan' }
  const tree = FlyBotRoomMembers({ room, roster: {}, actions: {} })
  const wrap = tree.children[0]
  assert.equal(wrap.props['data-flybot'], 'social-room-invite')
  const safe = wrap.children[0]
  assert.equal(safe.props.entry.component, Row)
  assert.equal(safe.props.props.room, room)
  assert.equal(typeof safe.props.props.host, 'function')
  assert.equal(typeof safe.props.props.call, 'function')
})

test('#876: the Members card draws the plugin rows only in a group that lives here', () => {
  const source = readFileSync(new URL('../src/client/group-settings.js', import.meta.url), 'utf8')
  assert.match(source, /room\.origin === 'face-to-face' \|\| room\.origin === 'inbound-share' \? null : h\(FlyBotRoomMembers, \{ room, roster, actions \}\)/,
    'a face room has its own invite card and a shared room is not ours to invite to')
})
