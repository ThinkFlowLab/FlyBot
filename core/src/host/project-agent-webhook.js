// Notification only: no private message body, FBA token, redirect or ambient proxy.
import { createHmac, timingSafeEqual } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'
import { request as httpsRequest } from 'node:https'
import { request as httpRequest } from 'node:http'
import { privateCredentialFile } from './project-private-file.js'

const blocked = new BlockList()
for (const [address, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16], ['192.0.0.0', 24], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]]) blocked.addSubnet(address, prefix, 'ipv4')
for (const [address, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['::ffff:0:0', 96]]) blocked.addSubnet(address, prefix, 'ipv6')
export const webhookSignature = (key, timestamp, body) => `sha256=${createHmac('sha256', key).update(`${timestamp}.${body}`).digest('hex')}`
export function verifyWebhookSignature({ key, timestamp, body, signature, now = Date.now(), toleranceMs = 300000 }) {
  if (!/^\d{13}$/.test(String(timestamp)) || Math.abs(now - Number(timestamp)) > toleranceMs || !/^sha256=[a-f0-9]{64}$/.test(signature ?? '')) return false
  return timingSafeEqual(Buffer.from(signature), Buffer.from(webhookSignature(key, timestamp, body)))
}
export async function sendAgentWebhook(settings, event, { now = Date.now, resolve = lookup, readKey = privateCredentialFile } = {}) {
  const url = new URL(settings.endpoint)
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const loopback = settings.allowLoopback === true && ['127.0.0.1', '::1', 'localhost'].includes(host)
  if (url.username || url.password || url.search || url.hash || url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) throw new Error('Webhook requires a fixed HTTPS endpoint without credentials/query/fragment')
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await resolve(host, { all: true })
  if (!addresses.length || addresses.some(row => !isIP(row.address) || blocked.check(row.address, row.family === 6 ? 'ipv6' : 'ipv4') && !(loopback && ['127.0.0.1', '::1'].includes(row.address)) && !settings.allowedAddresses?.includes(row.address))) throw new Error('Webhook address is outside the operator-approved network boundary')
  const selected = addresses[0], key = await readKey(settings.signingKeyFile)
  if (Buffer.byteLength(key) < 32) throw new Error('Webhook signing key must contain at least32 bytes')
  const body = JSON.stringify(event), timestamp = String(now())
  if (Buffer.byteLength(body) > 4096) throw new Error('Webhook notification exceeds metadata budget')
  return new Promise((resolveResponse, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, { method: 'POST', signal: AbortSignal.timeout(10000), agent: false,
      lookup: (_hostname, options, callback) => options.all ? callback(null, [selected]) : callback(null, selected.address, selected.family),
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-flybot-event-id': event.eventId, 'x-flybot-timestamp': timestamp, 'x-flybot-signature': webhookSignature(key, timestamp, body) } }, response => {
      let bytes = 0, text = ''
      response.on('data', chunk => { bytes += chunk.length; if (bytes > 4096) response.destroy(new Error('Webhook response exceeds its budget')); else text += chunk.toString('utf8') })
      response.on('error', () => reject(new Error('Webhook response could not be read')))
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) return reject(new Error('Webhook was not acknowledged'))
        if (!event.challenge) return resolveResponse({ received: true })
        try {
          const reply = JSON.parse(text), expected = webhookSignature(key, 'challenge', event.challenge)
          if (reply.challenge === event.challenge && /^sha256=[a-f0-9]{64}$/.test(reply.signature ?? '') && timingSafeEqual(Buffer.from(reply.signature), Buffer.from(expected))) return resolveResponse({ received: true })
        } catch { /* An invalid challenge is not a verified connection. */ }
        reject(new Error('Webhook connection challenge was not verified'))
      })
    })
    request.on('error', () => reject(new Error('Webhook notification could not be delivered')))
    request.end(body)
  })
}
