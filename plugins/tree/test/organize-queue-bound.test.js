// #2751: one reorganization job whose host call never settles used to hold the serial queue for
// ever: the next `exclusive()` job never ran and `idle()` never resolved. Each job now carries a
// deadline; a job that misses it is reported as abandoned (with its id) and the queue moves on.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createOrganizer } from '../src/organize.js'

// The queue needs nothing from the tree itself: no job below reads a Bot or a snapshot, so the
// organizer is built with the smallest host that satisfies its constructor.
function organizerAt({ jobTimeoutMs = 30 } = {}) {
  const warnings = []
  const fields = new Map()
  const fb = {
    getField: (id, key) => fields.get(`${id}:${key}`),
    setField: (id, key, value) => { if (value == null) fields.delete(`${id}:${key}`); else fields.set(`${id}:${key}`, value) },
    getBot: id => ({ id, name: id }),
    listBots: () => [],
    setSystemPrompt: () => {},
    createBot: () => new Promise(() => {}),
    updateBot: async () => {},
    memoryRead: () => [],
    memoryAppend: async () => ({ ok: true }),
    isRemote: () => false,
    hasAnyGrant: () => false,
  }
  const organizer = createOrganizer({
    fb,
    limits: { maxChildren: 8, maxDepth: 4 },
    snapshot: () => ({}),
    childrenOf: () => [],
    depthOf: () => 0,
    warn: (...args) => warnings.push(args.map(String).join(' ')),
    refreshAll: () => {},
    writeBlock: () => {},
    findRootId: () => 'root',
    now: () => 1_700_000_000_000,
    classify: () => ({}),
    jobTimeoutMs,
  })
  return { organizer, warnings }
}

test('#2751 a job whose host call never settles is abandoned, and the queue moves on', async () => {
  const { organizer, warnings } = organizerAt({ jobTimeoutMs: 30 })
  const never = new Promise(() => {})
  const stuck = organizer.shared.exclusive(async () => { await never; return 'done' })
  const later = organizer.shared.exclusive(async () => 'later ran')

  await assert.rejects(stuck, error => {
    assert.equal(error.abandoned, true, 'the give-up is reported, not as a failure of the host call')
    assert.match(error.message, /reorg-1/)
    return true
  })
  assert.equal(await later, 'later ran')
  await organizer.idle()
  assert.equal(organizer.busy(), false)

  const warned = warnings.join('\n')
  assert.match(warned, /reorg-1/) // the abandoned job is named
  assert.match(warned, /abandoned after 30ms/)
})

test('#2751 a failed job does not poison the queue', async () => {
  const { organizer } = organizerAt()
  const failed = organizer.shared.exclusive(async () => { throw new Error('host said no') })
  const later = organizer.shared.exclusive(async () => 'later ran')

  await assert.rejects(failed, /host said no/)
  assert.equal(await later, 'later ran')
  await organizer.idle()
  assert.equal(organizer.busy(), false)
})

test('#2751 a job that settles keeps its value and its order', async () => {
  const { organizer } = organizerAt()
  const order = []
  const first = organizer.shared.exclusive(async () => { order.push('first'); return 1 })
  const second = organizer.shared.exclusive(async () => { order.push('second'); return 2 })

  assert.equal(await first, 1)
  assert.equal(await second, 2)
  assert.deepEqual(order, ['first', 'second'])
  await organizer.idle()
})
