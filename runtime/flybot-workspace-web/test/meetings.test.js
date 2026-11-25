import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { boot, bootMemory, deliverBundle, key, legacyBundles, volume, WS } from './helpers.js'
import { attachRuntime, detachRuntime } from '../src/host.js'
import { setSharedBotSocial } from '../lib/c/bot-social.js'
import { digest } from '../featurekit/http.js'
import { openStore } from '../featurekit/store.js'
import {waveBase64} from '../../../flybot_workspace/static/meetings/audio.mjs'

const base = (id = '', ws = WS) => `/v1/workspaces/${ws}/meetings${id ? '/' + id : ''}`
const body = { title: '周会', attendees: ['alice', 'bob'], summary: '同步进度。', transcript: '讨论排期。', action_items: [{ text: '订会议室', owner: 'bob' }] }

test('reviewed local meeting actions copy once to personal Memory with a saved reference', async () => {
  const team = 'b'.repeat(32)
  const bot = await bootMemory(volume(), {teams:[team]})
  const target = `/v1/workspaces/${WS}/memory/actions`
  const create = await bot.call('meetings','POST',base('',team), {...body,
    action_items:[{...body.action_items[0],due_date:'2030-01-17'}, {text:'已完成',done:true}]}, key())
  assert.equal(create.status,201)
  const {id,revision} = create.body.meeting
  const reference = {workspace_id:team,meeting_id:id,action_index:0,revision}
  const reviewed = {title:'个人复核会议室',notes:'先确认时间',due_at:Date.parse('2030-01-18')/1000,source:reference}
  const copy = (payload = reviewed, path = target) => bot.call('memory','POST',path+'/from-meeting',payload,key())
  assert.equal((await copy({...reviewed,source:{...reference,action_index:1}})).status,409)
  assert.equal((await copy(reviewed, `/v1/workspaces/${team}/memory/actions`)).status,404)
  assert.equal((await copy({...reviewed,due_at:'2030-01-18'})).status,400)
  const stored = await copy()
  assert.equal(stored.status,201)
  const action = stored.body.action
  const resolveSource = () => bot.call('memory','GET',target+'/'+action.id+'/meeting-source')
  assert.deepEqual(action.source,{kind:'meeting',...reference})
  assert.deepEqual((await resolveSource()).body, {source:reference})
  assert.equal(action.title,reviewed.title)
  assert.equal(action.due_at,reviewed.due_at)
  assert.doesNotMatch(JSON.stringify(action),/讨论排期|同步进度|订会议室/)
  const extra = await copy({...reviewed,notes:'不应覆盖第一次保存'})
  assert.equal(extra.status,200)
  assert.deepEqual(extra.body.action,action)
  const edit = await bot.call('meetings','POST',base(id,team),{revision,changes:{summary:'更改摘要'}})
  assert.equal(edit.status,200)
  assert.equal((await copy()).body.error.code,'source_changed')
  const current = {...reviewed,source:{...reference,revision:edit.body.meeting.revision}}
  assert.equal((await copy(current)).body.action.id,action.id)
  assert.equal((await bot.call('memory','GET', target)).body.items.length,1)
  assert.deepEqual((await bot.call('memory','GET', target+'/'+action.id)).body.action.source, action.source)

  const [original, other] = edit.body.meeting.action_items
  const reordered = await bot.call('meetings','POST',base(id,team),{
    revision:edit.body.meeting.revision, changes:{action_items:[other, {...original, done:true}]},
  })
  assert.equal(reordered.status,200)
  assert.deepEqual((await resolveSource()).body, {source:{
    workspace_id:team, meeting_id:id, revision:reordered.body.meeting.revision, action_index:1,
  }})
  const ambiguous = await bot.call('meetings','POST',base(id,team),{
    revision:reordered.body.meeting.revision, changes:{action_items:[original, other, original]},
  })
  assert.equal(ambiguous.status,200)
  assert.deepEqual((await resolveSource()).body, {source:{
    workspace_id:team, meeting_id:id, revision:ambiguous.body.meeting.revision,
  }})
  bot.features.table['teams/activeWorkspaces'] = async () => []
  assert.equal((await copy(current)).status,404)
  assert.equal((await resolveSource()).status,404)
  assert.equal((await bot.call('memory','POST', target+'/'+action.id+'/remove',{})).status,200)
  assert.equal((await bot.call('memory','GET', target+'/'+action.id)).status,404)
})

test('meeting catalogue searches saved transcript passages with bounded private excerpts and normal paging', async () => {
  const bot = await boot()
  const term = 'Build [4.2]'
  const transcript = 'unrelated preface ' + '背景。'.repeat(40) + term + '，这周发布。' + '尾部。'.repeat(40)
  const create = (title, started_at, workspace = WS) => bot.call('meetings', 'POST', base('', workspace),
    {...body, title, started_at, transcript}, key())
  const latest = (await create('发布讨论', 200)).body.meeting
  const older = (await create('之前的讨论', 100)).body.meeting
  const otherWorkspace = 'b'.repeat(32)
  await create('另一工作区', 300, otherWorkspace)
  const query = new URLSearchParams({q:'build [4.2]', order:'recent', limit:'1'})
  const first = (await bot.call('meetings', 'GET', base() + '?' + query)).body
  assert.equal(first.items.length, 1)
  assert.equal(first.items[0].id, latest.id)
  const {before, match, after} = first.items[0].transcript_match
  assert.equal(match, term)
  assert.ok(before.startsWith('…') && before.length <= 43)
  assert.ok(after.startsWith('，这周发布。') && after.length <= 43)
  assert.equal(first.items[0].transcript, undefined)
  assert.equal(first.items[0].summary, undefined)
  assert.equal(first.cursor, latest.id)
  query.set('cursor', first.cursor)
  const second = (await bot.call('meetings', 'GET', base() + '?' + query)).body
  assert.deepEqual(second.items.map(row => row.id), [older.id])
  assert.equal(second.cursor, null)
  const ordinary = (await bot.call('meetings', 'GET', base())).body
  assert.ok(ordinary.items.every(row => row.transcript_match === undefined && row.transcript === undefined))
  const summarySearch = (await bot.call('meetings', 'GET', base() + '?q=' + encodeURIComponent(body.summary))).body
  assert.equal(summarySearch.items.length, 2)
  assert.ok(summarySearch.items.every(row => row.transcript_match === undefined))
})

