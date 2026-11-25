import { createLegacyDispatch, LEGACY_PATH } from '../src/dispatch.js'
import { triangleGlb } from './fixtures/triangle-glb.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { inflateRawSync } from 'node:zlib'
import { boot, deliverBundle, key, legacyBundles, volume, WS } from './helpers.js'
import { setSharedBotSocial } from '../lib/c/bot-social.js'

const base = (rest = '', ws = WS) => `/v1/workspaces/${ws}/artifacts${rest}`
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

test('artifacts feature loads in this DS-Bot and keeps its data in its own feature directory', async () => {
  const bot = await boot()
  assert.ok(bot.features.loaded.includes('artifacts'), JSON.stringify(bot.features.failed))
  assert.ok(existsSync(join(bot.vol.data, 'flybot-workspace', 'features', 'artifacts', 'artifacts.sqlite3')))
})

test('document trees keep retry receipts, descendants and parent links inside the same workspace', async () => {
  let bot = await boot()
  const call = (...args) => bot.call('artifacts', ...args)
  const create = (title, parent_id, workspace = WS, receipt = key()) => call('POST', base('', workspace),
    {title, body:'文档内容', ...(parent_id ? {parent_id} : {})}, receipt)
  const parent = (await create('父文档')).body.artifact
  const otherWorkspace = 'b'.repeat(32)
  const unrelated = (await create('其他工作区文档', null, otherWorkspace)).body.artifact
  assert.equal((await create('越过工作区', unrelated.id)).status, 404)
  const receipt = key()
  const child = await create('子文档', parent.id, WS, receipt)
  assert.equal(child.status, 201)
  const id = child.body.artifact.id
  assert.deepEqual(child.body.artifact.parent, {id:parent.id,title:parent.title})
  assert.equal((await create('子文档', parent.id, WS, receipt)).body.artifact.id, id)
  assert.equal((await create('子文档', null, WS, receipt)).status, 409)
  const nested = (await create('孙文档', id)).body.artifact
  const site = await call('POST', base(), {title:'网站作品',kind:'website',body:'<h1>Hello</h1>'}, key())
  assert.equal((await create('网页下的子文档', site.body.artifact.id)).status, 404)

  bot = await boot(bot.vol)
  const tree = base('/document-tree')
  const items = (await call('GET', tree)).body.items
  assert.deepEqual(new Map(items.map(row => [row.id,row.parent_id])), new Map([[parent.id,null],[id,parent.id],[nested.id,id]]))
  assert.ok(items.every(row => !Object.hasOwn(row,'body')))
  assert.deepEqual((await call('GET', base('/document-tree',otherWorkspace))).body.items.map(row=>row.id), [unrelated.id])
  const outsider = await boot()
  assert.deepEqual((await outsider.call('artifacts','GET',tree)).body.items, [])
  const update = await call('POST', base('/'+id), {revision:1,changes:{body:'文档内容'}})
  assert.equal(update.body.artifact.parent.id, parent.id)
  await call('POST', base('/'+parent.id+'/remove'), {})
  assert.equal((await call('GET', base('/'+id))).body.artifact.parent, undefined)
  assert.equal((await call('GET', base('/'+nested.id))).body.artifact.parent.id, id)
  assert.equal((await call('GET', tree)).body.items.find(row=>row.id===id).parent_id, null)
})

test('moving an existing document preserves its descendants, content revision and account scope', async () => {
  let bot = await boot()
  const call = (...args) => bot.call('artifacts', ...args)
  const create = async (title, workspace = WS, parentId = null) => (await call('POST', base('', workspace), {
    title, body: '移入项目的现有内容', ...(parentId && {parent_id: parentId}),
  }, key())).body.artifact
  const tree = base('/document-tree')
  const move = (id, parent, expected) => call('POST', tree, {artifact_id:id,parent_id:parent,expected_parent_id:expected})
  const project = await create('项目')
  const other = await create('另一个项目')
  const existing = await create('现有文档')
  const child = await create('现有文档的子文档', WS, existing.id)
  const foreign = await create('其他工作区', 'b'.repeat(32))

  assert.equal((await move(existing.id, existing.id, null)).body.error.code,'document_tree_cycle')
  assert.equal((await move(existing.id, child.id, null)).body.error.code,'document_tree_cycle')
  assert.equal((await move(existing.id, foreign.id, null)).status,404)
  assert.equal((await move(foreign.id, project.id, null)).status,404)
  assert.equal((await call('POST', tree, {artifact_id:existing.id,parent_id:project.id})).status,400)
  assert.deepEqual((await move(existing.id, project.id, null)).body,{id:existing.id,parent:{id:project.id,title:project.title}})
  assert.equal((await move(existing.id, other.id, null)).body.error.code,'document_tree_changed')
  assert.equal((await move(existing.id, project.id, null)).status,200)
  bot = await boot(bot.vol)
  assert.deepEqual((await call('GET', base('/' + existing.id))).body.artifact,
    {...existing,parent:{id:project.id,title:project.title}})
  assert.equal((await call('GET', base('/' + child.id))).body.artifact.parent.id,existing.id)
  const outsider = await boot()
  assert.equal((await outsider.call('artifacts','POST',tree,
    {artifact_id:existing.id,parent_id:null,expected_parent_id:project.id})).status,404)
  assert.deepEqual((await move(existing.id, null, project.id)).body,{id:existing.id,parent:null})
  assert.equal((await call('GET', base('/' + existing.id))).body.artifact.parent,undefined)
  assert.equal((await call('GET', base('/' + child.id))).body.artifact.parent.id,existing.id)
})

test('restoring a reviewed version preserves history and replays an exact native receipt after restart', async () => {
  let bot = await boot()
  const call = (...args) => bot.call('artifacts', ...args)
  const created = await call('POST', base(), {title:'版本恢复', kind:'document', body:'原稿'}, key())
  assert.equal(created.status, 201)
  const path = base('/' + created.body.artifact.id)
  assert.equal((await call('POST', path, {revision:1, changes:{body:'第二稿'}})).body.artifact.revision, 2)
  const operationKey = key()
  const reviewed = {revision:2, to:1}
  const first = await call('POST', path + '/restore', reviewed, operationKey)
  assert.equal(first.status, 200)
  assert.deepEqual(first.body.restore, {base_revision:2, source_revision:1, result_revision:3})
  assert.equal(first.body.artifact.body, '原稿')
  assert.equal((await call('POST', path, {revision:3, changes:{body:'新修改'}})).body.artifact.revision, 4)

  bot = await boot(bot.vol)
  const replay = await call('POST', path + '/restore', reviewed, operationKey)
  assert.equal(replay.status, 200)
  assert.deepEqual(replay.body.restore, first.body.restore)
  assert.equal(replay.body.artifact.revision, 4)
  assert.equal(replay.body.artifact.body, '新修改')
  const otherTarget = await call('POST', path + '/restore', {revision:2, to:2}, operationKey)
  assert.equal(otherTarget.status, 409)
  assert.equal(otherTarget.body.error.code, 'idempotency_conflict')
  const staleReview = await call('POST', path + '/restore', reviewed, key())
  assert.equal(staleReview.status, 409)
  assert.equal(staleReview.body.error.current.revision, 4)
  const versions = await call('GET', path + '/versions')
  assert.deepEqual(versions.body.items.map(item => [item.revision, item.restored_from ?? null]), [[4,null],[3,1],[2,null],[1,null]])
  assert.equal((await call('GET', path + '/versions/2')).body.version.body, '第二稿')
  assert.equal((await call('GET', path + '/versions/3')).body.version.restored_from, 1)
  const outsider = await boot()
  assert.equal((await outsider.call('artifacts','POST',path + '/restore',reviewed,operationKey)).status, 404)
})

