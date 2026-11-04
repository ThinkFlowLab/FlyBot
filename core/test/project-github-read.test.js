import assert from 'node:assert/strict'
import { test } from 'node:test'
import { appFixture } from './fixtures/github-app.mjs'
import { createProjectGithubRead } from '../src/host/project-github-read.js'
function setup() {
  const calls = []
  const rt = { state: {}, config: { projectRepositories: { 'owner/repo': { github: { login: 'automation', configDir: '/explicit' } } }, personalGithub: { alice: { p: { login: 'alice-gh' } } } }, requireProjectAccess(actor, id) { if (actor.memberId !== 'alice' || id !== 'p' || rt.revoked) throw new Error('Project denied'); return { id, repository: 'owner/repo' } } }
  const read = createProjectGithubRead(rt, { identity: async settings => ({ login: settings.login, token: 'private-token' }), request: async url => { calls.push(url); return Response.json(url.includes('check-runs') ? { check_runs: [{ name: 'tests-ok', status: 'completed', conclusion: 'success' }] } : /\/pulls\/\d+$/.test(url) ? { number: 1, head: { sha: 'a'.repeat(40) }, base: { ref: 'main' }, html_url: 'https://github.com/owner/repo/pull/1' } : [{ number: 1, title: 'Issue', state: 'open' }]) } })
  return { rt, read, calls }
}
test('GitHub reads bind repository, identity and bounded paths to the current Project', async () => {
  const f = setup(), actor = { memberId: 'alice' }
  const result = await f.read({ projectId: 'p', operation: 'issues', repository: 'victim/private', url: 'https://example.invalid' }, actor)
  assert.equal(result.repository, 'owner/repo'); assert.equal(result.executorLogin, 'automation'); assert.equal(result.pagination, 'bounded-first-page')
  assert.ok(f.calls[0].startsWith('https://api.github.com/repos/owner/repo/issues?'))
  assert.equal(JSON.stringify(result).includes('private-token'), false)
  assert.equal((await f.read({ projectId: 'p', scope: 'personal' }, actor)).executorLogin, 'alice-gh')
  const checks = await f.read({ projectId: 'p', operation: 'checks', number: 1 }, actor)
  assert.equal(checks.data.sha, 'a'.repeat(40)); assert.equal(checks.data.checks[0].conclusion, 'success')
  await assert.rejects(f.read({ projectId: 'p', operation: '../secrets' }, actor), /Unsupported/)
  await assert.rejects(f.read({ projectId: 'p', operation: 'pull', number: '1' }, actor), /Unsupported/)
  await assert.rejects(f.read({ projectId: 'p' }, { memberId: 'bob' }), /denied/)
})
test('revocation while reading withholds data and a revoked platform session prevents external calls', async () => {
  const f = setup(); let external = 0
  f.rt.platformIdentityEnabled = true; f.rt.validatePlatformActor = async () => false
  await assert.rejects(f.read({ projectId: 'p' }, { memberId: 'alice' }), /revoked/); assert.equal(f.calls.length, 0)
  const read = createProjectGithubRead(f.rt, { identity: async () => ({ login: 'automation', token: 'secret' }), request: async () => { external++; f.rt.revoked = true; return Response.json([]) } })
  f.rt.validatePlatformActor = async () => true
  await assert.rejects(read({ projectId: 'p' }, { memberId: 'alice' }), /denied/); assert.equal(external, 1)
})

test('published, queued and started are distinct server-derived states', async () => {
  const { taskExecutionStatus } = await import('../src/host/workbench-state.js')
  const task = { id: 't', projectId: 'p', status: 'open', deliveryAttemptId: 'a' }, state = { projectAttempts: { a: { id: 'a', taskId: 't', projectId: 'p', status: 'running' } } }
  assert.equal(taskExecutionStatus({}, { id: 't', status: 'open' }).phase, 'published')
  task.collaboration = { status: 'queued', botId: 'p:dev' }
  assert.equal(taskExecutionStatus(state, task).phase, 'queued')
  task.collaboration.status = 'claimed'; task.collaboration.claim = { workerId: 'w', status: 'active' }
  assert.equal(taskExecutionStatus(state, task).phase, 'starting')
  state.projectHarnessWorkers = { w: { projectId: 'p', attemptId: 'a', status: 'running' } }
  assert.equal(taskExecutionStatus(state, task).phase, 'running')
  task.collaboration.status = 'arbitration'
  assert.equal(taskExecutionStatus(state, task).phase, 'awaiting-chief')
})

test('thread polling observes comments/edits, reviews, inline feedback, checks and head with independent rotating cursors', async () => {
  const f=setup(), urls=[], sha='a'.repeat(40)
  const root={number:7,state:'open',updated_at:'2026-11-01T00:00:00Z',html_url:'https://github.com/owner/repo/pull/7',head:{sha},base:{repo:{full_name:'owner/repo'}}}
  const read=createProjectGithubRead(f.rt,{identity:async()=>({login:'automation',token:'private-token'}),request:async url=>{
    urls.push(url)
    if(/\/pulls\/7$/.test(url))return Response.json(root)
    if(url.includes('check-runs'))return Response.json({check_runs:[{id:4,head_sha:sha,name:'test',status:'completed',conclusion:'success'}]})
    if(url.includes('/reviews?'))return Response.json([{id:2,body:'Review',state:'CHANGES_REQUESTED',commit_id:sha,submitted_at:'2026-11-01T01:00:00Z'},{id:999,body:'Private unsubmitted draft',state:'PENDING',commit_id:sha,submitted_at:null}])
    if(url.includes('/pulls/7/comments?'))return Response.json([{id:3,body:'Inline',commit_id:sha,path:'core/client.js',line:3,in_reply_to_id:1}])
    return Response.json(Array.from({length:20},(_,i)=>({id:i+10,body:'Comment',updated_at:'2026-11-01T02:00:00Z'})))
  }})
  const result=await read({projectId:'p',operation:'thread-events',threadKind:'pull',number:7,pages:{comments:3,checks:4},headSha:'b'.repeat(40)},{memberId:'alice'})
  assert.equal(result.data.events.length,24)
  assert.deepEqual(result.data.pages,{comments:4,reviews:1,inline:1,checks:1})
  assert.ok(urls.some(url=>url.includes('/issues/7/comments?per_page=20&page=3')))
  assert.ok(urls.some(url=>url.includes(`/commits/${sha}/check-runs?per_page=20&page=1`)))
  assert.equal(result.data.events.find(e=>e.type==='inline').path,'core/client.js')
  assert.equal(result.data.events.find(e=>e.type==='reviews').state,'CHANGES_REQUESTED')
  assert.equal(result.data.headSha,sha)
  assert.equal(JSON.stringify(result).includes('private-token'),false)
  assert.equal(JSON.stringify(result).includes('Private unsubmitted draft'),false)
})

