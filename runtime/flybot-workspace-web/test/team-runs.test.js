import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAgents } from '../features/agents/index.js'
import { createTeamRuns, stages } from '../features/team-runs/index.js'
import { teamRunWorkKey } from '../features/shares/team-run-source.js'
import artifacts from '../features/artifacts/index.js'
import { featureHost, loadFeatures, registerFeature } from '../src/features.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const W = 'a'.repeat(32)
const TEAM = 'b'.repeat(32)
const settle = async (feature) => { for (let i = 0; i < 20 && feature.inflight.size; i += 1) await Promise.all(feature.inflight.values()) }

async function fixture(reply, {runWorkspace = W, database = ':memory:'} = {}) {
  const turns = []
  const bots = { main: { id: 'main', name: 'Main', capabilities: [] } }
  let sessionCount = 0
  const rt = {
    state: {bots}, chatOwners: new Map(), botOf: id => bots[id],
    async createBot(fields) {
      const id = 'bot-' + Object.keys(bots).length
      return bots[id] = {...fields, id}
    },
    createSession: async () => 'session-' + ++sessionCount,
    workDirOf: () => '/fixture',
    updateBot: async (id, change) => Object.assign(bots[id], change),
    setFlags: async (id, flags) => Object.assign(bots[id], flags),
    save: async () => {},
  }
  const services = {rt, ctx: {}, mainBot: async () => 'main', chatTurn: async () => assert.fail('Expected native Bot execution'),
    async nativeTurn(bot, session, text, rid, options) {
      const [key] = Object.entries(bots[bot].flybotWorkspace.sessionKeys).find(([,id]) => id === session)
      turns.push({key, text, rid, bot, session})
      const out = reply ? await reply(key, text, options?.onProgress, options?.signal) : {text: `out:${key.split(':')[4]}`}
      return {...out, sessionId:session, turnId:'turn-' + turns.length}
    },
  }
  const table = {}
  const identity = {instanceId: 'f'.repeat(32)}
  const state = {teams: runWorkspace === W ? [] : [{id:runWorkspace}]}
  const host = { identity, runtime: async () => services, call: async (name, payload) => {
    if (name === 'agents/personal-binding') return {workspace_id: W}
    if (name === 'teams/activeWorkspaces') return state.teams
    if (name === 'skills/materialForScope') return {items: []}
    if (!table[name]) throw Object.assign(new Error('x'), { code: 'flybot-workspace/not-found' })
    return table[name](payload, {internal:true})
  } }
  const agents = createAgents({ db: new DatabaseSync(':memory:'), host }).endpoints
  for (const [k, v] of Object.entries(agents)) table[`agents/${k}`] = v
  table['agents/groupTurn'] = (payload, call) => {
    assert.equal(call.internal, true)
    assert.equal(typeof payload.onProgress, 'function')
    return agents.turn(payload, {onProgress:payload.onProgress, signal:payload.signal})
  }
  const dataDir = mkdtempSync(join(tmpdir(), 'ot-tr-works-'))
  registerFeature(table, 'artifacts', artifacts(featureHost({name:'artifacts', identity, dataDir, table})))
  const a = (await agents.create({ workspace_id: runWorkspace, name: '研究', idempotency_key: 'a'.repeat(16) })).agent
  const b = (await agents.create({ workspace_id: runWorkspace, name: '写作', idempotency_key: 'b'.repeat(16) })).agent
  const db = new DatabaseSync(database)
  db.exec('PRAGMA foreign_keys=ON')
  const feature = createTeamRuns({ db, host })
  return { feature, e: feature.endpoints, a, b, agents, turns, host, state, db, table }
}

const body = (a, b, extra = {}) => ({ workspace_id: W, title: '调研报告', goal: '写一份行业调研', idempotency_key: 'r'.repeat(16),
  steps: [{ agent_id: a.id, instruction: '收集资料', depends_on: [] }, { agent_id: a.id, instruction: '找数据', depends_on: [] },
    { agent_id: b.id, instruction: '成文', depends_on: [0, 1] }], ...extra })

