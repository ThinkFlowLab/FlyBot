import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { applyNativeOverlay } from '../native-ds-bot-overlay.mjs'

const source = fileURLToPath(new URL('../../ds-bot-upstream/ds-bot/', import.meta.url))
const harness = resolve(process.env.DSH_HARNESS ?? join(source, 'dev/harness'))
const requireHarness = createRequire(join(harness, 'package.json'))
const loadHarness = name => import(pathToFileURL(requireHarness.resolve(name)).href)
const load = (root, file) => import(pathToFileURL(join(root, file)).href)

const FOREGROUND = 'foreground-head'
const FOREGROUND_OLD = 'foreground-old'
const OPEN = 'open-head'
const OPEN_OLD = 'open-old'
const NEW_HEAD = 'open-next'
const TASK = 'unrelated-task'
const TASK_OLD = 'unrelated-task-old'
const OTHER = 'other-bot-head'
const live = [FOREGROUND, FOREGROUND_OLD, OPEN, NEW_HEAD, OPEN_OLD, TASK, TASK_OLD, OTHER]
const leg = sessionId => ({sessionId, endedAt: 5})

async function registryOf(context, root, liveIds) {
  const [
    {Context}, {SessionId}, jsonl, {default:Storage}, storageDomain, storageJson, {default:WorkspaceRegistry},
  ] = await Promise.all([
    '@deepseek-ai/cordis', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-session-persistence-jsonl',
    '@deepseek-ai/dsh-storage', '@deepseek-ai/dsh-storage-domain', '@deepseek-ai/dsh-storage-json',
    '@deepseek-ai/dsh-workspace',
  ].map(loadHarness))
  const host = new Context()
  await host.plugin(Storage)
  await host.plugin(storageJson, {root:join(root,'storage')})
  await host.plugin(storageDomain, {backend:'json'})
  await host.plugin(typeof jsonl.apply === 'function' ? jsonl : jsonl.default, {root:join(root,'sessions')})
  await host.plugin({name:'live-sessions',apply:inner=>inner.provide('sessions',{
    list:()=>[], get:id=>liveIds.includes(id) ? {} : undefined,
  })})
  await host.plugin({
    name:'plugin-hooks',
    apply:inner=>{
      const hooks = name => context.listeners.get(name) ?? []
      inner.on('workspace/session-stop', payload => Promise.all(hooks('workspace/session-stop').map(listener => listener(payload))))
      inner.on('workspace/session-activity', (payload, next) => hooks('workspace/session-activity')
        .reduceRight((rest, listener) => () => listener(payload, rest), next)())
    },
  })
  await host.plugin(WorkspaceRegistry)
  const registry = await new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error('DSH workspace registry did not start')), 5000)
    host.inject(['workspaceRegistry'], inner => {
      clearTimeout(timer)
      resolveReady(inner.workspaceRegistry)
    })
  })
  return {registry, SessionId, stop:()=>host.fiber.dispose()}
}

const legacyState = () => ({
  version:1, mainBotIds:['writer'], revision:1, rooms:{},
  bots:{
    writer:{
      id:'writer', sessionId:FOREGROUND, name:'Writer', createdAt:1,
      segments:[leg(FOREGROUND_OLD)],
      openParts:[{sessionId:OPEN, segments:[leg(OPEN_OLD)], startedAt:6}],
      tasks:[{id:'review', sessionId:TASK, segments:[leg(TASK_OLD)], status:'running', title:'Review'}],
      flybotWorkspace:{sessionKeys:{'agent:writer:foreground':FOREGROUND_OLD,'agent:writer:open':OPEN_OLD}},
    },
    other:{
      id:'other',sessionId:OTHER,name:'Other',createdAt:1,
    },
  },
})

async function nativeHost(t) {
  const scratch = mkdtempSync(join(tmpdir(),'ot-host-open-parts-'))
  t.after(()=>rmSync(scratch,{recursive:true,force:true,maxRetries:5}))
  const staged = join(scratch,'ds-bot')
  cpSync(source,staged,{recursive:true,filter:path=>basename(path)!=='node_modules'})
  symlinkSync(join(source,'node_modules'),join(staged,'node_modules'),'dir')
  applyNativeOverlay(staged)
  const prior = process.env.DSH_HARNESS
  process.env.DSH_HARNESS = harness
  t.after(()=>{ if (prior === undefined) delete process.env.DSH_HARNESS; else process.env.DSH_HARNESS = prior })
  await load(staged,'test/harness-resolve.mjs')
  const [{createRuntime},{fakeContext},threads] = await Promise.all(
    ['index.js','test/fake-ctx.js','src/host/threads.js'].map(file => load(staged,file)))
  const home = join(scratch,'volume')
  mkdirSync(home)
  return {createRuntime,fakeContext,threads,home,scratch}
}

