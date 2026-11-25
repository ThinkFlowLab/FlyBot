import assert from 'node:assert/strict'
import { test } from 'node:test'
import { callFlybot, ROUTE } from '../src/call.js'
import { dispatch, PATH, registerFlybotRoute } from '../src/route.js'

test('dispatch only answers social/* endpoints and never puts a secret in the error body', () => {
  const flybot = {
    api: {
      async call(name, payload) {
        if (name === 'social/status') return { home: 'me', faceAutoSend: {} }
        if (name === 'social/secret') {
          throw Object.assign(new Error('refused'), { code: 'bot/refused', api_key: 'sk-must-not-leak' })
        }
        throw Object.assign(new Error(`Unknown FlyBot endpoint: ${name}`), { code: 'bot/unknown-endpoint' })
      },
    },
  }
  return Promise.all([
    dispatch(flybot, 'social/status', {}).then((result) => {
      assert.equal(result.ok, true)
      assert.equal(result.value.home, 'me')
    }),
    dispatch(flybot, 'state', {}).then((result) => {
      assert.equal(result.ok, false)
      assert.equal(result.error.code, 'bot/not-found')
    }),
    dispatch(flybot, 'social/secret', {}).then((result) => {
      assert.equal(result.ok, false)
      assert.equal(result.error.code, 'bot/refused')
      assert.doesNotMatch(JSON.stringify(result), /sk-must-not-leak/)
      assert.equal(result.error.details?.api_key, undefined)
    }),
  ])
})

test('browser call unwraps ok values and maps HTTP and API errors', async () => {
  const fetches = []
  const fetchImpl = async (url, init) => {
    fetches.push({ url, init })
    const body = JSON.parse(init.body)
    if (body.endpoint === 'social/status') {
      return { ok: true, json: async () => ({ ok: true, value: { home: 'me' } }) }
    }
    if (body.endpoint === 'down') {
      return { ok: false, status: 502, json: async () => ({}) }
    }
    return { ok: true, json: async () => ({ ok: false, error: { code: 'bot/not-found', message: 'Unknown FlyBot endpoint social/missing' } }) }
  }
  assert.deepEqual(await callFlybot('social/status', {}, undefined, fetchImpl), { home: 'me' })
  assert.equal(fetches[0].url, ROUTE)
  assert.equal(fetches[0].init.credentials, 'same-origin')
  await assert.rejects(() => callFlybot('down', {}, undefined, fetchImpl), (error) => error.code === 'HTTP_502')
  await assert.rejects(() => callFlybot('social/missing', {}, undefined, fetchImpl), (error) => (
    error.code === 'bot/not-found' && /social\/missing/.test(error.message)
  ))
})

test('registerFlybotRoute hangs a POST handler on the dsh fetch registry', async () => {
  const registered = []
  const ctx = {
    effect(fn, label) {
      const off = fn()
      registered.push(label)
      return off
    },
    connection: {
      fetch: {
        register(spec) {
          registered.push(spec)
          return () => {}
        },
      },
    },
  }
  const flybot = { api: { call: async () => ({ ok: true }) } }
  registerFlybotRoute(ctx, flybot)
  assert.equal(registered[0].path, PATH)
  assert.deepEqual(registered[0].methods, ['POST'])
  assert.equal(registered[1], 'flybot-workspace: flybot api route')
  const response = await registered[0].fetch(new Request('http://localhost/api/flybot', {
    method: 'POST',
    body: JSON.stringify({ endpoint: 'state', payload: {} }),
  }))
  const body = await response.json()
  assert.equal(body.ok, false)
  assert.equal(body.error.code, 'bot/not-found')
})
