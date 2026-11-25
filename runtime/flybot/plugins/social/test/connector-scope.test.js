import assert from 'node:assert/strict'
import { test } from 'node:test'
import { connectorTokenAllowed, createSocialApi } from '../src/mcp-client.js'
import { createFaceRoomApi } from '../src/face-rooms.js'

test('connector token scope: only the Bot Social routes that accept it', () => {
  const allowed = [
    '/mcp',
    '/v1/face-rooms',
    '/v1/face-rooms/join',
    '/v1/face-rooms/frm_1',
    '/v1/face-rooms/frm_1/start',
    '/v1/face-rooms/frm_1/leave',
    '/v1/face-rooms/frm_1/messages',
    '/v1/face-rooms/frm_1/lead',
    '/v1/face-rooms/frm_1/roles',
    '/v1/bots/b1/grants',
    '/v1/bots/b1/grants/g1',
    '/v1/bots/b1/profile',
    '/v1/grants/g1',
    '/v1/remote-bots',
    '/v1/remote-bots/g1?bot_id=@coder.bob.home',
  ]
  for (const route of allowed) assert.equal(connectorTokenAllowed(route), true, route)

  const denied = [
    '/v1/me',
    '/v1/me?x=1',
    '/v1/relationships/r1/grants',
    '/v1/approvals',
    '/v1/bots',
    '/v1/face-rooms-other',
    '/v1/remote-botsX',
    '/v1/bots/b1/settings',
    '/v1/grants',
  ]
  for (const route of denied) assert.equal(connectorTokenAllowed(route), false, route)
})

test('a REST call outside the connector-token scope fails before the request', async () => {
  const calls = []
  const api = createSocialApi({
    server: 'https://social.test',
    token: 'otk_test',
    fetch: async (url, init) => {
      calls.push({ url, authorization: init.headers.authorization })
      return new Response('{}', { status: 200 })
    },
  })

  await assert.rejects(
    api.rest('GET', '/v1/me'),
    error => error?.code === 'route_not_allowed' && /a connector token is not accepted there/.test(error.message),
  )
  assert.equal(calls.length, 0)

  await api.rest('GET', '/v1/bots/b1/grants')
  assert.deepEqual(calls, [{ url: 'https://social.test/v1/bots/b1/grants', authorization: 'Bearer otk_test' }])
})

test('face-room REST calls carry the connector token on the documented routes', async () => {
  const calls = []
  const api = createFaceRoomApi({
    server: 'https://social.test',
    token: 'otk_test',
    fetch: async (url, init) => {
      calls.push({ url, authorization: init.headers.authorization })
      return new Response(JSON.stringify({ rooms: [] }), { status: 200 })
    },
  })

  assert.deepEqual(await api.list(), [])
  assert.deepEqual(calls, [{ url: 'https://social.test/v1/face-rooms', authorization: 'Bearer otk_test' }])
})

test('a 204 answer (a withdrawn link) is a Response, not a crash of the process', async (t) => {
  const { createServer } = await import('node:http')
  const { socialFetch } = await import('../src/mcp-client.js')
  const server = createServer((req, res) => { res.writeHead(req.method === 'DELETE' ? 204 : 200, { 'content-type': 'application/json' }).end(req.method === 'DELETE' ? undefined : '{"ok":true}') })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const base = `http://127.0.0.1:${server.address().port}`
  const gone = await socialFetch(`${base}/v1/local-room-invites/tk`, { method: 'DELETE' })
  assert.equal(gone.status, 204)
  assert.equal(await gone.text(), '')
  const read = await socialFetch(`${base}/v1/local-room-invites/tk`)
  assert.deepEqual(await read.json(), { ok: true })
})
