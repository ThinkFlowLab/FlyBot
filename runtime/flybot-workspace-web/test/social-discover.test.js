// Stream C discover feature maps to the shared catalog routes (fake Bot Social).
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBotSocial, setSharedBotSocial } from '../lib/c/bot-social.js'
import discover from '../features/discover/index.js'
import social from '../features/social/index.js'
import { createDispatch } from '../src/dispatch.js'
import { boot } from './helpers.js'
import { triangleGlb } from './fixtures/triangle-glb.js'

const SERVER = 'https://social.example.test'

test('the contacts directory carries its authenticated viewer and personal workspace', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ot-contacts-viewer-'))
  const credentialsPath = join(dir, 'connector.json')
  writeFileSync(credentialsPath, JSON.stringify({token:'fixture',server:SERVER}), {mode:0o600})
  const workspace = 'a'.repeat(32)
  setSharedBotSocial(createBotSocial({server:SERVER,credentialsPath,fetch:async url => {
    assert.equal(url, SERVER + '/v1/ot/contacts')
    return Response.json({items:[]})
  }}))
  const list = social({call:async endpoint => {
    assert.equal(endpoint, 'agents/personal-binding')
    return {workspace_id:workspace}
  }}).endpoints.v1
  const request = new Request(SERVER, {headers:{'x-ot-owner-username':'SignedOwner'}})
  const result = await list({method:'GET',path:'/v1/contacts',body:{viewer_username:'UntrustedName'}},{request})
  assert.deepEqual(result, {status:200,body:{items:[],workspace_id:workspace,viewer_username:'SignedOwner'}})
})

test('editable publishing and remix copy only the selected canonical saved work', async () => {
  const author = await boot()
  const reader = await boot()
  const authorSpace = 'd'.repeat(32)
  const readerSpace = 'e'.repeat(32)
  author.features.table['agents/personal-binding'] = async () => ({workspace_id:authorSpace})
  reader.features.table['agents/personal-binding'] = async () => ({workspace_id:readerSpace})
  const original = {schema:'flybot-workspace.slides.v1',slides:[{title:'Discussion',bullets:['Visible point']}]}
  const local = `/v1/workspaces/${authorSpace}/artifacts`
  const recorded = await author.call('artifacts','POST',local,{title:'Workshop',kind:'slides',
    slides:{...original,slides:[{...original.slides[0],speaker_notes:'private note'}]},
    source:{kind:'agent_task',id:'c'.repeat(32),task_kind:'private-origin'}},'private-slide-origin')
  assert.equal(recorded.status,201,JSON.stringify(recorded.body))
  const sourceId = recorded.body.artifact.id
  assert.equal(recorded.body.artifact.source.task_kind,'private-origin')
  const publish = `${local}/${sourceId}/discover`
  const slug = 'workshop-release'
  const revision = 'c'.repeat(64)
  let relayPut
  let available = true
  setSharedBotSocial({request:async (method,path,payload) => {
    if (path.startsWith('/v1/ot/teams/by-workspace/')) throw Object.assign(new Error('Not a member'),{status:404})
    if (path === '/v1/ot/listings/mine') return {listings:[]}
    if (method === 'PUT') {
      assert.equal(path,'/v1/ot/listings')
      relayPut = payload
      return {slug,listed:true,editable_remix:!!payload.editable_snapshot}
    }
    assert.equal(path,`/v1/ot/discover/${slug}/remix?revision=${revision}`)
    if (!available) throw Object.assign(new Error('Withdrawn'),{status:404})
    return {template:{kind:'slides',title:'Workshop',revision},source:{kind:'slides',slides:relayPut.editable_snapshot}}
  }})
  const opts = {slug,allow_editable_remix:true,revision:1,editable_snapshot:{private:'untrusted request body'}}
  const originalBinding = author.features.table['agents/personal-binding']
  author.features.table['agents/personal-binding'] = async () => ({workspace_id:'f'.repeat(32)})
  assert.equal((await author.call('discover','POST',publish,opts)).status,409)
  assert.equal(relayPut,undefined)
  author.features.table['agents/personal-binding'] = originalBinding
  assert.equal((await author.call('discover','POST',publish,{...opts,revision:2})).body.error.code,'artifact_changed')
  assert.equal((await author.call('discover','POST',publish,{slug})).status,201)
  assert.equal(relayPut.editable_snapshot,undefined)
  assert.equal((await author.call('discover','POST',publish,opts)).body.discover.editable_remix,true)
  assert.deepEqual(relayPut.editable_snapshot,original)
  assert.doesNotMatch(JSON.stringify(relayPut),/private note|private-origin|untrusted request body/)
  await author.call('artifacts','POST',local+'/'+sourceId,{revision:1,changes:{slides:{...original,slides:[{title:'Private new work',bullets:[]}]}}})
  const remix = '/v1/discover/works/'+slug+'/remix'
  const input = {revision,title:'My own workshop'}
  const receipt = 'editable-remix-receipt'
  const copied = await reader.call('discover','POST',remix,input,receipt)
  assert.equal(copied.status,201,JSON.stringify(copied.body))
  const copyPath = `/v1/workspaces/${readerSpace}/artifacts/${copied.body.artifact.id}`
  const owned = (await reader.call('artifacts','GET',copyPath)).body.artifact
  assert.deepEqual(owned.slides,original)
  assert.equal(owned.source,undefined)
  assert.equal((await author.call('artifacts','GET',copyPath)).status,404)
  available = false
  assert.equal((await reader.call('discover','POST',remix,input,receipt)).status,200)
  assert.equal((await reader.call('discover','POST',remix,{...input,title:'Second copy'},'second-remix-receipt')).status,404)
})

