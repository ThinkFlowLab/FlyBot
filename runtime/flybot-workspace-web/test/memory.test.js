import assert from 'node:assert/strict'
import test from 'node:test'
import { bootMemory as boot, deliverBundle, key, legacyBundles, volume, WS } from './helpers.js'
import { setSharedBotSocial } from '../lib/c/bot-social.js'

const base = (rest = '', ws = WS) => `/v1/workspaces/${ws}/memory${rest}`

test('a reviewed team message produces one private action with scoped provenance and current revision', async t => {
  const team = 'b'.repeat(32)
  const room = 'otc_' + 'C'.repeat(26)
  const message = 'otm_' + 'D'.repeat(26)
  const other = 'otm_' + 'E'.repeat(26)
  const route = `/v1/ot/workspaces/${team}/conversations/${room}/messages/`
  const reads = []
  let accessible = true
  setSharedBotSocial({
    async request(method,path) {
      assert.equal(method,'GET')
      reads.push(path)
      if (accessible && (path === route + message || path === route + other)) {
        return {revision:2,body:'已保存的群聊原话'}
      }
      throw Object.assign(new Error('Fixture cannot view source'),{status:404})
    },
  })
  t.after(()=>setSharedBotSocial(undefined))
  const bot = await boot(volume(),{teams:[team]})
  const call = (...args)=>bot.call('memory',...args)
  const path = base('/actions/from-chat')
  const source = {kind:'social',workspace_id:team,conversation_id:room,message_id:message,revision:2}
  const write = (changes={})=>call('POST',path,{source,title:'复查蓝图',notes:'我审阅过的私人备注',...changes},key())

  assert.equal((await call('POST',base('/actions/from-chat',team),{source,title:'团队公开行动'},key())).status,404)
  assert.equal((await write({source:{...source,revision:1}})).status,409)
  assert.equal((await write({source:{...source,workspace_id:'f'.repeat(32)}})).status,404)
  assert.deepEqual((await call('GET',base('/actions'))).body.items,[])
  const [created,replayed] = (await Promise.all([write(),write()])).sort((a,b)=>b.status-a.status)
  assert.deepEqual([created.status,replayed.status],[201,200])
  const action = created.body.action
  assert.equal(replayed.body.action.id,action.id)
  assert.deepEqual(action.source_chat,source)
  assert.equal(action.workspace_id,WS)
  assert.equal(action.notes,'我审阅过的私人备注')
  const exact = base('/actions/'+action.id)
  assert.deepEqual((await call('GET',exact)).body.action,{...action, automation_followups:[]})
  assert.equal((await call('GET',base('/actions/'+action.id,team))).status,404)
  assert.equal((await call('GET',base('/actions'))).body.items[0].source_chat,undefined)
  accessible = false
  assert.equal((await write({source:{...source,message_id:other}})).status,404)
  const verifiedReads = reads.length
  assert.equal((await write()).body.action.id,action.id)
  assert.equal(reads.length,verifiedReads)
})

test('the native message reference keeps its agent and rejects a source outside the active workspace', async () => {
  const team = 'b'.repeat(32)
  const bot = await boot(volume(),{teams:[team]})
  const source = {kind:'agent',workspace_id:team,agent_id:'c'.repeat(32),
    conversation_id:'d'.repeat(32),message_id:'e'.repeat(32)}
  bot.features.table['agents/actionSource'] = async (payload,call) => {
    assert.equal(call.internal,true)
    assert.deepEqual(payload,source)
    return true
  }
  const head = (ref)=>bot.call('memory','POST',base('/actions/from-chat'),{source:ref,title:'跟进回复'},key())
  assert.equal((await head({...source,workspace_id:'f'.repeat(32)})).status,404)
  const saved = await head(source)
  assert.equal(saved.status,201)
  assert.deepEqual(saved.body.action.source_chat,source)
})

