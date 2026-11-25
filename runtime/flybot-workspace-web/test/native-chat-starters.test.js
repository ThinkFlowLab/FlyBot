import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { createAgents } from '../features/agents/index.js'

const WORKSPACE = '1'.repeat(32)
const OTHER_WORKSPACE = '2'.repeat(32)

function ownerRuntime(testContext) {
  const db = new DatabaseSync(':memory:')
  testContext.after(() => db.close())
  const bots = { main: { id: 'main', name: 'Main', capabilities: [] } }
  let botId = 0
  let sessions = 0
  const runtime = {
    mainBot: async () => 'main',
    rt: {
      state: { bots }, chatOwners: new Map(), botOf: id => bots[id],
      createBot: async fields => {
        const id = 'bot-' + ++botId
        bots[id] = { ...fields, id }
        return bots[id]
      },
      createSession: async () => 'session-' + ++sessions,
      workDirOf: () => '/fixture',
      updateBot: async (id, patch) => Object.assign(bots[id], patch),
      setFlags: async (id, flags) => Object.assign(bots[id], flags),
      save: async () => {},
    },
  }
  const host = { runtime: async () => runtime, currentRuntime: () => runtime }
  const { endpoints } = createAgents({ db, host })
  return {
    bots, db, host, runtime,
    endpoints,
    importAgents: agents => endpoints.import({agents}),
    sessions: () => sessions,
    request: (method, path, body, idempotency_key) => endpoints.v1({ method, path, body, idempotency_key }),
  }
}

const agentBase = workspace => `/v1/workspaces/${workspace}/agents`
const directory = (workspace, archived = false) => agentBase(workspace) + '?limit=100&include=conversations'
  + (archived ? '&include_archived=1' : '')

async function createAgent(runtime, workspace, name, quick_starts) {
  const response = await runtime.request('POST', agentBase(workspace), { name, quick_starts },
    'fixture-agent-' + name.replaceAll(' ', '-'))
  assert.equal(response.status, 201)
  return response.body.agent
}

async function openThread(runtime, agentPath) {
  const response = await runtime.request('POST', agentPath + '/conversations', { title: 'Fixture thread' }, 'fixture-conversation')
  assert.equal(response.status, 201)
  return agentPath + '/conversations/' + response.body.conversation.id
}

test('the owner’s native Chat directory and thread detail share the latest saved starter array', async t => {
  const runtime = ownerRuntime(t)
  const original = await createAgent(runtime, WORKSPACE, 'Owner agent', [' Outline this brief ', 'Ask for next steps'])
  const agentPath = agentBase(WORKSPACE) + '/' + original.id
  const first = await runtime.request('GET', directory(WORKSPACE))
  assert.equal(first.status, 200)
  assert.deepEqual(first.body.items.map(({ id, workspace_id, served_by, quick_starts }) =>
    ({ id, workspace_id, served_by, quick_starts })), [
    { id: original.id, workspace_id: WORKSPACE, served_by: 'ds-bot', quick_starts: ['Outline this brief', 'Ask for next steps'] },
  ])
  assert.deepEqual(first.body.conversations, [])
  assert.equal(runtime.sessions(), 0)

  const thread = await openThread(runtime, agentPath)
  const opened = await runtime.request('GET', thread)
  assert.equal(opened.status, 200)
  assert.deepEqual(opened.body.agent, first.body.items[0])
  assert.deepEqual(opened.body.items, [])

  const change = await runtime.request('POST', agentPath, { revision: original.revision, quick_starts: ['Review the revised plan'] })
  assert.equal(change.status, 200)
  const latest = await runtime.request('GET', thread)
  const listed = await runtime.request('GET', directory(WORKSPACE))
  assert.equal(listed.body.conversations.length, 1)
  assert.equal(listed.body.conversations[0].agent_id, original.id)
  assert.equal(latest.body.agent.revision, change.body.agent.revision)
  assert.deepEqual(latest.body.agent.quick_starts, ['Review the revised plan'])
  assert.deepEqual(listed.body.items[0].quick_starts, latest.body.agent.quick_starts)
  assert.equal(runtime.sessions(), 1)

  const cleared = await runtime.request('POST', agentPath, { revision: change.body.agent.revision, quick_starts: [] })
  assert.equal(cleared.status, 200)
  assert.deepEqual((await runtime.request('GET', thread)).body.agent.quick_starts, [])
  assert.deepEqual((await runtime.request('GET', directory(WORKSPACE))).body.items[0].quick_starts, [])
})

