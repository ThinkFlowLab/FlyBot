import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createNotifier, fakeSlack, rateLimited, channelNotFound, networkFailure } from '../src/host/notify.js'

// Every retry below is driven by fake timers: a test never sleeps in real time. `settle` lets the
// adapter reach its next await (transport call or backoff) before the clock is moved.
async function settle() {
  for (let i = 0; i < 3; i += 1) await new Promise(resolve => setImmediate(resolve))
}

test('#355: a reminder reaches the transport in Slack chat.postMessage shape', async () => {
  const transport = fakeSlack([{ ok: true }])
  const notifier = createNotifier({ transport, channel: 'C0123' })

  const first = await notifier.send({ key: 'r1', text: 'Standup in 10 minutes' })
  assert.deepEqual(first, { state: 'sent', ts: 'ts-1', attempts: 1 })
  // Optional fields are passed only when given, so a plain reminder is a plain message.
  assert.deepEqual(transport.calls, [{ channel: 'C0123', text: 'Standup in 10 minutes' }])

  await notifier.send({ key: 'r2', text: 'Still 10 minutes', blocks: [{ type: 'section' }], threadTs: 'ts-1' })
  assert.deepEqual(transport.calls[1], { channel: 'C0123', text: 'Still 10 minutes', blocks: [{ type: 'section' }], threadTs: 'ts-1' })
})

test('#355: the same reminder handed over twice is one message', async () => {
  const transport = fakeSlack([{ ok: true }])
  const notifier = createNotifier({ transport, channel: 'C0123' })

  assert.equal((await notifier.send({ key: 'r1', text: 'Tomorrow: ship' })).state, 'sent')
  const again = await notifier.send({ key: 'r1', text: 'Tomorrow: ship' })
  assert.deepEqual(again, { state: 'duplicate', ts: 'ts-1', attempts: 0 })
  assert.equal(transport.calls.length, 1, 'a repeated reminder is not a second transport call')
})

test('#355: a second send for a reminder already in flight joins it instead of starting another', async () => {
  let release
  const transport = fakeSlack([() => new Promise(resolve => { release = () => resolve({ ok: true, ts: 'ts-a' }) })])
  const notifier = createNotifier({ transport, channel: 'C0123' })

  const first = notifier.send({ key: 'r1', text: 'Tomorrow: ship' })
  await settle()
  const second = notifier.send({ key: 'r1', text: 'Tomorrow: ship' })
  release()
  const [a, b] = await Promise.all([first, second])
  assert.equal(transport.calls.length, 1)
  assert.equal(a.ts, 'ts-a')
  assert.equal(b.ts, 'ts-a')
})

test('#355: a rate limit waits what Retry-After asks, then sends once', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const transport = fakeSlack([rateLimited(2_000), { ok: true }])
  const notifier = createNotifier({ transport, channel: 'C0123' })

  const pending = notifier.send({ key: 'r1', text: 'Tomorrow: ship' })
  await settle()
  assert.equal(transport.calls.length, 1)
  t.mock.timers.tick(1_999)
  await settle()
  assert.equal(transport.calls.length, 1, 'Retry-After is a floor, not a suggestion')
  t.mock.timers.tick(1)
  await settle()
  assert.deepEqual(await pending, { state: 'sent', ts: 'ts-2', attempts: 2 })
  assert.equal(transport.calls.length, 2)
})

test('#355: a broken link backs off further on each attempt', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const waits = []
  const transport = fakeSlack([networkFailure(), networkFailure(), { ok: true }])
  const notifier = createNotifier({ transport, channel: 'C0123', delay: async ms => { waits.push(ms) } })

  const result = await notifier.send({ key: 'r1', text: 'Tomorrow: ship' })
  assert.deepEqual(waits, [500, 1_000])
  assert.deepEqual(result, { state: 'sent', ts: 'ts-3', attempts: 3 })
})

test('#355: a thrown transport error is a broken link, not a reason to give up', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const transport = fakeSlack([new Error('socket hang up'), { ok: true }])
  const notifier = createNotifier({ transport, channel: 'C0123' })

  const pending = notifier.send({ key: 'r1', text: 'Tomorrow: ship' })
  await settle()
  t.mock.timers.tick(500)
  await settle()
  assert.deepEqual(await pending, { state: 'sent', ts: 'ts-2', attempts: 2 })
})

