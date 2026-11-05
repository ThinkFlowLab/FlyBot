import { harnessProfile } from '../src/host/project-harness-auth.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, rename, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createProjectScheduler } from '../src/host/project-scheduler.js'
import { createProjectEffects } from '../src/host/project-effects.js'
import { install as installProjectInputs } from '../src/host/project-inputs.js'
import { createProjectResources } from '../src/host/project-resources.js'
import { createProjectHarness, handoffFrame, harnessCapabilities } from '../src/host/project-harness.js'

async function fixture(t, roleGithub) {
  const root = await mkdtemp(join(tmpdir(), 'flybot-harness-contract-'))
  const runtimeDir = join(root, 'runtime'), cwd = join(root, 'work')
  await mkdir(join(runtimeDir, 'src/host'), { recursive: true }); await mkdir(cwd)
  await writeFile(join(runtimeDir, 'src/host/project-harness-worker.mjs'), `
import {createInterface} from 'node:readline';
const lines=createInterface({input:process.stdin});
const write=value=>process.stdout.write(JSON.stringify(value)+'\\n');
write({type:'ready',sdk:{codex:'0.166.0','claude-agent':'0.3.316'}});
lines.on('line',line=>{const m=JSON.parse(line);
 if(m.type==='stop'){write({type:'stopped',released:true});setTimeout(()=>process.exit(0),20);}
 if(m.type==='start') {
  write({type:'sdk-event',event:{type:'thread.started',thread_id:'bound-thread'}});
  write({type:'sdk-event',event:{type:'debug',noTools:m.settings.noTools,readOnly:m.settings.readOnly,writableRoots:m.settings.writableRoots,resumeSessionId:m.settings.sessionId??null,value:m.settings.env.OPENAI_API_KEY,taskId:'task-1234567890abcdef',unknownCredential:'sk-unitsecret123456789012345'}});
  write({type:'completed',sessionId:'bound-thread',text:'OUTPUT implementation: actual contract worker output',usage:{input_tokens:1}});
 }
});`)
  const session = { id: 's', projectId: 'p', taskId: 't', attemptId: 'a', role: 'developer', definition: { role: 'developer', instructions: 'Stable developer convention', skills: [] }, execution: { harness: 'codex' }, context: { text: 'Frozen criteria and role memory' }, resourceLease: { id: 'l', resourceId: 'r', generation: 1 } }
  const workspace = { id: 'w', projectId: 'p', attemptId: 'a', role: 'developer', path: cwd }
  const rt = { home: root, state: { tasks: { t: { id: 't', projectId: 'p' } }, projectResourceLeases: { l: { id: 'l', resourceId: 'r', projectId: 'p', attemptId: 'a', role: 'developer', generation: 1, status: 'reserved' } } },
    config: { projectResources: { r: { type: 'local', root, capacity: 1, runtimeDir, harnesses: ['codex'], allowedProjectOwnerIds: ['owner'], profiles: { owner: { codex: { home: join(root, 'profile'), configDir: join(root, 'profile/codex'), model: 'test-model', envRefs: { OPENAI_API_KEY: 'FLYBOT_TEST_HARNESS_SECRET' } } } } } } },
    save: async () => {}, warn() {}, readProject: () => ({ id: 'p', ownerUserId: 'owner' }), requireProjectAccess(actor) { if (actor.memberId !== 'owner') throw new Error('Access denied') },
    projectDelivery: { ownsWorkspace: (projectId, path) => projectId === 'p' && path === cwd ? workspace : null, sessionFor: () => session,
      bindSession: async (_workspace, bot) => rt.projectResources.markStarted(session.resourceLease.id, session.resourceLease.generation, { kind: 'sdk', handle: bot.id }), releaseSession: async () => {} } }
  process.env.FLYBOT_TEST_HARNESS_SECRET = 'unit-credential-opaque-value'
  rt.projectResources = createProjectResources(rt)
  const harness = createProjectHarness(rt, { roleGithub })
  t.after(async () => { for (const id of Object.keys(rt.state.projectHarnessWorkers ?? {})) await harness.release(id); delete process.env.FLYBOT_TEST_HARNESS_SECRET; await rm(root, { recursive: true, force: true }) })
  return { rt, harness, cwd }
}

test('SDK process contract preserves evidence, redacts credentials and confirms release before freeing capacity', async t => {
  const { rt, harness, cwd } = await fixture(t)
  const id = await harness.spawn({ executionProjectId: 'p', executionWorkDir: cwd, prompt: 'Do the assigned Task' })
  const result = new Promise(resolve => harness.onResult(resolve))
  await harness.dispatch({ botId: id, taskId: 't', brief: 'Frozen requirement', outputs: [{ name: 'implementation' }] })
  assert.equal((await result).ok, true)
  const row = rt.state.projectHarnessWorkers[id]
  assert.equal(row.backendSessionId, 'bound-thread')
  const evidence = await readFile(row.eventLog, 'utf8')
  assert.match(evidence, /REDACTED/)
  assert.match(evidence, /task-1234567890abcdef/, 'Task IDs must survive credential redaction')
  assert.equal(evidence.includes('sk-unitsecret123456789012345'), false)
  assert.equal(evidence.includes(process.env.FLYBOT_TEST_HARNESS_SECRET), false)
  assert.equal(rt.projectResources.occupied('r'), 1)
  await harness.release(id)
  assert.equal(rt.projectResources.occupied('r'), 0)
  assert.equal(row.status, 'released')
  assert.equal(await harness.release(id), true)
  await assert.rejects(harness.dispatch({ botId: id }), /unavailable/)
})

test('SDK workers reject unregistered Workspaces and missing explicit profiles', async t => {
  const { harness, rt, cwd } = await fixture(t)
  await assert.rejects(harness.spawn({ executionProjectId: 'p', executionWorkDir: '/foreign' }), /registered/)
  delete rt.config.projectResources.r.profiles
  await assert.rejects(harness.spawn({ executionProjectId: 'p', executionWorkDir: cwd }), /explicitly authorized/)
})

for (const priorState of ['unreachable', 'released-worker', 'released-lease', 'stale-generation', 'legacy-no-proof']) test('controller-lost SDK release reconciles ' + priorState + ' using exact exit evidence', async t => {
  const { rt, cwd } = await fixture(t)
  const scope = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `import {captureProcessScope} from ${JSON.stringify(new URL('../src/host/project-process-proof.js', import.meta.url).href)};console.log(JSON.stringify(await captureProcessScope()))`], { encoding: 'utf8', env: { PATH: process.env.PATH } }))
  const id = 'sdk-controller-lost', root = rt.config.projectResources.r.root
  for (const name of ['project-sdk-exit.mjs', 'project-process-proof.js']) await writeFile(join(rt.config.projectResources.r.runtimeDir, 'src/host', name), await readFile(new URL('../src/host/' + name, import.meta.url)))
  await mkdir(join(root, '.flybot-sdk-exit'))
  await writeFile(join(root, '.flybot-sdk-exit', id + '.json'), JSON.stringify({ version: 'project-sdk-exit/v1', workerId: id, leaseId: 'l', generation: 1, scope, status: 'stopped' }))
  rt.state.projectHarnessWorkers = { [id]: { id, projectId: 'p', attemptId: 'a', role: 'developer', resourceId: 'r', leaseId: 'l', generation: 1, status: priorState === 'released-worker' ? 'released' : 'unreachable', cwd, exitRecovery: { version: 'project-sdk-exit/v1' } } }
  if (priorState === 'released-worker') rt.state.projectHarnessWorkers[id].releaseProof = { kind: 'sdk-stop-ack-and-process-exit', workerId: id, generation: 1, at: Date.now() }
  Object.assign(rt.state.projectResourceLeases.l, { status: priorState === 'released-lease' ? 'released' : 'unreachable', worker: { kind: 'sdk', handle: id } })
  const restored = createProjectHarness(rt)
  if (priorState === 'legacy-no-proof') {
    delete rt.state.projectHarnessWorkers[id].exitRecovery
    await rm(join(root, '.flybot-sdk-exit', id + '.json'))
    await assert.rejects(restored.release(id), /exit cannot be confirmed/)
    assert.equal(rt.state.projectResourceLeases.l.status, 'unreachable')
    delete rt.state.projectHarnessWorkers[id]
    return
  }
  if (priorState === 'stale-generation') {
    const command = rt.projectResources.command
    rt.projectResources.command = async (...args) => { const result = await command(...args); rt.state.projectResourceLeases.l.generation = 2; return result }
    await assert.rejects(restored.release(id), /exit cannot be confirmed/)
    assert.equal(rt.state.projectResourceLeases.l.status, 'unreachable')
    delete rt.state.projectHarnessWorkers[id] // No live process exists in this synthetic stale-binding fixture.
    return
  }
  assert.equal(await restored.release(id), true)
  assert.equal(rt.state.projectResourceLeases.l.status, 'released')
  assert.equal(rt.state.projectHarnessWorkers[id].releaseProof.kind, 'sdk-stop-ack-and-process-exit')
})

