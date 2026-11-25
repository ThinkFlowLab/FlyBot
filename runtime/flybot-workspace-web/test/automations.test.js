import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { dueAt, nextScheduledSlot, validSchedule, zonedEpoch } from '../features/automations/schedule.js'
import { createAutomations, dsBotTurn } from '../features/automations/automations.js'
import { TEMPLATES } from '../features/automations/templates.js'
import { featureHost, loadFeatures, registerFeature } from '../src/features.js'
import artifactsFeature from '../features/artifacts/index.js'
import { attachRuntime, detachRuntime } from '../src/host.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const W = 'a'.repeat(32)
const flush = () => new Promise((r) => setImmediate(r))

function fixture(turn, at = 1_800_000_000, saveArtifact, readMeetingAction, readMemoryAction) {
  const clock = { now: at }
  const calls = []
  const dbPath = join(mkdtempSync(join(tmpdir(), 'ot-auto-')), 'a.sqlite3')
  const feature = createAutomations({
    personalBinding: async () => ({workspace_id: W}),
    saveArtifact,
    readMeetingAction,
    readMemoryAction,
    db: new DatabaseSync(dbPath), clock: () => clock.now, log: () => {},
    turn: turn ?? (async (args) => { calls.push(args); return { text: 'DS-Bot did it', model: 'm', session_id: 's1', turn_id: 't1', bot_id: 'bot1', model_calls: 1 } }),
  })
  return { feature, clock, calls, dbPath, e: feature.endpoints }
}

test('signed task drafting uses the scoped native model and returns only editable authoring fields', async t => {
  const db = new DatabaseSync(':memory:')
  t.after(() => db.close())
  const first = Promise.withResolvers()
  const queried = []
  const feature = createAutomations({
    db,
    turn: () => assert.fail('drafting started an automation'),
    async requireWorkspace(workspace) {
      if (workspace !== W) throw Object.assign(new Error('Workspace unavailable'), {status:404})
    },
    draftRuntime: () => ({
      backgroundTextOnly(description, {system}) {
        queried.push(description)
        assert.match(system, /do not perform the task/)
        return queried.length === 1 ? first.promise : 'incomplete JSON'
      },
    }),
  })
  const context = username => ({request:new Request('http://fixture', {headers:{'x-ot-owner-username':username}})})
  const draft = (workspace, description, username = 'alice') => feature.ops.v1({
    method:'POST', path:`/v1/workspaces/${workspace}/automations/draft`, body:{description},
  }, context(username))
  assert.equal((await draft(W, '编写周报', '')).status, 403)
  assert.equal((await draft('b'.repeat(32), '编写周报')).status, 404)
  assert.equal((await draft(W, ' ')).status, 400)
  assert.deepEqual(queried, [])
  const accepted = draft(W, '  编写周报  ')
  await flush()
  assert.equal((await draft(W, '另一个草稿')).status, 429)
  first.resolve(JSON.stringify({title:'整理周报', prompt:'写一份进展摘要。', schedule:{kind:'daily'}, enabled:true}))
  assert.deepEqual(await accepted, {status:200,body:{
    draft:{title:'整理周报',prompt:'写一份进展摘要。'}, workspace_id:W, viewer_username:'alice',
  }})
  assert.deepEqual(queried, ['编写周报'])
  assert.equal((await draft(W, '无效的模型回复')).status, 502)
  assert.equal((await draft(W, '允许重试')).status, 502)
  assert.deepEqual(feature.endpoints['automations/list']({workspace_id:W}).items, [])
})

test('meeting follow-up verifies exact source, coalesces concurrent saves, and retains its original action', async () => {
  const MEETING = 'b'.repeat(32)
  const reference = { meeting_id: MEETING, revision: 2, action_index: 0 }
  const snapshot = Promise.withResolvers()
  const reads = []
  let nextRead
  const { e, calls } = fixture(undefined, undefined, undefined, async (workspace, ref) => {
    reads.push({workspace, ref})
    assert.deepEqual(ref, reference)
    if (workspace !== W) return {status: 404}
    const reply = nextRead ?? snapshot.promise
    nextRead = undefined
    return reply
  })
  const payload = {workspace_id: W, title: '跟进验收记录', participants: ['alice'], template_id: 'custom',
    schedule: {kind:'now', time_zone:'UTC'}, enabled: true, source_meeting: {...reference, text:'伪造的来源内容'},
    idempotency_key: 'save-meeting-followup-001'}
  const create = options => e['automations/create']({...payload, ...options})
  const lookup = (workspace, username) => e['automations/v1']({
    method:'GET', path:`/v1/workspaces/${workspace}/automations?meeting=${MEETING}&revision=2&action=0`,
  }, {request:new Request('https://example.test', {headers:{'x-ot-owner-username':username}})})
  assert.equal((await lookup(W, '')).status, 403)
  assert.equal(reads.length, 0)
  const draft = lookup(W, 'alice')
  snapshot.resolve({status: 200, body: {
    meeting: {id: MEETING, workspace_id: W, revision: 2, title:'交付例会', transcript:'逐字稿不用于跟进'},
    action: {text:'核对回执', owner:'Alice', done:false, extra:'不应回传的字段'},
  }})
  assert.deepEqual(await draft, {status:200, body:{
    automation:null, viewer_username:'alice',
    meeting:{id:MEETING, workspace_id:W, revision:2, title:'交付例会'},
    action:{index:0, text:'核对回执', owner:'Alice', done:false},
  }})
  assert.equal(reads.length, 1)
  const staleSource = Promise.withResolvers()
  nextRead = staleSource.promise
  const loading = lookup(W, 'alice')
  assert.equal(reads.length, 2)
  const first = create()
  const duplicate = create({title:'另一份草稿', idempotency_key:'save-meeting-followup-002'})
  const [saved, replay] = await Promise.all([first, duplicate])
  assert.equal(saved.status, 201)
  assert.equal(replay.status, 200)
  assert.equal(replay.automation.id, saved.automation.id)
  assert.equal(replay.automation.title, payload.title)
  assert.equal(saved.automation.enabled, false)
  assert.deepEqual(saved.automation.source_meeting, {...reference, title:'交付例会', text:'核对回执', owner:'Alice'})
  staleSource.resolve({status:409})
  assert.deepEqual(await loading, {status:200, body:{automation:saved.automation, viewer_username:'alice'}})
  assert.deepEqual(e['automations/list']({workspace_id:W}).items, [saved.automation])
  const item = e['automations/update']({workspace_id:W, id:saved.automation.id, revision:1, changes:{title:'处理验收回执'}}).automation
  const beforeExisting = reads.length
  assert.deepEqual(await lookup(W, 'alice'), {status:200, body:{automation:item, viewer_username:'alice'}})
  assert.equal(reads.length, beforeExisting)
  assert.equal((await lookup('c'.repeat(32), 'alice')).status, 404)
  await assert.rejects(create({workspace_id:'c'.repeat(32)}), {status:404, code:'automations/meeting_source_unavailable'})
  assert.equal(calls.length, 0)
})

test('a scoped memory action prepares one durable follow-up for its reviewed revision and runs only on request', async () => {
  const actionId = 'b'.repeat(32)
  const otherWorkspace = 'c'.repeat(32)
  const memoryCalls = []
  const firstAction = {id: actionId, workspace_id: W, revision: 2, status: 'open',
    title: '核对简报', notes: '核对发布日期和来源。', due_at: 1_800_001_000}
  let action = firstAction
  let concurrentRead = null
  const {calls, e, feature} = fixture(undefined, undefined, undefined, undefined, async (workspace, id) => {
    memoryCalls.push({workspace, id})
    assert.equal(workspace, W)
    assert.equal(id, actionId)
    return concurrentRead ? concurrentRead.promise : {status: 200, body: {action}}
  })
  const context = username => ({request: new Request('https://example.test', {headers: {'x-ot-owner-username': username}})})
  const collection = workspace => `/v1/workspaces/${workspace}/automations`
  const lookup = (revision, workspace = W, username = 'alice') => e['automations/v1']({
    method: 'GET', path: collection(workspace) + `?memory_action=${actionId}&revision=${revision}`,
  }, context(username))
  const post = (revision, {workspace = W, key = 'save-memory-followup-001', changes = {}, username = 'alice'} = {}) =>
    e['automations/v1']({
      method: 'POST', path: collection(workspace), idempotency_key: key,
      body: {title: '准备已检查的简报', prompt: '只输出两条检查建议。', template_id: 'custom',
        participants: ['alice'], enabled: true, schedule: {kind: 'now', time_zone: 'UTC'},
        source_memory_action: {action_id: actionId, revision}, ...changes},
    }, context(username))

  assert.equal((await lookup(2, W, '')).status, 403)
  assert.equal((await lookup(2, otherWorkspace)).status, 403)
  assert.equal((await post(2, {workspace: otherWorkspace})).status, 403)
  assert.equal((await post(2, {username: ''})).status, 403)
  assert.equal((await post(2, {changes: {run_sample: true}})).body.error.code, 'invalid_sample')
  assert.equal((await post(2, {changes: {source_memory_action: {action_id: actionId, revision: 2, notes: 'forged'}}})).status, 400)
  assert.equal(memoryCalls.length, 0)
  assert.deepEqual((await lookup(2)).body, {automation: null, action: firstAction, viewer_username: 'alice'})
  action = {...firstAction, revision: 3, notes: '本次更新的原始内容。'}
  const stale = await post(2)
  assert.equal(stale.status, 409)
  assert.equal(stale.body.error.code, 'memory_source_unavailable')

  concurrentRead = Promise.withResolvers()
  const first = post(3)
  const second = post(3, {key: 'save-memory-followup-tab-2', changes: {title: '另一标签页的标题'}})
  await flush()
  assert.equal(memoryCalls.length, 4)
  concurrentRead.resolve({status: 200, body: {action}})
  const completed = await Promise.all([first, second])
  concurrentRead = null
  assert.deepEqual(completed.map(result => result.status).sort(), [200, 201])
  const saved = completed.find(result => result.status === 201).body.automation
  assert.equal(completed.find(result => result.status === 200).body.automation.id, saved.id)
  assert.deepEqual(saved.source_memory_action, {
    action_id: actionId, revision: 3, title: action.title, notes: action.notes, due_at: action.due_at,
  })
  assert.equal(saved.enabled, false)
  assert.deepEqual(feature.tick(W), [])
  assert.equal(calls.length, 0)

  action = {...action, revision: 4, status: 'done', notes: 'New private notes'}
  const receipt = await lookup(3)
  assert.deepEqual(receipt.body, {automation: saved, action: null, viewer_username: 'alice'})
  assert.equal((await lookup(4)).status, 409)
  assert.equal((await post(4)).status, 409)
  assert.equal((await post(3)).body.automation.id, saved.id)
  assert.equal(calls.length, 0)
  const linked = (workspace_id = W, action_id = actionId) => feature.ops.memoryFollowupsForAction({workspace_id, action_id})
  assert.deepEqual(await linked(), {items: [{id: saved.id, title: saved.title, revision: 3, enabled: false}]})
  assert.deepEqual(await linked(W, 'e'.repeat(32)), {items: []})
  await assert.rejects(linked(otherWorkspace), /个人工作区/)
  action = {...action, revision: 5, status: 'open'}
  const latest = (await post(5, {key: 'save-later-memory-followup', changes: {title: '准备第二版简报'}})).body.automation
  assert.ok(latest?.id && latest.id !== saved.id)
  assert.deepEqual((await linked()).items.map(item => [item.id, item.revision]), [[latest.id, 5], [saved.id, 3]])
  const items = (await e['automations/v1']({method: 'GET', path: collection(W)}, context('alice'))).body.items
  assert.deepEqual(new Set(items.map(item => item.source_memory_action.revision)), new Set([3, 5]))

  const manual = await e['automations/v1']({
    method: 'POST', path: collection(W) + '/' + saved.id + '/run', idempotency_key: 'run-memory-followup-001',
  }, context('alice'))
  assert.equal(manual.status, 202)
  await flush()
  assert.deepEqual(calls.map(call => call.prompt), [`[FlyBot 自动化 · ${saved.title}]\n${saved.prompt}`])
  assert.deepEqual(e['automations/run']({workspace_id: W, id: saved.id, run_id: manual.body.run.id}).run.result,
    {text: 'DS-Bot did it', model: 'm'})
})

