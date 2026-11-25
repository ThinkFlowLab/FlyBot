import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { createAgents, composePrompt, CATEGORIES } from '../features/agents/index.js'
import { loadFeatures } from '../src/features.js'
import { nativeAgentFixture } from './native-agent-fixture.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const W = 'a'.repeat(32)

function fixture(options) {
  const runtime = nativeAgentFixture({reply: (_turn, count) => `DS-Bot reply ${count}`, ...options})
  const host = { runtime: async () => runtime.services, call: async (name) => {
    if (name === 'skills/materialForScope') return {items: []}
    if (name === 'agents/personal-binding') return {workspace_id: W}
    throw new Error('Unexpected endpoint: ' + name)
  } }
  const db = new DatabaseSync(join(mkdtempSync(join(tmpdir(), 'ot-agents-')), 'a.sqlite3'))
  const created = createAgents({ db, host })
  return { e: created.endpoints, migrate: created.migrate, rebrandBuiltinAssistant: created.rebrandBuiltinAssistant,
    attachTeam:created.attachTeam, db, ...runtime }
}

test('categories stay in step with the Python source', () => {
  const py = readFileSync(join(HERE, '../../../flybot_workspace/agents.py'), 'utf8')
  const block = py.slice(py.indexOf('CATEGORIES = ('), py.indexOf(')', py.indexOf('CATEGORIES = (')))
  assert.deepEqual([...block.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]), CATEGORIES)
})

test('an agent description drafts with the owner model, without creating an agent', async () => {
  const foreign = 'b'.repeat(32)
  const db = new DatabaseSync(':memory:')
  const generated = {name:'访谈整理员', summary:'整理用户访谈', instructions:'列出需求和待确认问题。', quick_starts:['整理下面的访谈']}
  const output = Promise.withResolvers()
  let modelOutput = output.promise
  const started = Promise.withResolvers()
  let modelCalls = 0
  const host = {
    currentRuntime: () => ({backgroundTextOnly: async (prompt, {system}) => {
      modelCalls += 1
      assert.equal(prompt, '帮我整理用户访谈')
      assert.match(system, /Return only a JSON object/)
      started.resolve()
      return modelOutput
    }}),
    call: async name => name === 'agents/personal-binding' ? {workspace_id: W} : [{id:foreign,role:'member'}],
  }
  const {endpoints:e} = createAgents({db,host})
  const draft = (workspace, prompt) => e.v1({method:'POST',path:`/v1/workspaces/${workspace}/agents/draft`,body:{prompt}})
  assert.equal((await draft(foreign,'帮我整理用户访谈')).status,403)
  assert.equal((await draft(W,'  ')).status,400)
  const first = draft(W,'帮我整理用户访谈')
  await started.promise
  assert.equal((await draft(W,'帮我整理用户访谈')).status,429)
  output.resolve(JSON.stringify({...generated,tools:['extra']}))
  assert.deepEqual((await first).body,{draft:generated})
  assert.equal(modelCalls,1)
  modelOutput = Promise.resolve(JSON.stringify({...generated,instructions:''}))
  assert.equal((await draft(W,'帮我整理用户访谈')).status,502)
  modelOutput = Promise.resolve(JSON.stringify(generated))
  assert.deepEqual((await draft(W,'帮我整理用户访谈')).body,{draft:generated})
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM agents').get().count,0)
})

test('portraits are validated, saved in the owner runtime, and returned by directory reads', async () => {
  const {e} = fixture()
  const body = {workspace_id:W,name:'助手',portrait:'coral',idempotency_key:'portrait-test-001'}
  assert.equal((await e.v1({method:'POST',path:`/v1/workspaces/${W}/agents`,body:{...body,portrait:'unsupported'},
    idempotency_key:body.idempotency_key})).status,400)
  const made = await e.create(body)
  assert.equal(made.agent.portrait,'coral')
  const replay = await e.create(body)
  assert.equal(replay.status,200)
  assert.equal(replay.agent.id,made.agent.id)
  const path=`/v1/workspaces/${W}/agents/${made.agent.id}`
  const edited=await e.v1({method:'POST',path,body:{revision:made.agent.revision,portrait:'violet'}})
  assert.equal(edited.status,200)
  assert.equal((await e.list({workspace_id:W})).items[0].portrait,'violet')
  const reset=await e.v1({method:'POST',path,body:{revision:edited.body.agent.revision,portrait:null}})
  assert.equal(reset.body.agent.portrait,null)
})