for (const recovery of ['release', 'reconcile']) test('controller-lost host ' + recovery + ' waits for the actual resource worker to settle and exit', { timeout: 15000 }, async t => {
  const { rt, cwd } = await fixture(t), id = 'sdk-live-controller-lost'
  rt.config.projectResources.r.runtimeDir = resolve(import.meta.dirname, '..')
  rt.state.projectHarnessWorkers = { [id]: { id, projectId: 'p', attemptId: 'a', role: 'developer', resourceId: 'r', leaseId: 'l', generation: 1, status: 'unreachable', cwd, exitRecovery: { version: 'project-sdk-exit/v1' } } }
  await rt.projectResources.markStarted('l', 1, { kind: 'sdk', handle: id })
  const identity = { version: 'project-sdk-exit/v1', root: rt.config.projectResources.r.root, workerId: id, leaseId: 'l', generation: 1 }
  const child = rt.projectResources.startProcess('p', 'r', { cwd, argv: ['node', resolve(import.meta.dirname, '../src/host/project-harness-worker.mjs'), JSON.stringify(identity)] })
  child.stderr.resume(); child.stdin.on('error', () => {})
  const exit = once(child, 'close'), lines = createInterface({ input: child.stdout })
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exit; lines.close() })
  await once(lines, 'line')
  rt.projectHarness = createProjectHarness(rt)
  assert.equal(rt.projectResources.occupied('r'), 1)
  if (recovery === 'release') assert.equal(await rt.projectHarness.release(id), true)
  else { child.stdin.end(); await exit; await rt.projectResources.reconcile() }
  await exit
  assert.equal(rt.projectResources.occupied('r'), 0)
  assert.equal(rt.state.projectHarnessWorkers[id].releaseProof.source, 'resource-stopped-receipt')
  assert.equal(rt.state.tasks.t.status, undefined, 'Physical exit does not complete the Task')
})

for (const previousStatus of ['unreachable', 'released']) test('legacy ' + previousStatus + ' SDK reconciles only its saved stop event and zero process exit', async t => {
  const { rt, harness, cwd } = await fixture(t)
  const start = rt.projectResources.startProcess; let child
  rt.projectResources.startProcess = (...args) => (child = start(...args))
  const id = await harness.spawn({ executionProjectId: 'p', executionWorkDir: cwd, prompt: 'Own legacy worker' })
  const exited = once(child, 'close')
  child.stdin.end(JSON.stringify({ type: 'stop' }) + '\n'); await exited
  const row = rt.state.projectHarnessWorkers[id]
  const stoppedHash = createHash('sha256').update(JSON.stringify({ type: 'stopped', released: true })).digest('hex')
  for (let n = 0; n < 100 && row.lastEventHash !== stoppedHash; ++n) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(row.lastEventHash, stoppedHash)
  delete row.exitRecovery; row.status = previousStatus; rt.state.projectResourceLeases.l.status = previousStatus
  rt.projectHarness = createProjectHarness(rt)
  await rt.projectResources.reconcile()
  assert.equal(row.status, 'released'); assert.equal(rt.projectResources.occupied('r'), 0)
  assert.equal(row.releaseProof.source, 'durable-host-stop-event')
})

