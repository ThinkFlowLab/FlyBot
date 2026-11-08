// #2656: the Inbox's workflow read left the shell on the bare endpoint, so the host
// answered `bot/not-found` and readWorkflows settled every poll as "plugin not
// installed" — a failed run never reached the Inbox. The host routes a plugin only
// under `flybot/` (src/host/channel.js), so the shell's action must use the plugin
// call. This test takes the wiring index.js actually ships and drives it through a
// fetch that answers exactly the way the channel does.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const root = new URL('..', import.meta.url)
const indexSource = readFileSync(new URL('src/client/index.js', root), 'utf8')

const platform = {
  react: {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {}, useLayoutEffect: () => {}, useRef: current => ({ current }),
    useCallback: fn => fn, useMemo: fn => fn(), Fragment: 'fragment',
  },
  'react-dom': {},
  '@deepseek-ai/dsh-client-ui-primitives': {},
}

const { outputFiles } = await build({
  stdin: {
    contents: [
      "export { call as bareCall } from './src/client/api.js'",
      "export { call as flybotCall } from './src/client/flybot-slots.js'",
      "export { readWorkflows } from './src/client/workflows.js'",
    ].join('\n'),
    resolveDir: fileURLToPath(root),
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})

// The real client modules, loaded once; each test gets its own host below.
const load = (fetch) => {
  const module = { exports: {} }
  runInNewContext(outputFiles[0].text, {
    module, exports: module.exports, require: name => platform[name],
    fetch, localStorage: { getItem: () => null }, window: { addEventListener: () => {}, removeEventListener: () => {} },
    setTimeout, clearTimeout, setInterval, clearInterval, console,
  })
  return module.exports
}

// src/host/channel.js: a `flybot/` endpoint reaches the plugin, anything else is
// refused with bot/not-found. The refusal is what readWorkflows maps to its hint.
const host = (pack) => {
  const endpoints = []
  const fetch = async (route, init) => {
    assert.equal(route, 'api/bot', 'the shell posts its calls on the shared channel')
    const { endpoint } = JSON.parse(init.body)
    endpoints.push(endpoint)
    const body = endpoint.startsWith('flybot/')
      ? { ok: true, value: pack }
      : { ok: false, error: { code: 'bot/not-found', message: `Unknown endpoint ${endpoint}` } }
    return { ok: true, json: async () => body }
  }
  return { endpoints, fetch }
}

const pack = {
  templates: [],
  workflows: [{ id: 'delivery', name: 'Delivery', runs: [{ taskId: 't1', status: 'failed' }] }],
}

test('#2656: the shell wires the Inbox workflow read to the plugin call', async () => {
  const wired = /actions\.workflowState = \(\) => readWorkflows\(([A-Za-z_$][\w$]*)\)/.exec(indexSource)
  assert.ok(wired, 'index.js wires actions.workflowState through readWorkflows')
  const { endpoints, fetch } = host(pack)
  const { bareCall, flybotCall, readWorkflows } = load(fetch)
  const send = { call: bareCall, flybotCall }[wired[1]]
  assert.ok(send, `index.js wires workflowState to "${wired[1]}", which is not a call this test can drive`)

  // The shape index.js builds, over the function it names.
  const actions = { workflowState: () => readWorkflows(send) }
  const settled = await actions.workflowState()

  assert.deepEqual(endpoints, ['flybot/workflow/state'],
    `the host saw ${JSON.stringify(endpoints)}; a plugin read must carry the flybot/ prefix`)
  assert.equal(settled.phase, 'ready', `the Inbox read settled as ${settled.phase}: ${settled.error}`)
  assert.ok(settled.pack.workflows.length > 0, 'the failed run is offered to the Inbox')
})

test('#2656: the bare endpoint is what made every poll a missing-plugin error', async () => {
  // The contract the fix relies on: channel.js refuses a bare endpoint, and the
  // settle reads that refusal as "no plugin". Kept so the test names the bug even
  // if the wiring changes shape again.
  const { endpoints, fetch } = host(pack)
  const { bareCall, readWorkflows } = load(fetch)
  const settled = await readWorkflows(bareCall)
  assert.deepEqual(endpoints, ['workflow/state'])
  assert.equal(settled.phase, 'error')
  assert.match(settled.error, /Workflow plugin is not installed/)
})