test('a published copy starts with the recipient model and independently configured capabilities', async t => {
  const runtime = ownerRuntime(t)
  const model = 'recipient-model'
  runtime.bots.main.model = model
  runtime.bots.main.capabilities = ['recipient-connected-tool']
  const request = {workspace_id:WORKSPACE, name:'Shared assistant', instructions:'Identify tasks.',
    quick_starts:['Plan the week'], idempotency_key:'fixture-create-remix'}
  await assert.rejects(runtime.endpoints.createRemix(request), error => error.status === 404)
  const {status,agent} = await runtime.endpoints.createRemix(request,{internal:true})
  assert.equal(status,201)
  const bot = runtime.bots[agent.native_bot_id]
  assert.equal(bot.model,model)
  assert.deepEqual(bot.capabilities,[])
  assert.deepEqual(agent.quick_starts,['Plan the week'])
  assert.equal(bot.flybotWorkspace.workspace_id,WORKSPACE)
  assert.equal(runtime.db.prepare('SELECT inherit_capabilities FROM agents WHERE id=?').get(agent.id).inherit_capabilities,0)
  await assert.rejects(runtime.endpoints.create(request), error => error.status === 409)

  bot.capabilities.push('explicitly-enabled-tool')
  const replay = await runtime.endpoints.createRemix(request,{internal:true})
  assert.equal(replay.status,200)
  assert.equal(replay.agent.id,agent.id)
  assert.deepEqual(bot.capabilities,['explicitly-enabled-tool'])
  const ordinary = await createAgent(runtime,WORKSPACE,'My own agent',[])
  assert.deepEqual(runtime.bots[ordinary.native_bot_id].capabilities,['recipient-connected-tool'])
})

test('private conversation organization preserves its owner, native session and historical entry', async t => {
  const owner = ownerRuntime(t)
  const agent = await createAgent(owner, WORKSPACE, 'Organizer', [])
  const neighbor = await createAgent(owner, WORKSPACE, 'Neighbor', [])
  const agentPath = agentBase(WORKSPACE) + '/' + agent.id
  const thread = await openThread(owner, agentPath)
  const id = thread.split('/').at(-1)
  const original = (await owner.request('GET', thread)).body.conversation
  const otherThread = (await owner.request('POST', agentPath+'/conversations', {title:'Also active'}, 'fixture-other-thread')).body.conversation.id
  const organize = (action, fields = {}) => owner.request('POST', thread, {action,...fields})
  const search = conversation_id => owner.endpoints.searchMessages({workspace_id:WORKSPACE,q:'Keep this',limit:10,conversation_id})
  const startup = conversation_id => owner.endpoints.startupEntry({workspace_id:WORKSPACE,agent_id:agent.id,conversation_id},{internal:true})
  const messageId = 'f'.repeat(32)
  owner.db.prepare(`INSERT INTO agent_messages (id,conversation_id,role,text,status,created)
    VALUES (?,?,'user','Keep this note','sent',3)`).run(messageId,id)
  owner.db.prepare('UPDATE agent_conversations SET updated=10 WHERE id=?').run(id)
  owner.db.prepare('UPDATE agent_conversations SET updated=5 WHERE id=?').run(otherThread)
  assert.equal((await startup()).conversation.id,id)
  assert.equal((await search()).items[0].id,messageId)
  assert.equal(original.title_edited,false)
  assert.equal((await organize('rename',{title:'   '})).status,400)
  assert.equal((await organize('rename',{title:original.title})).body.conversation.title_edited,true)
  const renamed = await organize('rename',{title:'  Sprint notes  '})
  assert.equal(renamed.status,200)
  assert.equal(renamed.body.conversation.title,'Sprint notes')
  assert.equal(renamed.body.conversation.title_edited,true)
  assert.equal(renamed.body.conversation.updated,10)
  assert.equal((await owner.request('POST',thread.replace(agent.id,neighbor.id),{action:'archive'})).status,404)
  assert.equal((await owner.request('POST',thread.replace(WORKSPACE,OTHER_WORKSPACE),{action:'archive'})).status,404)

  const archived = await organize('archive')
  assert.equal(archived.status,200)
  assert.equal(archived.body.conversation.archived,true)
  assert.ok(archived.body.conversation.archived_at > 0)
  assert.deepEqual((await organize('archive')).body,archived.body)
  assert.equal((await owner.request('GET',agentPath+'/conversations?archived=1')).body.items[0].id,id)
  assert.deepEqual((await owner.request('GET',agentPath+'/conversations')).body.items.map(row => row.id),[otherThread])
  assert.deepEqual((await owner.request('GET',directory(WORKSPACE))).body.conversations.map(row => row.id),[otherThread])
  const summaries = (await owner.request('GET',directory(WORKSPACE)+'&conversation_status=archived')).body.conversations
  assert.deepEqual(summaries.map(row => [row.id,row.title,row.archived,row.title_edited]),[[id,'Sprint notes',true,true]])
  assert.deepEqual((await search()).items,[])
  assert.equal((await search(id)).items[0].id,messageId)
  assert.equal((await startup()).conversation.id,otherThread)
  assert.equal((await startup(id)).conversation.archived,true)
  const detail = (await owner.request('GET',thread+'?limit=1')).body
  assert.equal(detail.conversation.native_session_id,original.native_session_id)
  assert.equal(detail.items[0].id,messageId)

  const replay = await owner.request('POST',agentPath+'/conversations',{title:'Fixture thread'},'fixture-conversation')
  assert.equal(replay.status,201)
  assert.deepEqual([replay.body.conversation.id,replay.body.conversation.title,replay.body.conversation.archived],[id,'Sprint notes',true])
  assert.equal((await owner.request('POST',agentPath+'/conversations',{title:'Sprint notes'},'fixture-conversation')).status,409)
  const restored = await organize('restore')
  assert.equal(restored.body.conversation.archived,false)
  assert.equal(restored.body.conversation.archived_at,null)
  assert.deepEqual((await organize('restore')).body,restored.body)
  assert.equal((await search()).items[0].id,messageId)
  assert.equal((await startup()).conversation.id,id)
  assert.equal(owner.sessions(),2)
})

