import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProjectEffects } from '../src/host/project-effects.js'
import { install as installProjectInputs } from '../src/host/project-inputs.js'
import { createProjectResources } from '../src/host/project-resources.js'
import { createProjectHarness, handoffFrame, harnessCapabilities } from '../src/host/project-harness.js'

async function fixture(t) {
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
  write({type:'sdk-event',event:{type:'debug',noTools:m.settings.noTools,readOnly:m.settings.readOnly,resumeSessionId:m.settings.sessionId??null,value:m.settings.env.OPENAI_API_KEY,taskId:'task-1234567890abcdef',unknownCredential:'sk-unitsecret123456789012345'}});
  write({type:'completed',sessionId:'bound-thread',text:'OUTPUT implementation: actual contract worker output',usage:{input_tokens:1}});
 }
});`)
  const session = { id: 's', projectId: 'p', taskId: 't', attemptId: 'a', role: 'developer', definition: { role: 'developer', instructions: 'Stable developer convention', skills: [] }, execution: { harness: 'codex' }, context: { text: 'Frozen criteria and role memory' }, resourceLease: { id: 'l', resourceId: 'r', generation: 1 } }
  const workspace = { id: 'w', projectId: 'p', attemptId: 'a', role: 'developer', path: cwd }
  const rt = { home: root, state: { tasks: { t: { id: 't', projectId: 'p' } }, projectResourceLeases: { l: { id: 'l', resourceId: 'r', projectId: 'p', attemptId: 'a', generation: 1, status: 'reserved' } } },
    config: { projectResources: { r: { type: 'local', root, capacity: 1, runtimeDir, harnesses: ['codex'], allowedProjectOwnerIds: ['owner'], profiles: { owner: { codex: { home: join(root, 'profile'), configDir: join(root, 'profile/codex'), model: 'test-model', envRefs: { OPENAI_API_KEY: 'FLYBOT_TEST_HARNESS_SECRET' } } } } } } },
    save: async () => {}, warn() {}, readProject: () => ({ id: 'p', ownerUserId: 'owner' }), requireProjectAccess(actor) { if (actor.memberId !== 'owner') throw new Error('Access denied') },
    projectDelivery: { ownsWorkspace: (projectId, path) => projectId === 'p' && path === cwd ? workspace : null, sessionFor: () => session,
      bindSession: async (_workspace, bot) => rt.projectResources.markStarted(session.resourceLease.id, session.resourceLease.generation, { kind: 'sdk', handle: bot.id }), releaseSession: async () => {} } }
  process.env.FLYBOT_TEST_HARNESS_SECRET = 'unit-credential-opaque-value'
  rt.projectResources = createProjectResources(rt)
  const harness = createProjectHarness(rt)
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


test('SDK Chief context requests continue the same worker before final judgement and retain memory effects', async t => {
  const {rt,harness}=await fixture(t)
  const {roleContext,readContextArchive}=await import('../src/host/project-role-context.js')
  const path=join(rt.config.projectResources.r.runtimeDir,'src/host/project-harness-worker.mjs')
  await writeFile(path,`