test('non-App Dev receives Git mutation rights only for its bound isolated resource clone', async t => {
  const { harness, rt, cwd } = await fixture(t)
  execFileSync('git', ['init', '-q', cwd])
  const workspace = rt.projectDelivery.ownsWorkspace('p', cwd)
  Object.assign(workspace, { kind: 'resource-clone', resourceId: 'r', repository: cwd })
  rt.state.projectAttempts = { a: { workspaces: { developer: workspace } } }
  const id = await harness.spawn({ executionProjectId: 'p', executionWorkDir: cwd, prompt: 'Non-App development' })
  const result = new Promise(resolve => harness.onResult(resolve))
  await harness.dispatch({ botId: id, taskId: 't', brief: 'Stage and commit owned work', outputs: [{ name: 'implementation' }] })
  await result
  const events = (await readFile(rt.state.projectHarnessWorkers[id].eventLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(events.find(row => row.event?.type === 'debug').event.writableRoots, [join(cwd, '.git')])
})

for (const changed of ['binding', 'symlink', 'common-dir']) test('isolated Dev Git grant refuses changed ' + changed, async t => {
  const { harness, rt, cwd } = await fixture(t)
  execFileSync('git', ['init', '-q', cwd])
  const workspace = rt.projectDelivery.ownsWorkspace('p', cwd)
  Object.assign(workspace, { kind: 'resource-clone', resourceId: 'r', repository: cwd })
  rt.state.projectAttempts = { a: { workspaces: { developer: workspace } } }
  const id = await harness.spawn({ executionProjectId: 'p', executionWorkDir: cwd, prompt: 'Owned development' })
  if (changed === 'binding') workspace.resourceId = 'foreign'
  else {
    const foreign = join(cwd, '..', 'foreign-git')
    if (changed === 'symlink') { await rename(join(cwd, '.git'), foreign); await symlink(foreign, join(cwd, '.git')) }
    else { execFileSync('git', ['init', '--bare', '-q', foreign]); await writeFile(join(cwd, '.git', 'commondir'), foreign + '\n') }
  }
  await assert.rejects(harness.dispatch({ botId: id, taskId: 't', brief: 'Work', outputs: [{ name: 'implementation' }] }), /binding changed|does not belong/)
  assert.equal(rt.state.projectHarnessWorkers[id].status, 'idle')
})

test('non-App read-only policy role never gains isolated clone Git writes', async t => {
  const { harness, rt, cwd } = await fixture(t)
  const workspace = rt.projectDelivery.ownsWorkspace('p', cwd), session = rt.projectDelivery.sessionFor()
  Object.assign(workspace, { kind: 'resource-clone', resourceId: 'r', repository: cwd })
  session.definition.policyRole = 'reviewer'
  rt.state.projectAttempts = { a: { workspaces: { developer: workspace } } }
  const id = await harness.spawn({ executionProjectId: 'p', executionWorkDir: cwd, prompt: 'Review only' })
  const result = new Promise(resolve => harness.onResult(resolve))
  await harness.dispatch({ botId: id, taskId: 't', brief: 'Review', outputs: [{ name: 'implementation' }] })
  await result
  const events = (await readFile(rt.state.projectHarnessWorkers[id].eventLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  const settings = events.find(row => row.event?.type === 'debug').event
  assert.deepEqual(settings.writableRoots, []); assert.equal(settings.readOnly, true)
})

test('resource-side configuration failure remains environment evidence and releases only after worker exit', async t => {
  const { harness, rt, cwd } = await fixture(t)
  const file = join(rt.config.projectResources.r.runtimeDir, 'src/host/project-harness-worker.mjs')
  let source = await readFile(file, 'utf8')
  source = source.replace("write({type:'completed',sessionId:'bound-thread',text:'OUTPUT implementation: actual contract worker output',usage:{input_tokens:1}});", "write({type:'failure',reason:'Codex configuration is not ready',capabilityFailure:{code:'bot/harness-capability',kind:'legacy-sandbox-conflict',stage:'configuration',modelInvoked:false}});")
  await writeFile(file, source)
  const id = await harness.spawn({ executionProjectId: 'p', executionWorkDir: cwd, prompt: 'Do the assigned Task' })
  const result = new Promise(resolve => harness.onResult(resolve))
  await harness.dispatch({ botId: id, taskId: 't', brief: 'Frozen requirement', outputs: [{ name: 'implementation' }] })
  assert.equal((await result).ok, false)
  assert.equal(rt.state.projectHarnessWorkers[id].capabilityFailure.kind, 'legacy-sandbox-conflict')
  assert.equal(rt.state.projectHarnessHealth['p:r:codex'].status, 'environmentError')
  assert.equal(rt.projectResources.occupied('r'), 1)
  await harness.release(id)
  assert.equal(rt.projectResources.occupied('r'), 0)
})

test('a declared warmed npm cache is copied into this worker scratch without sharing writable dependency state', async t => {
  const { rt, harness, cwd } = await fixture(t)
  const session = rt.projectDelivery.sessionFor()
  session.environmentPreparation = { id: 'environment-fixture', principalId: 'owner', status: 'ready', projectId: 'p', attemptId: 'a', workspaceId: 'w', resourceId: 'r', cache: '.prepared-npm-cache', identitySha256: 'a'.repeat(64) }
  await mkdir(join(cwd, '.prepared-npm-cache'))
  await writeFile(join(cwd, '.prepared-npm-cache', 'warm-entry'), 'sealed-cache')
  const id = await harness.spawn({ executionProjectId: 'p', executionWorkDir: cwd, prompt: 'Use only prepared dependencies' })
  const row = rt.state.projectHarnessWorkers[id]
  assert.equal(row.dependencyPreparationId, 'environment-fixture')
  assert.equal(await readFile(join(row.scratchDirectory, 'npm-cache/warm-entry'), 'utf8'), 'sealed-cache')
  await writeFile(join(row.scratchDirectory, 'npm-cache/warm-entry'), 'worker-write')
  assert.equal(await readFile(join(cwd, '.prepared-npm-cache/warm-entry'), 'utf8'), 'sealed-cache')
  await harness.release(id)
  assert.equal(rt.projectResources.occupied('r'), 0)
})

test('SDK command cache misses are advisory environment facts, never independent test results', async t => {
  const { rt, harness, cwd } = await fixture(t)
  const file = join(rt.config.projectResources.r.runtimeDir, 'src/host/project-harness-worker.mjs')
  const source = await readFile(file, 'utf8')
  await writeFile(file, source.replace("write({type:'completed'", "write({type:'sdk-event',event:{type:'item.completed',item:{id:'cmd-1',type:'command_execution',exit_code:1,aggregated_output:'npm error ENOTCACHED only-if-cached'}}});write({type:'completed'"))
  const id = await harness.spawn({ executionProjectId: 'p', executionWorkDir: cwd, prompt: 'Record actual dependency limitations' })
  const result = new Promise(resolve => harness.onResult(resolve))
  await harness.dispatch({ botId: id, taskId: 't', brief: 'Frozen requirement', outputs: [{ name: 'implementation' }] })
  assert.equal((await result).ok, true)
  const observations = rt.state.projectHarnessWorkers[id].environmentObservations
  assert.equal(observations.length, 1)
  assert.equal(observations[0].status, 'environment-blocked')
  assert.match(observations[0].source, /not independent verification/)
  assert.match(observations[0].outputSha256, /^[a-f0-9]{64}$/)
  assert.equal(rt.state.projectAttempts?.a?.evidence?.tests, undefined)
  await harness.release(id)
})

test('Workflow result callback can await the same SDK worker release without blocking stop acknowledgement', async t => {
  const { rt, harness, cwd } = await fixture(t)
  const id = await harness.spawn({ executionProjectId: 'p', executionWorkDir: cwd, prompt: 'Implement Task' })
  let finish, fail
  const completed = new Promise((resolve, reject) => { finish = resolve; fail = reject })
  harness.onResult(async () => { try { await harness.release(id); finish() } catch (error) { fail(error) } })
  await harness.dispatch({ botId: id, taskId: 't', brief: 'Frozen requirement', outputs: [{ name: 'implementation' }] })
  await completed
  assert.equal(rt.state.projectHarnessWorkers[id].status, 'released')
  assert.equal(rt.projectResources.occupied('r'), 0)
})

test('resource SDK version handshake fails before task dispatch and releases the unstarted worker', async t => {
  const { rt, harness, cwd } = await fixture(t)
  const path = join(rt.config.projectResources.r.runtimeDir, 'src/host/project-harness-worker.mjs')
  const source = await readFile(path, 'utf8')
  await writeFile(path, source.replace("codex:'0.166.0'", "codex:'0.0.0'"))
  await assert.rejects(harness.spawn({ executionProjectId: 'p', executionWorkDir: cwd, prompt: 'Must not be dispatched' }), /version.*missing or incompatible/)
  assert.equal(rt.projectResources.occupied('r'), 0)
  assert.ok(Object.values(rt.state.projectHarnessWorkers).every(row => row.status === 'released'))
})

test('missing SDK bridge is an environment failure with no inference or leaked reservation', async t => {
  const { rt, harness, cwd } = await fixture(t)
  rt.config.projectResources.r.runtimeDir = join(rt.home, 'missing-runtime')
  await assert.rejects(harness.spawn({ executionProjectId: 'p', executionWorkDir: cwd, prompt: 'Must not be dispatched' }), /runtime exited before/)
  assert.equal(rt.projectResources.occupied('r'), 0)
})

test('a raw JSON handoff gains only its missing framing, preserving the actual model decision', () => {
  const value = { action: 'arbitrate', reason: 'No sealed candidate is available', outputs: { tests: 'Not run' } }
  assert.equal(handoffFrame(JSON.stringify(value), ['handoff']), 'OUTPUT handoff: ' + JSON.stringify(value))
  assert.equal(handoffFrame('OUTPUT handoff: ' + JSON.stringify(value), ['handoff']), 'OUTPUT handoff: ' + JSON.stringify(value))
  assert.equal(handoffFrame(JSON.stringify(value), ['tests']), JSON.stringify(value))
  for (const text of ['Please decide for me', '{}', '{"action":"close","reason":"done"}', 'null']) assert.equal(handoffFrame(text, ['handoff']), text)
})


test('command workers bind distinct scratch directories and clean them only after confirmed exit', async t => {
  const { rt, harness, cwd } = await fixture(t)
  rt.projectDelivery.sessionFor().role = 'reviewer'
  const id = await harness.spawn({ executionProjectId: 'p', executionWorkDir: cwd, prompt: 'Review candidate' })
  const row = rt.state.projectHarnessWorkers[id]
  assert.equal((await stat(row.scratchDirectory)).isDirectory(), true)
  assert.equal((await stat(row.scratchDirectory)).mode & 0o777, 0o700)
  assert.notEqual(row.scratchDirectory, cwd)
  assert.ok(row.scratchDirectory.endsWith('.flybot-scratch-' + id))
  await harness.release(id)
  assert.ok(row.scratchCleanedAt)
  await assert.rejects(stat(row.scratchDirectory), { code: 'ENOENT' })
  assert.equal(row.releaseProof.kind, 'sdk-stop-ack-and-process-exit')
})


for (const disclosure of ['context', 'warning']) test('SDK Chief ' + disclosure + ' requests continue the same worker before final judgement and retain memory effects', async t => {
  const {rt,harness}=await fixture(t)
  const {roleContext,readContextArchive}=await import('../src/host/project-role-context.js')
  const path=join(rt.config.projectResources.r.runtimeDir,'src/host/project-harness-worker.mjs')
  await writeFile(path,`
import{createInterface}from'node:readline';
const write=v=>process.stdout.write(JSON.stringify(v)+'\\n');write({type:'ready',sdk:{codex:'0.166.0'}});
createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);
if(m.type==='stop'){write({type:'stopped',released:true});setTimeout(()=>process.exit(0),20)}
if(m.type==='start'){write({type:'sdk-event',event:{type:'thread.started',thread_id:'chief-context-thread'}});write({type:'completed',sessionId:'chief-context-thread',text:JSON.stringify(${JSON.stringify(disclosure === 'warning' ? {warningRequests:[{warningId:'warning-fixture',topic:'progress'}]} : {contextRequests:[{kind:'knowledge',id:'fact'}]})})})}
if(m.type==='input'){if(!m.prompt.includes('Verified pnpm decision'))process.exit(2);write({type:'completed',sessionId:'chief-context-thread',text:JSON.stringify({reply:'Retained the project decision',actions:[],memoryUpdates:[{text:'Project uses pnpm',topic:'development'}]})})}
});`)
  const context=roleContext({projectId:'p',role:'chief',definition:{},knowledge:[{id:'fact',text:'Verified pnpm decision'}],retrieval:true})
  let memoryWrites=0,exchanges=0,finish
  const done=new Promise(resolve=>{finish=resolve})
  rt.projectAgents={isDelegationActive:()=>true,contextExchange:async(agentId,delegationId,data,snapshot)=>{
    assert.equal(agentId,'public-p');assert.equal(delegationId,'d');exchanges++
    if(data.memoryUpdates?.length)memoryWrites+=data.memoryUpdates.length
    if(data.warningRequests?.length)assert.equal(data.warningRequests[0].warningId,'warning-fixture')
    return {reads:data.warningRequests?.length?[{text:'Verified pnpm decision'}]:data.contextRequests?.length?readContextArchive(snapshot,data.contextRequests):[],writes:[]}
  }}
  rt.config.projectResources.r.harnesses=['codex'];rt.state.projectResourceHealth={r:{status:'ready',at:Date.now()}};rt.state.projectHarnessHealth={'p:r:codex': { status: 'ready', profile: harnessProfile(rt.config.projectResources['r'], rt.readProject('p'), 'r', 'codex').profile }};delete rt.state.projectResourceLeases.l
  const agent={id:'public-p',projectId:'p',lastRequest:{}}
  const id=await harness.chiefTurn({agent,delegation:{id:'d',definitionRevision:1},definition:{execution:{harness:'codex',resourceIds:['r'],model:'test-model'}},context,text:'Read the saved decision',onResult:finish})
  const result=await done
  assert.equal(result.ok,true)
  assert.equal(result.backendSessionId,'chief-context-thread')
  assert.equal(JSON.parse(result.text).reply,'Retained the project decision')
  assert.equal(exchanges,2);assert.equal(memoryWrites,1)
  await harness.release(id)
  assert.equal(rt.projectResources.occupied('r'),0)
  assert.match(await readFile(rt.state.projectHarnessWorkers[id].sealedLog,'utf8'),new RegExp(disclosure === 'warning' ? 'warningRequests' : 'contextRequests'))
})


test('conversation carriers for non-Chief roles cannot gain development shell or write capabilities', async t => {
  const {rt,harness}=await fixture(t)
  rt.config.projectResources.r.harnesses=['codex'];rt.state.projectResourceHealth={r:{status:'ready',at:Date.now()}};rt.state.projectHarnessHealth={'p:r:codex': { status: 'ready', profile: harnessProfile(rt.config.projectResources['r'], rt.readProject('p'), 'r', 'codex').profile }};delete rt.state.projectResourceLeases.l
  rt.projectAgents={isDelegationActive:()=>true}
  for(const role of ['developer','reviewer']) {
    const agent={id:'room-'+role,projectId:'p',role,roomId:'room',lastRequest:{}}
    let finish;const done=new Promise(resolve=>{finish=resolve})
    const id=await harness.chiefTurn({agent,delegation:{id:'d-'+role,definitionRevision:1,readOnly:true},definition:{instructions:'Room conversation only',execution:{harness:'codex',resourceIds:['r'],model:'test-model'}},context:{text:'Scoped room context'},text:'Answer this ordinary room question',onResult:finish})
    assert.equal((await done).ok,true)
    const events=(await readFile(rt.state.projectHarnessWorkers[id].sealedLog,'utf8')).trim().split('\n').map(line=>JSON.parse(line))
    const flags=events.find(row=>row.event?.type==='debug').event
    assert.equal(flags.noTools,true,'A role label does not authorize tools for a conversation carrier')
    assert.equal(flags.readOnly,true)
    await harness.release(id)
  }
})


test('busy SDK queues feedback until a safe next turn in the same worker, thread and claim', async t => {
  const { rt, harness, cwd } = await fixture(t)
  const session = rt.projectDelivery.sessionFor()
  session.poolClaimId = 'claim'
  const task = rt.state.tasks.t
  task.status = 'working'; task.deliveryAttemptId = session.attemptId; session.generation = 2
  task.collaboration = { status: 'claimed', generation: 2, botId: 'p:developer', currentHandoffId: 'h', initiatedBy: 'owner', claim: { id: 'claim', generation: 2, botId: 'p:developer', status: 'active' } }
  rt.projects = { requireActive() {} }
  rt.projectEffects = createProjectEffects(rt); installProjectInputs(rt)
  rt.save = async () => {
    const proof = rt.projectEffects.capture()
    await writeFile(join(rt.home, 'inbox-state.json'), JSON.stringify(rt.state))
    rt.projectEffects.saved(proof)
  }
  const runtime = rt.config.projectResources.r.runtimeDir
  await writeFile(join(runtime, 'src/host/project-harness-worker.mjs'), `
import {createInterface} from 'node:readline';import {existsSync} from 'node:fs';
const write=v=>process.stdout.write(JSON.stringify(v)+'\\n');const batches=[];
write({type:'ready',sdk:{codex:'0.166.0'}});
createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);
 if(m.type==='stop'){write({type:'stopped',released:true});setTimeout(()=>process.exit(0),20);return;}
 if(m.type==='start'){
  const data=JSON.parse(m.prompt.match(/Inputs: ([^\\n]+)/)[1]);batches.push(data.taskInbox);
  write({type:'sdk-event',event:{type:'thread.started',thread_id:'same-thread'}});
  write({type:'sdk-event',event:{type:'item.completed',item:{type:'agent_message',text:'First turn is busy'}}});
  const poll=setInterval(()=>{if(!existsSync('finish-first'))return;clearInterval(poll);write({type:'completed',sessionId:'same-thread',text:'OUTPUT handoff: '+JSON.stringify({action:'arbitrate',reason:'Prior proposal not yet applied'})});},10);
 }
 if(m.type==='input'){
  batches.push(JSON.parse(m.prompt.split('New durable Task inbox: ')[1]));
  write({type:'sdk-event',event:{type:'item.completed',item:{type:'agent_message',text:'Read queued feedback'}}});
  const inputReceipts=batches.map(b=>({batchId:b.batchId,read:b.inputs.map(i=>i.id),handled:b.inputs.map(i=>i.id)}));
  write({type:'completed',sessionId:'same-thread',text:'OUTPUT handoff: '+JSON.stringify({action:'arbitrate',reason:'Both feedback inputs processed; Chief must judge',inputReceipts})});
 }
});`)
  await rt.projectInputs.publish({projectId:'p',taskId:'t',requestId:'first',text:'Keep original groups'}, {memberId:'owner'})
  const initial = await rt.projectInputs.prepare('t', task.collaboration.claim)
  const id = await harness.spawn({executionProjectId:'p',executionWorkDir:cwd,prompt:'Process the current Task'})
  task.collaboration.claim.workerId = id
  let resultCount = 0
  const result = new Promise(resolve => harness.onResult(row => { resultCount++; resolve(row) }))
  await harness.dispatch({botId:id,taskId:'t',brief:'Task criteria',inputs:{taskInbox:initial},outputs:[{name:'handoff'}]})
  for(let n=0;n<200 && rt.state.projectHarnessWorkers[id].eventCount<3;n++) await new Promise(resolve=>setTimeout(resolve,5))
  assert.equal(rt.state.projectHarnessWorkers[id].status,'running')
  const second = await rt.projectInputs.publish({projectId:'p',taskId:'t',requestId:'second',text:'Retain personal Chief too'}, {memberId:'owner'})
  assert.equal(rt.projectInputs.list({projectId:'p',taskId:'t'},{memberId:'owner'}).inputs.find(i=>i.id===second.input.id).phase,'accepted')
  await writeFile(join(cwd,'finish-first'),'ready')
  const output = await result
  assert.equal(output.ok,true)
  assert.equal(resultCount,1,'The intermediate proposal must not trigger a handoff')
  assert.equal(Object.keys(rt.state.projectHarnessWorkers).length,1)
  assert.equal(rt.state.projectHarnessWorkers[id].backendSessionId,'same-thread')
  assert.equal(rt.state.projectHarnessWorkers[id].safeInputTurns,1)
  const decision=JSON.parse(output.text.split('OUTPUT handoff: ')[1])
  await rt.projectInputs.acknowledge('t',task.collaboration.claim,decision.inputReceipts)
  assert.ok(rt.projectInputs.list({projectId:'p',taskId:'t'},{memberId:'owner'}).inputs.every(i=>i.phase==='handled'))
  assert.equal(task.status,'working')
  await harness.release(id)
})

test('safe SDK input turns are bounded and excess feedback remains for the next responsible Bot', async t => {
  const {rt,harness,cwd}=await fixture(t),session=rt.projectDelivery.sessionFor(),task=rt.state.tasks.t
  session.poolClaimId='bounded-claim';task.status='working';task.deliveryAttemptId=session.attemptId;session.generation=2
  task.collaboration={status:'claimed',generation:2,botId:'p:developer',initiatedBy:'owner',claim:{id:session.poolClaimId,generation:2,botId:'p:developer',status:'active'}}
  rt.projects={requireActive(){}};rt.projectEffects=createProjectEffects(rt);installProjectInputs(rt)
  rt.save=async()=>{rt.projectEffects.saved(rt.projectEffects.capture())}
  await writeFile(join(rt.config.projectResources.r.runtimeDir,'src/host/project-harness-worker.mjs'),`
import{createInterface}from'node:readline';import{existsSync,writeFileSync}from'node:fs';
const write=v=>process.stdout.write(JSON.stringify(v)+'\\n');const batches=[];let round=0;
write({type:'ready',sdk:{codex:'0.166.0'}});
createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);
if(m.type==='stop'){write({type:'stopped',released:true});setTimeout(()=>process.exit(0),20);return;}
if(!['start','input'].includes(m.type))return;
const batch=m.type==='start'?JSON.parse(m.prompt.match(/Inputs: ([^\\n]+)/)[1]).taskInbox:JSON.parse(m.prompt.split('New durable Task inbox: ')[1]);batches.push(batch);
write({type:'sdk-event',event:{type:'thread.started',thread_id:'bounded-thread'}});writeFileSync('ready-'+round,'ready');
const current=round++;const timer=setInterval(()=>{if(!existsSync('allow-'+current))return;clearInterval(timer);
const inputReceipts=batches.map(b=>({batchId:b.batchId,read:b.inputs.map(i=>i.id),handled:b.inputs.map(i=>i.id)}));
write({type:'completed',sessionId:'bounded-thread',text:'OUTPUT handoff: '+JSON.stringify({action:'arbitrate',reason:'Process bounded batches; leave any newer inputs pending',inputReceipts})});},5);
});`)
  await rt.projectInputs.publish({projectId:'p',taskId:'t',requestId:'initial',text:'Initial feedback'},{memberId:'owner'})
  const batch=await rt.projectInputs.prepare('t',task.collaboration.claim)
  const id=await harness.spawn({executionProjectId:'p',executionWorkDir:cwd,prompt:'Process bounded Task input'})
  task.collaboration.claim.workerId=id
  const result=new Promise(resolve=>harness.onResult(resolve))
  await harness.dispatch({botId:id,taskId:'t',brief:'Task',inputs:{taskInbox:batch},outputs:[{name:'handoff'}]})
  for(let n=0;n<5;n++){
    let ready=false
    for(let tries=0;tries<400;tries++){try{await stat(join(cwd,'ready-'+n));ready=true;break}catch{await new Promise(resolve=>setTimeout(resolve,5))}}
    assert.equal(ready,true,'The same worker should reach the expected safe turn')
    await rt.projectInputs.publish({projectId:'p',taskId:'t',requestId:'busy-'+n,text:'Feedback arriving during round '+n},{memberId:'owner'})
    await writeFile(join(cwd,'allow-'+n),'proceed')
  }
  const output=await result;assert.equal(output.ok,true)
  const decision=JSON.parse(output.text.split('OUTPUT handoff: ')[1])
  await rt.projectInputs.acknowledge('t',task.collaboration.claim,decision.inputReceipts)
  assert.equal(rt.state.projectHarnessWorkers[id].safeInputTurns,4)
  assert.equal(Object.keys(rt.state.projectHarnessWorkers).length,1)
  const pending=rt.projectInputs.pending('t')
  assert.equal(pending.length,1)
  assert.throws(()=>rt.projectInputs.requireHandled('t'),/unhandled/)
  assert.equal(task.status,'working')
  await harness.release(id)
})

async function taskInputFixture(t, workerSource) {
  const f=await fixture(t),{rt,harness}=f,session=rt.projectDelivery.sessionFor(),task=rt.state.tasks.t
  session.poolClaimId='idle-claim';task.status='working';task.deliveryAttemptId=session.attemptId;session.generation=2
  task.collaboration={status:'claimed',generation:2,botId:'p:developer',initiatedBy:'owner',claim:{id:session.poolClaimId,generation:2,botId:'p:developer',status:'active'}}
  rt.projects={requireActive(){}};rt.projectEffects=createProjectEffects(rt);installProjectInputs(rt);rt.projectHarness=harness
  rt.save=async()=>{const proof=rt.projectEffects.capture();await writeFile(join(rt.home,'inbox.json'),JSON.stringify(rt.state));rt.projectEffects.saved(proof)}
  await writeFile(join(rt.config.projectResources.r.runtimeDir,'src/host/project-harness-worker.mjs'),workerSource)
  const id=await harness.spawn({executionProjectId:'p',executionWorkDir:f.cwd,prompt:'Process Task feedback'})
  task.collaboration.claim.workerId=id
  return {...f,task,id}
}

test('ordinary Task feedback resumes a safe idle message turn without opening another SDK worker', async t => {
  const {rt,harness,task,id}=await taskInputFixture(t,`
import{createInterface}from'node:readline';const write=v=>process.stdout.write(JSON.stringify(v)+'\\n');write({type:'ready',sdk:{codex:'0.166.0'}});
createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.type==='stop'){write({type:'stopped',released:true});setTimeout(()=>process.exit(0),20);return;}
if(m.type==='start'){write({type:'sdk-event',event:{type:'thread.started',thread_id:'idle-thread'}});write({type:'completed',sessionId:'idle-thread',text:'Please clarify the existing Task scope'});}
if(m.type==='input'){const b=JSON.parse(m.prompt.split('New durable Task inbox: ')[1]);write({type:'sdk-event',event:{type:'item.completed',item:{type:'agent_message',text:'Read the scoped feedback'}}});write({type:'completed',sessionId:'idle-thread',text:'OUTPUT handoff: '+JSON.stringify({action:'arbitrate',reason:'Feedback clarifies scope; ask Chief',inputReceipts:{batchId:b.batchId,read:b.inputs.map(i=>i.id),handled:b.inputs.map(i=>i.id)}})});}
});`)
  const completed=new Promise(resolve=>harness.onResult(resolve))
  await harness.dispatch({botId:id,taskId:task.id,brief:'Current Task',outputs:[{name:'handoff'}]})
  for(let n=0;n<200&&rt.state.projectHarnessWorkers[id].status!=='waiting-input';n++)await new Promise(resolve=>setTimeout(resolve,5))
  assert.equal(rt.state.projectHarnessWorkers[id].pending.kind,'message')
  await rt.projectInputs.publish({projectId:'p',taskId:'t',requestId:'clarification',text:'Retain the original room tools'},{memberId:'owner'})
  await Promise.all([rt.projectEffects.drain(),harness.taskInputWake(task.id)])
  const result=await completed;assert.equal(result.ok,true)
  const decision=JSON.parse(result.text.split('OUTPUT handoff: ')[1])
  await rt.projectInputs.acknowledge(task.id,task.collaboration.claim,decision.inputReceipts)
  assert.equal(rt.state.projectHarnessWorkers[id].safeInputTurns,1)
  assert.equal(Object.keys(rt.state.projectHarnessWorkers).length,1)
  assert.equal(rt.state.projectHarnessWorkers[id].backendSessionId,'idle-thread')
  assert.equal(rt.projectInputs.pending(task.id).length,0)
  await harness.release(id)
})

test('Task feedback cannot answer an SDK permission prompt or replace its request identity', async t => {
  const {rt,harness,task,id}=await taskInputFixture(t,`
import{createInterface}from'node:readline';const write=v=>process.stdout.write(JSON.stringify(v)+'\\n');write({type:'ready',sdk:{codex:'0.166.0'}});
createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.type==='stop'){write({type:'stopped',released:true});setTimeout(()=>process.exit(0),20);return;}
if(m.type==='start')write({type:'permission',id:'original-permission-id',request:{name:'Bash',input:{command:'protected action'}}});
if(m.type==='input'||m.type==='permission')throw Error('Ordinary Task feedback must not approve a permission');
});`)
  await harness.dispatch({botId:id,taskId:task.id,brief:'Current Task',outputs:[{name:'handoff'}]})
  for(let n=0;n<200&&rt.state.projectHarnessWorkers[id].pending?.kind!=='permission';n++)await new Promise(resolve=>setTimeout(resolve,5))
  await rt.projectInputs.publish({projectId:'p',taskId:'t',requestId:'ordinary-feedback',text:'Please continue if allowed'},{memberId:'owner'})
  await rt.projectEffects.drain()
  assert.equal(rt.state.projectHarnessWorkers[id].status,'waiting-input')
  assert.equal(rt.state.projectHarnessWorkers[id].pending.id,'original-permission-id')
  assert.equal(rt.projectInputs.list({projectId:'p',taskId:'t'},{memberId:'owner'}).inputs[0].phase,'accepted')
  assert.equal(rt.projectInputs.pending(task.id).length,1)
  assert.deepEqual(await harness.taskInputWake(task.id),{woken:false,waitingFor:'permission'})
  await harness.release(id)
})

test('a result callback failing after confirmed release cannot poison the worker lifecycle', async t => {
  const { rt, harness, cwd } = await fixture(t)
  const id = await harness.spawn({ executionProjectId: 'p', executionWorkDir: cwd, prompt: 'Callback lifecycle' })
  let finished
  const done = new Promise(resolve => { finished = resolve })
  harness.onResult(async () => {
    await harness.release(id)
    finished()
    throw new Error('Downstream result handling failed after release')
  })
  await harness.dispatch({ botId: id, taskId: 't', brief: 'Frozen requirement', outputs: [{ name: 'implementation' }] })
  await done
  await new Promise(resolve => setTimeout(resolve, 30))
  const row=rt.state.projectHarnessWorkers[id]
  assert.equal(row.status,'released')
  assert.equal(row.releaseProof.kind,'sdk-stop-ack-and-process-exit')
  assert.equal(rt.projectResources.occupied('r'),0)
  assert.equal(row.failure,undefined)
})


test('changed caller prompt resumes the Task-role SDK thread when its role definition is unchanged', async t => {
  const { rt, harness, cwd } = await fixture(t)
  const first = await harness.spawn({ executionProjectId: 'p', executionWorkDir: cwd, prompt: 'Initial Task requirement' })
  const completed = new Promise(resolve => harness.onResult(resolve))
  await harness.dispatch({ botId: first, taskId: 't', brief: 'Initial work', outputs: [{ name: 'implementation' }] })
  await completed
  await harness.release(first)
  const session = rt.projectDelivery.sessionFor()
  session.id = 'returned-role-session'
  session.attemptId = 'second-attempt'
  rt.state.projectResourceHealth = { r: { status: 'ready' } }
  rt.state.projectHarnessHealth = { 'p:r:codex': { status: 'ready', profile: harnessProfile(rt.config.projectResources['r'], rt.readProject('p'), 'r', 'codex').profile } }
  session.resourceLease = await rt.projectResources.reserve({ projectId: 'p', attemptId: session.attemptId, role: 'developer', sessionKey: session.id, harness: 'codex', resourceIds: ['r'] })
  const next = await harness.spawn({ executionProjectId: 'p', executionWorkDir: cwd, prompt: 'Tester returned the Task with new feedback and changed candidate facts' })
  assert.equal(rt.state.projectHarnessWorkers[next].continuedFrom, first)
  assert.equal(rt.state.projectHarnessWorkers[next].backendSessionId, 'bound-thread')
  const returned = new Promise(resolve => harness.onResult(resolve))
  await harness.dispatch({ botId: next, taskId: 't', brief: 'Continue previous work', outputs: [{ name: 'implementation' }] })
  await returned
  assert.match(await readFile(rt.state.projectHarnessWorkers[next].eventLog, 'utf8'), /"resumeSessionId":"bound-thread"/)
})

test('every SDK delivery role resumes the original thread across an admitted cwd change and releases its reservation', async t => {
  for (const role of ['developer', 'tester', 'reviewer']) await t.test(role, async t => {
    const { rt, harness, cwd } = await fixture(t)
    const original = rt.projectDelivery.sessionFor(), oldWorkspace = rt.projectDelivery.ownsWorkspace('p', cwd)
    original.role = role; original.definition.role = role; oldWorkspace.role = role
    execFileSync('git', ['init', '-q', cwd]); oldWorkspace.repository = cwd
    rt.state.projectResourceLeases.l.role = role; rt.state.projectResourceLeases.l.principalId = 'owner'
    rt.state.tasks.t.id = 't'; rt.state.tasks.t.deliveryAttemptId = 'a'
    rt.state.projectAttempts = { a: { id: 'a', projectId: 'p', taskId: 't', status: 'running', roleSessions: { [role]: original }, workspaces: { [role]: oldWorkspace } } }
    const first = await harness.spawn({ executionProjectId: 'p', executionWorkDir: cwd, prompt: 'Original Task and role convention' })
    const complete = new Promise(resolve => harness.onResult(resolve))
    await harness.dispatch({ botId: first, taskId: 't', brief: 'First execution', outputs: [{ name: 'implementation' }] })
    await complete; await harness.release(first)
    const path = join(rt.home, `new-${role}`)
    await mkdir(path)
    execFileSync('git', ['init', '-q', path])
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '--allow-empty', '-qm', 'fixture'], { cwd: path })
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path, encoding: 'utf8' }).trim()
    const nextSession = { ...structuredClone(original), id: `new-${role}`, attemptId: 'a2', status: 'prepared' }
    delete nextSession.backendSessionId; delete nextSession.botId
    const workspace = { id: 'new-workspace', projectId: 'p', attemptId: 'a2', role, path, repository: path, resourceId: 'r', status: 'allocated', materialization: { expectedCheckout: sha, actualCheckout: sha } }
    rt.state.projectAttempts.a2 = { id: 'a2', projectId: 'p', taskId: 't', status: 'running', roleSessions: { [role]: nextSession }, workspaces: { [role]: workspace } }
    rt.state.projectWorkspaces = { [workspace.id]: workspace }
    rt.state.tasks.t.deliveryAttemptId = 'a2'
    rt.state.projectResourceHealth = { r: { status: 'ready' } }; rt.state.projectHarnessHealth = { 'p:r:codex': { status: 'ready', profile: harnessProfile(rt.config.projectResources['r'], rt.readProject('p'), 'r', 'codex').profile } }
    nextSession.resourceLease = await rt.projectResources.reserve({ projectId: 'p', attemptId: 'a2', role, sessionKey: nextSession.id, harness: 'codex', resourceIds: ['r'] })
    rt.projectDelivery.sessionFor = () => nextSession
    rt.projectDelivery.ownsWorkspace = (_projectId, selected) => selected === path ? workspace : null
    rt.projectDelivery.bindSession = async (_workspace, bot) => rt.projectResources.markStarted(nextSession.resourceLease.id, nextSession.resourceLease.generation, { kind: 'sdk', handle: bot.id })
    const next = await harness.spawn({ executionProjectId: 'p', executionWorkDir: path, prompt: 'Continue the same Task after return' })
    const row = rt.state.projectHarnessWorkers[next]
    assert.equal(row.continuedFrom, first); assert.equal(row.backendSessionId, 'bound-thread')
    assert.equal(row.restoration.mode, 'resumed'); assert.equal(row.restoration.observedCheckout, sha)
    const done = new Promise(resolve => harness.onResult(resolve))
    await harness.dispatch({ botId: next, taskId: 't', brief: 'Continue original context', outputs: [{ name: 'implementation' }] })
    await done
    const evidence = await readFile(row.eventLog, 'utf8')
    assert.match(evidence, /"resumeSessionId":"bound-thread"/)
    const logical = rt.state.projectTaskSessions[row.logicalSessionId]
    assert.equal(logical.bindings.length, 2); assert.equal(logical.bindings[1].restoration.mode, 'resumed')
    assert.equal(logical.bindings[0].sessionId, logical.bindings[1].sessionId)
    await harness.release(next)
    assert.equal(rt.projectResources.occupied('r'), 0)
  })
})