test('archiving imported history does not bind a replacement native session during adoption or reads', async t => {
  const owner = ownerRuntime(t)
  const agent = await createAgent(owner, WORKSPACE, 'Personal chat', [])
  const id = 'f'.repeat(32), message = 'a'.repeat(32)
  const legacy = {workspace_id:WORKSPACE,id:agent.id,conversations:[{id,title:'Legacy topic',created:1,updated:2,
    messages:[{id:message,role:'user',text:'Retained message',created:2}]}]}
  await owner.endpoints['adopt-personal-chat'](legacy,false)
  const thread = agentBase(WORKSPACE)+'/'+agent.id+'/conversations/'+id
  assert.equal((await owner.request('POST',thread,{action:'rename',title:'Retained topic'})).status,200)
  assert.equal((await owner.request('POST',thread,{action:'archive'})).status,200)
  await owner.endpoints['adopt-personal-chat'](legacy)
  await owner.endpoints.reconcile()
  const archived = (await owner.request('GET',thread)).body
  assert.equal(archived.conversation.archived,true)
  assert.equal(archived.conversation.title,'Retained topic')
  assert.equal(archived.conversation.native_session_id,null)
  assert.deepEqual(archived.items.map(row => row.id),[message])
  assert.equal(owner.sessions(),0)
})