test('agent CRUD: idempotent create, unique names, revisions, archive, search', async () => {
  const { e } = fixture()
  const body = { workspace_id: W, name: '研究员', summary: '查资料', instructions: '只给有出处的结论', category: 'research', quick_starts: ['帮我查'], idempotency_key: 'k'.repeat(16) }
  const made = await e.create(body)
  assert.equal(made.status, 201)
  assert.equal(made.agent.served_by, 'ds-bot')
  assert.equal((await e.create(body)).status, 200)
  await assert.rejects(e.create({ ...body, summary: 'x' }), /different request/)
  await assert.rejects(e.create({ ...body, idempotency_key: 'j'.repeat(16) }), /already exists/)
  await assert.rejects(e.create({ ...body, category: 'nope', idempotency_key: 'm'.repeat(16) }), (err) => err.status === 400)
  const id = made.agent.id
  const up = await e.update({ workspace_id: W, id, revision: 1, changes: { name: '资深研究员' } })
  assert.equal(up.agent.revision, 2)
  await assert.rejects(e.update({ workspace_id: W, id, revision: 1, changes: { summary: 'y' } }), (err) => err.status === 409)
  assert.equal((await e.list({ workspace_id: W, q: '资深' })).items.length, 1)
  await e.archive({ workspace_id: W, id })
  assert.equal((await e.list({ workspace_id: W })).items.length, 0)
  assert.equal((await e.list({ workspace_id: W, archived: true })).items.length, 1)
  await e.archive({ workspace_id: W, id, archived: false })
  assert.equal((await e.list({ workspace_id: W, category: 'research' })).items.length, 1)
  await assert.rejects(e.get({ workspace_id: 'b'.repeat(32), id }), (err) => err.code === 'agents/not-found')
})

test('concurrent settings changes share one native roster revision', async () => {
  const bots = { main: {id:'main', name:'Main', capabilities:[]} }
  const writes = []
  const rt = {
    state: {bots},
    botOf: id => bots[id],
    createBot: async fields => bots.agent = {...fields, id:'agent'},
    updateBot: async (id, fields) => {
      writes.push(fields)
      Object.assign(bots[id], fields)
    },
    setFlags: async (id, fields) => {
      writes.push(fields)
      Object.assign(bots[id], fields)
    },
    save: async () => {},
  }
  const host = {runtime: async () => ({rt, mainBot: async () => 'main'}), call: async name => {
    if (name === 'agents/personal-binding') return {workspace_id: W}
  }}
  const {endpoints:e} = createAgents({db:new DatabaseSync(':memory:'), host})
  const created = await e.create({workspace_id:W, name:'原始名称', summary:'原始简介',
    instructions:'原始说明', idempotency_key:'settings-race-001'})
  const path = `/v1/workspaces/${W}/agents/${created.agent.id}`
  const save = body => e.v1({method:'POST', path, body})
  const read = async () => (await e.v1({method:'GET', path})).body.agent
  const first = {revision:created.agent.revision, instructions:'标签页一的说明'}
  const stale = {revision:created.agent.revision, summary:'标签页二的简介'}
  const [saved, conflict] = await Promise.all([save({...first,instructions:`  ${first.instructions}  `}),save(stale)])
  assert.deepEqual([saved.status,conflict.status], [200,409])
  assert.equal(conflict.body.error.code, 'revision_conflict')
  assert.equal((await read()).revision, created.agent.revision + 1)
  assert.equal((await read()).summary, '原始简介')
  assert.equal(bots.agent.instructions, first.instructions)
  assert.equal(bots.agent.flybotWorkspace.summary, '原始简介')
  assert.equal(writes.length, 1)

  const revision = saved.body.agent.revision
  const [archived, staleEdit] = await Promise.all([
    e.v1({method:'POST', path:path+'/archive', body:{revision, archived:true}}),
    save({revision, instructions:'归档不应接受过期编辑'}),
  ])
  assert.deepEqual([archived.status,staleEdit.status], [200,409])
  assert.equal((await read()).archived, 1)
  assert.equal((await read()).revision, revision + 1)
  assert.equal(bots.agent.hidden, true)
  assert.equal(bots.agent.instructions, first.instructions)
  assert.equal(writes.length, 2)

  // A direct native edit also invalidates the Web revision before it can write.
  const archiveRevision = archived.body.agent.revision
  bots.agent.instructions = '原生客户端保存的说明'
  const afterNativeEdit = await save({revision:archiveRevision, instructions:'旧网页里的说明'})
  assert.equal(afterNativeEdit.status, 409)
  assert.equal(afterNativeEdit.body.error.code, 'revision_conflict')
  assert.equal((await read()).instructions, bots.agent.instructions)
  assert.equal(writes.length, 2)
})

