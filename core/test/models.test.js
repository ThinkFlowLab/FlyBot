import assert from 'node:assert/strict'
import { test } from 'node:test'
import { install } from '../src/host/models.js'

const PROVIDERS = {
  deepseek: [{ id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' }, { id: 'deepseek-v4-pro' }],
  ollama: [{ id: 'kimi-k3' }, { id: 'deepseek-v4-pro' }],
}

function runtime(defaultSelection) {
  const ctx = {
    llm: {
      listProviders: () => Object.keys(PROVIDERS).map(id => ({ id })),
      listModels: async id => PROVIDERS[id],
    },
    get: name => (name === 'agentDefaultModel' && defaultSelection ? { currentSelection: () => defaultSelection } : undefined),
  }
  const rt = { ctx, state: { bots: {} } }
  install(rt)
  return rt
}

test('the default model is the DSH default when served, else the first served model', async () => {
  assert.equal(await runtime({ provider: 'ollama', model: 'kimi-k3' }).defaultModel(), 'ollama/kimi-k3')
  assert.equal(await runtime({ provider: 'gone', model: 'x' }).defaultModel(), 'deepseek/deepseek-v4.1-flash')
  assert.equal(await runtime(undefined).defaultModel(), 'deepseek/deepseek-v4.1-flash')
})

test('a model is named by its ref, or by an id or name only one provider serves', async () => {
  const rt = runtime(undefined)
  assert.equal(await rt.resolveModel('ollama/kimi-k3'), 'ollama/kimi-k3')
  assert.equal(await rt.resolveModel(' Kimi-K3 '), 'ollama/kimi-k3')
  assert.equal(await rt.resolveModel('DeepSeek V4.1 Flash'), 'deepseek/deepseek-v4.1-flash')
  await assert.rejects(rt.resolveModel('deepseek-v4-pro'), /more than one provider.*deepseek\/deepseek-v4-pro, ollama\/deepseek-v4-pro/)
  await assert.rejects(rt.resolveModel('kimi'), /not available\. Available models: deepseek\/deepseek-v4\.1-flash/)
})

test('a Bot runs on its own model, else the one it last ran on, else the default', async () => {
  const rt = runtime({ provider: 'ollama', model: 'kimi-k3' })
  assert.equal(await rt.desiredModel({ model: 'deepseek/deepseek-v4-pro', appliedModel: 'ollama/kimi-k3' }), 'deepseek/deepseek-v4-pro')
  assert.equal(await rt.desiredModel({ model: 'gone/model', appliedModel: 'deepseek/deepseek-v4-pro' }), 'deepseek/deepseek-v4-pro')
  assert.equal(await rt.desiredModel({ model: 'gone/model' }), 'ollama/kimi-k3')
})

test('choosing a Bot model leaves the user\'s DSH default model as it was', async () => {
  const writes = []
  let current = { provider: 'ollama', model: 'kimi-k3' }
  const defaults = {
    currentSelection: () => ({ ...current }),
    saveSelection: async (next) => { writes.push(`${next.provider}/${next.model}`); current = { ...next } },
  }
  const ctx = {
    llm: { listProviders: () => [], listModels: async () => [] },
    get: name => (name === 'agentDefaultModel' ? defaults : undefined),
    // Like DSH: the selection is also saved as the default, in the background.
    sessionController: { selectModel: async ({ provider, model }) => { void defaults.saveSelection({ provider, model }) } },
  }
  const rt = { ctx, state: { bots: {} }, warn() {} }
  install(rt)
  await Promise.all([
    rt.selectSessionModel('s1', { provider: 'deepseek', model: 'deepseek-v4-pro' }),
    rt.selectSessionModel('s2', { provider: 'deepseek', model: 'deepseek-v4.1-flash' }),
    rt.selectSessionModel('s3', { provider: 'ollama', model: 'kimi-k3' }),
  ])
  assert.deepEqual(current, { provider: 'ollama', model: 'kimi-k3' })
  assert.deepEqual(writes, ['deepseek/deepseek-v4-pro', 'ollama/kimi-k3', 'deepseek/deepseek-v4.1-flash', 'ollama/kimi-k3', 'ollama/kimi-k3'])
})

test('a Bot with no model yet changes nothing until the user picks one', async () => {
  const rt = runtime({ provider: 'ollama', model: 'kimi-k3' })
  assert.equal(await rt.desiredModel({ appliedModel: 'deepseek/deepseek-v4-pro' }), undefined)
  assert.equal(await rt.desiredModel({}), undefined)
  await rt.catalog()
  assert.equal(rt.cachedDefault(), 'ollama/kimi-k3')
})

// A runtime with two providers, a DSH default, and a session controller that, like
// DSH, saves every Session selection as the default.
function bench({ providers = { deepseek: ['v4-flash'], stepfun: ['step-5'] }, fallback = { provider: 'stepfun', model: 'step-5' }, reasoning = {} } = {}) {
  let current = { ...fallback }
  const selected = []
  const saved = []
  const listeners = new Map()
  const ctx = {
    on(name, listener) { listeners.set(name, listener); return () => listeners.delete(name) },
    get: name => (name === 'agentDefaultModel'
      ? { currentSelection: () => ({ ...current }), saveSelection: async (next) => { saved.push(next); current = { ...next } } }
      : undefined),
    llm: {
      listProviders: () => Object.keys(providers).map(id => ({ id, name: id.toUpperCase() })),
      listModels: async id => providers[id].map(model => ({ id: model, name: model, inputModalities: ['text'] })),
      resolveModelInfo: async (provider, model) => reasoning[`${provider}/${model}`] ?? {},
    },
    sessionController: {
      selectModel: async ({ sessionId, provider, model, reasoningEffort }) => {
        selected.push(`${sessionId}:${provider}/${model}${reasoningEffort === undefined ? '' : `:${reasoningEffort}`}`)
        current = { provider, model }
      },
    },
  }
  const rt = { ctx, state: { bots: {} }, chatOf: id => id, groupSessionsOf: () => [], save: async () => {}, warn: () => {} }
  install(rt)
  return { rt, selected, saved, providers, listeners, current: () => current }
}

test('the catalog is every model DSH serves, with no lab', async () => {
  const { rt } = bench()
  assert.deepEqual((await rt.catalog()).map(entry => [entry.ref, entry.providerName, 'lab' in entry]), [
    ['deepseek/v4-flash', 'DEEPSEEK', false],
    ['stepfun/step-5', 'STEPFUN', false],
  ])
})

test('a fresh catalog sees a model list changed in DSH settings at once', async () => {
  const { rt, providers } = bench()
  await rt.catalog()
  providers.deepseek = ['deepseek-flash', 'deepseek-v4-pro']
  assert.ok((await rt.catalog()).some(entry => entry.ref === 'deepseek/v4-flash'))
  assert.deepEqual((await rt.catalog({ fresh: true })).filter(entry => entry.provider === 'deepseek').map(entry => entry.id), ['deepseek-flash', 'deepseek-v4-pro'])
})

test('applying a Bot model leaves the DSH default as the user set it', async () => {
  const { rt, selected, current } = bench()
  const bot = { id: 'b1', model: 'deepseek/v4-flash' }
  assert.equal(await rt.applyModel(bot), 'deepseek/v4-flash')
  assert.deepEqual(selected, ['b1:deepseek/v4-flash'])
  assert.deepEqual(current(), { provider: 'stepfun', model: 'step-5' })
  assert.equal(bot.appliedModel, 'deepseek/v4-flash')
})

test('a Bot model applies its thinking level, and only re-selects on a change', async () => {
  const { rt, selected } = bench({ reasoning: { 'deepseek/v4-flash': { reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'high' } } } })
  const bot = { id: 'b1', model: 'deepseek/v4-flash', effort: 'low' }
  await rt.applyModel(bot)
  assert.deepEqual(selected, ['b1:deepseek/v4-flash:low'])
  assert.equal(bot.appliedEffort, 'low')
  await rt.applyModel(bot)
  assert.equal(selected.length, 1)

  // A level the model does not serve is never sent: the model's default applies.
  bot.effort = 'max'
  await rt.applyModel(bot)
  assert.deepEqual(selected.at(-1), 'b1:deepseek/v4-flash')
  assert.equal(bot.appliedEffort, undefined)
})

test('a group Session that did not take the model keeps the Bot stale and is retried (#289)', async () => {
  const { rt, selected } = bench()
  let failing = true
  rt.groupSessionsOf = () => ['g1']
  const select = rt.ctx.sessionController.selectModel
  rt.ctx.sessionController.selectModel = async (request) => {
    if (failing && request.sessionId === 'g1') throw new Error('no adapter')
    return select(request)
  }
  const bot = { id: 'b1', model: 'deepseek/v4-flash' }
  await rt.applyModel(bot)
  assert.equal(bot.appliedModel, 'deepseek/v4-flash')
  assert.equal(bot.modelStale, true)
  // Nothing changed, yet the next apply goes back to the group Session.
  failing = false
  await rt.applyModel(bot)
  assert.equal(selected.filter(item => item.startsWith('g1:')).length, 1)
  assert.equal('modelStale' in bot, false)
  // Settled: the early return is back.
  const before = selected.length
  await rt.applyModel(bot)
  assert.equal(selected.length, before)
})

test('resolveEffort takes an id or a name, and refuses what the model has not', async () => {
  const { rt } = bench({ reasoning: {
    'deepseek/v4-flash': { reasoning: { efforts: [{ id: 'off', name: 'Off' }, { id: 'high', name: 'High' }] } },
    'stepfun/step-5': {},
  } })
  assert.equal(await rt.resolveEffort('deepseek/v4-flash', 'high'), 'high')
  assert.equal(await rt.resolveEffort('deepseek/v4-flash', ' Off '), 'off')
  assert.equal(await rt.resolveEffort('deepseek/v4-flash', ''), undefined)
  await assert.rejects(rt.resolveEffort('stepfun/step-5', 'high'), /no thinking levels/)
  await assert.rejects(rt.resolveEffort('deepseek/v4-flash', 'max'), /not available for deepseek\/v4-flash\. Available: Off, High/)
})

test('the catalog attaches thinking levels to models a Bot uses', async () => {
  const { rt } = bench({ reasoning: { 'deepseek/v4-flash': { reasoning: { efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high' } } } })
  rt.state.bots.b1 = { id: 'b1', model: 'deepseek/v4-flash' }
  const entries = await rt.catalog()
  assert.deepEqual(entries.find(entry => entry.ref === 'deepseek/v4-flash')?.reasoning, { efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high' })
  assert.equal(entries.find(entry => entry.ref === 'stepfun/step-5')?.reasoning, undefined)
})

test('a model is applied once the provider of its Bot registers', async () => {
  const { rt, providers, listeners } = bench({ providers: {} })
  const waiting = rt.waitForModel({ model: 'stepfun/step-5' }, 5000)
  setTimeout(() => {
    providers.stepfun = ['step-5']
    listeners.get('llm/adapters-updated')?.()
  }, 20)
  assert.equal(await waiting, 'stepfun/step-5')
  assert.equal(await rt.waitForModel({}, 5000), undefined)
})

test('a Bot on the default model with its own thinking level leaves the default level as it was', async () => {
  const fallback = { provider: 'deepseek', model: 'v4-flash', reasoningEffort: 'high' }
  const { rt, current } = bench({ fallback, reasoning: { 'deepseek/v4-flash': { reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'high' } } } })
  rt.ctx.sessionController.selectModel = async ({ provider, model, reasoningEffort }) => {
    const selected = { provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) }
    await rt.ctx.get('agentDefaultModel').saveSelection(selected)
    return { selected }
  }
  await rt.applyModel({ id: 'b1', model: 'deepseek/v4-flash', effort: 'low' })
  assert.deepEqual(current(), fallback)
})

// Test connection (#409): the request is mocked; no real model is called.
function testRuntime({ stream, bots, efforts } = {}) {
  const calls = []
  const tagged = []
  const ctx = {
    llm: {
      listProviders: () => Object.keys(PROVIDERS).map(id => ({ id })),
      listModels: async id => PROVIDERS[id],
      resolveModelInfo: async () => (efforts ? { reasoning: { efforts } } : {}),
      stream: (options) => {
        calls.push(options)
        return stream(options, calls.length)
      },
    },
    get: () => undefined,
  }
  const rt = {
    ctx,
    state: { bots: bots ?? { b1: { id: 'b1', name: 'Writer', model: 'ollama/kimi-k3', effort: 'high' } } },
    chatOf: id => `chat-${id}`,
    tagUsage: (messages, tag) => { tagged.push(tag); return messages },
  }
  install(rt)
  return { rt, calls, tagged }
}

const finishWith = reason => async function* () { yield { type: 'text-delta', text: 'OK' }; yield { type: 'finish', reason } }

test('a connection test sends one tiny request on the Bot\'s own route and reports success', async () => {
  const { rt, calls, tagged } = testRuntime({ stream: finishWith({ kind: 'completed' }), efforts: [{ id: 'high' }, { id: 'off' }] })
  const result = await rt.testModel('b1')
  assert.equal(result.ok, true)
  assert.equal(result.ref, 'ollama/kimi-k3')
  assert.equal(typeof result.ms, 'number')
  assert.equal(calls.length, 1)
  const [call] = calls
  assert.equal(call.provider, 'ollama')
  assert.equal(call.model, 'kimi-k3')
  assert.equal(call.sessionId, 'chat-b1')
  assert.equal(call.reasoningEffort, 'off')
  assert.ok(call.maxTokens <= 16)
  assert.ok(call.signal instanceof AbortSignal)
  assert.equal(call.messages.length, 1)
  assert.deepEqual(tagged, [{ sessionId: 'chat-b1', kind: 'other' }])
})

test('a reply cut off at the token limit still counts as a working connection', async () => {
  const { rt } = testRuntime({ stream: finishWith({ kind: 'max-tokens' }) })
  assert.equal((await rt.testModel('b1')).ok, true)
})

test('a failed test answers with a code only, never the provider text', async () => {
  const secret = 'sk-live-1234567890abcdef'
  const cases = [
    [{ code: 'AUTH', message: `Incorrect API key provided: ${secret}`, status: 401 }, 'AUTH'],
    [{ code: 'UNKNOWN', message: 'no API key for provider route "deepseek-official"' }, 'NO_KEY'],
    [{ code: 'QUOTA', message: 'Insufficient balance' }, 'QUOTA'],
    [{ code: 'RATE_LIMIT', message: `slow down ${secret}` }, 'RATE_LIMIT'],
    [{ code: 'TIMEOUT', message: 'idle timeout' }, 'TIMEOUT'],
    [{ code: 'TRANSPORT', message: 'fetch failed ECONNREFUSED' }, 'TRANSPORT'],
    [{ code: 'HTTP_404', message: 'Not Found', status: 404 }, 'MODEL_NOT_FOUND'],
    [{ code: 'INVALID_REQUEST', message: 'The model `kimi-k3` does not exist', status: 400 }, 'MODEL_NOT_FOUND'],
    [{ code: 'INVALID_REQUEST', message: 'bad request', status: 400 }, 'INVALID_REQUEST'],
    [{ code: 'SERVER', message: 'upstream 502' }, 'SERVER'],
    [{ code: 'NO_ADAPTER', message: 'no adapter registered for provider "ollama"' }, 'NOT_SERVED'],
    [{ code: 'WEIRD', message: secret }, 'UNKNOWN'],
  ]
  for (const [failure, code] of cases) {
    const { rt } = testRuntime({ stream: finishWith({ kind: 'error', failure }) })
    const result = await rt.testModel('b1')
    assert.deepEqual(result, { ok: false, ref: 'ollama/kimi-k3', code }, failure.message)
    assert.ok(!JSON.stringify(result).includes(secret))
  }
})

test('an aborted or throwing test is a timeout or a coded failure, not an exception', async () => {
  const aborted = testRuntime({ stream: finishWith({ kind: 'aborted', failure: { code: 'ABORTED', message: 'aborted' } }) })
  assert.equal((await aborted.rt.testModel('b1')).code, 'TIMEOUT')
  const thrown = testRuntime({ stream: () => { throw Object.assign(new Error('Incorrect API key sk-abc'), { code: 'AUTH' }) } })
  assert.deepEqual(await thrown.rt.testModel('b1'), { ok: false, ref: 'ollama/kimi-k3', code: 'AUTH' })
  const silent = testRuntime({ stream: async function* () { yield { type: 'text-delta', text: 'O' } } })
  assert.deepEqual(await silent.rt.testModel('b1'), { ok: false, ref: 'ollama/kimi-k3', code: 'UNKNOWN' })
})

test('a Bot runs one test at a time, and a Bot with no model sends nothing', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const { rt, calls } = testRuntime({
    stream: async function* () { await gate; yield { type: 'finish', reason: { kind: 'completed' } } },
    bots: { b1: { id: 'b1', name: 'Writer', model: 'ollama/kimi-k3' }, b2: { id: 'b2', name: 'New' }, r1: { id: 'r1', name: 'Friend', remote: { handle: 'x' } } },
  })
  const first = rt.testModel('b1')
  await assert.rejects(rt.testModel('b1'), /already running/)
  release()
  assert.equal((await first).ok, true)
  assert.equal((await rt.testModel('b1')).ok, true)
  assert.equal(calls.length, 2)
  assert.deepEqual(await rt.testModel('b2'), { ok: false, code: 'NO_MODEL' })
  await assert.rejects(rt.testModel('r1'), error => error.code === 'bot/invalid')
  await assert.rejects(rt.testModel('missing'), error => error.code === 'bot/not-found')
  assert.equal(calls.length, 2)
})