test('a DAG runs every step as a DS-Bot turn of its agent, in dependency order', async () => {
  const { feature, e, a, b, turns } = await fixture()
  const made = await e.create(body(a, b))
  assert.equal(made.status, 201)
  assert.deepEqual(made.run.steps.map((s) => s.stage), [1, 1, 2])
  await settle(feature)
  const { run } = await e.get({ workspace_id: W, id: made.run.id })
  assert.equal(run.status, 'succeeded')
  assert.deepEqual(run.steps.map((s) => s.status), ['succeeded', 'succeeded', 'succeeded'])
  assert.equal(run.steps[2].ds_bot.engine, 'ds-bot')
  assert.equal(turns.length, 3)
  assert.ok(turns[2].key.startsWith(`agent:${b.id}:team-run:${made.run.id}:2`))
  assert.equal(turns[2].bot, b.native_bot_id)
  assert.deepEqual(turns.slice(0, 2).map(turn => turn.bot), [a.native_bot_id, a.native_bot_id])
  assert.match(turns[2].text, /团队任务目标：写一份行业调研/)
  assert.match(turns[2].text, /\[第 1 步 · 研究\] out:0/)
  assert.match(turns[2].text, /\[第 2 步 · 研究\] out:1/)
  assert.equal((await e.create(body(a, b))).status, 200)
  await assert.rejects(e.create(body(a, b, { goal: '别的' })), (err) => err.status === 409)
  assert.equal((await e.list({ workspace_id: W })).items[0].progress.succeeded, 3)
})

test('a failed step blocks dependants; retry resets them and finishes the run', async () => {
  let failFirst = true
  const { feature, e, a, b } = await fixture((key) => {
    if (key.split(':')[4] === '0' && failFirst) { failFirst = false; throw new Error('DS-Bot turn timed out') }
    return { text: 'ok' }
  })
  const { run } = await e.create(body(a, b))
  await settle(feature)
  let now = (await e.get({ workspace_id: W, id: run.id })).run
  assert.equal(now.status, 'failed')
  assert.deepEqual(now.steps.map((s) => [s.status, s.error_code]), [['failed', 'timeout'], ['succeeded', null], ['blocked', null]])
  await e.retry({ workspace_id: W, id: run.id, position: 0 })
  await settle(feature)
  now = (await e.get({ workspace_id: W, id: run.id })).run
  assert.equal(now.status, 'succeeded')
  assert.equal(now.steps[0].attempts, 2)
  await assert.rejects(e.retry({ workspace_id: W, id: run.id, position: 1 }), (err) => err.status === 409)
})

test('reused tasks keep only local lineage and remove links to deleted tasks', async () => {
  const {feature, e, a, b, agents} = await fixture(null, {runWorkspace:TEAM})
  const plan = body(a, b, {workspace_id:TEAM})
  const original = (await e.create(plan)).run
  await settle(feature)
  const first = {...plan, title:'第一次复用', idempotency_key:'r1'.repeat(12), reused_from:original.id}
  const second = {...plan, title:'第二次复用', idempotency_key:'r2'.repeat(12), reused_from:original.id}
  const one = (await e.create(first)).run
  const two = (await e.create(second)).run
  await settle(feature)
  assert.equal(one.reused_from, original.id)
  assert.equal(two.reused_from, original.id)
  const read = id => e.get({workspace_id:TEAM, id}).then(result => result.run)
  assert.equal((await read(original.id)).latest_reuse, two.id)
  const own = (await agents.create({workspace_id:W, name:'个人复核员', idempotency_key:'private-agent-1xx'})).agent
  await assert.rejects(e.create(body(own, own, {reused_from:original.id})), error =>
    error.status === 404 && error.code === 'team-runs/reuse_unavailable')
  await e.remove({workspace_id:TEAM, id:two.id})
  assert.equal((await read(original.id)).latest_reuse, one.id)
  await e.remove({workspace_id:TEAM, id:original.id})
  assert.equal((await read(one.id)).reused_from, undefined)
  const replay = await e.create(first)
  assert.equal(replay.status, 200)
  assert.equal(replay.run.id, one.id)
})