test('owner recovery survives a native restart and only reveals an active confirmed share', async (t) => {
  let bot = await boot()
  const outsider = await boot()
  const bindings = target => {
    target.features.table['agents/personal-binding'] = async () => ({workspace_id:WS})
  }
  bindings(bot)
  let publishes = 0
  let checkState = 200
  const hashes = new Set()
  setSharedBotSocial({
    async request(method,path,payload) {
      if (method === 'PUT') {
        publishes += 1
        hashes.add(payload.token_hash)
        return {published:true}
      }
      if (method === 'DELETE') {
        hashes.delete(path.split('/').at(-1))
        return {revoked:true}
      }
      const present = hashes.has(path.split('/').at(-1))
      if (!present || checkState !== 200) throw Object.assign(Error('Unavailable'),{status:present ? checkState : 404})
      return {active:true}
    },
  })
  t.after(()=>setSharedBotSocial(undefined))
  const {artifact} = (await bot.call('artifacts','POST',base(),{title:'Recover a shared link',body:'Exact source'},key())).body
  const path = base('/'+artifact.id+'/shares')
  const create = () => bot.call('artifacts','POST',path,{revision:1})
  const {share} = (await create()).body
  const link = path+'/'+share.id+'/link'
  assert.equal((await outsider.call('artifacts','POST',link,{})).status,404)
  const db = new DatabaseSync(join(bot.vol.data,'flybot-workspace','features','artifacts','artifacts.sqlite3'))
  t.after(()=>db.close())
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM artifact_shares').all()).includes(share.token))
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM artifact_share_keys').all()).includes(share.token))

  bot = await boot(bot.vol)
  bindings(bot)
  const recover = () => bot.call('artifacts','POST',link,{})
  const listed = (await bot.call('artifacts','GET',path)).body.items
  assert.equal(listed[0].recoverable,true)
  assert.equal(listed[0].path,undefined)
  assert.equal(listed[0].token,undefined)
  checkState = 503
  assert.equal((await recover()).status,503)
  checkState = 404
  assert.equal((await recover()).status,404)
  checkState = 200
  assert.deepEqual((await recover()).body.share,{id:share.id,path:share.path})
  assert.equal(publishes,1)
  db.prepare('UPDATE artifact_shares SET recovery_version=0 WHERE id=?').run(share.id)
  assert.equal((await recover()).status,404)
  db.prepare('UPDATE artifact_shares SET recovery_version=1,expires=1 WHERE id=?').run(share.id)
  assert.equal((await recover()).status,404)
  db.prepare('UPDATE artifact_shares SET expires=NULL WHERE id=?').run(share.id)
  await bot.call('artifacts','POST',path+'/'+share.id+'/revoke',{})
  assert.equal((await recover()).status,404)
  assert.equal(publishes,1)
})

test('Studio copy verifies the reviewed private revision and keeps a stable per-version receipt', async (t) => {
  const bot = await boot()
  const other = await boot()
  const call = (...args) => bot.call('artifacts', ...args)
  const privateBody = 'Reviewed body\n\n'
  const created = await call('POST', base(), {
    title: 'Team   notes', body: privateBody, kind: 'document',
    source: {kind:'agent_message', id:'b'.repeat(32), conversation_id:'c'.repeat(32)},
  }, key())
  assert.equal(created.status, 201)
  const original = created.body.artifact
  const path = base('/' + original.id + '/studio-copy')
  const input = {revision: original.revision, title:'Team notes', body:privateBody}
  const outgoing = []
  const studioId = 'e'.repeat(32)
  setSharedBotSocial({
    request: async (method, target, payload) => {
      assert.equal(method, 'POST')
      assert.equal(target, '/v1/ot/teams/' + WS + '/studio/documents')
      outgoing.push(payload)
      if (outgoing.length === 1) throw Error('Lost acknowledgment')
      return {document:{id:studioId}}
    },
  })
  t.after(() => setSharedBotSocial(undefined))

  assert.equal((await call('POST', path, {...input, body:'Unreviewed body'})).body.error.code, 'source_changed')
  assert.equal((await other.call('artifacts', 'POST', path, input)).status, 404)
  assert.equal(outgoing.length, 0)
  assert.equal((await call('POST', path, input)).body.error.code, 'studio_copy_unconfirmed')
  assert.deepEqual((await call('POST', path, input)).body, {id:studioId,workspace_id:WS})
  assert.deepEqual(outgoing[0], {title:input.title, body:privateBody, client_key:outgoing[1].client_key})
  assert.match(outgoing[1].client_key, /^[a-f0-9]{64}$/)
  const originalPath = base('/' + original.id)
  assert.deepEqual((await call('GET', originalPath)).body.artifact, original)

  assert.equal((await call('POST', originalPath, {revision:original.revision, changes:{body:'Updated later'}})).status, 200)
  assert.equal((await call('POST', path, input)).body.error.code, 'source_changed')
  assert.equal(outgoing.length, 2)
  await call('POST', path, {...input, revision:original.revision + 1, body:'Updated later'})
  assert.notEqual(outgoing[2].client_key, outgoing[1].client_key)
})

test('Studio copies from the personal runtime and a verified named source scope use distinct target receipts', async (t) => {
  const bot = await boot()
  const personal = bot.identity.instanceId
  const destinations = ['b'.repeat(32), 'd'.repeat(32)]
  const contents = {title:'Reviewed document',body:'Text from the saved version'}
  const create = workspace => bot.call('artifacts','POST',base('',workspace),contents,key())
  const [{body:{artifact:local}}, {body:{artifact:team}}] = await Promise.all([create(personal),create(WS)])
  const sent = []
  setSharedBotSocial({
    async request(method, path, payload) {
      sent.push({method,path,payload})
      return {document:{id:'e'.repeat(32)}}
    },
  })
  t.after(() => setSharedBotSocial(undefined))

  const copy = (artifact,target) => bot.call('artifacts','POST',base('/'+artifact.id+'/studio-copy',artifact.workspace_id),
    {...contents,revision:artifact.revision,target_workspace_id:target})
  assert.equal((await copy(local,'invalid')).status,400)
  assert.equal(sent.length,0)
  assert.equal((await copy(local,destinations[0])).body.workspace_id,destinations[0])
  await copy(local,destinations[0])
  await copy(local,destinations[1])
  await copy(team,destinations[1])
  assert.deepEqual(sent.map(entry=>entry.path),[destinations[0],destinations[0],destinations[1],destinations[1]]
    .map(target=>`/v1/ot/teams/${target}/studio/documents`))
  assert.equal(sent[0].payload.client_key,sent[1].payload.client_key)
  assert.notEqual(sent[0].payload.client_key,sent[2].payload.client_key)
  assert.deepEqual(sent.map(entry=>entry.payload.source_workspace_id),[undefined,undefined,undefined,WS])
})

test('copying a saved work version creates a separate private artifact and replays after the source is removed', async () => {
  const owner = await boot()
  const other = await boot()
  const call = (...args) => owner.call('artifacts',...args)
  const literal = JSON.stringify({schema:'flybot-workspace.slides.v1',slides:[{title:'JSON example',bullets:['literal document text']}]})
  const original = (await call('POST',base(),{title:'Notes',body:literal,
    source:{kind:'agent_message',id:'b'.repeat(32),conversation_id:'c'.repeat(32)}},key())).body.artifact
  assert.equal(original.source.kind,'agent_message')
  const path = '/' + original.id
  await call('POST',base(path),{revision:1,changes:{body:'Newer original'}},key())
  await call('POST',base(path+'/favorite'),{enabled:true})
  const input = {title:'Notes copy',duplicate_from:{artifact_id:original.id,revision:1}}
  const receipt = key()
  assert.equal((await other.call('artifacts','POST',base(),input,receipt)).status,404)
  assert.equal((await call('POST',base('','d'.repeat(32)),input,receipt)).status,404)
  assert.equal((await call('POST',base(),{...input,duplicate_from:{...input.duplicate_from,revision:4}},receipt)).body.error.code,'version_not_found')
  const result = await call('POST',base(),input,receipt)
  assert.equal(result.status,201,JSON.stringify(result.body))
  const {artifact:copy} = result.body
  assert.notEqual(copy.id,original.id)
  assert.deepEqual([copy.kind,copy.title,copy.body,copy.revision],['document','Notes copy',literal,1])
  assert.equal(copy.source,undefined)
  assert.deepEqual((await call('GET',base('/'+copy.id+'/shares'))).body.items,[])
  assert.deepEqual((await call('GET',base()+'?scope=favorites')).body.items.map(row => row.id),[original.id])
  assert.equal((await call('POST',base(),{...input,title:'Different'},receipt)).status,409)
  assert.equal((await call('POST',base(),input,key())).body.error.code,'title_conflict')
  const revised = await call('POST',base('/'+copy.id),{revision:1,changes:{body:'Only edited in copy'}})
  assert.equal(revised.body.artifact.body,'Only edited in copy')
  assert.equal((await call('GET',base(path))).body.artifact.body,'Newer original')
  assert.deepEqual((await call('GET',base(path+'/versions'))).body.items.map(row => row.revision),[2,1])
  await call('POST',base(path+'/remove'),{})
  const replay = await call('POST',base(),input,receipt)
  assert.equal(replay.status,200)
  assert.equal(replay.body.artifact.id,copy.id)
  assert.equal(replay.body.artifact.body,'Only edited in copy')
})

