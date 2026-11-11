import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createNotifier, fakeSlack, channelNotFound } from '../src/host/notify.js'

// #2808: `sent` keeps at most SENT_KEPT keys, so a long-lived host drops the oldest instead of
// growing without bound. `refused` must hold the same rule: a permanent failure is remembered so
// that repeating that send is not a second transport call (the outbound message may already be out),
// not so that a process accumulates one entry per failed send forever. Connectors hand notify.js a
// fresh randomUUID() per send (core/src/host/connectors.js), so the key space of `refused` is
// unbounded on exactly the path that keeps failing (a deleted channel, a revoked bot).
const KEPT = 1_000

test('#2808: a permanently refused key does not accumulate forever', async () => {
  const transport = fakeSlack([channelNotFound()])
  const notifier = createNotifier({ transport, channel: 'C0123' })

  // One more distinct permanently refused key than the table may keep.
  for (let i = 0; i <= KEPT; i += 1) {
    const answer = await notifier.send({ key: `k-${i}`, text: 'Standup in 10 minutes' })
    assert.deepEqual(answer, { state: 'failed', error: 'channel_not_found', attempts: 1, permanent: true })
  }
  assert.equal(transport.calls.length, KEPT + 1, 'a first permanent refusal is one transport call')
  const before = transport.calls.length

  // The newest refusal is still remembered: repeating it is answered from memory, not the transport.
  assert.deepEqual(await notifier.send({ key: `k-${KEPT}`, text: 'Standup in 10 minutes' }), {
    state: 'failed', error: 'channel_not_found', attempts: 0, permanent: true,
  })
  assert.equal(transport.calls.length, before, 'the newest refused key is still remembered')

  // The oldest was dropped once the table reached its bound, so this key is tried again: it fails
  // the same way (a permanent failure is still never retried inside one send), but it is no longer
  // refused from a table that only ever grew.
  const again = await notifier.send({ key: 'k-0', text: 'Standup in 10 minutes' })
  assert.equal(transport.calls.length, before + 1, 'an evicted key reaches the transport again')
  assert.deepEqual(again, { state: 'failed', error: 'channel_not_found', attempts: 1, permanent: true })
})