test('automation follow-up projects an authorized result and rechecks it before execution', async () => {
  const {feature, e, a, b, table, turns, state} = await fixture(null, {runWorkspace:TEAM})
  const automation_id = 'd'.repeat(32), run_id = 'e'.repeat(32)
  const source = {kind:'automation_run', automation_id, run_id}
  const report = 'Authorized automation output\n' + 'x'.repeat(4000) + ' outside-context-budget'
  let status = 'succeeded'
  table['automations/get'] = async ({workspace_id, id}) => {
    assert.equal(workspace_id, TEAM)
    assert.equal(id, automation_id)
    return {automation:{workspace_id, id, title:'Daily brief', prompt:'private original settings'}}
  }
  table['automations/run'] = async ({workspace_id, id, run_id:current}) => {
    assert.equal(workspace_id, TEAM)
    assert.equal(id, automation_id)
    assert.equal(current, run_id)
    if (!status) throw Object.assign(new Error('Removed'), {status:404})
    return {run:{workspace_id, automation_id:id, id:current, status, result:{text:report}}}
  }
  const path = `/v1/workspaces/${TEAM}/team-runs/automation-results/${automation_id}/${run_id}`
  const preview = () => e.v1({method:'GET', path})
  const result = await preview()
  assert.equal(result.status, 200)
  assert.deepEqual(result.body, {source, title:'Daily brief'})
  assert.equal(turns.length, 0)
  status = 'cancelled'
  assert.equal((await preview()).status, 409)
  await assert.rejects(e.create(body(a, b, {workspace_id:TEAM, source})), error => error.status === 409)
  status = 'succeeded'
  const params = body(a, b, {workspace_id:TEAM, source})
  const created = await e.create(params)
  await settle(feature)
  assert.equal(created.status, 201)
  assert.deepEqual((await e.get({workspace_id:TEAM, id:created.run.id})).run.source, source)
  assert.equal(turns.length, 3)
  assert.ok(turns.every(turn => turn.text.includes('Authorized automation output') &&
    !turn.text.includes('private original settings') && !turn.text.includes('outside-context-budget')))
  status = null
  assert.equal((await preview()).status, 404)
  assert.equal((await e.create(params)).run.id, created.run.id)
  state.teams = []
  assert.equal((await preview()).status, 404)
})

test('private team runs export every finished result intact and fence literal text', async () => {
  const long = '首行\n~~~~\n<script>text only</script>\n' + '长文本'.repeat(3000) + '\n最后一行'
  const {feature, e, a, b, state} = await fixture(key => ({text:key.includes(':0:') ? long : '第二项结果'}), {runWorkspace:TEAM})
  const {run} = await e.create(body(a,b,{workspace_id:TEAM}))
  const path = `/v1/workspaces/${TEAM}/team-runs/${run.id}/export`
  const read = () => e.v1({method:'GET', path})
  await settle(feature)
  const {status, download} = await read()
  assert.equal(status, 200)
  assert.equal(download.content_type, 'text/markdown; charset=utf-8')
  assert.equal(download.filename, `team-run-${run.id}.md`)
  const content = Buffer.from(download.data,'base64').toString('utf8')
  assert.ok(content.includes('\n~~~~~\n' + long + '\n~~~~~\n'))
  assert.ok(content.includes('## 第 2 步\n') && content.includes('第二项结果'))
  assert.equal((await e.v1({method:'GET',path:path.replace(TEAM,W)})).status,404)
  state.teams=[]
  assert.equal((await read()).status,404)
})