test('private Space media remix imports exact bytes, revalidates signatures and retains committed receipts', async () => {
  const bot = await boot()
  const other = await boot()
  const workspace = 'a'.repeat(32)
  bot.features.table['agents/personal-binding'] = async () => ({workspace_id:workspace})
  const revision = '7'.repeat(64)
  const wav = Buffer.alloc(3*1024*1024 + 44,0x80)
  Buffer.from('RIFF').copy(wav)
  wav.writeUInt32LE(wav.length-8,4)
  Buffer.from('WAVEfmt ').copy(wav,8)
  wav.writeUInt32LE(16,16)
  wav.writeUInt16LE(1,20)
  wav.writeUInt16LE(1,22)
  wav.writeUInt32LE(22050,24)
  wav.writeUInt32LE(22050,28)
  wav.writeUInt16LE(1,32)
  wav.writeUInt16LE(8,34)
  Buffer.from('data').copy(wav,36)
  wav.writeUInt32LE(wav.length-44,40)
  const model = triangleGlb()
  const media = (mime, filename, bytes) => ({kind:'media',mime,filename,bytes:bytes.length,data:bytes.toString('base64')})
  let source = media('audio/wav','三兆字节.wav',wav)
  const template = {kind:'media',title:'Public media',revision}
  let withdrawn = false
  let reads = 0
  setSharedBotSocial({request:async () => {
    reads++
    if (withdrawn) throw Object.assign(new Error('Withdrawn'),{status:404,code:'listing_not_found'})
    return {template,source}
  }})
  const path = '/v1/discover/works/public-media/remix'
  const call = (title,key) => bot.call('discover','POST',path,{title,revision},key)
  const catalog = `/v1/workspaces/${workspace}/artifacts`
  const first = await call('我的音频','media-remix-large')
  assert.equal(first.status,201,JSON.stringify(first.body))
  const audio = first.body.artifact
  assert.equal(audio.kind,'media')
  const file = catalog+'/'+audio.id+'/file'
  const original = await bot.call('artifacts','GET',file)
  assert.deepEqual(Buffer.from(original.download.data,'base64'),wav)
  assert.equal((await other.call('artifacts','GET',file)).status,404)
  const manual = await bot.call('artifacts','POST',catalog,{_multipart:true,fields:{title:'上传时仍限两兆字节'},
    files:{file:{filename:source.filename,data:source.data}}},'oversize-upload-test')
  assert.equal(manual.status,413)
  assert.equal((await call('我的音频','media-remix-other-key')).body.error.code,'title_conflict')
  assert.equal(reads,1)
  source = {...source,mime:'image/png'}
  assert.equal((await call('错误的类型','media-remix-mismatch')).status,400)
  source = media('model/gltf-binary','外部模型.glb',triangleGlb({
    customize(model) { model.buffers[0].uri = 'https://example.test/payload.bin' },
  }))
  assert.equal((await call('带外部地址的模型','media-remix-external')).status,400)
  source = media('model/gltf-binary','三角模型.glb',model)
  const glb = await call('我的模型','media-remix-glb-file')
  assert.equal(glb.status,201,JSON.stringify(glb.body))
  const saved = await bot.call('artifacts','GET',catalog+'/'+glb.body.artifact.id+'/file')
  assert.equal(saved.download.content_type,'model/gltf-binary')
  assert.deepEqual(Buffer.from(saved.download.data,'base64'),model)
  withdrawn = true
  assert.deepEqual((await call('我的音频','media-remix-large')).body,first.body)
  assert.equal((await call('撤回后新副本','media-remix-closed')).status,404)
})

test('public work remix writes only verified publications to the viewer’s personal Space', async () => {
  const bot = await boot()
  const other = await boot()
  const workspace = 'a'.repeat(32)
  bot.features.table['agents/personal-binding'] = async () => ({workspace_id:workspace})
  const revision = 'b'.repeat(64)
  const source = {kind:'document',body:'Published notes'}
  const template = {revision,title:'Original',kind:source.kind}
  let closed = false
  let reads = 0
  setSharedBotSocial({request:async (method,path) => {
    assert.equal(method,'GET')
    reads++
    assert.match(path,/^\/v1\/ot\/discover\/public-notes\/remix(?:\?revision=b{64})?$/)
    if (closed) throw Object.assign(new Error('Withdrawn'),{status:404,code:'listing_not_found'})
    return {template,...(path.includes('?') ? {source} : {})}
  }})
  const target = '/v1/discover/works/public-notes/remix'
  const forged = await bot.endpoint('artifacts/remixPublicWork',{workspace_id:workspace,slug:'public-notes',revision,
    title:'Forged source',source,idempotency_key:'fake-copy-assertion'})
  assert.equal(forged.ok,false)
  assert.deepEqual((await bot.call('discover','GET',target)).body,{template})
  const input = {title:'Public notes copy',revision}
  const key = 'work-remix-example'
  assert.equal((await bot.call('discover','POST',target,{...input,workspace_id:'c'.repeat(32)},key)).status,400)
  assert.equal((await bot.call('discover','POST',target,{...input,source:{...source,body:'Forged'}},key)).status,400)
  const created = await bot.call('discover','POST',target,input,key)
  assert.equal(created.status,201,JSON.stringify(created.body))
  const copy = created.body.artifact
  assert.equal(copy.workspace_id,workspace)
  assert.equal(copy.body,undefined)
  const detail = `/v1/workspaces/${workspace}/artifacts/${copy.id}`
  const artifact = (await bot.call('artifacts','GET',detail)).body.artifact
  assert.deepEqual([artifact.body,artifact.source,artifact.revision],[source.body,undefined,1])
  assert.equal((await other.call('artifacts','GET',detail)).status,404)
  assert.equal((await bot.call('discover','POST',target,{...input,title:'Different'},key)).status,409)
  assert.equal(reads,2)
  closed = true
  assert.deepEqual(await bot.call('discover','POST',target,input,key),{status:200,body:created.body})
  assert.equal(reads,2)
  assert.equal((await bot.call('discover','POST',target,{...input,title:'New copy'},'another-remix-key')).status,404)
  assert.equal(reads,3)
})

