import assert from 'node:assert/strict'
import test from 'node:test'
import { FeatureError } from '../featurekit/http.js'
import { setSharedBotSocial } from '../lib/c/bot-social.js'
import social from '../features/social/index.js'
import overview from '../features/overview/index.js'

const workspace = 'a'.repeat(32)
const other = 'b'.repeat(32)
const foreign = 'f'.repeat(32)
const automation = 'c'.repeat(32)
const noticeId = run => 'automation-run-' + run
const inbox = wid => '/v1/workspaces/' + wid + '/notifications'
const local = (run, created, workspace_id = workspace, read = false) => ({
  id:noticeId(run), kind:'automation.run_finished', created, read, workspace_id,
  automation_id:automation, run_id:run, title:'Daily run', status:'succeeded',
  output:'private result', prompt:'private instructions', path:'//outside.invalid',
})

function fixture(t) {
  const runs = ['1'.repeat(32), '2'.repeat(32), '3'.repeat(32)]
  const [first,second,third] = runs.map(noticeId)
  const localRows = [local(runs[0], 9), local(runs[1], 10), local(runs[2], 100, other)]
  const sharedRows = [
    {id:'shared-old', seq:12, kind:'messenger.mention', created_at:8000, read:false, data:{}},
    {id:'shared-recent', seq:13, kind:'messenger.mention', created_at:10050, read:false, data:{}},
    {id:'shared-read', seq:11, kind:'artifact.shared', created_at:9999, read:true, data:{
      conversation_id:'otc_' + 'A'.repeat(26), message_id:'otm_' + 'B'.repeat(26),
    }},
  ]
  const sharedCalls = [], localCalls = []
  const faults = {}, prefs = {}
  setSharedBotSocial({ async request(method, path, body) {
    sharedCalls.push({method, path, body})
    if (path.startsWith('/v1/ot/teams/by-workspace/')) {
      if (path.endsWith(foreign)) throw Object.assign(new Error('Workspace not found'),{status:404,code:'social/not_found'})
      return {id:'team-row',name:'Workspace'}
    }
    const url = new URL(path,'http://fixture.test')
    const team = method === 'GET' ? url.searchParams.get('workspace_id') : body.workspace_id
    if (team === foreign) throw Object.assign(new Error('Workspace not found'),{status:404,code:'social/not_found'})
    const kind = method === 'GET' ? url.searchParams.get('kind') : body.kind
    assert.notEqual(kind,'automation')
    assert.ok(!body?.notification_id?.startsWith('automation-run-'))
    const exclude = method === 'GET' ? url.searchParams.get('exclude') : body.exclude
    const excludes = (faults.oldShared || !exclude) ? [] : exclude.split(',')
    const echo = excludes.length ? {exclude} : {}
    const visible = sharedRows.filter(row => !excludes.includes(row.kind) &&
      (!kind || row.kind === 'artifact.shared' || (row.kind === 'discover.published' && row.data.kind === 'work')))
    if (method === 'POST') {
      if (faults.sharedPost) throw faults.sharedPost
      if (!body.all && !visible.some(row => row.id === body.notification_id)) {
        throw Object.assign(new Error('Notice not found'),{status:404,code:'social/not_found'})
      }
      for (const row of visible) if (body.all || row.id === body.notification_id) row.read = true
      return {unread:visible.filter(row => !row.read).length, ...echo}
    }
    if (faults.sharedGet) throw faults.sharedGet
    const unread = visible.filter(row => !row.read)
    const filtered = url.searchParams.get('unread') ? unread : visible
    const notifications = [...filtered].sort((a,b) => b.seq-a.seq).slice(0,Number(url.searchParams.get('limit')))
    return {unread:unread.length, notifications, ...echo}
  } })
  t.after(() => setSharedBotSocial(undefined))
  const host = {async call(endpoint, payload) {
    if (endpoint === 'settings/notificationPrefs') {
      if (faults.prefs) throw faults.prefs
      return {prefs}
    }
    if (endpoint === 'agents/personal-binding') return {workspace_id:workspace}
    if (endpoint === 'agents/workspaceOverview') return {count:1,items:[{id:'agent-thread',source:'agent',updated:1}]}
    if (endpoint === 'automations/list') return {items:[]}
    if (endpoint === 'messenger/v1') return {status:200,body:{items:[{id:'shared-thread',kind:'group',updated:2}]}}
    if (endpoint === 'social/v1') return social(host).endpoints.v1(payload)
    if (['artifacts/v1','meetings/v1'].includes(endpoint)) return {status:200,body:{items:[]}}
    localCalls.push({endpoint,payload})
    if (faults.missing) throw Object.assign(new Error('Unknown FlyBot endpoint'),{code:'flybot-workspace/not-found'})
    if (endpoint === 'automations/notifications' && faults.localGet) throw faults.localGet
    if (endpoint === 'automations/readNotifications' && faults.localRead) throw faults.localRead
    if (payload.workspace_id === foreign) throw new FeatureError(404,'not_found','Workspace not found')
    const rows = localRows.filter(row => row.workspace_id === payload.workspace_id)
    if (endpoint === 'automations/readNotifications') {
      if (!payload.all && !rows.some(row => row.id === payload.notification_id)) throw new FeatureError(404,'not_found','Notice not found')
      for (const row of rows) if (payload.all || row.id === payload.notification_id) row.read = true
    } else assert.equal(endpoint,'automations/notifications')
    const unread = rows.filter(row => !row.read)
    const visible = payload.unread ? unread : rows
    const items = [...visible].sort((a,b) => b.created-a.created || b.id.localeCompare(a.id)).slice(0,payload.limit)
    return {items,unread_count:unread.length}
  }}
  const endpoint = social(host).endpoints.v1
  const get = (query = '', wid = workspace) => endpoint({method:'GET',path:inbox(wid)+query})
  const read = (body, wid = workspace) => endpoint({method:'POST',path:inbox(wid)+'/read',body})
  return {host, first, second, third, sharedCalls, sharedRows, localCalls, localRows, prefs, get, read, faults}
}