test('archive pagination keeps every same-second conversation reachable without exposing agent instructions', async t => {
  const owner = ownerRuntime(t)
  const agent = await createAgent(owner,WORKSPACE,'Large archive',[])
  const other = await createAgent(owner,OTHER_WORKSPACE,'Other archive',[])
  const insert = owner.db.prepare(`INSERT INTO agent_conversations
    (id,agent_id,title,created,updated,archived_at) VALUES (?,?,'Archived',1,2,3)`)
  for (let i = 0; i < 205; i++) insert.run(i.toString(16).padStart(32,'0'),agent.id)
  insert.run('f'.repeat(32),other.id)
  const aggregate = directory(WORKSPACE)+'&conversation_status=archived'
  const perAgent = agentBase(WORKSPACE)+'/'+agent.id+'/conversations?archived=1&limit=100'
  for (const [path,key] of [[aggregate,'conversations'],[perAgent,'items']]) {
    const seen = []
    let cursor = null
    do {
      const response = await owner.request('GET',path + (cursor ? '&cursor='+cursor : ''))
      assert.equal(response.status,200)
      assert.ok(response.body[key].every(row => row.agent_id === agent.id))
      if (key === 'conversations') assert.deepEqual(response.body.items,[{
        id:agent.id,workspace_id:WORKSPACE,name:'Large archive',archived:0,native_deleted:false,served_by:'ds-bot',
      }])
      seen.push(...response.body[key].map(row => row.id))
      cursor = response.body.cursor
    } while (cursor)
    assert.deepEqual(seen,Array.from({length:205},(_,i) => (204-i).toString(16).padStart(32,'0')))
  }
  assert.equal((await owner.request('GET',aggregate+'&cursor='+agent.id)).status,400)
  assert.equal(owner.sessions(),0)
})

test('archived and deleted agents cannot supply starter chips from old Chat rows', async t => {
  const runtime = ownerRuntime(t)
  const agent = await createAgent(runtime, WORKSPACE, 'Archived agent', ['Saved archive starter'])
  const agentPath = agentBase(WORKSPACE) + '/' + agent.id
  const thread = await openThread(runtime, agentPath)
  const bot = runtime.bots[agent.native_bot_id]
  bot.hidden = true
  const hidden = await runtime.request('GET', thread)
  assert.equal(hidden.status, 200)
  assert.equal(hidden.body.agent.archived, 1)
  assert.deepEqual(hidden.body.agent.quick_starts, [])
  const archived = await runtime.request('GET', directory(WORKSPACE, true))
  assert.deepEqual(archived.body.items[0].quick_starts, [])
  const editor = await runtime.request('GET', agentPath)
  assert.equal(editor.body.agent.archived, 1)
  assert.deepEqual(editor.body.agent.quick_starts, ['Saved archive starter'])

  bot.hidden = false
  assert.deepEqual((await runtime.request('GET', agentPath)).body.agent.quick_starts, ['Saved archive starter'])
  delete runtime.bots[agent.native_bot_id]
  const stale = await runtime.request('GET', directory(WORKSPACE, true))
  assert.equal(stale.body.items[0].native_deleted, true)
  assert.deepEqual(stale.body.items[0].quick_starts, [])
  const removed = await runtime.request('GET', thread)
  assert.equal(removed.status, 409)
  assert.equal(removed.body.error.code, 'native_deleted')
  assert.equal(removed.body.agent, undefined)
})

test('private agent starters remain local to the account and workspace even for the same shared workspace ID', async t => {
  const owner = ownerRuntime(t)
  const other = ownerRuntime(t)
  const a = await createAgent(owner, WORKSPACE, 'First account', ['First account only'])
  const b = await createAgent(other, WORKSPACE, 'Second account', ['Second account only'])
  const anotherWorkspace = await createAgent(owner, OTHER_WORKSPACE, 'Other workspace', ['Other workspace only'])
  const agentPath = agentBase(WORKSPACE) + '/' + a.id
  const thread = await openThread(owner, agentPath)
  assert.deepEqual((await owner.request('GET', directory(WORKSPACE))).body.items.map(row => row.id), [a.id])
  assert.deepEqual((await owner.request('GET', directory(OTHER_WORKSPACE))).body.items.map(row => row.id), [anotherWorkspace.id])
  assert.deepEqual((await other.request('GET', directory(WORKSPACE))).body.items.map(row => row.id), [b.id])
  assert.equal((await owner.request('GET', thread.replace(WORKSPACE, OTHER_WORKSPACE))).status, 404)
  assert.equal((await other.request('GET', thread)).status, 404)
  assert.equal((await other.request('GET', agentPath)).status, 404)
  assert.deepEqual((await other.request('GET', directory(WORKSPACE))).body.conversations, [])
  assert.equal(other.sessions(), 0)
})