test('profile social sends only actor-scoped queries and explicit follow requests', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ot-profile-social-'))
  const credentialsPath = join(dir, 'connector.json')
  writeFileSync(credentialsPath, JSON.stringify({token:'profile-fixture',server:SERVER}), {mode:0o600})
  const calls = []
  setSharedBotSocial(createBotSocial({server:SERVER,credentialsPath,fetch:async (url, init) => {
    assert.equal(init.headers.authorization,'Bearer profile-fixture')
    calls.push({url:url.slice(SERVER.length), method:init.method, body:init.body && JSON.parse(init.body)})
    if (init.method === 'GET') return Response.json({items:[],next_cursor:null})
    if (url.includes('/listings/')) return Response.json({collected:false,liked:false,unrelated:'not forwarded'})
    return Response.json(url.endsWith('/notifications') ? {enabled:false} : {following:false})
  }}))
  const route = discover({dataDir:dir}).endpoints.v1
  const path = '/v1/profile/social'
  assert.deepEqual(await route({method:'GET',path:path+'?view=followers&q=Ann%20Lee&limit=20',owner_id:'forged'}), {
    status:200,body:{items:[],next_cursor:null},
  })
  assert.equal((await route({method:'GET',path:path+'?view=liked&owner_id=other'})).status,400)
  assert.equal((await route({method:'GET',path:path+'?view=liked&view=following'})).status,400)
  assert.equal((await route({method:'POST',path,body:{handle:'ann.home',on:true,owner_id:'other'}})).status,400)
  assert.equal((await route({method:'POST',path,body:{handle:'ann.home',on:'false'}})).status,400)
  assert.deepEqual(await route({method:'POST',path,body:{handle:'ann.home',on:false}}), {
    status:200,body:{following:false},
  })
  const listing = 'otl_' + 'V'.repeat(26)
  assert.equal((await route({method:'POST',path,body:{listing_id:listing,action:'publish'}})).status,400)
  assert.equal((await route({method:'POST',path,body:{listing_id:listing,action:'like',on:true}})).status,400)
  assert.equal((await route({method:'POST',path,body:{listing_id:[listing],action:'like'}})).status,400)
  assert.deepEqual(await route({method:'POST',path,body:{listing_id:listing,action:'collect'},owner_id:'forged'}),{
    status:200,body:{collected:false},
  })
  assert.deepEqual(await route({method:'POST',path,body:{listing_id:listing,action:'like'}}),{
    status:200,body:{liked:false},
  })
  const notices = '/v1/profile/follow-work'
  assert.equal((await route({method:'GET',path:notices+'?view=liked'})).status,400)
  assert.equal((await route({method:'GET',path:notices+'?cursor=abc'})).status,200)
  assert.deepEqual(await route({method:'POST',path:notices,body:{handle:'ann.home',enabled:false}}), {
    status:200,body:{enabled:false},
  })
  assert.deepEqual(calls,[
    {url:'/v1/ot/profile/social?view=followers&q=Ann+Lee&limit=20',method:'GET',body:undefined},
    {url:'/v1/ot/follows',method:'POST',body:{handle:'ann.home',on:false}},
    {url:'/v1/ot/listings/'+listing+'/collect',method:'POST',body:{on:false}},
    {url:'/v1/ot/listings/'+listing+'/like',method:'POST',body:{on:false}},
    {url:'/v1/ot/profile/social?view=work-notices&cursor=abc',method:'GET',body:undefined},
    {url:'/v1/ot/follows/notifications',method:'POST',body:{handle:'ann.home',enabled:false}},
  ])
})

test('native Discover feeds and work detail bind the viewer to the trusted request account', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ot-discover-viewer-'))
  const credentialsPath = join(dir, 'connector.json')
  writeFileSync(credentialsPath, JSON.stringify({ token: 'ot-fake-token', server: SERVER }), { mode: 0o600 })
  const fetch = async url => new URL(url).pathname.endsWith('/detail')
    ? Response.json({
      work: {kind: 'work', listed: true, slug: 'trusted-work', title: 'Work', liked: true},
      previous: null, next: {slug: 'next-work', title: 'Next'},
      viewer_username: 'service-value',
    })
    : Response.json({items: [], viewer_username: 'service-value'})
  setSharedBotSocial(createBotSocial({server: SERVER, credentialsPath, fetch}))
  const dispatch = createDispatch({endpoints: {'discover/v1': discover({dataDir: dir}).endpoints.v1}})
  async function viewer(path, header) {
    const response = await dispatch(new Request('http://runtime/api/flybot-workspace', {
      method: 'POST',
      headers: header === undefined ? {} : {'x-ot-owner-username': header},
      body: JSON.stringify({endpoint: 'discover/v1', payload: {method: 'GET', path, viewer_username: 'client-value'}}),
    }))
    const {ok, value} = await response.json()
    assert.equal(ok, true)
    assert.equal(value.status, 200)
    return value.body.viewer_username
  }
  assert.equal(await viewer('/v1/discover/works?limit=12', 'trusted.viewer'), 'trusted.viewer')
  assert.equal(await viewer('/v1/discover/me/works?tab=collected', 'trusted.viewer'), 'trusted.viewer')
  assert.equal(await viewer('/v1/discover/works', 'not a username'), undefined)
  assert.equal(await viewer('/v1/discover/works'), undefined)
  assert.equal(await viewer('/v1/discover/agents', 'trusted.viewer'), 'trusted.viewer')
  assert.equal(await viewer('/v1/discover/agents'), undefined)
  assert.equal(await viewer('/v1/discover/works/trusted-work?tab=collected', 'trusted.viewer'), 'trusted.viewer')
  assert.equal(await viewer('/v1/discover/works/trusted-work?tab=following', 'bad name'), undefined)
  assert.equal(await viewer('/v1/discover/works/trusted-work'), undefined)
  assert.equal(await viewer('/v1/profile/social?view=following', 'trusted.viewer'), 'trusted.viewer')
  assert.equal(await viewer('/v1/profile/social?view=following', 'bad name'), undefined)
  assert.equal(await viewer('/v1/profile/social?view=following'), undefined)
})