test('the mixed inbox cuts off the globally newest rows and projects only exact private run metadata', async t => {
  const {get,second,sharedCalls,localCalls} = fixture(t)
  const result = await get('?limit=2&filter=unread')
  assert.equal(result.status,200)
  assert.equal(result.body.limit,2)
  assert.equal(result.body.unread_count,4)
  assert.deepEqual(result.body.items.map(item => item.id),['shared-recent',second])
  const row = result.body.items[1]
  const [path, query] = row.path.split('?')
  assert.equal(path,'/automations')
  assert.deepEqual(Object.fromEntries(new URLSearchParams(query)),{workspace,automation,run:'2'.repeat(32)})
  assert.deepEqual(Object.keys(row).sort(),
    ['id','kind','created','read','workspace_id','automation_id','run_id','title','status','path'].sort())
  assert.deepEqual(localCalls,[{endpoint:'automations/notifications',payload:{workspace_id:workspace,limit:2,unread:true}}])
  assert.deepEqual(sharedCalls,[{method:'GET',path:'/v1/ot/notifications?limit=2&latest=1&personal=1&unread=1',body:undefined}])
})

test('explicit filters keep shared work and local automation visibility separate', async t => {
  const {get,read,first,second,third,sharedCalls,localCalls,localRows} = fixture(t)
  const runList = await get('?kind=automation&limit=5')
  assert.deepEqual(runList.body.items.map(row => row.id),[second,first])
  assert.equal(runList.body.unread_count,2)
  assert.equal((await get('?kind=automation',other)).body.items[0].id,third)
  assert.equal((await get('?kind=automation',foreign)).status,404)
  assert.equal(sharedCalls.length,0)
  assert.equal((await read({notification_id:third,kind:'automation'})).status,404)
  assert.equal((await read({notification_id:'shared-old',kind:'automation'})).status,404)
  assert.equal((await read({notification_id:first,kind:'work'})).status,404)
  assert.ok(localRows.every(row => !row.read))
  const localCount = localCalls.length
  const work = await get('?kind=work')
  assert.deepEqual(work.body.items.map(row => row.id),['shared-read'])
  assert.equal((await read({all:true,kind:'work'})).status,200)
  assert.equal(localCalls.length,localCount)
  assert.deepEqual(sharedCalls.at(-1).body,{all:true,personal:true,kind:'work'})
})

test('read-one changes only its own store and reports the total unread for the active workspace', async t => {
  const {read,first,sharedCalls,localCalls,localRows} = fixture(t)
  assert.deepEqual(await read({notification_id:first}),{status:200,body:{unread_count:3}})
  assert.equal(sharedCalls[0].method,'GET')
  assert.deepEqual(localCalls[0],{endpoint:'automations/readNotifications',payload:{workspace_id:workspace,notification_id:first}})
  assert.deepEqual(await read({notification_id:'shared-recent'}),{status:200,body:{unread_count:2}})
  assert.equal(localCalls[1].endpoint,'automations/notifications')
  assert.deepEqual(sharedCalls.at(-1).body,{notification_id:'shared-recent',personal:true,kind:undefined})
  assert.deepEqual(await read({all:true}),{status:200,body:{unread_count:0}})
  assert.equal(localRows.find(row => row.workspace_id === other).read,false)
  assert.deepEqual(localCalls.at(-1),{endpoint:'automations/readNotifications',payload:{workspace_id:workspace,all:true}})
})