test('calendar deadlines survive the saved action, list search, completion and Markdown export', async () => {
  const bot = await boot()
  const due_date = '2032-02-29'
  const action = {text:'核对日程', owner:'bob', due_date}
  const create = due_date => bot.call('meetings','POST',base(), {...body, action_items:[{...action,due_date}]},key())
  for (const invalid of ['2031-02-29', '2032-2-29', '2032-02-29T12:00', '0000-01-01', 1961625600]) {
    assert.equal((await create(invalid)).status, 400)
  }
  const saved = await create(due_date)
  assert.equal(saved.status, 201)
  const {meeting} = saved.body
  const path = base(meeting.id)
  const inbox = await bot.call('meetings','GET',base() + '?view=actions')
  assert.equal(inbox.body.items[0].due_date,due_date)
  const search = await bot.call('meetings','GET',base() + '?q=' + due_date)
  assert.deepEqual(search.body.items.map(item=>item.id),[meeting.id])
  const receipt = await bot.call('meetings','GET',path + '/action?index=0&revision=1')
  assert.deepEqual(receipt.body.action,{...action,done:false})
  assert.equal((await bot.call('meetings','POST',path + '/action',{index:0,revision:1})).status,200)
  const completed = await bot.call('meetings','GET',path)
  assert.deepEqual(completed.body.meeting.action_items,[{...action,done:true}])
  const exported = await bot.call('meetings','GET',path + '/export')
  assert.match(exported.text, /\[x\] 核对日程（bob · 截止日期 2032-02-29）/)
})

test('action inbox pages each status and toggles only an exact workspace revision', async () => {
  const bot = await boot()
  const own = 'Alice'
  const {meeting} = (await bot.call('meetings','POST',base(),{...body,started_at:100,
    action_items:[{text:'open own',owner:own},{text:'open other',owner:'bob'},{text:'closed item',done:true}]},key())).body
  const other = 'b'.repeat(32)
  await bot.call('meetings','POST',base('',other),{...body,title:'Other meeting',action_items:[{text:'other workspace only'}]},key())
  const list = base()+'?view=actions&limit=1'
  const first = await bot.call('meetings','GET',list)
  assert.equal(first.status,200)
  assert.equal(first.body.items[0].text,'open own')
  assert.ok(first.body.cursor)
  assert.equal(first.body.items[0].summary,undefined)
  assert.equal(first.body.items[0].transcript,undefined)
  const second = await bot.call('meetings','GET',list+'&cursor='+encodeURIComponent(first.body.cursor))
  assert.equal(second.body.items[0].text,'open other')
  assert.equal(second.body.cursor,null)
  assert.equal((await bot.call('meetings','GET',list+'&cursor=wrong')).status,400)
  const exact = base(meeting.id)+'/action'
  const wrong = await bot.call('meetings','POST',base(meeting.id,other)+'/action',{index:0,revision:1})
  assert.equal(wrong.status,404)
  const complete = await bot.call('meetings','POST',exact,{index:0,revision:1})
  assert.equal(complete.status,200)
  assert.deepEqual(complete.body.action,{index:0,done:true})
  assert.equal((await bot.call('meetings','POST',exact,{index:1,revision:1})).status,409)
  const saved = (await bot.call('meetings','GET',base(meeting.id))).body.meeting
  assert.equal(saved.summary,body.summary)
  assert.deepEqual(saved.action_items.map(item=>item.done),[true,false,true])
  const remaining = (await bot.call('meetings','GET',list)).body
  assert.equal(remaining.items[0].text,'open other')
  assert.notEqual(remaining.activity_version,first.body.activity_version)

  const done = list + '&status=completed'
  const completed = await bot.call('meetings','GET',done)
  assert.equal(completed.status,200)
  assert.equal(completed.body.items[0].text,'open own')
  const otherCompleted = await bot.call('meetings','GET',done + '&cursor=' + completed.body.cursor)
  assert.equal(otherCompleted.body.items[0].text,'closed item')
  assert.equal(otherCompleted.body.cursor,null)
  assert.equal((await bot.call('meetings','GET',done + '&status=open')).status,400)
  assert.equal((await bot.call('meetings','GET',list + '&status=all')).status,400)
  assert.equal((await bot.call('meetings','POST',exact,{index:0,revision:2,done:'false'})).status,400)
  assert.equal((await bot.call('meetings','POST',exact,{index:0,revision:1,done:false})).status,409)
  assert.equal((await bot.call('meetings','POST',base(meeting.id,other)+'/action',{index:0,revision:2,done:false})).status,404)
  const reopen = await bot.call('meetings','POST',exact,{index:0,revision:2,done:false})
  assert.equal(reopen.status,200)
  assert.equal(reopen.body.meeting.revision,3)
  assert.deepEqual(reopen.body.action,{index:0,done:false})
  assert.equal((await bot.call('meetings','POST',exact,{index:0,revision:3,done:false})).status,409)
  assert.equal((await bot.call('meetings','GET',list)).body.items[0].text,'open own')
  assert.equal((await bot.call('meetings','GET',done)).body.items[0].text,'closed item')
  const reopened = await bot.call('meetings','GET',exact + '?index=0&revision=3')
  assert.equal(reopened.status,200)
  assert.deepEqual(reopened.body.action,{text:'open own',owner:own,done:false})
})

test('one scoped meeting memory keeps provenance and preserves separate edits across repeated copies', async () => {
  const bot = await bootMemory()
  const {meeting} = (await bot.call('meetings', 'POST', base(), {
    ...body, action_items:[{...body.action_items[0], due_date:'2032-02-29'}],
  }, key())).body
  const route = base(meeting.id) + '/memory'
  const copy = revision => bot.call('meetings', 'POST', route, {revision})
  const revise = (revision, changes) => bot.call('meetings', 'POST', base(meeting.id), {revision, changes})
  const [first, again] = await Promise.all([copy(1), copy(1)])
  assert.deepEqual([first.status, again.status].sort(), [200, 201])
  const {id} = first.body.memory
  assert.equal(again.body.memory.id, id)
  const target = '/v1/workspaces/' + WS + '/memory/' + id
  const read = async () => (await bot.call('memory', 'GET', target)).body.page
  const initial = await read()
  assert.match(initial.body, /同步进度。[\s\S]+订会议室（bob · 截止日期 2032-02-29）/)
  assert.ok(!initial.body.includes(body.transcript))
  assert.deepEqual(initial.source, {kind:'meeting', meeting_id:meeting.id, meeting_revision:1})
  assert.equal((await bot.call('meetings', 'POST', base(meeting.id, 'b'.repeat(32)) + '/memory', {revision:1})).status, 404)
  assert.equal((await bot.endpoint('memory/saveMeetingNote', {})).ok, false)
  await revise(1, {summary:'决定在下周发布。'})
  assert.equal((await copy(1)).status, 409)
  assert.deepEqual((await copy(2)).body, {memory:{id, workspace_id:WS}, state:'updated', truncated:false})
  const refreshed = await read()
  assert.equal(refreshed.revision, 2)
  assert.equal(refreshed.source.meeting_revision, 2)
  assert.match(refreshed.body, /决定在下周发布/)
  const versions = await bot.call('memory', 'GET', target + '/versions')
  assert.deepEqual(versions.body.items.map(item => item.revision), [1])
  await bot.call('memory', 'POST', target, {revision:2,changes:{body:'记忆页自己的备注。'}})
  await revise(2, {summary:'修改了会议，保留记忆页自己的备注。'})
  assert.equal((await copy(3)).body.state, 'edited')
  assert.equal((await read()).body, '记忆页自己的备注。')
  await bot.call('memory', 'POST', target + '/remove', {})
  assert.equal((await copy(3)).status, 201)
})