test('the signed recurring preview uses scheduler dates and clock changes without saving or running', async t => {
  const db = new DatabaseSync(':memory:')
  t.after(() => db.close())
  const epoch = text => Date.parse(text) / 1000
  let current = epoch('2026-03-07T05:00:00Z')
  const feature = createAutomations({
    db, clock:() => current,
    turn:() => assert.fail('schedule preview ran the automation'),
    async requireWorkspace(workspace) {
      if (workspace !== W) throw Object.assign(new Error('Workspace unavailable'), {status:404})
    },
  })
  const scope = username => ({request:new Request('http://fixture', {headers:{'x-ot-owner-username':username}})})
  const preview = (schedule, workspace = W, username = 'alice') => feature.ops.v1({
    method:'POST', path:`/v1/workspaces/${workspace}/automations/schedule-preview`, body:{schedule},
  }, scope(username))
  const schedule = {kind:'daily', time:'02:30', time_zone:'America/New_York'}
  assert.equal((await preview(schedule, W, '')).status, 403)
  assert.equal((await preview(schedule, 'b'.repeat(32))).status, 404)
  assert.equal((await preview({...schedule, time_zone:'not-a-zone'})).status, 400)
  const spring = await preview(schedule)
  assert.deepEqual(spring, {status:200, body:{time_zone:schedule.time_zone, workspace_id:W, viewer_username:'alice', slots:[
    {at:epoch('2026-03-07T07:30:00Z'), date:'2026-03-07', weekday:6, time:'02:30'},
    {at:epoch('2026-03-08T07:30:00Z'), date:'2026-03-08', weekday:7, time:'03:30', clock_change:'forward'},
    {at:epoch('2026-03-09T06:30:00Z'), date:'2026-03-09', weekday:1, time:'02:30'},
  ]}})
  current = epoch('2026-10-31T23:00:00Z')
  const autumn = (await preview({...schedule, time:'01:30'})).body.slots
  assert.deepEqual(autumn.map(slot => slot.at), [
    epoch('2026-11-01T05:30:00Z'), epoch('2026-11-02T06:30:00Z'), epoch('2026-11-03T06:30:00Z'),
  ])
  assert.equal(autumn[0].clock_change, 'first')
  current = epoch('2026-02-01T05:00:00Z')
  const months = (await preview({...schedule,kind:'monthly',day:31})).body.slots
  assert.deepEqual(months.map(slot=>slot.date), ['2026-03-31','2026-05-31','2026-07-31'])
  assert.deepEqual(feature.endpoints['automations/list']({workspace_id:W}).items, [])
})

test('next recurring slot follows local weekdays, month lengths and DST', () => {
  const seconds = iso => Date.parse(iso) / 1000
  const weekly = {kind:'weekly', weekday:1, time:'09:00', time_zone:'America/New_York'}
  assert.equal(nextScheduledSlot(weekly, seconds('2027-03-13T16:00:00Z')), seconds('2027-03-15T13:00:00Z'))
  const weekdays = {kind:'weekdays', time:'09:00', time_zone:'UTC'}
  assert.equal(nextScheduledSlot(weekdays, seconds('2027-02-26T09:00:00Z')), seconds('2027-03-01T09:00:00Z'))
  const monthly = {kind:'monthly', day:31, time:'09:00', time_zone:'Asia/Shanghai'}
  assert.equal(nextScheduledSlot(monthly, seconds('2027-03-31T01:00:00Z')), seconds('2027-05-31T01:00:00Z'))
})

test('DST resolves gaps by their actual duration and repeated wall times to the first occurrence', () => {
  const seconds = iso => Date.parse(iso) / 1000
  const daily = {kind:'daily', time:'02:30', time_zone:'Europe/Berlin'}
  const spring = seconds('2027-03-28T01:30:00Z')
  assert.equal(nextScheduledSlot(daily, seconds('2027-03-28T00:00:00Z')), spring)
  assert.equal(dueAt(daily, spring-1), null)
  assert.equal(dueAt(daily, spring), spring)
  assert.equal(nextScheduledSlot(daily, spring), seconds('2027-03-29T00:30:00Z'))
  const fall = seconds('2027-10-31T00:30:00Z')
  assert.equal(nextScheduledSlot(daily, fall-1), fall)
  assert.equal(dueAt(daily, fall+3600), fall)
  assert.equal(nextScheduledSlot(daily, fall), seconds('2027-11-01T01:30:00Z'))
  const halfHour = {kind:'once', date:'2027-10-03', time:'02:15', time_zone:'Australia/Lord_Howe'}
  assert.equal(nextScheduledSlot(halfHour, seconds('2027-10-02T00:00:00Z')), seconds('2027-10-02T15:45:00Z'))
})

test('a corrected clock transition cannot rerun an existing local slot, and paused previews never run', async () => {
  const seconds = iso => Date.parse(iso) / 1000
  const start = seconds('2027-03-27T12:00:00Z')
  const {e, feature, clock, calls} = fixture(undefined, start)
  const common = {workspace_id:W, template_id:'custom', prompt:'Confirm once', participants:['alice']}
  const schedule = {kind:'once', date:'2027-03-28', time:'02:30', time_zone:'Europe/Berlin'}
  const create = (title, key, timing, enabled) => e['automations/create']({...common, title, idempotency_key:key,
    schedule:timing, enabled}).automation
  const daily = create('例行摘要', 'clock-change-daily', {kind:'daily',time:schedule.time,time_zone:schedule.time_zone}, true)
  const paused = create('暂停预览', 'clock-change-paused', schedule, false)
  const migrated = create('已在原时刻运行的计划', 'clock-change-migrated', schedule, true)
  const shifted = seconds('2027-03-28T01:30:00Z')
  const early = seconds('2027-03-28T00:30:00Z')
  const get = id => e['automations/get']({workspace_id:W,id}).automation.schedule_status
  assert.deepEqual(get(paused.id), {state:'paused',at:shifted,clock_change:'forward'})
  const inject = feature.db.prepare(`INSERT INTO ot_automation_runs
    (id,automation_id,workspace_id,due_at,started,finished,status,dispatch)
    VALUES(?,?,?,?,?,?,'succeeded','{}')`)
  inject.run('f'.repeat(32), migrated.id, W, early, early, early+1)
  clock.now = early+1
  assert.deepEqual(get(migrated.id), {state:'once_triggered'})
  assert.deepEqual(get(daily.id), {state:'scheduled',at:shifted,clock_change:'forward'})
  assert.deepEqual(feature.tick(), [])
  clock.now = shifted
  assert.deepEqual(feature.tick().map(run => run.automation_id), [daily.id])
  await Promise.all(feature.inflight.values())
  assert.equal(calls.length, 1)
  clock.now += 3600
  assert.deepEqual(feature.tick(), [])
  assert.deepEqual(get(daily.id), {state:'scheduled',at:seconds('2027-03-29T00:30:00Z')})
  assert.deepEqual(get(paused.id), {state:'paused'})
  assert.equal(e['automations/runs']({workspace_id:W,id:paused.id}).items.length,0)

  clock.now = seconds('2027-10-30T12:00:00Z')
  const lateFold = create('按旧时刻已完成', 'clock-change-late-fold', {kind:'once',date:'2027-10-31',
    time:schedule.time,time_zone:schedule.time_zone}, true)
  const later = seconds('2027-10-31T01:30:00Z')
  inject.run('e'.repeat(32), lateFold.id, W, later, later, later+1)
  clock.now = later+1
  assert.deepEqual(get(lateFold.id), {state:'once_triggered'})
  assert.ok(!feature.tick().some(run => run.automation_id===lateFold.id))
  await Promise.all(feature.inflight.values())
})

