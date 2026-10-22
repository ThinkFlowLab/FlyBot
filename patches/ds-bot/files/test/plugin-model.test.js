import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MODEL_LIMITS, createPluginModel } from '../src/host/plugin-model.js'

function fakeRt({ reply = 'An answer', finish = { kind: 'stop' }, fail, readOnly = false, model = 'deepseek/v4' } = {}) {
  const requests = []
  let defaultCalls = 0
  const rt = {
    readOnly: () => (readOnly ? 'another host holds the team' : undefined),
    defaultModel: async () => {
      defaultCalls += 1
      return model
    },
    ctx: {
      llm: {
        async* stream(request) {
          requests.push(request)
          if (fail) throw fail
          yield { type: 'text-delta', index: 0, text: reply }
          yield { type: 'finish', reason: finish }
        },
      },
    },
  }
  return { rt, requests, defaults: () => defaultCalls }
}

test('a plugin that is not allow-listed is refused, and the allow-list is the only key', async () => {
  const { rt, requests } = fakeRt()
  const ask = createPluginModel(rt, { allow: [] })
  assert.deepEqual(await ask('flybot-tree', { prompt: 'hi' }), { ok: false, code: 'not-allowed' })
  assert.equal(requests.length, 0, 'no model call is made')
})

test('a read-only host, an empty prompt and an over-long prompt are refused before any call', async () => {
  const { rt } = fakeRt({ readOnly: true })
  assert.deepEqual(await createPluginModel(rt, { allow: ['p'] })('p', { prompt: 'hi' }), { ok: false, code: 'read-only' })
  const live = fakeRt()
  const ask = createPluginModel(live.rt, { allow: ['p'] })
  assert.deepEqual(await ask('p', { prompt: '   ' }), { ok: false, code: 'empty-prompt' })
  assert.deepEqual(await ask('p', { prompt: 'x'.repeat(MODEL_LIMITS.maxPromptChars + 1) }), { ok: false, code: 'prompt-too-long' })
  assert.equal(live.requests.length, 0)
})

test('an allowed plugin gets text only, with the output clamped to the host ceiling', async () => {
  const { rt, requests } = fakeRt({ reply: 'Hangzhou' })
  const ask = createPluginModel(rt, { allow: ['flybot-tree'] })
  assert.deepEqual(await ask('flybot-tree', { prompt: 'City?', maxTokens: 99999 }), { ok: true, text: 'Hangzhou' })
  assert.equal(requests[0].maxTokens, MODEL_LIMITS.maxTokens, 'maxTokens is clamped')
  assert.equal(requests[0].provider, 'deepseek')
  assert.equal(requests[0].model, 'v4')
})

test('#579: a per-plugin default model is used by that plugin, after the model a call names', async () => {
  const { rt, requests, defaults } = fakeRt()
  const ask = createPluginModel(rt, { allow: ['cheap', 'other'], models: { cheap: 'deepseek/v4-flash' } })
  assert.deepEqual(await ask('cheap', { prompt: 'hi' }), { ok: true, text: 'An answer' })
  assert.deepEqual([requests[0].provider, requests[0].model], ['deepseek', 'v4-flash'], 'the plugin default is used')
  assert.equal(defaults(), 0, 'the team default is not asked when the plugin has one')
  await ask('cheap', { prompt: 'hi', model: 'openai/gpt-5' })
  assert.deepEqual([requests[1].provider, requests[1].model], ['openai', 'gpt-5'], 'a model the call names still wins')
  await ask('other', { prompt: 'hi' })
  assert.deepEqual([requests[2].provider, requests[2].model], ['deepseek', 'v4'], 'a plugin the host did not name keeps the team default')
  assert.equal(defaults(), 1, 'only the unnamed plugin falls back')
})

test('#579: a per-plugin entry that is not a usable name is ignored, never passed through', async () => {
  for (const models of [{ p: '' }, { p: '   ' }, { p: 42 }, { p: null }, {}]) {
    const { rt, requests } = fakeRt()
    const ask = createPluginModel(rt, { allow: ['p'], models })
    assert.deepEqual(await ask('p', { prompt: 'hi' }), { ok: true, text: 'An answer' })
    assert.deepEqual([requests[0].provider, requests[0].model], ['deepseek', 'v4'], 'an unusable entry falls back to the team default')
  }
  const { rt, requests } = fakeRt()
  const ask = createPluginModel(rt, { allow: ['p'], models: { p: 'cheap/x' } })
  await ask('p', { prompt: 'hi', model: '' })
  assert.deepEqual([requests[0].provider, requests[0].model], ['cheap', 'x'], 'an empty model in the call falls through to the plugin default')
})

test('a provider error is a short code, never the provider message', async () => {
  const { rt } = fakeRt({ fail: Object.assign(new Error('401: key sk-live-SECRET rejected'), { code: 'AUTH' }) })
  const answer = await createPluginModel(rt, { allow: ['p'] })('p', { prompt: 'hi' })
  assert.deepEqual(answer, { ok: false, code: 'AUTH' })
  assert.equal(JSON.stringify(answer).includes('SECRET'), false)
})

test('an empty reply is a failure, and a model-less team is refused', async () => {
  const blank = fakeRt({ reply: '' })
  assert.deepEqual(await createPluginModel(blank.rt, { allow: ['p'] })('p', { prompt: 'hi' }), { ok: false, code: 'empty-reply' })
  const none = fakeRt({ model: null })
  assert.deepEqual(await createPluginModel(none.rt, { allow: ['p'] })('p', { prompt: 'hi' }), { ok: false, code: 'no-model' })
})

test('calls are rate limited per plugin inside a minute', async () => {
  const { rt } = fakeRt()
  let clock = 0
  const ask = createPluginModel(rt, { allow: ['p'], now: () => clock, limits: { perMinute: 3 } })
  assert.equal((await ask('p', { prompt: 'a' })).ok, true)
  assert.equal((await ask('p', { prompt: 'b' })).ok, true)
  assert.equal((await ask('p', { prompt: 'c' })).ok, true)
  assert.deepEqual(await ask('p', { prompt: 'd' }), { ok: false, code: 'rate-limited' })
  clock = 61_000
  assert.equal((await ask('p', { prompt: 'e' })).ok, true, 'the window slides')
})

test('a stream that ends with an error finish maps to a short code', async () => {
  const { rt } = fakeRt({ reply: '', finish: { kind: 'error', failure: { code: 'RATE_LIMIT' } } })
  assert.deepEqual(await createPluginModel(rt, { allow: ['p'] })('p', { prompt: 'hi' }), { ok: false, code: 'RATE_LIMIT' })
})