test('a shared follow-up only starts and dispatches with its exact authorized source', async () => {
  const keepFirst = Promise.withResolvers()
  const entered = Promise.withResolvers()
  const {feature, e, a, b, db, table, turns} = await fixture((key, prompt) => {
    assert.match(key, /:0:1$/)
    assert.match(prompt, /authorized team excerpt/)
    entered.resolve()
    return keepFirst.promise
  }, {runWorkspace: TEAM})
  const source = {id: 'otsr_' + 'A'.repeat(26), version: 'a'.repeat(64), positions: [1]}
  let access = true
  table['shares/teamRunContext'] = async (payload, call) => {
    assert.equal(call.internal, true)
    assert.deepEqual(payload, {workspace_id: TEAM, source})
    if (!access) throw Object.assign(new Error('Revoked'), {status: 404})
    return {title: 'Reviewed plan', outputs: [{position: 2, text: 'authorized team excerpt'}]}
  }
  const params = body(a, b, {workspace_id: TEAM, source})
  params.steps = [params.steps[0], {...params.steps[2], depends_on:[0]}]
  const {status, run} = await e.create(params)
  assert.equal(status, 201)
  assert.deepEqual(run.source, source)
  await entered.promise
  access = false
  keepFirst.resolve({text:'first step result'})
  await settle(feature)
  const done = (await e.get({workspace_id: TEAM, id: run.id})).run
  assert.deepEqual(done.steps.map(step => [step.status, step.error_code]), [['succeeded', null], ['failed', 'source_unavailable']])
  assert.equal(turns.length, 1)
  assert.equal((await e.create(params)).status, 200)
  await assert.rejects(e.create({...params, idempotency_key:'fresh-followup-key'}), {status: 404, code: 'team-runs/source_unavailable'})
  await assert.rejects(e.retry({workspace_id:TEAM, id:run.id, position:1}), {status: 404, code: 'team-runs/source_unavailable'})
  assert.equal((await e.get({workspace_id:TEAM, id:run.id})).run.steps[1].attempts, 1)
  assert.deepEqual(JSON.parse(db.prepare('SELECT source FROM team_run_sources WHERE run_id=?').get(run.id).source), source)
})

test('only the authorized live attempt can expose an ephemeral preview', async () => {
  const controls = new Map()
  const {feature, e, a, b, state, turns, db} = await fixture((key, _prompt, onProgress) => {
    const [, , , , position, attempt] = key.split(':')
    if (position !== '0') return {text:`finished ${position}`}
    const control = Promise.withResolvers()
    controls.set(attempt, {...control, onProgress})
    return control.promise
  }, {runWorkspace:TEAM})
  const {run} = await e.create(body(a, b, {workspace_id:TEAM}))
  const path = `/v1/workspaces/${TEAM}/team-runs/${run.id}`
  const get = async () => (await e.v1({method:'GET', path})).body.run
  const tick = () => new Promise(resolve => setImmediate(resolve))
  await tick()
  const first = controls.get('1')
  const long = '临'.repeat(19_999) + '🚀rest'
  first.onProgress(long)
  const partial = (await get()).steps[0]
  assert.equal(partial.status, 'running')
  assert.equal(partial.output, '')
  assert.equal(partial.preview.length, 20_000)
  assert.ok(partial.preview.isWellFormed())
  assert.equal(db.prepare('SELECT output FROM team_run_steps WHERE run_id=? AND position=0').get(run.id).output, '')
  assert.equal((await e.v1({method:'POST', path:path+'/steps/0/artifact'})).status, 409)
  assert.ok(!(await e.v1({method:'GET', path:path.slice(0, path.lastIndexOf('/'))})).body.items[0].steps)
  state.teams = []
  assert.equal((await e.v1({method:'GET', path})).status, 404)
  state.teams = [{id:TEAM}]
  first.onProgress('discarded attempt')
  first.reject(new Error('DS-Bot turn timed out'))
  await settle(feature)
  assert.equal((await get()).steps[0].preview, undefined)

  const retry = attempt => e.v1({method:'POST', path:path+'/steps/0/retry', body:{attempt}})
  assert.equal((await retry(1)).status, 200)
  await tick()
  const second = controls.get('2')
  second.onProgress('new preview')
  first.onProgress('stale callback')
  assert.equal((await get()).steps[0].preview, 'new preview')
  second.reject(new Error('DS-Bot turn timed out'))
  await settle(feature)
  assert.equal((await retry(1)).status, 409)
  assert.equal((await retry(0)).status, 400)
  assert.equal((await retry(2)).status, 200)
  await tick()
  controls.get('3').resolve({text:'authoritative reply'})
  await settle(feature)
  const completed = await get()
  assert.equal(completed.steps[0].output, 'authoritative reply')
  assert.equal(completed.steps[0].preview, undefined)
  assert.match(turns.at(-1).text, /authoritative reply/)
  assert.doesNotMatch(turns.at(-1).text, /preview|discarded|stale/)
})