test('a no-op state save cannot authorize SDK input, and the unstarted process remains releasable', async t => {
  const { rt, harness, cwd } = await fixture(t)
  const id = await harness.spawn({ executionProjectId: 'p', executionWorkDir: cwd, prompt: 'No uncommitted input' })
  rt.savesQueued = () => 0
  await assert.rejects(harness.dispatch({ botId: id, taskId: 't', brief: 'Must not be sent', outputs: [{ name: 'implementation' }] }), /commit a state snapshot/)
  assert.equal(rt.state.projectHarnessWorkers[id].backendSessionId, undefined)
  assert.equal(rt.state.projectHarnessWorkers[id].executionStartedAt, null)
  await harness.release(id)
  assert.equal(rt.projectResources.occupied('r'), 0)
})


test('Harness capability inspection distinguishes SDK support, native limitations and unknown adapters', () => {
  for (const harness of ['codex', 'claude-agent']) {
    const capabilities = harnessCapabilities(harness)
    assert.equal(capabilities.taskRoleResume, true)
    assert.equal(capabilities.crossHarnessResume, false)
    assert.equal(capabilities.input, 'between-sdk-turns')
    capabilities.taskRoleResume = false
    assert.equal(harnessCapabilities(harness).taskRoleResume, true)
  }
  assert.equal(harnessCapabilities('flybot').taskRoleResume, true)
  assert.equal(harnessCapabilities('flybot').exitConfirmation, 'native-agent-quiescence')
  assert.equal(harnessCapabilities('flybot').sdkVersion, null)
  assert.throws(() => harnessCapabilities('unknown'), /Unknown/)
})

