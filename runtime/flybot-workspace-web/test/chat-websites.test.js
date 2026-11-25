import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import artifactsFeature from '../features/artifacts/index.js'
import { BODY_MAX, TITLE_MAX } from '../features/artifacts/model.js'
import websitesFeature from '../features/websites/index.js'
import { generateWebsite } from '../features/websites/provider.js'

const PERSONAL = 'a'.repeat(32)
const TEAM = 'b'.repeat(32)
const OTHER = 'c'.repeat(32)
const KEY = 'generate-local-website'
const PROMPT = '做一个可以点击计数的网页'
const TITLE = '点击计数'
const HTML = '<!doctype html><html lang="zh"><head><title>点击计数</title></head><body><button id="count" type="button">0</button><script>const button = document.getElementById("count"); button.onclick = () => button.textContent = Number(button.textContent) + 1</script></body></html>'
const OUTPUT = JSON.stringify({ title: TITLE, html: HTML })
const websitesPath = (workspace = PERSONAL) => `/v1/workspaces/${workspace}/websites`
const artifactsPath = (workspace = PERSONAL) => `/v1/workspaces/${workspace}/artifacts`

function boot(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ot-website-jobs-'))
  const state = { runtime: null, teamMember: true }
  const host = {
    dataDir: dir, featureDir: () => dir,
    currentRuntime: () => state.runtime,
    async call(name, payload) {
      if (name === 'agents/personal-binding') return { workspace_id: PERSONAL }
      if (name === 'teams/activeWorkspaces') return state.teamMember ? [{ id: TEAM }] : []
      if (name === 'artifacts/generatedWebsite') return artifacts.endpoints.generatedWebsite(payload, { internal: true })
      if (name === 'websites/wake') return websites.endpoints.wake(payload, { internal: true })
      assert.fail(`Unexpected endpoint: ${name}`)
    },
  }
  const artifacts = artifactsFeature(host)
  let websites = websitesFeature(host)
  t.after(() => {
    websites.store.close()
    artifacts.store.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return {
    state, artifacts,
    request: (method, path, body, idempotency_key) => websites.endpoints.v1({ method, path, body, idempotency_key }),
    get store() { return websites.store },
    restart() {
      websites.store.close()
      websites = websitesFeature(host)
    },
  }
}

async function waitFor(check) {
  for (let i = 0; i < 150; i++) {
    const result = await check()
    if (result) return result
    await delay(20)
  }
  assert.fail('Website job did not reach the expected state')
}

test('accepts one job per idempotency key, returns immediately and privately saves the website', async t => {
  const { request, state, artifacts } = boot(t)
  const path = websitesPath()
  const gate = Promise.withResolvers()
  t.after(() => gate.resolve(OUTPUT))

  assert.deepEqual((await request('GET', path)).body, { configured: false, job: null })
  assert.equal((await request('POST', path, { prompt: PROMPT }, KEY)).body.error.code, 'website_unconfigured')
  const prompts = []
  state.runtime = { backgroundTextOnly(prompt) { prompts.push(prompt); return gate.promise } }
  assert.equal((await request('GET', websitesPath(OTHER))).status, 404)
  for (const body of [{}, { prompt: '' }, { prompt: 'x'.repeat(1601) }, { prompt: '\0x' }, { prompt: PROMPT, html: HTML }]) {
    assert.equal((await request('POST', path, body, KEY)).status, 400)
  }
  assert.equal((await request('POST', path, { prompt: PROMPT })).status, 400)
  const [accepted, replay] = await Promise.all([
    request('POST', path, { prompt: '  ' + PROMPT + '\n' }, KEY),
    request('POST', path, { prompt: PROMPT }, KEY),
  ])
  const { id } = accepted.body.job
  assert.equal(accepted.status, 202)
  assert.deepEqual(accepted.body.job, { id, prompt: PROMPT, state: 'queued', artifact_id: null })
  assert.deepEqual(replay, accepted)
  assert.equal((await request('POST', path, { prompt: 'something else' }, KEY)).status, 409)
  assert.equal((await request('GET', `${websitesPath(TEAM)}/${id}`)).status, 404)

  const jobPath = `${path}/${id}`
  await waitFor(() => prompts.length > 0)
  assert.equal((await request('GET', jobPath)).body.job.state, 'running')
  assert.equal(prompts.length, 1)
  assert.ok(prompts[0].endsWith('Description: ' + JSON.stringify(PROMPT)))
  gate.resolve(OUTPUT)

  const job = await waitFor(async () => {
    const { body } = await request('GET', jobPath)
    return ['succeeded', 'failed'].includes(body.job.state) && body.job
  })
  assert.equal(job.state, 'succeeded', job.message)
  assert.deepEqual((await request('GET', path)).body, { configured: true, job })
  assert.deepEqual((await request('POST', path, { prompt: PROMPT }, KEY)).body, { job })
  assert.equal(prompts.length, 1)
  const artifactPath = `${artifactsPath()}/${job.artifact_id}`
  const stored = await artifacts.endpoints.v1({ method: 'GET', path: artifactPath })
  assert.equal(stored.body.artifact.kind, 'website')
  assert.equal(stored.body.artifact.body, HTML)
  const shares = await artifacts.endpoints.v1({ method: 'GET', path: `${artifactPath}/shares` })
  assert.deepEqual(shares.body, { items: [] })
})

test('reconciles saved interrupted jobs and only runs queued jobs after startup', async t => {
  const harness = boot(t)
  const { request, artifacts, state } = harness
  const savedId = 'd'.repeat(32)
  const interruptedId = 'e'.repeat(32)
  const queuedId = 'f'.repeat(32)
  const revokedId = '1'.repeat(32)
  const queuedPrompt = '另一个网站'
  const saved = await artifacts.endpoints.generatedWebsite({ workspace_id: PERSONAL, job_id: savedId, title: TITLE, body: HTML }, { internal: true })
  for (const [id, workspace, status, prompt] of [
    [savedId, PERSONAL, 'running', PROMPT],
    [interruptedId, PERSONAL, 'running', PROMPT],
    [queuedId, PERSONAL, 'queued', queuedPrompt],
    [revokedId, TEAM, 'queued', PROMPT],
  ]) {
    harness.store.run('INSERT INTO website_jobs (id,workspace_id,key,prompt,state,created) VALUES (?,?,?,?,?,1)',
      id, workspace, id, prompt, status)
  }
  state.teamMember = false
  harness.restart()

  const getJob = async id => (await request('GET', `${websitesPath()}/${id}`)).body.job
  const recovered = await waitFor(async () => {
    const job = await getJob(savedId)
    return job.state === 'succeeded' && job
  })
  assert.equal(recovered.artifact_id, saved.id)
  assert.match((await getJob(interruptedId)).message, /生成中断/)
  assert.equal((await getJob(queuedId)).state, 'queued')

  const inputs = []
  state.runtime = { async backgroundTextOnly(prompt) { inputs.push(prompt); return OUTPUT } }
  const resumed = await waitFor(async () => {
    const job = await getJob(queuedId)
    return ['succeeded', 'failed'].includes(job.state) && job
  })
  assert.equal(resumed.state, 'succeeded', resumed.message)
  assert.notEqual(resumed.artifact_id, saved.id)
  await waitFor(() => harness.store.get('SELECT state FROM website_jobs WHERE id=?', revokedId).state === 'failed')
  assert.equal((await request('GET', `${websitesPath(TEAM)}/${revokedId}`)).status, 404)
  assert.equal(inputs.length, 1)
  assert.ok(inputs[0].endsWith('Description: ' + JSON.stringify(queuedPrompt)))
})

test('checks workspace membership again before saving, after the model has run', async t => {
  const harness = boot(t)
  const { request, artifacts, state } = harness
  const gate = Promise.withResolvers()
  t.after(() => gate.resolve(OUTPUT))
  let called = false
  state.runtime = { backgroundTextOnly() { called = true; return gate.promise } }
  const response = await request('POST', websitesPath(TEAM), { prompt: PROMPT }, KEY)
  assert.equal(response.status, 202)

  await waitFor(() => called)
  state.teamMember = false
  gate.resolve(OUTPUT)
  const { id } = response.body.job
  await waitFor(() => harness.store.get('SELECT error FROM website_jobs WHERE id=?', id).error === 'access')
  assert.equal((await request('GET', `${websitesPath(TEAM)}/${id}`)).status, 404)
  assert.deepEqual((await artifacts.endpoints.v1({ method: 'GET', path: artifactsPath(TEAM) })).body.items, [])
})

test('accepts a bounded HTML document and rejects malformed model responses', async () => {
  const generate = response => generateWebsite({ backgroundTextOnly: async () => response }, PROMPT)
  assert.deepEqual(await generate('```json\n' + OUTPUT + '\n```'), { title: TITLE, body: HTML })
  for (const response of [
    '', 'an explanation', '{}', OUTPUT.repeat(100),
    JSON.stringify({ title: TITLE, html: 'a plain text response' }),
    JSON.stringify({ title: 't'.repeat(TITLE_MAX + 1), html: HTML }),
    JSON.stringify({ title: TITLE, html: `<html>${'x'.repeat(BODY_MAX)}</html>` }),
    JSON.stringify({ title: TITLE, html: '<html>\0</html>' }),
  ]) await assert.rejects(generate(response))
})
