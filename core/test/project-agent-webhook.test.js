import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, writeFileSync, rmSync, chmodSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { sendAgentWebhook, webhookSignature, verifyWebhookSignature } from '../src/host/project-agent-webhook.js'
import { privateCredentialFile } from '../src/host/project-private-file.js'

test('notification signatures bind exact timestamp/body and reject modified or expired notifications', () => {
  const key = 'fixture-key-'.repeat(4), timestamp = '1793710000000', body = '{"eventId":"one"}'
  const signature = `sha256=${createHmac('sha256', key).update(`${timestamp}.${body}`).digest('hex')}`
  assert.equal(webhookSignature(key, timestamp, body), signature)
  assert.equal(verifyWebhookSignature({ key, timestamp, body, signature, now: Number(timestamp) }), true)
  for (const change of [{ body: body + ' ' }, { signature: 'sha256=' + '0'.repeat(64) }, { timestamp: '1' }, { now: Number(timestamp) + 300001 }]) assert.equal(verifyWebhookSignature({ key, timestamp, body, signature, now: Number(timestamp), ...change }), false)
})

test('private host keys reject public files/symlinks; unsafe URL, DNS/private network and credential-bearing URLs never receive notifications', async t => {
  const home = mkdtempSync(join(tmpdir(), 'flybot-webhook-key-')), file = join(home, 'key'), link = join(home, 'link')
  t.after(() => rmSync(home, { recursive: true, force: true }))
  writeFileSync(file, 'fixture-key-'.repeat(4), { mode: 0o600 }); symlinkSync(file, link)
  assert.match(await privateCredentialFile(file), /fixture/)
  await assert.rejects(privateCredentialFile(link), /private credential/i)
  chmodSync(file, 0o644); await assert.rejects(privateCredentialFile(file), /private credential/i)
  for (const endpoint of ['http://example.com', 'https://user:password@example.com', 'https://example.com?token=x', 'https://example.com/#fragment', 'https://127.0.0.1', 'https://[::ffff:127.0.0.1]']) await assert.rejects(sendAgentWebhook({ endpoint }, { eventId: 'one' }), /HTTPS|address/)
  await assert.rejects(sendAgentWebhook({ endpoint: 'https://receiver.example' }, { eventId: 'one' }, { resolve: async () => [{ address: '169.254.169.254', family: 4 }] }), /network boundary/)
})

test('independent receiver verifies a real signed TCP notification and connection challenge without private content', { timeout: 15000 }, async t => {
  const home = mkdtempSync(join(tmpdir(), 'flybot-webhook-tcp-')), file = join(home, 'key')
  writeFileSync(file, 'isolated-fixture-key-'.repeat(3), { mode: 0o600 })
  const child = fork(new URL('./fixtures/agent-webhook-receiver.mjs', import.meta.url), [file], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { PATH: process.env.PATH } })
  const exit = once(child, 'exit')
  t.after(async () => { child.kill(); await exit; rmSync(home, { recursive: true, force: true }) })
  const [ready] = await once(child, 'message'), settings = { endpoint: `http://127.0.0.1:${ready.port}/notify`, allowLoopback: true, signingKeyFile: file }
  const event = { version: 'flybot-agent-notification/v1', type: 'connection.verify', eventId: 'one', challenge: 'private-test-challenge', projectId: 'p', agentId: 'a' }
  assert.deepEqual(await sendAgentWebhook(settings, event), { received: true })
  await assert.rejects(sendAgentWebhook({ ...settings, endpoint: settings.endpoint.replace('/notify', '/bad-proof') }, event), /challenge/)
  await assert.rejects(sendAgentWebhook({ ...settings, endpoint: settings.endpoint.replace('/notify', '/redirect') }, event), /acknowledged/)
  const accepted = once(child, 'message')
  const notification = { version: 'flybot-agent-notification/v1', type: 'inbox.available', eventId: 'two', messageId: 'message', projectId: 'p', agentId: 'a' }
  await sendAgentWebhook(settings, notification)
  const [message] = await accepted
  assert.deepEqual(message.event, notification)
  assert.equal(message.verified, true)
  assert.equal(message.ownerCookie, false)
  assert.equal(message.authorization, false)
})