test('scheduler projections distinguish one-time trigger, pause, and the next slot after execution', async () => {
  const at = Date.parse('2027-02-26T09:00:00Z') / 1000
  const {e, feature, clock} = fixture(undefined, at)
  const daily = {kind:'weekdays', time:'09:00', time_zone:'UTC'}
  const once = {kind:'now', time_zone:'UTC'}
  const create = (title, schedule, enabled) => e['automations/create']({workspace_id:W, title, schedule, enabled,
    prompt:'Record a result', template_id:'custom', participants:['alice'], idempotency_key:`fixture-key-for-${title}`}).automation
  const recurring = create('Recurring',daily,true)
  const single = create('Single',once,true)
  const paused = create('Paused',daily,false)
  assert.deepEqual(recurring.schedule_status, {state:'due'})
  assert.deepEqual(single.schedule_status, {state:'due'})
  assert.deepEqual(paused.schedule_status, {state:'paused'})
  const fired = feature.tick(W)
  assert.equal(fired.length,2)
  await Promise.all(feature.inflight.values())
  const status = id => e['automations/get']({workspace_id:W,id}).automation.schedule_status
  assert.deepEqual(status(single.id), {state:'once_triggered'})
  const next = {state:'scheduled', at:Date.parse('2027-03-01T09:00:00Z') / 1000}
  assert.deepEqual(status(recurring.id),next)
  assert.deepEqual(e['automations/runs']({workspace_id:W,id:recurring.id}).schedule_status,next)
  const {items} = e['automations/list']({workspace_id:W,category:'mine',username:'alice'})
  assert.deepEqual(items.find(item => item.id === recurring.id).schedule_status,next)
  clock.now = next.at
  assert.deepEqual(status(recurring.id), {state:'due'})
})

test('the exact native run and history expose its durable saved work after rename and deletion', async () => {
  const table = {}
  const host = featureHost({name: 'artifacts', identity: {instanceId: W},
    dataDir: mkdtempSync(join(tmpdir(), 'ot-auto-artifacts-')), table})
  const artifacts = artifactsFeature(host)
  registerFeature(table, 'artifacts', artifacts)
  const feature = createAutomations({
    db: new DatabaseSync(':memory:'),
    turn: async () => ({text:'DS-Bot did it'}),
    saveArtifact: payload => host.call('artifacts/saveAutomationRun', payload),
    readSavedWorks: payload => host.call('artifacts/savedAutomationWorks', payload),
  })
  const e = feature.endpoints
  const {automation} = e['automations/create']({workspace_id: W, title: '保存工作简报', participants: ['alice'],
    template_id: 'custom', schedule: {kind: 'now', time_zone: 'UTC'},
    prompt: 'Summarize the day.', idempotency_key: 'create-save-run-001'})
  const {run} = e['automations/runNow']({workspace_id: W, id: automation.id, idempotency_key: 'start-save-run-001'})
  await feature.inflight.get(run.id)
  const runsPath = `/v1/workspaces/${W}/automations/${automation.id}/runs`
  const path = runsPath + '/' + run.id + '/artifact'
  const read = path => e['automations/v1']({method:'GET', path})
  const save = () => e['automations/v1']({method: 'POST', path, body: {body: 'caller cannot override output'}})
  const exact = () => read(runsPath + '/' + run.id)
  assert.equal((await exact()).body.run.saved_work, null)
  const first = await save()
  assert.equal(first.status, 201)
  const {artifact} = first.body
  assert.equal(artifact.body, 'DS-Bot did it')
  assert.equal(artifact.source.kind, 'automation_run')
  assert.equal(artifact.source.id, run.id)
  assert.equal(artifact.source.automation_id, automation.id)
  const receipt = {id:artifact.id, title:artifact.title}
  assert.deepEqual((await exact()).body.run.saved_work, receipt)
  assert.deepEqual((await read(runsPath + '?limit=1')).body.items[0].saved_work, receipt)
  const repeat = await save()
  assert.equal(repeat.status, 200)
  assert.equal(repeat.body.artifact.id, artifact.id)
  assert.equal((await e['automations/v1']({method: 'GET', path})).status, 405)
  assert.equal((await e['automations/v1']({method: 'POST', path: path.replace(W, 'b'.repeat(32))})).status, 404)
  const ref = {workspace_id:W, automation_id:automation.id, run_ids:[run.id]}
  assert.deepEqual(await host.call('artifacts/savedAutomationWorks', {...ref, automation_id:'b'.repeat(32)}), {items:[]})
  assert.deepEqual(await host.call('artifacts/savedAutomationWorks', {...ref, workspace_id:'b'.repeat(32)}), {items:[]})
  await assert.rejects(() => artifacts.endpoints.savedAutomationWorks(ref), {status:404})
  await assert.rejects(() => artifacts.endpoints.saveAutomationRun({}, {internal: false}), /Save results/)
  const work = `/v1/workspaces/${W}/artifacts/${artifact.id}`
  const edit = (path, body) => table['artifacts/v1']({method:'POST', path, body})
  assert.equal((await edit(work, {revision:1, changes:{title:'重命名的结果'}})).status, 200)
  assert.deepEqual((await exact()).body.run.saved_work, {...receipt, title:'重命名的结果'})
  assert.equal((await edit(work + '/remove', {})).status, 200)
  assert.equal((await exact()).body.run.saved_work, null)
  assert.equal((await read(runsPath)).body.items[0].saved_work, null)
  const replacement = await save()
  assert.equal(replacement.status, 201)
  assert.notEqual(replacement.body.artifact.id, artifact.id)
  assert.equal((await exact()).body.run.saved_work.id, replacement.body.artifact.id)
})

test('team publication reviews only the stored output and recovers a lost share without a duplicate', async () => {
  const collection = `/v1/workspaces/${W}/studio/documents`
  const documents = new Map()
  const writes = []
  let denied = false, loseResponse = true, turns = 0
  const {endpoints: e, inflight} = createAutomations({
    db: new DatabaseSync(':memory:'),
    turn: async () => { turns++; return {text:'完成验收，下一步核对资料。', model:'private-model', session_id:'private-session'} },
    studioRequest: async ({method,path,body}) => {
      if (denied) return {status:404, body:{}}
      if (method === 'GET' && path === collection) return {status:200, body:{items:[]}}
      if (method === 'GET') return {status:[...documents.values()].some(id => path === collection+'/'+id) ? 200 : 404,body:{}}
      assert.equal(path,collection)
      writes.push(body)
      const id = documents.get(body.client_key) || String(documents.size+1).padStart(32,'0')
      documents.set(body.client_key,id)
      if (loseResponse) { loseResponse=false; return {status:503,body:{}} }
      return {status:200,body:{document:{id}}}
    },
  })
  const {automation} = e['automations/create']({
    workspace_id:W,title:'结果验收',prompt:'Private prompt',template_id:'custom',
    participants:['alice'],schedule:{kind:'now',time_zone:'UTC'},idempotency_key:'studio-create-automation',
  })
  const {run} = e['automations/runNow']({workspace_id:W,id:automation.id,idempotency_key:'studio-automation-first-run'})
  await inflight.get(run.id)
  const path = `/v1/workspaces/${W}/automations/${automation.id}/runs/${run.id}/studio`
  const get = () => e['automations/v1']({method:'GET',path})
  const save = body => e['automations/v1']({method:'POST',path,body})
  assert.equal((await e['automations/v1']({method:'GET',path:path.replace(W,'b'.repeat(32))})).status,404)
  assert.equal((await save({review:'0'.repeat(64),body:'should never be published'})).status,400)
  assert.equal((await save({review:'0'.repeat(64)})).body.error.code,'review_changed')
  const preview = (await get()).body
  assert.equal(preview.body,'完成验收，下一步核对资料。')
  assert.match(preview.title,/^结果验收/)
  assert.equal(writes.length,0)
  assert.equal((await save({review:preview.review})).status,503)
  e['automations/update']({workspace_id:W,id:automation.id,revision:1,changes:{title:'私下改名'}})
  assert.deepEqual((await get()).body,preview)
  const retry = await save({review:preview.review})
  assert.equal(retry.status,200)
  assert.equal(documents.size,1)
  assert.deepEqual(writes,[0,1].map(() => ({title:preview.title,body:preview.body,client_key:preview.review})))
  assert.deepEqual((await get()).body,retry.body)
  assert.deepEqual((await save({review:preview.review})).body,retry.body)
  denied = true
  assert.equal((await get()).status,403)
  assert.equal(turns,1)
})

test('schedule slots match the server rules across time zones', () => {
  const zone = 'Asia/Shanghai'
  const nine = zonedEpoch(zone, 2027, 1, 4, 9, 0) // Monday
  assert.equal(nine, Date.UTC(2027, 0, 4, 1, 0) / 1000)
  assert.equal(dueAt({ kind: 'daily', time: '09:00', time_zone: zone }, nine - 1), null)
  assert.equal(dueAt({ kind: 'daily', time: '09:00', time_zone: zone }, nine + 60), nine)
  assert.equal(dueAt({ kind: 'weekly', weekday: 1, time: '09:00', time_zone: zone }, nine + 5), nine)
  assert.equal(dueAt({ kind: 'weekly', weekday: 2, time: '09:00', time_zone: zone }, nine + 5), null)
  assert.equal(dueAt({ kind: 'weekdays', time: '09:00', time_zone: zone }, nine + 5), nine)
  assert.equal(dueAt({ kind: 'monthly', day: 4, time: '09:00', time_zone: zone }, nine + 5), nine)
  assert.equal(dueAt({ kind: 'once', date: '2027-01-04', time: '09:00', time_zone: zone }, nine), nine)
  assert.equal(dueAt({ kind: 'now', time_zone: zone }, nine), 0)
  assert.equal(validSchedule({ kind: 'daily', time: '25:00', time_zone: zone }), false)
  assert.equal(validSchedule({ kind: 'once', date: '2027-02-30', time: '09:00', time_zone: zone }), false)
  assert.equal(validSchedule({ kind: 'daily', time: '09:00', time_zone: 'Nowhere/City' }), false)
  assert.equal(validSchedule({ kind: 'later', date: '2027-02-03', time: '09:00', time_zone: 'UTC' }), true)
})