test('messages to an agent are native DS-Bot turns on that conversation\'s own session', async () => {
  const { e, turns, bots } = fixture()
  const { agent } = await e.create({ workspace_id: W, name: '助手', summary: '', instructions: 'Keep answers to one sentence.', idempotency_key: 'a'.repeat(16) })
  const { conversation } = await e['conversation-create']({ workspace_id: W, id: agent.id })
  const sent = await e.send({ workspace_id: W, id: agent.id, conversation_id: conversation.id, text: '你好' })
  assert.equal(sent.reply.text, 'DS-Bot reply 1')
  assert.equal(sent.reply.meta.engine, 'ds-bot')
  assert.equal(turns[0].key, `agent:${agent.id}:${conversation.id}`)
  assert.equal(turns[0].bot, agent.native_bot_id)
  assert.equal(turns[0].sessionId, conversation.native_session_id)
  assert.equal(turns[0].text, '你好')
  assert.equal(bots[agent.native_bot_id].instructions, 'Keep answers to one sentence.')
  assert.equal(turns[0].rid, `ot-agent:${sent.message.id}`)
  assert.equal((await e.messages({ workspace_id: W, id: agent.id, conversation_id: conversation.id })).items.length, 2)
  await e.archive({ workspace_id: W, id: agent.id })
  await assert.rejects(e.send({ workspace_id: W, id: agent.id, conversation_id: conversation.id, text: 'x' }), (err) => err.code === 'agents/archived')
})

test('existing Personal Agent binds Chief without replacing native IDs, private history or unrelated sessions', async () => {
  const {e, db, turns, bots, services} = fixture()
  const {rt} = services
  rt.isMain = id => id === 'main'
  rt.live = new Map()
  rt.pastOwners = new Map()
  const chief = bots.main
  chief.name = 'Chief'
  chief.instructions = 'Existing native instructions'
  chief.sessionId = await rt.createSession()
  rt.chatOwners.set(chief.sessionId, chief.id)

  const {agent} = await e.create({workspace_id:W, name:'Personal Agent', idempotency_key:'fixture-personal-chief'})
  const old = bots[agent.native_bot_id]
  const args = {workspace_id:W, id:agent.id}
  const {conversation} = await e['conversation-create'](args)
  const scope = {...args, conversation_id:conversation.id}
  await e.send({...scope, text:'First native turn'})
  const session = conversation.native_session_id
  old.sessionId = await rt.createSession()
  rt.chatOwners.set(old.sessionId, old.id)
  db.prepare('INSERT INTO native_personal_binding VALUES (1,?,?)').run(W,agent.id)

  rt.live.set(session,{turn:1})
  await assert.rejects(e.get(args), {code:'agents/history-busy'})
  assert.equal(rt.chatOwners.get(session),old.id)
  rt.live.delete(session)
  db.exec(`CREATE TRIGGER interrupt_binding BEFORE UPDATE OF bot_id ON native_agent_objects
    BEGIN SELECT RAISE(ABORT,'Interrupted after roster save'); END`)
  await assert.rejects(e.get(args), /Interrupted after roster save/)
  assert.equal(rt.chatOwners.get(session),chief.id)
  db.exec('DROP TRIGGER interrupt_binding')

  const personal = (await e.get(args)).agent
  assert.equal(personal.id, agent.id)
  assert.equal(personal.name, 'Personal Agent')
  assert.equal(personal.native_bot_id, chief.id)
  assert.equal(chief.name, 'Chief')
  assert.equal(chief.instructions, 'Existing native instructions')
  assert.equal(rt.chatOwners.get(chief.sessionId),chief.id)
  assert.equal(rt.chatOwners.get(old.sessionId),old.id)
  assert.equal(old.flybotWorkspace?.agent_id,undefined)
  await e.send({...scope, text:'Second native turn'})
  assert.deepEqual(turns.map(value => [value.bot,value.sessionId]), [[old.id,session],[chief.id,session]])
  assert.equal((await e.messages(scope)).items.length,4)
})

