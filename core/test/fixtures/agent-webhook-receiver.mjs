// Independent test receiver; no production credentials or network services.
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { createHmac, timingSafeEqual, createHash } from 'node:crypto'
const key = readFileSync(process.argv[2], 'utf8'), seen = new Set()
const client = process.argv[3] ? JSON.parse(readFileSync(process.argv[3], 'utf8')) : null
const server = createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk
  const timestamp = req.headers['x-flybot-timestamp'], signature = req.headers['x-flybot-signature'] ?? ''
  const expected = `sha256=${createHmac('sha256', key).update(`${timestamp}.${body}`).digest('hex')}`
  const verified = /^\d{13}$/.test(timestamp ?? '') && Math.abs(Date.now() - Number(timestamp)) < 300000 && signature.length === expected.length && timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  if (!verified) { res.writeHead(401); res.end(); return }
  const event = JSON.parse(body)
  if (req.url === '/redirect') { res.writeHead(302, { location: '/notify' }); res.end(); return }
  if (req.url === '/bad-proof') { res.end(JSON.stringify({ challenge: event.challenge })); return }
  if (!event.challenge && !seen.has(event.eventId)) {
    try {
      if (client) {
        if (event.projectId !== client.projectId || event.agentId !== client.agentId) throw Error('wrong recipient')
        const api = async (kind, name, payload, requestId) => {
          const response = await fetch(`${client.origin}/api/bot`, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json', 'x-flybot-member-session': client.token }, body: JSON.stringify({ endpoint: 'project-development', payload: { version: 'project-development/v1', projectId: event.projectId, kind, name, payload, ...(requestId ? { requestId } : {}) } }), signal: AbortSignal.timeout(10000) })
          const body = await response.json(); if (!body.ok) throw Error('inbox operation refused'); return body.value.result
        }
        const request = createHash('sha256').update(event.eventId).digest('hex').slice(0, 32)
        const { claim } = await api('command', 'inbox.claim', { messageId: event.messageId }, `receiver-claim-${request}`)
        await api('query', 'inbox.get', { messageId: event.messageId, limit: 4000 })
        const completed = await api('command', 'inbox.complete', { messageId: event.messageId, claimId: claim.claimId, generation: claim.generation, text: 'Approved fixture option', publish: true }, `receiver-answer-${request}`)
        if (!completed.published) throw Error('expected authorized publication')
      }
      seen.add(event.eventId); process.send({ event, verified, handled: Boolean(client), ownerCookie: Boolean(req.headers.cookie), authorization: Boolean(req.headers.authorization || req.headers['x-flybot-member-session']) })
    } catch { res.writeHead(503); res.end(); return }
  }
  res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(event.challenge ? { challenge: event.challenge, signature: `sha256=${createHmac('sha256', key).update(`challenge.${event.challenge}`).digest('hex')}` } : { received: true }))
})
server.listen(0, '127.0.0.1', () => process.send({ port: server.address().port }))
