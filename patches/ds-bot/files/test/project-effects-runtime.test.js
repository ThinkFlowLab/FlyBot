import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { validateHandoff } from '../../plugins/workflow/src/pool-contract.js'
import { createProjectGithubRead } from '../src/host/project-github-read.js'

async function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'flybot-effects-runtime-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify({ version: 2, members: { 'owner-1': { id: 'owner-1' } }, mainBotIds: [], bots: {}, rooms: {}, tasks: { task: { id: 'task', projectId: 'p', requesterId: 'owner-1', title: 'Durable handoff', status: 'open' } }, projects: { p: { id: 'p', name: 'Project', status: 'active', ownerUserId: 'owner-1' } } }))
  const ctx = fakeContext(), rt = createRuntime(ctx, { home, projectWorkbench: true })
  rt.projectAgents.deliveryDefinitions = () => ({ revision: 1, roles: ['chief', 'developer', 'tester', 'reviewer'].map(role => ({ id: `p:${role}`, role })) })
  await rt.load()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true }) })
  let executed = 0, dispatched = 0
  rt.projectPools.connect({ validate: validateHandoff, release: async () => true, evidence: async () => [], complete: async () => {},
    async execute({ task, claim }) {
      const disk = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
      const effect = Object.values(disk.projectEffects).find(row => row.payload.handoffId === task.collaboration.currentHandoffId)
      assert.equal(effect.status, 'running')
      assert.equal(disk.tasks.task.collaboration.claim.id, claim.id)
      executed++; return 'controlled-worker'
    }, async dispatch() { dispatched++ } })
  return { rt, home, executed: () => executed, dispatched: () => dispatched }
}

test('real store rename acknowledges the same handoff/claim before any external dispatch', async t => {
  const f = await fixture(t)
  await f.rt.projectPools.admit({ id: 'attempt', taskId: 'task' }, { memberId: 'owner-1' })
  await Promise.all([f.rt.projectScheduler.wake(), f.rt.projectScheduler.wake()])
  assert.equal(f.executed(), 1)
  assert.equal(f.dispatched(), 1)
  const disk = JSON.parse(readFileSync(join(f.home, 'state.json'), 'utf8'))
  assert.equal(Object.values(disk.projectEffects)[0].status, 'done')
  assert.equal(disk.tasks.task.collaboration.claim.workerId, 'controlled-worker')
  const result = await f.rt.projectEndpoint('project-development', { version: 'project-development/v1', kind: 'query', name: 'effects', projectId: 'p', payload: { taskId: 'task' } }, { memberId: 'owner-1' })
  assert.equal(result.result.effects[0].committed, true)
  assert.equal(Object.hasOwn(result.result.effects[0], 'payload'), false)
})

test('failed real handoff commit rolls back its offer and cannot be rescued by a timer', async t => {
  const f = await fixture(t), save = f.rt.save
  f.rt.save = async () => { throw Error('Injected write failure') }
  await assert.rejects(f.rt.projectPools.admit({ id: 'attempt', taskId: 'task' }, { memberId: 'owner-1' }), /write failure/)
  f.rt.save = save
  await f.rt.projectScheduler.wake()
  assert.equal(f.executed(), 0)
  assert.equal(f.dispatched(), 0)
  assert.equal(f.rt.state.tasks.task.collaboration.history.length, 0)
  assert.equal(Object.keys(f.rt.state.projectEffects).length, 0)
})

test('v1 Task input commits the inbox and notify intent before returning and creates no Task or worker', async t => {
  const f = await fixture(t)
  const command = { version: 'project-development/v1', kind: 'command', name: 'input.publish', projectId: 'p', requestId: 'human-feedback', payload: { taskId: 'task', text: 'Retain the native groups and personal Chief' } }
  const first = await f.rt.projectEndpoint('project-development', command, { memberId: 'owner-1' })
  const disk = JSON.parse(readFileSync(join(f.home, 'state.json'), 'utf8'))
  assert.equal(disk.projectTaskInputs[first.result.input.id].text, command.payload.text)
  assert.ok(Object.values(disk.projectEffects).some(row => row.kind === 'input.notify' && row.payload.inputId === first.result.input.id))
  assert.equal((await f.rt.projectEndpoint('project-development', command, { memberId: 'owner-1' })).replayed, true)
  const list = await f.rt.projectEndpoint('project-development', { version: 'project-development/v1', kind: 'query', name: 'inputs', projectId: 'p', payload: { taskId: 'task' } }, { memberId: 'owner-1' })
  assert.equal(list.result.inputs.length, 1)
  assert.equal(Object.keys(f.rt.state.tasks).length, 1)
  assert.equal(f.executed(), 0)
  await assert.rejects(f.rt.projectEndpoint('project-development', { ...command, requestId: 'forged-target', payload: { ...command.payload, projectId: 'foreign' } }, { memberId: 'owner-1' }), /another Project/)
})