test('a Personal Agent chat can publish its actual native Bot id once', async () => {
  const {e, db, services, attachTeam, bots} = fixture()
  const {rt} = services
  rt.isMain = id => id === 'main'
  rt.pastOwners = new Map()
  const {agent:personal} = await e.create({workspace_id:W,name:'Personal Agent',idempotency_key:'native-team-personal'})
  db.prepare('INSERT INTO native_personal_binding VALUES(1,?,?)').run(W,personal.id)
  const address = {workspace_id:W,id:personal.id}
  const owner = (await e.get(address)).agent
  assert.equal(owner.native_bot_id,'main')
  const {conversation} = await e['conversation-create'](address)
  const direct = services.nativeTurn.bind(services)
  attachTeam(services)
  let builds = 0
  let managedSession
  services.nativeTurn = async (botId,sessionId,text,requestId,options) => {
    const out = () => direct(botId,sessionId,text,requestId)
    if (!options?.personalTeamScope) {
      assert.equal(rt.flybotWorkspaceTeam.scope(sessionId),null)
      return out()
    }
    managedSession = sessionId
    return rt.flybotWorkspaceTeam.run({botId,sessionId,requestId,scope:options.personalTeamScope},async () => {
      const tools = rt.flybotWorkspaceTeam.scope(sessionId)
      assert.ok(tools)
      const profile = {name:'Test Engineer',role:'QA',instructions:'Review the release.'}
      const build = link => {
        builds++
        return rt.createBot({...profile,model:'flybot/default',flybotWorkspace:link})
      }
      const first = await tools.createBot(profile,build)
      assert.deepEqual(await tools.createBot(profile,build),first)
      assert.match(first.url,/agent=[a-f0-9]{32}$/)
      return out()
    })
  }
  await e.send({...address,conversation_id:conversation.id,text:'Create a test engineer',idempotency_key:'native-team-direct-send'})
  assert.equal(rt.flybotWorkspaceTeam.scope(managedSession),null)
  await e.turn({agent_id:personal.id,key:conversation.id,text:'External call'})
  const roster = (await e.list({workspace_id:W})).items.filter(row => row.name === 'Test Engineer')
  assert.equal(roster.length,1)
  const bot = bots[roster[0].native_bot_id]
  assert.equal(bot.model,'flybot/default')
  assert.equal(bot.flybotWorkspace.agent_id,roster[0].id)
  assert.equal(builds,1)
})

test('without the DS-Bot chat service a send fails closed and is recorded', async () => {
  const { e, turns } = fixture({ available: false })
  const { agent } = await e.create({ workspace_id: W, name: 'A', idempotency_key: 'b'.repeat(16) })
  const { conversation } = await e['conversation-create']({ workspace_id: W, id: agent.id })
  await assert.rejects(e.send({ workspace_id: W, id: agent.id, conversation_id: conversation.id, text: 'x' }), (err) => err.code === 'agents/runtime-unavailable')
  const items = (await e.messages({ workspace_id: W, id: agent.id, conversation_id: conversation.id })).items
  assert.deepEqual(items.map((m) => m.status), ['sent', 'failed'])
  assert.equal(turns.length, 0)
})

test('legacy import is idempotent; persona header order matches the server', async () => {
  const { e } = fixture()
  const row = { id: 'c'.repeat(32), workspace_id: W, name: '旧', summary: 's', instructions: 'i', revision: 4, archived: 0 }
  assert.equal((await e.import({ agents: [row] })).imported, 1)
  assert.equal((await e.import({ agents: [row] })).imported, 0)
  assert.equal((await e.get({ workspace_id: W, id: row.id })).agent.revision, 4)
  assert.equal(composePrompt({ name: 'N', summary: 'S', instructions: 'I' }, ' q ', 'Chinese'), 'You are N.\nReply in Chinese.\nS\nI\n\nUser: q')
})