test('the native Chat directory pages durable data before the runtime attaches', async t => {
  const owner = ownerRuntime(t)
  const [personal, archived, second, foreign, thread] = ['a','b','c','d','e'].map(id => id.repeat(32))
  await owner.importAgents([
    {id: personal, workspace_id: WORKSPACE, name: 'Personal agent', quick_starts: ['Start an outline']},
    {id: archived, workspace_id: WORKSPACE, name: 'Archived draft', archived: true, quick_starts: ['Hidden starter']},
    {id: second, workspace_id: WORKSPACE, name: 'Second agent'},
    {id: foreign, workspace_id: OTHER_WORKSPACE, name: 'Other workspace'},
  ])
  const insert = owner.db.prepare('INSERT INTO agent_conversations (id,agent_id,title,created,updated) VALUES (?, ?, ?, 1, 1)')
  insert.run(thread, personal, 'Retained conversation')
  insert.run(foreign, foreign, 'Other thread')
  owner.db.prepare('INSERT INTO native_personal_binding VALUES (1, ?, ?)').run(WORKSPACE, personal)
  owner.db.prepare('INSERT INTO native_agent_objects VALUES (?, ?, ?)').run(personal, 'saved-bot-id', 'Personal agent')
  owner.db.exec('PRAGMA query_only=ON')
  owner.host.currentRuntime = () => null
  let runtimeRequests = 0
  owner.host.runtime = async () => {
    runtimeRequests += 1
    throw new Error('Runtime has not attached')
  }
  const reads = []
  owner.host.call = async name => {
    reads.push(name)
    return {recall: 'off'}
  }
  const url = agentBase(WORKSPACE) + '?limit=1&include=conversations'
  const first = await owner.request('GET', url)
  assert.equal(first.status, 200)
  assert.deepEqual(first.body.items.map(row => [row.id, row.native_bot_id, row.quick_starts, row.memory_recall_default]),
    [[personal, 'saved-bot-id', ['Start an outline'], false]])
  assert.equal(first.body.cursor, personal)
  assert.deepEqual(first.body.conversations.map(row => ({...row})),
    [{id: thread, agent_id: personal, title: 'Retained conversation', updated: 1, archived_at:null, archived:false, title_edited:false}])

  const next = await owner.request('GET', url + '&cursor=' + first.body.cursor)
  assert.equal(next.status, 200)
  assert.deepEqual(next.body.items.map(row => [row.id, row.native_bot_id]), [[second, null]])
  assert.equal(next.body.cursor, null)
  assert.deepEqual(next.body.conversations, [])

  const withArchived = await owner.request('GET', url + '&cursor=' + personal + '&include_archived=1')
  assert.equal(withArchived.status, 200)
  assert.deepEqual(withArchived.body.items.map(row => [row.id, row.archived, row.quick_starts]), [[archived, 1, []]])
  assert.equal(withArchived.body.cursor, archived)
  assert.deepEqual(reads, ['personal/get'])
  assert.equal(runtimeRequests, 0)
  assert.equal(owner.sessions(), 0)
})

test('the native Chat directory and thread observe live roster edits without a model or database writes', async t => {
  const owner = ownerRuntime(t)
  const longName = 'An agent with a saved name that exceeds the native bot alias limit'
  const created = await owner.request('POST', agentBase(WORKSPACE),
    {name: longName, quick_starts: ['Outline this brief']}, 'fixture-agent-long-name')
  assert.equal(created.status, 201)
  const agent = created.body.agent
  const agentPath = agentBase(WORKSPACE) + '/' + agent.id
  const thread = await openThread(owner, agentPath)
  const bot = owner.bots[agent.native_bot_id]
  assert.notEqual(bot.name, longName)
  owner.db.exec('PRAGMA query_only=ON')
  let startups = 0
  owner.runtime.mainBot = async () => {
    startups += 1
    throw new Error('Model is unavailable')
  }

  const initial = await owner.request('GET', directory(WORKSPACE))
  assert.equal(initial.status, 200)
  assert.equal(initial.body.items[0].name, longName)
  bot.name = 'Native renamed agent'
  const renamed = await owner.request('GET', directory(WORKSPACE))
  assert.equal(renamed.status, 200)
  assert.equal(renamed.body.items[0].name, bot.name)
  assert.equal((await owner.request('GET', thread)).body.agent.name, bot.name)
  assert.equal(owner.db.prepare('SELECT name FROM agents WHERE id=?').get(agent.id).name, longName)

  bot.hidden = true
  assert.deepEqual((await owner.request('GET', directory(WORKSPACE))).body.items, [])
  const hidden = await owner.request('GET', directory(WORKSPACE, true))
  assert.equal(hidden.body.items[0].archived, 1)
  assert.deepEqual(hidden.body.items[0].quick_starts, [])
  delete owner.bots[agent.native_bot_id]
  const deleted = await owner.request('GET', directory(WORKSPACE, true))
  assert.equal(deleted.body.items[0].native_deleted, true)
  assert.equal(deleted.body.items[0].native_bot_id, agent.native_bot_id)
  assert.equal(startups, 0)
  assert.equal((await owner.request('GET', agentBase(WORKSPACE))).status, 500)
  assert.equal(startups, 1)
})

