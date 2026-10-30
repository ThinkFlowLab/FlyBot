// The route is the card (#1775): `handoff.to` names the role that owns the next step, so the card
// waits in that role's pool and an idle member of the role wakes for it. Nothing here is a
// dispatch: the producer records the handoff, the target role takes the card, and a card with no
// room is still offered, because the pool is the role and not the group.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { validateHandoff } from '../../plugins/workflow/src/pool-contract.js'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const team = () => ({
  version: 2,
  revision: 1,
  mainBotIds: ['a'],
  members: { 'owner-1': { id: 'owner-1', createdAt: 1, designatedChiefId: 'a' } },
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Lead', sessionId: 'a', createdAt: 1, ownerId: 'owner-1' },
    d1: { id: 'd1', name: 'Dev1', role: 'Dev', sessionId: 'd1', createdAt: 2, ownerId: 'owner-1', createdBy: 'a' },
    r1: { id: 'r1', name: 'Rev1', role: 'Reviewer', sessionId: 'r1', createdAt: 3, ownerId: 'owner-1', createdBy: 'a' },
  },
  rooms: {},
  grants: {},
  agents: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {},
})

async function start(t) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-handoff-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(team()))
  const ctx = fakeContext()
  const agents = new Map()
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) {
      const inbox = {
        nextStep: [],
        nextTurn: [],
        remove(id) {
          const keep = message => message.id !== id
          const before = this.nextTurn.length + this.nextStep.length
          this.nextTurn = this.nextTurn.filter(keep)
          this.nextStep = this.nextStep.filter(keep)
          return this.nextTurn.length + this.nextStep.length !== before
        },
      }
      agents.set(sessionId, {
        session: { id: sessionId }, id: sessionId, calls: [], status: 'idle', inbox,
        followup(message) { this.calls.push(message); this.inbox.nextTurn.push(message) },
        steer() {}, inject() {}, cancel() {}, async whenIdle() {},
      })
    }
    return agents.get(sessionId)
  }
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async () => ({ id: 'w1' }), archiveSession: async () => {} },
    sessionController: {
      create: async () => ({ sessionId: 'made' }),
      resolveAgent: async id => ({ agent: agentOf(id) }),
      selectModel: async () => {},
      page: async () => ({ records: [], hasMore: false }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  const rt = createRuntime(ctx, { home })
  await rt.load()
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  const track = (sessionId, args) => ctx.registeredTools.get('track_tasks').execute(args ?? {}, { agent: { id: sessionId } })
  const calls = (sessionId) => agents.get(sessionId)?.calls ?? []
  const text = (sessionId) => calls(sessionId).map(message => message.content.map(block => block.text ?? '').join('\n')).join('\n')
  const drive = async () => { await rt.considerTaskDrive(); await ctx.taskDrive.settled() }
  const idOf = (body) => {
    const id = String(body).match(/task-[0-9a-f]+/)?.[0]
    assert.ok(id, body)
    return id
  }
  return { ctx, rt, track, calls, text, drive, idOf, home }
}

test('a card handed to a role wakes that role and one member claims it, with no dispatch', async (t) => {
  const app = await start(t)
  // The Chief writes the opening handoff once: the card is in the Dev pool from that write.
  const created = await app.track('a', { tasks: [{ title: 'Build the route', handoff: { from: 'Lead', to: 'Dev', reason: 'first slice' } }] })
  const id = app.idOf(created)
  assert.equal(app.rt.state.tasks[id].queueRole, 'Dev')
  assert.equal(app.rt.state.tasks[id].handoff.to, 'Dev')

  await app.drive()
  assert.match(app.text('d1'), new RegExp(`Take ${id} `), 'the Dev is offered the card by the route alone')
  assert.equal(app.text('r1'), '', 'another role is not woken')

  assert.match(await app.track('d1', { claim: true, id }), new RegExp(`^Claimed ${id} `))
  assert.equal(app.rt.state.tasks[id].claimedBy, 'd1')
  assert.equal(app.rt.state.tasks[id].status, 'claimed')
})

test('a producer hands on its own card and the target role takes it; from and evidence survive', async (t) => {
  const app = await start(t)
  const id = app.idOf(await app.track('a', { tasks: [{ title: 'Build the route', handoff: { from: 'Lead', to: 'Dev' } }] }))
  await app.drive()
  await app.track('d1', { claim: true, id })

  // The producer's own write is the whole handover: it names the role, records what proves the work.
  const handed = await app.track('d1', {
    tasks: [{ id, handoff: { from: 'Dev', to: 'Reviewer', reason: 'diff ready' }, evidence: [{ sha: 'abcdef1234', check: 'node --test' }] }],
  })
  assert.ok(handed)
  const card = app.rt.state.tasks[id]
  assert.equal(card.status, 'open', 'the producer let go of the card in the same write')
  assert.equal(card.claimedBy, undefined)
  assert.equal(card.queueRole, 'Reviewer')
  assert.equal(card.handoff.from, 'Dev')
  assert.equal(card.evidence.length, 1)
  assert.equal(app.calls('a').length, 0, 'the Chief ran nothing while the card moved on')

  await app.drive()
  assert.match(app.text('r1'), new RegExp(`Take ${id} `))
  assert.match(await app.track('r1', { claim: true, id }), new RegExp(`^Claimed ${id} `))
  assert.equal(app.rt.state.tasks[id].claimedBy, 'r1')
  assert.equal(app.rt.state.tasks[id].handoff.from, 'Dev', 'the card still says who produced it')
  assert.deepEqual(app.rt.state.tasks[id].evidence.map(entry => entry.sha), ['abcdef1234'])
  assert.equal(app.calls('a').length, 0, 'the Chief ran nothing')
})

test('with no idle member of the role the card waits in the pool and is taken once one appears', async (t) => {
  const app = await start(t)
  // The Reviewer already holds a card, so it cannot take another.
  const busy = app.idOf(await app.track('r1', { tasks: [{ title: 'Review the last diff', column: 'in-progress' }] }))
  const id = app.idOf(await app.track('a', { tasks: [{ title: 'Build the route', handoff: { from: 'Lead', to: 'Dev' } }] }))
  await app.drive()
  await app.track('d1', { claim: true, id })
  await app.track('d1', { tasks: [{ id, handoff: { from: 'Dev', to: 'Reviewer', reason: 'diff ready' } }] })

  await app.drive()
  const waiting = app.rt.state.tasks[id]
  assert.equal(waiting.status, 'open', 'the card is not lost when nobody can take it')
  assert.equal(waiting.claimedBy, undefined)
  assert.equal(waiting.queueRole, 'Reviewer', 'it stays in the Reviewer pool')
  assert.doesNotMatch(app.text('r1'), new RegExp(`Take ${id} `))

  // The Reviewer delivers the card it held; the pool is offered again on the next pass.
  await app.rt.taskEndpoint('task-return', { id: busy, summary: 'the last diff is fine' })
  await app.drive()
  assert.match(app.text('r1'), new RegExp(`Take ${id} `))
  assert.match(await app.track('r1', { claim: true, id }), new RegExp(`^Claimed ${id} `))
})

test('a role returns the card to its producer as a rework card the producer can take', async (t) => {
  const app = await start(t)
  const id = app.idOf(await app.track('a', { tasks: [{ title: 'Build the route', handoff: { from: 'Lead', to: 'Dev' } }] }))
  await app.drive()
  await app.track('d1', { claim: true, id })
  await app.track('d1', { tasks: [{ id, handoff: { from: 'Dev', to: 'Reviewer', reason: 'diff ready' }, evidence: [{ sha: 'abcdef1234', check: 'node --test' }] }] })
  await app.drive()
  await app.track('r1', { claim: true, id })
  await app.track('r1', { tasks: [{ id, column: 'in-progress' }] })

  const returned = await app.track('r1', { rework: { task: id, reason: 'no test for the return path' } })
  const childId = app.idOf(returned)
  const child = app.rt.state.tasks[childId]
  assert.equal(child.taskClass, 'rework')
  assert.equal(child.reworkOf, id, 'the rework points back at the card it fixes')
  assert.equal(child.handoff.to, 'Dev', 'and at the role that produced it')
  assert.equal(child.handoff.from, 'Reviewer')
  assert.equal(child.queueRole, 'Dev')
  assert.equal(app.rt.state.tasks[id].status, 'working', 'the original waits for the rework to be accepted')

  await app.drive()
  assert.doesNotMatch(app.text('d1').split('Continue ').at(-1) ?? '', /never/, 'sanity')
  const wake = app.calls('d1').map(message => message.content.map(block => block.text ?? '').join('\n')).find(line => line.includes(`Take ${childId} `))
  assert.ok(wake, `the producer is offered the rework card, got:\n${app.text('d1')}`)
  assert.match(await app.track('d1', { claim: true, id: childId }), new RegExp(`^Claimed ${childId} `))
  assert.equal(app.rt.state.tasks[childId].claimedBy, 'd1')
})

test('a card waiting for its rework is not re-offered when its lease expires (#1804)', async (t) => {
  const app = await start(t)
  const id = app.idOf(await app.track('a', { tasks: [{ title: 'Build the route', handoff: { from: 'Lead', to: 'Dev' } }] }))
  await app.drive()
  await app.track('d1', { claim: true, id })
  await app.track('d1', { tasks: [{ id, handoff: { from: 'Dev', to: 'Reviewer', reason: 'diff ready' } }] })
  await app.drive()
  await app.track('r1', { claim: true, id })
  await app.track('r1', { tasks: [{ id, column: 'in-progress' }] })
  const childId = app.idOf(await app.track('r1', { rework: { task: id, reason: 'no test for the return path' } }))
  const offers = () => (app.text('r1').match(new RegExp(`Take ${id} `, 'g')) ?? []).length
  const before = offers()

  // The original waits for the child: recovering it would offer it back to the role that sent it
  // back and let the producer take it again while the rework is open — the same work twice.
  assert.equal(await app.rt.taskExpireLeases(Date.now() + 31 * 60 * 1000), 0, 'the card held for rework is not recovered')
  assert.equal(app.rt.state.tasks[id].status, 'working', 'the original keeps waiting for its rework')
  await app.drive()
  assert.equal(offers(), before, 'the Reviewer is not offered the card it sent back')
  assert.match(app.text('d1'), new RegExp(`Take ${childId} `), 'the producer is offered the rework card')
  assert.match(await app.track('d1', { claim: true, id }), /no card for Dev in the handoff pool/, 'the producer cannot take the card its rework covers')
  assert.match(await app.track('d1', { claim: true, id: childId }), new RegExp(`^Claimed ${childId} `), 'the producer takes the card that is in flight')
})

// #1804 keeps a card with an open `rework` child out of the lease recovery; this pins the states on
// both sides of that guard — held while the child is open, recovered once it is cancelled. Green on
// the base too (the base holds the card back and recovers it the same way), so the case is a
// regression guard, not a discriminator for #1809.
test('a cancelled rework hands its original back to the lease recovery (#1804)', async (t) => {
  const app = await start(t)
  const id = app.idOf(await app.track('a', { tasks: [{ title: 'Build the route', handoff: { from: 'Lead', to: 'Dev' } }] }))
  await app.drive()
  await app.track('d1', { claim: true, id })
  await app.track('d1', { tasks: [{ id, handoff: { from: 'Dev', to: 'Reviewer', reason: 'diff ready' } }] })
  await app.drive()
  await app.track('r1', { claim: true, id })
  await app.track('r1', { tasks: [{ id, column: 'in-progress' }] })
  const childId = app.idOf(await app.track('r1', { rework: { task: id, reason: 'no test for the return path' } }))
  const held = app.rt.state.tasks[id]
  const worker = held.worker
  assert.ok(worker, 'the claim that holds the card started a worker')

  // While the child is open the tick leaves the card alone: no recovery, so the worker, the holder
  // and an empty evidence list all stay put.
  assert.equal(await app.rt.taskExpireLeases(Date.now() + 31 * 60 * 1000), 0, 'a card waiting for its rework is not recovered')
  assert.equal(held.status, 'working', 'the original keeps waiting for its rework')
  assert.equal(held.worker, worker, 'the worker of the open card is not dropped')
  assert.deepEqual(held.evidence ?? [], [], 'no recovery is recorded while the rework is open')

  // The exit: with the child cancelled no rework is open, so the next tick recovers the card the way
  // it recovers any abandoned one, and only once.
  await app.rt.taskEndpoint('task-cancel', { id: childId })
  assert.equal(app.rt.state.tasks[childId].status, 'cancelled')
  assert.equal(await app.rt.taskExpireLeases(Date.now() + 61 * 60 * 1000), 1)
  const recovered = held
  assert.equal(recovered.status, 'open', 'an abandoned rework does not strand the original')
  assert.equal(recovered.queueRole, 'Reviewer', 'back in the queue its handoff names')
  assert.equal(recovered.ownerBotId, held.queueBy, 'the requeue hands the card back to the Bot that enqueued it')
  assert.equal(recovered.claimedBy, undefined)
  assert.equal(recovered.lease, undefined)
  assert.equal(recovered.worker, undefined, 'the dead worker is dropped')
  assert.equal(app.rt.taskWorkerState(worker), undefined)
  assert.equal(recovered.evidence?.at(-1)?.check, 'lease expired (held by Rev1)', 'the recovery names the holder it recovered from')
  assert.equal(await app.rt.taskExpireLeases(Date.now() + 62 * 60 * 1000), 0, 'the recovered card is not recovered twice')
  await app.drive()
  assert.match(app.text('r1'), new RegExp(`Take ${id} `), 'the Reviewer is offered the card again')
})

// #1853: the pool contract's first two checks read the same board facts as the host's route
// (`core/src/host/tasks.js:441-442`, `:494-501`), so the two policies cannot drift apart in
// silence. The contract's roles, pools and exec owner are taken from the live board here, not
// written down a second time.
test('the pool contract and the host route reach the same target and owner verdict (#1853)', async (t) => {
  const app = await start(t)
  const bots = Object.values(app.rt.state.bots)
  const roles = [...new Set(bots.map(bot => bot.role))]
  const context = (over = {}) => ({
    roles,
    pools: Object.fromEntries(roles.map(role => [role, { workers: 1 }])),
    execOwner: bots.find(bot => bot.id === 'd1').ownerId,
    worker: { wip: 0 },
    pool: { inflight: 0, workers: 1 },
    seen: new Set(),
    ...over,
  })

  // 1. target — the host refuses a role no Bot carries, and the contract refuses the same role.
  const refused = await app.track('a', { tasks: [{ title: 'Ghost handoff', handoff: { from: 'Lead', to: 'Ghost', reason: 'x' } }] })
  assert.match(refused, /unknown-role/)
  assert.equal(validateHandoff({ card: 'task-x', fromRole: 'Lead', toRole: 'Ghost', reason: 'x' }, context()).code, 'unknown-role')
  assert.equal(validateHandoff({ card: 'task-x', fromRole: 'Ghost', toRole: 'Dev', reason: 'x' }, context()).ok, true, 'the contract checks the target role, as the host does, and not the producer')

  // ... and the same acceptance: the pool the host routes the card to is a pool the contract takes.
  const id = app.idOf(await app.track('a', { tasks: [{ title: 'Build the route', handoff: { from: 'Lead', to: 'Dev', reason: 'first slice' } }] }))
  const routed = app.rt.state.tasks[id].queueRole
  assert.equal(routed, 'Dev')
  assert.equal(validateHandoff({ card: id, fromRole: 'Lead', toRole: routed, reason: 'first slice' }, context()).ok, true)

  // 2. owner — the writing Bot's owner is the exec's only owner; another owner is refused.
  const dev = bots.find(bot => bot.id === 'd1')
  assert.equal(validateHandoff({ card: id, fromRole: 'Dev', toRole: 'Reviewer', reason: 'diff ready', owner: dev.ownerId }, context()).ok, true)
  const notOwner = validateHandoff({ card: id, fromRole: 'Dev', toRole: 'Reviewer', reason: 'diff ready', owner: 'owner-2' }, context())
  assert.equal(notOwner.code, 'not-owner')
  assert.equal(dev.ownerId, context().execOwner, 'the board itself gives the exec its one owner')
})