test('agents load through the extension point', async () => {
  process.env.FLYBOT_WORKSPACE_AUTOMATIONS_CLOCK = '0'
  const { table, loaded } = await loadFeatures({ dir: join(HERE, '../features'), identity: { instanceId: 'e'.repeat(32) }, dataDir: mkdtempSync(join(tmpdir(), 'ot-agents-load-')), log: () => {} })
  assert.ok(loaded.includes('agents'))
  assert.ok(table['agents/turn'] && table['agents/send'] && table['agents/conversation-create'])
})



test('v1 lists agents and conversations in the legacy /v1 shape', async () => {
  const { e } = fixture()
  const created = await e.v1({
    method: 'POST', path: `/v1/workspaces/${W}/agents`,
    idempotency_key: 'a'.repeat(20),
    body: { name: '文档助手', summary: '整理', instructions: '先列要点。' },
  })
  assert.equal(created.status, 201, created.body)
  const id = created.body.agent.id
  assert.equal(created.body.agent.homepage.visibility, 'restricted')
  const listed = await e.v1({ method: 'GET', path: `/v1/workspaces/${W}/agents?limit=100` })
  assert.equal(listed.body.items[0].id, id)
  const convo = await e.v1({ method: 'POST', path: `/v1/workspaces/${W}/agents/${id}/conversations`, body: { title: '新对话' } })
  assert.equal(convo.status, 201)
  const cid = convo.body.conversation.id
  const sent = await e.v1({
    method: 'POST', path: `/v1/workspaces/${W}/agents/${id}/conversations/${cid}/messages`,
    body: { body: '你好' },
  })
  assert.equal(sent.status, 201)
  assert.equal(sent.body.message.body, '你好')
  assert.equal(sent.body.reply.role, 'assistant')
  const opened = await e.v1({ method: 'GET', path: `/v1/workspaces/${W}/agents/${id}/conversations/${cid}` })
  assert.equal(opened.body.items[0].body, '你好')
  const homepage = await e.v1({ method: 'POST', path: `/v1/workspaces/${W}/agents/${id}/homepage`, body: {} })
  assert.equal(homepage.status, 404)
  assert.equal(homepage.body.error.code, 'not_moved')
})


test('official agents bundle imports once including history', async () => {
  const { createHash } = await import('node:crypto')
  const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex')
  const table = (rows) => {
    const text = JSON.stringify(rows)
    return { text, manifest: { rows: rows.length, sha256: sha(text) } }
  }
  const aid = 'c'.repeat(32), cid = 'd'.repeat(32), mid = 'e'.repeat(32)
  const agents = table([{ id: aid, workspace_id: W, name: '旧助手', summary: '整理', instructions: '先列要点。', revision: 1, created: 1, updated: 1, archived: 0 }])
  const convos = table([{ id: cid, workspace_id: W, agent_id: aid, user_id: 'u'.repeat(32), title: '旧对话', created: 1, updated: 1 }])
  const messages = table([{ id: mid, conversation_id: cid, workspace_id: W, agent_id: aid, user_id: 'u'.repeat(32), role: 'user', body: '你好', status: 'succeeded', created: 1, updated: 1, seq: 1 }])
  const bundle = { format: 'flybot-workspace-dsbot-import', version: 1, feature: 'agents', created: 1,
    tables: { workspace_agents: agents.text, agent_conversations: convos.text, agent_messages: messages.text },
    manifest: { workspace_agents: agents.manifest, agent_conversations: convos.manifest, agent_messages: messages.manifest } }
  const { e, migrate, sessions, turns } = fixture()
  const first = await migrate(bundle)
  assert.equal(first.imported, 1)
  assert.equal((await e.list({ workspace_id: W })).items[0].name, '旧助手')
  assert.equal((await e.messages({ workspace_id: W, id: aid, conversation_id: cid })).items[0].text, '你好')
  assert.deepEqual([...sessions.values()].flatMap(({events}) => events.map(event => [event.type, event.data.source?.flybotWorkspaceMessageId])),
    [['user/message', mid]])
  assert.equal(turns.length, 0, 'history import never starts a model turn')
  assert.equal((await migrate(bundle)).imported, 0)
})

