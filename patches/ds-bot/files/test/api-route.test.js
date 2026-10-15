// The /api/bot route must survive a hot reload: DSH's connection refuses a second owner of an
// exact Fetch path and frees it only when the first owner is disposed.
import test from 'node:test'
import assert from 'node:assert/strict'
import { registerRoute } from '../src/host/channel.js'

function connection() {
  const routes = new Map()
  return {
    routes,
    fetch: {
      register(route) {
        if (routes.has(route.path)) throw new Error(`connection: exact Fetch route ${JSON.stringify(route.path)} is already registered`)
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
  }
}

test('api route: a reloaded instance waits for the old one to free the path, then serves it', async () => {
  const conn = connection()
  const oldRoute = { path: '/api/bot', name: 'old' }
  const newRoute = { path: '/api/bot', name: 'new' }
  const disposeOld = registerRoute({ connection: conn }, oldRoute)
  const warnings = []
  const disposeNew = registerRoute({ connection: conn }, newRoute, (...args) => warnings.push(args), { every: 5 })
  assert.equal(conn.routes.get('/api/bot'), oldRoute)
  disposeOld()
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(conn.routes.get('/api/bot'), newRoute, 'the new instance owns the route, so the browser gets no 404')
  assert.equal(warnings.length, 1)
  disposeNew()
  assert.equal(conn.routes.size, 0)
})

test('api route: disposing while waiting stops the retries; other errors still throw', async () => {
  const conn = connection()
  const disposeOld = registerRoute({ connection: conn }, { path: '/api/bot', name: 'old' })
  const disposeNew = registerRoute({ connection: conn }, { path: '/api/bot', name: 'new' }, () => {}, { every: 5 })
  disposeNew()
  disposeOld()
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(conn.routes.size, 0)
  assert.throws(() => registerRoute({ connection: { fetch: { register() { throw new Error('bad route') } } } }, { path: '/x' }), /bad route/)
})