test('discover endpoints publish only the whitelisted projection and browse the shared feed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ot-cd-'))
  mkdirSync(join(dir, 'bot'))
  writeFileSync(join(dir, 'bot', 'flybot-social.json'), JSON.stringify({ token: 'ot-fake-token', server: SERVER }), { mode: 0o600 })
  const calls = []
  const fetch = async (url, init) => { calls.push({ method: init.method, path: url.slice(SERVER.length), body: init.body ? JSON.parse(init.body) : undefined }); return new Response('{}') }
  setSharedBotSocial(createBotSocial({ server: SERVER, credentialsPath: join(dir, 'bot', 'flybot-social.json'), fetch }))
  const E = discover({ dataDir: dir }).endpoints
  await E.publish({ kind: 'agent', ref: 'bot_1', slug: 'writer', title: 'Writer', instructions: 'SECRET PROMPT', memory: 'private' })
  await E.feed({ tab: 'following', q: 'deck' })
  await E.like({ listing_id: 'otl_1' })
  await E.collect({ listing_id: 'otl_1', on: false })
  await E.follow({ handle: 'ann.home' })
  await E.get({ slug: 'writer' })
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), [
    'PUT /v1/ot/listings', 'GET /v1/ot/discover?tab=following&q=deck', 'POST /v1/ot/listings/otl_1/like',
    'POST /v1/ot/listings/otl_1/collect', 'POST /v1/ot/follows', 'GET /v1/ot/discover/writer',
  ])
  assert.ok(!JSON.stringify(calls[0].body).includes('SECRET'), 'instructions are never published')
  assert.ok(!('memory' in calls[0].body))
  assert.equal(calls[3].body.on, false)
})

test('catalog publication is explicit and remix copies the previewed release in the destination runtime', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ot-cd-remix-'))
  const credentialsPath = join(dir, 'connector.json')
  writeFileSync(credentialsPath, JSON.stringify({ token: 'ot-fake-token', server: SERVER }), { mode: 0o600 })
  const workspaceId = 'a'.repeat(32)
  const agentId = 'b'.repeat(32)
  const agent = {
    id: agentId, name: 'Writer', summary: 'Draft assistance', category: 'design',
    instructions: 'Released writing instructions', revision: 5, memory: 'PRIVATE MEMORY',
    quick_starts: ['Preview this plan'],
  }
  let row
  const created = []
  const fetch = async (url, init) => {
    const path = url.slice(SERVER.length)
    if (path === '/v1/ot/listings' && init.method === 'PUT') {
      row = { id: 'listing-1', listed: true, ...JSON.parse(init.body) }
      return Response.json(row)
    }
    if (path === '/v1/ot/discover/writer') return Response.json(row)
    if (path === '/v1/ot/listings/mine') return Response.json({listings:[row]})
    if (path === '/v1/ot/discover/writer/start') {
      assert.deepEqual(JSON.parse(init.body), {quick_start:0, quick_start_version:'a'.repeat(64)})
      return Response.json({conversation_id:'test-thread', draft_text:'Preview this plan'})
    }
    if (path === '/v1/ot/discover?kind=agent&q=Draft&creator=alice.home&category=design') {
      return Response.json({ items: [{ ...row, creator: {handle: 'alice.home', display_name: 'Alice'} }] })
    }
    throw new Error('Unexpected request: ' + path)
  }
  setSharedBotSocial(createBotSocial({ server: SERVER, credentialsPath, fetch }))
  const E = discover({
    dataDir: dir,
    async call(endpoint, payload) {
      if (endpoint === 'agents/get') {
        assert.deepEqual(payload, { id: agentId, workspace_id: workspaceId })
        return { agent }
      }
      if (endpoint === 'agents/personal-binding') return { workspace_id: workspaceId }
      assert.equal(endpoint, 'agents/createRemix')
      created.push(payload)
      return { status: 201, agent: { id: 'c'.repeat(32), name: payload.name } }
    },
  }).endpoints
  const publish = '/v1/workspaces/' + workspaceId + '/agents/' + agentId + '/discover'
  const remix = '/v1/discover/agents/writer/remix'
  const call = (method, path, body, key = 'a-valid-remix-key') => E.v1({ method, path, body, idempotency_key: key })
  assert.equal((await call('POST', publish, { slug: 'writer' })).status, 200)
  assert.equal(row.snapshot, undefined)
  const blank = (await call('GET', remix)).body.template
  assert.equal(blank.instructions, '')
  assert.deepEqual(blank.quick_starts, [])
  const publicStart = '/v1/discover/agents/writer/start'
  const quick = {quick_start:0, quick_start_version:'a'.repeat(64)}
  assert.equal((await call('POST', publicStart, {...quick, body:'Forged'})).status, 400)
  assert.deepEqual((await call('POST', publicStart, quick)).body,
    {conversation_id:'test-thread', draft_text:'Preview this plan', workspace_id:workspaceId})
  assert.equal((await call('POST', publish, {slug:'writer', publish_quick_starts:'yes'})).status, 400)
  assert.equal((await call('POST', publish, {slug:'writer', publish_quick_starts:true})).body.discover.publish_quick_starts,true)
  assert.deepEqual(JSON.parse(row.snapshot), {version:1, quick_starts:agent.quick_starts})
  assert.equal((await call('GET', publish)).body.discover.publish_quick_starts,true)
  const withStarts = (await call('GET', remix)).body.template
  assert.deepEqual(withStarts.quick_starts, ['Preview this plan'])
  assert.notEqual(withStarts.revision, blank.revision)
  agent.quick_starts = ['Private change since publication']
  assert.deepEqual((await call('GET', remix)).body.template, withStarts)
  assert.equal((await call('POST', remix, { revision:withStarts.revision, workspace_id:workspaceId, name:'Copy with starters',
    quick_starts:['Unapproved override'], memory:'Private override' }, 'starts-remix-receipt')).status, 201)
  assert.deepEqual(created[0], { workspace_id:workspaceId, idempotency_key:'starts-remix-receipt', name:'Copy with starters',
    summary:agent.summary, category:agent.category, instructions:'', quick_starts:['Preview this plan'] })
  assert.equal((await call('POST', publish, {slug:'writer', publish_quick_starts:true})).status, 200)
  assert.equal((await call('POST', remix, {revision:withStarts.revision, workspace_id:workspaceId})).body.error.code, 'listing_changed')

  // Older instructions-only releases keep their existing remix receipt.
  row.snapshot = JSON.stringify({version:1, instructions:agent.instructions})
  const expected = {name:agent.name,summary:agent.summary,category:agent.category,instructions:agent.instructions}
  const legacy = createHash('sha256').update(JSON.stringify([row.id,expected])).digest('hex')
  assert.deepEqual((await call('GET', remix)).body.template,{...expected,quick_starts:[],revision:legacy})
  assert.equal((await call('POST', remix, {revision:legacy, workspace_id:workspaceId, name:'Legacy copy'}, 'legacy-remix-receipt')).status, 201)
  assert.deepEqual(created[1].quick_starts, [])

  row.snapshot = JSON.stringify({version:1, quick_starts:['  Keep   spacing consistent  ', false, 'x'.repeat(81),
    'private\u0000control', 'Second published starter', 'Outside the published limit'], private_notes:'Never export'})
  const filtered = (await call('GET', remix)).body.template
  assert.deepEqual(filtered.quick_starts,['Keep spacing consistent','Second published starter'])
  assert.doesNotMatch(JSON.stringify(filtered),/private|Outside the published limit|Never export/)
  assert.equal((await call('POST', remix, {revision:filtered.revision, workspace_id:workspaceId, name:'Filtered copy'},
    'filtered-remix-receipt')).status,201)
  assert.deepEqual(created[2].quick_starts,filtered.quick_starts)
  for (const invalid of ['{broken', JSON.stringify({version:2,quick_starts:['Unsupported release']}),
    JSON.stringify({quick_starts:['Unknown schema']}), JSON.stringify({version:1,quick_starts:'Invalid field'})]) {
    row.snapshot = invalid
    assert.deepEqual((await call('GET', remix)).body.template.quick_starts,[])
  }

  assert.equal((await call('POST', publish, { slug: 'writer', revision: 5, copy_instructions: true })).status, 200)
  assert.equal(row.category, 'design')
  assert.doesNotMatch(JSON.stringify(row), /PRIVATE MEMORY/)
  const feed = await call('GET', '/v1/discover/agents?q=Draft&category=design&creator=alice.home')
  assert.deepEqual(feed.body.items[0].creator, { handle: 'alice.home', name: 'Alice' })
  assert.equal('snapshot' in feed.body.items[0], false)
  const {template} = (await call('GET', remix)).body
  assert.equal(template.instructions, agent.instructions)
  assert.equal((await call('POST', remix, {
    revision: template.revision, workspace_id: workspaceId, name: 'My writer', instructions: 'Override ignored',
  })).status, 201)
  assert.deepEqual(created[3], {
    workspace_id: workspaceId, idempotency_key: 'a-valid-remix-key', name: 'My writer',
    summary: agent.summary, category: agent.category, instructions: agent.instructions, quick_starts:[],
  })
  assert.equal((await call('POST', publish, { slug: 'writer', revision: 4, copy_instructions: true })).status, 409)
  assert.equal((await call('POST', publish, { slug: 'writer', copy_instructions: false })).status, 200)
  assert.equal((await call('POST', remix, { revision: template.revision, workspace_id: workspaceId })).status, 409)
  row.listed = false
  assert.equal((await call('GET', remix)).status, 404)
  assert.equal(created.length, 4)
})

