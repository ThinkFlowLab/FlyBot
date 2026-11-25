import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { boot, bootMemory, deliverBundle, key, volume, WS } from './helpers.js'
import { digest } from '../featurekit/http.js'
import { setSharedBotSocial } from '../lib/c/bot-social.js'
import { loadIdentity } from '../src/identity.js'

// The search path should read the native agent ledger without starting a model turn.
function seedChat(bot, workspace = WS, prefix = 'a') {
  const agent = (prefix + 'e').repeat(16)
  const conversation = (prefix + 'f').repeat(16)
  const db = new DatabaseSync(join(bot.vol.data, 'flybot-workspace', 'features', 'agents', 'agents.sqlite3'))
  const ids = ['1','2','3'].map(index => (prefix + index).repeat(16))
  try {
    db.prepare(`INSERT INTO agents (id, workspace_id, name, name_hash, summary, instructions, revision, created,
      updated, key_hash, request_hash) VALUES (?, ?, '周报助手', ?, '', '', 1, 1, 1, ?, ?)`).run(agent, workspace, agent, agent, agent)
    db.prepare('INSERT INTO agent_conversations (id,agent_id,title,created,updated) VALUES (?,?,?,?,?)').run(conversation, agent, '周报助手', 1, 1)
    const insert = db.prepare(`INSERT INTO agent_messages (id, conversation_id, role, text, status, created)
      VALUES (?, ?, ?, ?, 'succeeded', ?)`)
    for (const [i, text] of ['帮我写周报', '好的，周报草稿见 https://example.com/report。', '谢谢'].entries()) {
      insert.run(ids[i], conversation, i % 2 ? 'assistant' : 'user', text, 1800000000 + i)
    }
  } finally {
    db.close()
  }
  return { agent, conversation, ids }
}

test('the session directory lists only the selected workspace conversations without a native runtime', async () => {
  const bot = await boot()
  const local = seedChat(bot)
  const other = seedChat(bot, 'b'.repeat(32), 'b')
  const result = await bot.endpoint('agents/conversationSummaries', {
    workspace_id: WS, agent_ids: [local.agent, other.agent, local.agent],
  })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.deepEqual(result.value.items, [{
    id:local.conversation, agent_id:local.agent, title:'周报助手', updated:1, archived_at:null, archived:false, title_edited:false,
  }])
})

test('message search runs in DS-Bot over this owner\'s own conversations', async () => {
  const bot = await boot()
  assert.ok(bot.features.loaded.includes('search'), JSON.stringify(bot.features.failed))
  const { agent, conversation, ids } = seedChat(bot)
  seedChat(bot, 'b'.repeat(32), 'b')
  const call = (path) => bot.call('search', 'GET', path)
  const found = await call(`/v1/workspaces/${WS}/search/messages?q=周报&kind=agent&limit=1`)
  assert.equal(found.status, 200, JSON.stringify(found.body))
  assert.deepEqual(found.body.items.map((item) => item.message_id), [ids[0]])
  assert.equal(found.body.items[0].agent_id, agent)
  assert.equal(found.body.items[0].title, '周报助手')
  assert.equal(found.body.items[0].created, 1800000000)
  assert.equal(found.body.items[0].role, 'user')
  assert.equal(found.body.items[0].agent_name, undefined)
  assert.equal(found.body.cursor, ids[0])
  const next = await call(`/v1/workspaces/${WS}/search/messages?q=周报&limit=1&cursor=${ids[0]}`)
  assert.deepEqual(next.body.items.map((item) => item.message_id), [ids[1]])
  assert.equal(next.body.items[0].role, 'assistant')
  assert.equal(next.body.items[0].agent_name, '周报助手')
  assert.deepEqual((await call(`/v1/workspaces/${WS}/search/messages?q=周报&conversation_id=${conversation}`))
    .body.items.map(item => item.message_id), ids.slice(0, 2))
  assert.equal((await call(`/v1/workspaces/${WS}/search/messages?q=周报&conversation_id=${'f'.repeat(32)}`)).body.items.length, 0)
  assert.equal((await call(`/v1/workspaces/${WS}/search/messages?q=`)).status, 400)
  assert.equal((await call(`/v1/workspaces/${WS}/search/messages?q=x&bogus=1`)).status, 400)
  const links = await call(`/v1/workspaces/${WS}/search/resources?kind=links&q=`)
  assert.deepEqual(links.body.items.map((item) => item.href), ['https://example.com/report'])
  const files = await call(`/v1/workspaces/${WS}/search/resources?kind=files&q=x`)
  assert.equal(files.status, 200)
  const other = await boot()
  assert.equal((await other.call('search', 'GET', `/v1/workspaces/${WS}/search/messages?q=周报&kind=agent`)).body.items.length, 0)
})

