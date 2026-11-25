import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import videoFeature from '../features/videos/index.js'
import { submitVideo, videoResult } from '../features/videos/provider.js'

const WS = 'a'.repeat(32)
const TEAM = 'b'.repeat(32)
const API = 'https://api.dev.runwayml.com/v1'
const CDN = 'https://dnznrvs05pmza.cloudfront.net/test.mp4?fixture=1'
const TASK = '6b5ff6bc-8888-4782-835b-884cc9ca9650'
const PATH = `/v1/workspaces/${WS}/videos`
const config = {provider:'runway', model:'gen4.5', api_key:'synthetic-runway-key'}
const prompt = {prompt:'A sailboat at dusk',shape:'portrait'}
// Container framing fixture. Real playback is checked in the browser test.
const MP4 = Buffer.from('000000146674797069736f6d0000000069736f6d000000096d6f6f7600000000096d64617401','hex')

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(),'ot-video-jobs-'))
  t.after(() => rmSync(dir,{recursive:true,force:true}))
  let enabled = true
  let inTeam = true
  let feature
  const saved = new Map()
  const host = {
    featureDir: () => dir,
    async call(name,input) {
      if (name === 'agents/personal-binding') return {workspace_id:WS}
      if (name === 'teams/activeWorkspaces') return inTeam ? [{id:TEAM}] : []
      if (name === 'model-api/videoProvider') return enabled ? config : null
      if (name === 'videos/wake') return feature.endpoints.wake(input,{internal:true})
      if (name === 'artifacts/generatedVideo') {
        if (input.data) {
          assert.deepEqual(input.data,MP4)
          saved.set(input.job_id,{id:'f'.repeat(32)})
        }
        return saved.get(input.job_id)
      }
      throw Error('unexpected endpoint')
    },
  }
  return {
    get store() { return feature.store },
    begin() { feature = videoFeature(host) },
    stop() { feature.store.close() },
    configure(value) { enabled = value },
    joinTeam(value) { inTeam = value },
    async due(id) {
      feature.store.run('UPDATE video_jobs SET next_check=0 WHERE id=?',id)
      await feature.endpoints.wake({},{internal:true})
    },
    request(method,path,body,idempotency_key) {
      return feature.endpoints.v1({method,path,body,idempotency_key})
    },
  }
}

async function observed(read, predicate) {
  for (let attempt = 0; attempt < 150; attempt++) {
    const result = await read()
    if (predicate(result)) return result
    await delay(20)
  }
  assert.fail('video worker did not reach expected state')
}

test('video is queued immediately, published through bounded external jobs, and remains private to its workspace', async t => {
  const f = fixture(t)
  f.begin()
  t.after(() => f.stop())
  let submitted = 0
  let polled = 0
  let downloads = 0
  let providerWait
  const generationAccepted = new Promise(resolve => { providerWait = resolve })
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original; providerWait() })
  globalThis.fetch = async (url,options) => {
    assert.equal(options.redirect,'error')
    if (url === CDN) {
      assert.equal(options.method,'GET')
      assert.equal(options.headers.Authorization,undefined)
      downloads++
      return new Response(MP4,{headers:{'Content-Type':'video/mp4'}})
    }
    assert.equal(options.headers.Authorization,'Bearer '+config.api_key)
    assert.equal(options.headers['X-Runway-Version'],'2024-11-06')
    if (url === API + '/text_to_video') {
      assert.equal(options.method,'POST')
      assert.deepEqual(JSON.parse(options.body),{model:'gen4.5',promptText:prompt.prompt,ratio:'720:1280',duration:5})
      submitted++
      await generationAccepted
      return Response.json({id:TASK})
    }
    assert.equal(url,API + '/tasks/' + TASK)
    assert.equal(options.method,'GET')
    polled++
    return Response.json(polled === 1 ? {id:TASK,status:'RUNNING'} : {id:TASK,status:'SUCCEEDED',output:[CDN]})
  }
  const key = 'fixture-video-idempotency'
  f.configure(false)
  assert.equal((await f.request('GET',PATH)).body.configured,false)
  assert.equal((await f.request('POST',PATH,prompt,key)).body.error.code,'video_unconfigured')
  f.configure(true)
  assert.equal((await f.request('POST',PATH,{...prompt,shape:'square'},key)).status,400)
  assert.equal((await f.request('POST',PATH,{...prompt,prompt:'x'.repeat(1001)},key)).status,400)
  const queued = await f.request('POST',PATH,prompt,key)
  assert.equal(queued.status,202)
  assert.equal(queued.body.job.state,'queued')
  const id = queued.body.job.id
  assert.equal((await f.request('POST',PATH,prompt,key)).body.job.id,id)
  assert.equal((await f.request('POST',PATH,{...prompt,shape:'landscape'},key)).status,409)
  assert.equal((await f.request('GET',PATH.replace(WS,TEAM)+'/'+id)).status,404)
  providerWait()
  await observed(() => f.store.get('SELECT * FROM video_jobs WHERE id=?',id),row => row.provider_id === TASK)
  await f.due(id)
  await observed(() => f.store.get('SELECT * FROM video_jobs WHERE id=?',id),row => polled === 1 && row.next_check > Date.now())
  await f.due(id)
  const result = await observed(() => f.request('GET',PATH+'/'+id),response => ['succeeded','failed'].includes(response.body.job.state))
  assert.equal(result.body.job.state,'succeeded',result.body.job.message)
  assert.equal(result.body.job.artifact_id,'f'.repeat(32))
  assert.doesNotMatch(JSON.stringify(result),new RegExp(TASK+'|'+config.api_key))
  assert.equal((await f.request('GET',PATH)).body.job.id,id)
  assert.equal((await f.request('POST',PATH,prompt,key)).body.job.artifact_id,result.body.job.artifact_id)
  assert.deepEqual({submitted,polled,downloads},{submitted:1,polled:2,downloads:1})
})