test('templates stay in step with the Python source', () => {
  const py = readFileSync(join(HERE, '../../../flybot_workspace/automations.py'), 'utf8')
  const ids = [...py.matchAll(/^ {4}'([a-z_]+)': \{/gm)].map((m) => m[1])
  assert.deepEqual(Object.keys(TEMPLATES), ids)
})

test('create is idempotent, titles are unique, updates check revision', async () => {
  const { e } = fixture()
  const body = { workspace_id: W, title: '每日简报', template_id: 'daily_brief', schedule: { kind: 'daily', time: '09:00', time_zone: 'Asia/Shanghai' }, participants: ['alice'], idempotency_key: 'k'.repeat(16) }
  const made = e['automations/create'](body)
  assert.equal(made.status, 201)
  assert.equal(made.automation.enabled, false)
  assert.equal(made.automation.compiled, true)
  assert.match(made.automation.prompt, /每天 09:00/)
  assert.equal(e['automations/create'](body).status, 200)
  assert.throws(() => e['automations/create']({ ...body, title: '别的' }), /different request/)
  assert.throws(() => e['automations/create']({ ...body, idempotency_key: 'j'.repeat(16) }), /already exists/)
  const id = made.automation.id
  const up = e['automations/update']({ workspace_id: W, id, revision: 1, changes: { enabled: true, scope: 'ongoing' } })
  assert.equal(up.automation.revision, 2)
  assert.match(up.automation.prompt, /长期运行/)
  assert.throws(() => e['automations/update']({ workspace_id: W, id, revision: 1, changes: { enabled: false } }), (err) => err.status === 409)
  assert.equal(e['automations/list']({ workspace_id: W, category: 'work' }).items.length, 1)
  assert.equal(e['automations/list']({ workspace_id: W, category: 'life' }).items.length, 0)
  assert.equal(e['automations/list']({ workspace_id: 'b'.repeat(32) }).items.length, 0)
})

test('the mine tab lists saved automations for the signed-in runtime owner', async () => {
  const { e } = fixture()
  const draft = { workspace_id: W, template_id: 'custom', prompt: 'Respond once',
    schedule: { kind: 'now', time_zone: 'UTC' } }
  const { automation } = e['automations/create']({
    ...draft, title: '我的任务', participants: ['alice'], idempotency_key: 'a'.repeat(16),
  })
  e['automations/create']({
    ...draft, title: '其他人的任务', participants: ['bobby'], idempotency_key: 'b'.repeat(16),
  })
  const path = `/v1/workspaces/${W}/automations?category=mine`
  const request = new Request('https://example.test', { headers: { 'x-ot-owner-username': 'Alice' } })
  const result = await e['automations/v1']({ path }, { request })
  assert.equal(result.status, 200)
  assert.deepEqual(result.body.items.map(item => item.id), [automation.id])
})

test('creating a scheduled automation can save it enabled in the same request', async () => {
  const { e } = fixture()
  const request = {
    method: 'POST', path: `/v1/workspaces/${W}/automations`, idempotency_key: 'e'.repeat(16),
    body: { title: '每周检查', template_id: 'custom', prompt: 'Check the report', participants: ['alice'],
      schedule: { kind: 'weekly', weekday: 1, time: '09:00', time_zone: 'UTC' }, enabled: true },
  }
  const created = await e['automations/v1'](request)
  assert.equal(created.status, 201)
  assert.equal(created.body.automation.enabled, true)
  assert.equal(created.body.automation.revision, 1)
  const retried = await e['automations/v1'](request)
  assert.equal(retried.status, 200)
  assert.equal(retried.body.automation.id, created.body.automation.id)
  assert.equal((await e['automations/v1']({...request, body: {...request.body, enabled: false}})).status, 409)
})

test('saving a recurring routine atomically starts one sample and keeps its recurring slot independent', async () => {
  const now = Date.parse('2027-02-26T08:30:00Z') / 1000
  const { e, feature, clock, calls } = fixture(undefined, now)
  const collection = `/v1/workspaces/${W}/automations`
  const payload = {title:'Daily sample', template_id:'daily_brief', participants:['alice'], scope:'ongoing', enabled:true,
    schedule:{kind:'daily', time:'09:00', time_zone:'UTC'}, run_sample:true}
  const save = (body, idempotency_key = 'routine-sample-exact-001') =>
    e['automations/v1']({method:'POST', path:collection, body, idempotency_key})
  const first = await save(payload)
  assert.equal(first.status, 201)
  const {automation, sample_run} = first.body
  assert.equal(sample_run.automation_id, automation.id)
  assert.equal(sample_run.workspace_id, W)
  assert.equal(automation.schedule_status.at, now + 1800)
  const replay = await save(payload)
  assert.equal(replay.status, 200)
  assert.equal(replay.body.sample_run.id, sample_run.id)
  assert.equal((await save({...payload, run_sample:false})).status, 409)
  await flush()
  const exact = e['automations/run']({workspace_id:W, id:automation.id, run_id:sample_run.id}).run
  assert.equal(exact.status, 'succeeded')
  assert.equal(exact.result.text, 'DS-Bot did it')
  assert.equal(calls.length, 1)

  const invalid = await save({...payload, title:'Unscheduled sample', schedule:{kind:'now', time_zone:'UTC'}}, 'routine-sample-invalid-001')
  assert.equal(invalid.status, 400)
  assert.equal(invalid.body.error.code, 'invalid_sample')
  const paused = await save({...payload, title:'Paused sample', enabled:false}, 'routine-sample-paused-001')
  assert.equal(paused.status, 201)
  assert.deepEqual(paused.body.automation.schedule_status, {state:'paused'})
  assert.equal(paused.body.sample_run.automation_id, paused.body.automation.id)
  await flush()
  clock.now += 1800
  const [scheduled] = feature.tick(W)
  assert.equal(scheduled.trigger, 'scheduled')
  assert.equal(scheduled.automation_id, automation.id)
  assert.notEqual(scheduled.id, sample_run.id)
  assert.equal(feature.tick(W).length, 0)
  await flush()
  assert.equal(calls.length, 3)
})

test('a due schedule fires inside DS-Bot once per slot and records the DS-Bot reply', async () => {
  const at = zonedEpoch('UTC', 2027, 1, 4, 9, 0)
  const { e, calls, feature, clock } = fixture(null, at)
  const { automation } = e['automations/create']({ workspace_id: W, title: '提醒', template_id: 'reminder', schedule: { kind: 'daily', time: '09:00', time_zone: 'UTC' }, participants: ['alice'], idempotency_key: 'r'.repeat(16) })
  assert.equal(automation.enabled, true)
  const fired = feature.tick()
  assert.equal(fired.length, 1)
  assert.equal(feature.tick().length, 0, 'same slot never fires twice')
  await Promise.all(feature.inflight.values())
  assert.equal(calls.length, 1)
  assert.equal(calls[0].conversation, `automation:${automation.id}`)
  assert.match(calls[0].prompt, /到点提醒我/)
  const { items } = e['automations/runs']({ workspace_id: W, id: automation.id })
  assert.equal(items[0].status, 'succeeded')
  assert.equal(items[0].trigger, 'scheduled')
  assert.equal(items[0].result.text, 'DS-Bot did it')
  assert.equal(items[0].dispatch.backend, 'ds-bot')
  assert.equal(items[0].dispatch.ds_bot.session_id, 's1')
  clock.now += 86400
  assert.equal(feature.tick().length, 1, 'next day fires again')
})

test('recurring plans use the current activation and skip times elapsed before create, resume or rule change', async () => {
  const at = zonedEpoch('Europe/Paris', 2027, 2, 25, 12, 0)
  const nextSlot = zonedEpoch('Europe/Paris', 2027, 2, 27, 10, 0)
  const {e, feature, clock, dbPath} = fixture(undefined, at)
  const schedule = {kind:'daily', time:'09:00', time_zone:'Europe/Paris'}
  const {automation} = e['automations/create']({
    workspace_id:W, title:'定期简报', template_id:'custom', schedule, participants:['alice'],
    idempotency_key:'new-recurring-brief-001', enabled:true,
  })
  const where = {workspace_id:W, id:automation.id}
  let saved = automation
  const update = changes => {
    saved = e['automations/update']({...where, revision:saved.revision, changes}).automation
  }
  assert.deepEqual(saved.schedule_status, {state:'scheduled', at:zonedEpoch('Europe/Paris', 2027, 2, 26, 9, 0)})
  assert.deepEqual(feature.tick(W), [])
  update({enabled:false})
  clock.now += 86400
  assert.deepEqual(feature.tick(W), [])
  update({enabled:true})
  assert.deepEqual(saved.schedule_status, {state:'scheduled', at:zonedEpoch('Europe/Paris', 2027, 2, 27, 9, 0)})
  update({schedule:{...schedule, time:'10:00'}})
  assert.deepEqual(saved.schedule_status, {state:'scheduled', at:nextSlot})
  assert.deepEqual(feature.tick(W), [])
  assert.deepEqual(e['automations/list']({workspace_id:W}).items[0].schedule_status, saved.schedule_status)
  assert.deepEqual(e['automations/runs'](where).schedule_status, saved.schedule_status)

  clock.now = nextSlot + 60
  update({prompt:'Include the project plan.', enabled:true, schedule:{...schedule, time:'10:00'}})
  assert.deepEqual(saved.schedule_status, {state:'due'})
  feature.db.close()
  const calls = []
  const restored = createAutomations({db: new DatabaseSync(dbPath), clock: () => clock.now,
    turn: async ({prompt}) => { calls.push(prompt); return {text:'saved result'} }})
  try {
    restored.start()
    await Promise.all(restored.inflight.values())
    assert.deepEqual(restored.tick(W), [])
    const {items} = restored.endpoints['automations/runs'](where)
    assert.equal(items.length, 1)
    assert.equal(items[0].due_at, nextSlot)
    assert.equal(items[0].status, 'succeeded')
    assert.match(calls[0], /Include the project plan/)
  } finally {
    restored.stop()
    restored.db.close()
  }
})

test('upgrading an existing automation volume keeps enabled definitions and applies the cutoff when a paused plan resumes', async () => {
  const morning = zonedEpoch('UTC', 2027, 2, 25, 8, 0)
  const scheduled = zonedEpoch('UTC', 2027, 2, 25, 9, 0)
  const {e, feature, clock, dbPath} = fixture(undefined, morning)
  const create = (title, enabled) => e['automations/create']({
    workspace_id:W, title, template_id:'custom', schedule:{kind:'daily', time:'09:00', time_zone:'UTC'},
    participants:['alice'], idempotency_key:`volume-migration-${title}`, enabled,
  }).automation
  const enabled = create('existing-enabled', true)
  const paused = create('existing-paused', false)
  feature.db.exec('ALTER TABLE ot_automations DROP COLUMN schedule_active_at')
  feature.db.close()
  clock.now = scheduled + 120
  const restored = createAutomations({db: new DatabaseSync(dbPath), clock: () => clock.now,
    turn: async () => ({text:'migration result'})})
  try {
    const result = restored.endpoints['automations/update']({workspace_id:W, id:paused.id,
      revision:paused.revision, changes:{enabled:true}})
    assert.deepEqual(result.automation.schedule_status, {state:'scheduled', at:scheduled + 86400})
    const fired = restored.tick(W)
    assert.deepEqual(fired.map(item => item.automation_id), [enabled.id])
    await Promise.all(restored.inflight.values())
    assert.deepEqual(restored.tick(W), [])
    assert.deepEqual(restored.endpoints['automations/get']({workspace_id:W,id:enabled.id}).automation.schedule_status,
      {state:'scheduled', at:scheduled + 86400})
  } finally {
    restored.db.close()
  }
})

test('automations keep running after 200 historical runs and preserve keyset history and artifact sources', async () => {
  const at = zonedEpoch('UTC', 2027, 1, 4, 9, 0)
  const {e, feature} = fixture(null, at, async source => ({status: 201, artifact: {source}}))
  const {automation} = e['automations/create']({workspace_id: W, title: '长期运行', template_id: 'reminder',
    schedule: {kind: 'daily', time: '09:00', time_zone: 'UTC'}, participants: ['alice'], idempotency_key: 'g'.repeat(16)})
  const context = {workspace_id: W, id: automation.id}
  const insert = feature.db.prepare(`INSERT INTO ot_automation_runs
    (id,automation_id,workspace_id,due_at,started,finished,status,error_code,dispatch)
    VALUES(?,?,?,?,?,?,?,?,?)`)
  const prior = []
  feature.db.exec('BEGIN')
  for (let i = 1; i <= 240; i++) {
    const id = i.toString(16).padStart(32, '0')
    const start = at - 1000 + Math.floor(i / 4)
    const status = i % 3 === 0 ? 'failed' : 'succeeded'
    const error = i % 9 === 0 ? 'cancelled' : i % 6 === 0 ? 'timeout' : status === 'failed' ? 'runtime_failed' : null
    const due = i % 2 === 0 ? -i : at - 86400 - i
    const resultText = 'Historical output ' + i
    prior.push({id, started: start, status: ['cancelled','timeout'].includes(error) ? error : status, resultText})
    const dispatch = JSON.stringify({backend: 'ds-bot', result: {text: resultText}})
    insert.run(id, automation.id, W, due, start, start + 1, status, error, dispatch)
  }
  feature.db.exec('COMMIT')

  const [scheduled] = feature.tick()
  assert.equal(scheduled?.trigger, 'scheduled')
  await feature.inflight.get(scheduled.id)
  assert.equal(feature.tick().length, 0)

  const manualRequest = {...context, idempotency_key: 'm'.repeat(16)}
  const manual = e['automations/runNow'](manualRequest)
  assert.equal(manual.status, 202)
  await feature.inflight.get(manual.run.id)
  assert.equal(e['automations/runNow'](manualRequest).run.id, manual.run.id)

  const retryRequest = {...context, run_id: prior[2].id, idempotency_key: 'r'.repeat(16)}
  const retry = e['automations/retry'](retryRequest)
  assert.equal(retry.status, 201)
  await feature.inflight.get(retry.run.id)
  assert.equal(e['automations/retry'](retryRequest).run.id, retry.run.id)

  const [oldest] = prior
  const archived = await e['automations/saveRun']({...context, run_id: oldest.id})
  assert.deepEqual(archived.artifact.source, {
    workspace_id: W, automation_id: automation.id, automation_title: automation.title, run_id: oldest.id, body: oldest.resultText,
  })
  const newest = [scheduled.id, manual.run.id, retry.run.id].map(run_id => e['automations/run']({...context, run_id}).run)
  assert.deepEqual(newest.map(row => row.status), ['succeeded', 'succeeded', 'succeeded'])
  const readAll = status => {
    const items = []
    let cursor
    do {
      const page = e['automations/runs']({...context, limit: 19, status, cursor})
      items.push(...page.items.map(run => run.id))
      cursor = page.cursor
    } while (cursor)
    return items
  }
  const ordered = [...prior, ...newest].sort((a, b) => b.started - a.started || b.id.localeCompare(a.id))
  assert.deepEqual(readAll(), ordered.map(run => run.id))
  assert.deepEqual(readAll('failed'), ordered.filter(run => ['failed','timeout'].includes(run.status)).map(run => run.id))
  assert.deepEqual(readAll('cancelled'), ordered.filter(run => run.status === 'cancelled').map(run => run.id))
  assert.deepEqual(readAll('active'), [])
})

test('manual execution queues only the named automation and leaves its scheduled slot free', async () => {
  let finishTurn
  const calls = []
  const { e, feature } = fixture(args => new Promise(resolve => { calls.push(args); finishTurn = resolve }))
  const draft = {workspace_id: W, template_id: 'custom', prompt: 'Respond once', participants: ['alice'],
    schedule: {kind: 'now', time_zone: 'UTC'}}
  const {automation: target} = e['automations/create']({...draft, title: '手动', idempotency_key: 'm'.repeat(16)})
  const {automation: other} = e['automations/create']({...draft, title: '其他', idempotency_key: 'o'.repeat(16)})
  const req = {method: 'POST', path: `/v1/workspaces/${W}/automations/${target.id}/run`,
    body: {}, idempotency_key: 'q'.repeat(16)}
  const receipt = {...req, method: 'GET', body: undefined}
  assert.deepEqual((await e['automations/v1'](receipt)).body, {run: null})
  assert.equal(calls.length, 0, 'checking the receipt cannot queue a run')
  const accepted = await e['automations/v1'](req)
  assert.equal(accepted.status, 202)
  assert.equal(accepted.body.run.trigger, 'manual')
  assert.equal(accepted.body.run.status, 'running')
  assert.deepEqual((await e['automations/v1'](receipt)).body.run, accepted.body.run)
  assert.deepEqual((await e['automations/v1']({...receipt, path: receipt.path.replace(target.id, other.id)})).body, {run: null})
  assert.equal((await e['automations/v1']({...receipt, path: receipt.path.replace(W, 'b'.repeat(32))})).status, 404)
  const runsPath = `/v1/workspaces/${W}/automations/${target.id}/runs`
  const detail = await e['automations/v1']({method: 'GET', path: runsPath + '/' + accepted.body.run.id})
  assert.equal(detail.body.run.status, 'running')
  assert.equal((await e['automations/v1']({method: 'GET', path: runsPath + '?status=running'})).body.items[0].id, accepted.body.run.id)
  assert.equal((await e['automations/v1']({method: 'GET', path: runsPath + '?status=active'})).body.items[0].id, accepted.body.run.id)
  const activeRun = {id:accepted.body.run.id, automation_id:target.id, workspace_id:W, status:'running'}
  assert.deepEqual((await e['automations/v1']({method: 'GET', path: runsPath + '?status=queued'})).body,
    {items: [], cursor: null, has_pending: true, active_run:activeRun, schedule_status: {state:'paused'}, schedule_revision: 1})
  assert.deepEqual(e['automations/get']({workspace_id:W,id:target.id}).automation.active_run, activeRun)
  assert.deepEqual(e['automations/list']({workspace_id:W}).items.find(item => item.id === target.id).active_run, activeRun)
  assert.equal(e['automations/get']({workspace_id:W,id:other.id}).automation.active_run, undefined)
  assert.equal((await e['automations/v1'](req)).body.run.id, accepted.body.run.id)
  assert.equal((await e['automations/v1']({...req, idempotency_key: 'x'.repeat(16)})).status, 409)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].conversation, `automation:${target.id}`)
  assert.equal(e['automations/runs']({workspace_id: W, id: other.id}).items.length, 0)
  assert.equal(e['automations/get']({workspace_id: W, id: target.id}).automation.enabled, false)
  e['automations/update']({workspace_id: W, id: target.id, revision: 1, changes: {enabled: true}})
  assert.equal(feature.tick().length, 0, 'the pending manual run holds the automation until it finishes')
  finishTurn({text: '完成'})
  await Promise.all(feature.inflight.values())
  assert.equal(feature.tick().length, 1)
  await flush()
  finishTurn({text: '定时完成'})
  await Promise.all(feature.inflight.values())
  assert.equal(e['automations/runs']({workspace_id: W, id: target.id}).items.length, 2)
})