test('large meeting minutes retain useful summaries and actionable excerpts inside the memory limit', async () => {
  const bot = await bootMemory()
  const title = '听'.repeat(79) + '😀会议'
  const {meeting} = (await bot.call('meetings', 'POST', base(), {
    title, summary:'😀'.repeat(4000), action_items:Array.from({length:50}, (_, i) => ({
      text:'任务 ' + i + ' ' + '继续'.repeat(240),
    })),
  }, key())).body
  const result = await bot.call('meetings', 'POST', base(meeting.id) + '/memory', {revision:1})
  assert.equal(result.status, 201)
  assert.equal(result.body.truncated, true)
  const path = '/v1/workspaces/' + WS + '/memory/' + result.body.memory.id
  const page = (await bot.call('memory', 'GET', path)).body.page
  assert.ok(page.title.length <= 80 && page.body.length <= 8000 && !page.body.includes('\ufffd'))
  assert.match(page.body, /任务 49/)
  assert.match(page.body, /完整纪要请从来源链接查看/)
})

test('meetings feature loads in this DS-Bot and keeps its data in its own feature directory', async () => {
  const bot = await boot()
  assert.ok(bot.features.loaded.includes('meetings'), JSON.stringify(bot.features.failed))
  assert.ok(existsSync(join(bot.vol.data, 'flybot-workspace', 'features', 'meetings', 'meetings.sqlite3')))
  const routes = await bot.endpoint('meetings/routes')
  assert.equal(routes.ok, true)
  assert.ok(routes.value.routes.every((source) => source.startsWith('^\\/v1\\/workspaces')))
})

