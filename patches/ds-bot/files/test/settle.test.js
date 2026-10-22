import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

// The user's own chat: every `send` reaches the host separately, the way the composer
// posts one card per line. Prompts are recorded in the order they open a turn.
function start() {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-settle-'))
  const ctx = fakeContext()
  const prompts = []
  const sent = []
  const workspaces = new Map()
  let sessions = 0
  Object.assign(ctx, {
    llm: {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => [{ id: 'deepseek-v4-flash' }],
      resolveModelInfo: async () => ({}),
    },
    workspaceRegistry: {
      get: id => workspaces.get(id),
      resolveByPath: async () => undefined,
      create: async (path) => {
        const workspace = { id: `w${workspaces.size + 1}`, path }
        workspaces.set(workspace.id, workspace)
        return workspace
      },
      archiveSession: async () => {},
    },
    sessionController: {
      create: async () => ({ sessionId: `s${++sessions}` }),
      resolveAgent: async sessionId => ({ agent: { session: { id: sessionId }, followup: message => sent.push({ sessionId, message }) } }),
      selectModel: async () => {},
      prompt: async (request) => {
        prompts.push({ sessionId: request.sessionId, text: request.content.map(part => part.text).join('') })
        return { accepted: true }
      },
      page: async () => ({ events: [] }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => {
    route = options
    return register(options)
  }
  const rt = createRuntime(ctx, { home })
  const call = async (endpoint, payload) => {
    const response = await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))
    return response.json()
  }
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { call, prompts, sent, rt, ctx, stop }
}

// A tick hands the timer's callback its turn; the promises it starts settle on the
// microtask queue, which setImmediate drains without touching the mocked clock.
const drain = () => new Promise(resolve => setImmediate(resolve))

test('#642: three lines inside the window open one turn, in arrival order', async (t) => {
  const { call, prompts, rt, stop } = start()
  t.after(stop)
  t.mock.timers.enable({ apis: ['setTimeout'] })
  await rt.load()
  const chief = (await call('state', {})).value.mainBotId

  await call('send', { sessionId: chief, text: 'change that one' })
  t.mock.timers.tick(300)
  await call('send', { sessionId: chief, text: 'and that one too' })
  t.mock.timers.tick(300)
  await call('send', { sessionId: chief, text: 'and read the log while you are there' })
  assert.deepEqual(prompts, [], 'no turn opens while the burst is still inside the window')

  t.mock.timers.tick(1_500)
  await drain()
  assert.equal(prompts.length, 1, 'the burst opens one turn, not three')
  assert.equal(prompts[0].text, 'change that one\nand that one too\nand read the log while you are there')
})

test('#642: a line after the window opens its own turn', async (t) => {
  const { call, prompts, rt, stop } = start()
  t.after(stop)
  t.mock.timers.enable({ apis: ['setTimeout'] })
  await rt.load()
  const chief = (await call('state', {})).value.mainBotId

  await call('send', { sessionId: chief, text: 'first' })
  t.mock.timers.tick(1_500)
  await drain()
  assert.deepEqual(prompts.map(entry => entry.text), ['first'])

  t.mock.timers.tick(500)
  await call('send', { sessionId: chief, text: 'first + 2 s' })
  t.mock.timers.tick(1_500)
  await drain()
  assert.deepEqual(prompts.map(entry => entry.text), ['first', 'first + 2 s'])
})

test('#642: one line alone keeps its own turn, after the window', async (t) => {
  const { call, prompts, rt, stop } = start()
  t.after(stop)
  t.mock.timers.enable({ apis: ['setTimeout'] })
  await rt.load()
  const chief = (await call('state', {})).value.mainBotId

  await call('send', { sessionId: chief, text: 'only one line' })
  assert.deepEqual(prompts, [])
  t.mock.timers.tick(1_500)
  await drain()
  assert.deepEqual(prompts.map(entry => entry.text), ['only one line'])
})

test('#642: a Bot-to-Bot line in the middle of a burst is not held by the timer', async (t) => {
  const { call, prompts, sent, rt, stop } = start()
  t.after(stop)
  t.mock.timers.enable({ apis: ['setTimeout'] })
  await rt.load()
  const chief = (await call('state', {})).value.mainBotId
  const writer = (await call('create-bot', { name: 'Writer' })).value

  await call('send', { sessionId: chief, text: 'the user is typing' })
  await rt.deliver({ fromId: writer.id, toId: chief, text: 'a Bot line', role: 'request' })
  assert.equal(sent.length, 1, 'the Bot line reaches its Session at once, behind no user timer')
  assert.deepEqual(prompts, [])

  t.mock.timers.tick(1_500)
  await drain()
  assert.deepEqual(prompts.map(entry => entry.text), ['the user is typing'])
})

test('#642: a line arriving while a turn runs is not held, and the held lines stay ahead of it', async (t) => {
  const { call, prompts, rt, stop } = start()
  t.after(stop)
  t.mock.timers.enable({ apis: ['setTimeout'] })
  await rt.load()
  const chief = (await call('state', {})).value.mainBotId

  await call('send', { sessionId: chief, text: 'held one' })
  // The turn starts inside the window (a schedule, or another Bot's line).
  rt.liveOf(chief).turn = 'turn-1'
  await call('send', { sessionId: chief, text: 'busy one' })
  await drain()
  assert.deepEqual(prompts.map(entry => entry.text), ['held one', 'busy one'], 'arrival order, each as its own item')

  t.mock.timers.tick(1_500)
  await drain()
  assert.equal(prompts.length, 2, 'nothing is left over for the closed window')
})

test('#682: a failed flush keeps the held line and retries on the next window', async (t) => {
  const { call, prompts, ctx, rt, stop } = start()
  t.after(stop)
  t.mock.timers.enable({ apis: ['setTimeout'] })
  await rt.load()
  const chief = (await call('state', {})).value.mainBotId
  const orig = ctx.sessionController.prompt
  let fail = true
  ctx.sessionController.prompt = async (request) => {
    if (fail) throw Object.assign(new Error('ds-bot: the Session is gone'), { code: 'bot/refused' })
    return orig(request)
  }

  assert.equal((await call('send', { sessionId: chief, text: 'keep me' })).ok, true)
  t.mock.timers.tick(1_500)
  await drain()
  assert.deepEqual(prompts, [], 'the failed prompt delivered nothing')

  fail = false
  t.mock.timers.tick(1_500)
  await drain()
  assert.deepEqual(prompts.map(entry => entry.text), ['keep me'], 'the held line went out on the retry, in order')
})

test('#682: a failed flush on the send path answers the sender the error, not ok', async (t) => {
  const { call, prompts, ctx, rt, stop } = start()
  t.after(stop)
  t.mock.timers.enable({ apis: ['setTimeout'] })
  await rt.load()
  const chief = (await call('state', {})).value.mainBotId
  const orig = ctx.sessionController.prompt
  let fail = true
  ctx.sessionController.prompt = async (request) => {
    if (fail) throw Object.assign(new Error('ds-bot: the Session is gone'), { code: 'bot/refused' })
    return orig(request)
  }

  await call('send', { sessionId: chief, text: 'held one' })
  // The turn starts inside the window, so the next line must not be held behind the timer.
  rt.liveOf(chief).turn = 'turn-1'
  const refused = await call('send', { sessionId: chief, text: 'busy one' })
  assert.equal(refused.ok, false, 'a line the host could not deliver is not reported as sent')
  assert.equal(refused.error.code, 'bot/refused')
  assert.deepEqual(prompts, [])

  fail = false
  const retried = await call('send', { sessionId: chief, text: 'busy again' })
  assert.equal(retried.ok, true)
  assert.deepEqual(prompts.map(entry => entry.text), ['held one', 'busy again'], 'the kept line still goes first')
})
