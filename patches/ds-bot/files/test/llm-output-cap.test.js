import assert from 'node:assert/strict'
import { test } from 'node:test'
import { install } from '../src/host/models.js'
import { fakeContext } from './fake-ctx.js'

// #3132: DashScope refuses `max_completion_tokens` above 12288 with a 400, and a model
// row may declare more than the endpoint takes. The request is clamped at the seam every
// model call crosses; nothing in this file asserts on the model or frontend packages.

const CEILING = 12_288
const MODEL = 'opencsitool/DeepSeek-V4.1-Flash-1017'
// #3198: the ceiling is DashScope's, reached through the `opencsitool` route that #3132
// recorded; another provider's endpoint accepts more, so the cap is not its business.
const OTHER_PROVIDER = 'deepseek-official'
const OTHER_MODEL = `${OTHER_PROVIDER}/DeepSeek-V4.1-Flash-1017`

const user = text => ({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })
const request = (overrides = {}) => ({
  provider: 'opencsitool',
  model: 'DeepSeek-V4.1-Flash-1017',
  messages: [user('Review this pull request')],
  sessionId: 's-review',
  ...overrides,
})

// DSH runs `llm/stream` as a waterfall: a listener calls `next()` for the rest of the
// chain, and a listener that restarts a request calls `ctx.llm.stream(copy)`, which runs
// the chain again from the top. `next` takes no arguments, so this stand-in advances on
// `next()` only — a copy reaches the provider through `stream`, exactly as in the host.
function bench({ info = {}, resolveError } = {}) {
  const ctx = fakeContext()
  const requests = []
  ctx.llm = {
    listProviders: () => [],
    resolveModelInfo: async (provider, model) => {
      if (resolveError !== undefined) throw resolveError
      return info[`${provider}/${model}`]
    },
    stream: options => run(options),
  }
  const run = (options, index = 0) => {
    const chain = ctx.listeners.get('llm/stream') ?? []
    if (index < chain.length) return chain[index](options, () => run(options, index + 1))
    requests.push(options)
    return (async function* answered() { yield { type: 'finish', reason: { kind: 'stop' } } })()
  }
  install({ ctx, state: {} })
  const ask = async asked => {
    for await (const chunk of ctx.llm.stream(asked)) void chunk
    return { sent: requests.at(-1), count: requests.length }
  }
  return { ctx, requests, ask }
}

test('a model row declaring more than the endpoint takes is asked for 12288, and the call is not rewritten in place', async () => {
  const { ask } = bench({ info: { [MODEL]: { defaultMaxTokens: 16_384 } } })
  const asked = request()
  const { sent, count } = await ask(asked)
  assert.equal(sent.maxTokens, CEILING)
  assert.equal(count, 1, 'one provider request, not two')
  assert.equal(asked.maxTokens, undefined, 'the caller\'s object is untouched')
})

test('a model row declaring more than the ceiling is left alone on a route whose endpoint accepts it', async () => {
  const { ask } = bench({ info: { [OTHER_MODEL]: { defaultMaxTokens: 16_384 } } })
  const { sent, count } = await ask(request({ provider: OTHER_PROVIDER }))
  assert.equal('maxTokens' in sent, false, 'the declared default is filled by DSH, not written here')
  assert.equal(count, 1, 'one provider request, not two')
})

test('a model row under the ceiling keeps what it declares, and nothing is invented', async () => {
  const { ask } = bench({ info: { [MODEL]: { defaultMaxTokens: 4_096 } } })
  const { sent } = await ask(request())
  assert.equal('maxTokens' in sent, false, 'the declared default is filled by DSH, not written here')
})

test('a caller that asks for more than the ceiling is clamped to it, and its own object keeps its value', async () => {
  const { ask } = bench({ info: { [MODEL]: { defaultMaxTokens: 16_384 } } })
  const asked = request({ maxTokens: 20_000 })
  const { sent, count } = await ask(asked)
  assert.equal(sent.maxTokens, CEILING)
  assert.equal(count, 1)
  assert.equal(asked.maxTokens, 20_000)
})

test('a caller asking for more than the ceiling keeps its value on a route whose endpoint accepts it', async () => {
  const { ask } = bench({ info: { [OTHER_MODEL]: { defaultMaxTokens: 16_384 } } })
  const asked = request({ provider: OTHER_PROVIDER, maxTokens: 20_000 })
  const { sent, count } = await ask(asked)
  assert.equal(sent.maxTokens, 20_000, 'the caller\'s request reaches the provider unchanged')
  assert.equal(count, 1, 'one provider request, not two')
  assert.equal(asked.maxTokens, 20_000)
})

test('a route that cannot be named keeps the clamp', async () => {
  const { ask } = bench({ info: { [MODEL]: { defaultMaxTokens: 16_384 } } })
  const { sent } = await ask(request({ provider: undefined, maxTokens: 20_000 }))
  assert.equal(sent.maxTokens, CEILING, 'an unplaceable route keeps the proven-safe cap')
})

test('a caller at or under the ceiling is passed through unchanged', async () => {
  const { ask } = bench({ info: { [MODEL]: { defaultMaxTokens: 16_384 } } })
  for (const maxTokens of [CEILING, 4_096, 1]) {
    const { sent } = await ask(request({ maxTokens }))
    assert.equal(sent.maxTokens, maxTokens)
  }
})

test('nothing declared and nothing asked: no cap appears on the request', async () => {
  const { ask } = bench({ info: { [MODEL]: {} } })
  const { sent, count } = await ask(request())
  assert.equal('maxTokens' in sent, false)
  assert.equal(count, 1)
})

test('a model lookup that fails leaves the request alone instead of breaking the call', async () => {
  const { ask } = bench({ resolveError: new Error('no adapter') })
  const { sent, count } = await ask(request())
  assert.equal('maxTokens' in sent, false)
  assert.equal(count, 1)
})