test('retry is idempotent and a running turn cannot be duplicated', async () => {
  let fail = true
  let release
  const { e, feature } = fixture(async () => {
    if (fail) throw Object.assign(new Error('x'), { code: 'flybot-workspace/runtime-unavailable' })
    await new Promise((r) => { release = r })
    return { text: 'ok' }
  })
  const { automation } = e['automations/create']({ workspace_id: W, title: '现在', template_id: 'custom', prompt: 'do it', schedule: { kind: 'now', time_zone: 'UTC' }, participants: ['alice'], idempotency_key: 'n'.repeat(16) })
  e['automations/update']({ workspace_id: W, id: automation.id, revision: 1, changes: { enabled: true } })
  feature.tick()
  await Promise.all(feature.inflight.values())
  const [failed] = e['automations/runs']({ workspace_id: W, id: automation.id }).items
  assert.equal(failed.status, 'failed')
  assert.equal(failed.error_code, 'runtime_unavailable')
  fail = false
  const retry = {workspace_id: W, id: automation.id, run_id: failed.id, idempotency_key: 'x'.repeat(16)}
  const receipt = {method: 'GET', path: `/v1/workspaces/${W}/automations/${automation.id}/runs/${failed.id}/retry`,
    idempotency_key: retry.idempotency_key}
  assert.deepEqual((await e['automations/v1'](receipt)).body, {run: null})
  const retried = e['automations/retry'](retry)
  assert.equal(retried.status, 201)
  assert.equal(retried.run.status, 'running')
  assert.equal(retried.run.trigger, 'retry')
  assert.equal(retried.run.retry_of, failed.id)
  assert.deepEqual(e['automations/run'](retry).run.latest_retry, {id:retried.run.id,status:'running'})
  assert.equal((await e['automations/v1'](receipt)).body.run.id, retried.run.id)
  assert.equal(e['automations/retry'](retry).run.id, retried.run.id)
  const anotherRetry = {...retry, idempotency_key: 'y'.repeat(16)}
  assert.throws(() => e['automations/retry'](anotherRetry), error => error.code === 'automations/already_running')
  const manual = {workspace_id: W, id: automation.id, idempotency_key: 'm'.repeat(16)}
  assert.throws(() => e['automations/runNow'](manual), error => error.code === 'automations/already_running')
  await flush()
  const running = {workspace_id: W, id: automation.id, run_id: retried.run.id}
  assert.equal(e['automations/run'](running).run.status, 'running')
  assert.equal(e['automations/retry'](retry).run.id, retried.run.id)
  release()
  await Promise.all(feature.inflight.values())
  assert.equal(e['automations/run'](running).run.status, 'succeeded')
  assert.equal((await e['automations/v1'](receipt)).body.run.status, 'succeeded')
  assert.equal(e['automations/runs'](running).has_pending, false)
  const read = path => e['automations/v1']({method:'GET',path})
  const runs = `/v1/workspaces/${W}/automations/${automation.id}/runs`
  assert.deepEqual((await read(runs+'?status=failed')).body.items[0].latest_retry, {id:retried.run.id,status:'succeeded'})
  assert.equal((await read(runs+'/'+retried.run.id)).body.run.retry_of, failed.id)
  assert.equal((await read(runs.replace(W,'b'.repeat(32))+'/'+failed.id)).status,404)
  const newer = e['automations/retry'](anotherRetry)
  await flush()
  release()
  await Promise.all(feature.inflight.values())
  assert.deepEqual((await read(runs+'/'+failed.id)).body.run.latest_retry, {id:newer.run.id,status:'succeeded'})

  // History cleanup can remove a run independently of its original retry receipt.
  const remove = feature.db.prepare('DELETE FROM ot_automation_runs WHERE id=?')
  remove.run(newer.run.id)
  assert.equal((await read(runs+'/'+newer.run.id)).status,404)
  assert.deepEqual((await read(runs+'/'+failed.id)).body.run.latest_retry, {id:retried.run.id,status:'succeeded'})
  remove.run(failed.id)
  assert.equal((await read(runs+'/'+failed.id)).status,404)
  assert.equal((await read(runs+'/'+retried.run.id)).body.run.retry_of,undefined)
})