test('native public agent starts pass only the selected listing identity and retain stale-listing errors', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ot-cd-public-composer-'))
  const credentialsPath = join(dir, 'connector.json')
  writeFileSync(credentialsPath, JSON.stringify({token:'ot-fake-token',server:SERVER}), {mode:0o600})
  const id = 'otl_' + 'A'.repeat(26)
  const stale = 'otl_' + 'B'.repeat(26)
  const calls = []
  setSharedBotSocial(createBotSocial({server:SERVER,credentialsPath,fetch:async (url, init) => {
    const input = JSON.parse(init.body)
    assert.equal(url, SERVER + '/v1/ot/discover/draft-agent/start')
    calls.push(input)
    if (input.listing_id === stale) {
      return Response.json({error:{code:'public_agent_changed',message:'Listing changed'}}, {status:409})
    }
    return Response.json({conversation_id:'otc_current',created:true})
  }}))
  const workspace = 'a'.repeat(32)
  const native = discover({dataDir:dir,async call(endpoint) {
    assert.equal(endpoint, 'agents/personal-binding')
    return {workspace_id:workspace}
  }}).endpoints.v1
  const start = body => native({method:'POST',path:'/v1/discover/agents/draft-agent/start',body})
  assert.equal((await start({listing_id:id,message:'private draft'})).status, 400)
  assert.equal((await start({listing_id:id,quick_start:0,quick_start_version:'a'.repeat(64)})).status, 400)
  assert.equal((await start({listing_id:'otl_fake'})).status, 400)
  const opened = await start({listing_id:id})
  assert.equal(opened.status, 200)
  assert.deepEqual(opened.body, {conversation_id:'otc_current',created:true,workspace_id:workspace})
  const moved = await start({listing_id:stale})
  assert.equal(moved.status, 409)
  assert.equal(moved.body.error.code, 'public_agent_changed')
  assert.deepEqual(calls, [{listing_id:id},{listing_id:stale}])
})