test('archived agents can be listed and restored without recreating or crossing owner scope', async t => {
  const runtime = ownerRuntime(t)
  const outsider = ownerRuntime(t)
  outsider.host.call = async name => name === 'teams/activeWorkspaces' ? [] : null
  const agent = await createAgent(runtime, WORKSPACE, 'Recoverable agent', ['Existing starter'])
  let archiveRole = 'owner'
  runtime.host.call = async name => {
    if (name === 'agents/personal-binding') return null
    assert.equal(name, 'teams/activeWorkspaces')
    if (archiveRole === 'unavailable') throw Error('Bot Social unavailable')
    return [{id: WORKSPACE, role: archiveRole}, {id: OTHER_WORKSPACE, role: 'owner'}]
  }
  const another = await createAgent(runtime, WORKSPACE, 'Active neighbour', [])
  const archive = agentBase(WORKSPACE) + '/' + agent.id + '/archive'
  const directory = agentBase(WORKSPACE) + '?limit=100'
  const archivedList = directory + '&archived=1'
  assert.equal((await runtime.request('GET', archive)).status, 405)
  assert.equal((await runtime.request('POST', archive, {archived:'false', revision:agent.revision})).status, 400)
  assert.equal((await runtime.request('POST', archive, {archived:false})).status, 400)
  const saved = await runtime.request('POST', archive, {archived:true, revision:agent.revision})
  assert.equal(saved.status, 200)
  assert.equal(saved.body.agent.archived, 1)
  assert.deepEqual((await runtime.request('GET', directory)).body.items.map(item=>item.id),[another.id])
  assert.equal((await runtime.request('GET', archivedList+'&include_archived=1')).status,400)
  const [hidden] = (await runtime.request('GET', archivedList)).body.items
  assert.equal(hidden.id, agent.id)
  assert.equal(runtime.bots[hidden.native_bot_id].hidden, true)
  assert.equal((await outsider.request('POST', archive, {archived:false, revision:hidden.revision})).status, 403)
  assert.equal((await runtime.request('POST', archive, {archived:false, revision:agent.revision})).status, 409)
  archiveRole = 'member'
  assert.equal((await runtime.request('GET', archivedList)).status, 403)
  assert.equal((await runtime.request('GET', directory+'&include_archived=1')).status, 403)
  const hiddenResponse = await runtime.request('POST', archive, {archived:false, revision:hidden.revision})
  const missingResponse = await runtime.request('POST', agentBase(WORKSPACE) + '/' + 'f'.repeat(32) + '/archive',
    {archived:false, revision:hidden.revision})
  assert.equal(hiddenResponse.status, 403)
  assert.deepEqual(missingResponse, hiddenResponse)
  assert.deepEqual((await runtime.request('GET', directory)).body.items.map(item=>item.id), [another.id])
  await assert.rejects(runtime.endpoints.archive({workspace_id:WORKSPACE, id:agent.id,
    archived:false, revision:hidden.revision}), error => error.status === 403)
  assert.equal(runtime.bots[hidden.native_bot_id].hidden, true)
  archiveRole = 'unavailable'
  assert.equal((await runtime.request('GET', archivedList)).status, 503)
  archiveRole = 'admin'
  const restored = await runtime.request('POST', archive, {archived:false, revision:hidden.revision})
  assert.equal(restored.status, 200)
  assert.equal(restored.body.agent.id, agent.id)
  assert.equal(restored.body.agent.native_bot_id, agent.native_bot_id)
  assert.deepEqual(restored.body.agent.quick_starts, ['Existing starter'])
  assert.equal(runtime.bots[agent.native_bot_id].hidden, false)
  assert.deepEqual((await runtime.request('GET', archivedList)).body.items,[])
})
