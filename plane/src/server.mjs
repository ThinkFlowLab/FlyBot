// Pure router + an optional node:http adapter.
//
// `handle()` never listens on a socket, so the whole authorization surface is testable
// without ports. Every /api/* route verifies the operator token first; instance routes
// then compare `instance.ownerId === token.accountId` and answer 403 on mismatch.
import { createServer } from 'node:http'
import { createPlane } from '../index.js'
import { DuplicateInstanceError, openStore } from './store.mjs'
import { verifyOperator } from './credentials.mjs'

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' }

function reply(status, body) {
  return { status, body, headers: JSON_HEADERS }
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== ''
}

function parseBody(body) {
  if (body === undefined || body === null || body === '') return null
  if (typeof body === 'object') return body
  return JSON.parse(body)
}

export async function handle(request, { plane, store } = {}) {
  const method = String(request.method ?? 'GET').toUpperCase()
  const path = String(request.path ?? '/').split('?')[0]
  const headers = request.headers ?? {}
  const authorization = headers.authorization ?? headers.Authorization ?? ''

  const account = verifyOperator(store, authorization)
  if (!account) return reply(401, { error: 'unauthorized' })

  if (path === '/api/instances') {
    if (method === 'GET') return reply(200, { instances: plane.listInstances(account.id) })
    if (method !== 'POST') return reply(405, { error: 'method_not_allowed' })
    let body
    try {
      body = parseBody(request.body)
    } catch {
      return reply(400, { error: 'invalid_json' })
    }
    if (!body || typeof body !== 'object') return reply(400, { error: 'invalid_request' })
    const { workspaceId, name } = body
    if (!nonEmpty(workspaceId) || !nonEmpty(name)) return reply(400, { error: 'invalid_request' })
    try {
      const created = await plane.createInstance({ workspaceId, name, ownerId: account.id })
      return reply(201, created)
    } catch (error) {
      if (error instanceof DuplicateInstanceError) return reply(409, { error: 'duplicate_instance' })
      throw error
    }
  }

  const match = path.match(/^\/api\/instances\/([^/]+)(?:\/(start|stop))?$/)
  if (match) {
    const id = decodeURIComponent(match[1])
    const action = match[2]
    const instance = plane.getInstance(id)
    if (!instance) return reply(404, { error: 'not_found' })
    if (instance.ownerId !== account.id) return reply(403, { error: 'forbidden' })

    if (!action && method === 'GET') return reply(200, { instance })
    if (action === 'start' && method === 'POST') {
      return reply(200, { instance: await plane.startInstance(id) })
    }
    if (action === 'stop' && method === 'POST') {
      return reply(200, { instance: await plane.stopInstance(id) })
    }
    return reply(405, { error: 'method_not_allowed' })
  }

  return reply(404, { error: 'not_found' })
}

// Convenience for the CLI and tests. Accepts an already-built plane/store so a caller can
// keep one store instance; otherwise builds both from `dataDir`.
export function serve({ port = 3090, dataDir, backend, plane, store, clock } = {}) {
  const theStore = store ?? (dataDir ? openStore(dataDir) : null)
  const thePlane = plane ?? createPlane({ dataDir, store: theStore, backend, clock })
  if (!theStore) throw new TypeError('serve needs a store or a dataDir')
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = Buffer.concat(chunks).toString('utf8')
    let answer
    try {
      answer = await handle({ method: req.method, path: req.url, headers: req.headers, body }, { plane: thePlane, store: theStore })
    } catch {
      answer = reply(500, { error: 'internal_error' })
    }
    res.writeHead(answer.status, answer.headers)
    res.end(JSON.stringify(answer.body))
  })
  if (typeof port === 'number') server.listen(port, '127.0.0.1')
  return server
}