test('stopping a running automation is exact and keeps the native queue held until its turn ends', async () => {
  const stopObserved = Promise.withResolvers()
  const finishStoppedTurn = Promise.withResolvers()
  const calls = []
  const {e,feature} = fixture(async ({requestId,signal}) => {
    calls.push(requestId)
    if (calls.length !== 1) return {text:'Next turn completed'}
    signal.addEventListener('abort', stopObserved.resolve, {once:true})
    await finishStoppedTurn.promise
    return {text:'A late result from the stopped turn'}
  })
  const create = (title, key) => e['automations/create']({workspace_id:W, title, template_id:'custom', prompt:'do it',
    schedule:{kind:'now',time_zone:'UTC'}, participants:['alice'], enabled:false, idempotency_key:key.repeat(16)}).automation
  const first = create('Stop this turn','a'), second = create('Run afterwards','b')
  const start = (automation, key) => e['automations/runNow']({workspace_id:W, id:automation.id, idempotency_key:key.repeat(16)}).run
  const running = start(first,'c'), queued = start(second,'d')
  const path = `/v1/workspaces/${W}/automations/${first.id}/runs/${running.id}`
  const work = feature.inflight.get(running.id)
  const cancel = path => e['automations/v1']({method:'POST',path:path+'/cancel',body:{}})
  await flush()
  try {
    assert.deepEqual(calls,[`ot-automation:${running.id}`])
    assert.equal(queued.status,'queued')
    assert.equal((await cancel(path.replace(W,'f'.repeat(32)))).status,404)
    assert.equal((await cancel(path.replace(first.id,second.id))).status,404)
    const accepted = await cancel(path)
    assert.equal(accepted.status,202)
    assert.equal(accepted.body.run.status,'running')
    assert.equal(accepted.body.run.stop_requested,true)
    await stopObserved.promise
    assert.deepEqual(await cancel(path),accepted)
    assert.equal(e['automations/runs']({workspace_id:W,id:first.id,status:'active'}).active_run.stop_requested,true)
    assert.equal(e['automations/run']({workspace_id:W,id:second.id,run_id:queued.id}).run.status,'queued')
  } finally {
    finishStoppedTurn.resolve()
  }
  await work
  await Promise.all(feature.inflight.values())
  const stopped = e['automations/run']({workspace_id:W,id:first.id,run_id:running.id}).run
  assert.equal(stopped.status,'cancelled')
  assert.equal(stopped.stop_requested,undefined)
  assert.deepEqual(stopped.result,{cancelled:true})
  assert.equal((await cancel(path)).body.run.status,'cancelled')
  assert.equal(e['automations/run']({workspace_id:W,id:second.id,run_id:queued.id}).run.status,'succeeded')
  assert.deepEqual(calls,[`ot-automation:${running.id}`,`ot-automation:${queued.id}`])
})

test('startup interrupts claimed turns and resumes only previously unclaimed runs', async t => {
  const {e, feature, dbPath, clock} = fixture()
  const draft = {workspace_id: W, template_id: 'custom', prompt: 'Respond once', participants: ['alice'],
    schedule: {kind: 'now', time_zone: 'UTC'}}
  const {automation: first} = e['automations/create']({...draft, title: 'Interrupted', idempotency_key: 'i'.repeat(16)})
  const {automation: second} = e['automations/create']({...draft, title: 'Waiting', idempotency_key: 'w'.repeat(16)})
  const {automation: third} = e['automations/create']({...draft, title: 'Cancelled', idempotency_key: 'c'.repeat(16)})
  const {automation: fourth} = e['automations/create']({...draft, title: 'Stop already requested', idempotency_key: 's'.repeat(16)})
  const claimedId = 'c'.repeat(32), queuedId = 'd'.repeat(32), cancelledId = 'e'.repeat(32)
  const stoppingId = 'f'.repeat(32)
  const insert = feature.db.prepare(`INSERT INTO ot_automation_runs
    (id,automation_id,workspace_id,due_at,started,status,dispatch,claimed_at)
    VALUES(?,?,?,0,?,'queued','{"backend":"ds-bot"}',?)`)
  insert.run(claimedId, first.id, W, clock.now, clock.now)
  insert.run(queuedId, second.id, W, clock.now, null)
  insert.run(cancelledId, third.id, W, clock.now, null)
  insert.run(stoppingId, fourth.id, W, clock.now, clock.now)
  feature.db.prepare('UPDATE ot_automation_runs SET stop_requested_at=? WHERE id=?').run(clock.now,stoppingId)
  feature.db.close()

  clock.now += 20
  const calls = []
  const restored = createAutomations({db: new DatabaseSync(dbPath), clock: () => clock.now,
    turn: async args => { calls.push(args); return {text: 'Recovered queued run'} }})
  t.after(() => { restored.stop(); restored.db.close() })
  const interrupted = restored.ops.run({workspace_id: W, id: first.id, run_id: claimedId}).run
  assert.equal(interrupted.status, 'failed')
  assert.equal(interrupted.error_code, 'interrupted')
  assert.equal(interrupted.finished, clock.now)
  assert.equal(restored.ops.runs({workspace_id: W, id: first.id}).has_pending, false)
  const queued = restored.ops.runs({workspace_id: W, id: second.id, status: 'queued'}).items[0]
  assert.equal(queued.id, queuedId)
  assert.equal(queued.automation_revision,undefined)
  assert.equal(restored.ops.cancel({workspace_id: W, id: third.id, run_id: cancelledId}).run.status, 'cancelled')
  assert.equal(restored.ops.run({workspace_id: W, id: fourth.id, run_id: stoppingId}).run.status, 'cancelled')
  restored.start()
  restored.start()
  await Promise.all(restored.inflight.values())
  assert.deepEqual(calls.map(item => item.requestId), [`ot-automation:${queuedId}`])
  const result = restored.ops.run({workspace_id: W, id: second.id, run_id: queuedId}).run
  assert.equal(result.status,'succeeded')
  assert.equal(result.automation_revision,1)
  assert.deepEqual(restored.db.prepare('SELECT run_id,status FROM ot_automation_run_notices ORDER BY run_id').all()
    .map(row => [row.run_id, row.status]), [[claimedId, 'interrupted'], [queuedId, 'succeeded']])
})

test('explicit runs and retries refuse stale settings while replaying an accepted attempt', async () => {
  const calls = []
  const {e,feature} = fixture(async invocation => {
    calls.push(invocation)
    if (calls.length === 1) throw Error('First attempt failed')
    return {text:'Retried after review'}
  })
  const created = e['automations/create']({workspace_id:W, template_id:'custom', title:'Review settings',
    prompt:'Original task instructions', participants:['alice'], schedule:{kind:'now',time_zone:'UTC'},
    idempotency_key:'review-settings-create'}).automation
  const path = `/v1/workspaces/${W}/automations/${created.id}`
  const send = (suffix, revision, key) => e['automations/v1']({method:'POST',path:path+suffix,
    body:{expected_revision:revision},idempotency_key:key})
  const started = await send('/run',1,'review-first-attempt')
  assert.equal(started.status,202)
  await Promise.all(feature.inflight.values())
  const original = started.body.run
  const retryPath = '/runs/'+original.id+'/retry'
  const update = (revision,prompt) => e['automations/update']({workspace_id:W,id:created.id,revision,changes:{prompt}})
  update(1,'Reviewed task revision two')
  const staleRetry = await send(retryPath,1,'review-rejected-retry')
  assert.equal(staleRetry.status,409)
  assert.equal(staleRetry.body.error.code,'run_revision_changed')
  assert.deepEqual(staleRetry.body.error.current,{revision:2})
  const staleManual = await send('/run',1,'review-rejected-manual')
  assert.equal(staleManual.status,409)
  assert.equal(staleManual.body.error.code,'run_revision_changed')
  assert.equal((await send(retryPath,'2','review-invalid-retry')).status,400)
  assert.equal(calls.length,1)
  assert.equal(e['automations/runs']({workspace_id:W,id:created.id}).items.length,1)

  const retryKey = 'review-approved-retry'
  const accepted = await send(retryPath,2,retryKey)
  assert.equal(accepted.status,201)
  assert.equal(accepted.body.run.automation_revision,2)
  assert.equal(accepted.body.run.retry_of,original.id)
  await Promise.all(feature.inflight.values())
  update(2,'Later task revision three')
  const replay = await send(retryPath,2,retryKey)
  assert.equal(replay.status,200)
  assert.equal(replay.body.run.id,accepted.body.run.id)
  assert.equal(replay.body.run.status,'succeeded')
  const receipt = await e['automations/v1']({method:'GET',path:path+retryPath,idempotency_key:retryKey})
  assert.deepEqual(receipt.body,replay.body)
  assert.deepEqual(calls.map(call => call.prompt.split('\n').at(-1)),[
    'Original task instructions','Reviewed task revision two',
  ])
})

