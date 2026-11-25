import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { createSocialApi } from '../src/mcp-client.js'

// A Bot Social that accepts the connection and never answers, the way a server hung
// mid-deploy does. The sockets are tracked so the test can close over a held-open request.
function heldOpenServer(t) {
  const sockets = new Set()
  const server = createServer(() => { /* accepted, never answered */ })
  server.on('connection', socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      t.after(() => {
        for (const socket of sockets) socket.destroy()
        server.close()
      })
      resolve(`http://127.0.0.1:${server.address().port}`)
    })
  })
}

test('#2633: the REST fallback rejects at its deadline instead of hanging', async t => {
  const server = await heldOpenServer(t)
  const api = createSocialApi({ server, token: 'otk_test', timeoutMs: 200 })
  const started = Date.now()

  const outcome = await Promise.race([
    api.rest('GET', '/v1/bots/b1/grants').then(
      value => ({ settled: 'resolved', value }),
      error => ({ settled: 'rejected', error }),
    ),
    new Promise(resolve => {
      const timer = setTimeout(() => resolve({ settled: 'pending' }), 1500)
      timer.unref?.()
    }),
  ])
  const elapsed = Date.now() - started

  assert.equal(outcome.settled, 'rejected', `rest() was still ${outcome.settled} at ${elapsed}ms with a 200ms deadline`)
  assert.equal(outcome.error?.code, 'timeout')
  assert.equal(outcome.error?.message, 'Bot Social GET /v1/bots/b1/grants: no answer in 0s')
  assert.ok(elapsed < 1000, `rest() took ${elapsed}ms with a 200ms deadline`)
})

test('#2633: a REST answer inside the deadline still returns its body', async t => {
  const server = createServer((req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, path: req.url }))
    }, 20)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())

  const api = createSocialApi({ server: `http://127.0.0.1:${server.address().port}`, token: 'otk_test', timeoutMs: 1000 })
  assert.deepEqual(
    await api.rest('PATCH', '/v1/bots/b1/profile', { display_name: 'Chief' }),
    { ok: true, path: '/v1/bots/b1/profile' },
  )
})
