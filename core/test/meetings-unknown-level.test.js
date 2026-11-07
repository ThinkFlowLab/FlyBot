// #2592: `summary()` is the projection every meeting action answers through, and it called the
// strict `decisionLevel()` on the stored record. A `level` no writer stores — a hand edit, or a
// record from an older build — made `meeting action=list` throw `meeting/invalid` and lose every
// record, not only the bad one. The read side now renders an unknown level as `ordinary`, the way
// `advanceRefusal()` and the board's `decisionCardOf` already read it; the write path still refuses.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { install } from '../src/host/meetings.js'

const corrupt = {
  id: 'm1',
  status: 'decided',
  question: 'Adopt the record?',
  level: 'critical',
  participants: [{ name: 'Dev', position: { stance: 'agree' } }],
  owner: 'Chief',
  decisionFile: 'decisions/x.md',
  taskIds: [],
  decidedAt: 12,
  updatedAt: 12,
}

const boot = (meetings = {}) => {
  const rt = {
    state: { meetings },
    load: async () => {},
    save: async () => {},
    ctx: { tools: { register() {} } },
  }
  install(rt)
  return rt
}

test('#2592: the meeting list keeps its records when a stored level does not parse', async () => {
  const rt = boot({ m1: corrupt })
  const list = await rt.meetingEndpoint('list')
  assert.match(list, /m1 \[decided\] Adopt the record\?/)
  assert.match(list, /level: ordinary/)
})

test('#2592: reading the record itself does not throw either', async () => {
  const rt = boot({ m1: corrupt })
  const read = await rt.meetingEndpoint('read', { meeting: 'm1' })
  assert.match(read, /m1 \[decided\] Adopt the record\?/)
})

test('#2592: the write path still refuses an unknown level', async () => {
  const rt = boot()
  await assert.rejects(
    rt.meetingEndpoint('open', { question: 'Adopt the record?', participants: ['Dev'], level: 'critical' }),
    /invalid: level must be one of ordinary, major, severe/,
  )
})
