import { createServer } from 'node:http'

// A separate listener exposes only authenticated Feishu events, never Harness or the console.
export function createFeishuEventServer(service) {
  return createServer(async (req, res) => {
    const match = /^\/api\/feishu\/events\/(cli_[0-9a-f]{16})$/i.exec(req.url ?? '')
    if (req.method !== 'POST' || !match) { res.writeHead(404).end(); return }
    if (Number(req.headers['content-length']) > 1024 * 1024) { res.writeHead(413).end(); req.resume(); return }
    try {
      const chunks = []; let size = 0
      for await (const chunk of req) { size += chunk.length; if (size > 1024 * 1024) { res.writeHead(413).end(); req.resume(); return }; chunks.push(chunk) }
      const answer = await service.receive(match[1], JSON.parse(Buffer.concat(chunks).toString()), 'http')
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(answer))
    } catch (error) {
      const status = error.code === 'bot/forbidden' ? 403 : error instanceof SyntaxError ? 400 : 503
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ error: status === 403 ? error.message : 'Event could not be saved; retry later' }))
    }
  })
}
