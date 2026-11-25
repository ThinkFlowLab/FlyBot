// User-configured remote MCP servers (port of flybot_workspace/custom_mcp.py),
// called from the user's own DS-Bot. Only public HTTPS:443 endpoints, DNS is
// resolved once and every address must be public, the connection is pinned to
// a checked address (no second lookup, no proxy, no redirects), and responses
// are size-bounded. Streamable HTTP (JSON or SSE) only; no stdio/local commands.
import { lookup as dnsLookup } from 'node:dns/promises'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import { randomUUID } from 'node:crypto'
import { fail } from '../../lib/b4/http.js'

export const LIMIT = 262144
export const PREFIX = 'OTMCP_'
export const MAX_SERVERS = 4

const v4 = text => text.split('.').reduce((n, p) => n * 256 + Number(p), 0)
const V4_DENY = [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]]

function expand6(text) {
  let [head, tail] = text.toLowerCase().split('::')
  const h = head ? head.split(':') : []
  const t = tail !== undefined && tail ? tail.split(':') : []
  const fill = tail !== undefined ? Array(8 - h.length - t.length).fill('0') : []
  return [...h, ...fill, ...t].map(x => parseInt(x || '0', 16))
}

export function publicIp(address) {
  const kind = isIP(address)
  if (kind === 4) {
    const n = v4(address)
    return !V4_DENY.some(([net, bits]) => Math.floor(n / 2 ** (32 - bits)) === Math.floor(v4(net) / 2 ** (32 - bits)))
  }
  if (kind === 6) {
    if (address.includes('.')) return false // embedded IPv4 forms (mapped/compat) are refused
    const w = expand6(address)
    if (w.length !== 8) return false
    if ((w[0] & 0xe000) !== 0x2000) return false // native global unicast 2000::/3 only
    if (w[0] === 0x2001 && w[1] === 0x0db8) return false // documentation
    if (w[0] === 0x2002) return false // 6to4
    if (w[0] === 0x2001 && w[1] === 0x0000) return false // Teredo
    if (w[0] === 0x2001 && w[1] < 0x0200) return false // IETF protocol assignments
    return true
  }
  return false
}

export function endpoint(value) {
  const bad = () => fail(400, 'mcp_endpoint', 'Use a public HTTPS:443 MCP endpoint; private networks are blocked')
  if (typeof value !== 'string' || value.length > 512 || /[\x00-\x20\\]/.test(value)) fail(400, 'mcp_endpoint', 'Use a public HTTPS MCP URL without credentials or query')
  let url
  try { url = new URL(value) } catch { return bad() }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (url.protocol !== 'https:' || !host || (url.port && url.port !== '443') || url.username || url.password || url.search || url.hash || /[?#]/.test(value)) return bad()
  if (host.endsWith('.') || host === 'localhost' || /\.(localhost|local|internal)$/.test(host)) return bad()
  if (isIP(host) && !publicIp(host)) return bad()
  return { host, path: (url.pathname || '/') }
}

export function pinnedTransport({ resolve = host => dnsLookup(host, { all: true, verbatim: true }), request = httpsRequest } = {}) {
  return async (url, headers, body) => {
    const { host, path } = endpoint(url)
    let addresses
    try { addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await resolve(host) } catch { fail(502, 'mcp_transport', 'MCP network request failed; not retried') }
    if (!addresses?.length || !addresses.every(a => publicIp(a.address))) fail(400, 'mcp_network', 'MCP DNS resolved to a blocked address')
    const pinned = [...addresses].sort((a, b) => String(a.address).localeCompare(String(b.address)))[0]
    return new Promise((resolvePromise, reject) => {
      const req = request({
        host, servername: isIP(host) ? undefined : host, port: 443, path, method: 'POST', timeout: 12_000, agent: false,
        headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
        lookup: (_name, options, cb) => (options?.all ? cb(null, [{ address: pinned.address, family: pinned.family }]) : cb(null, pinned.address, pinned.family)),
      }, (res) => {
        const chunks = []
        let size = 0
        res.on('data', (chunk) => {
          size += chunk.length
          if (size > LIMIT) { res.destroy(); reject(Object.assign(new Error('limit'), { fault: ['mcp_response', 'MCP response exceeded size limit'] })) } else chunks.push(chunk)
        })
        res.on('end', () => resolvePromise([res.statusCode, Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v.join(', ') : v])), Buffer.concat(chunks)]))
        res.on('error', reject)
      })
      req.on('timeout', () => req.destroy(new Error('timeout')))
      req.on('error', reject)
      req.end(body)
    }).catch((error) => {
      if (error?.fault) fail(502, ...error.fault)
      fail(502, 'mcp_transport', 'MCP network request failed; not retried')
    })
  }
}

export class McpClient {
  constructor(config, send) { this.config = config; this.send = send; this.session = null }

  async rpc(method, params = {}, notification = false) {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-03-26' }
    if (this.config.bearer_token) headers.Authorization = 'Bearer ' + this.config.bearer_token
    if (this.session) headers['Mcp-Session-Id'] = this.session
    const id = randomUUID().replaceAll('-', '')
    const message = { jsonrpc: '2.0', method, params }
    if (!notification) message.id = id
    let status, rh, raw
    try { [status, rh, raw] = await this.send(this.config.url, headers, JSON.stringify(message)) } catch (error) {
      if (error?.status) throw error
      fail(502, 'mcp_transport', 'MCP request failed; not retried')
    }
    if (![200, 202, 204].includes(status) || raw.length > LIMIT) fail(502, 'mcp_response', 'MCP rejected request or returned an oversized response')
    const session = rh['mcp-session-id']
    if (session) {
      if (session.length > 256 || /[^\x21-\x7e]/.test(session)) fail(502, 'mcp_response', 'Invalid MCP session')
      this.session = session
    }
    if (notification) return {}
    try {
      let doc
      if ((rh['content-type'] || '').includes('text/event-stream')) {
        doc = raw.toString('utf8').split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5).trim())).find(v => v && v.id === id)
      } else doc = JSON.parse(raw.toString('utf8'))
      if (!doc || doc.id !== id || doc.jsonrpc !== '2.0' || !doc.result || typeof doc.result !== 'object' || Array.isArray(doc.result)) throw new Error()
      return doc.result
    } catch { fail(502, 'mcp_response', 'MCP returned an invalid response') }
  }

  async initialize() {
    await this.rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'FlyBot', version: '1.0.0' } })
    await this.rpc('notifications/initialized', {}, true)
    return this
  }
}