test('the actual SDK profile budget rejects oversized input before starting a backend Session', async t => {
  const { rt, harness, cwd } = await fixture(t)
  rt.config.projectContext = { models: { 'test-model': { windowTokens: 4000, outputTokens: 500, toolTokens: 500, protocolTokens: 300 } } }
  const id = await harness.spawn({ executionProjectId: 'p', executionWorkDir: cwd, prompt: 'Keep the contract' })
  await assert.rejects(harness.dispatch({ botId: id, taskId: 't', brief: 'Mandatory current input '.repeat(1000), outputs: [{ name: 'implementation' }] }), { code: 'bot/context-budget' })
  assert.equal(rt.state.projectHarnessWorkers[id].executionStartedAt, null)
  assert.equal(rt.state.projectHarnessWorkers[id].backendSessionId, undefined)
  const result = new Promise(resolve => harness.onResult(resolve))
  await harness.dispatch({ botId: id, taskId: 't', brief: 'Use a bounded next step', outputs: [{ name: 'implementation' }] })
  assert.equal((await result).ok, true)
  assert.equal(rt.state.projectHarnessWorkers[id].inputUsage.withinBudget, true)
})

test('native input budget checks the exact role and message with a durable generation fence', async () => {
  const { createContextBudget } = await import('../src/host/project-context-budget.js')
  const budget = createContextBudget({ defaults: { windowTokens: 4000, outputTokens: 500, toolTokens: 500, protocolTokens: 300 } })
  const claim = { id: 'claim', generation: 2, status: 'active', botId: 'p:developer', workerId: 'native' }
  const session = { id: 's', projectId: 'p', taskId: 't', role: 'developer', generation: 2, poolClaimId: 'claim', botId: 'native', status: 'bound', context: { budget } }
  let saves = 0
  const rt = { state: { bots: { native: { id: 'native', attemptId: 'a', systemPrompt: 'Mandatory role convention' } }, tasks: { t: { projectId: 'p', collaboration: { initiatedBy: 'owner', generation: 2, claim } } }, projectAttempts: { a: { id: 'a', projectId: 'p', taskId: 't', status: 'running', roleSessions: { developer: session } } } }, config: {},
    save: async () => { saves++ }, savesQueued: () => saves, projects: { requireActive() {} }, requireProjectAccess() {}, projectDelegations: { background: async () => {} } }
  rt.botOf = id => rt.state.bots[id]
  const harness = createProjectHarness(rt)
  assert.equal((await harness.checkNativeInput({ botId: 'native', taskId: 't', text: 'Current Task input' })).checked, true)
  await assert.rejects(harness.checkNativeInput({ botId: 'native', taskId: 't', text: 'Large mandatory input'.repeat(1000) }), { code: 'bot/context-budget' })
  await assert.rejects(harness.checkNativeInput({ botId: 'native', taskId: 'foreign', text: 'Wrong scope' }), /scope/)
  rt.save = async () => { saves++; claim.status = 'revoked' }
  await assert.rejects(harness.checkNativeInput({ botId: 'native', taskId: 't', text: 'Raced input' }), /superseded/)
  assert.equal(session.inputUsage.withinBudget, true)
})