test('saving link-shared text copies only the reviewed snapshot to the personal runtime', async (t) => {
  const bot = await boot()
  const other = await boot()
  const call = (...args) => bot.call('artifacts',...args)
  const workspace = WS
  assert.notEqual(workspace, bot.identity.instanceId)
  bot.features.table['agents/personal-binding'] = async () => ({workspace_id:workspace})
  other.features.table['agents/personal-binding'] = async () => ({workspace_id:other.identity.instanceId})
  const endpoint = base('/shared-copy', workspace)
  const token = 'a'.repeat(43)
  let snapshot = {title:'Shared plan',body:'Reviewed text with <literal markup>.'}
  let resolves = 0
  setSharedBotSocial({
    async request(method, path, payload) {
      assert.deepEqual([method,path,payload],['POST','/v1/ot/public-shares/resolve',{token}])
      resolves += 1
      if (!snapshot) throw Object.assign(new Error('revoked'),{status:404})
      return snapshot
    },
  })
  t.after(() => setSharedBotSocial(undefined))

  assert.equal((await other.call('artifacts','POST',endpoint,{token})).status,404)
  assert.equal((await call('POST',base('/shared-copy',bot.identity.instanceId),{token})).status,404)
  assert.equal((await call('POST',endpoint,{token,body:'Use my different text'})).status,400)
  assert.equal(resolves,0)
  const {body:{snapshot:preview}} = await call('POST',endpoint,{token})
  assert.deepEqual(Object.keys(preview).sort(),['body','fingerprint','title'])
  assert.equal(preview.body,snapshot.body)
  assert.deepEqual((await call('GET',base('',workspace))).body.items,[])

  const originalSnapshot = snapshot
  const confirmation = {token,fingerprint:preview.fingerprint}
  snapshot = {...snapshot,body:'Unreviewed alternate text'}
  assert.equal((await call('POST',endpoint,confirmation)).status,409)
  snapshot = null
  assert.equal((await call('POST',endpoint,confirmation)).status,404)
  assert.deepEqual((await call('GET',base('',workspace))).body.items,[])

  snapshot = originalSnapshot
  const results = await Promise.all([call('POST',endpoint,confirmation),call('POST',endpoint,confirmation)])
  assert.deepEqual(results.map(result => result.status).sort(),[200,201])
  const first = results[0].body.artifact
  assert.equal(results[1].body.artifact.id,first.id)
  assert.equal(first.body,originalSnapshot.body)
  assert.equal(first.source,undefined)
  const previous = resolves
  snapshot = null
  const receipt = await call('POST',endpoint,confirmation)
  assert.equal(receipt.body.artifact.id,first.id)
  assert.equal(resolves,previous)
  assert.equal((await call('GET',base('',workspace))).body.items.length,1)
})

test('a reviewed Studio version saves exactly once to the account’s personal workspace', async (t) => {
  const bot = await boot()
  const personal = 'a'.repeat(32)
  const source = 'b'.repeat(32)
  const id = 'c'.repeat(32)
  bot.features.table['agents/personal-binding'] = async () => ({workspace_id:personal})
  const path = base('/studio-personal-copy',personal)
  const call = data => bot.call('artifacts','POST',path,data)
  const review = {source_workspace_id:source,document_id:id,revision:7}
  let readable = true
  let reads = 0
  let body = 'Exact saved text'
  setSharedBotSocial({
    async request(method,target) {
      assert.equal(method,'GET')
      assert.equal(target,`/v1/ot/teams/${source}/studio/documents/${id}/versions/7`)
      reads += 1
      if (!readable) throw Object.assign(new Error('Missing membership'),{status:404})
      return {version:{revision:7,title:'Team copy',body}}
    },
  })
  t.after(()=>setSharedBotSocial(undefined))

  assert.equal((await bot.call('artifacts','POST',base('/studio-personal-copy','d'.repeat(32)),review)).status,404)
  assert.equal((await call({...review,body:'Untrusted browser content'})).status,400)
  assert.equal(reads,0)
  const {snapshot} = (await call(review)).body
  assert.equal(snapshot.body,body)
  assert.equal(snapshot.can_copy,true)
  assert.deepEqual((await bot.call('artifacts','GET',base('',personal))).body.items,[])
  const confirm = {...review,fingerprint:snapshot.fingerprint}
  readable = false
  assert.equal((await call(confirm)).status,404)
  readable = true
  body = 'Another body'
  assert.equal((await call(confirm)).status,409)
  body = '长'.repeat(8001)
  const long = (await call(review)).body.snapshot
  assert.equal(long.can_copy,false)
  assert.equal(long.body.length,8001)
  assert.equal((await call({...review,fingerprint:long.fingerprint})).status,413)
  body = snapshot.body
  const [first, second] = await Promise.all([call(confirm),call(confirm)])
  assert.deepEqual([first.status,second.status].sort(),[200,201])
  assert.equal(first.body.artifact.id,second.body.artifact.id)
  assert.equal(first.body.artifact.body,snapshot.body)
  assert.equal(first.body.artifact.source,undefined)
  readable = false
  assert.equal((await call(review)).status,404)
  assert.equal((await call(confirm)).body.artifact.id,first.body.artifact.id)
})

test('saved website, structured work and historical media copies keep their native content', async () => {
  const bot = await boot()
  const call = (...args) => bot.call('artifacts',...args)
  const payloads = [
    {title:'Website',kind:'website',body:'<h1>Blueprint</h1><style>h1{color:blue}</style>'},
    {title:'Slides',kind:'slides',slides:{schema:'flybot-workspace.slides.v1',slides:[{title:'First',bullets:['Important']}] }},
    {title:'Board',kind:'whiteboard',board:{schema:'flybot-workspace.whiteboard.v1',width:800,height:600,strokes:[]}},
    {title:'Dashboard',kind:'dashboard',dashboard:{schema:'flybot-workspace.dashboard.v1',widgets:[{type:'metric',title:'Total',value:'15'}]}},
    {title:'Workbook',kind:'spreadsheet',spreadsheet:{schema:'flybot-workspace.spreadsheet.v1',sheets:[
      {name:'Costs',rows:[['2'],['=SUM(A1:A1)']]},{name:'Notes',rows:[['Retained']]}]}},
  ]
  for (const payload of payloads) {
    const saved = await call('POST',base(),payload,key())
    assert.equal(saved.status,201,JSON.stringify(saved.body))
    const original = saved.body.artifact
    await call('POST',base('/'+original.id),{revision:1,changes:{title:original.title+' updated'}})
    const result = await call('POST',base(),{title:original.title+' copy',duplicate_from:{artifact_id:original.id,revision:1}},key())
    assert.equal(result.status,201,JSON.stringify(result.body))
    const copy = result.body.artifact
    const field = payload.kind === 'website' ? 'body' : payload.kind === 'whiteboard' ? 'board' : payload.kind
    assert.deepEqual([copy.kind,copy[field],copy.revision],[original.kind,original[field],1])
  }
  const upload = (title, bytes, filename, revision) => ({
    _multipart:true,fields:{title,...(revision ? {revision:String(revision)} : {})},
    files:{file:{filename,data:bytes.toString('base64')}},
  })
  const original = (await call('POST',base(),upload('Image',PNG,'original.png'),key())).body.artifact
  const path = '/' + original.id
  const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7','base64')
  assert.equal((await call('POST',base(path+'/file'),upload('Image',gif,'later.gif',1))).body.artifact.revision,2)
  const copied = await call('POST',base(),{title:'Earlier image',duplicate_from:{artifact_id:original.id,revision:1}},key())
  assert.equal(copied.status,201,JSON.stringify(copied.body))
  assert.equal(copied.body.artifact.media.filename,'original.png')
  await call('POST',base(path+'/remove'),{})
  const file = await call('GET',base('/'+copied.body.artifact.id+'/file'))
  assert.equal(file.status,200)
  assert.deepEqual(Buffer.from(file.download.data,'base64'),PNG)
})

