
import assert from 'node:assert/strict'
import test from 'node:test'
import { createGatewayDispatch, GATEWAY_PATH } from '../src/dispatch.js'
import { createV1Endpoint } from '../featurekit/v1.js'

const token = 'ota_' + '1'.repeat(32) + '_' + 'K'.repeat(43)
const agent = 'a'.repeat(32)
const inv = 'c'.repeat(32)

function request(path, { method = 'POST', headers = {}, body } = {}) {
  return new Request('http://127.0.0.1' + GATEWAY_PATH + '?path=' + encodeURIComponent(path), {
    method, headers: { 'content-type': 'application/json', ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

test('external agent API is shaped like /v1/gateway and verifies the token in the plugin', async () => {
  const calls = []
  const dispatch = createGatewayDispatch({
    endpoints: {
      'agent-api/invoke': async (payload) => { calls.push(['invoke', payload]); return { status: 202, invocation: { id: inv, status: 'queued' } } },
      'agent-api/invocation': async (payload) => { calls.push(['status', payload]); return { invocation: { id: payload.id, status: 'succeeded', reply: 'ok' } } },
    },
  })
  const created = await dispatch(request(`/v1/gateway/agents/${agent}/invocations`, {
    headers: { 'x-ot-gateway-token': token, 'idempotency-key': 'k'.repeat(16) }, body: { prompt: 'hello' },
  }))
  assert.equal(created.status, 202)
  assert.deepEqual(await created.json(), { invocation: { id: inv, status: 'queued' } })
  assert.equal(calls[0][1].token, token)
  assert.equal(calls[0][1].prompt, 'hello')
  const polled = await dispatch(request(`/v1/gateway/invocations/${inv}`, {
    method: 'GET', headers: { 'x-ot-gateway-token': token },
  }))
  assert.equal(polled.status, 200)
  assert.equal((await polled.json()).invocation.reply, 'ok')
  const denied = await dispatch(request(`/v1/gateway/agents/${agent}/invocations`, { body: { prompt: 'x' } }))
  assert.equal(denied.status, 401)
})

import { createLegacyDispatch, LEGACY_PATH } from '../src/dispatch.js'

test('legacy /v1 dispatch returns the Flask-shaped body and status', async () => {
  const dispatch = createLegacyDispatch({
    endpoints: {
      'settings/v1': async (payload) => {
        if (payload.path !== '/v1/settings' || payload.method !== 'POST') throw new Error('bad')
        return { status: 200, body: { language: payload.body.language, revision: 3 } }
      },
    },
  })
  const url = 'http://127.0.0.1' + LEGACY_PATH + '?feature=settings&path=' + encodeURIComponent('/v1/settings')
  const ok = await dispatch(new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ language: 'zh-CN' }) }))
  assert.equal(ok.status, 200)
  assert.deepEqual(await ok.json(), { language: 'zh-CN', revision: 3 })
  const missing = await dispatch(new Request('http://127.0.0.1' + LEGACY_PATH + '?feature=unknown&path=' + encodeURIComponent('/v1/settings'), { method: 'GET' }))
  assert.equal(missing.status, 404)
})

test('native feature downloads honor the query from browser navigation or a shim request', async () => {
  const path = '/v1/works/export'
  const endpoint = createV1Endpoint({
    feature: 'artifacts',
    routes: [{
      pattern: /^\/v1\/works\/export$/,
      handle(req) {
        const pptx = req.query.get('format') === 'pptx'
        return {filename: pptx ? 'slides.pptx' : 'slides.html', raw: req.queryString}
      },
    }],
    context: {},
  })
  const dispatch = createLegacyDispatch({endpoints: {'artifacts/v1': endpoint}})
  const url = new URL(LEGACY_PATH, 'http://127.0.0.1')
  url.search = new URLSearchParams({feature: 'artifacts', path, query: 'format=pptx'})
  const download = await dispatch(new Request(url))
  assert.equal(download.status, 200)
  assert.match(download.headers.get('content-disposition'), /slides\.pptx/)
  assert.equal(await download.text(), 'format=pptx')
  const shim = await endpoint({method: 'GET', path: path + '?format=pptx'})
  assert.equal(shim.download.filename, 'slides.pptx')
})
