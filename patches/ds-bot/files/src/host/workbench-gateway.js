// Restricted shared entry. The DSH owner credential stays server-side; members never
// receive raw Harness APIs or its owner cookie. Project authorization remains in FlyBot.
import { createServer } from 'node:http'
import { gzipSync } from 'node:zlib'
import { readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const WORKBENCH_ENDPOINTS = new Set([
  'personal-space', 'auth-mode', 'platform-login', 'auth-whoami', 'auth-revoke', 'auth-invite', 'auth-redeem', 'workbench-state',
  'project-repositories', 'project-repository-link', 'project-repository-unlink', 'project-close-request', 'project-close-prepare', 'project-close-confirm',
  'projects', 'project-create', 'project-read', 'project-detail', 'project-board', 'project-members', 'project-role',
  'project-invite', 'project-join', 'project-leave', 'project-member-remove', 'project-archive', 'project-delete',
  'project-quota', 'project-resources', 'project-resource-environment-check', 'project-execution-input', 'project-runtime-check', 'project-terminal-open', 'project-terminal-poll', 'project-terminal-input', 'project-terminal-resize', 'project-terminal-close', 'project-queue-cancel', 'project-queue-retry', 'project-workflow',
  'task-create', 'task-update', 'task-cancel', 'task-answer-input',
  'project-task-run', 'project-task-detail', 'project-task-accept', 'project-task-reject',
  'project-attempt-stop', 'project-attempt-log', 'project-attempt-cleanup', 'project-attempt-publication-retry',
  'project-rooms', 'project-room-create', 'project-room-read', 'project-room-message', 'project-room-attachment', 'project-room-stop', 'project-agent-stop',
  'project-agents', 'project-agent-message', 'project-agent-history', 'project-agent-memory-write', 'project-role-memory-write', 'project-agent-definition', 'project-roles', 'project-role-proposals', 'project-role-decision',
  'project-development', 'project-task-pools', 'project-chief-question', 'project-github-read', 'project-agent-mode',
  'project-chief-state', 'project-chief-configure', 'project-chief-inspect', 'project-scheduled-task',
  'project-agent-proposal-apply', 'project-knowledge-write', 'project-credential-status', 'project-github-comment',
])
const LIMIT = 1024 * 1024
const HTML = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>FlyBot · Project workbench</title><link rel="stylesheet" href="/workbench.css"></head><body><div id="workbench-root"></div><script defer src="/workbench.js"></script></body></html>'

export function createWorkbenchGateway({ upstreamOrigin, upstreamCookie, publicOrigin, readAsset, request = fetch } = {}) {
  const upstream = new URL(upstreamOrigin)
  if (!['http:', 'https:'].includes(upstream.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(upstream.hostname) || upstream.pathname !== '/' || upstream.search || upstream.hash || upstream.username || upstream.password) throw new Error('Workbench upstream must be a fixed loopback origin')
  if (typeof upstreamCookie !== 'string' || !upstreamCookie || upstreamCookie.length > 8192 || /[\r\n\u0000]/.test(upstreamCookie)) throw new Error('A valid private upstream cookie is required')
  const published = publicOrigin ? new URL(publicOrigin) : null
  if (published && (published.origin !== publicOrigin || published.username || published.password || !['http:', 'https:'].includes(published.protocol))) throw new Error('Invalid fixed workbench public origin')
  const assets = readAsset ?? (name => readFile(resolve(import.meta.dirname, '../..', name)))
  const server = createServer(async (req, res) => {
    res.setHeader('cache-control', 'no-store')
    res.setHeader('x-content-type-options', 'nosniff')
    res.setHeader('x-frame-options', 'DENY')
    res.setHeader('referrer-policy', 'no-referrer')
    res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'")
    const respond = (status, value, type = 'application/json; charset=utf-8') => {
      const data = Buffer.from(type.startsWith('application/json') ? JSON.stringify(value) : value)
      res.setHeader('vary', 'Accept-Encoding')
      const acceptsGzip = String(req.headers['accept-encoding'] ?? '').split(',').some(part => /^gzip(?:\s*;|$)/i.test(part.trim()) && !/;\s*q=0(?:\.0*)?\s*$/i.test(part))
      const compressed = acceptsGzip && data.length >= 1024
      res.writeHead(status, { 'content-type': type, ...(compressed ? { 'content-encoding': 'gzip' } : {}) })
      res.end(compressed ? gzipSync(data) : data)
    }
    const port = server.address()?.port
    const allowed = published ? [published.origin] : [`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`]
    const host = String(req.headers.host ?? '')
    if (!allowed.some(origin => new URL(origin).host === host)) return respond(403, { error: 'Unexpected workbench host' })
    const origin = req.headers.origin
    if (origin && !allowed.includes(origin) || req.headers['sec-fetch-site'] === 'cross-site') return respond(403, { error: 'Cross-origin request refused' })
    const url = new URL(req.url ?? '/', allowed[0])
    if (url.search) return respond(404, { error: 'Not found' })
    if (req.method === 'GET') {
      if (url.pathname === '/') return respond(200, HTML, 'text/html; charset=utf-8')
      if (url.pathname === '/health') return respond(200, { status: 'ok' })
      if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end() }
      if (['/workbench.js', '/workbench.css', '/workbench-native.js', '/workbench-native.css'].includes(url.pathname)) {
        try { return respond(200, await assets(url.pathname.slice(1)), url.pathname.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8') }
        catch { return respond(503, { error: 'Build the Project workbench assets before starting' }) }
      }
      if (/^\/workbench-fonts\/KaTeX_[A-Za-z0-9_-]+-[A-Z0-9]{8}\.(woff2?|ttf)$/.test(url.pathname)) {
        try { return respond(200, await assets(url.pathname.slice(1)), url.pathname.endsWith('.woff2') ? 'font/woff2' : url.pathname.endsWith('.woff') ? 'font/woff' : 'font/ttf') }
        catch { return respond(404, { error: 'Font not found' }) }
      }
      return respond(404, { error: 'Not found' })
    }
    if (req.method !== 'POST' || url.pathname !== '/api/bot') return respond(404, { error: 'Not found' })
    if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return respond(415, { error: 'JSON requests only' })
    try {
      let size = 0
      const chunks = []
      for await (const chunk of req) { size += chunk.length; if (size > LIMIT) return respond(413, { error: 'Request too large' }); chunks.push(chunk) }
      let body
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return respond(400, { error: 'Invalid JSON' }) }
      if (!WORKBENCH_ENDPOINTS.has(body?.endpoint)) return respond(403, { error: 'Endpoint is unavailable at the shared workbench entry' })
      const actor = req.headers['x-flybot-member-session']
      if (body.endpoint === 'auth-invite' && !actor) return respond(403, { error: 'Initial member invitation must be issued by the private operator entry' })
      const upstreamResponse = await request(`${upstream.origin}/api/bot`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(180_000),
        headers: { 'content-type': 'application/json', cookie: upstreamCookie, origin: upstream.origin,
          ...(typeof actor === 'string' ? { 'x-flybot-member-session': actor } : {}) },
        body: JSON.stringify({ endpoint: body.endpoint, payload: body.payload ?? {} }) })
      if (!upstreamResponse.ok) return respond(502, { error: 'Workbench runtime is unavailable' })
      const text = await upstreamResponse.text()
      if (text.length > 8 * LIMIT) return respond(502, { error: 'Workbench response exceeded its limit' })
      let result
      try { result = JSON.parse(text) } catch { return respond(502, { error: 'Invalid workbench response' }) }
      return respond(200, result) // Never forward upstream Set-Cookie/Location/owner credentials.
    } catch { if (!res.headersSent) respond(502, { error: 'Workbench runtime request failed' }) }
  })
  server.on('upgrade', (_request, socket) => { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n') })
  return server
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const value = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1] }
  const file = value('--upstream-cookie-file')
  if (!file || (await stat(file)).mode & 0o077) throw new Error('Use a private mode-0600 upstream cookie file')
  const server = createWorkbenchGateway({ upstreamOrigin: value('--upstream'), upstreamCookie: (await readFile(file, 'utf8')).trim(), publicOrigin: value('--public-origin') })
  const port = Number(value('--port') ?? 3081)
  server.listen(port, '127.0.0.1', () => process.stdout.write(`Project workbench: http://127.0.0.1:${server.address().port}/\n`))
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => server.close())
}