test('meetings run inside this DS-Bot: create, idempotent replay, list, read, update, export, remove', async () => {
  const bot = await boot()
  const call = (...args) => bot.call('meetings', ...args)
  const k = key()
  const created = await call('POST', base(), body, k)
  assert.equal(created.status, 201, JSON.stringify(created.body))
  const meeting = created.body.meeting
  assert.equal(meeting.action_count, 1)
  assert.equal(meeting.done_count, 0)
  assert.equal((await call('POST', base(), body, k)).status, 200)
  assert.equal((await call('POST', base(), { ...body, title: '另一个' }, k)).status, 409)
  assert.equal((await call('POST', base(), body, key())).status, 409, 'duplicate title')
  assert.equal((await call('POST', base(), body)).status, 400, 'idempotency key required')
  assert.equal((await call('POST', base(), { ...body, title: '' }, key())).status, 400)

  const listed = await call('GET', base() + '?limit=20')
  assert.equal(listed.status, 200)
  assert.equal(listed.body.items.length, 1)
  assert.equal(listed.body.items[0].transcript, undefined)
  assert.equal((await call('GET', base() + '?bogus=1')).status, 400)
  assert.equal((await call('GET', base(meeting.id))).body.meeting.transcript, '讨论排期。')

  const stale = await call('POST', base(meeting.id), { revision: 9, changes: { summary: 'x' } })
  assert.equal(stale.status, 409)
  assert.equal(stale.body.error.current.revision, 1)
  const updated = await call('POST', base(meeting.id), { revision: 1, changes: { action_items: [{ text: '订会议室', owner: 'bob', done: true }] } })
  assert.equal(updated.status, 200)
  assert.equal(updated.body.meeting.revision, 2)
  assert.equal(updated.body.meeting.done_count, 1)

  const exported = await call('GET', base(meeting.id) + '/export')
  assert.equal(exported.status, 200)
  assert.match(exported.download.content_type, /text\/markdown/)
  assert.equal(exported.download.filename, `meeting-${meeting.id}.md`)
  assert.match(exported.text, /^# 周会/)
  assert.match(exported.text, /- \[x\] 订会议室（bob）/)

  const remove = base(meeting.id) + '/remove'
  assert.equal((await call('POST', remove, {})).status, 400)
  assert.equal((await call('POST', remove, {revision:1})).status, 409)
  assert.equal((await call('GET', base(meeting.id))).body.meeting.revision, 2)
  const removed = await call('POST', remove, {revision:2})
  assert.equal(removed.status, 200)
  assert.equal(removed.body.removed.revision, 2)
  assert.equal((await call('GET', base(meeting.id))).status, 404)
})

test('concurrent edits cannot share a meeting revision', async () => {
  const bot = await boot()
  const {body:{meeting}} = await bot.call('meetings', 'POST', base(), body, key())
  const path = base(meeting.id)
  const edits = await Promise.all(['first edit', 'second edit'].map(summary =>
    bot.call('meetings', 'POST', path, {revision:meeting.revision, changes:{summary}})))
  assert.deepEqual(edits.map(edit => edit.status).sort(), [200, 409])
  const saved = edits.find(edit => edit.status === 200).body.meeting
  assert.equal(saved.revision, meeting.revision + 1)
  assert.deepEqual((await bot.call('meetings', 'GET', path)).body.meeting, saved)
})

test('meeting creation replays an omitted start time across clock changes', async t => {
  const bot = await boot()
  const call = (...args) => bot.call('meetings', ...args)
  const startedAt = 1795212000
  let now = startedAt * 1000
  t.mock.method(Date, 'now', () => now)
  const k = key()
  const saved = await call('POST', base(), body, k)
  assert.equal(saved.status, 201)
  assert.equal(saved.body.meeting.started_at, startedAt)

  now += 2000
  assert.deepEqual(await call('POST', base(), body, k), {status: 200, body: saved.body})
  assert.deepEqual(await call('POST', base(), {...body, started_at: null}, k), {status: 200, body: saved.body})
  assert.equal((await call('POST', base(), {...body, started_at: startedAt}, k)).status, 409)
  assert.equal((await call('POST', base(), {...body, transcript: '更新后的正文'}, k)).status, 409)
  assert.equal((await call('GET', base())).body.items.length, 1)
})

test('meeting creation recognizes the original fingerprint of older saved meetings after editing the start time', async t => {
  const bot = await boot()
  const call = (...args) => bot.call('meetings', ...args)
  const startedAt = 1795212000
  let now = startedAt * 1000
  t.mock.method(Date, 'now', () => now)
  const k = key()
  // An explicit time equal to creation time yields the fingerprint stored by an older implicit save.
  const request = {...body, started_at: startedAt}
  const saved = await call('POST', base(), request, k)
  assert.equal(saved.status, 201)
  now += 2000
  const edited = await call('POST', base(saved.body.meeting.id), {revision: 1, changes: {started_at: startedAt + 60}})
  assert.equal(edited.status, 200)
  assert.deepEqual(await call('POST', base(), body, k), edited)
  assert.deepEqual(await call('POST', base(), request, k), edited)
  assert.equal((await call('POST', base(), {...request, started_at: startedAt + 60}, k)).status, 409)
  assert.equal((await call('POST', base(), {...body, transcript: '更新后的正文'}, k)).status, 409)
})

test('only an authorized finished call can prefill and associate a personal meeting draft', async t => {
  const bot = await boot()
  const installBinding = runtime => {
    runtime.features.table['agents/personal-binding'] = async () => ({workspace_id:WS})
    runtime.features.table['teams/activeWorkspaces'] = async () => []
  }
  installBinding(bot)
  const id = 'otcav_' + 'A'.repeat(26)
  const sourcePath = base('from-call/' + id)
  const source = {id, title:'Discussion', kind:'video', started_at:1795212000123, ended_at:1795212200123,
    attendees:['Alex','  Morgan  ','alex']}
  const reads = []
  const shares = []
  let relay = 'social/meeting_call_active'
  setSharedBotSocial({async request(method, path, payload) {
    if (method === 'POST' && path === '/v1/ot/meeting-shares') {
      shares.push(payload)
      return {meeting: {id:'c'.repeat(32)}}
    }
    assert.equal(method,'GET')
    reads.push(path)
    assert.equal(path,'/v1/ot/call-records/' + id)
    if (relay) throw Object.assign(new Error('fixture'), {code:relay,
      status:relay === 'social/meeting_call_active' ? 409 : 404})
    return {record:source}
  }})
  t.after(() => setSharedBotSocial(undefined))
  const call = (method, ...args) => bot.call('meetings', method, ...args)
  assert.equal((await call('GET', sourcePath.replace(WS, 'b'.repeat(32)))).status, 404)
  assert.equal(reads.length, 0)
  const active = await call('GET', sourcePath)
  assert.equal(active.status, 409)
  assert.equal(active.body.error.code, 'meeting_call_active')
  assert.equal((await call('POST', base(), {source_call_id:id}, key())).status, 409)
  relay = 'social/call_record_not_found'
  assert.equal((await call('GET', sourcePath)).status, 404)
  assert.equal((await call('POST', base(), {source_call_id:id}, key())).status, 404)
  relay = null
  const gateway = new Request('http://fixture', {headers:{'x-ot-owner-username':'fixture-user'}})
  const result = await bot.features.table['meetings/v1']({method:'GET',path:sourcePath}, {request:gateway})
  assert.deepEqual(result.body, {workspace_id:WS, viewer_username:'fixture-user', source:{
    id, title:'Discussion', kind:'video', started_at:1795212000, ended_at:1795212200, attendees:['Alex','Morgan'],
  }})
  assert.deepEqual((await call('GET', base())).body.items, [])

  const draft = {source_call_id:id, title:'My notes', summary:'A summary added in this DS-Bot'}
  const saveKey = key()
  const saved = await call('POST', base(), draft, saveKey)
  assert.equal(saved.status,201)
  const meeting = saved.body.meeting
  assert.equal(meeting.source_call_id,id)
  assert.equal(meeting.started_at,1795212000)
  assert.deepEqual(meeting.attendees,['Alex','Morgan'])
  assert.equal(meeting.transcript,'')
  assert.deepEqual((await call('POST', base(), draft, saveKey)).body.meeting, meeting)
  const duplicate = await call('POST', base(), {...draft,title:'Another copy'}, key())
  assert.equal(duplicate.status,409)
  assert.equal(duplicate.body.error.code,'meeting_exists')
  assert.equal(duplicate.body.error.current.id,meeting.id)
  assert.equal((await call('POST', base(meeting.id), {revision:1,changes:{source_call_id:null}})).status,400)
  const edited = await call('POST', base(meeting.id), {revision:1,changes:{title:'Edited notes'}})
  assert.equal(edited.body.meeting.source_call_id,id)
  const sharePath = base(meeting.id + '/shares')
  const selected = {call_id:id,revision:2,recipient_ids:['fixture-attendee']}
  assert.equal((await call('POST',sharePath,{...selected,call_id:'otcav_'+'B'.repeat(26)},key())).status,404)
  assert.equal((await call('POST',sharePath,{...selected,conversation_id:'wrong-recipient-mode'},key())).status,400)
  assert.equal((await call('POST',sharePath,{...selected,revision:1},key())).status,409)
  assert.deepEqual(shares,[])
  const shareKey = key()
  assert.equal((await call('POST',sharePath,selected,shareKey)).status,201)
  assert.deepEqual(shares,[{title:edited.body.meeting.title, started_at:meeting.started_at, summary:meeting.summary,
    action_items:[], source_id:meeting.id, client_key:shareKey, ...selected}])
  const restarted = await boot(bot.vol)
  installBinding(restarted)
  assert.deepEqual((await restarted.call('meetings','GET',sourcePath)).body.meeting,edited.body.meeting)
  assert.equal((await restarted.call('meetings','GET',base())).body.items[0].source_call_id,id)
  const second = await boot()
  installBinding(second)
  assert.equal((await second.call('meetings','GET',sourcePath)).body.meeting,undefined)
})

test('different calls can keep their shared title without duplicating a saved call', async t => {
  const vol = volume()
  const firstRuntime = await bootMemory(vol)
  const title = 'Weekly review'
  const firstCall = 'otcav_' + 'A'.repeat(26)
  const secondCall = 'otcav_' + 'B'.repeat(26)
  const records = new Map([
    [firstCall, 1700000000],
    [secondCall, 1700604800],
  ])
  setSharedBotSocial({async request(method,path) {
    assert.equal(method,'GET')
    const id = path.replace('/v1/ot/call-records/','')
    assert.ok(records.has(id))
    const started = records.get(id)
    return {record:{id, kind:'video', title, started_at:started*1000, ended_at:(started+1000)*1000, attendees:['Alex']}}
  }})
  t.after(() => setSharedBotSocial(undefined))

  const firstDraft = {source_call_id:firstCall, summary:'First call notes'}
  const firstKey = key()
  const first = await firstRuntime.call('meetings','POST',base(),firstDraft,firstKey)
  assert.equal(first.status,201)
  // Simulate a call note already written by the old runtime before this migration.
  const store = openStore(join(vol.data,'flybot-workspace','features','meetings','meetings.sqlite3'))
  store.transaction(db => {
    db.run("DELETE FROM ot_feature_migrations WHERE feature='meetings' AND version=5")
    db.run('UPDATE meetings SET title_hash=? WHERE id=?',digest(title.toLowerCase()),first.body.meeting.id)
  })
  store.close()

  const runtime = await bootMemory(vol)
  const call = (method,path,payload,requestKey) => runtime.call('meetings',method,path,payload,requestKey)
  const secondDraft = {source_call_id:secondCall, summary:'Second call notes'}
  const secondKey = key()
  const second = await call('POST',base(),secondDraft,secondKey)
  assert.equal(second.status,201,JSON.stringify(second.body))
  assert.notEqual(first.body.meeting.id,second.body.meeting.id)
  assert.equal(second.body.meeting.title,title)
  assert.equal(second.body.meeting.started_at,records.get(secondCall))
  assert.deepEqual((await call('POST',base(),firstDraft,firstKey)).body.meeting,first.body.meeting)
  assert.deepEqual((await call('POST',base(),secondDraft,secondKey)).body.meeting,second.body.meeting)
  const duplicate = await call('POST',base(),{...secondDraft,title:'Another title'},key())
  assert.equal(duplicate.status,409)
  assert.equal(duplicate.body.error.code,'meeting_exists')
  assert.equal(duplicate.body.error.current.id,second.body.meeting.id)
  assert.deepEqual((await call('GET',base('from-call/'+firstCall))).body.meeting,first.body.meeting)
  assert.deepEqual((await call('GET',base('from-call/'+secondCall))).body.meeting,second.body.meeting)

  const manual = {title, summary:'Manual meeting notes'}
  assert.equal((await call('POST',base(),manual,key())).status,201)
  assert.equal((await call('POST',base(),manual,key())).status,409)
  const renamed = await call('POST',base(first.body.meeting.id),{revision:1,changes:{title:'Planning'}})
  assert.equal(renamed.status,200)
  const sameTitleAgain = await call('POST',base(first.body.meeting.id), {revision:2,changes:{title}})
  assert.equal(sameTitleAgain.status,200)
  assert.equal(sameTitleAgain.body.meeting.source_call_id,firstCall)
})

test('meeting list filters all saved metadata before paging in start-time order', async () => {
  const bot = await boot()
  const otherWorkspace = 'b'.repeat(32)
  const add = async (index, props = {}, workspace = WS) => {
    const saved = await bot.call('meetings', 'POST', base('', workspace), {
      title: '会议 ' + index, started_at: 1000 + index, transcript: '仅正文出现的词',
      action_items: [{text:'行动', done:true}], ...props,
    }, key())
    assert.equal(saved.status, 201)
    return saved.body.meeting.id
  }
  const old = await add(1, {summary:'含有 ÄPFEL % 总结', action_items:[{text:'旧行动项',owner:'Ravi'}]})
  const tie = await add(1, {title:'同时间项目'})
  const other = await add(2, {summary:'Äpfel'}, otherWorkspace)
  const newer = await Promise.all(Array.from({length:23}, (_, i) => add(i + 3)))
  const list = query => bot.call('meetings', 'GET', base() + '?' + query)
  const ids = result => result.body.items.map(item => item.id)
  const first = await list('limit=20&order=recent')
  assert.deepEqual(ids(first), newer.toReversed().slice(0,20))
  assert.equal(first.body.cursor, ids(first).at(-1))
  const rest = await list('limit=20&order=recent&cursor=' + first.body.cursor)
  assert.deepEqual(ids(rest), [...newer.slice(0,3).reverse(), ...[tie,old].sort()])
  assert.equal(rest.body.cursor, null)
  assert.equal(rest.body.activity_version, first.body.activity_version)
  assert.ok([...first.body.items,...rest.body.items].every(item => !('summary' in item) && !('transcript' in item)))
  assert.deepEqual(ids(await list('order=recent&open=1')), [old])
  assert.deepEqual(ids(await list('order=recent&open=1&q=' + encodeURIComponent('äpfel %'))), [old])
  assert.deepEqual(ids(await list('q=ravi')), [old])
  assert.deepEqual(ids(await list('order=recent&open=1&q=' + encodeURIComponent('仅正文出现的词'))), [old])
  assert.deepEqual(ids(await list('q=' + encodeURIComponent('未出现的词'))), [])
  assert.deepEqual(ids(await list('order=recent&cursor=' + other)), [])
  for (const query of ['order=wrong','open=0','open=1&open=1','q=' + 'a'.repeat(81)]) {
    assert.equal((await list(query)).status, 400)
  }
  assert.equal((await bot.call('meetings', 'POST', base(old), {
    revision:1, changes:{started_at:10100},
  })).status, 200)
  const changed = await list('order=recent&limit=1')
  assert.deepEqual(ids(changed), [old])
  assert.notEqual(changed.body.activity_version, first.body.activity_version)
})

test('saved meeting actions and Space copies validate scope and revision without returning transcript', async () => {
  const bot = await boot()
  const call = (...args) => bot.call('meetings', ...args)
  const created = await call('POST', base(), body, key())
  const meeting = created.body.meeting
  const path = base(meeting.id)
  const actionPath = path + '/action?index=0&revision=1'
  const artifactsPath = `/v1/workspaces/${WS}/artifacts`
  const action = await call('GET', actionPath)
  assert.equal(action.status, 200)
  assert.deepEqual(action.body, {
    meeting: {id:meeting.id,workspace_id:WS,title:body.title,revision:1},
    action:{text:'订会议室',owner:'bob',done:false},
  })
  assert.equal((await call('GET', path + '/action?index=1&revision=1')).status, 404)
  assert.equal((await call('GET', path + '/action?index=0&revision=1&revision=2')).status, 400)
  assert.equal((await call('POST', path + '/action', {})).status, 400)
  assert.equal((await call('GET', base(meeting.id,'b'.repeat(32)) + '/action?index=0&revision=1')).status, 404)
  assert.equal((await call('POST', base(meeting.id,'b'.repeat(32)) + '/artifact', {revision:1})).status, 404)
  assert.equal((await call('POST', path + '/artifact', {revision:2})).status, 409)
  assert.equal((await call('POST', path + '/artifact', {revision:1,body:'unexpected text'})).status, 400)
  assert.equal((await call('GET', path + '/artifact')).status, 405)
  const outside = await bot.endpoint('artifacts/saveMeetingNote', {workspace_id:WS,meeting_id:meeting.id,revision:1,title:'不应创建',body:'not a note'})
  assert.equal(outside.ok, false)
  assert.equal((await bot.call('artifacts','GET',artifactsPath)).body.items.length, 0)

  // Existing content with the preferred title must remain independent.
  const preexisting = await bot.call('artifacts','POST',artifactsPath,{title:'周会 · 纪要 v1',body:'其他文档'},key())
  assert.equal(preexisting.status, 201)
  const archived = await call('POST', path + '/artifact', {revision:1})
  assert.equal(archived.status, 201)
  const saved = archived.body.artifact
  assert.notEqual(saved.id, preexisting.body.artifact.id)
  assert.equal(saved.workspace_id, WS)
  assert.match(saved.body,/同步进度。/)
  assert.match(saved.body,/- \[ \] 订会议室（bob）/)
  assert.doesNotMatch(saved.body,/讨论排期。/)
  const edit = await bot.call('artifacts','POST', artifactsPath + '/' + saved.id, {
    revision:1,changes:{title:'我重命名的纪要',body:'我已经编辑了这一份。'},
  })
  assert.equal(edit.status, 200)
  const replay = await call('POST', path + '/artifact', {revision:1})
  assert.equal(replay.status, 200)
  assert.equal(replay.body.artifact.id, saved.id)
  assert.equal(replay.body.artifact.body, '我已经编辑了这一份。')
  const changed = await call('POST', path, {revision:1, changes:{action_items:[{text:'订会议室',owner:'bob',done:true}]}})
  assert.equal(changed.status, 200)
  assert.equal((await call('GET', actionPath)).status, 409)
  assert.equal((await call('GET', path + '/action?index=0&revision=2')).status, 409)
  assert.equal((await call('POST', path + '/artifact', {revision:1})).status, 409)
  const second = await call('POST', path + '/artifact', {revision:2})
  assert.equal(second.status, 201)
  assert.notEqual(second.body.artifact.id, saved.id)
  assert.match(second.body.artifact.body,/- \[x\] 订会议室（bob）/)
  const long = await call('POST', base(), {title:'长纪要',summary:'字'.repeat(8000)}, key())
  assert.equal(long.status, 201)
  const rejected = await call('POST', base(long.body.meeting.id) + '/artifact', {revision:1})
  assert.equal(rejected.status, 413)
  assert.match(rejected.body.error.message,/导出 Markdown/)
  assert.equal((await bot.call('artifacts','GET',artifactsPath)).body.items.length, 3)
  const foreign = await boot()
  assert.equal((await foreign.call('meetings','GET',actionPath)).status, 404)
  assert.equal((await foreign.call('artifacts','GET',artifactsPath)).body.items.length, 0)
})

test('meeting shares publish only the saved summary and action items through the selected workspace', async t => {
  const bot = await boot()
  const call = (method, path, payload, sendKey) => bot.call('meetings',method,base(path),payload,sendKey)
  const created = await call('POST','',body,key())
  const meeting = created.body.meeting
  const receiptId = 'd'.repeat(32)
  const receipt = {id:receiptId,title:meeting.title,revision:1,started_at:meeting.started_at,
    organizer:'组织者',summary:body.summary,action_items:[{...body.action_items[0],done:false}],shared:true}
  const calls = []
  let sent = false
  setSharedBotSocial({async request(method,path,input) {
    calls.push({method,path,input})
    if (path.includes('/meeting-share-recipients')) return {items:[{id:'recipient-a',name:'参会人'}]}
    if (path.endsWith('/revoke')) return {revoked:true}
    if (method === 'POST') {
      const replayed = sent
      sent = true
      return {meeting:receipt,replayed}
    }
    if (path.endsWith(receiptId)) return {meeting:receipt}
    return {items:[receipt],cursor:null}
  }})
  t.after(() => setSharedBotSocial(undefined))
  const path = `${meeting.id}/shares`
  const recipients = {revision:1,conversation_id:'otc_group',recipient_ids:['recipient-a']}
  const shareKey = key()
  assert.equal((await call('POST',path,{...recipients,transcript:'never send this'},shareKey)).status,400)
  assert.equal((await call('POST',path,{...recipients,revision:2},shareKey)).status,409)
  assert.equal((await bot.call('meetings','POST',base(path,'b'.repeat(32)),recipients,shareKey)).status,404)
  assert.equal(calls.length,0)
  assert.deepEqual((await call('GET','share-recipients?conversation_id=otc_group')).body.items,[{id:'recipient-a',name:'参会人'}])
  assert.equal(calls.at(-1).path,`/v1/ot/workspaces/${WS}/meeting-share-recipients?conversation_id=otc_group`)
  assert.equal((await call('POST',path,recipients,shareKey)).status,201)
  assert.deepEqual(calls.at(-1),{method:'POST',path:`/v1/ot/workspaces/${WS}/meeting-shares`,input:{
    title:body.title,started_at:meeting.started_at,summary:body.summary,action_items:receipt.action_items,
    source_id:meeting.id,client_key:shareKey,...recipients,
  }})
  assert.equal((await call('POST',path,recipients,shareKey)).status,200)
  assert.equal((await call('GET',path)).body.items[0].id,receiptId)
  assert.match(calls.at(-1).path,new RegExp('source_id='+meeting.id))
  assert.equal((await call('GET','shared?limit=100')).body.items[0].id,receiptId)
  assert.equal((await call('GET',`shared/${receiptId}`)).body.meeting.summary,body.summary)
  assert.equal((await call('POST',`${meeting.id}/remove`,{revision:meeting.revision})).status,200)
  assert.equal((await call('GET','shared?sent=1')).body.items[0].id,receiptId)
  assert.equal(calls.at(-1).path,`/v1/ot/workspaces/${WS}/meeting-shares?limit=20&sent=1`)
  assert.deepEqual((await call('POST',`shared/${receiptId}/revoke`,{})).body,{revoked:true})
  assert.equal((await call('GET','shared?source_id='+meeting.id)).status,400)
})

test('received meeting actions are copied once into personal memory and every retry rechecks access', async t => {
  const team = 'b'.repeat(32), shareId = 'c'.repeat(32)
  const bot = await bootMemory(volume(), {teams:[team]})
  const text = '📋'.repeat(45) + ' 在周五前确认议程'
  const meeting = {id:shareId, title:'周会', revision:3, shared:true, action_items:[
    {text,owner:'Alice',due_date:'2032-02-29',done:false}, {text:'已确认的事项',done:true},
  ]}
  const assigned = {share_id:shareId, revision:3, action_index:0, text, owner:'Alice', meeting_title:meeting.title}
  const another = {...assigned, share_id:'d'.repeat(32)}
  let received = true, revoked = false
  setSharedBotSocial({async request(method, path) {
    assert.equal(method, 'GET')
    if (path.includes('/meeting-shares?view=actions')) return {items:revoked ? [another] : [assigned,another],cursor:null}
    assert.equal(path, `/v1/ot/workspaces/${team}/meeting-shares/${shareId}`)
    if (revoked) throw Object.assign(new Error('Meeting share not found'), {status:404,code:'social/not_found'})
    return {meeting, received}
  }})
  t.after(() => setSharedBotSocial(undefined))
  const receipt = base('shared/' + shareId, team)
  const list = base('shared?view=actions&limit=2', team)
  const gateway = new Request('http://fixture', {headers:{'x-ot-owner-username':'Alice'}})
  const loadActions = () => bot.features.table['meetings/v1']({method:'GET',path:list}, {request:gateway})
  const copy = (input) => bot.call('meetings', 'POST', receipt + '/action', input)
  const actions = '/v1/workspaces/' + WS + '/memory/actions'
  const item = {revision:3,index:0}
  assert.equal((await bot.endpoint('memory/saveSharedMeetingAction', {})).ok,false)
  assert.equal((await bot.endpoint('memory/sharedMeetingActions', {})).ok,false)
  assert.deepEqual((await loadActions()).body.items,[assigned,another])
  assert.equal((await copy({...item,workspace_id:team})).status,400)
  assert.equal((await copy({...item,revision:2})).status,409)
  assert.equal((await copy({...item,index:1})).status,409)
  assert.equal((await copy({...item,index:2})).status,404)
  received = false
  assert.equal((await copy(item)).status,404)
  received = true
  const copied = await Promise.all([copy(item),copy(item)])
  assert.deepEqual(copied.map(result=>result.status).sort(),[200,201])
  const action = copied[0].body.action
  assert.deepEqual(copied[1].body.action,action)
  assert.equal(action.workspace_id,WS)
  assert.equal(action.status,'open')
  const privatePath = actions + '/' + action.id
  const saved = (await bot.call('memory','GET',privatePath)).body.action
  assert.match(saved.notes,/在周五前确认议程/)
  assert.equal(saved.due_at,Date.parse('2032-02-29') / 1000)
  assert.deepEqual(saved.source,{kind:'shared_meeting',workspace_id:team,share_id:shareId,revision:3,action_index:0})
  const updated = (await bot.call('memory','POST',privatePath,
    {revision:action.revision,changes:{status:'done',notes:'已自行处理'}})).body.action
  const completed = {...action,status:'done',revision:updated.revision}
  assert.ok(completed.revision > action.revision)
  assert.deepEqual((await bot.call('meetings','GET',receipt)).body.saved_actions,[{index:0,...completed}])
  assert.deepEqual((await loadActions()).body.items,[{...assigned,saved_action:completed},another])
  const replay = await copy(item)
  assert.equal(replay.status,200)
  assert.deepEqual(replay.body.action,completed)
  assert.equal((await bot.call('memory','GET',privatePath)).body.action.notes,'已自行处理')
  assert.equal((await bot.call('memory','GET',actions.replace(WS,team))).body.items.length,0)
  assert.deepEqual((await bot.call('meetings','GET',receipt)).body.meeting,meeting)
  revoked = true
  assert.equal((await copy(item)).status,404)
  assert.deepEqual((await loadActions()).body.items,[another])
  assert.equal((await bot.call('memory','GET',actions)).body.items.length,1)
})

test('meeting speech prepares and uses the local provider in the signed-in runtime', async (t) => {
  const bot = await boot()
  const call = (method, path, body) => bot.call('meetings', method, base(path), body)
  assert.equal((await call('GET', 'speech')).body.phase, 'unavailable')
  let phase = 'unprepared'
  let location = 'host-local'
  let accepted = false
  let calls = 0
  const providerId = 'sensevoice-local'
  const speech = {
    snapshot: () => ({selection: {providerId}, providers: [{id: providerId, location, preparation: {phase}}]}),
    prepare(id) { assert.equal(id, providerId); accepted = true },
    resolve(spec) { return spec },
    async transcribe(spec, signal) {
      calls += 1
      assert.equal(spec.providerId, providerId)
      assert.equal(spec.audio.readUInt32LE(24), 16000)
      assert.equal(spec.audio.readInt16LE(44), -32768)
      assert.equal(signal.aborted, false)
      return {text: ' 周四发布 ' }
    },
  }
  attachRuntime({rt: {}, ctx: {get: name => name === 'speechToText' ? speech : undefined}})
  t.after(detachRuntime)
  const body = {audio_base64: waveBase64(new Float32Array([-1, 0, 1]))}
  assert.equal((await call('POST', 'transcribe', body)).status, 409)
  assert.deepEqual((await call('POST', 'speech', {})).body, {phase: 'checking', ready: false, progress: null})
  assert.equal(accepted, true)
  phase = 'ready'
  assert.equal((await call('GET', 'speech')).body.ready, true)
  assert.equal((await call('POST', 'transcribe', {audio_base64: 'AAAA'})).status, 400)
  assert.equal((await call('POST', 'transcribe', {audio_base64: waveBase64(new Float32Array(240001))})).status, 400)
  assert.deepEqual((await call('POST', 'transcribe', body)).body, {text: '周四发布'})
  assert.equal(calls, 1)
  location = 'cloud'
  assert.equal((await call('POST', 'transcribe', body)).status, 503)
  assert.equal(calls, 1)
  assert.deepEqual((await call('GET', '')).body.items, [])
})

test('meeting draft uses only the native text inference service and never saves without a separate request', async (t) => {
  const bot = await boot()
  const call = (method, id, body) => bot.call('meetings', method, base(id), body)
  const input = { title: '发布周会', attendees: ['小林'], transcript: '已决定周四上线。小林负责核对清单。' }
  const prompts = []
  let answer = '```json\n{"summary":"周四上线。","action_items":[{"text":"核对清单","owner":"小林","done":true}]}\n```'
  assert.equal((await call('POST', 'draft', input)).status, 503)
  attachRuntime({rt: {}, ctx: {}, textOnly: async prompt => { prompts.push(prompt); return answer }})
  t.after(detachRuntime)
  assert.equal((await call('POST', 'draft', {...input, transcript: ' '})).status, 400)
  assert.equal((await call('GET', 'draft')).status, 400)
  assert.equal(prompts.length, 0)
  const generated = await call('POST', 'draft', input)
  assert.equal(generated.status, 200)
  assert.deepEqual(generated.body.draft, { summary: '周四上线。', action_items: [
    {text: '核对清单', owner: '小林', done: false},
  ]})
  assert.deepEqual(JSON.parse(prompts[0].split('\n').at(-1)), input)
  assert.deepEqual((await call('GET', '')).body.items, [])
  answer = 'not JSON'
  assert.equal((await call('POST', 'draft', input)).status, 502)
  const transcript = '会议记录'.repeat(10000)
  const saved = await bot.call('meetings', 'POST', base(), {...input, ...generated.body.draft, transcript}, key())
  assert.equal(saved.status, 201)
  assert.equal(saved.body.meeting.transcript, transcript)
  assert.equal(((await bot.endpoint('meetings/search', {q: input.title})).value.items[0]).href,
    `/meetings#workspace=${WS}&meeting=${saved.body.meeting.id}`)
})

test('saved meeting draft jobs replay, queue, and discard late or revised results', async t => {
  const bot = await boot()
  const other = await boot()
  const gateway = new Request('http://fixture', {headers:{'x-ot-owner-username':'fixture-user'}})
  const call = (actor, method, path, body) => actor.features.table['meetings/v1']({method,path,body}, {request:gateway})
  const route = base('draft')
  const read = (meeting, actor = bot) => call(actor,'GET',`${route}?meeting=${meeting.id}&revision=${meeting.revision}`)
  const command = (meeting, options) => call(bot,'POST',route,{meeting_id:meeting.id,revision:meeting.revision,...options})
  const start = (meeting, previous_job_id = null) => command(meeting,{mode:'start',previous_job_id})
  const flush = () => new Promise(resolve => setImmediate(resolve))
  const pending = []
  attachRuntime({rt:{},ctx:{},textOnly:()=> assert.fail('use isolated background inference'), backgroundTextOnly:prompt => {
    const completion = Promise.withResolvers()
    pending.push({source:JSON.parse(prompt.split('\n').at(-1)), completion})
    return completion.promise
  }})
  t.after(detachRuntime)
  const {meeting:first} = (await bot.call('meetings','POST',base(),body,key())).body
  const {meeting:second} = (await bot.call('meetings','POST',base(),{...body,title:'后续会议'},key())).body
  const accepted = await start(first)
  assert.equal(accepted.status,202)
  assert.equal(accepted.body.job.state,'running')
  const job = accepted.body.job.id
  assert.equal((await start(first)).body.job.id,job)
  const queued = await start(second)
  assert.equal(queued.body.job.state,'queued')
  assert.equal(pending.length,1)
  assert.equal(pending[0].source.transcript,body.transcript)
  assert.equal((await read(first,other)).status,404)
  assert.equal((await call(bot,'GET',`${base('draft','b'.repeat(32))}?meeting=${first.id}&revision=1`)).status,404)
  assert.equal((await command(first,{mode:'cancel',job_id:job})).body.job.state,'cancelled')
  pending[0].completion.resolve('{"summary":"迟到的结果","action_items":[]}')
  await flush()
  assert.equal((await read(first)).body.job.state,'cancelled')
  assert.equal((await read(first)).body.job.draft,undefined)
  assert.equal((await read(second)).body.job.state,'running')
  assert.equal(pending.length,2)
  assert.equal((await bot.call('meetings','POST',base(second.id),{revision:1,changes:{transcript:'已编辑原会议正文'}})).status,200)
  pending[1].completion.resolve('{"summary":"已失效的结果","action_items":[]}')
  await flush()
  assert.equal((await read(second)).status,409)
  assert.equal((await read({...second,revision:2})).body.job,null)
  const retry = (await start(first,job)).body.job
  assert.notEqual(retry.id,job)
  assert.equal((await start(first,job)).body.job.id,retry.id)
  pending[2].completion.resolve('{"summary":"待核对的结果","action_items":[]}')
  await flush()
  const detail = await call(bot,'GET',base(first.id))
  assert.deepEqual(detail.body.draft_job,{id:retry.id,state:'ready',draft:{summary:'待核对的结果',action_items:[]}})
  assert.equal(detail.body.meeting.summary,body.summary)
  const reopened = await boot(bot.vol)
  assert.deepEqual((await read(first,reopened)).body.job,detail.body.draft_job)
  assert.equal((await command(first,{mode:'dismiss',job_id:job})).body.job.state,'ready')
  assert.deepEqual((await command(first,{mode:'dismiss',job_id:retry.id})).body.job,{id:retry.id,state:'dismissed'})
})

test('a DS-Bot restart marks a held saved draft interrupted without automatically rerunning it', async t => {
  const bot = await boot()
  const {meeting} = (await bot.call('meetings','POST',base(),body,key())).body
  const gateway = new Request('http://fixture', {headers:{'x-ot-owner-username':'fixture-user'}})
  const route = base('draft')
  const completion = Promise.withResolvers()
  let turns = 0
  attachRuntime({rt:{},ctx:{},textOnly:() => { turns += 1; return completion.promise }})
  t.after(detachRuntime)
  const start = await bot.features.table['meetings/v1']({method:'POST',path:route,
    body:{mode:'start',meeting_id:meeting.id,revision:1,previous_job_id:null}}, {request:gateway})
  assert.equal(start.status,202)
  const reopened = await boot(bot.vol)
  const read = () => reopened.features.table['meetings/v1']({method:'GET',path:`${route}?meeting=${meeting.id}&revision=1`}, {request:gateway})
  const {job} = (await read()).body
  assert.equal(job.id,start.body.job.id)
  assert.equal(job.state,'failed')
  assert.match(job.error,/重启/)
  completion.resolve('{"summary":"旧进程返回的结果","action_items":[]}')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(turns,1)
  assert.deepEqual((await read()).body.job,job)
})

test('meeting data persists in this volume only; another DS-Bot never sees it', async () => {
  const vol = volume()
  const first = await boot(vol)
  const created = await first.call('meetings', 'POST', base(), body, key())
  const again = await boot(vol)
  assert.equal((await again.call('meetings', 'GET', base(created.body.meeting.id))).status, 200)
  const other = await boot()
  assert.equal((await other.call('meetings', 'GET', base(created.body.meeting.id))).status, 404)
  assert.equal((await other.call('meetings', 'GET', base())).body.items.length, 0)
})

test('unmoved and malformed /v1 targets are refused', async () => {
  const bot = await boot()
  assert.equal((await bot.call('meetings', 'GET', `/v1/workspaces/${WS}/automations`)).body.error.code, 'not_moved')
  for (const bad of ['/v1/workspaces/../meetings', '/x/meetings', '/v1/workspaces/%2e%2e/meetings', '//v1/']) {
    assert.equal((await bot.call('meetings', 'GET', bad)).status, 404, bad)
  }
  assert.equal((await bot.call('meetings', 'DELETE', base())).status, 404)
})

test('legacy meetings of one test account import into that account\'s DS-Bot, idempotently', async () => {
  const { bundles, expect } = legacyBundles(['meetings'])
  const vol = volume()
  deliverBundle(vol, 'meetings-1.bundle', bundles.meetings)
  const bot = await boot(vol)
  const routes = await bot.endpoint('meetings/routes')
  assert.deepEqual(routes.value.imported.map((item) => item.status), ['imported'])
  const wid = expect.workspace_id
  const read = await bot.call('meetings', 'GET', base(expect.meetings.meeting_id, wid))
  assert.equal(read.status, 200)
  assert.equal(read.body.meeting.title, expect.meetings.title)
  assert.equal(read.body.meeting.action_items[0].text, '订会议室')
  const titles = (await bot.call('meetings', 'GET', base('', wid))).body.items.map((item) => item.title)
  assert.ok(!titles.includes(expect.meetings.foreign_title), 'another account\'s meeting never enters this bundle')
  assert.equal(existsSync(join(vol.data, 'flybot-workspace', 'import', 'meetings-1.bundle')), false)
  deliverBundle(vol, 'meetings-1.bundle', bundles.meetings)
  const again = await boot(vol)
  assert.deepEqual((await again.endpoint('meetings/routes')).value.imported.map((item) => item.status), ['already-imported'])
  const tampered = JSON.parse(bundles.meetings)
  tampered.tables.meetings = tampered.tables.meetings.replace('周会', '改过')
  const evil = volume()
  deliverBundle(evil, 'x.bundle', JSON.stringify(tampered))
  const rejected = await boot(evil)
  const badDigest = (await rejected.endpoint('meetings/routes')).value.imported[0]
  assert.equal(badDigest.status, 'rejected')
  assert.match(badDigest.reason, /digest mismatch/)

  const foreign = volume()
  deliverBundle(foreign, 'foreign.bundle', JSON.stringify({
    ...JSON.parse(bundles.meetings),
    instance_id: bot.identity.routingInstanceId ?? bot.identity.instanceId,
  }))
  const other = await boot(foreign)
  assert.deepEqual((await other.endpoint('meetings/routes')).value.imported, [
    { name: 'foreign.bundle', status: 'rejected', reason: 'import target mismatch' },
  ])
  assert.equal((await other.call('meetings', 'GET', base(expect.meetings.meeting_id, wid))).status, 404)
  assert.equal(existsSync(join(foreign.data, 'flybot-workspace', 'import', 'foreign.bundle')), true)
})