test('startup picks up persisted task IDs and reconciles interrupted submissions without sending again', async t => {
  const f = fixture(t)
  f.begin()
  const resume = '1'.repeat(32)
  const ambiguous = '2'.repeat(32)
  const now = Date.now()
  const seed = (id,external) => f.store.run(`INSERT INTO video_jobs(
    id,workspace_id,key,prompt,shape,state,created,next_check,submitted,provider_id)
    VALUES(?,?,?,?,'landscape','running',?,0,?,?)`,
  id,TEAM,'test-' + id,'fixture',Math.floor(now/1000),now,external)
  seed(resume,TASK)
  seed(ambiguous,null)
  f.stop()
  const original = globalThis.fetch
  const seen = []
  globalThis.fetch = async (url,options) => {
    seen.push([url,options.method])
    if (url === API + '/tasks/' + TASK) return Response.json({id:TASK,status:'SUCCEEDED',output:[CDN]})
    if (url === CDN) return new Response(MP4,{headers:{'Content-Type':'video/mp4'}})
    assert.fail('unexpected provider request')
  }
  t.after(() => { globalThis.fetch = original; f.stop() })
  f.begin()
  const get = id => f.request('GET',PATH.replace(WS,TEAM)+'/'+id)
  const done = await observed(() => get(resume),response => response.body.job.state === 'succeeded')
  assert.equal(done.body.job.artifact_id,'f'.repeat(32))
  const row = await observed(() => get(ambiguous),response => response.body.job.state === 'failed')
  assert.match(row.body.job.message,/未能确认/)
  assert.deepEqual(seen,[[API + '/tasks/' + TASK,'GET'],[CDN,'GET']])
  f.joinTeam(false)
  assert.equal((await get(resume)).status,404)
})

test('malformed provider receipts and unsafe or malformed media fail without credentials escaping', async () => {
  await assert.rejects(submitVideo(config,prompt,async () => Response.json({id:['not-a-task']})),
    error => error.code === 'uncertain')
  await assert.rejects(submitVideo(config,prompt,async () => { throw Error('network') }),
    error => error.code === 'uncertain')
  const from = (output,body) => async (url,options) => {
    if (url === API + '/tasks/' + TASK) return Response.json({id:TASK,status:'SUCCEEDED',output:[output]})
    assert.equal(url,output)
    assert.deepEqual(options.headers,{Accept:'video/mp4'})
    return body
  }
  for (const url of [
    'http://dnznrvs05pmza.cloudfront.net/test.mp4',
    'https://elsewhere.test/test.mp4',
    'https://other.dnznrvs05pmza.cloudfront.net/test.mp4',
    'https://dnznrvs05pmza.cloudfront.net:443/test.mp4',
    'https://dnznrvs05pmza.cloudfront.net:8443/test.mp4',
    'https://dnznrvs05pmza.cloudfront.net@localhost/test.mp4',
    'https://secret@dnznrvs05pmza.cloudfront.net/test.mp4',
  ]) {
    await assert.rejects(videoResult(config,TASK,from(url)),error => error.code === 'failed')
  }
  const alternate = 'https://dotherfixture.cloudfront.net/test.mp4?_jwt=fixture'
  assert.deepEqual(await videoResult(config,TASK,from(alternate,new Response(MP4))),MP4)
  await assert.rejects(videoResult(config,TASK,from(CDN,new Response(MP4.slice(0,20)))),
    error => error.code === 'failed')
  await assert.rejects(videoResult(config,TASK,from(CDN,Response.redirect('https://invalid.test'))),
    error => error.code === 'failed')
  await assert.rejects(videoResult(config,TASK,from(CDN,new Response(MP4,{headers:{'Content-Length':String(9*1024*1024)}}))),
    error => error.code === 'too_large')
  const oversized = new ReadableStream({start(controller) {
    controller.enqueue(new Uint8Array(8*1024*1024))
    controller.enqueue(new Uint8Array(1))
    controller.close()
  }})
  await assert.rejects(videoResult(config,TASK,from(CDN,new Response(oversized))),
    error => error.code === 'too_large')
})