test('thread reader rejects invalid cursor, repository/kind mismatch, moving head and malformed event pages', async () => {
  const f=setup(), actor={memberId:'alice'}, base={projectId:'p',operation:'thread-events',threadKind:'pull',number:7}
  for(const extra of [{threadKind:'url'},{pages:null},{pages:{checks:0}},{pages:{foreign:1}},{pages:[]}])await assert.rejects(f.read({...base,...extra},actor),/cursor/)
  for(const variant of ['foreign','url','head','page','identity','moving']){
    let roots=0
    const read=createProjectGithubRead(f.rt,{identity:async()=>({login:'automation',token:'private-token'}),request:async url=>{
      if(/\/pulls\/7$/.test(url)){roots++;return Response.json({number:7,html_url:variant==='url'?'https://example.invalid':'https://github.com/owner/repo/pull/7',head:{sha:variant==='head'?'bad':variant==='moving'&&roots>1?'b'.repeat(40):'a'.repeat(40)},base:{repo:{full_name:variant==='foreign'?'victim/private':'owner/repo'}}})}
      if(variant==='page')return Response.json({unexpected:true})
      if(variant==='identity')return Response.json([{id:'invalid'}])
      return Response.json(url.includes('check-runs')?{check_runs:[]}:[])
    }})
    await assert.rejects(read(base,actor),/mismatch|invalid|moved/,variant)
  }
  const issue=createProjectGithubRead(f.rt,{identity:async()=>({login:'automation',token:'private-token'}),request:async url=>Response.json(url.includes('/comments?')?[]:{number:7,html_url:'https://github.com/owner/repo/issues/7',state:'closed',updated_at:'2026-11-01',pull_request:{}})})
  await assert.rejects(issue({...base,threadKind:'issue'},actor),/mismatch/)
})

test('trusted scheduled Project reads use current principal proof without a browser cookie or personal credential fallback',async()=>{
  const f=setup(),actor={memberId:'alice'}
  let checked=0
  f.rt.platformIdentityEnabled=true;f.rt.validateHumanActor=async()=>false
  f.rt.projectDelegations={async background(id){assert.equal(id,'alice');checked++}}
  await assert.rejects(f.read({projectId:'p',background:true,actor:{trusted:true}},actor),/revoked/)
  assert.equal((await f.read.background({projectId:'p',operation:'issues'},actor)).executorLogin,'automation')
  assert.ok(checked>=2)
  await assert.rejects(f.read.background({projectId:'p',scope:'personal'},actor),/Project automation/)
  f.rt.projectDelegations.background=async()=>{throw Error('principal disabled')}
  await assert.rejects(f.read.background({projectId:'p'},actor),/disabled/)
})

test('a mutable Project cannot retarget its captured repository while credential selection is suspended',async()=>{
  const project={id:'p',repository:'owner/repo'},rt={config:{projectRepositories:{'owner/repo':{github:{login:'automation'}}}},requireProjectAccess(){return project}}
  let calls=0
  const read=createProjectGithubRead(rt,{identity:async()=>{project.repository='victim/private';return{login:'automation',token:'secret'}},request:async()=>{calls++;return Response.json([])}})
  await assert.rejects(read({projectId:'p'},{memberId:'owner'}),/repository changed/)
  assert.equal(calls,0)
})

test('App project reads use minimal scoped installation tokens and never impersonate a personal user', async t => {
  let calls = 0
  const f = appFixture(t, (_url, _options, permissions) => { calls++; assert.deepEqual(permissions, { issues: 'read' }); return Response.json([{ number: 1, title: 'App issue', state: 'open' }]) })
  const rt = { state: {}, config: { projectRepositories: { 'org/repo': { github: f.settings } }, personalGithub: { alice: { p: f.settings } } }, requireProjectAccess: () => ({ id: 'p', repository: 'org/repo' }) }
  const read = createProjectGithubRead(rt, { request: f.request })
  const result = await read({ projectId: 'p', operation: 'issues' }, { memberId: 'alice' })
  assert.equal(result.executorLogin, 'contract-app[bot]'); assert.equal(result.identity.installationId, 12); assert.equal(calls, 1)
  assert(!JSON.stringify(result).includes('ghs_')); assert(!JSON.stringify(result).includes('.pem'))
  await assert.rejects(read({ projectId: 'p', scope: 'personal' }, { memberId: 'alice' }), /independent user/)
  f.suspend(); await assert.rejects(read({ projectId: 'p' }, { memberId: 'alice' }), /installation/); assert.equal(calls, 1)
})