test('memory pages run inside this DS-Bot: create, list, edit, conflict, versions, restore, export, remove', async () => {
  const bot = await boot()
  assert.ok(bot.features.loaded.includes('memory'), JSON.stringify(bot.features.failed))
  const call = (...args) => bot.call('memory', ...args)
  const k = key()
  const created = await call('POST', base(), { title: '客户偏好', body: '喜欢简洁的周报。', topics: ['客户', '客户'] }, k)
  assert.equal(created.status, 201, JSON.stringify(created.body))
  const page = created.body.page
  assert.deepEqual(page.topics, ['客户'])
  assert.equal((await call('POST', base(), { title: '客户偏好', body: '喜欢简洁的周报。', topics: ['客户', '客户'] }, k)).status, 200)
  assert.equal((await call('POST', base(), { title: '客户偏好', body: 'x' }, key())).status, 409)
  assert.equal((await call('POST', base(), { title: '', body: 'x' }, key())).status, 400)
  const listed = await call('GET', base('?q=客户'))
  assert.equal(listed.body.items.length, 1)
  assert.equal(listed.body.items[0].preview, '喜欢简洁的周报。')
  const stale = await call('POST', base('/' + page.id), { revision: 5, changes: { body: 'y' } })
  assert.equal(stale.status, 409)
  assert.equal(stale.body.error.current.revision, 1)
  const edited = await call('POST', base('/' + page.id), { revision: 1, changes: { body: '周五发周报。' } })
  assert.equal(edited.body.page.revision, 2)
  const history = await call('GET', base(`/${page.id}/versions`))
  assert.equal(history.body.current, 2)
  assert.deepEqual(history.body.items.map((item) => item.revision), [1])
  assert.equal((await call('GET', base(`/${page.id}/versions/1`))).body.version.body, '喜欢简洁的周报。')
  const restored = await call('POST', base(`/${page.id}/versions/1/restore`), { revision: 2 })
  assert.equal(restored.body.page.revision, 3)
  assert.equal(restored.body.page.body, '喜欢简洁的周报。')
  const exported = await call('GET', base(`/${page.id}/export`))
  assert.equal(exported.status, 200)
  assert.match(exported.text, /^---\ntitle: "客户偏好"\ntopics:\n  - "客户"\nrevision: 3\n/)
  assert.equal(exported.download.filename, 'memory.md')
  assert.equal((await call('POST', base(`/${page.id}/remove`), {})).status, 200)
  assert.equal((await call('GET', base('/' + page.id))).status, 404)
})

test('every retained memory version can be paged and restored in the owning workspace', async () => {
  const team = 'b'.repeat(32)
  const bot = await boot(volume(),{teams:[team]})
  const call = (...args) => bot.call('memory', ...args)
  const created = await call('POST',base(),{title:'保留的记忆历史',body:'修订正文 1'},key())
  assert.equal(created.status,201)
  const id = created.body.page.id
  const path = base('/'+id)
  for (let revision = 1; revision < 55; revision++) {
    const edited = await call('POST',path,{revision,changes:{body:'修订正文 '+(revision+1)}})
    assert.equal(edited.status,200)
  }
  const list = async (cursor, first, count) => {
    const response = await call('GET',path+'/versions'+(cursor ? '?cursor='+cursor : ''))
    assert.equal(response.status,200)
    assert.equal(response.body.current,55)
    assert.deepEqual(response.body.items.map(item => item.revision), Array.from({length:count},(_,index) => first-index))
    return response.body.cursor
  }
  assert.equal(await list(null,54,20),35)
  assert.equal(await list(35,34,20),15)
  assert.equal(await list(15,14,9),null)
  assert.equal((await call('GET',base('/'+id+'/versions?cursor=15',team))).status,404)
  for (const query of ['?cursor=0','?cursor=','?cursor=-3','?cursor=15&cursor=20','?limit=100']) {
    assert.equal((await call('GET',path+'/versions'+query)).status,400)
  }
  assert.equal((await call('GET',path+'/versions/6?cursor=15')).status,400)
  assert.equal((await call('GET',path+'/versions/5')).status,404)
  assert.equal((await call('POST',path+'/versions/6/restore',{revision:54})).status,409)
  const restored = await call('POST',path+'/versions/6/restore',{revision:55})
  assert.equal(restored.body.page.revision,56)
  assert.equal(restored.body.page.body,'修订正文 6')
  assert.equal((await call('GET',path+'/versions/55')).body.version.body,'修订正文 55')
})