test('SDK sandbox policy follows pinned capability while custom logical role identity remains distinct', async t => {
  for (const [role, policyRole, readOnly] of [['implementer', 'developer', false], ['auditor', 'reviewer', true]]) {
    await t.test(role, async t => {
      const f = await fixture(t), session = f.rt.projectDelivery.sessionFor()
      session.role = role; session.policyRole = policyRole
      session.definition = { ...session.definition, role, policyRole }
      f.rt.state.projectAgentDefinitions = { p: { revision: 1, roles: [session.definition] } }
      f.rt.state.projectResourceLeases.l.role = role
      f.rt.projectDelivery.ownsWorkspace('p', f.cwd).role = role
      let resolve; const result = new Promise(done => { resolve = done })
      f.harness.onResult(resolve)
      const id = await f.harness.spawn({ executionProjectId: 'p', executionWorkDir: f.cwd, prompt: 'Execute the pinned capability contract' })
      await f.harness.dispatch({ botId: id, brief: 'Inspect assigned work', inputs: {} })
      await result; await f.harness.release(id)
      const row = f.rt.state.projectHarnessWorkers[id]
      const events = (await readFile(row.sealedLog, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line))
      const debug = events.find(item => item.event?.type === 'debug')
      assert.equal(debug.event.readOnly, readOnly)
      assert.equal(row.role, role); assert.equal(row.policyRole, policyRole)
      assert.equal(f.rt.state.projectTaskSessions[row.logicalSessionId].role, role)
    })
  }
})

test('an actual prepared SDK subprocess receives no start after its role resource is revoked', async t => {
  const { pinTaskRoleDefinition } = await import('../src/host/project-task-sessions.js')
  const { rt, harness, cwd } = await fixture(t), session = rt.projectDelivery.sessionFor()
  const task = rt.state.tasks.t
  session.poolClaimId = 'revoked-start'; session.generation = 2; task.deliveryAttemptId = session.attemptId
  task.collaboration = { initiatedBy: 'owner', generation: 2, claim: { id: session.poolClaimId, generation: 2, status: 'active', botId: 'p:developer', role: 'developer' } }
  const role = { id: 'p:developer', ...session.definition, execution: { harness: 'codex', resourceIds: ['r'] } }
  const catalog = { revision: 1, roles: [role] }
  rt.projectAgents = { deliveryDefinitions: () => catalog }
  Object.assign(session, pinTaskRoleDefinition(rt.state, session, role, 1, catalog))
  const id = await harness.spawn({ executionProjectId: 'p', executionWorkDir: cwd, prompt: 'Do not execute after revocation' })
  task.collaboration.claim.workerId = id
  role.execution.resourceIds = []
  await assert.rejects(harness.dispatch({ botId: id, taskId: task.id, brief: 'Current Task', outputs: [{ name: 'handoff' }] }), /revoked/)
  const row = rt.state.projectHarnessWorkers[id]
  assert.equal(row.executionStartedAt, null)
  assert.equal(row.status, 'prepared')
  await harness.release(id)
  assert.equal(row.releaseProof.kind, 'sdk-stop-ack-and-process-exit')
  assert.equal(rt.state.projectResourceLeases.l.status, 'released')
})

