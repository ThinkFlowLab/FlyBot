import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import artifactsFeature from '../features/artifacts/index.js'
import imageFeature from '../features/images/index.js'
import { createModelApi } from '../features/model-api/model-api.js'
import { compatHandler } from '../lib/b4/compat.js'

const WS = 'a'.repeat(32)
const OTHER = 'b'.repeat(32)
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==','base64')
const providerUrl = 'https://images.example.test/v1'
const path = `/v1/workspaces/${WS}/images`

test('an image task survives the request and stores its own private media without repeating generation', async () => {
  const dir = mkdtempSync(join(tmpdir(),'ot-image-jobs-'))
  const fixtureKey = 'synthetic-image-test-key'
  const api = createModelApi({dir,sealKey:Buffer.alloc(32,3),platform:()=>null})
  const config = compatHandler(api.legacy)
  const set = (changes, revision = 0) => config({method:'POST',path:'/v1/model-api/image',body:{revision,changes}})
  let calls = 0
  let activeMember = true
  const original = globalThis.fetch
  const host = {
    dataDir:dir,featureDir:()=>dir,
    async call(name,payload) {
      if (name === 'model-api/imageProvider') return api.resolveImage()
      if (name === 'agents/personal-binding') return null
      if (name === 'teams/activeWorkspaces') return activeMember ? [{id:WS}] : []
      if (name === 'artifacts/generatedImage') return artifacts.endpoints.generatedImage(payload,{internal:true})
      if (name === 'images/wake') return images.endpoints.wake(payload,{internal:true})
      throw Error('Unexpected endpoint')
    },
  }
  const artifacts = artifactsFeature(host)
  const images = imageFeature(host)
  const image = (method,route,body,idempotency_key) => images.endpoints.v1({method,path:route,body,idempotency_key})
  const renderSpec = {prompt:'A red sail at dusk',shape:'portrait'}
  let release
  const modelCanAnswer = new Promise(resolve => { release = resolve })
  globalThis.fetch = async (url,options) => {
    calls++
    assert.equal(url,providerUrl+'/images/generations')
    assert.equal(options.headers.Authorization,'Bearer '+fixtureKey)
    assert.equal(options.redirect,'error')
    assert.equal(JSON.parse(options.body).size,'1024x1536')
    await modelCanAnswer
    return Response.json({data:[{b64_json:PNG.toString('base64')}]})
  }
  try {
    assert.equal((await image('GET',path)).body.configured,false)
    assert.equal((await image('GET',path.replace(WS,OTHER))).status,404)
    const key = 'repeat-image-generation'
    assert.equal((await image('POST',path,renderSpec,key)).status,503)
    assert.equal((await set({base_url:'http://images.example.test/v1',model:'test-image',api_key:fixtureKey})).status,400)
    const saved = await set({base_url:providerUrl,model:'test-image',api_key:fixtureKey})
    assert.equal(saved.body.image_api.api_key_set,true)
    assert.equal(saved.body.image_api.revision,1)
    assert.doesNotMatch(JSON.stringify(saved),/synthetic-image-test-key/)
    assert.doesNotMatch(readFileSync(join(dir,'model-api.json'),'utf8'),/synthetic-image-test-key/)
    assert.equal((await config({method:'GET',path:'/v1/model-api'})).body.model_api.api_key_set,false)
    assert.equal((await image('POST',path,{...renderSpec,shape:['portrait']},key)).status,400)
    const started = await image('POST',path,renderSpec,key)
    assert.equal(started.status,202)
    const id = started.body.job.id
    assert.equal((await image('POST',path,renderSpec,key)).body.job.id,id)
    assert.equal((await image('POST',path,{...renderSpec,shape:'square'},key)).status,409)
    assert.equal((await image('GET',path.replace(WS,OTHER)+'/'+id)).status,404)
    assert.equal((await image('GET',path,undefined,key)).body.job.id,id)
    assert.equal((await image('GET',path,undefined,'another-image-request')).body.job,null)
    assert.equal((await image('GET',path,undefined,'bad')).status,400)
    activeMember = false
    assert.equal((await image('GET',path)).status,404)
    assert.equal((await image('GET',path,undefined,key)).status,404)
    assert.equal((await image('GET',path+'/'+id)).status,404)
    activeMember = true
    release()
    let done
    for (let i=0;i<80;i++) {
      done = (await image('GET',path+'/'+id)).body.job
      if (['succeeded','failed'].includes(done.state)) break
      await delay(30)
    }
    assert.equal(done.state,'succeeded',done.message)
    const stored = await artifacts.endpoints.v1({method:'GET',path:`/v1/workspaces/${WS}/artifacts/${done.artifact_id}/file`})
    assert.equal(stored.download.content_type,'image/png')
    assert.deepEqual(Buffer.from(stored.download.data,'base64'),PNG)
    assert.equal((await image('POST',path,renderSpec,key)).body.job.artifact_id,done.artifact_id)
    assert.equal(calls,1)
    assert.equal((await set({api_key:null},1)).body.image_api.api_key_set,false)
  } finally {
    release()
    globalThis.fetch = original
    images.store.close()
    artifacts.store.close()
    rmSync(dir,{recursive:true,force:true})
  }
})