test('native connector tools use the mounted Composio connection without asking for another sign-in', async t => {
  const {createRuntime,fakeContext,home} = await nativeHost(t)
  const roster = legacyState()
  roster.bots.writer.tasks = []
  writeFileSync(join(home,'state.json'), JSON.stringify(roster))
  const context = fakeContext()
  context.sessionController = {resolveAgent:async id => ({agent:context.scopeAgent(id)})}
  const rt = createRuntime(context,{home})
  try {
    await rt.load()
    rt.botOf('writer').capabilities = ['ot-apps']
    rt.flybotWorkspaceApps = {connectedToolkits:async () => [{slug:'github',tools:['GITHUB_LIST_REPOS','GITHUB_CREATE_ISSUE']}]}
    const agent = context.scopeAgent(FOREGROUND)
    agent.ctx.tools.schemas = () => [{name:'mcp__ot-apps__GITHUB_LIST_REPOS'}]
    const exec = {agent,concludeTurn:() => assert.fail('Composio is already connected')}
    const list = rt.teamTools.find(tool => tool.name === 'list_connectors')
    const request = rt.teamTools.find(tool => tool.name === 'request_connector')
    const args = {id:'github',purpose:'Inspect a repository'}
    const result = String(await list.execute({},exec))
    assert.match(result,/GitHub \(github\).*connected through FlyBot \(Composio\).*mcp__ot-apps__GITHUB_LIST_REPOS/)
    assert.doesNotMatch(result,/GITHUB_CREATE_ISSUE/)
    assert.match(String(await request.execute(args,exec)),/connected through FlyBot \(Composio\)/)
    assert.equal(rt.state.connectorRequests?.writer?.length ?? 0,0)
    agent.ctx.tools.schemas = () => []
    assert.match(String(await request.execute(args,exec)),/no app tools are currently mounted/)
    assert.equal(rt.state.connectorRequests?.writer?.length ?? 0,0)
  } finally { await context.dispose() }
})