test('target-bound imported history is searchable with stable source IDs, workspace scoping and keyset paging', async () => {
  const vol = volume()
  const owner = loadIdentity({env: process.env, dataDir: vol.data})
  const instance = owner.routingInstanceId ?? owner.instanceId
  const otherWorkspace = 'b'.repeat(32)
  const agent = '1'.repeat(32)
  const otherAgent = '2'.repeat(32)
  const conversation = '3'.repeat(32)
  const otherConversation = '4'.repeat(32)
  const first = '5'.repeat(32)
  const second = '6'.repeat(32)
  const third = '7'.repeat(32)
  const foreign = '8'.repeat(32)
  const created = 1800000000
  const rows = {
    workspace_agents: [
      {id: agent, workspace_id: WS, name: '导入助手'},
      {id: otherAgent, workspace_id: otherWorkspace, name: '另一空间助手'},
    ],
    agent_conversations: [
      {id: conversation, workspace_id: WS, agent_id: agent, title: '原始对话标题', created, updated: created + 1},
      {id: otherConversation, workspace_id: otherWorkspace, agent_id: otherAgent, title: '另一空间对话', created, updated: created},
    ],
    agent_messages: [
      {id: second, workspace_id: WS, agent_id: agent, conversation_id: conversation, role: 'assistant',
        body: '季度总结第二段 https://example.com/imported。', created, status: 'succeeded'},
      {id: first, workspace_id: WS, agent_id: agent, conversation_id: conversation, role: 'user',
        body: '季度总结第一段', created, status: 'succeeded'},
      {id: third, workspace_id: WS, agent_id: agent, conversation_id: conversation, role: 'user',
        body: '季度总结第三段', created: created + 1, status: 'succeeded'},
      {id: foreign, workspace_id: otherWorkspace, agent_id: otherAgent, conversation_id: otherConversation, role: 'user',
        body: '另一空间季度总结', created, status: 'succeeded'},
    ],
  }
  const tables = Object.fromEntries(Object.entries(rows).map(([name, items]) => [name, JSON.stringify(items)]))
  const manifest = Object.fromEntries(Object.entries(tables).map(([name, body]) =>
    [name, {rows: rows[name].length, sha256: digest(body)}]))
  const bundle = {format: 'flybot-workspace-dsbot-import', version: 1, feature: 'agents', instance_id: instance, tables, manifest}
  const filename = 'legacy-agent-history.bundle'
  deliverBundle(vol, filename, JSON.stringify(bundle))
  const bot = await boot(vol)
  assert.ok(bot.features.loaded.includes('agents'), JSON.stringify(bot.features.failed))
  const messagePath = `/v1/workspaces/${WS}/search/messages?q=季度总结&kind=agent`
  const search = query => bot.call('search', 'GET', messagePath + (query || ''))
  const page = await search('&limit=1')
  assert.equal(page.status, 200)
  assert.deepEqual(page.body.items.map(item => [item.message_id, item.agent_id, item.conversation_id, item.title, item.created]),
    [[first, agent, conversation, '原始对话标题', created]])
  assert.equal(page.body.cursor, first)
  const next = await search('&limit=1&cursor=' + page.body.cursor)
  assert.deepEqual(next.body.items.map(item => [item.message_id, item.agent_name]), [[second, '导入助手']])
  const last = await search('&limit=1&cursor=' + next.body.cursor)
  assert.deepEqual(last.body.items.map(item => item.message_id), [third])
  assert.equal(last.body.cursor, null)
  assert.deepEqual((await search('&conversation_id=' + otherConversation)).body.items, [])
  assert.equal((await search('&cursor=' + foreign)).status, 400)
  assert.deepEqual((await bot.call('search', 'GET', messagePath.replace(WS, otherWorkspace))).body.items.map(item => item.message_id),
    [foreign])
  const links = await bot.call('search', 'GET', `/v1/workspaces/${WS}/search/resources?kind=links&q=季度总结`)
  assert.deepEqual(links.body.items.map(item => [item.id, item.href]), [[second, 'https://example.com/imported']])

  const hook = await bot.endpoint('agents/searchMessages', {
    workspace_id: WS, q: '季度总结', limit: 1, cursor: first, ascending: true,
  })
  assert.equal(hook.ok, true, JSON.stringify(hook.error))
  assert.deepEqual(hook.value.items.map(item => item.id), [second])

  const stranger = volume()
  deliverBundle(stranger, filename, JSON.stringify(bundle))
  const other = await boot(stranger)
  assert.notEqual(other.identity.routingInstanceId ?? other.identity.instanceId, instance)
  assert.deepEqual((await other.call('search', 'GET', messagePath)).body.items, [])
})

