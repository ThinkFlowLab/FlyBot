// #2360: `diagnostics-clear` answered `ok(true)` whatever the host did, so the window could not tell
// a truncated leaf from a refused one, or a removed rotated copy from a leftover. The endpoint passes
// the host's own result through now; this is the shape the client reads.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { install } from '../src/host/channel.js'

// The channel needs its context for the route it registers and nothing else on this path: the
// endpoint the test posts to never reaches a turn, a session or a Bot.
function channel() {
  const routes = []
  const ctx = {
    effect: (execute) => {
      execute()
      return () => {}
    },
    connection: { fetch: { register: (route) => { routes.push(route); return () => {} } } },
    logger: { warn() {} },
  }
  const rt = {
    ctx,
    state: {},
    warn: () => {},
    refresh: async () => {},
    readOnly: () => undefined,
    authorize: () => ({ ok: true }),
    load: async () => {},
    diagnostics: { clear: async () => ({ leaf: 'truncated', rotated: 'kept' }) },
  }
  install(rt)
  const call = async (endpoint, payload = {}) => (await routes[0].fetch(new Request('http://localhost/api/bot', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint, payload }),
  }))).json()
  return { call }
}

test('#2360: diagnostics-clear answers with the result the host reported', async () => {
  const { call } = channel()
  assert.deepEqual(await call('diagnostics-clear'), { ok: true, value: { leaf: 'truncated', rotated: 'kept' } })
})