test('simultaneous edits and restores cannot replace a page from the same revision', async () => {
  const bot = await boot()
  const call = (...args) => bot.call('memory', ...args)
  const original = (await call('POST', base(), {title:'并行修订',body:'起始正文'},key())).body.page
  const path = base('/' + original.id)
  const edit = (revision, body) => call('POST', path, {revision, changes:{body}})
  async function checkRace(writes, expectedRevision) {
    const results = await Promise.all(writes)
    assert.deepEqual(results.map(result => result.status).sort(),[200,409])
    const saved = results.find(result => result.status === 200).body.page
    const conflict = results.find(result => result.status === 409).body.error
    assert.equal(saved.revision, expectedRevision)
    assert.equal(conflict.current.revision, expectedRevision)
    assert.equal(conflict.current.body,saved.body)
    assert.deepEqual((await call('GET',path)).body.page,{...saved,pinned:false})
    assert.equal((await call('GET',path+'/versions/'+expectedRevision)).body.version.body,saved.body)
  }
  await checkRace([edit(1,'正文版本一'),edit(1,'正文版本二')],2)
  await checkRace([edit(2,'并行保留的内容'),call('POST',path+'/versions/1/restore',{revision:2})],3)
})

test('做梦 proposes a duplicate-paragraph merge in DS-Bot; only accept writes the page', async () => {
  const bot = await boot()
  const call = (...args) => bot.call('memory', ...args)
  const page = (await call('POST', base(), { title: '重复', body: '第一段。\n\n第二段。\n\n第一段。\n' }, key())).body.page
  const clean = (await call('POST', base(), { title: '干净', body: '只有一段。' }, key())).body.page
  assert.equal((await call('POST', base(`/${clean.id}/dream`), {})).body.suggestion, null)
  const proposed = await call('POST', base(`/${page.id}/dream`), {})
  assert.equal(proposed.body.suggestion.status, 'open')
  assert.equal((await call('GET', base('/' + page.id))).body.page.revision, 1, 'proposing writes nothing')
  const accepted = await call('POST', base(`/${page.id}/dream/${proposed.body.suggestion.id}`), { action: 'accept' })
  assert.equal(accepted.body.suggestion.status, 'accepted')
  assert.equal(accepted.body.page.body, '第一段。\n\n第二段。\n')
  assert.equal(accepted.body.page.revision, 2)
  const readVersion = revision => call('GET', base(`/${page.id}/versions/${revision}`))
  assert.equal((await readVersion(1)).body.version.body,page.body)
  assert.equal((await readVersion(2)).body.version.body,accepted.body.page.body)
  const replay = await call('POST', base(`/${page.id}/dream/${proposed.body.suggestion.id}`), {action:'accept'})
  assert.deepEqual(replay.body.applied,accepted.body.applied)
  assert.equal(replay.body.page.revision,2)
  await call('POST',base('/'+page.id),{revision:2,changes:{body:page.body}})
  const stale = await call('POST',base(`/${page.id}/dream`),{})
  await call('POST',base('/'+page.id),{revision:3,changes:{body:'新内容。'}})
  assert.equal((await call('POST',base(`/${page.id}/dream/${stale.body.suggestion.id}`),{action:'accept'})).status,409)
  assert.equal((await call('GET',base('/'+page.id))).body.page.body,'新内容。')
})

test('memory/pages gives chat recall pages only from the selected workspace in this DS-Bot', async () => {
  const otherWorkspace = 'e'.repeat(32)
  const bot = await boot(undefined, {teams:[otherWorkspace]})
  await bot.call('memory', 'POST', base(), { title: '口味', body: '不吃辣。' }, key())
  await bot.call('memory', 'POST', base('', otherWorkspace), { title: '备忘', body: '只在另一工作区' }, key())
  const viaApi = await bot.endpoint('memory/pages', {workspace_id:WS})
  assert.equal(viaApi.ok, true)
  assert.equal(viaApi.value.length, 1)
  assert.deepEqual(Object.keys(viaApi.value[0]).sort(), ['body', 'id', 'revision', 'title', 'updated', 'workspace_id'])
  assert.equal(viaApi.value[0].title, '口味')
  const search = await bot.endpoint('memory/search', { q: '不吃辣' })
  assert.equal(search.value.items[0].kind, 'memory')
  assert.equal((await bot.endpoint('memory/pages', {})).ok, false)
  assert.equal((await bot.endpoint('memory/pages', {workspace_id:otherWorkspace})).value[0].title,'备忘')
  const other = await boot()
  assert.deepEqual((await other.endpoint('memory/pages', {workspace_id:WS})).value, [], 'another DS-Bot has none of these pages')
})