test('cancel aborts active native steps, skips their dependants and ignores late replies', async () => {
  const pending = []
  const release = () => {
    for (const {resolve, preview} of pending.splice(0)) {
      preview('late draft')
      resolve({text:'late'})
    }
  }
  const { feature, e, a, b, agents, turns } = await fixture((_key, _text, preview, signal) =>
    new Promise(resolve => { pending.push({resolve, preview, signal}) }))
  const { run } = await e.create(body(a, b))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(turns.length, 2)
  pending[0].preview('visible before cancel')
  assert.equal((await e.get({workspace_id:W, id:run.id})).run.steps[0].preview, 'visible before cancel')
  const cancelled = (await e.cancel({ workspace_id: W, id: run.id })).run
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(pending.length, 2)
  assert.ok(pending.every(item => item.signal?.aborted))
  await new Promise((r) => setImmediate(r))
  release()
  await settle(feature)
  const after = (await e.get({ workspace_id: W, id: run.id })).run
  assert.ok(after.steps.every((s) => s.status === 'cancelled' && !s.preview && !s.output))
  assert.equal(turns.length, 2)
  await e.remove({ workspace_id: W, id: run.id })
  await assert.rejects(e.get({ workspace_id: W, id: run.id }), (err) => err.status === 404)
  const k = (n) => n.repeat(16)
  await assert.rejects(e.create(body(a, b, { idempotency_key: k('x'), steps: [{ agent_id: a.id, instruction: 'x', depends_on: [1] }, { agent_id: a.id, instruction: 'y', depends_on: [] }] })), /earlier steps/)
  await assert.rejects(e.create(body(a, b, { idempotency_key: k('y'), steps: [{ agent_id: a.id, instruction: 'x', depends_on: [] }] })), /2-8 steps/)
  await agents.archive({ workspace_id: W, id: b.id })
  await assert.rejects(e.create(body(a, b, { idempotency_key: k('z') })), /active workspace agent/)
  await assert.rejects(e['step-artifact']({ workspace_id: W, id: 'd'.repeat(32), position: 0 }), (err) => err.status === 404)
  assert.deepEqual(stages([{ position: 0, depends: '[]' }, { position: 1, depends: '[0]' }, { position: 2, depends: '[0,1]' }]), { 0: 1, 1: 2, 2: 3 })
})

