import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { createAgents } from '../features/agents/index.js'
import { loadFeatures } from '../src/features.js'
import { attachRuntime, detachRuntime } from '../src/host.js'
import { tokens, rank } from '../features/chat/recall.js'

const dir = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'features')
const identity = { instanceId: 'd'.repeat(32) }

async function load(data = mkdtempSync(join(tmpdir(), 'ot-chat-'))) {
  const { table, failed } = await loadFeatures({ dir, identity, dataDir: data, log: () => {} })
  assert.deepEqual(failed, [])
  return table
}

test('recall tokens: Latin words and CJK bigrams', () => {
  assert.deepEqual(tokens('The Roadmap 计划表'), ['roadmap', '计划', '划表'])
  const pages = [{ id: 'p1', title: 'Launch', body: 'roadmap for Q3 launch' }, { id: 'p2', title: '其他', body: '午餐' }]
  assert.deepEqual(rank('what is the launch roadmap', pages).map((h) => h.page.id), ['p1'])
  assert.deepEqual(rank('nothing matches', pages), [])
})

test('private DS-Bot chats persist scoped recall citations and honor the conversation switch', async () => {
  const wid = 'a'.repeat(32)
  const scope = {workspace_id:wid}
  const page = {...scope, id:'c'.repeat(32), revision:2, title:'Launch plan', body:'The launch is on Friday in Hangzhou.'}
  const foreignPage = {...page, workspace_id:'b'.repeat(32), id:'f'.repeat(32), body:'Private other-workspace launch note.'}
  const recallRequests = []
  const personalRequests = []
  const candidateQueue = []
  const prompts = []
  const events = new Map()
  const bots = {main:{id:'main',name:'Main',capabilities:[]}}
  let sessions = 0
  const runtime = {
    mainBot: async () => 'main', chatTurn:async () => {}, ctx:{sessions:{flush:async () => {}}},
    rt: {state:{bots}, botOf:id => bots[id], chatOwners:new Map(), save:async () => {},
      createBot:async fields => (bots.agent = {...fields,id:'agent',capabilities:[]}),
      createSession:async () => 'session-' + (++sessions),
      workDirOf:() => '/fixture', resolveAgent:async id => ({session:{id}}),
      async *eventsBackwards(id) { yield* events.get(id) || [] }},
    async nativeTurn(bot, sid, prompt, key) {
      assert.equal(bot,'agent')
      prompts.push(prompt)
      const native = events.get(sid) || []
      native.push({type:'user/message',seq:native.length+1,time:1,data:{content:[{type:'text',text:prompt}],source:{rpcId:key}}})
      native.push({type:'assistant/message',seq:native.length+1,time:2,data:{message:{content:[{type:'text',text:'Friday.'}]}}})
      events.set(sid,native)
      return {text:'Friday.',sessionId:sid,turnId:native.length}
    },
  }
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE agent_conversation_memory (conversation_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL)')
  try {
    let profile = {name:'Ada',instructions:'Answer briefly.',recall:'all'}
    let selectedHistory
    let personalization = {...scope, profile:{communication:'Use concise bullets.'}, preferences:['Use metric units.']}
    const {endpoints} = createAgents({db,host:{
      runtime:async () => runtime,
      async call(endpoint, payload) {
        if (endpoint === 'memory/pages') {
          recallRequests.push(payload)
          return [page,foreignPage]
        }
        if (endpoint === 'memory/recallAcrossWorkspaces') {
          assert.equal(payload.workspace_id,wid)
          return [{page:foreignPage}]
        }
        if (endpoint === 'memory/personal') {
          personalRequests.push(payload)
          return personalization
        }
        if (endpoint === 'personal/get') return profile
        if (endpoint === 'memory/enqueueCapture') { candidateQueue.push(payload); return }
        if (endpoint === 'memory/enqueueHistory') { selectedHistory = payload; return {queued:1} }
        assert.equal(endpoint,'skills/materialForScope')
      },
    }})
    const {agent} = await endpoints.create({...scope,name:'Planner',idempotency_key:'create-planner-fixture'})
    const base = `/v1/workspaces/${wid}/agents/${agent.id}/conversations`
    const create = body => endpoints.v1({method:'POST',path:base,body,idempotency_key:'create-launch-fixture'})
    const created = await create({title:'Plans'})
    assert.equal(created.body.conversation.memory_recall,true)
    const path = base + '/' + created.body.conversation.id
    const send = key => endpoints.v1({method:'POST',path:path+'/messages',body:{body:'When is the launch?'},idempotency_key:key})
    const first = await send('workspace-recall-fixture')
    assert.equal(first.status,201)
    assert.equal(first.body.reply.body,'Friday.')
    assert.deepEqual(first.body.reply.memory_refs,[{...scope,id:page.id,revision:2,title:page.title}])
    assert.equal(first.body.message.client_key,'workspace-recall-fixture')
    assert.match(prompts[0],/Friday in Hangzhou/)
    assert.match(prompts[0],/Use concise bullets.*\nPreference: "Use metric units/)
    assert.equal(first.body.reply.memory_profile_workspace,wid)
    assert.deepEqual(personalRequests,[scope])
    assert.doesNotMatch(prompts[0],/other-workspace/)
    const source = candidateQueue[0]
    assert.equal(source.message_id,first.body.message.id)
    assert.deepEqual(await endpoints.captureSource(source),{title:'Plans',text:'When is the launch?'})
    assert.equal(await endpoints.captureSource({...source,message_id:first.body.reply.id}),null)
    await assert.rejects(endpoints.captureSource({...source,workspace_id:foreignPage.workspace_id}),{status:404})
    assert.deepEqual(recallRequests,[scope])
    const reopened = (await endpoints.v1({method:'GET',path})).body.items[1]
    assert.deepEqual(reopened.memory_refs,first.body.reply.memory_refs)
    assert.equal(reopened.memory_profile_workspace,wid)
    assert.doesNotMatch(JSON.stringify(reopened),/concise bullets|metric units/)

    assert.equal((await endpoints.v1({method:'POST',path,body:{memory_recall:false}})).body.memory_recall,false)
    assert.equal((await create({title:'Plans'})).body.conversation.memory_recall,false)
    assert.equal((await send('workspace-recall-fixture')).body.reply.id,first.body.reply.id)
    const disabled = (await send('workspace-recall-disabled')).body.reply
    assert.equal(disabled.memory_refs,undefined)
    assert.equal(disabled.memory_profile_workspace,undefined)
    assert.doesNotMatch(prompts[1],/Reference notes|concise bullets|metric units/)
    assert.equal(recallRequests.length,1)
    assert.equal(await endpoints.captureSource(source),null)
    assert.deepEqual(await endpoints.captureSource({...source,selected:true}),{title:'Plans',text:'When is the launch?'})
    const submitHistory = ids => endpoints.v1({method:'POST',path:path+'/memory/capture',body:{message_ids:ids}})
    assert.equal((await submitHistory([first.body.reply.id])).status,400)
    assert.equal((await submitHistory([source.message_id,source.message_id])).status,400)
    assert.equal((await submitHistory([source.message_id])).status,202)
    assert.deepEqual(selectedHistory,{...scope,agent_id:agent.id,conversation_id:created.body.conversation.id,message_ids:[source.message_id]})
    assert.equal(candidateQueue.length,1)
    assert.equal(personalRequests.length,1)

    await endpoints['adopt-personal-chat']({...scope,id:agent.id,conversations:[]},false)
    profile = {...profile,recall:'off'}
    const {conversation} = await endpoints['conversation-create']({...scope,id:agent.id,title:'Personal'})
    assert.equal(conversation.memory_recall,false)
    const personal = base + '/' + conversation.id
    await endpoints.v1({method:'POST',path:personal,body:{memory_recall:true}})
    personalization = {...personalization,workspace_id:foreignPage.workspace_id,preferences:['Other workspace preference.']}
    const on = await endpoints.v1({method:'POST',path:personal+'/messages',body:{body:'launch'},idempotency_key:'personal-recall-fixture'})
    assert.deepEqual(on.body.reply.memory_refs,first.body.reply.memory_refs)
    assert.match(prompts[2],/Answer briefly/)
    assert.doesNotMatch(prompts[2],/Other workspace preference/)
    assert.equal(on.body.reply.memory_profile_workspace,undefined)
    assert.deepEqual(recallRequests,[scope,scope])
    assert.deepEqual(personalRequests,[scope,scope])

    await endpoints.turn({agent_id:agent.id,key:'social:shared-room',text:'launch'})
    assert.doesNotMatch(prompts[3],/Friday in Hangzhou|Answer briefly|Private workspace personalization/)
    assert.deepEqual(recallRequests,[scope,scope])
    assert.deepEqual(personalRequests,[scope,scope])

    assert.equal((await endpoints.v1({method:'POST',path,body:{memory_scope:'everything'}})).status,400)
    assert.deepEqual((await endpoints.v1({method:'POST',path,body:{memory_scope:'workspaces'}})).body,
      {memory_recall:true,memory_scope:'workspaces'})
    assert.equal((await endpoints.v1({method:'GET',path})).body.conversation.memory_scope,'workspaces')
    const shared = (await send('cross-workspaces-fixture')).body.reply
    assert.deepEqual(shared.memory_refs,[{workspace_id:foreignPage.workspace_id,id:foreignPage.id,revision:2,title:foreignPage.title}])
    assert.match(prompts.at(-1),/Reference notes from accessible workspaces/)
    assert.match(prompts.at(-1),/other-workspace launch note/)
    assert.deepEqual(recallRequests,[scope,scope])
  } finally { db.close() }
})

test('skills are native DS-Bot capabilities attached to the Main Bot', async () => {
  const table = await load()
  const bot = { capabilities: ['ot-skill-abc', 'other'] }
  const saved = []
  const rt = {
    botOf: () => bot,
    capabilitySave: async (cap) => { saved.push(cap) },
    changeCapabilityAttachment: async (op, { name }) => { if (op === 'attach') bot.capabilities.push(name); else bot.capabilities = bot.capabilities.filter((n) => n !== name) },
  }
  attachRuntime({ rt, ctx: {}, mainBot: async () => 'bot1' })
  try {
    await table['skills/save']({ name: 'weekly-review', content: 'Do the review.' })
    assert.equal(saved[0].kind, 'skill')
    assert.deepEqual((await table['skills/list']()).items, [
      { name: 'ot-skill-abc', source: 'flybot-workspace' }, { name: 'ot-user-skill-weekly-review', source: 'user' }])
    await assert.rejects(table['skills/save']({ name: 'Bad Name', content: 'x' }), { code: 'skills/invalid' })
    await table['skills/remove']({ name: 'weekly-review' })
    assert.equal(bot.capabilities.includes('ot-user-skill-weekly-review'), false)
  } finally { detachRuntime() }
})

test('personal chat history is adopted through the trusted importer only', async () => {
  const table = await load()
  assert.equal(typeof table['chat/exportLegacy'], 'function')
  assert.equal(table['chat/import'], undefined)
  assert.equal(table['chat/importStatus'], undefined)
})

test('legacy private chat export preserves insertion order for messages at the same time', async t => {
  const data = mkdtempSync(join(tmpdir(), 'ot-chat-'))
  const table = await load(data)
  await table['chat/exportLegacy']()
  const db = new DatabaseSync(join(data, 'flybot-workspace', 'features', 'chat', 'chat.sqlite3'))
  t.after(() => db.close())
  db.exec(`INSERT INTO conversations VALUES ('c','Conversation',1,1);
    INSERT INTO messages VALUES
      ('zzz','c','user','Question',1,'{}'),
      ('aaa','c','assistant','Answer',1,'{}');`)
  const {conversations} = await table['chat/exportLegacy']()
  assert.deepEqual(conversations[0].messages.map(message => message.id), ['zzz', 'aaa'])
})

test('the browser can neither provide raw skill material nor invoke the internal materializer', async () => {
  const table = await load()
  assert.equal(table['skills/sync'], undefined)
  await assert.rejects(table['skills/materialForScope']({scope:'account'}, {request:new Request('https://example.test')}),
    {status:404, code:'skills/not-found'})
})


test('native skill names fit DS-Bot after migrated profiles; save, bind and revoke use stable identities', async () => {
  const { userSkillName, boundName } = await import('../features/skills/index.js')
  const table = await load()
  const bot = { id:'migrated-main', capabilities: ['ot-skill-existing', 'ot-bound-old'] }
  const library = new Map()
  const rt = {
    state: {bots:{[bot.id]:bot}},
    botOf: () => bot,
    capabilitySave: async cap => {
      assert.ok(cap.name.length <= 32)
      assert.match(cap.name, /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/)
      library.set(cap.name, cap)
    },
    changeCapabilityAttachment: async (op, { name }, caller) => {
      assert.equal(caller, 'migrated-main')
      bot.capabilities = bot.capabilities.filter(n => n !== name)
      if (op === 'attach') { assert.ok(library.has(name)); bot.capabilities.push(name) }
    },
  }
  attachRuntime({ rt, ctx: {}, mainBot: async () => 'migrated-main' })
  try {
    for (const slug of ['deploy-accept-00000000', 'a'.repeat(48), 'a--b', 'a-']) {
      const saved = await table['skills/save']({ name: slug, content: 'Read this native skill.' })
      assert.equal(saved.name, userSkillName(slug))
      assert.equal(library.get(saved.name).content, 'Read this native skill.')
      assert.ok(bot.capabilities.includes(saved.name))
      await table['skills/remove']({ name: slug })
      await table['skills/remove']({ name: slug }) // idempotent revocation
      assert.ok(!bot.capabilities.includes(saved.name))
    }
    assert.equal(userSkillName('weekly-review'), 'ot-user-skill-weekly-review')
    assert.notEqual(userSkillName('a'.repeat(47) + 'b'), userSkillName('a'.repeat(47) + 'c'))
    const v1 = (method, path, body) => table['skills/v1']({method,path:'/v1/skills/' + path,body})
    const id = 'import-' + '0123456789abcdef'.repeat(2)
    const content = '# Bound instructions'
    const imported = await v1('POST','packages',{revision:0,consent:true,
      package:{id,name:'Long identifier',version:'1.0.0',content,permissions:['model_context'],format:'flybot-workspace.prompt-skill.v2'}})
    assert.equal(imported.status,200)
    const bind = enabled => v1('POST','bindings',{skill_id:id,scope:'account',version:'1.0.0',
      digest:imported.body.package.digest,permissions:['model_context'],enabled})
    assert.equal((await bind(true)).status,200)
    assert.ok(bot.capabilities.includes(boundName(id)))
    assert.equal(library.get(boundName(id)).content, content)
    assert.ok(bot.capabilities.includes('ot-skill-existing'))
    assert.ok(!bot.capabilities.includes('ot-bound-old'))
    assert.equal((await bind(false)).status,200)
    assert.deepEqual(bot.capabilities, ['ot-skill-existing'])
  } finally { detachRuntime() }
})
