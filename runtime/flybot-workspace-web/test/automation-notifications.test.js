import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { FeatureError } from '../featurekit/http.js'
import { createAutomations } from '../features/automations/automations.js'

const PERSONAL = 'a'.repeat(32)
const TEAM = 'b'.repeat(32)
const OWNER = {internal: true}

function fixture(t, turn = async () => ({text: 'private-result-marker'})) {
  const db = new DatabaseSync(':memory:')
  const active = new Set([PERSONAL, TEAM])
  const time = {now: 1_800_000_000}
  const feature = createAutomations({db, turn, clock: () => time.now, log: () => {}, requireWorkspace: async (id) => {
    if (!active.has(id)) throw new FeatureError(404, 'not_found', 'Workspace is unavailable')
  }})
  t.after(() => { feature.stop(); db.close() })
  const create = (title, extra = {}) => feature.ops.create({workspace_id: PERSONAL, title, template_id: 'custom',
    prompt: 'private-prompt-marker', schedule: {kind: 'now', time_zone: 'UTC'}, participants: ['alice'],
    idempotency_key: 'auto-create-' + title.replaceAll(' ', '-'), ...extra})
  const list = (workspace_id = PERSONAL, options = {}, call = OWNER) => feature.ops.notifications({workspace_id, ...options}, call)
  const read = (workspace_id, selection, call = OWNER) => feature.ops.readNotifications({workspace_id, ...selection}, call)
  const settled = async () => {
    while (feature.inflight.size) await Promise.all(feature.inflight.values())
  }
  return {feature, active, time, create, list, read, settled}
}

test('scheduled native terminal results create one metadata-only receipt per run under the current policy', async (t) => {
  const blocked = Promise.withResolvers()
  const {feature, time, create, list, settled} = fixture(t, async ({prompt}) => {
    if (prompt.includes('Failure')) throw new Error('private-provider-error')
    if (prompt.includes('Timeout')) throw new Error('timed out')
    if (prompt.includes('Held')) await blocked.promise
    return {text: 'private-result-marker'}
  })
  const {automation: success} = create('Success', {enabled: true})
  assert.equal(success.notification_policy, 'scheduled')
  assert.equal(create('Success', {enabled: true, notification_policy: 'scheduled'}).status, 200)
  assert.throws(() => create('Success', {enabled: true, notification_policy: 'all'}), {status: 409})
  assert.throws(() => create('Invalid', {notification_policy: 'sometimes'}), {status: 400})
  create('Failure', {enabled: true})
  create('Timeout', {enabled: true})
  create('Muted', {enabled: true, notification_policy: 'off'})
  const {automation: held} = create('Held', {enabled: true})
  const issued = feature.tick(PERSONAL)
  assert.equal(issued.length, 5)
  feature.ops.update({workspace_id: PERSONAL, id: held.id, revision: 1, changes: {notification_policy: 'off'}})
  blocked.resolve()
  await settled()
  assert.deepEqual(feature.tick(PERSONAL), [])
  const notices = await list()
  assert.equal(notices.unread_count, 3)
  assert.deepEqual(Object.fromEntries(notices.items.map(item => [item.title, item.status])), {
    Success: 'succeeded', Failure: 'failed', Timeout: 'timeout',
  })
  const receipt = notices.items.find(item => item.automation_id === success.id)
  const successRun = issued.find(run => run.automation_id === success.id)
  assert.deepEqual(receipt, {id: 'automation-run-' + successRun.id, kind: 'automation.run_finished', created: time.now,
    read: false, workspace_id: PERSONAL, automation_id: success.id, run_id: successRun.id, title: 'Success', status: 'succeeded'})
  assert.doesNotMatch(JSON.stringify(notices), /private-/)

  const failed = notices.items.find(item => item.status === 'failed')
  const retry = {workspace_id: PERSONAL, id: failed.automation_id, run_id: failed.run_id, idempotency_key: 'retry-default-000001'}
  feature.ops.retry(retry)
  await settled()
  assert.equal((await list()).unread_count, 3)
  feature.ops.update({workspace_id: PERSONAL, id: failed.automation_id, revision: 1, changes: {notification_policy: 'all'}})
  time.now++
  const retryAll = {...retry, idempotency_key: 'retry-all-000000001'}
  const result = feature.ops.retry(retryAll)
  assert.equal(feature.ops.retry(retryAll).run.id, result.run.id)
  await settled()
  assert.deepEqual((await list()).items.slice(0, 1).map(item => [item.run_id, item.status]), [[result.run.id, 'failed']])
  assert.equal((await list()).unread_count, 4)
})