test('memory citations read exact saved revisions with current workspace access', async () => {
  const team = 'f'.repeat(32)
  const teams = [team]
  const bot = await boot(undefined, {teams})
  const call = (...args) => bot.call('memory', ...args)
  const local = (await call('POST', base(), {title:'发布笔记', body:'保留自己的发布记忆。'}, key())).body.page
  const {page} = (await call('POST', base('', team), {title:'团队发布', body:'发布地点是北京。'}, key())).body
  const path = base('/' + page.id, team)
  const {action} = (await call('POST', base('/actions', team), {title:'核对发布准备', memory_page_id:page.id}, key())).body
  const actionPath = base('/actions/' + action.id, team)
  const edited = await call('POST', path, {revision:1, changes:{body:'发布地点改到上海。'}})
  assert.equal(edited.status, 200)
  assert.equal(edited.body.page.revision, 2)
  const current = await bot.endpoint('memory/pages', {workspace_id:team})
  assert.deepEqual(current.value.map(item => [item.id,item.revision,item.body]), [[page.id,2,'发布地点改到上海。']])
  const historical = await call('GET', path + '/versions/1')
  assert.equal(historical.body.current, 2)
  assert.equal(historical.body.version.body, '发布地点是北京。')
  assert.equal((await call('GET', path + '/versions/2')).body.version.body, '发布地点改到上海。')
  assert.equal((await call('GET', path + '/versions/3')).status, 404)
  assert.equal((await call('GET', base('/' + page.id) + '/versions/1')).status, 404)
  assert.equal((await call('GET', actionPath)).body.action.id, action.id)
  assert.equal((await bot.endpoint('memory/search', {q:'发布'})).value.items.length, 2)

  teams.length = 0
  for (const target of [base('',team), path, path + '/versions', path + '/versions/1', actionPath]) {
    const result = await call('GET', target)
    assert.equal(result.status, 404)
    assert.equal(result.body.error.code, 'not_found')
  }
  assert.equal((await call('POST', path, {revision:2, changes:{body:'不应被保存。'}})).status, 404)
  assert.equal((await call('POST', path + '/remove', {})).status, 404)
  assert.equal((await bot.endpoint('memory/pages', {workspace_id:team})).ok, false)
  assert.equal((await bot.endpoint('memory/personal', {workspace_id:team})).ok, false)
  assert.deepEqual((await bot.endpoint('memory/search', {q:'发布'})).value.items.map(item => item.id), [local.id])

  teams.push(team)
  assert.equal((await call('GET', path)).body.page.body, '发布地点改到上海。')
  assert.equal((await call('POST', path + '/remove', {})).status, 200)
  assert.equal((await call('GET', path + '/versions/1')).status, 404)
  bot.features.table['teams/activeWorkspaces'] = async () => { throw new Error('Bot Social disconnected') }
  assert.equal((await call('GET', base('/' + local.id))).status, 200)
  assert.equal((await call('GET', base('/profile'))).status, 200)
  assert.deepEqual((await bot.endpoint('memory/search', {q:'发布'})).value.items.map(item => item.id), [local.id])
})

test('one test account\'s legacy memory (with history) imports into its DS-Bot only', async () => {
  const { bundles, expect } = legacyBundles(['memory'])
  const vol = volume()
  deliverBundle(vol, 'memory-1.bundle', bundles.memory)
  const bot = await boot(vol, {personal:expect.workspace_id})
  assert.deepEqual((await bot.endpoint('memory/routes')).value.imported.map((item) => item.status), ['imported'])
  const wid = expect.workspace_id
  const page = await bot.call('memory', 'GET', base('/' + expect.memory.page_id, wid))
  assert.equal(page.status, 200)
  assert.equal(page.body.page.body, expect.memory.body)
  assert.equal(page.body.page.revision, expect.memory.revision)
  assert.equal(page.body.page.created_by, 'alice')
  assert.deepEqual(page.body.page.topics, ['客户'])
  const history = await bot.call('memory', 'GET', base(`/${expect.memory.page_id}/versions`, wid))
  assert.deepEqual(history.body.items.map((item) => item.revision), [1])
  const titles = (await bot.endpoint('memory/pages', {workspace_id:wid})).value.map((item) => item.title)
  assert.deepEqual(titles, [expect.memory.title])
  const edited = await bot.call('memory', 'POST', base('/' + expect.memory.page_id, wid), { revision: 2, changes: { body: '改成周四发。' } })
  assert.equal(edited.body.page.updated_by, 'alice', 'new edits are attributed to the imported owner')
})