test('#355: three failed attempts end the delivery, and a later run may try again', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const waits = []
  const transport = fakeSlack([networkFailure(), networkFailure(), networkFailure(), { ok: true }])
  const notifier = createNotifier({ transport, channel: 'C0123', delay: async ms => { waits.push(ms) } })

  const first = await notifier.send({ key: 'r1', text: 'Tomorrow: ship' })
  assert.deepEqual(first, { state: 'failed', error: 'network', attempts: 3, permanent: false })
  assert.deepEqual(waits, [500, 1_000], 'three attempts, two waits: the budget is not exceeded')
  assert.equal(transport.calls.length, 3)

  // Exhausting the attempts is not a verdict about the channel, so the reminder is not blacklisted.
  const second = await notifier.send({ key: 'r1', text: 'Tomorrow: ship' })
  assert.equal(second.state, 'sent')
  assert.equal(transport.calls.length, 4)
})

test('#355: Slack\'s own transient codes are retried, not remembered as permanent', async () => {
  // Slack answers these for its own trouble (an internal error, a restart, a slow request). One of
  // them must not cost the owner a reminder: each is retried on the same budget as a broken link.
  for (const code of ['internal_error', 'fatal_error', 'service_unavailable', 'request_timeout']) {
    const waits = []
    const transport = fakeSlack([{ ok: false, error: code }, { ok: true }])
    const notifier = createNotifier({ transport, channel: 'C0123', delay: async ms => { waits.push(ms) } })
    assert.deepEqual(await notifier.send({ key: `r-${code}`, text: 'Tomorrow: ship' }), { state: 'sent', ts: 'ts-2', attempts: 2 }, `${code} is worth another attempt`)
    assert.deepEqual(waits, [500], `${code} backs off like any transient failure`)
    assert.equal(transport.calls.length, 2)
  }
  // And running out of attempts is not a verdict about the channel: the reminder is not remembered
  // as permanently refused, so a later run may still deliver it.
  const transport = fakeSlack([{ ok: false, error: 'service_unavailable' }, { ok: false, error: 'service_unavailable' }, { ok: false, error: 'service_unavailable' }, { ok: true }])
  const notifier = createNotifier({ transport, channel: 'C0123', delay: async () => {} })
  assert.deepEqual(await notifier.send({ key: 'r-retry', text: 'Tomorrow: ship' }), { state: 'failed', error: 'service_unavailable', attempts: 3, permanent: false })
  assert.equal((await notifier.send({ key: 'r-retry', text: 'Tomorrow: ship' })).state, 'sent', 'a transient failure is not remembered as a refusal')
})

test('#355: a missing channel is a permanent failure and is not retried', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const transport = fakeSlack([channelNotFound(), { ok: true }])
  const notifier = createNotifier({ transport, channel: 'C-gone' })

  const first = await notifier.send({ key: 'r1', text: 'Tomorrow: ship' })
  assert.deepEqual(first, { state: 'failed', error: 'channel_not_found', attempts: 1, permanent: true })
  assert.equal(transport.calls.length, 1)

  const second = await notifier.send({ key: 'r1', text: 'Tomorrow: ship' })
  assert.deepEqual(second, { state: 'failed', error: 'channel_not_found', attempts: 0, permanent: true })
  assert.equal(transport.calls.length, 1, 'a structural failure stays answered without another call')
})

test('#355: a channel that is off makes no transport call at all', async () => {
  const transport = fakeSlack([{ ok: true }])
  const notifier = createNotifier({ transport, channel: 'C0123', enabled: false })

  assert.deepEqual(await notifier.send({ key: 'r1', text: 'Tomorrow: ship' }), { state: 'skipped', attempts: 0, reason: 'channel-off' })
  assert.equal(transport.calls.length, 0)
})

test('#355: switching a channel off stops a reminder that is waiting to retry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const transport = fakeSlack([rateLimited(5_000), { ok: true }])
  const notifier = createNotifier({ transport, channel: 'C0123' })

  const pending = notifier.send({ key: 'r1', text: 'Tomorrow: ship' })
  await settle()
  assert.equal(transport.calls.length, 1)
  notifier.setEnabled(false)
  t.mock.timers.tick(5_000)
  await settle()
  assert.deepEqual(await pending, { state: 'skipped', attempts: 1, reason: 'channel-off' })
  assert.equal(transport.calls.length, 1, 'the retry never leaves after the switch went off')
  assert.equal(notifier.enabled, false)
})

test('#355: a reminder needs a key and something to say', async () => {
  const notifier = createNotifier({ transport: fakeSlack(), channel: 'C0123' })
  // A malformed reminder is refused before anything is queued, so the caller hears it at once.
  assert.throws(() => notifier.send({ text: 'no key' }), { code: 'notify/invalid' })
  assert.throws(() => notifier.send({ key: 'r1' }), { code: 'notify/invalid' })
  assert.throws(() => notifier.send({ key: 'r2', text: '   ' }), { code: 'notify/invalid' })
  assert.throws(() => createNotifier({ transport: fakeSlack() }), { code: 'notify/invalid' })
  assert.throws(() => createNotifier({ channel: 'C0123' }), { code: 'notify/invalid' })
})