test('preferences hide matching rows and unread counts while keeping follow notices and hidden receipts', async t => {
  const {get, read, prefs, sharedRows, sharedCalls, localRows, first, faults} = fixture(t)
  sharedRows.push(
    {id:'following', seq:14, kind:'follow.new', created_at:10100, read:false, data:{}},
    {id:'published', seq:15, kind:'discover.published', created_at:10200, read:false, data:{kind:'work', slug:'updated-work'}},
  )
  Object.assign(prefs, {mentions:false, artifacts:false, task_completion:false})
  const muted = await get('?limit=1&filter=unread')
  assert.equal(muted.status, 200)
  assert.deepEqual(muted.body.items.map(row => row.id), ['published'])
  assert.equal(muted.body.unread_count, 2)
  assert.equal(new URL(sharedCalls.at(-1).path, 'https://fixture.test').searchParams.get('exclude'),
    'messenger.mention,artifact.shared,artifact')
  assert.deepEqual((await get('?kind=work')).body.items.map(row => row.id), ['published'])
  assert.deepEqual((await get('?kind=automation')).body, {items:[], unread_count:0, limit:200})
  assert.equal((await get('?kind=automation', foreign)).status, 404)

  assert.equal((await read({notification_id:first})).status, 404)
  assert.equal((await read({notification_id:'shared-recent'})).status, 404)
  assert.deepEqual((await read({all:true})).body, {unread_count:0})
  assert.ok(sharedRows.filter(row => row.kind === 'messenger.mention').every(row => !row.read))
  assert.ok(localRows.every(row => !row.read))
  prefs.mentions = true
  prefs.task_completion = true
  assert.equal((await get()).body.unread_count, 4)

  prefs.mentions = false
  faults.oldShared = true
  const writes = sharedCalls.filter(call => call.method === 'POST').length
  assert.equal((await read({all:true})).status, 503)
  assert.equal(sharedCalls.filter(call => call.method === 'POST').length, writes)
  assert.equal((await get()).status, 503)
  faults.prefs = new Error('internal path')
  assert.doesNotMatch(JSON.stringify(await get()), /internal path/)
})

test('invalid requests and real source failures cannot masquerade as successful inbox reads or marks', async t => {
  const {get,read,first,sharedCalls,localCalls,faults,localRows} = fixture(t)
  for (const query of ['?limit=0','?limit=1&limit=2','?kind=work&kind=automation','?filter=unread&filter=all','?filter=other','?secret=1']) {
    assert.equal((await get(query)).status,400)
  }
  for (const body of [{all:true,notification_id:first},{all:false},{notification_id:'automation-run-invalid'},{notification_id:first,workspace_id:other}]) {
    assert.equal((await read(body)).status,400)
  }
  assert.equal(sharedCalls.length,0)
  assert.equal(localCalls.length,0)
  faults.localGet = new Error('fixture private prompt')
  const failedList = await get()
  assert.equal(failedList.status,503)
  assert.doesNotMatch(JSON.stringify(failedList),/fixture private prompt/)
  const priorSharedPosts = sharedCalls.filter(call => call.method === 'POST').length
  assert.equal((await read({all:true})).status,503)
  assert.equal(sharedCalls.filter(call => call.method === 'POST').length,priorSharedPosts)
  faults.localGet = undefined
  faults.sharedGet = Object.assign(new Error('Shared service unavailable'),{status:503,code:'social/unreachable'})
  assert.equal((await read({notification_id:first})).status,503)
  assert.ok(localRows.every(row => !row.read))
  faults.sharedGet = undefined
  faults.localRead = new Error('fixture private result')
  const partial = await read({all:true})
  assert.equal(partial.status,503)
  assert.equal(partial.body.error.code,'notifications_partial_read')
  assert.doesNotMatch(JSON.stringify(partial),/fixture private result/)
  assert.equal((await get()).body.unread_count,2)
})

test('overview and merged notifications tolerate only a genuinely unregistered local feature', async t => {
  const {host,get,read,faults,localRows,sharedCalls} = fixture(t)
  const home = (wid = workspace) => overview(host).endpoints.v1({method:'GET',path:'/v1/workspaces/'+wid+'/overview'})
  const personal = (await home()).body
  assert.deepEqual(personal.workspace,{id:workspace,name:'个人空间',kind:'personal'})
  assert.equal(personal.unread_notifications,4)
  assert.equal(personal.counts.agents,1)
  assert.deepEqual(personal.recent_conversations.map(row=>row.source),['social','agent'])
  assert.equal(sharedCalls.some(call=>call.path.includes('/teams/by-workspace/')),false)
  assert.ok(sharedCalls.some(call=>call.path.includes('personal=1')))
  assert.equal((await home(foreign)).status,404)
  faults.missing = true
  assert.equal((await home()).body.unread_notifications,2)
  assert.equal((await read({all:true})).status,200)
  assert.equal((await get()).body.unread_count,0)
  assert.equal((await get('?kind=automation')).status,503)
  assert.equal((await read({all:true,kind:'automation'})).status,503)
  faults.missing = false
  faults.localGet = new Error('Unexpected store failure')
  assert.equal((await home()).status,503)
  faults.localGet = undefined
  localRows[0].workspace_id = 'mismatched'
  localRows[1].id = noticeId('9'.repeat(32))
  assert.equal((await get()).status,503)
})