test('native Discover forwards popularity cursors separately and publishes only the selected saved 3D revision', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ot-cd-models-'))
  const credentialsPath = join(dir, 'connector.json')
  writeFileSync(credentialsPath, JSON.stringify({token: 'fixture', server: SERVER}), {mode: 0o600})
  const workspace = 'a'.repeat(32)
  const artifact = '3'.repeat(32)
  const cursor = 'd'.repeat(32) + '.12'
  const kind = 'model/gltf-binary'
  const published = {id: 'entry', kind: 'work', work_kind: 'model3d', slug: 'vase', title: '陶瓷花瓶', listed: true}
  const modelData = Buffer.from('published GLB fixture').toString('base64')
  let review = false
  const fetch = async (url, init) => {
    const target = new URL(url)
    if (target.pathname === '/v1/ot/discover') {
      if (target.searchParams.has('before')) {
        assert.equal(target.searchParams.get('before'), '123')
        assert.equal(target.searchParams.has('sort'), false)
        return Response.json({items: [], next_before: 100})
      }
      assert.equal(target.searchParams.get('kind'), 'work')
      assert.equal(target.searchParams.get('sort'), 'popular')
      assert.equal(target.searchParams.get('work_kind'), 'model3d')
      assert.equal(target.searchParams.get('cursor'), cursor)
      return review
        ? Response.json({error: {code: 'popularity_expired', message: 'refresh'}}, {status: 409})
        : Response.json({items: [{...published, model_data: modelData}], next_cursor: cursor})
    }
    if (target.pathname === '/v1/ot/listings/mine') return Response.json({listings: []})
    assert.equal(target.pathname, '/v1/ot/listings')
    assert.equal(init.method, 'PUT')
    assert.deepEqual(JSON.parse(init.body), {
      kind: 'work', ref: artifact, slug: 'vase', title: '陶瓷花瓶',
      summary: '', work_kind: 'model3d', snapshot: '', model_data: modelData, source_revision:5,
    })
    return Response.json(published)
  }
  setSharedBotSocial(createBotSocial({server: SERVER, credentialsPath, fetch}))
  const call = discover({
    dataDir: dir,
    async call(endpoint, input) {
      if (endpoint === 'artifacts/v1') {
        assert.equal(input.path, `/v1/workspaces/${workspace}/artifacts/${artifact}`)
        return {body: {artifact: {kind: 'media', title: '陶瓷花瓶', revision: 5, media: {mime: kind}}}}
      }
      assert.equal(endpoint, 'artifacts/chatAttachment')
      assert.deepEqual(input, {workspace_id: workspace, artifact_id: artifact, revision: 5})
      return {attachment: {mime: kind, data: modelData}}
    },
  }).endpoints.v1
  const feed = '/v1/discover/me/works?sort=popular&kind=model3d&cursor=' + cursor
  const results = await call({method: 'GET', path: feed})
  assert.equal(results.body.items[0].kind, 'model3d')
  assert.equal(results.body.items[0].model_data, undefined)
  assert.equal(results.body.cursor, cursor)
  assert.equal((await call({method: 'GET', path: '/v1/discover/me/works?cursor=123'})).body.cursor, 100)
  review = true
  const expired = await call({method: 'GET', path: feed})
  assert.equal(expired.status, 409)
  assert.equal(expired.body.error.code, 'popularity_expired')
  const path = `/v1/workspaces/${workspace}/artifacts/${artifact}/discover`
  const stale = await call({method:'POST',path,body:{slug:'vase',revision:4}})
  assert.equal(stale.status,409)
  assert.equal(stale.body.error.code,'artifact_changed')
  const saved = await call({method:'POST',path,body:{slug:'vase',revision:5}})
  assert.equal(saved.status, 201)
  assert.equal(saved.body.discover.listed, true)
})

test('native Discover passes the full work query and scoped cursor while returning only bounded match fields', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ot-cd-content-'))
  const credentialsPath = join(dir, 'connector.json')
  writeFileSync(credentialsPath, JSON.stringify({token: 'fixture', server: SERVER}), {mode: 0o600})
  const position = 'l.1761111000000.otl_' + 'A'.repeat(26) + '.' + '9'.repeat(24)
  const query = '公开方案'.repeat(20)
  const calls = []
  setSharedBotSocial(createBotSocial({server: SERVER, credentialsPath, fetch: async (url) => {
    const target = new URL(url)
    assert.equal(target.pathname, '/v1/ot/discover')
    calls.push(Object.fromEntries(target.searchParams))
    const panel = {slug: 'work-panel', title: '公开看板', kind: 'work', work_kind: 'dashboard'}
    const text = '内容中的检索结果'
    return Response.json({items: [
      {...panel, match: {kind: 'body', text, start: 4, end: 6, snapshot: 'out of contract'}},
      {...panel, slug: 'bad-offsets', match: {kind: 'body', text, start: 4, end: text.length + 1}},
    ], next_cursor: target.searchParams.has('cursor') ? null : position, next_before: 155})
  }}))
  const call = discover({dataDir: dir}).endpoints.v1
  const path = '/v1/discover/me/works?' + new URLSearchParams({q: query, tab: 'following', kind: 'dashboard', limit: '12'})
  const view = {request: new Request(SERVER, {headers: {'x-ot-owner-username': 'reader.qa'}})}
  const first = await call({method: 'GET', path}, view)
  assert.equal(first.status, 200)
  assert.equal(first.body.cursor, position)
  assert.equal(first.body.viewer_username, 'reader.qa')
  assert.deepEqual(first.body.items[0].match, {kind: 'body', text: '内容中的检索结果', start: 4, end: 6})
  assert.equal(first.body.items[1].match, undefined)
  assert.equal((await call({method: 'GET', path: path + '&cursor=' + position})).body.cursor, null)
  assert.equal((await call({method: 'GET', path: path + '&cursor=l.invalid'})).status, 400)
  assert.equal((await call({method:'GET',path:'/v1/discover/me/works?tab=following&sort=collected'})).status,400)
  assert.equal((await call({method:'GET',path:'/v1/discover/me/works?tab=collected&sort=collected&cursor=42'})).status,400)
  assert.equal((await call({method:'GET',path:'/v1/discover/me/works?tab=collected&sort=collected&cursor=' + position})).status,200)
  assert.deepEqual(calls, [
    {kind: 'work', tab: 'following', q: query, work_kind: 'dashboard', pagination: 'keyset', limit: '12'},
    {kind: 'work', tab: 'following', q: query, work_kind: 'dashboard', pagination: 'keyset', cursor: position, limit: '12'},
    {kind:'work',tab:'collected',pagination:'keyset',cursor:position,sort:'collected'},
  ])
})