test('the image preserves managed threads, delivery and rollovers across a v0.3.9 volume upgrade', async t => {
  const {createRuntime,fakeContext,threads,home,scratch} = await nativeHost(t)
  const file = join(home,'state.json')
  const originalRoutingId = process.env.FLYBOT_WORKSPACE_ROUTING_INSTANCE_ID
  const originalInstanceId = process.env.FLYBOT_WORKSPACE_INSTANCE_ID
  delete process.env.FLYBOT_WORKSPACE_INSTANCE_ID
  process.env.FLYBOT_WORKSPACE_ROUTING_INSTANCE_ID = 'a'.repeat(32)
  t.after(()=>{
    if (originalRoutingId === undefined) delete process.env.FLYBOT_WORKSPACE_ROUTING_INSTANCE_ID
    else process.env.FLYBOT_WORKSPACE_ROUTING_INSTANCE_ID = originalRoutingId
    if (originalInstanceId === undefined) delete process.env.FLYBOT_WORKSPACE_INSTANCE_ID
    else process.env.FLYBOT_WORKSPACE_INSTANCE_ID = originalInstanceId
  })
  const legacy = legacyState()
  // DSH may have persisted an older retirement attempt. The live managed head
  // and its past segment must not donate schedules to the related foreground.
  legacy.retiredParts = [{sessionId:OPEN,botId:'writer'},{sessionId:OPEN_OLD,botId:'writer'}]
  // A stale duplicate claim cannot turn another Bot's or a task's history into
  // this chat's history. Valid preceding parts remain private.
  legacy.bots.writer.openParts[0].segments.push(leg(TASK_OLD),leg(OTHER))
  writeFileSync(file,JSON.stringify(legacy))

  const paths = (rt, owner, part) => rt.partsOfThread(owner,part).map(value=>value.sessionId)
  const fixtureContext = () => {
    const context = fakeContext()
    const pending = []
    context.sessionController = {
      prompt:async request=>pending.push(request),
      resolveAgent:async id=>({agent:{...context.scopeAgent(id),status:id === TASK ? 'running' : 'idle'}}),
    }
    return {context,pending}
  }
  for (let restart = 0; restart < 3; restart++) {
    const {context,pending} = fixtureContext()
    const dsh = await registryOf(context,join(home,'dsh'),live)
    context.workspaceRegistry = dsh.registry
    if (!restart) {
      for (const id of [OPEN,OPEN_OLD]) await dsh.registry.archiveSession(dsh.SessionId(id),{stopActivity:true})
    }
    const rt = createRuntime(context,{home})
    const moves = []
    rt.moveSchedules = async (...args) => moves.push(args)
    try {
      await rt.load()
      rt.ensureCapabilities = async () => {}
      const focus = restart === 0 ? OPEN : NEW_HEAD
      const previous = restart === 0 ? [OPEN_OLD] : [OPEN_OLD,OPEN]
      const writer = rt.botOf('writer')
      assert.equal(rt.chatOf('writer'),FOREGROUND)
      assert.equal(rt.chatOwners.get(focus),'writer')
      assert.equal(rt.pastOwners.get(OPEN_OLD)?.botId,'writer')
      assert.equal(rt.chatOwners.get(OTHER),'other')
      assert.equal(rt.taskOwners.get(focus),undefined)
      assert.deepEqual(rt.taskOwners.get(TASK),{botId:'writer',taskId:'review'})
      assert.deepEqual(paths(rt,'writer',FOREGROUND_OLD),[FOREGROUND_OLD,FOREGROUND])
      assert.deepEqual(paths(rt,'writer',OPEN_OLD),[...previous,focus])
      assert.deepEqual(paths(rt,'writer',TASK_OLD),[TASK_OLD,TASK])
      assert.equal(threads.sameConversation(rt.state,'writer',OPEN_OLD,focus),true)
      assert.equal(threads.sameConversation(rt.state,'writer',OPEN_OLD,FOREGROUND),false)
      assert.equal(threads.sameConversation(rt.state,'writer',OPEN_OLD,TASK),false)
      assert.equal(threads.threadOfPart(rt.botOf('other'),OPEN_OLD),undefined)
      rt.live.set(FOREGROUND,{turn:1,toolCount:1,since:Date.now()})
      assert.equal(rt.shouldMoveForeground(writer,FOREGROUND),false)
      await rt.sendUser({sessionId:OPEN_OLD,content:[{type:'text',text:'open only'}],requestId:'open-request'})
      await rt.sendUser({sessionId:FOREGROUND_OLD,content:[{type:'text',text:'foreground only'}],requestId:'foreground-request'})
      await rt.sendUser({sessionId:TASK,content:[{type:'text',text:'task input'}],requestId:'task-request'})
      assert.deepEqual(pending.map(({sessionId,requestId})=>[sessionId,requestId]),[
        [focus,'open-request'],[FOREGROUND,'foreground-request'],[FOREGROUND,'task-request'],
      ])
      // The real DSH workspace service restores an archived managed head
      // without changing the last segment or opening a different conversation.
      const archived = id => [...dsh.registry.archivedSessionIds].includes(id)
      if (!restart) {
        for (let checks=0; (archived(OPEN) || rt.state.retiredParts) && checks<100; checks++) {
          await new Promise(resolveCheck=>setTimeout(resolveCheck,10))
        }
        assert.equal(archived(OPEN),false)
        assert.equal(archived(OPEN_OLD),true)
        assert.equal(rt.state.retiredParts,undefined)
        assert.deepEqual(moves,[])
        assert.equal(threads.pushThreadPart(writer,OPEN,NEW_HEAD,leg(OPEN)),true)
        assert.equal(threads.successorOfMovedPart(writer,NEW_HEAD),NEW_HEAD)
        assert.equal(threads.threadCurrentOfPart(writer,OPEN),NEW_HEAD)
      }
      await rt.save({required:true})
      const persisted = JSON.parse(readFileSync(file,'utf8')).bots.writer
      assert.equal(persisted.sessionId,FOREGROUND)
      assert.deepEqual(persisted.segments,[leg(FOREGROUND_OLD)])
      assert.deepEqual(persisted.openParts,[{sessionId:NEW_HEAD,segments:[leg(OPEN_OLD),leg(OPEN)],startedAt:6}])
      assert.equal(persisted.tasks[0].sessionId,TASK)
    } finally {
      await context.dispose()
      await dsh.stop()
    }
  }

  // Omit the manager identity: the same image keeps upstream migration
  // behavior for native teams with no managed FlyBot parts.
  delete process.env.FLYBOT_WORKSPACE_ROUTING_INSTANCE_ID
  const unmanaged = join(scratch,'upstream-volume')
  mkdirSync(unmanaged)
  writeFileSync(join(unmanaged,'state.json'),JSON.stringify(legacyState()))
  const {context} = fixtureContext()
  const dsh = await registryOf(context,join(unmanaged,'dsh'),live)
  context.workspaceRegistry = dsh.registry
  const rt = createRuntime(context,{home:unmanaged})
  try {
    await rt.load()
    assert.equal(rt.botOf('writer').openParts,undefined)
    assert.equal(rt.chatOwners.has(OPEN),false)
    assert.equal(threads.threadCurrentOfPart(rt.botOf('writer'),OPEN),FOREGROUND)
    assert.equal(rt.taskOwners.get(TASK).taskId,'review')
  } finally {
    await context.dispose()
    await dsh.stop()
  }
})
