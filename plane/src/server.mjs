// The plane's HTTP surface, split so it can be tested without a socket (#3113): `handle()` is a
// pure function from one request `{ method, path, headers, body }` to one response
// `{ status, headers, body }`, and `serve()` is the thin `node:http` adapter that feeds it.
//
// Every route asks `verifyOperator` first — a control token is not an operator token, and neither
// is silence — and then the instance routes compare `instance.ownerId` with the account the token
// belongs to: a stranger with a valid token of their own gets 403, not a read.
import { createServer } from 'node:http'
import { redact, verifyOperator } from './credentials.mjs'
import { openStore, DuplicateInstanceError, UnknownInstanceError } from './store.mjs'

const json = (status, body) => ({ status, headers: { 'content-type': 'application/json' }, body })

const ROUTES = [
  { method: 'POST', pattern: /^\/api\/instances$/ },
  { method: 'GET', pattern: /^\/api\/instances$/ },
  { method: 'GET', pattern: /^\/api\/instances\/([^/]+)$/ },
  { method: 'POST', pattern: /^\/api\/instances\/([^/]+)\/start$/ },
  { method: 'POST', pattern: /^\/api\/instances\/([^/]+)\/stop$/ },
]

const route = (method, path) => {
  const hit = ROUTES.find(r => r.method === method && r.pattern.test(path))
  if (!hit) return null
  const match = hit.pattern.exec(path)
  return { method, id: match[1] ?? null }
}

export function handle(request, deps) {
  const { store, backend } = deps
  const found = route(request.method, request.path)
  if (!found) return json(404, { error: 'no such route' })

  const operator = verifyOperator(store, request.headers?.authorization)
  if (!operator) return json(401, { error: 'a valid operator token is required' })

  if (request.method === 'POST' && found.id === null) {
    const { workspaceId, name } = request.body ?? {}
    if (!workspaceId || !name) return json(400, { error: 'workspaceId and name are required' })
    try {
      const { instance, controlToken } = store.createInstance({ workspaceId, name })
      const reported = backend.create(instance, { controlToken })
      const saved = store.updateInstance(instance.id, reported)
      // The control token is handed out exactly once, here, to the operator that created the
      // instance; the store keeps only its digest.
      return json(201, { instance: saved, controlToken })
    } catch (err) {
      if (err instanceof DuplicateInstanceError) return json(409, { error: err.message })
      if (err instanceof UnknownInstanceError) return json(404, { error: err.message })
      return json(400, { error: err.message })
    }
  }

  if (request.method === 'GET' && found.id === null) {
    return json(200, { instances: store.listInstances({ ownerId: operator.accountId }) })
  }

  const instance = store.findInstance(found.id)
  if (!instance) return json(404, { error: `no instance ${found.id}` })
  if (instance.ownerId !== operator.accountId) return json(403, { error: 'this instance belongs to another operator' })

  if (request.method === 'GET') return json(200, { instance })

  const reported = request.path.endsWith('/start') ? backend.start(instance) : backend.stop(instance)
  const saved = store.updateInstance(instance.id, reported)
  return json(200, { instance: saved })
}

export function serve({ port, dataDir, backend, host = '127.0.0.1', log = () => {} }) {
  const store = openStore(dataDir)
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    let body = {}
    if (chunks.length) {
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { body = {} }
    }
    const url = new URL(req.url, 'http://localhost')
    const response = handle(
      { method: req.method, path: url.pathname, headers: req.headers, body },
      { store, backend },
    )
    const payload = JSON.stringify(response.body)
    res.writeHead(response.status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) })
    res.end(payload)
    log(`${req.method} ${url.pathname} -> ${response.status} ${redact(req.headers?.authorization ?? '')}`)
  })
  return new Promise(resolve => server.listen(port, host, () => resolve(server)))
}