test('publishing media exports the saved revision and Discover only projects its public file metadata', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ot-discover-media-'))
  const credentialsPath = join(dir, 'connector.json')
  writeFileSync(credentialsPath, JSON.stringify({token: 'fixture', server: SERVER}), {mode: 0o600})
  const workspace = 'c'.repeat(32)
  const artifactId = '6'.repeat(32)
  const bytes = Buffer.from('saved-media-fixture')
  let media = {}
  let mismatch = false
  const puts = []
  setSharedBotSocial(createBotSocial({server: SERVER, credentialsPath, fetch: async (url, init) => {
    const {pathname} = new URL(url)
    if (pathname.endsWith('/mine')) return Response.json({listings: []})
    if (init.method === 'PUT') {
      const doc = JSON.parse(init.body)
      puts.push(doc)
      return Response.json({...doc, listed: true})
    }
    assert.equal(pathname, '/v1/ot/discover/media-preview/detail')
    return Response.json({work: {
      kind: 'work', listed: true, slug: 'media-preview', title: '作品预览', work_kind: 'video',
      file_available: true, file_mime: media.mime, file_bytes: bytes.length, media_data: bytes.toString('base64'),
      media_filename: 'private-original.mp4',
    }})
  }}))
  const call = discover({dataDir: dir, async call(endpoint, input) {
    if (endpoint === 'artifacts/v1') {
      assert.deepEqual(input, {method: 'GET', path: `/v1/workspaces/${workspace}/artifacts/${artifactId}`})
      return {body: {artifact: {kind: 'media', title: '作品预览', revision: 7, media}}}
    }
    assert.equal(endpoint, 'artifacts/chatAttachment')
    assert.deepEqual(input, {workspace_id: workspace, artifact_id: artifactId, revision: 7})
    return {attachment: {mime: mismatch ? 'image/gif' : media.mime, data: bytes.toString('base64')}}
  }}).endpoints.v1
  const publish = {method: 'POST', path: `/v1/workspaces/${workspace}/artifacts/${artifactId}/discover`,
    body: {slug: 'media-preview', media_data: 'must-use-saved-bytes', media_mime: 'text/html'}}
  for (const [kind, mime, filename] of [['image','image/png','photo.png'], ['audio','audio/ogg','song.ogg'], ['video','video/mp4','clip.mp4']]) {
    media = {mime, filename}
    assert.equal((await call(publish)).status, 201)
    assert.deepEqual(puts.at(-1), {kind: 'work', ref: artifactId, slug: 'media-preview', title: '作品预览',
      work_kind: kind, summary: '', snapshot: '', media_data: bytes.toString('base64'), media_mime: mime, media_filename: filename,
      source_revision: 7})
  }
  mismatch = true
  assert.equal((await call(publish)).status, 409)
  const detail = {method: 'GET', path: '/v1/discover/works/media-preview'}
  const {work} = (await call(detail)).body
  assert.equal(work.file_available, true)
  assert.equal(work.file_mime, 'video/mp4')
  assert.equal(work.file_bytes, bytes.length)
  assert.equal(work.media_data, undefined)
  assert.equal(work.media_filename, undefined)
  media = {mime: 'text/html', filename: 'unsafe.html'}
  assert.equal((await call(publish)).status, 400)
  assert.equal((await call(detail)).body.work.file_available, undefined)
  assert.equal(puts.length, 3)
})

test('publishing native works sends only saved display content to the public catalog', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ot-discover-published-text-'))
  const credentialsPath = join(dir, 'connector.json')
  writeFileSync(credentialsPath, JSON.stringify({token: 'fixture', server: SERVER}), {mode: 0o600})
  const siteHtml = '<main><h1>可见 &amp; 导览</h1><p hidden>hidden</p><script>private()</script></main>'
  const works = [
    [{kind: 'whiteboard', board: {strokes: [{type: 'path', meta: 'internal'}, {type: 'text', text: '白板标注'}]}}, '白板标注'],
    [{kind: 'slides', slides: {slides: [{title: '月度计划', bullets: ['第一目标'], notes: 'speaker notes'}]}}, '月度计划 第一目标'],
    [{kind: 'dashboard', dashboard: {widgets: [{type: 'table', title: '概览', columns: ['阶段'], rows: [['验收']], source: 'internal'}]}}, '概览 阶段 验收'],
    [{kind: 'spreadsheet', spreadsheet: {sheets: [{name: '季度', rows: [['销量', '80']]}]}}, '季度\n销量\t80'],
    [{kind: 'website', body: siteHtml}],
  ]
  const puts = []
  setSharedBotSocial(createBotSocial({server: SERVER, credentialsPath, fetch: async (url, init) => {
    if (url.endsWith('/mine')) return Response.json({listings: []})
    assert.equal(init.method, 'PUT')
    const data = JSON.parse(init.body)
    puts.push(data)
    return Response.json({...data, listed: true})
  }}))
  const workspace = 'c'.repeat(32)
  const artifact = '9'.repeat(32)
  for (const [saved, summary] of works) {
    const call = discover({dataDir: dir, async call(endpoint, request) {
      assert.equal(endpoint, 'artifacts/v1')
      assert.equal(request.path, `/v1/workspaces/${workspace}/artifacts/${artifact}`)
      return {body: {artifact: {...saved, title: '对外发布', source: {title: 'private original'}}}}
    }}).endpoints.v1
    const result = await call({method: 'POST', path: `/v1/workspaces/${workspace}/artifacts/${artifact}/discover`, body: {slug: 'public-work'}})
    assert.equal(result.status, 201)
    assert.deepEqual(puts.at(-1), {
      kind: 'work', ref: artifact, slug: 'public-work', title: '对外发布', work_kind: saved.kind,
      ...(saved.kind === 'website' ? {site_html: siteHtml} : {summary, snapshot: summary}),
    })
  }
})