test('existing pool revocation stops an actual live SDK worker before resource release after role rights change', async t => {
  for (const revocation of ['role-resource', 'operator-disable', 'requirements-revision']) await t.test(revocation, async t => {
  const { pinTaskRoleDefinition } = await import('../src/host/project-task-sessions.js')
  const { reconcileExecutionAuthority } = await import('../src/host/project-execution-authority.js')
  const { createProjectPools } = await import('../src/host/project-pools.js')
  const { rt, harness, cwd } = await fixture(t), session = rt.projectDelivery.sessionFor(), task = rt.state.tasks.t
  session.poolClaimId = 'live-revoke'; session.generation = 2; task.deliveryAttemptId = session.attemptId
  task.collaboration = { status: 'claimed', initiatedBy: 'owner', generation: 2, claim: { id: session.poolClaimId, generation: 2, status: 'active', botId: 'p:developer', role: 'developer' } }
  const role = { id: 'p:developer', ...session.definition, execution: { harness: 'codex', resourceIds: ['r'] } }
  const catalog = { revision: 1, roles: [role] }
  rt.projectAgents = { deliveryDefinitions: () => catalog }
  rt.state.projectAttempts = { [session.attemptId]: { roleSessions: { developer: session }, requirement: { projectTaskRevision: 1 } } }
  if (revocation === 'requirements-revision') task.projectTask = { requirements: { revision: 1 } }
  Object.assign(session, pinTaskRoleDefinition(rt.state, session, role, 1, catalog))
  rt.projectPools = createProjectPools(rt)
  rt.projectPools.connect({ release: id => harness.release(id) })
  const id = await harness.spawn({ executionProjectId: 'p', executionWorkDir: cwd, prompt: 'Current Task' })
  session.botId = id; task.collaboration.claim.workerId = id
  await harness.dispatch({ botId: id, taskId: task.id, brief: 'Current Task', outputs: [{ name: 'handoff' }] })
  for (let n = 0; n < 200 && rt.state.projectHarnessWorkers[id].status !== 'waiting-input'; n++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(rt.state.projectHarnessWorkers[id].status, 'waiting-input')
  if (revocation === 'role-resource') role.execution.resourceIds = []
  else if (revocation === 'operator-disable') rt.config.projectResources.r.disabled = true
  else task.projectTask.requirements.revision++
  await reconcileExecutionAuthority(rt)
  assert.equal(task.collaboration.status, 'blocked')
  assert.equal(task.collaboration.claim.status, 'revoked')
  assert.equal(task.collaboration.claim.exitConfirmed, true)
  assert.equal(rt.state.projectHarnessWorkers[id].releaseProof.kind, 'sdk-stop-ack-and-process-exit')
  assert.equal(rt.state.projectResourceLeases.l.status, 'released')
  assert.equal(harness.hasController(id), false)
  })
})

test('SDK human input rechecks the sending actor after awaited initiator authorization', async t => {
  const { rt, harness, task, id } = await taskInputFixture(t, `
import {createInterface} from 'node:readline';const write=v=>process.stdout.write(JSON.stringify(v)+'\\n');write({type:'ready',sdk:{codex:'0.166.0'}});
createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.type==='stop'){write({type:'stopped',released:true});setTimeout(()=>process.exit(0),20);return;}
if(m.type==='start')write({type:'completed',sessionId:'input-actor-thread',text:'Need clarification'});
});`)
  await harness.dispatch({ botId: id, taskId: task.id, brief: 'Current Task', outputs: [{ name: 'handoff' }] })
  for (let n = 0; n < 200 && rt.state.projectHarnessWorkers[id].status !== 'waiting-input'; n++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(rt.state.projectHarnessWorkers[id].status, 'waiting-input')
  let senderAllowed = true
  rt.requireProjectAccess = actor => { if (actor.memberId !== 'owner' && !senderAllowed) throw Error('Sending member was removed') }
  rt.projectDelegations = { async background() { senderAllowed = false } }
  await assert.rejects(harness.input({ workerId: id, generation: rt.state.projectHarnessWorkers[id].generation, text: 'Late unauthorized input' }, { memberId: 'sender' }), /Sending member was removed/)
  assert.equal(rt.state.projectHarnessWorkers[id].status, 'waiting-input')
})


test('an actual SDK protocol subprocess must exit before its Chief input wait frees project capacity', async t => {
  const { rt, harness, cwd } = await fixture(t)
  rt.state.bots = {}; rt.state.projectAttempts = { a: { id: 'a', taskId: 't', projectId: 'p', status: 'running' } }
  rt.state.projectExecutions = { run: { id: 'run', attemptId: 'a', taskId: 't', projectId: 'p', status: 'running' } }
  rt.state.tasks.t.deliveryAttemptId = 'a'
  const scheduler = createProjectScheduler(rt)
  const id = await harness.spawn({ executionProjectId: 'p', executionWorkDir: cwd, prompt: 'Test execution exit and waiting capacity' })
  const result = new Promise(resolve => harness.onResult(resolve))
  await harness.dispatch({ botId: id, taskId: 't', brief: 'Capacity checkpoint', outputs: [{ name: 'implementation' }] })
  assert.equal((await result).ok, true)
  rt.state.tasks.t.chiefQuestion = { decisionId: 'chief-input', reason: 'Chief requests a scoped project input' }
  rt.state.tasks.t.collaboration = { status: 'blocked', claim: { workerId: id, role: 'developer', status: 'completed' }, history: [] }
  await scheduler.captureWait(rt.state.tasks.t)
  assert.equal(scheduler.slots('p'), 1); assert.equal(rt.projectResources.occupied('r'), 1)
  assert.equal(scheduler.capacity('p').exitUnknown, 1)
  await harness.release(id)
  // The minimal Harness fixture omits role on its pre-existing lease; real reservations carry it.
  rt.state.projectResourceLeases.l.role = 'developer'
  assert.equal(rt.state.projectHarnessWorkers[id].releaseProof.kind, 'sdk-stop-ack-and-process-exit')
  assert.equal(scheduler.slots('p'), 0); assert.equal(rt.projectResources.occupied('r'), 0)
  assert.equal(scheduler.capacity('p').waitingInput, 1)
  assert.equal(rt.state.projectAttempts.a.status, 'running'); assert.equal(rt.state.projectExecutions.run.status, 'running')
  assert.equal(rt.state.projectHarnessWorkers[id].backendSessionId, 'bound-thread')
})

test('Chief reservation save failure must release its unstarted resource',async t=>{
const {rt,harness}=await fixture(t);
rt.projectAgents={isDelegationActive:()=>true}; rt.state.projectResourceHealth={r:{status:'ready',at:Date.now()}};rt.state.projectHarnessHealth={'p:r:codex': { status: 'ready', profile: harnessProfile(rt.config.projectResources['r'], rt.readProject('p'), 'r', 'codex').profile }};delete rt.state.projectResourceLeases.l;
rt.state.projectExecutions={inspection:{invocation:1}};let saves=0;rt.save=async()=>{if(++saves===2)throw new Error('correlation save failed')};
await assert.rejects(harness.chiefTurn({agent:{id:'public-p',projectId:'p',lastRequest:{}},delegation:{id:'d',chiefJob:{runId:'inspection',invocation:1}},definition:{execution:{harness:'codex',resourceIds:['r']}},context:{text:'Inspect'},text:'Inspect',onResult:async()=>{}}),/correlation save failed/);
assert.equal(rt.projectResources.occupied('r'),0);
assert.equal(Object.values(rt.state.projectResourceLeases)[0].chiefRunId,'inspection');
});

test('pre-worker SDK admission failure releases its reservation without deleting the Task context', async t => {
  for (const kind of ['profile', 'model', 'binding']) {
    const { rt, harness, cwd } = await fixture(t)
    if (kind === 'profile') delete rt.config.projectResources.r.profiles
    if (kind === 'model') delete rt.config.projectResources.r.profiles.owner.codex.model
    if (kind === 'binding') {
      const { taskSession } = await import('../src/host/project-task-sessions.js')
      const session = rt.projectDelivery.sessionFor(), logical = taskSession(rt.state, session)
      logical.bindings.push({ version: 'task-role-binding/v2', key: 'foreign', workerId: 'missing', sessionId: 'retained-thread' })
    }
    await assert.rejects(harness.spawn({ executionProjectId: 'p', executionWorkDir: cwd, prompt: 'Admission must not leak' }))
    assert.equal(rt.projectResources.occupied('r'), 0, kind)
    if (kind === 'binding') assert.equal(Object.values(rt.state.projectTaskSessions)[0].bindings[0].sessionId, 'retained-thread')
  }
})


test('registered SDK failure before spawn rolls back capacity with a verifiable no-start proof', async t => {
  const { rt, harness, cwd } = await fixture(t)
  const session = rt.projectDelivery.sessionFor()
  session.context.archive = { sources: [] }; session.context.archiveSha256 = 'a'.repeat(64)
  rt.projectResources.uploadFile = async () => { throw new Error('Injected pre-spawn archive failure') }
  await assert.rejects(harness.spawn({ executionProjectId: 'p', executionWorkDir: cwd, prompt: 'Fail before external spawn' }), /pre-spawn archive/)
  const row = Object.values(rt.state.projectHarnessWorkers)[0]
  assert.equal(row.status, 'released'); assert.equal(row.spawnPhase, 'aborted')
  assert.equal(row.releaseProof.kind, 'sdk-worker-not-started')
  assert.equal(rt.projectResources.occupied('r'), 0)
  const { confirmedWorkerExit } = await import('../src/host/project-task-sessions.js')
  assert.equal(confirmedWorkerExit(rt.state, row), true)
  assert.equal(rt.state.projectAttempts, undefined, 'No Task history is rewritten by resource cleanup')
})

test('SDK receipt correction keeps its physical Session and sealed execution, and discards late prior completions', async t => {
  const { rt, harness, task, id } = await taskInputFixture(t, `
import{createInterface}from'node:readline';const write=v=>process.stdout.write(JSON.stringify(v)+'\\n');write({type:'ready',receiptCorrection:'input-correction/v1',sdk:{codex:'0.166.0'}});
createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.type==='stop'){write({type:'stopped',released:true});setTimeout(()=>process.exit(0),20);return;}
if(m.type==='start'){write({type:'sdk-event',event:{type:'thread.started',thread_id:'original-thread'}});write({type:'completed',sessionId:'original-thread',text:'OUTPUT handoff: {"action":"arbitrate","reason":"Original business result"}'});}
if(m.type==='input'){if(!m.protocolCorrection||!m.turnId)throw Error('Expected narrow correction');write({type:'completed',sessionId:'original-thread',text:'OUTPUT handoff: {"action":"complete","reason":"Late original result"}'});write({type:'completed',turnId:m.turnId,sessionId:'original-thread',text:'OUTPUT handoff: {"correctionOf":"proposal","inputReceipts":[]}'});}
});`)
  const claim = task.collaboration.claim; claim.attemptId = 'a'; claim.inputCorrection = { status: 'pending', round: 1 }
  let executions = 0, results = 0, originalHash, originalLog
  rt.projectDelivery.recordExecution = async () => { ++executions }
  let finish, fail
  const done = new Promise((resolve, reject) => { finish = resolve; fail = reject })
  harness.onResult(async result => {
    try {
      ++results
      if (results === 1) {
        originalHash = rt.state.projectHarnessWorkers[id].resultHash; originalLog = await readFile(rt.state.projectHarnessWorkers[id].sealedLog, 'utf8')
        await harness.correctInput({ workerId: id, task, claim, prompt: 'Correct only the receipt', round: 1 })
      } else finish(result)
    } catch (error) { fail(error) }
  })
  await harness.dispatch({ botId: id, taskId: 't', brief: 'Current work', outputs: [{ name: 'handoff' }] })
  const result = await done, worker = rt.state.projectHarnessWorkers[id]
  assert.equal(result.ok, true); assert.match(result.text, /correctionOf/)
  assert.equal(results, 2); assert.equal(executions, 1); assert.equal(worker.backendSessionId, 'original-thread')
  assert.equal(worker.resultHash, originalHash); assert.equal(await readFile(worker.sealedLog, 'utf8'), originalLog)
  assert.equal(worker.inputCorrectionResult.turnId, 'receipt-idle-claim-1')
})


test('role App worker capability is checked before admission and auth frames never enter event evidence', async t => {
  const token = 'ghs_fixture_ipc_token', scope = { sha256: 'a'.repeat(64) }
  let issues = 0
  const roleGithub = { async bind(_session, row) { row.githubAccess = { ...scope }; return scope }, async issue() { issues++; return { token, metadata: scope, expiresAt: Date.now() + 60000 } }, redact: value => value }
  let { rt, harness, cwd } = await fixture(t, roleGithub)
  await assert.rejects(harness.spawn({ executionProjectId: 'p', executionWorkDir: cwd, prompt: 'Never start without role capability' }), /lacks role App/)
  assert.equal(issues, 0)
  ;({ rt, harness, cwd } = await fixture(t, roleGithub))
  const file = join(rt.config.projectResources.r.runtimeDir, 'src/host/project-harness-worker.mjs')
  let source = await readFile(file, 'utf8')
  source = source.replace("write({type:'ready',sdk:", "write({type:'ready',roleGithub:'role-github/v1',sdk:")
  source = source.replace("if(m.type==='start') {", "if(m.type==='start') {globalThis.start=m;write({type:'github-auth-request',id:'11111111-1111-4111-8111-111111111111'});return;} if(m.type==='github-auth-response'){if(m.value?.token!=='ghs_fixture_ipc_token')process.exit(8);m.settings=globalThis.start.settings;")
  await writeFile(file, source)
  const id = await harness.spawn({ executionProjectId: 'p', executionWorkDir: cwd, prompt: 'Scoped auth IPC' })
  const result = new Promise(resolve => harness.onResult(resolve))
  await harness.dispatch({ botId: id, taskId: 't', brief: 'Frozen requirement', outputs: [{ name: 'implementation' }] })
  assert.equal((await result).ok, true); assert.equal(issues, 1)
  const row = rt.state.projectHarnessWorkers[id], log = await readFile(row.eventLog, 'utf8')
  assert.ok(!log.includes('github-auth')); assert.ok(!log.includes(token)); assert.ok(!JSON.stringify(rt.state).includes(token))
  await harness.release(id)
  assert.equal(row.githubAccess.renewing, false)
})

test('refresh-token reuse reaches the original worker/profile health without becoming a code verdict or leaking provider text', async t => {
  const { rt, harness, cwd } = await fixture(t)
  const file = join(rt.config.projectResources.r.runtimeDir, 'src/host/project-harness-worker.mjs')
  let source = await readFile(file, 'utf8')
  source = source.replace("write({type:'completed',sessionId:'bound-thread',text:'OUTPUT implementation: actual contract worker output',usage:{input_tokens:1}});", "write({type:'failure',authenticationFailure:{code:'refresh_token_reused'},reason:'fixture-private-auth-response'});")
  await writeFile(file, source)
  const id = await harness.spawn({ executionProjectId: 'p', executionWorkDir: cwd, prompt: 'Review the current candidate' })
  const result = new Promise(resolve => harness.onResult(resolve))
  await harness.dispatch({ botId: id, taskId: 't', brief: 'Frozen requirement', outputs: [{ name: 'implementation' }] })
  const failed = await result, row = rt.state.projectHarnessWorkers[id], health = rt.projectResources.harnessHealth('p','r','codex')
  assert.equal(failed.ok, false); assert.match(failed.text, /refresh_token_reused/)
  assert.equal(health.status, 'authRequired'); assert.equal(health.profile.id, row.profile.id)
  assert.equal(row.authenticationFailure.code, 'refresh_token_reused')
  assert.ok(!(await readFile(row.eventLog,'utf8')).includes('fixture-private-auth-response'))
  assert.ok(!JSON.stringify(rt.state).includes('fixture-private-auth-response'))
  assert.equal(rt.state.projectAttempts, undefined, 'Authentication does not manufacture a candidate/test/Review verdict')
  const before = row.profile.id
  rt.config.projectResources.r.profiles.owner.codex.configDir += '-changed'
  const current = rt.projectResources.harnessHealth('p','r','codex')
  assert.equal(current.status, 'unconfigured'); assert.notEqual(current.profile.id, before)
  await harness.release(id)
})

for (const harnessKind of ['codex', 'claude-agent']) test(harnessKind + ' execution keeps running past the obsolete total timeout and exposes bounded evidence', async t => {
  const { rt, harness, cwd } = await fixture(t)
  rt.config.projectExecutionTimeoutMs = 1000
  const resource = rt.config.projectResources.r
  resource.harnesses.push('claude-agent'); resource.profiles.owner['claude-agent'] = resource.profiles.owner.codex
  rt.projectDelivery.sessionFor().execution.harness = harnessKind
  const path = join(resource.runtimeDir, 'src/host/project-harness-worker.mjs')
  const event = harnessKind === 'codex' ? { type: 'item.started', item: { id: 'command-1', type: 'command_execution', command: 'npm test', status: 'in_progress' } } : { type: 'assistant', session_id: 'bound-thread', message: { content: [{ type: 'tool_use', id: 'command-1', name: 'Bash', input: { command: 'npm test' } }] } }
  const worker = (await readFile(path, 'utf8')).replace(/  write\(\{type:'completed'.*\n/, `  write({type:'sdk-event',event:${JSON.stringify(event)}});\n`)
  await writeFile(path, worker)
  const id = await harness.spawn({ executionProjectId: 'p', executionWorkDir: cwd, prompt: 'Long operation' })
  await harness.dispatch({ botId: id, taskId: 't', brief: 'Run tests', outputs: [{ name: 'implementation' }] })
  await new Promise(resolve => setTimeout(resolve, 1200))
  const row = rt.state.projectHarnessWorkers[id]
  assert.equal(row.status, 'running')
  assert.equal(row.activity.command, 'npm test')
  assert.equal(harness.observe(id).connection, 'connected')
  assert.equal(harness.observe(id).process, 'unknown', 'A connected controller cannot assert actual executor liveness')
  const source = await harness.events(id)
  assert.equal(source.status, 'observed'); assert(source.entries.length)
  assert(!JSON.stringify(source).includes('sk-unitsecret'))
  await assert.rejects(harness.events(id, { eventOffset: -1 }), /cursor/)
  assert.equal(await harness.release(id), true)
  assert.equal(harness.observe(id).process, 'exit-confirmed')
})

for (const oversized of [false, true]) test('Reviewer inline evidence ' + (oversized ? 'respects the configured model budget before dispatch' : 'reaches the worker without scratch access or durable content duplication'), async t => {
  const { rt, harness, cwd } = await fixture(t), session = rt.projectDelivery.sessionFor()
  const candidate = 'a'.repeat(40), log = join(rt.home, 'host-tests.log'), content = 'SEALED_HOST_LOG_START\n' + '✓ tests passed\n'.repeat(oversized ? 200 : 1) + 'SEALED_HOST_LOG_END\n'
  await writeFile(log, content)
  Object.assign(session, { role: 'reviewer', definition: { role: 'reviewer', instructions: 'Review independently', skills: [] } })
  rt.state.projectResourceLeases.l.role = 'reviewer'
  rt.state.projectAttempts = { a: { id: 'a', projectId: 'p', taskId: 't', candidateSha: candidate, roleSessions: { reviewer: session }, evidence: { tests: { sha: candidate, passed: true, log, sha256: createHash('sha256').update(content).digest('hex'), command: ['npm', 'test'] } } } }
  if (oversized) rt.config.projectContext = { defaults: { windowTokens: 2048 } }
  const start = rt.projectResources.startProcess, frames = []
  rt.projectResources.startProcess = (...args) => {
    const process = start(...args), write = process.stdin.write.bind(process.stdin)
    process.stdin.write = (...values) => { frames.push(JSON.parse(values[0])); return write(...values) }
    return process
  }
  const id = await harness.spawn({ executionProjectId: 'p', executionWorkDir: cwd, prompt: 'Review the current sealed candidate' })
  const command = rt.projectResources.command
  rt.projectResources.uploadFile = () => { throw Error('scratch upload denied') }
  rt.projectResources.command = () => { throw Error('scratch read denied') }
  const step = { botId: id, taskId: 't', brief: 'Inspect host evidence', outputs: [{ name: 'implementation' }] }
  if (oversized) {
    await assert.rejects(harness.dispatch(step), { code: 'bot/context-budget' })
    assert.equal(frames.filter(frame => frame.type === 'start').length, 0)
    assert.ok(['prepared', 'idle'].includes(rt.state.projectHarnessWorkers[id].status))
  } else {
    const completed = new Promise(resolve => harness.onResult(resolve))
    await harness.dispatch(step); assert.equal((await completed).ok, true)
    const frame = frames.find(frame => frame.type === 'start')
    assert.ok(frame.prompt.includes(JSON.stringify(content)))
    assert.match(frame.prompt, /no scratch file read is required/)
    assert.equal(frame.settings.readOnly, true)
    assert.equal(frame.settings.writableRoots.length, 0)
    const metadata = rt.state.projectHarnessWorkers[id].reviewEvidence
    assert.equal(metadata.sha, candidate); assert.equal(metadata.bytes, Buffer.byteLength(content))
    assert.equal(Object.hasOwn(metadata, 'content'), false)
    assert.equal(JSON.stringify(rt.state).includes('SEALED_HOST_LOG_START'), false)
  }
  rt.projectResources.command = command
  await harness.release(id)
})