test('sample and manual receipts are opt-in, and private reads are exact and scoped', async (t) => {
  const {feature, active, time, create, list, read, settled} = fixture(t)
  const {automation: ordinary} = create('Ordinary')
  feature.ops.runNow({workspace_id: PERSONAL, id: ordinary.id, idempotency_key: 'ordinary-manual-0001'})
  const daily = {kind: 'daily', time: '09:00', time_zone: 'UTC'}
  create('Default sample', {schedule: daily, run_sample: true})
  await settled()
  assert.deepEqual(await list(), {items: [], unread_count: 0})

  const {sample_run: sample} = create('Opt-in sample', {schedule: daily, run_sample: true, notification_policy: 'all'})
  const {automation: receiver} = create('Opt-in manual', {notification_policy: 'all'})
  const manual = {workspace_id: PERSONAL, id: receiver.id, idempotency_key: 'opt-in-manual-0001'}
  const {run: manualRun} = feature.ops.runNow(manual)
  assert.equal(feature.ops.runNow(manual).run.id, manualRun.id)
  await settled()
  time.now++
  const {automation: teamRun} = create('Team brief', {workspace_id: TEAM, enabled: true})
  feature.tick(TEAM)
  await settled()

  const personal = await list(PERSONAL, {limit: 200})
  const team = await list(TEAM, {limit: 1})
  assert.deepEqual(new Set(personal.items.map(item => item.run_id)), new Set([sample.id, manualRun.id]))
  assert.deepEqual(team.items.map(item => item.automation_id), [teamRun.id])
  assert.equal(personal.unread_count, 2)
  const exact = {notification_id: 'automation-run-' + manualRun.id}
  await assert.rejects(list(PERSONAL, {}, {}), {status: 404, code: 'not_found'})
  await assert.rejects(read(PERSONAL, exact, {}), {status: 404})
  await assert.rejects(read(TEAM, exact), {status: 404})
  await assert.rejects(read(PERSONAL, {notification_id: 'automation-run-' + 'c'.repeat(32)}), {status: 404})
  await assert.rejects(read(PERSONAL, {...exact, all: true}), {status: 400})
  await assert.rejects(list(PERSONAL, {limit: 201}), {status: 400})
  await assert.rejects(list(PERSONAL, {unread: 'true'}), {status: 400})

  const firstRead = await read(PERSONAL, exact)
  assert.equal(firstRead.unread_count, 1)
  const seen = feature.db.prepare('SELECT read_at FROM ot_automation_run_notices WHERE run_id=?')
  const readAt = time.now++
  assert.deepEqual(await read(PERSONAL, exact), firstRead)
  assert.equal(seen.get(manualRun.id).read_at, readAt)
  assert.deepEqual((await list(PERSONAL, {unread: true})).items.map(item => item.run_id), [sample.id])
  assert.equal((await read(PERSONAL, {all: true})).unread_count, 0)
  assert.equal((await list(TEAM)).unread_count, 1)
  active.delete(TEAM)
  await assert.rejects(list(TEAM), {status: 404})
  await assert.rejects(read(TEAM, {all: true}), {status: 404})
  active.add(TEAM)
  assert.equal((await list(TEAM)).unread_count, 1)
})