test('an authenticated bootstrap ID rebrands its existing native built-in and retries interrupted writes', async () => {
  const {createHash} = await import('node:crypto')
  const {e, rebrandBuiltinAssistant, bots, services, db} = fixture()
  const id = 'c'.repeat(32), otherId = 'd'.repeat(32)
  const binding = {workspace_id: W, agent_id: 'e'.repeat(32)}
  const old = {workspace_id: W, name: 'Teamily Agent', summary: 'Teamily 平台助手', instructions: 'Keep my edit'}
  await e.import({agents: [{id, ...old}, {id: otherId, ...old, workspace_id: 'b'.repeat(32)}]})
  const payload = {workspace_id: W, id}
  const {agent: before} = await e.get(payload)
  const {agent: other} = await e.get({workspace_id: 'b'.repeat(32), id: otherId})
  const current = {id, ...old, name: 'FlyBot Assistant', summary: 'FlyBot 平台助手'}
  const tables = {}, manifest = {}
  for (const [name, rows] of Object.entries({
    personal_agents: [binding], workspace_agents: [current],
    builtin_agents: [{workspace_id: W, agent_id: id, builtin_key: 'flybot-assistant'}],
  })) {
    tables[name] = JSON.stringify(rows)
    manifest[name] = {rows: rows.length, sha256: createHash('sha256').update(tables[name]).digest('hex')}
  }
  const bundle = {format: 'flybot-workspace-dsbot-import', version: 1, feature: 'agents', tables, manifest}
  const bot = bots[before.native_bot_id]
  services.rt.save = async () => { throw new Error('interrupted native save') }
  await assert.rejects(rebrandBuiltinAssistant(bundle, binding), /interrupted native save/)
  assert.equal(db.prepare('SELECT name FROM agents WHERE id=?').get(id).name, old.name)
  services.rt.save = async () => {}
  await rebrandBuiltinAssistant(bundle, binding)
  const {agent: after} = await e.get(payload)
  assert.equal(after.id, id)
  assert.equal(after.native_bot_id, before.native_bot_id)
  assert.equal(after.name, current.name)
  assert.equal(after.summary, current.summary)
  assert.equal(bot.name, current.name)
  assert.equal(bot.instructions, old.instructions)
  assert.equal(bots[other.native_bot_id].name.startsWith('Teamily Agent'), true)
  await rebrandBuiltinAssistant(bundle, binding)
  assert.equal((await e.get(payload)).agent.revision, after.revision)
  db.close()
})

test('official personal history is durable before native attachment and binds to Chief on first use', async () => {
  const { createHash } = await import('node:crypto')
  const aid = 'c'.repeat(32), cid = 'd'.repeat(32)
  const tables = Object.fromEntries(Object.entries({
    workspace_agents: [{id: aid, workspace_id: W, name: 'Personal Agent'}],
    personal_agents: [{agent_id: aid, workspace_id: W}],
  }).map(([name, rows]) => [name, JSON.stringify(rows)]))
  const manifest = Object.fromEntries(Object.entries(tables).map(([name, text]) => [
    name, {rows: 1, sha256: createHash('sha256').update(text).digest('hex')},
  ]))
  const db = new DatabaseSync(':memory:')
  const host = {
    call: async (endpoint) => {
      assert.equal(endpoint, 'chat/exportLegacy')
      return {conversations: [{id: cid, title: 'Retained history'}]}
    },
    runtime: async () => {
      if (!native) throw new Error('runtime has not attached')
      return native.services
    },
  }
  let native
  const {endpoints, migrate} = createAgents({db, host})
  const bundle = {format: 'flybot-workspace-dsbot-import', version: 1, feature: 'agents', tables, manifest}
  await migrate(bundle)
  await migrate(bundle)
  assert.deepEqual({...await endpoints['personal-binding']()}, {agent_id: aid, workspace_id: W})
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM agent_conversations WHERE id=?').get(cid).count, 1)
  native = nativeAgentFixture()
  native.services.rt.isMain = id => id === native.bots.main.id
  native.bots.main.name = 'Chief'
  const {agent} = await endpoints.get({workspace_id:W,id:aid})
  assert.equal(agent.id, aid)
  assert.equal(agent.native_bot_id, native.bots.main.id)
  assert.equal(agent.name, 'Personal Agent')
  assert.deepEqual(Object.keys(native.bots), ['main'])
})
