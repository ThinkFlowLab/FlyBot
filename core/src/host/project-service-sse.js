// Request-scoped transport over authenticated service queries. No background
// project scheduler, bearer-in-URL, raw DSH stream or parallel event authority.
import { setTimeout as delay } from 'node:timers/promises'
import { once } from 'node:events'

export function createProjectSse({ pull, pollMs = 1000, maxStreams = 64 }) {
  if (!Number.isSafeInteger(pollMs) || pollMs < 10 || pollMs > 60000 || !Number.isSafeInteger(maxStreams) || maxStreams < 1 || maxStreams > 256) throw new Error('Invalid Project SSE transport limits')
  const active = new Set()
  async function handle(req, res, url, respond) {
    const token = req.headers['x-flybot-member-session'], projectId = url.searchParams.get('projectId')
    const invalid = [...url.searchParams.keys()].some(key => !['projectId', 'after'].includes(key) || url.searchParams.getAll(key).length !== 1)
    if (invalid || !/^[A-Za-z0-9_-]{1,100}$/.test(projectId ?? '')) return respond(400, { ok: false, error: { code: 'bot/invalid', message: 'Choose one Project and an optional event cursor' } })
    if (typeof token !== 'string' || !token || token.length > 8192) return respond(401, { ok: false, error: { code: 'bot/unauthorized', message: 'An authenticated member or personal-agent header is required' } })
    let cursor = req.headers['last-event-id'] ?? url.searchParams.get('after') ?? undefined
    if (url.searchParams.has('after') && req.headers['last-event-id'] !== undefined && req.headers['last-event-id'] !== url.searchParams.get('after') || cursor !== undefined && (typeof cursor !== 'string' || cursor.length > 600 || !/^[A-Za-z0-9_-]+$/.test(cursor))) return respond(400, { ok: false, error: { code: 'bot/invalid', message: 'Invalid or conflicting event cursor' } })
    if (active.size >= maxStreams) return respond(429, { ok: false, error: { code: 'bot/busy', message: 'Project event transport is at capacity', details: { nextAction: 'retry' } } })
    const controller = new AbortController(), { signal } = controller
    active.add(controller)
    const close = () => controller.abort()
    res.once('close', close)
    const frame = (type, data, id) => `${id ? `id: ${id}\n` : ''}event: ${type}\ndata: ${JSON.stringify(data)}\n\n`
    function send(type, data, id) {
      if (signal.aborted || res.destroyed) return false
      return res.write(frame(type, data, id))
    }
    try {
      const first = await pull({ projectId, name: cursor === undefined ? 'project.snapshot' : 'events', payload: cursor === undefined ? {} : { after: cursor, limit: 100 }, token, signal })
      if (signal.aborted) return
      if (cursor === undefined && (first?.project?.id !== projectId || typeof first.cursor !== 'string' || !/^[A-Za-z0-9_-]{1,600}$/.test(first.cursor))) throw new Error('Invalid scoped Project snapshot')
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' })
      res.flushHeaders()
      let page = first
      if (cursor === undefined) {
        cursor = first.cursor
        if (!send('snapshot', first, cursor)) await once(res, 'drain', { signal })
        page = null
      }
      while (!signal.aborted) {
        page ??= await pull({ projectId, name: 'events', payload: { after: cursor, limit: 100 }, token, signal })
        if (signal.aborted) break
        if (!Array.isArray(page.events)) throw new Error('Invalid Project event page')
        let backpressured = false
        for (const row of page.events) {
          if (row.projectId !== projectId || typeof row.cursor !== 'string' || !/^[A-Za-z0-9_-]{1,600}$/.test(row.cursor)) throw new Error('Project event scope changed')
          cursor = row.cursor
          if (!send('fact', row, cursor)) {
            await once(res, 'drain', { signal })
            backpressured = true
            break // Reauthenticate/requery instead of draining a stale buffered batch.
          }
        }
        if (!backpressured && !page.events.length && !res.destroyed && !res.write(': keep-alive\n\n')) await once(res, 'drain', { signal })
        page = null
        if (!backpressured) await delay(pollMs, undefined, { signal })
      }
    } catch (error) {
      if (!signal.aborted) {
        const code = typeof error.code === 'string' && error.code.startsWith('bot/') ? error.code : 'bot/unavailable'
        const details = { nextAction: ['bot/cursor-expired', 'bot/conflict'].includes(code) ? 'project.snapshot' : ['bot/unauthorized', 'bot/forbidden'].includes(code) ? 'authenticate' : 'retry' }
        if (!res.headersSent) respond(code === 'bot/unauthorized' ? 401 : code === 'bot/forbidden' ? 403 : ['bot/cursor-expired', 'bot/conflict'].includes(code) ? 409 : code === 'bot/invalid' ? 400 : 503, { ok: false, error: { code, message: 'Project event request could not continue', details } })
        else send(['bot/unauthorized', 'bot/forbidden'].includes(code) ? 'access-revoked' : 'reset-required', { code, details })
      }
    } finally {
      controller.abort(); active.delete(controller); res.removeListener('close', close)
      if (!res.writableEnded && !res.destroyed) res.end()
    }
  }
  return { handle, close() { for (const controller of active) controller.abort() }, active: () => active.size }
}