test('queued runs keep their accepted settings revision through edits and a process interruption', async t => {
  const {e, feature, dbPath, clock} = fixture(() => new Promise(() => {}))
  const draft = {workspace_id:W, template_id:'custom', prompt:'Respond once', participants:['alice'],
    schedule:{kind:'now',time_zone:'UTC'}}
  const create = (title, key) => e['automations/create']({...draft,title,idempotency_key:key}).automation
  const first = create('Executing before restart','in-flight-automation')
  const next = create('Waiting before restart','unstarted-automation')
  const run = (id,key) => e['automations/runNow']({workspace_id:W,id,idempotency_key:key}).run
  const running = run(first.id,'first-fixture-run-0001')
  const waiting = run(next.id,'waiting-fixture-run-01')
  assert.equal(running.status,'running')
  assert.equal(waiting.status,'queued')
  assert.deepEqual([...feature.inflight.keys()],[running.id])
  const changed = e['automations/update']({workspace_id:W,id:next.id,revision:1,
    changes:{title:'New name after admission',prompt:'Use the new instructions only in later runs'}}).automation
  await flush()
  feature.stop()
  feature.db.close()

  let runtimeReady = false
  const calls = []
  clock.now += 30
  const restored = createAutomations({db:new DatabaseSync(dbPath),clock:()=>clock.now,runtimeReady:()=>runtimeReady,
    turn:async args => {calls.push(args);return {text:'Recovered the unstarted run'}}})
  t.after(() => {restored.stop();restored.db.close()})
  restored.start()
  assert.equal(restored.inflight.size,0)
  const scope = {workspace_id:W,id:next.id,run_id:waiting.id}
  assert.equal(restored.ops.run(scope).run.status,'queued')
  assert.equal(restored.ops.run({workspace_id:W,id:first.id,run_id:running.id}).run.error_code,'interrupted')
  assert.equal(restored.ops.runNow({workspace_id:W,id:next.id,idempotency_key:'waiting-fixture-run-01'}).run.id,waiting.id)

  runtimeReady = true
  restored.tick()
  await Promise.all(restored.inflight.values())
  assert.deepEqual(calls.map(({requestId,prompt})=>[requestId,prompt]),[
    [`ot-automation:${waiting.id}`,'[FlyBot 自动化 · Waiting before restart]\nRespond once'],
  ])
  assert.equal(restored.ops.run(scope).run.status,'succeeded')
  assert.equal(restored.ops.run(scope).run.automation_revision,1)
  assert.doesNotMatch(JSON.stringify(restored.ops.run(scope)),/Respond once|queued_prompt/)
  assert.equal(restored.db.prepare('SELECT queued_prompt FROM ot_automation_runs WHERE id=?').get(waiting.id).queued_prompt,null)
  const later = restored.ops.runNow({workspace_id:W,id:next.id,idempotency_key:'new-settings-run-0001'}).run
  assert.notEqual(later.id,waiting.id)
  assert.equal(later.automation_revision,changed.revision)
  await Promise.all(restored.inflight.values())
  assert.equal(calls[1].prompt,'[FlyBot 自动化 · New name after admission]\nUse the new instructions only in later runs')
})

test('a cold clock leaves due slots and manual runs unclaimed until a native runtime is available', async t => {
  const at = zonedEpoch('UTC', 2027, 1, 4, 8, 55)
  let time = at, runtimeReady = false
  const calls = []
  const feature = createAutomations({db:new DatabaseSync(':memory:'),clock:()=>time,runtimeReady:()=>runtimeReady,
    turn:async input => {calls.push(input);return {text:'Private native result'}}})
  t.after(() => {feature.stop();feature.db.close()})
  const draft = {workspace_id:W,template_id:'custom',prompt:'Run my own automation',participants:['alice'],
    schedule:{kind:'daily',time:'09:00',time_zone:'UTC'}}
  const create = (title, enabled, key) => feature.ops.create({...draft,title,enabled,idempotency_key:key}).automation
  const daily = create('Start when ready',true,'cold-daily-automation')
  const manual = create('Explicit manual job',false,'cold-manual-automation')
  const cancelled = create('Cancel while cold',false,'cold-cancel-automation')
  const runNow = (id, key) => feature.ops.runNow({workspace_id:W,id,idempotency_key:key}).run
  time += 86400 + 600
  const waiting = runNow(manual.id,'waiting-on-native-run')
  const removing = runNow(cancelled.id,'cancel-while-cold-run')
  feature.start()
  assert.equal(waiting.status,'queued')
  assert.equal(removing.status,'queued')
  assert.deepEqual(feature.ops.runs({workspace_id:W,id:daily.id}).items,[])
  assert.equal(feature.ops.cancel({workspace_id:W,id:cancelled.id,run_id:removing.id}).run.status,'cancelled')
  assert.equal(feature.db.prepare('SELECT queued_prompt FROM ot_automation_runs WHERE id=?').get(removing.id).queued_prompt,null)
  assert.deepEqual(calls,[])

  runtimeReady = true
  const [scheduled] = feature.tick()
  assert.equal(scheduled.due_at,zonedEpoch('UTC',2027,1,5,9,0))
  assert.equal(scheduled.status,'queued')
  assert.equal(feature.tick().length,0)
  while (feature.inflight.size) await Promise.all(feature.inflight.values())
  assert.deepEqual(calls.map(({requestId,skillScope})=>[requestId,skillScope]),[
    [`ot-automation:${waiting.id}`,`automation:${W}:${manual.id}`],
    [`ot-automation:${scheduled.id}`,`automation:${W}:${daily.id}`],
  ])
  assert.equal(feature.tick().length,0)
  assert.equal(feature.ops.runs({workspace_id:W,id:daily.id}).items[0].status,'succeeded')
})

test('pausing cancels only accepted scheduled work that has not started', async () => {
  const calls = []
  const held = Promise.withResolvers()
  const {feature, e} = fixture(async invocation => {
    calls.push(invocation)
    if (calls.length === 1) await held.promise
    return {text:'Finished'}
  })
  const draft = {workspace_id:W, template_id:'custom', prompt:'Run once', participants:['alice'],
    schedule:{kind:'now',time_zone:'UTC'}, enabled:true, notification_policy:'all'}
  const create = (title, key) => e['automations/create']({...draft,title,idempotency_key:key}).automation
  const pause = item => e['automations/update']({workspace_id:W,id:item.id,revision:item.revision,changes:{enabled:false}})
  const lookup = (item, run) => e['automations/run']({workspace_id:W,id:item.id,run_id:run.id}).run
  const blocker = create('Already started', 'pause-blocker-fixture')
  const [running] = feature.tick()
  await flush()
  const scheduled = create('Automatic queued run', 'pause-scheduled-fixture')
  const manual = create('Explicit queued run', 'pause-manual-fixture')
  const explicit = e['automations/runNow']({workspace_id:W,id:manual.id,idempotency_key:'pause-explicit-fixture'}).run
  const [waiting] = feature.tick()
  assert.equal(waiting.automation_id,scheduled.id)
  assert.equal(waiting.status,'queued')
  assert.equal(waiting.trigger,'scheduled')
  assert.equal(pause(blocker).automation.active_run.status,'running')
  assert.equal(pause(manual).automation.active_run.status,'queued')
  const paused = pause(scheduled)
  const cancelled = lookup(scheduled,waiting)
  assert.equal(cancelled.status,'cancelled')
  assert.equal(cancelled.automation_revision,1)
  assert.equal(cancelled.result.cancelled,true)
  assert.match(cancelled.result.error,/暂停/)
  assert.equal(paused.cancelled_scheduled_runs,1)
  assert.equal(paused.automation.active_run,undefined)
  assert.equal(feature.db.prepare('SELECT queued_prompt FROM ot_automation_runs WHERE id=?').get(waiting.id).queued_prompt,null)

  const resumed = e['automations/update']({workspace_id:W,id:scheduled.id,revision:paused.automation.revision,changes:{enabled:true}})
  assert.deepEqual(resumed.automation.schedule_status,{state:'once_cancelled'})
  assert.deepEqual(feature.tick(),[])
  held.resolve()
  while (feature.inflight.size) await Promise.all(feature.inflight.values())
  assert.deepEqual(calls.map(call=>call.requestId),[`ot-automation:${running.id}`,`ot-automation:${explicit.id}`])
  assert.equal(lookup(blocker,running).status,'succeeded')
  assert.equal(lookup(manual,explicit).status,'succeeded')
  assert.equal(lookup(scheduled,waiting).status,'cancelled')
  assert.equal(feature.db.prepare('SELECT COUNT(*) AS n FROM ot_automation_run_notices WHERE run_id=?').get(waiting.id).n,0)
})

test('a resumed recurring automation advances to the next slot after cancelling a queued slot', async () => {
  const before = zonedEpoch('UTC',2027,1,4,8,55)
  const due = zonedEpoch('UTC',2027,1,4,9,0)
  const tomorrow = zonedEpoch('UTC',2027,1,5,9,0)
  const held = Promise.withResolvers()
  const calls = []
  const {feature, e, clock} = fixture(async call => {
    calls.push(call)
    if (calls.length === 1) await held.promise
    return {text:'Finished'}
  },before)
  const draft = {workspace_id:W,template_id:'custom',prompt:'Keep future recurring slots',participants:['alice'],
    schedule:{kind:'daily',time:'09:00',time_zone:'UTC'}}
  const create = (title, key, enabled) => e['automations/create']({...draft,title,enabled,idempotency_key:key}).automation
  const blocker = create('Blocks first slot','recurring-blocker-fixture',false)
  const daily = create('Daily workflow','recurring-paused-fixture',true)
  const running = e['automations/runNow']({workspace_id:W,id:blocker.id,idempotency_key:'recurring-blocker-run'}).run
  clock.now = due
  const [waiting] = feature.tick()
  assert.equal(waiting.status,'queued')
  const change = (revision, enabled) => e['automations/update']({workspace_id:W,id:daily.id,revision,changes:{enabled}})
  assert.equal(change(1,false).cancelled_scheduled_runs,1)
  clock.now++
  assert.deepEqual(change(2,true).automation.schedule_status,{state:'scheduled', at:tomorrow})
  held.resolve()
  while (feature.inflight.size) await Promise.all(feature.inflight.values())
  assert.deepEqual(feature.tick(),[])
  clock.now = tomorrow
  const [next] = feature.tick()
  while (feature.inflight.size) await Promise.all(feature.inflight.values())
  assert.equal(next.due_at,tomorrow)
  assert.deepEqual(calls.map(call=>call.requestId),[`ot-automation:${running.id}`,`ot-automation:${next.id}`])
  assert.deepEqual(e['automations/runs']({workspace_id:W,id:daily.id}).items.map(run=>[run.id,run.status]),[
    [next.id,'succeeded'],[waiting.id,'cancelled'],
  ])
})