import{createInterface}from'node:readline';
const write=v=>process.stdout.write(JSON.stringify(v)+'\\n');write({type:'ready',sdk:{codex:'0.166.0'}});
createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);
if(m.type==='stop'){write({type:'stopped',released:true});setTimeout(()=>process.exit(0),20)}
if(m.type==='start'){write({type:'sdk-event',event:{type:'thread.started',thread_id:'chief-context-thread'}});write({type:'completed',sessionId:'chief-context-thread',text:JSON.stringify({contextRequests:[{kind:'knowledge',id:'fact'}]})})}
if(m.type==='input'){if(!m.prompt.includes('Verified pnpm decision'))process.exit(2);write({type:'completed',sessionId:'chief-context-thread',text:JSON.stringify({reply:'Retained the project decision',actions:[],memoryUpdates:[{text:'Project uses pnpm',topic:'development'}]})})}
});`)
  const context=roleContext({projectId:'p',role:'chief',definition:{},knowledge:[{id:'fact',text:'Verified pnpm decision'}],retrieval:true})
  let memoryWrites=0,exchanges=0,finish
  const done=new Promise(resolve=>{finish=resolve})
  rt.projectAgents={isDelegationActive:()=>true,contextExchange:async(agentId,delegationId,data,snapshot)=>{
    assert.equal(agentId,'public-p');assert.equal(delegationId,'d');exchanges++
    if(data.memoryUpdates?.length)memoryWrites+=data.memoryUpdates.length
    return {reads:data.contextRequests?.length?readContextArchive(snapshot,data.contextRequests):[],writes:[]}
  }}
  rt.config.projectResources.r.harnesses=['codex'];rt.state.projectResourceHealth={r:{status:'ready',at:Date.now()}};rt.state.projectHarnessHealth={'p:r:codex':{status:'ready'}};delete rt.state.projectResourceLeases.l
  const agent={id:'public-p',projectId:'p',lastRequest:{}}
  const id=await harness.chiefTurn({agent,delegation:{id:'d',definitionRevision:1},definition:{execution:{harness:'codex',resourceIds:['r'],model:'test-model'}},context,text:'Read the saved decision',onResult:finish})
  const result=await done
  assert.equal(result.ok,true)
  assert.equal(result.backendSessionId,'chief-context-thread')
  assert.equal(JSON.parse(result.text).reply,'Retained the project decision')
  assert.equal(exchanges,2);assert.equal(memoryWrites,1)
  await harness.release(id)
  assert.equal(rt.projectResources.occupied('r'),0)
  assert.match(await readFile(rt.state.projectHarnessWorkers[id].sealedLog,'utf8'),/contextRequests/)
})


test('conversation carriers for non-Chief roles cannot gain development shell or write capabilities', async t => {
  const {rt,harness}=await fixture(t)
  rt.config.projectResources.r.harnesses=['codex'];rt.state.projectResourceHealth={r:{status:'ready',at:Date.now()}};rt.state.projectHarnessHealth={'p:r:codex':{status:'ready'}};delete rt.state.projectResourceLeases.l
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
  rt.state.projectHarnessHealth = { 'p:r:codex': { status: 'ready' } }
  session.resourceLease = await rt.projectResources.reserve({ projectId: 'p', attemptId: session.attemptId, role: 'developer', sessionKey: session.id, harness: 'codex', resourceIds: ['r'] })
  const next = await harness.spawn({ executionProjectId: 'p', executionWorkDir: cwd, prompt: 'Tester returned the Task with new feedback and changed candidate facts' })
  assert.equal(rt.state.projectHarnessWorkers[next].continuedFrom, first)
  assert.equal(rt.state.projectHarnessWorkers[next].backendSessionId, 'bound-thread')
  const returned = new Promise(resolve => harness.onResult(resolve))
  await harness.dispatch({ botId: next, taskId: 't', brief: 'Continue previous work', outputs: [{ name: 'implementation' }] })
  await returned
  assert.match(await readFile(rt.state.projectHarnessWorkers[next].eventLog, 'utf8'), /"resumeSessionId":"bound-thread"/)
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
  for (const revocation of ['role-resource', 'operator-disable']) await t.test(revocation, async t => {
  const { pinTaskRoleDefinition } = await import('../src/host/project-task-sessions.js')
  const { reconcileExecutionAuthority } = await import('../src/host/project-execution-authority.js')
  const { createProjectPools } = await import('../src/host/project-pools.js')
  const { rt, harness, cwd } = await fixture(t), session = rt.projectDelivery.sessionFor(), task = rt.state.tasks.t
  session.poolClaimId = 'live-revoke'; session.generation = 2; task.deliveryAttemptId = session.attemptId
  task.collaboration = { status: 'claimed', initiatedBy: 'owner', generation: 2, claim: { id: session.poolClaimId, generation: 2, status: 'active', botId: 'p:developer', role: 'developer' } }
  const role = { id: 'p:developer', ...session.definition, execution: { harness: 'codex', resourceIds: ['r'] } }
  const catalog = { revision: 1, roles: [role] }
  rt.projectAgents = { deliveryDefinitions: () => catalog }
  rt.state.projectAttempts = { [session.attemptId]: { roleSessions: { developer: session } } }
  Object.assign(session, pinTaskRoleDefinition(rt.state, session, role, 1, catalog))
  rt.projectPools = createProjectPools(rt)
  rt.projectPools.connect({ release: id => harness.release(id) })
  const id = await harness.spawn({ executionProjectId: 'p', executionWorkDir: cwd, prompt: 'Current Task' })
  session.botId = id; task.collaboration.claim.workerId = id
  await harness.dispatch({ botId: id, taskId: task.id, brief: 'Current Task', outputs: [{ name: 'handoff' }] })
  for (let n = 0; n < 200 && rt.state.projectHarnessWorkers[id].status !== 'waiting-input'; n++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(rt.state.projectHarnessWorkers[id].status, 'waiting-input')
  if (revocation === 'role-resource') role.execution.resourceIds = []
  else rt.config.projectResources.r.disabled = true
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
