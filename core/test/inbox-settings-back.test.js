// A failed workflow run has no chat, so Open on its inbox card opens the Workflow graphs page
// in Settings (#1706, inbox.js `openCard`). Closing that page did not come back to the queue:
// `closeSettings` only nulled the panel, so the person landed on whatever conversation lay under
// the inbox they had opened. The page a card opens now carries where closing it returns to, and
// the settings close reads that marker. `closedSettings` is the one transition the UI store runs
// for a close, so the shell and this test take the same path.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// inbox.js is a browser module: React and the icon set are the shell's, so it is bundled once with
// those left external and the platform modules stubbed, the way inbox.test.js loads it.
const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/inbox.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'node', write: false,
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const module = { exports: {} }
runInNewContext(bundle.outputFiles[0].text, {
  module, exports: module.exports, setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {}, Date, Promise,
  require: (name) => {
    const platform = {
      react: {
        createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
        useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
        useEffect: () => {}, useLayoutEffect: () => {}, useRef: current => ({ current }), useCallback: fn => fn, useMemo: fn => fn(), Fragment: 'fragment',
      },
      'react-dom': {},
      '@deepseek-ai/dsh-client-ui-primitives': {},
    }
    if (!(name in platform)) throw new Error(`no platform module ${name}`)
    return platform[name]
  },
})
const { openCard } = module.exports
const closedSettings = state => module.exports.closedSettings(state)

const calls = []
const actions = {
  closeInbox: () => calls.push(['close']),
  openSettings: (...args) => calls.push(['settings', ...args]),
  openSession: id => calls.push(['session', id]),
}

test('#2541: a workflow card asks Settings to return to the inbox when it closes', () => {
  calls.length = 0
  openCard(actions, { kind: 'workflow', id: 'wf-1' })
  assert.deepEqual(calls, [['close'], ['settings', 'workflows', null, 'inbox']], 'the page names the inbox as where closing returns')
})

test('#2541: closing that page brings the inbox back instead of the chat under it', () => {
  const opened = { inbox: null, settings: { page: 'workflows', id: null, back: 'inbox' }, remoteBotSettings: null }
  const closed = closedSettings(opened)
  assert.equal(closed.inbox, true, 'the inbox is open again')
  assert.equal(closed.settings, null)
})

test('#2541: a Settings page opened any other way still closes to the view under it', () => {
  const closed = closedSettings({ inbox: null, settings: { page: 'workflows', id: null }, remoteBotSettings: null })
  assert.equal(closed.inbox, null, 'no inbox comes back that was not open before')
  assert.equal(closed.settings, null)
  const untouched = { inbox: true, settings: null, remoteBotSettings: null }
  assert.equal(closedSettings(untouched), untouched, 'a close with no panel open leaves the state alone')
})