test('older pending native rows have unknown delivery and become interrupted after migration', t => {
  const {e, feature, dbPath, clock} = fixture()
  const {automation} = e['automations/create']({workspace_id: W, title: 'Previous owner runtime', template_id: 'custom',
    prompt: 'Check once', participants: ['alice'], schedule: {kind: 'now', time_zone: 'UTC'}, idempotency_key: 'r'.repeat(16)})
  const id = 'f'.repeat(32)
  feature.db.exec(`DROP TRIGGER ot_automation_notice_on_finish; DROP INDEX ot_automation_unclaimed_work;
    ALTER TABLE ot_automation_runs DROP COLUMN claimed_at;
    ALTER TABLE ot_automation_runs DROP COLUMN automation_revision;
    ALTER TABLE ot_automation_runs DROP COLUMN queued_prompt;
    ALTER TABLE ot_automation_runs DROP COLUMN stop_requested_at`)
  feature.db.prepare("INSERT INTO ot_automation_runs VALUES(?,?,?,0,?,NULL,'queued',NULL,'{}',NULL)")
    .run(id, automation.id, W, clock.now)
  feature.db.close()

  const restored = createAutomations({db: new DatabaseSync(dbPath), clock: () => clock.now,
    turn: () => assert.fail('old pending work must not be dispatched')})
  t.after(() => { restored.stop(); restored.db.close() })
  assert.equal(restored.ops.run({workspace_id: W, id: automation.id, run_id: id}).run.error_code, 'interrupted')
  assert.equal(restored.db.prepare('SELECT COUNT(*) AS n FROM ot_automation_run_notices').get().n, 0)
  restored.start()
  assert.equal(restored.inflight.size, 0)
})

test('legacy import is idempotent and never re-fires the already-run slot', () => {
  const at = zonedEpoch('UTC', 2027, 1, 4, 9, 30)
  const { e, feature, calls } = fixture(null, at)
  const row = { id: 'c'.repeat(32), workspace_id: W, title: '迁移', prompt: 'p', template_id: 'custom', schedule: { kind: 'daily', time: '09:00', time_zone: 'UTC' }, participants: [{ username: 'alice' }], enabled: true, revision: 3 }
  assert.equal(e['automations/import']({ automations: [row] }).imported, 1)
  assert.equal(e['automations/import']({ automations: [row] }).imported, 0)
  assert.equal(feature.tick().length, 0)
  assert.equal(calls.length, 0)
  assert.equal(e['automations/get']({ workspace_id: W, id: row.id }).automation.revision, 3)
})

test('the feature loads through the extension point and runs turns via the DS-Bot chatTurn service', async () => {
  process.env.FLYBOT_WORKSPACE_AUTOMATIONS_CLOCK = '0'
  const data = mkdtempSync(join(tmpdir(), 'ot-auto-load-'))
  const { table, loaded } = await loadFeatures({ dir: join(HERE, '../features'), identity: { instanceId: 'e'.repeat(32) }, dataDir: data, log: () => {} })
  assert.ok(loaded.includes('automations'))
  const made = await table['automations/create']({ workspace_id: W, title: 'X', template_id: 'custom', prompt: 'p', schedule: { kind: 'now', time_zone: 'UTC' }, participants: ['alice'], idempotency_key: 'l'.repeat(16) })
  assert.equal(made.status, 201)
  assert.equal((await table['automations/templates']()).items.length, Object.keys(TEMPLATES).length)
  const seen = []
  attachRuntime({ rt: {}, ctx: {}, chatTurn: async (key, text, rid) => { seen.push([key, rid]); return { text: 'hi', sessionId: 's', turnId: 't' } } })
  const turn = dsBotTurn({ runtime: async () => (await import('../src/host.js')).runtime() })
  const reply = await turn({ conversation: 'automation:1', prompt: 'p', requestId: 'r' })
  assert.deepEqual(seen, [['automation:1', 'r']])
  assert.equal(reply.session_id, 's')
  detachRuntime()
  attachRuntime({ rt: {}, ctx: {} })
  await assert.rejects(turn({ conversation: 'c', prompt: 'p' }), (err) => err.code === 'automations/runtime-unavailable')
  detachRuntime()
})



test('v1 lists templates and automations in the legacy /v1 shape', async () => {
  const { e } = fixture()
  const templates = await e['automations/v1']({ method: 'GET', path: '/v1/automation-templates' })
  assert.equal(templates.status, 200)
  assert.ok(templates.body.items.some((item) => item.id === 'custom'))
  const created = await e['automations/v1']({
    method: 'POST', path: `/v1/workspaces/${W}/automations`,
    idempotency_key: 'a'.repeat(20),
    body: { title: '晨报', prompt: '汇总。', template_id: 'custom', schedule: { kind: 'daily', time: '09:00', time_zone: 'Asia/Shanghai' }, participants: ['alice'] },
  })
  assert.equal(created.status, 201, created.body)
  const id = created.body.automation.id
  const listed = await e['automations/v1']({ method: 'GET', path: `/v1/workspaces/${W}/automations` })
  assert.equal(listed.body.items[0].id, id)
  const got = await e['automations/v1']({ method: 'GET', path: `/v1/workspaces/${W}/automations/${id}` })
  assert.equal(got.body.automation.title, '晨报')
  const updated = await e['automations/v1']({ method: 'POST', path: `/v1/workspaces/${W}/automations/${id}`, body: { revision: 1, changes: { enabled: true } } })
  assert.equal(updated.body.automation.enabled, true)
  const unknown = await e['automations/v1']({ method: 'GET', path: `/v1/workspaces/${W}/meetings` })
  assert.equal(unknown.status, 404)
  assert.equal(unknown.body.error.code, 'not_moved')
})

test('official import bundle marks the current slot skipped and does not re-import', async () => {
  const { createHash } = await import('node:crypto')
  const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex')
  const at = zonedEpoch('UTC', 2027, 1, 4, 9, 30)
  const { e, feature } = fixture(null, at)
  const automations = [{
    id: 'c'.repeat(32), workspace_id: W, title: '旧报', title_hash: 'x', prompt: '汇总。', template_id: 'custom',
    schedule: { kind: 'daily', time: '09:00', time_zone: 'UTC' }, participants: [{ username: 'alice' }], enabled: 1, revision: 1, created: 1, updated: 1,
  }]
  const text = JSON.stringify(automations)
  const history = JSON.stringify([
    {id: 'd'.repeat(32), automation_id: automations[0].id, workspace_id: W,
      due_at: at - 86400, started: at - 86400, status: 'succeeded', finished: at - 86399,
      dispatch: JSON.stringify({backend: 'runtime-connect', result: {text: 'Imported outcome'}})},
    {id: 'e'.repeat(32), automation_id: automations[0].id, workspace_id: W,
      due_at: at - 172800, started: at - 172800, status: 'queued'},
  ])
  const bundle = { format: 'flybot-workspace-dsbot-import', version: 1, feature: 'automations', created: 1,
    tables: { automations: text, automation_runs: history },
    manifest: { automations: { rows: 1, sha256: sha(text) }, automation_runs: { rows: 2, sha256: sha(history) } } }
  const first = await feature.migrate(bundle)
  assert.equal(first.imported, 1)
  assert.equal(e['automations/list']({ workspace_id: W }).items[0].title, '旧报')
  const runs = e['automations/runs']({ workspace_id: W, id: 'c'.repeat(32) })
  assert.ok(runs.items.some((row) => row.status === 'skipped' && row.error_code === 'migrated'))
  const imported = runs.items.find(row => row.id === 'd'.repeat(32))
  assert.equal(imported.dispatch.backend, 'legacy')
  assert.equal(imported.result.text, 'Imported outcome')
  assert.equal(runs.items.find(row => row.id === 'e'.repeat(32)).status, 'skipped')
  assert.equal(runs.has_pending, false)
  assert.equal(feature.tick().length, 0)
  assert.equal((await feature.migrate(bundle)).imported, 0)
})

test('onboarding creates a paused automation for the verified owner and returns its exact ID on replay', async () => {
  const {calls, e, feature} = fixture()
  const request = {method: 'POST', path: '/v1/onboarding/automations',
    body: {workspace_id: W, template_ids: ['daily_brief'], username: 'forged-account'}}
  const call = {request: new Request('https://example.test', {headers: {'x-ot-owner-username': 'alice'}})}
  assert.equal((await e['automations/v1'](request, {request: new Request('https://example.test', {headers: {'x-ot-owner-username': ''}})})).status, 403)
  const denied = await e['automations/v1']({...request, body: {...request.body, workspace_id: 'b'.repeat(32)}}, call)
  assert.equal(denied.status, 403)
  const result = await e['automations/v1'](request, call)
  assert.equal(result.status, 201)
  const id = result.body.created[0].id
  const path = `/v1/workspaces/${W}/automations/${id}`
  const current = () => e['automations/get']({workspace_id: W, id}).automation
  assert.equal(current().enabled, false)
  assert.deepEqual(current().participants, [{username: 'alice'}])
  assert.equal(calls.length, 0)
  assert.equal((await e['automations/v1']({method: 'GET', path: path + '/remove'}, call)).status, 405)
  assert.equal((await e['automations/v1']({method: 'GET', path: `/v1/workspaces/${W}/automations/tick`}, call)).status, 405)
  e['automations/update']({workspace_id: W, id, revision: 1, changes: {title: '改名的简报'}})
  const retry = await e['automations/v1'](request, call)
  assert.equal(retry.status, 200)
  assert.deepEqual(retry.body.created, [])
  assert.deepEqual(retry.body.skipped, [{id, template_id: 'daily_brief', title: '改名的简报'}])
  assert.equal(e['automations/list']({workspace_id: W}).items.length, 1)
  const run = await e['automations/v1']({method: 'POST', path: path + '/run', idempotency_key: 'onboarding-manual-1'}, call)
  assert.equal(run.status, 202)
  await feature.inflight.get(run.body.run.id)
  assert.equal(e['automations/run']({workspace_id: W, id, run_id: run.body.run.id}).run.result.text, 'DS-Bot did it')
  assert.equal(calls.length, 1)
  assert.equal(current().enabled, false)
})