test('browser routes create once, replay after an agent changes, and save the actual step output to Space', async () => {
  const {feature, e, a, b, agents, host} = await fixture()
  const {workspace_id, idempotency_key, ...payload} = body(a, b)
  const path = `/v1/workspaces/${workspace_id}/team-runs`
  const create = () => e.v1({method:'POST', path, body:payload, idempotency_key})
  const both = await Promise.all([create(), create()])
  assert.deepEqual(both.map(result => result.status).sort(), [200, 201])
  const id = both[0].body.run.id
  assert.equal(both[1].body.run.id, id)
  await settle(feature)
  await agents.archive({workspace_id:W, id:b.id})
  assert.equal((await create()).body.run.id, id)
  const changed = await e.v1({method:'POST', path, body:{...payload, goal:'Different'}, idempotency_key})
  assert.equal(changed.status, 409)

  const existing = await host.call('artifacts/v1', {method:'POST', path:`/v1/workspaces/${W}/artifacts`,
    body:{title:'调研报告 · 第 1 步', kind:'document', body:'Unrelated existing work'}, idempotency_key:'existing-work-key'})
  assert.equal(existing.status, 201)
  const save = () => e.v1({method:'POST', path:`${path}/${id}/steps/0/artifact`})
  const kept = await save()
  assert.equal(kept.status, 201)
  const artifact = kept.body.artifact
  assert.equal(artifact.body, 'out:0')
  assert.notEqual(artifact.id, existing.body.artifact.id)
  const source = {kind:'team_run_step', id, position:0, run_title:'调研报告'}
  assert.deepEqual(artifact.source, source)
  const forged = await host.call('artifacts/v1', {method:'POST', path:`/v1/workspaces/${W}/artifacts`,
    body:{title:'伪造来源', kind:'document', body:'Not a step result', source}, idempotency_key:'forged-work-key-1'})
  assert.equal(forged.status,403)
  const replay = await save()
  assert.equal(replay.status, 200)
  assert.equal(replay.body.artifact.id, artifact.id)
  const details = () => e.v1({method:'GET', path:`${path}/${id}`})
  const saved = (await details()).body.run
  assert.equal(saved.status, 'succeeded')
  assert.deepEqual(saved.steps.map(step => step.saved_artifact_id), [artifact.id, undefined, undefined])
  const readArtifact = id => host.call('artifacts/v1', {method:'GET', path:`/v1/workspaces/${W}/artifacts/${id}`})
  assert.deepEqual((await readArtifact(artifact.id)).body.artifact.source, source)
  // Older saves get their source from the exact receipt key and original output.
  const legacy = await host.call('artifacts/v1', {method:'POST', path:`/v1/workspaces/${W}/artifacts`,
    body:{title:'调研报告 · 第 2 步',kind:'document',body:saved.steps[1].output}, idempotency_key:teamRunWorkKey(id,1)})
  assert.equal(legacy.body.artifact.source,undefined)
  const legacyId = legacy.body.artifact.id
  const edited = await host.call('artifacts/v1', {method:'POST',path:`/v1/workspaces/${W}/artifacts/${legacyId}`,
    body:{revision:1,changes:{title:'我编辑过的旧结果',body:'这份结果已经修改'}}})
  assert.equal(edited.status,200)
  assert.equal((await details()).body.run.steps[1].saved_artifact_id,legacyId)
  const repaired = (await readArtifact(legacyId)).body.artifact
  assert.deepEqual(repaired.source,{...source,position:1})
  assert.equal(repaired.body,'这份结果已经修改')
  assert.equal((await e.v1({method:'GET', path})).body.items.length, 1)
  const wrongWorkspace = await host.call('artifacts/savedTeamRunWorks', {workspace_id: TEAM, run_id: id, positions: [0]})
  assert.deepEqual(wrongWorkspace.items, [])
  const remove = await host.call('artifacts/v1', {method:'POST', path:`/v1/workspaces/${W}/artifacts/${artifact.id}/remove`, body:{}})
  assert.equal(remove.status, 200)
  assert.equal((await details()).body.run.steps[0].saved_artifact_id, undefined)
  assert.equal((await e.v1({method:'POST', path:`${path}/${id}/steps/8/artifact`})).status, 404)
  assert.equal((await e.v1({method:'POST', path:`${path}/${id}/remove`})).status, 200)
  assert.equal((await e.v1({method:'GET', path:`${path}/${id}`})).status, 404)
})

