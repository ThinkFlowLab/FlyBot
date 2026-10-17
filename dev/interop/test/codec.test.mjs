import test from 'node:test'
import assert from 'node:assert/strict'
import { canonical, digest, decode, encode } from '../codec.mjs'
import { eventFor, input } from '../mocks.mjs'

const event = () => eventFor({ id: 'task-1', generation: 0, inputDigest: 'a'.repeat(64), input }, 'request')
test('canonical JSON and SHA-256 have stable vectors and preserve array order', () => {
  assert.equal(canonical({ z: [true, 'x'], a: 1 }), '{"a":1,"z":[true,"x"]}')
  assert.equal(digest({ z: [true, 'x'], a: 1 }), 'e5c4bc65865525bc29281eee9027b35aa2767130779332930b03621b0fb877c7')
  assert.equal(digest({ a: 1, z: [true, 'x'] }), digest({ z: [true, 'x'], a: 1 }))
  assert.notEqual(digest(['a', 'b']), digest(['b', 'a']))
  assert.throws(() => canonical(Infinity), /nonfinite/)
  let nested = {}; for (let i = 0; i < 20; i++) nested = { nested }
  assert.throws(() => canonical(nested), /too deep/)
})
test('valid envelope roundtrips; malformed versions/types/unknown keys fail', () => {
  assert.deepEqual(decode(encode(event())), event())
  for (const patch of [{ version: 2 }, { kind: 'idle' }, { payload: null }, { seq: 1.5 }, { eventId: '' }, { inputVersion: 0 }, { generation: -1 }, { inputDigest: 'not-a-digest' }, { actorId: 'owner-a' }, { payload: { input, ownerApproved: true } }]) assert.throws(() => encode({ ...event(), ...patch }))
  assert.throws(() => decode('{'))
  assert.throws(() => decode(' '.repeat(32769)), /too large/)
  assert.throws(() => encode({ ...event(), payload: { input: { ...input, requirement: 'x'.repeat(16385) } } }), /size|large/)
  assert.throws(() => encode({ ...event(), kind: 'answer', payload: { text: 'answer' } }), /reply/)
  assert.throws(() => encode({ ...event(), kind: 'progress', inReplyTo: 'request-1', payload: { text: 'x'.repeat(2001) } }), /size/)
})
test('network, sockets and subprocess calls fail immediately under the preload', async () => {
  const net = await import('node:net'), child = await import('node:child_process')
  assert.throws(() => fetch('https://example.com'), /unexpected network/)
  assert.throws(() => net.connect(80, 'example.com'), /unexpected network/)
  assert.throws(() => child.execSync('true'), /unexpected network/)
})
