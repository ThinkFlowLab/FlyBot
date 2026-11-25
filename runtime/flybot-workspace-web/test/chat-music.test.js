import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import artifactsFeature from '../features/artifacts/index.js'
import musicFeature from '../features/music/index.js'
import { generateMusic } from '../features/music/provider.js'

const WS = 'a'.repeat(32)
const TEAM = 'b'.repeat(32)
const KEY = 'synthetic-music-provider-key'
const CONFIG = { provider: 'elevenlabs', model: 'music_v2_5', api_key: KEY }
const PATH = `/v1/workspaces/${WS}/music`
const SPEC = { prompt: 'An ambient guitar duet', duration: 15, instrumental: true }
const RESUMED_SPEC = { prompt: 'A quiet song after the storm', duration: 30, instrumental: false }
const MP3 = Buffer.alloc(2 * 576)
for (const offset of [0, 576]) MP3.set([0xff, 0xfb, 0xb4, 0x00], offset)

const mp3Response = (body = MP3) => new Response(body, { headers: { 'content-type': 'audio/mpeg' } })

async function waitFor(check) {
  for (let i = 0; i < 100; i++) {
    const result = await check()
    if (result) return result
    await delay(20)
  }
  assert.fail('Music job did not reach the expected state')
}

test('music generation responds immediately, stores private audio, and recovers without another paid request', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ot-music-jobs-'))
  let configured = false
  let teamsOnline = true
  const submitted = []
  let music
  const host = {
    dataDir: dir, featureDir: () => dir,
    async call(name, payload) {
      if (name === 'model-api/musicProvider') return configured ? CONFIG : null
      if (name === 'agents/personal-binding') return { workspace_id: WS }
      if (name === 'teams/activeWorkspaces') {
        if (!teamsOnline) throw new Error('Membership lookup timed out')
        return [{ id: TEAM }]
      }
      if (name === 'artifacts/generatedMusic') return artifacts.endpoints.generatedMusic(payload, { internal: true })
      if (name === 'music/wake') return music.endpoints.wake(payload, { internal: true })
      throw Error('Unexpected endpoint')
    },
  }
  const artifacts = artifactsFeature(host)
  music = musicFeature(host)
  const request = (method, path, body, idempotency_key = 'generate-a-test-song') => music.endpoints.v1({ method, path, body, idempotency_key })
  const pendingProvider = Promise.withResolvers()
  const original = globalThis.fetch
  t.after(() => {
    pendingProvider.resolve()
    globalThis.fetch = original
    music.store.close()
    artifacts.store.close()
    rmSync(dir, { recursive: true, force: true })
  })
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://api.elevenlabs.io/v1/music?output_format=mp3_48000_192')
    assert.equal(options.method, 'POST')
    assert.equal(options.redirect, 'error')
    assert.equal(options.headers['xi-api-key'], KEY)
    submitted.push(JSON.parse(options.body))
    await pendingProvider.promise
    return mp3Response()
  }

  assert.deepEqual((await request('GET', PATH)).body, { configured: false, job: null })
  assert.equal((await request('POST', PATH, SPEC)).body.error.code, 'music_unconfigured')
  configured = true
  for (const change of [{ duration: '15' }, { duration: 12 }, { instrumental: 1 }, { prompt: ' '.repeat(30) }]) {
    assert.equal((await request('POST', PATH, { ...SPEC, ...change })).status, 400)
  }
  const [accepted, replay] = await Promise.all([request('POST', PATH, SPEC), request('POST', PATH, SPEC)])
  assert.equal(accepted.status, 202)
  const id = accepted.body.job.id
  assert.deepEqual(accepted.body.job, { id, ...SPEC, state: 'queued', artifact_id: null })
  assert.equal(replay.body.job.id, id)
  assert.equal((await request('POST', PATH, { ...SPEC, instrumental: false })).status, 409)
  assert.equal((await request('GET', `${PATH.replace(WS, TEAM)}/${id}`)).status, 404)
  await waitFor(async () => (await request('GET', `${PATH}/${id}`)).body.job.state === 'running')
  assert.deepEqual(submitted, [{ prompt: SPEC.prompt, music_length_ms: 15000, model_id: 'music_v2_5', force_instrumental: true }])
  pendingProvider.resolve()
  const completed = await waitFor(async () => {
    const job = (await request('GET', `${PATH}/${id}`)).body.job
    return ['succeeded', 'failed'].includes(job.state) && job
  })
  assert.equal(completed.state, 'succeeded', completed.message)
  const stored = await artifacts.endpoints.v1({ method: 'GET', path: `/v1/workspaces/${WS}/artifacts/${completed.artifact_id}/file` })
  assert.equal(stored.download.content_type, 'audio/mpeg')
  assert.deepEqual(Buffer.from(stored.download.data, 'base64'), MP3)

  // Simulate persisted jobs after a restart, including a workspace membership timeout.
  const interrupted = 'c'.repeat(32)
  const inaccessible = 'd'.repeat(32)
  const queued = 'e'.repeat(32)
  music.store.run("UPDATE music_jobs SET state='running',artifact_id=NULL WHERE id=?", id)
  music.store.run("INSERT INTO music_jobs VALUES(?,?,?,?,15,1,'running',?,NULL,NULL)", interrupted, WS, 'interrupted-music-job', SPEC.prompt, 1)
  music.store.run("INSERT INTO music_jobs VALUES(?,?,?,?,15,1,'queued',?,NULL,NULL)", inaccessible, TEAM, 'team-music-job', SPEC.prompt, 1)
  music.store.run("INSERT INTO music_jobs VALUES(?,?,?,?,30,0,'queued',?,NULL,NULL)", queued, WS, 'queued-music-job', RESUMED_SPEC.prompt, 1)
  music.store.close()
  teamsOnline = false
  music = musicFeature(host)
  const resumed = await waitFor(async () => {
    const job = (await request('GET', `${PATH}/${queued}`)).body.job
    return job.state === 'succeeded' && job
  })
  const recovered = (await request('GET', `${PATH}/${id}`)).body.job
  assert.notEqual(resumed.artifact_id, recovered.artifact_id)
  assert.equal(recovered.state, 'succeeded')
  assert.equal(recovered.artifact_id, completed.artifact_id)
  assert.equal((await request('GET', `${PATH}/${interrupted}`)).body.job.state, 'failed')
  assert.match((await request('GET', `${PATH}/${interrupted}`)).body.job.message, /ElevenLabs/)
  assert.equal((await request('GET', `${PATH.replace(WS, TEAM)}/${inaccessible}`)).status, 404)
  assert.equal(music.store.get('SELECT state FROM music_jobs WHERE id=?', inaccessible).state, 'failed')
  assert.equal((await request('POST', PATH, SPEC)).body.job.artifact_id, completed.artifact_id)
  assert.equal(submitted.length, 2)
  assert.deepEqual(submitted[1], { prompt: RESUMED_SPEC.prompt, music_length_ms: 30000, model_id: 'music_v2_5', force_instrumental: false })
})

test('music provider bounds the audio stream and hides vendor errors', async (t) => {
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  const check = async (response, code) => {
    globalThis.fetch = async () => response
    await assert.rejects(generateMusic(CONFIG, SPEC), { code, message: 'Music generation failed' })
  }
  await check(new Response(KEY, { status: 403 }), 'auth')
  await check(new Response(KEY, { status: 429 }), 'busy')
  await check(new Response(KEY, { status: 503 }), 'uncertain')
  await check(Response.redirect('https://other.test/audio.mp3'), 'uncertain')
  await check(new Response(MP3, { headers: { 'content-type': 'application/octet-stream' } }), 'uncertain')
  await check(mp3Response(Buffer.from('ID3fake audio')), 'uncertain')
  await check(mp3Response(MP3.subarray(0, MP3.length - 1)), 'uncertain')
  await check(new Response(MP3, { headers: { 'content-type': 'audio/mpeg', 'content-length': '2097153' } }), 'uncertain')
  let cancelled = false
  const stream = new ReadableStream({
    start(controller) { controller.enqueue(Buffer.alloc(2 * 1024 * 1024 + 1)) },
    cancel() { cancelled = true },
  })
  await check(mp3Response(stream), 'uncertain')
  assert.equal(cancelled, true)
})
