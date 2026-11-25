// Loopback MCP server (streamable HTTP, JSON responses) that gives this user's
// DS-Bot its connected app tools as a native MCP capability ("ot-apps").
// Bound to 127.0.0.1 with a per-boot random path token; requests carrying an
// Origin header (browsers, DNS rebinding) are refused. Every tools/call goes
// through the owner's one-shot approval in the connectors feature.
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'

export const CAPABILITY = 'ot-apps'
const BODY_LIMIT = 1024 * 1024

export async function handleRpc(connectors, message) {
  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return { jsonrpc: '2.0', id: message?.id ?? null, error: { code: -32600, message: 'Invalid Request' } }
  if (message.id === undefined) return null
  const ok = result => ({ jsonrpc: '2.0', id: message.id, result })
  switch (message.method) {
    case 'initialize':
      return ok({ protocolVersion: typeof message.params?.protocolVersion === 'string' ? message.params.protocolVersion : '2025-03-26',
        capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'flybot-workspace-apps', version: '1.0.0' },
        instructions: 'Your owner\'s connected apps (their own Composio connections and MCP servers). Every call waits for the owner to approve it in FlyBot Settings > App connectors.' })
    case 'ping':
      return ok({})
    case 'tools/list':
      return ok({ tools: await connectors.discover() })
    case 'tools/call': {
      const args = message.params?.arguments ?? {}
      if (!args || typeof args !== 'object' || Array.isArray(args)) return { jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'arguments must be an object' } }
      try {
        const result = await connectors.callTool(String(message.params?.name ?? ''), args)
        return ok({ isError: Boolean(result?.error), content: [{ type: 'text', text: JSON.stringify(result).slice(0, 60000) }] })
      } catch (error) {
        return ok({ isError: true, content: [{ type: 'text', text: JSON.stringify({ error: error?.code ?? 'tool_failed', note: 'No automatic retry.' }) }] })
      }
    }
    default:
      return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }
  }
}

export function startToolServer(connectors, { port = 0, host = '127.0.0.1' } = {}) {
  const token = randomBytes(18).toString('hex')
  const path = `/mcp/${token}`
  const server = createServer(async (req, res) => {
    const send = (status, value) => { const body = Buffer.from(JSON.stringify(value)); res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': body.length, 'Cache-Control': 'no-store' }); res.end(body) }
    if (req.headers.origin !== undefined) return send(403, { error: 'forbidden' })
    if ((req.url || '').split('?')[0] !== path) return send(404, { error: 'not found' })
    if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }); return res.end() }
    const chunks = []
    let size = 0
    req.on('data', (chunk) => { size += chunk.length; if (size > BODY_LIMIT) req.destroy(); else chunks.push(chunk) })
    req.on('end', async () => {
      try {
        const message = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        const batch = Array.isArray(message)
        const replies = []
        for (const item of batch ? message : [message]) { const reply = await handleRpc(connectors, item); if (reply) replies.push(reply) }
        if (!replies.length) { res.writeHead(202); return res.end() }
        send(200, batch ? replies : replies[0])
      } catch { if (!res.headersSent) send(400, { error: 'bad request' }) }
    })
  })
  const ready = new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => resolve(`http://${host}:${server.address().port}${path}`))
  })
  return { server, ready, close: () => new Promise(resolve => server.close(() => resolve())) }
}

// Save/attach the capability on the user's Main Bot once the runtime wrapper
// published mainBot(). `version` changes whenever connections change, so
// DS-Bot reloads the tool list. Detached when the user has no tools.
export async function syncCapability({ rt, mainBot }, url, version, wanted) {
  const botId = await mainBot()
  const attached = (rt.botOf(botId)?.capabilities ?? []).includes(CAPABILITY)
  if (!wanted) {
    if (attached) await rt.changeCapabilityAttachment('detach', { name: CAPABILITY }, botId).catch(() => {})
    return false
  }
  await rt.capabilitySave({ name: CAPABILITY, kind: 'mcp', description: 'Owner\'s connected apps (Composio + MCP servers); every call needs owner approval', transport: 'streamable-http', url: `${url}?v=${version}` }, { ui: true })
  if (!attached) await rt.changeCapabilityAttachment('attach', { name: CAPABILITY }, botId)
  return true
}
