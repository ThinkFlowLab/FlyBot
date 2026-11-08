import assert from 'node:assert/strict'
import { test } from 'node:test'
import { feishuCheck, feishuTransport } from '../src/host/connectors.js'
import { createNotifier } from '../src/host/notify.js'

// #2660: a Feishu custom-bot webhook has no idempotency field, so a POST whose answer was lost
// cannot be sent again: the receiver would show the same message twice. Notify.js retries
// `network`, which is right for a connection that never opened and wrong for a request that may
// already have been written — the transport has to tell those two apart.

const WEBHOOK = 'https://open.feishu.cn/open-apis/bot/v2/hook/unit-test'
const ok = data => ({ status: 200, ok: true, headers: { get: () => null }, json: async () => ({ code: 0, data }) })
const status = (code, headers = {}) => ({
  status: code,
  ok: code >= 200 && code < 300,
  headers: { get: name => headers[String(name).toLowerCase()] ?? null },
  json: async () => ({}),
})
const notifier = (fetch, extra = {}) => createNotifier({
  channel: 'feishu',
  transport: feishuTransport(WEBHOOK, { fetch, timeoutMs: 40 }),
  log: () => {},
  ...extra,
})

test('#2660: a POST whose answer was lost is not sent a second time', async () => {
  const posts = []
  const fetch = async (url, init) => {
    posts.push(JSON.parse(init.body))
    return new Promise(() => {}) // accepted, but the answer never comes back
  }

  const result = await notifier(fetch).send({ key: 'k1', text: 'standup in 5 minutes' })

  assert.equal(posts.length, 1, 'one send makes exactly one POST when the answer is lost')
  assert.deepEqual(posts[0], { msg_type: 'text', content: { text: 'standup in 5 minutes' } })
  assert.deepEqual(result, { state: 'failed', error: 'feishu/no-answer', attempts: 1, permanent: true })
  assert.equal(result.error, 'feishu/no-answer', 'the error names the unconfirmed delivery')
})

test('#2660: a connection that never opened still retries three times', async () => {
  let calls = 0
  const fetch = async () => {
    calls += 1
    const cause = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
    throw new TypeError('fetch failed', { cause })
  }

  const result = await notifier(fetch, { delay: async () => {} }).send({ key: 'k2', text: 'hello' })

  assert.equal(calls, 3, 'a refused connection wrote nothing, so the three attempts stay')
  assert.deepEqual(result, { state: 'failed', error: 'network', attempts: 3, permanent: false })
})

test('#2660: a 429 still retries and waits what Retry-After asks', async () => {
  let calls = 0
  const waits = []
  const fetch = async () => {
    calls += 1
    return calls === 1 ? status(429, { 'retry-after': '2' }) : ok({ message_id: 'om_1' })
  }

  const result = await notifier(fetch, { delay: async ms => { waits.push(ms) } }).send({ key: 'k3', text: 'hello' })

  assert.equal(result.state, 'sent')
  assert.equal(result.attempts, 2, 'a rate limit is transient: the same call is tried again')
  assert.ok(waits[0] >= 2_000, 'Retry-After is a floor, not a suggestion')
})

test('#2660: the connect sentence says the test message may already be posted', async () => {
  let calls = 0
  const fetch = async () => { calls += 1; return new Promise(() => {}) }

  await assert.rejects(
    feishuCheck(WEBHOOK, { fetch, timeoutMs: 40 }),
    error => {
      assert.equal(calls, 1, 'the probe is one POST, never a retry')
      assert.match(error.message, /did not answer in time/i)
      assert.match(error.message, /may already be in the chat/i)
      assert.ok(!error.message.includes('open.feishu.cn'), 'the sentence never carries the webhook URL')
      return true
    },
  )
})
