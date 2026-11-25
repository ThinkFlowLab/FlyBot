import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import model3dFeature from '../features/model3d/index.js'
import { model3dResult, submitModel3d } from '../features/model3d/provider.js'
import { GLB_MIME, MAX_GLB_BYTES, validGlb } from '../lib/glb.js'
import { triangleGlb } from './fixtures/triangle-glb.js'

const WS = 'a'.repeat(32)
const TEAM = 'b'.repeat(32)
const TEXT_API = 'https://api.meshy.ai/openapi/v2/text-to-3d'
const IMAGE_API = 'https://api.meshy.ai/openapi/v1/image-to-3d'
const CDN = 'https://assets.meshy.ai/fixtures/output/model.glb?Expires=123'
const PREVIEW = 'fixture-preview-id'
const REFINE = 'fixture-refine-id'
const IMAGE = 'fixture-image-id'
const config = {provider: 'meshy', model: 'meshy-7.1', api_key: 'fixture-meshy-secret'}
const textInput = {prompt: '浅蓝色陶瓷花瓶'}
const imageInput = {image: {mime: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4n8AAAAASUVORK5CYII='}}
const path = (workspace = WS) => `/v1/workspaces/${workspace}/models-3d`

const GLB = triangleGlb()

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ot-model3d-test-'))
  let enabled = true
  let joined = true
  let feature
  const artifacts = new Map()
  const diagnostics = []
  const host = {
    featureDir: () => dir,
    log: message => diagnostics.push(message),
    async call(name, input) {
      if (name === 'agents/personal-binding') return {workspace_id: WS}
      if (name === 'teams/activeWorkspaces') return joined ? [{id: TEAM}] : []
      if (name === 'model-api/model3dProvider') return enabled ? config : null
      if (name === 'model3d/wake') return feature.endpoints.wake(input, {internal: true})
      if (name === 'artifacts/generatedModel3d') {
        const key = input.workspace_id + ':' + input.job_id
        if (input.data) {
          assert.ok(input.title)
          assert.deepEqual(input.data, GLB)
          artifacts.set(key, {id: input.job_id})
        }
        return artifacts.get(key)
      }
      throw Error('unexpected endpoint')
    },
  }
  t.after(() => {
    feature?.store.close()
    rmSync(dir, {recursive: true, force: true})
  })
  return {
    begin() { feature = model3dFeature(host) },
    stop() { feature.store.close(); feature = null },
    get store() { return feature.store },
    get diagnostics() { return diagnostics },
    configure(value) { enabled = value },
    joinTeam(value) { joined = value },
    save(workspace, id, artifact) { artifacts.set(workspace + ':' + id, {id: artifact}) },
    async due(id) {
      feature.store.run('UPDATE model3d_jobs SET next_check=0 WHERE id=?', id)
      await feature.endpoints.wake({}, {internal: true})
    },
    request(method, target, body, key) { return feature.endpoints.v1({method, path: target, body, idempotency_key: key}) },
  }
}

function withProvider(t, fetcher) {
  const previous = globalThis.fetch
  globalThis.fetch = fetcher
  t.after(() => { globalThis.fetch = previous })
}

async function observed(read, matches) {
  for (let attempt = 0; attempt < 150; attempt++) {
    const result = await read()
    if (matches(result)) return result
    await delay(20)
  }
  assert.fail('3D worker did not reach the expected state')
}

test('text to 3D queues immediately and saves one model after the preview and texture stages', async t => {
  assert.equal(validGlb(GLB), true)
  const f = fixture(t)
  f.begin()
  const requests = []
  let release
  let previewChecks = 0
  const held = new Promise(resolve => { release = resolve })
  t.after(release)
  withProvider(t, async (url, options) => {
    requests.push([options.method, url])
    assert.equal(options.redirect, 'error')
    if (url === CDN) {
      assert.deepEqual(options.headers, {Accept: GLB_MIME})
      return new Response(GLB, {headers: {'Content-Type': GLB_MIME}})
    }
    assert.equal(options.headers.Authorization, 'Bearer ' + config.api_key)
    if (url === TEXT_API) {
      const body = JSON.parse(options.body)
      if (body.mode === 'preview') {
        assert.deepEqual(body, {target_formats: ['glb'], moderation: true, should_remesh: true, topology: 'triangle',
          target_polycount: 12000, mode: 'preview', ai_model: 'meshy-7.1', prompt: textInput.prompt})
        await held
        return Response.json({result: PREVIEW})
      }
      assert.deepEqual(body, {target_formats: ['glb'], moderation: true, enable_pbr: false, texture_resolution: '2k',
        mode: 'refine', preview_task_id: PREVIEW, texture_prompt: textInput.prompt})
      return Response.json({result: REFINE})
    }
    if (url === TEXT_API + '/' + PREVIEW) {
      previewChecks++
      return Response.json(previewChecks === 1 ? {id: PREVIEW, status: 'IN_PROGRESS', progress: 47}
        : {id: PREVIEW, status: 'SUCCEEDED'})
    }
    assert.equal(url, TEXT_API + '/' + REFINE)
    return Response.json({id: REFINE, status: 'SUCCEEDED', model_urls: {glb: CDN}})
  })
  const key = 'test-model3d-text-a'
  f.configure(false)
  assert.deepEqual((await f.request('GET', path())).body, {configured: false, job: null})
  assert.equal((await f.request('POST', path(), textInput, key)).body.error.code, 'model3d_unconfigured')
  f.configure(true)
  assert.equal((await f.request('POST', path(), {prompt: 'x'.repeat(801)}, key)).status, 400)
  const [accepted, replayed] = await Promise.all([
    f.request('POST', path(), textInput, key),
    f.request('POST', path(), textInput, key),
  ])
  assert.equal(accepted.status, 202)
  const {id} = accepted.body.job
  assert.deepEqual(accepted.body.job, {id, ...textInput, source: 'text', state: 'queued', stage: null, progress: 0, artifact_id: null})
  assert.equal(replayed.body.job.id, id)
  assert.equal((await f.request('POST', path(), imageInput, key)).status, 409)
  assert.equal((await f.request('GET', path(TEAM) + '/' + id)).status, 404)
  release()
  const persisted = () => f.store.get('SELECT * FROM model3d_jobs WHERE id=?', id)
  await observed(persisted, row => row.provider_id === PREVIEW)
  await f.due(id)
  await observed(persisted, row => row.progress === 23)
  assert.equal((await f.request('GET', path() + '/' + id)).body.job.stage, 'preview')
  await f.due(id)
  await observed(persisted, row => row.provider_id === REFINE && row.preview_id === PREVIEW)
  const active = (await f.request('GET', path())).body.job
  assert.equal(active.stage, 'refine')
  assert.equal(active.progress, 50)
  await f.due(id)
  const result = await observed(() => f.request('GET', path() + '/' + id), response => response.body.job.state === 'succeeded')
  assert.deepEqual(result.body.job, {id, ...textInput, source: 'text', state: 'succeeded', stage: 'refine', progress: 100, artifact_id: id})
  assert.doesNotMatch(JSON.stringify(result), /fixture-(preview-id|refine-id|meshy-secret)/)
  assert.equal((await f.request('POST', path(), textInput, key)).body.job.artifact_id, id)
  assert.deepEqual(requests, [
    ['POST', TEXT_API], ['GET', TEXT_API + '/' + PREVIEW], ['GET', TEXT_API + '/' + PREVIEW],
    ['POST', TEXT_API], ['GET', TEXT_API + '/' + REFINE], ['GET', CDN],
  ])
  assert.deepEqual(f.diagnostics, [])
})

test('image generation validates inputs, starts one task, and drops the reference from the job row', async t => {
  const f = fixture(t)
  f.begin()
  let submissions = 0
  let release
  const held = new Promise(resolve => { release = resolve })
  t.after(release)
  withProvider(t, async (url, options) => {
    if (url === IMAGE_API) {
      assert.equal(++submissions, 1)
      assert.equal(options.method, 'POST')
      assert.deepEqual(JSON.parse(options.body), {target_formats: ['glb'], moderation: true, should_remesh: true,
        topology: 'triangle', target_polycount: 12000, enable_pbr: false, texture_resolution: '2k', ai_model: 'meshy-7.1',
        image_url: 'data:image/png;base64,' + imageInput.image.data, should_texture: true})
      await held
      return Response.json({result: IMAGE})
    }
    if (url === IMAGE_API + '/' + IMAGE) return Response.json({id: IMAGE, status: 'SUCCEEDED', model_urls: {glb: CDN}})
    assert.equal(url, CDN)
    return new Response(GLB, {headers: {'Content-Type': 'application/octet-stream'}})
  })
  const key = 'test-model3d-image'
  const invalid = [
    {...imageInput, ...textInput},
    {image: {...imageInput.image, mime: 'image/jpeg'}},
    {image: {...imageInput.image, data: imageInput.image.data + '\n'}},
    {image: {...imageInput.image, url: 'https://example.org/image.png'}},
  ]
  for (const input of invalid) assert.equal((await f.request('POST', path(TEAM), input, key)).status, 400)
  const oversized = {image: {mime: 'image/png', data: Buffer.alloc(2 * 1024 * 1024 + 1).toString('base64')}}
  assert.equal((await f.request('POST', path(TEAM), oversized, key)).status, 413)
  const queued = await f.request('POST', path(TEAM), imageInput, key)
  assert.equal(queued.status, 202)
  assert.equal(queued.body.job.source, 'image')
  assert.equal(queued.body.job.prompt, '')
  assert.equal(Object.hasOwn(queued.body.job, 'image'), false)
  const {id} = queued.body.job
  const persisted = () => f.store.get('SELECT * FROM model3d_jobs WHERE id=?', id)
  const claimed = await observed(persisted, row => row.stage === 'image')
  assert.equal(claimed.image_base64, null)
  assert.equal(claimed.image_mime, null)
  assert.equal((await f.request('POST', path(TEAM), imageInput, key)).body.job.id, id)
  release()
  await observed(persisted, row => row.provider_id === IMAGE)
  await f.due(id)
  const saved = await observed(() => f.request('GET', path(TEAM)), response => response.body.job.state === 'succeeded')
  f.joinTeam(false)
  assert.equal((await f.request('GET', path(TEAM) + '/' + id)).status, 404)
  assert.equal(saved.body.job.artifact_id, id)
  assert.equal(submissions, 1)
})

test('startup resumes polling, recovers an already written model, and does not repeat an ambiguous POST', async t => {
  const f = fixture(t)
  f.begin()
  const now = Date.now()
  const seed = (id, stage, submitted, providerId, preview) => {
    f.store.run(`INSERT INTO model3d_jobs(id,workspace_id,key,input_hash,source,prompt,state,stage,
      created,next_check,submitted,provider_id,preview_id) VALUES(?,?,?,?,'text',?,'running',?,?,0,?,?,?)`,
    id, TEAM, 'test-' + id, 'hash-' + id, textInput.prompt, stage, Math.floor(now / 1000), submitted, providerId, preview)
  }
  const resumed = '1'.repeat(32)
  const ambiguous = '2'.repeat(32)
  const recovered = '3'.repeat(32)
  const readyRefine = '4'.repeat(32)
  seed(resumed, 'refine', now, REFINE, PREVIEW)
  seed(ambiguous, 'refine', now, null, PREVIEW)
  seed(recovered, 'refine', now, REFINE, PREVIEW)
  seed(readyRefine, 'refine', null, null, PREVIEW)
  f.save(TEAM, recovered, 'f'.repeat(32))
  f.stop()
  const seen = []
  withProvider(t, async (url, options) => {
    seen.push([url, options.method])
    if (url === TEXT_API) {
      assert.equal(JSON.parse(options.body).mode, 'refine')
      assert.equal(JSON.parse(options.body).preview_task_id, PREVIEW)
      return Response.json({result: 'ready-refine-submission'})
    }
    if (url === CDN) return new Response(GLB)
    assert.ok([TEXT_API + '/' + REFINE, TEXT_API + '/ready-refine-submission'].includes(url))
    return Response.json({id: url.split('/').at(-1), status: 'SUCCEEDED', model_urls: {glb: CDN}})
  })
  f.begin()
  const get = id => f.request('GET', path(TEAM) + '/' + id)
  const completed = await observed(() => get(resumed), response => response.body.job.state === 'succeeded')
  assert.equal(completed.body.job.artifact_id, resumed)
  const missing = await observed(() => get(ambiguous), response => response.body.job.state === 'failed')
  assert.match(missing.body.job.message, /未能确认/)
  assert.equal((await get(recovered)).body.job.artifact_id, 'f'.repeat(32))
  await observed(() => f.store.get('SELECT provider_id FROM model3d_jobs WHERE id=?', readyRefine),
    row => row.provider_id === 'ready-refine-submission')
  await f.due(readyRefine)
  await observed(() => get(readyRefine), response => response.body.job.state === 'succeeded')
  assert.deepEqual(seen, [
    [TEXT_API + '/' + REFINE, 'GET'], [CDN, 'GET'], [TEXT_API, 'POST'],
    [TEXT_API + '/ready-refine-submission', 'GET'], [CDN, 'GET'],
  ])
})

test('unsafe assets and provider errors keep credentials private and enforce the byte limit', async () => {
  for (const result of [{result: '../invalid'}, {result: ['invalid']}]) {
    await assert.rejects(submitModel3d(config, 'preview', textInput, async () => Response.json(result)), {code: 'uncertain'})
  }
  await assert.rejects(submitModel3d(config, 'preview', textInput, async () => { throw Error('provider: secret') }), {
    code: 'uncertain', message: 'uncertain',
  })
  await assert.rejects(submitModel3d(config, 'preview', textInput,
    async () => new Response('internal vendor detail', {status: 403})), {code: 'rejected', message: 'rejected'})
  const from = (output, body) => async (url, options) => {
    assert.equal(options.redirect, 'error')
    if (url === TEXT_API + '/' + REFINE) return Response.json({id: REFINE, status: 'SUCCEEDED', model_urls: {glb: output}})
    assert.equal(String(url), output)
    assert.deepEqual(options.headers, {Accept: GLB_MIME})
    assert.ok(body, 'invalid asset URL should never be fetched')
    return body
  }
  for (const url of [
    'http://assets.meshy.ai/test.glb',
    'https://assets.meshy.ai:443/test.glb',
    'https://nested.assets.meshy.ai/test.glb',
    'https://assets.meshy.ai@localhost/test.glb',
    'https://assets.meshy.ai.evil.example/test.glb',
    'https://assets.meshy.ai/test.glb#fragment',
  ]) {
    await assert.rejects(model3dResult(config, 'refine', REFINE, from(url)), {code: 'failed'})
  }
  await assert.rejects(model3dResult(config, 'refine', REFINE, from(CDN, Response.redirect('https://invalid.test'))), {code: 'failed'})
  await assert.rejects(model3dResult(config, 'refine', REFINE, from(CDN, new Response(GLB.slice(0, 12)))), {code: 'failed'})
  await assert.rejects(model3dResult(config, 'refine', REFINE, from(CDN, new Response(GLB, {
    headers: {'Content-Length': String(MAX_GLB_BYTES + 1)},
  }))), {code: 'too_large'})
  const oversized = new ReadableStream({start(controller) {
    controller.enqueue(new Uint8Array(MAX_GLB_BYTES))
    controller.enqueue(new Uint8Array(1))
    controller.close()
  }})
  await assert.rejects(model3dResult(config, 'refine', REFINE, from(CDN, new Response(oversized))), {code: 'too_large'})
  assert.deepEqual(await model3dResult(config, 'refine', REFINE, from(CDN, new Response(GLB))), {done: true, data: GLB})
})

test('GLB preview input must be self-contained and have a finite scene tree', () => {
  assert.equal(validGlb(triangleGlb()), true)
  assert.equal(validGlb(triangleGlb({customize(model) {
    model.buffers[0].uri = 'https://example.invalid/model.bin'
  }})), false)
  assert.equal(validGlb(triangleGlb({customize(model) {
    model.nodes[0].children = [0]
  }})), false)
  assert.equal(validGlb(triangleGlb({customize(model) {
    model.accessors[0].count = 10_000_000
  }})), false)
})