test('handoff input is rolled back when dispatch intent cannot even be staged', async t => {
  const f=await fixture(t);await f.rt.projectEffects.close()
  await assert.rejects(f.rt.projectPools.admit({id:'attempt',taskId:'task'},{memberId:'owner-1'}),/not writable/)
  assert.equal(Object.keys(f.rt.state.projectTaskInputs).length,0)
  assert.equal(f.rt.state.tasks.task.collaboration.history.length,0)
})

test('v1 GitHub subscription polling commits source cursor and original Task input through the real store', async t => {
  const f=await fixture(t),actor={memberId:'owner-1'}
  f.rt.state.projects.p.repository='owner/repo'
  f.rt.projectGithubRead=async body=>({repository:'owner/repo',data:{threadKind:body.threadKind,number:body.number,pages:{comments:1},events:[{id:'comments:7',type:'comments',text:'Keep the native multi-Bot chat',sha:null}]}})
  const command=(name,payload)=>f.rt.projectEndpoint('project-development',{version:'project-development/v1',kind:'command',projectId:'p',name,requestId:name.replaceAll('.','-'),payload},actor)
  const sub=(await command('source.subscribe',{taskId:'task',threadKind:'pull',number:48,includeHistory:true})).result.subscription
  const polled=await command('source.poll',{threadId:sub.threadId})
  assert.equal(polled.result.inputs,1)
  const disk=JSON.parse(readFileSync(join(f.home,'state.json'),'utf8'))
  const input=Object.values(disk.projectTaskInputs)[0]
  assert.ok(disk.projectSourceEvents[input.source.eventId])
  assert.equal(disk.projectThreads[sub.threadId].cursor.pages.comments,1)
  assert.ok(Object.values(disk.projectEffects).some(row=>row.kind==='input.notify'&&row.payload.inputId===input.id))
  assert.equal(Object.keys(disk.tasks).length,1)
  assert.equal((await command('source.poll',{threadId:sub.threadId})).replayed,true)
  const fresh=await f.rt.projectEndpoint('project-development',{version:'project-development/v1',kind:'command',projectId:'p',name:'source.poll',requestId:'fresh-poll',payload:{threadId:sub.threadId}},actor)
  assert.equal(fresh.result.inputs,0)
})

test('scheduled Source polling survives closed browser sessions using scoped current-principal broker proof',async t=>{
  const f=await fixture(t),actor={memberId:'owner-1'}
  f.rt.state.projects.p.repository='owner/repo'
  f.rt.config.projectRepositories={'owner/repo':{github:{login:'automation'}}}
  f.rt.projectGithubRead=createProjectGithubRead(f.rt,{identity:async()=>({login:'automation',token:'private-token'}),request:async url=>Response.json(url.includes('/comments?')?[{id:7,body:'Existing Task feedback',updated_at:new Date().toISOString()}]:{number:48,state:'open',html_url:'https://github.com/owner/repo/issues/48',updated_at:new Date().toISOString()})})
  const sub=await f.rt.projectSources.subscribe({projectId:'p',taskId:'task',threadKind:'issue',number:48,includeHistory:true,requestId:'offline-source'},actor)
  f.rt.platformIdentityEnabled=true;f.rt.validateHumanActor=async()=>false
  await assert.rejects(f.rt.projectGithubRead({projectId:'p',operation:'issues',background:true},actor),/revoked/)
  const polled=await f.rt.projectDevelopment.scheduledSource({projectId:'p',threadId:sub.subscription.threadId},actor)
  assert.equal(polled.inputs,1)
  const disk=JSON.parse(readFileSync(join(f.home,'state.json'),'utf8'))
  assert.equal(Object.values(disk.projectTaskInputs)[0].source.kind,'github')
  assert.equal(Object.keys(disk.tasks).length,1)
})

test('real membership removal cancels its pending input but preserves the Project Task and rejects source replay', async t => {
  const f=await fixture(t)
  f.rt.state.members.bob={id:'bob'}
  f.rt.state.projects.p.roles={members:['bob'],maintainers:[]}
  f.rt.state.tasks.task.requesterId='bob'
  const command={version:'project-development/v1',kind:'command',name:'input.publish',projectId:'p',requestId:'member-feedback',payload:{taskId:'task',text:'Preserve the existing group chat'}}
  const published=await f.rt.projectEndpoint('project-development',command,{memberId:'bob'})
  await f.rt.projectEndpoint('project-member-remove',{projectId:'p',memberId:'bob'},{memberId:'owner-1'})
  assert.equal(f.rt.state.projectTaskInputs[published.result.input.id].status,'cancelled')
  assert.ok(f.rt.state.tasks.task)
  await assert.rejects(f.rt.projectEndpoint('project-development',command,{memberId:'bob'}),/access denied/)
  f.rt.state.projects.p.roles.members.push('bob')
  assert.equal((await f.rt.projectEndpoint('project-development',command,{memberId:'bob'})).replayed,true)
  assert.equal(f.rt.state.projectTaskInputs[published.result.input.id].status,'cancelled')
  const domain=await f.rt.projectInputs.publish({...command.payload,projectId:'p',requestId:command.requestId},{memberId:'bob'})
  assert.equal(domain.already,true)
  assert.equal(domain.input.status,'cancelled')
})