test('a missing agent feature keeps authorized shared search and indicates private search is unavailable', async (t) => {
  const bot = await boot()
  delete bot.features.table['agents/searchMessages']
  delete bot.features.table['agents/personal-binding']
  const requested = []
  setSharedBotSocial({async request(method, raw) {
    assert.equal(method, 'GET')
    const url = new URL(raw, 'http://bot-social.test')
    assert.equal(url.searchParams.get('q'), '季度总结')
    requested.push(url.pathname)
    if (url.pathname !== `/v1/ot/workspaces/${WS}/messages/search`) throw Object.assign(Error('not visible'), {status: 404})
    return {items: [{
      cursor: '1800000000000:1', conversation_id: 'group', title: '讨论组', message_id: 'shared-1',
      body: '讨论季度总结', created_ms: 1800000000000,
    }]}
  }})
  t.after(() => setSharedBotSocial(undefined))

  const path = `/v1/workspaces/${WS}/search/messages?q=季度总结`
  const all = await bot.call('search', 'GET', path)
  assert.equal(all.status, 200)
  assert.deepEqual(all.body.items.map(item => item.message_id), ['shared-1'])
  assert.match(all.body.warning, /智能体消息搜索暂不可用/)
  const social = await bot.call('search', 'GET', path + '&kind=social')
  assert.equal(social.status, 200)
  assert.deepEqual(social.body.items.map(item => item.message_id), ['shared-1'])
  assert.equal(social.body.warning, undefined)
  assert.equal((await bot.call('search', 'GET', path + '&kind=agent')).status, 503)
  assert.equal((await bot.call('search', 'GET', `/v1/workspaces/${WS}/search/resources?kind=links`)).status, 503)
  assert.equal((await bot.call('search', 'GET', path.replace(WS, 'b'.repeat(32)))).status, 404)
  assert.deepEqual(requested, [
    `/v1/ot/workspaces/${WS}/messages/search`, `/v1/ot/workspaces/${WS}/messages/search`,
    `/v1/ot/workspaces/${'b'.repeat(32)}/messages/search`,
  ])
})

test('global search merges private history and Bot Social results without skipping a source', async (t) => {
  const bot = await boot()
  const { ids } = seedChat(bot)
  seedChat(bot, 'b'.repeat(32), 'b')
  const shared = [1800000002000, 1800000001000, 1800000000500].map((created_ms, index) => ({
    cursor: created_ms + ':' + (100 - index),
    conversation_id: 'group', title: '讨论组', message_id: 'shared-' + index, body: '讨论周报', created_ms,
  }))
  const requested = []
  let unavailable = false
  setSharedBotSocial({async request(method, raw) {
    assert.equal(method, 'GET')
    const url = new URL(raw, 'http://bot-social.test')
    assert.equal(url.pathname, `/v1/ot/workspaces/${WS}/messages/search`)
    assert.equal(url.searchParams.get('q'), '周报')
    if (unavailable) throw new Error('disconnected')
    const before = url.searchParams.get('before')
    requested.push(before)
    const from = before === null ? 0 : shared.findIndex(row => row.cursor === before) + 1
    return {items: shared.slice(from, from + Number(url.searchParams.get('limit')))}
  }})
  t.after(() => setSharedBotSocial(undefined))
  const call = (suffix = '') => bot.call('search', 'GET', `/v1/workspaces/${WS}/search/messages?q=周报&limit=2${suffix}`)
  const first = await call()
  assert.deepEqual(first.body.items.map(item => item.message_id), [shared[0].message_id, ids[1]])
  const second = await call('&cursor=' + first.body.cursor)
  assert.deepEqual(second.body.items.map(item => item.message_id), [shared[1].message_id, shared[2].message_id])
  const last = await call('&cursor=' + second.body.cursor)
  assert.deepEqual(last.body.items.map(item => item.message_id), [ids[0]])
  assert.equal(last.body.cursor, null)
  assert.deepEqual(requested, [null, shared[0].cursor, shared[2].cursor])
  assert.equal((await call('&cursor=s1.e30')).status, 400)
  unavailable = true
  const partial = await call()
  assert.deepEqual(partial.body.items.map(item => item.message_id), [ids[1], ids[0]])
  assert.ok(partial.body.warning)
  assert.equal((await call('&kind=social')).status, 503)
})