test('native work detail and comment routes forward the personal connector and return public projections', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ot-cd-comments-'))
  const credentialsPath = join(dir, 'connector.json')
  writeFileSync(credentialsPath, JSON.stringify({token: 'commenter-fixture', server: SERVER}), {mode: 0o600})
  const upstream = '/v1/ot/discover/writer-demo'
  const root = '/v1/discover/works/writer-demo'
  const id = 'otwc_' + '0'.repeat(26)
  const key = 'comment-key-2026-11'
  const comment = {
    id, parent_id: null, body: '欢迎交流', created_at: 1_790_000_000_000,
    author: {handle: 'writer.home', name: '作者', platform_user_id: 'private'},
    mine: true, can_remove: true, removed: false, reply_count: 0, likes: 0, liked: false,
    owner_id: 'private',
  }
  let creates = 0
  const fetch = async (url, init) => {
    assert.equal(init.headers.authorization, 'Bearer commenter-fixture')
    const path = url.slice(SERVER.length)
    if (path === upstream + '/detail?tab=collected&q=design&work_kind=model3d') return Response.json({
      work: {kind: 'work', listed: true, slug: 'writer-demo', title: '参考作品', comment_count: 1, snapshot: 'private instruction'},
      previous: null, next: {slug: 'other-work', title: '另一件作品', owner_id: 'private'},
    })
    if (path === upstream + '/comments?parent_id=' + id + '&cursor=100.' + id + '&limit=12') {
      return Response.json({items: [comment], cursor: null, comment_count: 1})
    }
    if (path === upstream + '/comments') {
      assert.equal(init.method, 'POST')
      assert.deepEqual(JSON.parse(init.body), {body: '欢迎交流', client_key: key})
      return Response.json({comment, comment_count: 1, replayed: creates++ > 0})
    }
    if (path === upstream + '/comments/' + id + '/like') {
      assert.deepEqual(JSON.parse(init.body), {enabled: true})
      return Response.json({comment: {...comment, liked: true, likes: 1}})
    }
    assert.equal(path, upstream + '/comments/' + id + '/remove')
    return Response.json({comment_count: 0})
  }
  setSharedBotSocial(createBotSocial({server: SERVER, credentialsPath, fetch}))
  const call = (method, path, body, idempotency_key) =>
    discover({dataDir: dir}).endpoints.v1({method, path, body, idempotency_key})

  const detail = (await call('GET', root + '?tab=collected&q=design&kind=model3d')).body
  assert.equal(detail.work.comment_count, 1)
  assert.ok(!Object.hasOwn(detail.work, 'snapshot'))
  assert.equal(detail.previous, null)
  assert.deepEqual(detail.next, {slug: 'other-work', title: '另一件作品'})
  assert.equal((await call('GET', root + '?cursor=12')).status, 400)
  assert.equal((await call('GET', root + '?sort=popular&sort=latest')).status, 400)
  const page = await call('GET', root + '/comments?parent_id=' + id + '&cursor=100.' + id + '&limit=12')
  assert.equal(page.status, 200)
  assert.deepEqual(page.body.items[0].author, {handle: 'writer.home', name: '作者'})
  assert.ok(!Object.hasOwn(page.body.items[0], 'owner_id'))
  assert.equal((await call('POST', root + '/comments', {body: comment.body})).status, 400)
  assert.equal((await call('POST', root + '/comments', {body: comment.body}, key)).status, 201)
  assert.equal((await call('POST', root + '/comments', {body: comment.body}, key)).status, 200)
  const update = await call('POST', root + '/comments/' + id + '/like', {enabled: true})
  assert.equal(update.body.comment.liked, true)
  assert.equal((await call('POST', root + '/comments/' + id + '/remove', {})).body.comment_count, 0)
  assert.equal((await call('GET', root + '/comments?limit=1&limit=2')).status, 400)
})

test('native website publication copies the authorized saved HTML and exposes only site availability in detail', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ot-cd-website-'))
  const records = []
  const credentialsPath = join(dir, 'connector.json')
  writeFileSync(credentialsPath, JSON.stringify({token: 'publisher', server: SERVER}), {mode: 0o600})
  const workspace = 'b'.repeat(32)
  const artifact = 'c'.repeat(32)
  const html = '<h1>本地计数器</h1><p>点按增加数值。</p><script>document.title = "script fixture"</script>'
  const listing = {kind: 'work', work_kind: 'website', listed: true, slug: 'local-counter', title: '本地计数器',
    site_available: true, source_revision: 2}
  const site = createBotSocial({server: SERVER, credentialsPath, async fetch(url, init) {
    records.push([init.method, new URL(url).pathname, init.body ? JSON.parse(init.body) : null])
    if (url.endsWith('/mine')) return Response.json({listings: []})
    if (url.endsWith('/detail')) return Response.json({work: {...listing, site_html: html}})
    return Response.json(listing)
  }})
  setSharedBotSocial(site)
  const run = discover({dataDir: dir, async call(endpoint, data) {
    assert.equal(endpoint, 'artifacts/v1')
    assert.equal(data.path, `/v1/workspaces/${workspace}/artifacts/${artifact}`)
    return {body: {artifact: {id: artifact, title: '本地计数器', kind: 'website', revision: 2, body: html}}}
  }}).endpoints.v1
  const publish = await run({
    method: 'POST', path: `/v1/workspaces/${workspace}/artifacts/${artifact}/discover`,
    body: {slug: 'local-counter', site_html: 'request override'},
  })
  assert.equal(publish.status, 201)
  assert.equal(publish.body.discover.published_revision,2)
  assert.deepEqual(records.find(([method]) => method === 'PUT')?.[2], {
    kind: 'work', ref: artifact, slug: 'local-counter', title: '本地计数器',
    work_kind: 'website', site_html: html, source_revision: 2,
  })
  const detail = await run({method: 'GET', path: '/v1/discover/works/local-counter'})
  assert.equal(detail.body.work.site_available, true)
  assert.equal(Object.hasOwn(detail.body.work, 'source_revision'), false)
  assert.equal(Object.hasOwn(detail.body.work, 'published_revision'), false)
  assert.equal(Object.hasOwn(detail.body.work, 'site_html'), false)
  assert.equal(JSON.stringify(detail).includes('script fixture'), false)
})