test('restart interrupts claimed work and only resumes independent unclaimed steps', async () => {
  const database = join(mkdtempSync(join(tmpdir(), 'ot-tr-restart-')), 'runs.sqlite3')
  const {db, a, b, host, turns} = await fixture(undefined, {database})
  const id = 'd'.repeat(32)
  db.prepare('INSERT INTO team_runs VALUES(?,?,?,?,?,?,?,?,?)').run(id, W, 'Interrupted', 'Goal', 'running', 10, 10, 'key', 'hash')
  const put = db.prepare(`INSERT INTO team_run_steps
    (run_id,position,agent_id,agent_name,instruction,depends,status,attempts,started)
    VALUES(?,?,?,?,?,?,?,?,?)`)
  put.run(id, 0, a.id, a.name, 'Claimed before restart', '[]', 'running', 1, 10)
  put.run(id, 1, a.id, a.name, 'Never claimed', '[]', 'waiting', 0, null)
  put.run(id, 2, b.id, b.name, 'Needs both', '[0,1]', 'waiting', 0, null)
  db.close()
  const restart = new DatabaseSync(database)
  const feature = createTeamRuns({db:restart, host, clock:() => 20})
  const e = feature.endpoints
  const get = async () => (await e.get({workspace_id:W, id})).run
  const initial = await get()
  assert.deepEqual(initial.steps.map(s => s.status), ['failed','waiting','blocked'])
  assert.equal(initial.steps[0].error_code, 'interrupted')
  feature.resume()
  feature.resume()
  await settle(feature)
  assert.deepEqual(turns.map(turn => turn.rid), [`ot-team-run:${id}:1:1`])
  assert.equal((await get()).status, 'failed')
  await e.retry({workspace_id:W, id, position:0})
  await settle(feature)
  assert.deepEqual(turns.slice(1).map(turn => turn.rid), [`ot-team-run:${id}:0:2`, `ot-team-run:${id}:2:1`])
  assert.equal((await get()).status, 'succeeded')
  restart.close()
})

test('workspace membership is checked on reads, writes, and outstanding step dispatch', async () => {
  const launched = Promise.withResolvers()
  const reply = Promise.withResolvers()
  const {feature, e, a, b, state, turns} = await fixture(() => { launched.resolve(); return reply.promise }, {runWorkspace: TEAM})
  const path = `/v1/workspaces/${TEAM}/team-runs`
  const draft = {title:'Team workspace', goal:'One after the other', steps:[
    {agent_id:a.id, instruction:'First', depends_on:[]}, {agent_id:b.id, instruction:'Then', depends_on:[0]},
  ]}
  const foreign = path.replace(TEAM, 'c'.repeat(32))
  assert.equal((await e.v1({method:'POST', path:foreign, body:draft, idempotency_key:'foreign-workspace'})).status, 404)
  assert.equal((await e.v1({method:'POST', path:path.replace(TEAM, W), body:draft, idempotency_key:'foreign-agent-in-personal'})).status, 400)
  const made = await e.v1({method:'POST', path, body:draft, idempotency_key:'shared-workspace'})
  assert.equal(made.status, 201)
  const current = path + '/' + made.body.run.id
  await launched.promise
  state.teams = []
  assert.equal((await e.v1({method:'GET', path})).status, 404)
  assert.equal((await e.v1({method:'GET', path:current})).status, 404)
  assert.equal((await e.v1({method:'POST', path:current + '/cancel'})).status, 404)
  reply.resolve({text:'First turn was already underway'})
  await settle(feature)
  assert.equal(turns.length, 1)
  state.teams = [{id:TEAM}]
  const after = (await e.v1({method:'GET', path:current})).body.run
  assert.equal(after.status, 'failed')
  assert.equal(after.steps[1].error_code, 'workspace_unavailable')
})

test('team-runs loads through the extension point', async () => {
  process.env.FLYBOT_WORKSPACE_AUTOMATIONS_CLOCK = '0'
  const { table, loaded } = await loadFeatures({ dir: join(HERE, '../features'), identity: { instanceId: 'e'.repeat(32) }, dataDir: mkdtempSync(join(tmpdir(), 'ot-tr-load-')), log: () => {} })
  assert.ok(loaded.includes('team-runs'))
  assert.ok(table['team-runs/create'] && table['team-runs/retry'] && table['team-runs/v1'] && table['team-runs/step-artifact'])
})