test('document, website, slides, dashboard and whiteboard CRUD, favorites, versions, export and restore run in this DS-Bot', async (t) => {
  const published = new Set()
  let offline = false
  let revocations = 0
  setSharedBotSocial({
    request: async (method, path, snapshot) => {
      if (method === 'PUT') {
        published.add(snapshot.token_hash)
        return { published: true }
      }
      assert.equal(method, 'DELETE')
      revocations++
      if (offline) throw Error('controlled Bot Social outage')
      assert.ok(published.delete(path.split('/').at(-1)))
      return { revoked: true }
    },
  })
  t.after(() => setSharedBotSocial(undefined))
  const bot = await boot()
  const call = (...args) => bot.call('artifacts', ...args)
  const created = await call('POST', base(), { title: '周报', body: '本周完成迁移。', kind: 'document' }, key())
  assert.equal(created.status, 201, JSON.stringify(created.body))
  const doc = created.body.artifact
  assert.equal(doc.kind, 'document')
  assert.equal(doc.body, '本周完成迁移。')
  const listed = await call('GET', base() + '?q=周报')
  assert.equal(listed.body.items.length, 1)
  assert.equal(listed.body.items[0].body, undefined)
  assert.equal(listed.body.items[0].preview.type, 'document')
  assert.equal((await call('GET', base('/' + doc.id))).body.artifact.body, '本周完成迁移。')

  const stale = await call('POST', base('/' + doc.id), { revision: 9, changes: { body: 'x' } })
  assert.equal(stale.status, 409)
  assert.equal(stale.body.error.current.revision, 1)
  const edited = await call('POST', base('/' + doc.id), { revision: 1, changes: { body: '本周合入插件。' } })
  assert.equal(edited.body.artifact.revision, 2)
  const fav = await call('POST', base(`/${doc.id}/favorite`), { enabled: true })
  assert.equal(fav.body.favorited, true)
  assert.equal((await call('GET', base())).body.items[0].favorited, true)

  const history = await call('GET', base(`/${doc.id}/versions`))
  assert.ok(history.body.items.some((item) => item.revision === 1))
  const exported = await call('GET', base(`/${doc.id}/export`))
  assert.equal(exported.status, 200)
  assert.match(exported.download.content_type, /text\/plain/)
  assert.match(exported.text, /本周合入插件/)
  const office = await call('GET', base(`/${doc.id}/export?format=docx`))
  assert.equal(office.status, 200, JSON.stringify(office.body))
  assert.match(office.download.content_type, /wordprocessingml/)
  assert.equal((await call('GET', base(`/${doc.id}/export?format=xlsx`))).body.error.code, 'unsupported_export')
  const restored = await call('POST', base(`/${doc.id}/restore`), { revision: 2, to: 1 })
  assert.equal(restored.body.artifact.body, '本周完成迁移。')
  assert.equal(restored.body.artifact.revision, 3)

  const site = await call('POST', base(), { title: '站点', body: '<h1>你好</h1><script>alert(1)</script>', kind: 'website' }, key())
  assert.equal(site.body.artifact.kind, 'website')
  const preview = await call('GET', base(`/${site.body.artifact.id}/preview`))
  assert.equal(preview.status, 200)
  assert.match(preview.text, /你好/)
  assert.doesNotMatch(preview.text, /<script>/)

  const slides = await call('POST', base(), { title: '路演', kind: 'slides', slides: { schema: 'flybot-workspace.slides.v1', slides: [{ title: '第一页', bullets: ['要点'] }] } }, key())
  assert.equal(slides.body.artifact.kind, 'slides')
  assert.equal(slides.body.artifact.slides.slides[0].title, '第一页')
  const board = await call('POST', base(), { title: '草图', kind: 'whiteboard', board: { schema: 'flybot-workspace.whiteboard.v1', width: 800, height: 600, strokes: [] } }, key())
  assert.equal(board.body.artifact.kind, 'whiteboard')
  const dash = await call('POST', base(), { title: '指标', kind: 'dashboard', dashboard: { schema: 'flybot-workspace.dashboard.v1', widgets: [{ type: 'metric', title: '人数', value: '12', note: '' }] } }, key())
  assert.equal(dash.body.artifact.kind, 'dashboard')

  const staleShare = await call('POST', base(`/${doc.id}/shares`), {revision:2})
  assert.equal(staleShare.status,409)
  assert.equal(staleShare.body.error.code,'artifact_changed')
  assert.equal(published.size,0)
  assert.deepEqual((await call('GET',base(`/${doc.id}/shares`))).body.items,[])
  const share = await call('POST', base(`/${doc.id}/shares`), {revision:3})
  assert.equal(share.status, 201)
  assert.match(share.body.share.path, /^\/share\//)
  assert.equal(share.body.share.token.length, 43)
  assert.equal(share.body.share.revision,3)
  const listedShares = await call('GET', base(`/${doc.id}/shares`))
  assert.equal(listedShares.body.items.length, 1)
  assert.equal(listedShares.body.items[0].revision,3)
  assert.equal(listedShares.body.items[0].path, undefined)
  assert.equal(listedShares.body.items[0].token, undefined)
  const revokePath = base(`/${doc.id}/shares/${share.body.share.id}/revoke`)
  offline = true
  const pendingRevoke = await call('POST', revokePath, {})
  assert.equal(pendingRevoke.status, 503)
  assert.equal(pendingRevoke.body.error.code, 'share_revoke_unconfirmed')
  assert.equal(published.size, 1)
  const pending = (await call('GET', base(`/${doc.id}/shares`))).body.items[0]
  assert.equal(pending.revoked, false)
  assert.equal(pending.revocation_pending, true)
  offline = false
  const revoked = await call('POST', revokePath, {})
  assert.equal(revoked.body.share.revoked, true)
  assert.equal(revoked.body.share.revocation_pending, false)
  assert.equal(published.size, 0)
  assert.equal((await call('POST', revokePath, {})).body.share.revoked, true)
  assert.equal(revocations, 2)

  assert.equal((await call('POST', base(`/${doc.id}/remove`), {})).status, 200)
  assert.equal((await call('GET', base('/' + doc.id))).status, 404)
})

test('media upload is stored in this DS-Bot feature directory and is listed for resource search', async () => {
  const bot = await boot()
  const call = (...args) => bot.call('artifacts', ...args)
  const created = await call('POST', base(), {
    _multipart: true,
    fields: { title: '封面', kind: 'media' },
    files: { file: { filename: '色块 验收.png', content_type: 'image/png', data: PNG.toString('base64') } },
  }, key())
  assert.equal(created.status, 201, JSON.stringify(created.body))
  const item = created.body.artifact
  assert.equal(item.kind, 'media')
  assert.equal(item.media.filename, '色块 验收.png')
  assert.equal(item.media.mime, 'image/png')
  const imageCatalog = await call('GET', base() + '?type=image&type=video')
  assert.deepEqual(imageCatalog.body.items.map(row => row.id), [item.id])
  assert.deepEqual((await call('GET', base() + '?type=model3d')).body.items, [])
  const objects = join(bot.vol.data, 'flybot-workspace', 'features', 'artifacts', 'objects', WS)
  assert.ok(existsSync(objects))
  const file = await call('GET', base(`/${item.id}/file`))
  assert.equal(file.status, 200)
  assert.equal(file.download.content_type, 'image/png')
  assert.equal(file.download.filename, '色块 验收.png')
  const exported = await call('GET', base(`/${item.id}/export`))
  assert.equal(exported.download.filename, '色块 验收.png')
  const files = await bot.endpoint('artifacts/files', { workspace_id: WS, q: '封面', limit: 20 })
  assert.equal(files.ok, true)
  assert.equal(files.value.items[0].id, item.id)
  assert.match(files.value.items[0].href, /\/file$/)
  const viaSearch = await bot.call('search', 'GET', `/v1/workspaces/${WS}/search/resources?kind=files&q=封面`)
  assert.equal(viaSearch.status, 200)
  assert.equal(viaSearch.body.items[0].id, item.id)
  const all = await bot.endpoint('search/all', { q: '封面' })
  assert.equal(all.value.items[0].kind, 'artifact')
})

test('ordinary uploads remain scoped download-only files and retry from the original receipt', async () => {
  const bot = await boot()
  const call = (...args) => bot.call('artifacts', ...args)
  const raw = Buffer.from('<h1>Saved source file</h1>')
  const input = {
    _multipart: true,
    fields: {title:'附加参考', kind:'media', allow_file:'1'},
    files: {file:{filename:'参考说明.html', content_type:'text/html', data:raw.toString('base64')}},
  }
  const requestKey = key()
  const created = await call('POST', base(), input, requestKey)
  assert.equal(created.status, 201)
  const item = created.body.artifact
  assert.equal(item.media.mime, 'application/octet-stream')
  const retried = await call('POST', base(), input, requestKey)
  assert.equal(retried.status, 200)
  assert.equal(retried.body.artifact.id, item.id)
  const download = await call('GET', base(`/${item.id}/file`))
  assert.equal(download.download.content_type, 'application/octet-stream')
  assert.equal(download.download.filename, '参考说明.html')
  assert.ok(!download.download.inline)
  assert.deepEqual(Buffer.from(download.download.data, 'base64'), raw)
  assert.deepEqual((await call('GET', base() + '?type=file')).body.items.map(row=>row.id), [item.id])
  assert.deepEqual((await call('GET', base() + '?type=image')).body.items, [])
  const outsider = await boot()
  assert.equal((await outsider.call('artifacts', 'GET', base(`/${item.id}/file`))).status, 404)
})

test('artifact data stays in this volume; another DS-Bot never sees it', async () => {
  const vol = volume()
  const first = await boot(vol)
  const created = await first.call('artifacts', 'POST', base(), { title: '仅此卷', body: '私有', kind: 'document' }, key())
  assert.equal((await boot(vol).then((bot) => bot.call('artifacts', 'GET', base('/' + created.body.artifact.id)))).status, 200)
  const other = await boot()
  assert.equal((await other.call('artifacts', 'GET', base('/' + created.body.artifact.id))).status, 404)
  assert.equal((await other.call('artifacts', 'GET', base())).body.items.length, 0)
})

test('Space catalog paginates through Unicode title matches and keeps scoped previews and favorites', async () => {
  const bot = await boot()
  const call = (...args) => bot.call('artifacts', ...args)
  async function create(title, workspace = WS) {
    const result = await call('POST', base('', workspace), { title, body: '# 草稿\n目录预览', kind: 'document' }, key())
    assert.equal(result.status, 201)
    return result.body.artifact.id
  }
  const ids = await Promise.all(['Äpfel 案例', '普通案例', 'ÄPFEL 摘要', '又一个 äpfel 草图'].map((title) => create(title)))
  await create('ÄPFEL 其他空间', 'b'.repeat(32))
  await call('POST', base(`/${ids[2]}/favorite`), { enabled: true })
  const expected = [ids[0], ids[2], ids[3]].sort()
  const allFirst = (await call('GET', base() + '?limit=2')).body
  assert.deepEqual(allFirst.items.map((item) => item.id), ids.slice().sort().slice(0, 2))
  assert.equal(allFirst.cursor, allFirst.items[1].id)
  const searchPath = base() + '?limit=2&q=' + encodeURIComponent(' ÄPFEL ')
  const first = (await call('GET', searchPath)).body
  assert.deepEqual(first.items.map((item) => item.id), expected.slice(0, 2))
  assert.equal(first.cursor, expected[1])
  const last = (await call('GET', searchPath + '&cursor=' + first.cursor)).body
  assert.deepEqual(last.items.map((item) => item.id), expected.slice(2))
  assert.equal(last.cursor, null)
  for (const item of [...first.items, ...last.items]) {
    assert.equal(item.body, undefined)
    assert.equal(item.preview.heading, '草稿')
    assert.equal(item.favorited, item.id === ids[2])
  }
  assert.equal(first.activity_version, allFirst.activity_version)
  assert.equal(last.activity_version, allFirst.activity_version)
})

test('Space catalog finds deep document and structured text with bounded original match offsets', async () => {
  const bot = await boot()
  const call = (...args) => bot.call('artifacts', ...args)
  async function create(fields, workspace = WS) {
    const result = await call('POST', base('', workspace), fields, key())
    assert.equal(result.status, 201, JSON.stringify(result.body))
    return result.body.artifact.id
  }
  const document = await create({
    title: '全文归档',
    body: `${'😀 普通前文 '.repeat(90)} İSTANBUL \n星海季度更新 ${'😀 普通后文 '.repeat(90)}`,
  })
  const site = await create({
    title: '发布站点', kind: 'website',
    body: [
      '<h1 data-label="attribute-secret">星海<strong>季度</strong>更新 &amp; 明细</h1>',
      '<script>const script-secret = "private"</script><style>.style-secret{display:none}</style>',
      '<span hidden><b>hidden-secret</b></span>',
      '<div style="color:red; display: none">css-hidden-secret</div>',
      '<template><template>template-secret</template>nested-hidden-secret</template>',
      '<!-- comment-secret --><script>unclosed-secret',
    ].join(''),
  })
  const slides = await create({
    title: '路演', kind: 'slides',
    slides: {schema:'flybot-workspace.slides.v1', slides:[
      {title:'首页', bullets:['背景']},
      {title:'收尾', bullets:['星海季度更新']},
    ]},
  })
  const sheet = await create({
    title:'账簿', kind:'spreadsheet', spreadsheet:{schema:'flybot-workspace.spreadsheet.v1',sheets:[
      {name:'模板',rows:[['汇总轴']]}, {name:'第二工作表',rows:[['A列','星海季度更新']]},
    ]},
  })
  await create({
    title:'项目看板', kind:'dashboard', dashboard:{schema:'flybot-workspace.dashboard.v1',widgets:[
      {type:'metric', title:'总体', value:'8', note:'已验收'},
      {type:'bar', title:'投入', labels:['业务支持'], values:[10]},
      {type:'table', title:'本周', columns:['事项'], rows:[['星海季度更新']]},
    ]},
  })
  await create({
    title:'方案草图', kind:'whiteboard', board:{width:800, height:600, strokes:[
      {id:'shape-text',type:'text',x:30,y:40,text:'星海季度更新'},
    ]},
  })
  const photo = await create({_multipart:true, fields:{title:'封面'},
    files:{file:{filename:'star-quarter-map.png',content_type:'image/png',data:PNG.toString('base64')}}})
  await create({title:'其他工作区',body:'星海季度更新'}, 'b'.repeat(32))

  const list = async (query, options = {}) => {
    const params = new URLSearchParams({order:'recent',q:query,...options})
    const result = await call('GET', base('?' + params))
    assert.equal(result.status,200)
    return result.body
  }
  const first = await list('星海季度更新', {limit:2})
  const second = await list('星海季度更新', {limit:2,cursor:first.cursor})
  const third = await list('星海季度更新', {limit:2,cursor:second.cursor})
  const matches = [...first.items,...second.items,...third.items]
  assert.equal(third.cursor,null)
  assert.equal(new Set(matches.map(item => item.id)).size,6)
  assert.equal(first.activity_version,third.activity_version)
  for (const item of matches) {
    assert.equal(item.workspace_id,WS)
    assert.equal(item.body,undefined)
    assert.equal(item.match.kind,'body')
    assert.equal(item.match.text.slice(item.match.start,item.match.end),'星海季度更新')
    assert.ok(item.match.text.length <= 160)
    assert.ok(!/[\uD800-\uDBFF]$|^[\uDC00-\uDFFF]/u.test(item.match.text))
  }
  const unicode = (await list(' İstanbul 星海季度更新 ')).items[0]
  assert.equal(unicode.id,document)
  assert.equal(unicode.match.text.slice(unicode.match.start,unicode.match.end),'İSTANBUL 星海季度更新')
  assert.ok(unicode.match.text.startsWith('…'))
  assert.equal((await list('星海季度更新 & 明细')).items[0].id,site)
  assert.match((await list('星海季度更新',{kind:'website'})).items[0].match.text, /& 明细/)
  assert.deepEqual((await list('secret')).items,[])
  const filename = await list('quarter-map', {type:'image'})
  assert.deepEqual(filename.items.map(item => item.id),[photo])
  assert.deepEqual(filename.items[0].match,{kind:'filename',text:'star-quarter-map.png',start:5,end:16})

  await call('POST',base('/' + slides + '/favorite'),{enabled:true})
  await call('POST',base('/' + sheet + '/favorite'),{enabled:true})
  assert.deepEqual((await list('星海季度更新',{scope:'favorites',type:'slides'})).items.map(item => item.id),[slides])
  const updated = await call('POST',base('/' + document),{revision:1,changes:{body:'更新后的关键词'}})
  assert.equal(updated.status,200)
  assert.ok(!(await list('星海季度更新')).items.some(item => item.id === document))
  assert.deepEqual((await list('更新后的关键词')).items.map(item => item.id),[document])
  assert.ok((await list('')).items.every(item => !Object.hasOwn(item,'match')))
})

test('Space recent pages, scopes and facets include matches beyond the first page', async () => {
  const bot = await boot()
  const call = (...args) => bot.call('artifacts', ...args)
  async function create(title, fields = {}, workspace = WS) {
    const result = await call('POST', base('', workspace), {
      title, body: '测试', kind: 'document', ...fields,
    }, key())
    assert.equal(result.status, 201, JSON.stringify(result.body))
    return result.body.artifact.id
  }
  const old = await create('旧站点', { kind: 'website' })
  const message = await create('对话摘录', { source: {
    kind: 'agent_message', id: 'b'.repeat(32), conversation_id: 'c'.repeat(32), conversation_title: '产品周会',
  } })
  const memory = await create('记忆产出', { source: {kind: 'agent_task', id: 'd'.repeat(32), task_kind: 'memory'} })
  const newer = await Promise.all(Array.from({length: 20}, (_, i) => create('新作品 ' + i)))
  const otherSpace = 'f'.repeat(32)
  const other = await create('另一个工作区', { source: {
    kind: 'agent_message', id: 'd'.repeat(32), conversation_id: 'e'.repeat(32), conversation_title: '内部讨论',
  } }, otherSpace)
  const db = new DatabaseSync(join(bot.vol.data, 'flybot-workspace', 'features', 'artifacts', 'artifacts.sqlite3'))
  try {
    db.prepare('UPDATE artifacts SET updated=3 WHERE workspace_id=?').run(WS)
    db.prepare('UPDATE artifacts SET updated=1 WHERE id=?').run(old)
    db.prepare('UPDATE artifacts SET updated=2 WHERE id IN (?,?)').run(message, memory)
    const nativeCreator = db.prepare('SELECT created_by FROM artifacts WHERE id=?').get(newer[0]).created_by
    db.prepare('INSERT INTO ot_users VALUES (?,?,0)').run(nativeCreator, 'qa-owner')
    db.prepare("INSERT INTO ot_users VALUES ('legacy-owner','qa-owner',1), ('legacy-friend','qa-friend',0), ('other-author','qa-other',0)").run()
    db.prepare("UPDATE artifacts SET created_by='legacy-owner' WHERE id=?").run(message)
    db.prepare("UPDATE artifacts SET created_by='legacy-friend' WHERE id=?").run(old)
    db.prepare("UPDATE artifacts SET created_by='other-author' WHERE id=?").run(other)
  } finally {
    db.close()
  }
  await call('POST', base('/' + old + '/favorite'), {enabled: true})
  await call('POST', base('/' + message + '/favorite'), {enabled: true})
  await call('POST', base('/' + other + '/favorite', otherSpace), {enabled: true})
  const list = (query, workspace) => call('GET', base('?' + query, workspace))
  const ids = result => result.body.items.map(row => row.id)
  const first = await list('order=recent')
  assert.deepEqual(ids(first), newer.toSorted())
  assert.equal(first.body.cursor, ids(first).at(-1))
  const rest = await list('order=recent&cursor=' + first.body.cursor)
  assert.deepEqual(ids(rest), [...[message, memory].sort(), old])
  assert.equal(rest.body.cursor, null)
  assert.equal(rest.body.activity_version, first.body.activity_version)
  const starred = await list('order=recent&scope=favorites&limit=1')
  assert.deepEqual(ids(starred), [message])
  assert.deepEqual(ids(await list('order=recent&scope=favorites&cursor=' + starred.body.cursor)), [old])
  assert.deepEqual(ids(await list('order=recent&kind=messages&scope=favorites&q=对话')), [message])
  assert.deepEqual(ids(await list('order=recent&kind=website&scope=favorites')), [old])
  assert.deepEqual(ids(await list('scope=memory')), [memory])
  assert.deepEqual(ids(await list('scope=mine&kind=messages')), [message])
  assert.deepEqual(ids(await list('scope=mine&kind=website')), [])
  assert.deepEqual(ids(await list('order=recent&cursor=' + other)), [])
  const matched = await list('order=recent&scope=favorites&type=website&type=messages&creator=qa-friend&creator=qa-owner&updated_since=1&updated_before=3&limit=1')
  assert.deepEqual(ids(matched), [message])
  assert.deepEqual(ids(await list('order=recent&scope=favorites&type=website&type=messages&creator=qa-friend&creator=qa-owner&updated_since=1&updated_before=3&cursor=' + matched.body.cursor)), [old])
  assert.deepEqual(ids(await list('type=document&updated_since=2&updated_before=3')), [memory])
  assert.deepEqual(ids(await list('type=messages&updated_since=2&updated_before=3&session=' + 'c'.repeat(32) +
    '&session=' + 'e'.repeat(32) + '&q=对话')), [message])
  assert.deepEqual(ids(await list('creator=qa-friend&updated_since=-86400&updated_before=2')), [old])
  assert.deepEqual((await list('facets=1')).body, {
    creators: ['qa-friend','qa-owner'], sessions: [{id: 'c'.repeat(32), label: '产品周会'}],
  })
  assert.deepEqual((await list('facets=1', otherSpace)).body, {
    creators: ['qa-other'], sessions: [{id: 'e'.repeat(32), label: '内部讨论'}],
  })
  for (const bad of ['facets=1&q=x', 'facets=1&facets=1', 'kind=wrong', 'scope=foreign', 'order=title',
    'type=pdf', 'creator=', 'session=%0A', 'updated_since=NotADate', 'updated_since=2.5',
    'updated_since=3&updated_before=2', 'updated_since=2&updated_since=3']) {
    assert.equal((await list(bad)).status, 400)
  }
  const edited = await call('POST', base('/' + old), {revision: 1, changes: {title: '更新后的站点'}})
  assert.equal(edited.status, 200)
  const latest = await list('order=recent&limit=1')
  assert.deepEqual(ids(latest), [old])
  assert.notEqual(latest.body.activity_version, first.body.activity_version)
})

test('Space automation scope filters before pagination and retains the exact saved run', async () => {
  const bot = await boot()
  const call = (...args) => bot.call('artifacts', ...args)
  const automation = 'b'.repeat(32)
  const firstRun = 'c'.repeat(32)
  const secondRun = 'd'.repeat(32)
  const otherSpace = 'f'.repeat(32)
  async function create(title, workspace = WS, run) {
    const source = run && {kind:'automation_run', id:run, automation_id:automation, automation_title:'整理日报'}
    const result = await call('POST', base('', workspace),
      {title, body:'一份自动化结果', ...(source && {source})}, key())
    assert.equal(result.status, 201, JSON.stringify(result.body))
    return result.body.artifact
  }
  const first = await create('日结', WS, firstRun)
  const second = await create('周报', WS, secondRun)
  await create('手工整理')
  const foreign = await create('其他工作区', otherSpace, firstRun)
  const query = 'scope=automation&order=recent&limit=1'
  const page = await call('GET', base('?' + query))
  assert.equal(page.status, 200)
  assert.equal(page.body.cursor, page.body.items[0].id)
  const rest = await call('GET', base('?' + query + '&cursor=' + page.body.cursor))
  assert.equal(rest.body.cursor, null)
  const artifacts = [...page.body.items, ...rest.body.items]
  assert.deepEqual(new Set(artifacts.map(item => item.id)), new Set([first.id, second.id]))
  assert.deepEqual(artifacts.find(item => item.id === first.id).source, first.source)
  const filtered = await call('GET', base('?' + query + '&type=document&q=周报'))
  assert.deepEqual(filtered.body.items.map(item => item.id), [second.id])
  const other = await call('GET', base('?' + query, otherSpace))
  assert.deepEqual(other.body.items.map(item => item.id), [foreign.id])
})

test('Space activity tracks saved revisions and favorites only in this owner and workspace', async () => {
  const bot = await boot()
  const another = await boot()
  const secondWorkspace = 'b'.repeat(32)
  const call = (...args) => bot.call('artifacts', ...args)
  const activity = async (id, workspace = WS) => {
    const result = await call('GET', base('/activity', workspace) + (id ? '?artifact=' + id : ''))
    assert.equal(result.status, 200)
    assert.match(result.body.version, /^[a-f0-9]{64}$/)
    return result.body
  }
  const before = await activity()
  assert.deepEqual(Object.keys(before), ['version'])
  const otherScope = await activity(null, secondWorkspace)
  assert.notEqual(otherScope.version, before.version)

  const created = await call('POST', base(), {title: 'Private work', body: 'Unexposed draft'}, key())
  assert.equal(created.status, 201)
  const id = created.body.artifact.id
  const createdActivity = await activity(id)
  assert.deepEqual(Object.keys(createdActivity), ['version', 'revision'])
  assert.equal(createdActivity.revision, 1)
  assert.notEqual(createdActivity.version, before.version)
  const filtered = await call('GET', base() + '?q=empty&limit=1')
  assert.equal(filtered.body.items.length, 0)
  assert.equal(filtered.body.activity_version, createdActivity.version)
  assert.deepEqual(await activity(id, secondWorkspace), {version: otherScope.version, revision: null})

  const foreign = await another.call('artifacts', 'GET', base('/activity') + '?artifact=' + id)
  assert.deepEqual(foreign.body, {version: before.version, revision: null})
  await call('POST', base('/' + id), {revision: 1, changes: {title: 'Edited'}})
  const edited = await activity(id)
  assert.equal(edited.revision, 2)
  assert.notEqual(edited.version, createdActivity.version)

  await call('POST', base(`/${id}/favorite`), {enabled: true})
  const favorite = await activity(id)
  assert.equal(favorite.revision, edited.revision)
  assert.notEqual(favorite.version, edited.version)
  await call('POST', base(`/${id}/favorite`), {enabled: true})
  assert.deepEqual(await activity(id), favorite)
  await call('POST', base(`/${id}/remove`), {})
  assert.deepEqual(await activity(id), {version: before.version, revision: null})
  for (const query of ['?foo=bar', '?artifact=bad', '?artifact=' + id + '&artifact=' + id]) {
    assert.equal((await call('GET', base('/activity') + query)).status, 400)
  }
  assert.equal((await call('POST', base('/activity'), {})).status, 400)
})

test('chat and automation sources attach on create and are idempotent by source', async () => {
  const bot = await boot()
  const payload = {
    title: '对话存档', body: '结论。', kind: 'document',
    source: { kind: 'agent_message', id: 'b'.repeat(32), conversation_id: 'c'.repeat(32), conversation_title: '周报助手' },
  }
  const first = await bot.endpoint('artifacts/create', { ...payload, workspace_id: WS, idempotency_key: key() })
  assert.equal(first.ok, true, JSON.stringify(first))
  assert.equal(first.value.artifact.source.kind, 'agent_message')
  assert.equal(first.value.artifact.source.conversation_title, '周报助手')
  const again = await bot.endpoint('artifacts/create', { ...payload, title: '另一标题', workspace_id: WS, idempotency_key: key() })
  assert.equal(again.value.artifact.id, first.value.artifact.id)
})

test('one test account\'s legacy artifacts import into its DS-Bot only', async () => {
  const { bundles, expect } = legacyBundles(['artifacts'])
  const vol = volume()
  deliverBundle(vol, 'artifacts-1.bundle', bundles.artifacts)
  const bot = await boot(vol)
  assert.deepEqual((await bot.endpoint('artifacts/routes')).value.imported.map((item) => item.status), ['imported'])
  const wid = expect.workspace_id
  const item = await bot.call('artifacts', 'GET', `/v1/workspaces/${wid}/artifacts/${expect.artifacts.artifact_id}`)
  assert.equal(item.status, 200)
  assert.equal(item.body.artifact.body, expect.artifacts.body)
  const listed = await bot.call('artifacts', 'GET', `/v1/workspaces/${wid}/artifacts?q=bob`)
  assert.equal(listed.body.items.length, 0)
  const other = await boot()
  assert.equal((await other.call('artifacts', 'GET', `/v1/workspaces/${wid}/artifacts/${expect.artifacts.artifact_id}`)).status, 404)
})

test('chat attachments export the selected saved version and require an internal caller', async () => {
  const bot = await boot()
  const created = await bot.call('artifacts','POST',base(),{title:'发给群聊',kind:'document',body:'Saved version one'},key())
  const artifact = created.body.artifact
  const input = {workspace_id:WS,artifact_id:artifact.id,revision:1}
  assert.equal((await bot.endpoint('artifacts/chatAttachment',input)).error.code, 'forbidden')
  await bot.call('artifacts','POST',base('/'+artifact.id),{revision:1,changes:{title:'新标题',body:'Saved version two'}})
  const resolve = data => bot.features.table['artifacts/chatAttachment'](data,{internal:true})
  const snapshot = await resolve(input)
  const historical = await bot.call('artifacts','GET',base('/'+artifact.id+'/versions/1/export?format=docx'))
  assert.deepEqual(Buffer.from(snapshot.attachment.data,'base64'),Buffer.from(historical.download.data,'base64'))
  assert.equal(snapshot.body,'发给群聊 · 版本 1')
  assert.equal(snapshot.context_excerpt,'Saved version one')
  assert.equal(snapshot.attachment.title,'发给群聊-v1.docx')
  assert.deepEqual(snapshot.attachment.resource,{kind:'document',title:'发给群聊',revision:1})
  const {attachment:updated,context_excerpt:excerpt} = await resolve({...input,revision:2})
  assert.equal(excerpt,'Saved version two')
  assert.deepEqual(updated.resource,{kind:'document',title:'新标题',revision:2})
  assert.notEqual(updated.data,snapshot.attachment.data)
  await assert.rejects(resolve({...input,workspace_id:'f'.repeat(32)}),error=>error.status===404)
  await assert.rejects(resolve({...input,revision:3}),error=>error.status===404)
  const examples = [
    [{title:'网页',kind:'website',body:'<h1>标题</h1><script>alert(1)</script>'}, 'txt', /text\/plain/],
    [{title:'白板',kind:'whiteboard'}, 'json', /application\/json/],
    [{title:'幻灯片',kind:'slides',slides:{schema:'flybot-workspace.slides.v1',slides:[{title:'开场',bullets:['计划']}]}}, 'pptx', /presentationml/],
    [{title:'工作表',kind:'dashboard',dashboard:{schema:'flybot-workspace.dashboard.v1',widgets:[{type:'metric',title:'参会人数',value:'3',note:''}]}}, 'xlsx', /spreadsheetml/],
    [{_multipart:true,fields:{title:'封面图'},files:{file:{filename:'dot.png',content_type:'image/png',data:PNG.toString('base64')}}}, 'png', /image\/png/],
  ]
  for (const [payload, suffix, mime] of examples) {
    const result = await bot.call('artifacts','POST',base(),payload,key())
    assert.equal(result.status,201,JSON.stringify(result.body))
    const {attachment,context_excerpt} = await resolve({...input,artifact_id:result.body.artifact.id})
    assert.ok(attachment.title.endsWith('.' + suffix))
    assert.match(attachment.mime,mime)
    assert.deepEqual(attachment.resource,{kind:result.body.artifact.kind,title:result.body.artifact.title,revision:1})
    if (suffix === 'txt') assert.doesNotMatch(Buffer.from(attachment.data,'base64').toString(), /<script>/)
    if (suffix === 'pptx') assert.equal(context_excerpt,'开场 计划')
    if (suffix === 'xlsx') assert.equal(context_excerpt?.trim(),'参会人数 3')
    if (suffix === 'png') assert.equal(context_excerpt,undefined)
  }
})

test('native workbook versions preserve distinct worksheets and Excel treats unsupported formulas as text', async () => {
  const bot = await boot()
  const call = (...args) => bot.call('artifacts', ...args)
  const spreadsheet = {schema:'flybot-workspace.spreadsheet.v1',sheets:[
    {name:'明细',rows:[['商品','金额'],['笔','12.50'],['胶水','7'],['总计','=sum(B2:B3)']]},
    {name:'库存',rows:[['编号','备注'],['00123','=HYPERLINK("https://example.test/","link")']]},
  ]}
  const payload = {title:'采购清单',kind:'spreadsheet',spreadsheet}
  const invalid = await call('POST',base(),{
    ...payload,spreadsheet:{...spreadsheet,sheets:[{name:'Sheet',rows:[]},{name:'sheet',rows:[]}]},
  },key())
  assert.equal(invalid.status,400)
  const created = await call('POST',base(),payload,key())
  assert.equal(created.status,201,JSON.stringify(created.body))
  const {artifact} = created.body
  const route = '/' + artifact.id
  assert.equal(artifact.kind,'spreadsheet')
  assert.deepEqual(artifact.spreadsheet,spreadsheet)
  assert.equal((await call('GET',base())).body.items[0].spreadsheet,undefined)
  const updated = structuredClone(spreadsheet)
  updated.sheets[0].rows[1][1] = '15'
  assert.equal((await call('POST',base(route),{revision:1,changes:{spreadsheet:updated}})).body.artifact.revision,2)
  const stale = await call('POST',base(route),{revision:1,changes:{spreadsheet}})
  assert.equal(stale.status,409)
  const history = await call('GET',base(route+'/versions'))
  assert.equal(history.status,200)
  assert.deepEqual(history.body.items.map(({revision,kind}) => [revision,kind]), [[2,'spreadsheet'],[1,'spreadsheet']])
  for (const revision of history.body.items) {
    assert.equal(revision.created_by,artifact.created_by)
    assert.equal(revision.spreadsheet,undefined)
  }
  const historical = await call('GET',base(route+'/versions/1/export'))
  assert.equal(historical.status,200)
  assert.match(historical.download.content_type,/spreadsheetml/)
  const bytes = Buffer.from(historical.download.data,'base64')
  const parts = new Map()
  for (let offset=0; bytes.readUInt32LE(offset) === 0x04034b50;) {
    const nameAt = offset+30
    const dataAt = nameAt+bytes.readUInt16LE(offset+26)+bytes.readUInt16LE(offset+28)
    const next = dataAt+bytes.readUInt32LE(offset+18)
    parts.set(bytes.toString('utf8',nameAt,dataAt),inflateRawSync(bytes.subarray(dataAt,next)).toString())
    offset = next
  }
  assert.match(parts.get('xl/workbook.xml'),/name="明细".*name="库存"/)
  assert.match(parts.get('xl/worksheets/sheet1.xml'),/<c r="B2"><v>12\.50<\/v><\/c>/)
  assert.match(parts.get('xl/worksheets/sheet1.xml'),/<f>SUM\(B2:B3\)<\/f>/)
  assert.match(parts.get('xl/worksheets/sheet2.xml'),/<t xml:space="preserve">00123<\/t>/)
  assert.match(parts.get('xl/worksheets/sheet2.xml'),/<t xml:space="preserve">=HYPERLINK/)
  assert.doesNotMatch(parts.get('xl/worksheets/sheet2.xml'),/<f>/)
  const attachment = await bot.features.table['artifacts/chatAttachment']({
    workspace_id:WS,artifact_id:artifact.id,revision:1,
  },{internal:true})
  assert.equal(attachment.attachment.title,'采购清单-v1.xlsx')
  assert.equal(attachment.attachment.data,historical.download.data)
  const restored = await call('POST',base(route+'/restore'),{revision:2,to:1})
  assert.equal(restored.body.artifact.revision,3)
  assert.deepEqual(restored.body.artifact.spreadsheet,spreadsheet)
  const preview = await call('GET',base(route+'/preview'))
  assert.match(preview.text,/<td>12\.50<\/td>/)
})

test('generated MP4 above the ordinary media upload limit can be viewed, exported and sent', async () => {
  const bot = await boot()
  const resolve = bot.features.table['artifacts/generatedVideo']
  const job_id = '7'.repeat(32)
  const payload = {workspace_id: WS, job_id}
  const video = Buffer.alloc(2 * 1024 * 1024 + 20)
  video.write('ftypisom', 4)
  await assert.rejects(resolve({...payload, title: '未授权', data: video}, {}), error => error.status === 404)
  await assert.rejects(resolve({...payload, title: '格式错误', data: PNG}, {internal: true}), error => error.status === 400)
  const saved = await resolve({...payload, title: '生成视频', data: video}, {internal: true})
  assert.equal((await resolve(payload, {internal: true})).id, saved.id)
  const content = await bot.call('artifacts', 'GET', base('/' + saved.id + '/file'))
  assert.equal(content.download.inline, true)
  assert.equal(content.download.content_type, 'video/mp4')
  assert.deepEqual(Buffer.from(content.download.data, 'base64'), video)
  const exported = await bot.call('artifacts', 'GET', base('/' + saved.id + '/export'))
  assert.equal(exported.download.data, content.download.data)
  const share = await bot.features.table['artifacts/chatAttachment']({
    workspace_id: WS, artifact_id: saved.id, revision: 1,
  }, {internal: true})
  assert.equal(share.attachment.mime, 'video/mp4')
  assert.equal(share.attachment.data, content.download.data)
})

test('generated MP3 is saved once and keeps the original bytes for playback and sharing', async () => {
  const bot = await boot()
  const resolve = bot.features.table['artifacts/generatedMusic']
  const payload = {workspace_id: WS, job_id: '8'.repeat(32)}
  const music = Buffer.alloc(576)
  music.set([0xff, 0xfa, 0xb4, 0x04])
  await assert.rejects(resolve({...payload, title: '未授权', data: music}, {}), error => error.status === 404)
  await assert.rejects(resolve({...payload, title: '格式错误', data: PNG}, {internal: true}), error => error.status === 400)
  const {id} = await resolve({...payload, title: '生成音乐', data: music}, {internal: true})
  assert.equal((await resolve(payload, {internal: true})).id, id)
  assert.equal((await resolve({...payload, title: '重复音乐', data: music}, {internal: true})).id, id)
  const content = await bot.call('artifacts', 'GET', base('/' + id + '/file'))
  assert.equal(content.download.inline, true)
  assert.equal(content.download.content_type, 'audio/mpeg')
  assert.deepEqual(Buffer.from(content.download.data, 'base64'), music)
  const share = await bot.features.table['artifacts/chatAttachment']({
    workspace_id: WS, artifact_id: id, revision: 1,
  }, {internal: true})
  assert.equal(share.attachment.mime, 'audio/mpeg')
  assert.match(share.attachment.title, /\.mp3$/)
  assert.equal(share.attachment.data, content.download.data)
})

test('generated GLB can be viewed, downloaded and attached to chat above the usual media limit', async () => {
  const bot = await boot()
  const generate = bot.features.table['artifacts/generatedModel3d']
  const request = {workspace_id: WS, job_id: '9'.repeat(32)}
  const data = triangleGlb({byteLength: 2 * 1024 * 1024 + 4})
  await assert.rejects(generate({...request, title: '未授权', data}, {}), {status: 404})
  const {id} = await generate({...request, title: '3D 模型', data}, {internal: true})
  assert.equal((await generate(request, {internal: true})).id, id)
  const view = await bot.call('artifacts', 'GET', base('/' + id + '/file'))
  assert.equal(view.download.inline, true)
  assert.equal(view.download.content_type, 'model/gltf-binary')
  assert.deepEqual(Buffer.from(view.download.data, 'base64'), data)
  const exported = await bot.call('artifacts', 'GET', base('/' + id + '/export'))
  assert.equal(exported.download.data, view.download.data)
  const share = await bot.features.table['artifacts/chatAttachment']({
    workspace_id: WS, artifact_id: id, revision: 1,
  }, {internal: true})
  assert.equal(share.attachment.mime, 'model/gltf-binary')
  assert.match(share.attachment.title, /\.glb$/)
  assert.equal(share.attachment.data, view.download.data)
})


test('generated website is saved as an editable artifact and can be recovered by job ID', async () => {
  const bot = await boot()
  const generate = bot.features.table['artifacts/generatedWebsite']
  const request = {workspace_id: WS, job_id: 'b'.repeat(32)}
  const internal = {internal: true}
  const html = '<!doctype html><title>Demo</title><button>Count</button>'
  await assert.rejects(generate({...request, title: 'Demo', body: html}, {}), {status: 404})
  assert.equal(await generate(request, internal), null)
  const saved = await generate({...request, title: 'Demo', body: html}, internal)
  assert.equal((await generate(request, internal)).id, saved.id)
  assert.equal((await generate({...request, title: 'Retry', body: html}, internal)).id, saved.id)
  const detail = await bot.call('artifacts', 'GET', base('/' + saved.id))
  assert.equal(detail.status, 200)
  assert.equal(detail.body.artifact.kind, 'website')
  assert.equal(detail.body.artifact.title, 'Demo')
  assert.equal(detail.body.artifact.body, html)
  assert.equal(detail.body.artifact.revision, 1)
})

test('website iframe renders only the selected saved revision with an opaque script sandbox', async () => {
  const bot = await boot()
  const html = '<!doctype html><title>Demo</title><button>Count</button><script>document.title = "Active"</script>'
  const site = await bot.call('artifacts', 'POST', base(), { title: '互动网页', kind: 'website', body: html }, key())
  assert.equal(site.status, 201, JSON.stringify(site.body))
  const path = base('/' + site.body.artifact.id)
  const dispatch = createLegacyDispatch({ endpoints: bot.features.table })
  const open = (path, query = '') => {
    const url = new URL(LEGACY_PATH, 'http://127.0.0.1')
    url.search = new URLSearchParams({ feature: 'artifacts', path, query })
    return dispatch(new Request(url))
  }
  const preview = await open(path + '/preview', 'revision=1')
  assert.equal(preview.status, 200)
  assert.equal(await preview.text(), html)
  assert.equal(preview.headers.get('content-type'), 'text/html; charset=utf-8')
  assert.equal(preview.headers.get('cache-control'), 'private, no-store')
  assert.equal(preview.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(preview.headers.get('referrer-policy'), 'no-referrer')
  const csp = preview.headers.get('content-security-policy')
  assert.match(csp, /(?:^|; )sandbox allow-scripts(?:;|$)/)
  assert.match(csp, /frame-ancestors 'self'/)
  assert.match(csp, /connect-src 'none'/)
  assert.match(csp, /form-action 'none'/)
  assert.doesNotMatch(csp, /allow-same-origin|allow-top-navigation|allow-popups/)

  const staticPreview = await open(path + '/preview')
  assert.equal(staticPreview.status, 200)
  assert.doesNotMatch(await staticPreview.text(), /<script>/)
  assert.doesNotMatch(staticPreview.headers.get('content-security-policy'), /allow-scripts/)
  const exported = await open(path + '/export')
  assert.equal(exported.status, 200)
  assert.match(exported.headers.get('content-disposition'), /^attachment/)
  assert.doesNotMatch(exported.headers.get('content-security-policy'), /allow-scripts/)
  assert.equal((await open(path + '/preview', 'revision=1&revision=1')).status, 400)
  assert.equal((await open(path + '/preview', 'revision=2')).status, 409)

  const updated = await bot.call('artifacts', 'POST', path, { revision: 1, changes: { body: '<h1>Saved again</h1>' } })
  assert.equal(updated.status, 200)
  assert.equal((await open(path + '/preview', 'revision=1')).status, 409)
  assert.equal(await (await open(path + '/preview', 'revision=2')).text(), '<h1>Saved again</h1>')
  assert.equal((await open(base('/' + site.body.artifact.id + '/preview', 'b'.repeat(32)), 'revision=2')).status, 404)
})