test('saving an authorized chat message creates one private versioned document with provenance', async (t) => {
  const bot = await boot()
  const local = seedChat(bot)
  const foreign = seedChat(bot, 'b'.repeat(32), 'b')
  const convoPath = `/v1/workspaces/${WS}/agents/${local.agent}/conversations/${local.conversation}`
  const saveAgent = convoPath + '/messages/'
  const receiptPath = saveAgent + local.ids[1] + '/artifact'
  assert.equal((await bot.call('agents', 'GET', receiptPath)).status, 404)
  const impostor = {
    title:'Manual creation',body:'Not the actual reply',kind:'document',
    source:{kind:'agent_message',id:local.ids[1],agent_id:local.agent,conversation_id:local.conversation},
  }
  assert.equal((await bot.call('artifacts', 'POST', `/v1/workspaces/${WS}/artifacts`, impostor, key())).status, 403)
  assert.equal((await bot.endpoint('artifacts/create', {...impostor,workspace_id:WS,idempotency_key:key()})).ok, false)
  assert.equal((await bot.call('agents', 'GET', receiptPath)).status, 404)
  assert.equal((await bot.call('agents', 'POST', saveAgent + foreign.ids[1] + '/artifact', {})).status, 404)
  const first = await bot.call('agents', 'POST', saveAgent + local.ids[1] + '/artifact', {title: 'Private note'})
  assert.equal(first.status, 201, JSON.stringify(first.body))
  const privateArtifact = first.body.artifact
  assert.equal(privateArtifact.body, '好的，周报草稿见 https://example.com/report。')
  assert.equal(privateArtifact.source.agent_id, local.agent)
  assert.equal(privateArtifact.source.conversation_id, local.conversation)
  const snapshot = await bot.call('artifacts', 'GET', `/v1/workspaces/${WS}/artifacts/${privateArtifact.id}/versions/1`)
  assert.equal(snapshot.body.version.body, privateArtifact.body)
  const duplicate = await bot.call('agents', 'POST', saveAgent + local.ids[1] + '/artifact', {title: 'Renamed retry'})
  assert.equal(duplicate.status, 200)
  assert.equal(duplicate.body.artifact.id, privateArtifact.id)
  assert.equal(duplicate.body.artifact.title, 'Private note')

  const receipt = {id:privateArtifact.id,title:'Private note'}
  assert.deepEqual((await bot.call('agents', 'GET', receiptPath)).body, {artifact:receipt})
  assert.equal((await bot.call('agents', 'GET', saveAgent + foreign.ids[1] + '/artifact')).status, 404)
  assert.equal((await bot.call('agents', 'GET', receiptPath.replace(WS, 'b'.repeat(32)))).status, 404)
  assert.equal((await bot.endpoint('artifacts/savedChatWorks', {
    workspace_id:WS, agent_id:local.agent, conversation_id:local.conversation,
  })).ok, false)
  // Archived conversations remain readable without attaching the native roster.
  await bot.call('agents', 'POST', convoPath, {action:'archive'})
  const history = await bot.call('agents', 'GET', convoPath + '?limit=3&around=' + local.ids[1])
  assert.equal(history.status, 200)
  assert.deepEqual(history.body.items.filter(item => item.saved_work).map(item => [item.id,item.saved_work]),
    [[local.ids[1],receipt]])
  const rename = await bot.call('artifacts', 'POST', `/v1/workspaces/${WS}/artifacts/${privateArtifact.id}`, {
    revision:privateArtifact.revision, changes:{title:'Renamed document'},
  })
  assert.equal(rename.status, 200)
  assert.deepEqual((await bot.call('agents', 'GET', receiptPath)).body.artifact, {...receipt,title:'Renamed document'})

  const sharedId = 'otm_history_1', oldId = 'otm_old_copy', sharedConversation = 'otc_product'
  let revision = 2
  let text = 'Historical shared message'
  const old = await bot.endpoint('artifacts/create', {workspace_id: WS, kind: 'document',
    title: 'Existing copy title', body: 'Older saved text', idempotency_key: 'msg-save-' + oldId})
  assert.equal(old.ok, true)
  setSharedBotSocial({async request(method, path) {
    assert.equal(method, 'GET')
    if (path === '/v1/ot/teams/by-workspace/' + WS) return {id:'ott_product'}
    if (path.endsWith('/' + oldId)) return {body: 'Older saved text', revision: 1, title: 'Product team'}
    assert.equal(path, `/v1/ot/workspaces/${WS}/conversations/${sharedConversation}/messages/${sharedId}`)
    return {body: text, revision, title: 'Product team'}
  }})
  t.after(() => setSharedBotSocial(undefined))
  const saveShared = `/v1/workspaces/${WS}/social/conversations/${sharedConversation}/messages/${sharedId}/save`
  const save = (title, revision) => bot.call('messenger', 'POST', saveShared, {title, revision})
  assert.equal((await save('Shared note', 1)).status, 409)
  const shared = await save('Shared note', 2)
  assert.equal(shared.status, 201, JSON.stringify(shared.body))
  assert.deepEqual(shared.body.artifact.source, {
    kind: 'agent_message', id: sharedId, conversation_id: sharedConversation, conversation_title: 'Product team',
  })
  revision += 1
  text = 'Edited shared message'
  const again = await save('Edited title', revision)
  assert.equal(again.status, 200)
  assert.equal(again.body.artifact.id, shared.body.artifact.id)
  assert.equal(again.body.artifact.body, 'Historical shared message')
  const reused = await bot.call('messenger', 'POST', saveShared.replace(sharedId, oldId), {
    title: 'Different title after upgrade', revision: 1,
  })
  assert.equal(reused.status, 200)
  assert.equal(reused.body.artifact.id, old.value.artifact.id)
  assert.equal(reused.body.artifact.source.id, oldId)
  const other = await boot()
  const docs = `/v1/workspaces/${WS}/artifacts`
  assert.equal((await bot.call('artifacts', 'GET', docs)).body.items.length, 3)
  assert.equal((await other.call('artifacts', 'GET', docs + '/' + privateArtifact.id)).status, 404)
  assert.equal((await other.call('agents', 'GET', receiptPath)).status, 404)
  assert.equal((await bot.call('artifacts', 'POST', docs + '/' + privateArtifact.id + '/remove', {})).status, 200)
  assert.equal((await bot.call('agents', 'GET', receiptPath)).status, 404)
  const afterDelete = await bot.call('agents', 'GET', convoPath + '?limit=3')
  assert.ok(afterDelete.body.items.every(item => !item.saved_work))

  const migrated = {id:'7'.repeat(32),title:'Legacy private document'}
  const tables = {
    artifacts:JSON.stringify([{...migrated,workspace_id:WS,title_hash:digest(migrated.title),kind:'document',
      body:privateArtifact.body,revision:1,created:1,updated:1,created_by:'owner',updated_by:'owner',
      key_hash:digest('legacy-save'),request_hash:digest('legacy-request'),
    }]),
    artifact_chat_sources:JSON.stringify([{artifact_id:migrated.id,workspace_id:WS,agent_id:local.agent,
      conversation_id:local.conversation,message_id:local.ids[1],created:1,
    }]),
  }
  const manifest = Object.fromEntries(Object.entries(tables).map(([name, body]) => [name,{rows:1,sha256:digest(body)}]))
  deliverBundle(bot.vol,'legacy-private-work.bundle',JSON.stringify({
    format:'flybot-workspace-dsbot-import',version:1,feature:'artifacts',tables,manifest,
  }))
  const restored = await boot(bot.vol)
  assert.deepEqual((await restored.call('agents','GET',receiptPath)).body.artifact,migrated)
  assert.equal((await restored.call('agents','POST',receiptPath,{title:'Retry imported'})).body.artifact.id,migrated.id)

})

test('search/all opens the exact artifact, memory and meeting from this DS-Bot', async () => {
  const bot = await bootMemory()
  const base = `/v1/workspaces/${WS}`
  const {page} = (await bot.call('memory','POST',base+'/memory',{title:'季度目标',body:'增长 20%'},key())).body
  const {meeting} = (await bot.call('meetings','POST',base+'/meetings',{title:'季度复盘',summary:'回顾目标'},key())).body
  const {artifact} = (await bot.call('artifacts','POST',base+'/artifacts',{title:'复盘材料',body:'季度报告'},key())).body
  const all = await bot.endpoint('search/all', { q: '季度' })
  assert.equal(all.ok, true, JSON.stringify(all))
  assert.deepEqual(all.value.items.map(item=>item.href).sort(), [
    `/meetings#workspace=${WS}&meeting=${meeting.id}`,
    `/memory?workspace=${WS}&page=${page.id}`,
    `/space?workspace=${WS}&artifact=${artifact.id}`,
  ])
  assert.equal((await bot.endpoint('search/all', { q: '' })).ok, false)
})
