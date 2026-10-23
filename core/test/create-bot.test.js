import { test } from 'node:test'
import assert from 'node:assert/strict'
import { afterCreate, createPayload, freshBotName, startModel } from '../src/client/bot-draft.js'

const models = [
  { ref: 'ollama/ds-flash', name: 'DS Flash', providerName: 'Ollama' },
  { ref: 'cloud/qwen-max', name: 'Qwen Max', providerName: 'Cloud' },
]

test('the form starts on the Main Bot\'s model, then the DSH default, then the first served one (#230)', () => {
  const chief = { id: 'chief', name: 'Chief', model: 'cloud/qwen-max' }
  const roster = (bot, defaultModel = 'ollama/ds-flash') => ({ models, defaultModel, mainBotId: bot.id, bots: [bot], byId: { [bot.id]: bot } })
  assert.equal(startModel(roster(chief)), 'cloud/qwen-max')
  // No chosen model yet: the one it last ran on.
  assert.equal(startModel(roster({ id: 'chief', name: 'Chief', appliedModel: 'cloud/qwen-max' })), 'cloud/qwen-max')
  // Its model is gone (or its provider lost the credential, so it is not served): the DSH default.
  assert.equal(startModel(roster({ id: 'chief', name: 'Chief', model: 'gone/model' })), 'ollama/ds-flash')
  assert.equal(startModel(roster({ id: 'chief', name: 'Chief', model: 'gone/model' }, 'cloud/qwen-max')), 'cloud/qwen-max')
  // Neither served: the first served model.
  assert.equal(startModel(roster({ id: 'chief', name: 'Chief', model: 'gone/model' }, 'gone/default')), 'ollama/ds-flash')
  // A roster without byId (tests, early snapshots) still finds the Main Bot in bots.
  assert.equal(startModel({ models, defaultModel: 'ollama/ds-flash', mainBotId: 'chief', bots: [chief] }), 'cloud/qwen-max')
})

test('without a Main Bot the form starts on the DSH default model, else the first served one', () => {
  assert.equal(startModel({ models, defaultModel: 'cloud/qwen-max' }), 'cloud/qwen-max')
  assert.equal(startModel({ models, defaultModel: 'gone/model' }), 'ollama/ds-flash')
  assert.equal(startModel({ models, defaultModel: null }), 'ollama/ds-flash')
  assert.equal(startModel({ models: [], defaultModel: 'cloud/qwen-max' }), '')
})

test('the payload carries the look and the chosen model, and never a brief (#645)', () => {
  const look = { shape: 'star', color: 'blue' }
  assert.deepEqual(createPayload({ name: 'A', look, model: 'cloud/qwen-max' }), { name: 'A', color: 'blue', avatar: { shape: 'star' }, model: 'cloud/qwen-max' })
  // A line typed in the composer is the new Bot's first request, sent as a turn, so the card
  // sends no `brief` the host would fold into the Bot's instructions.
  const payload = createPayload({ name: 'A', look, model: '', brief: '帮我写周报', image: 'data:image/png;base64,AA' })
  assert.deepEqual(payload, { name: 'A', color: 'blue', avatar: { shape: 'star', image: 'data:image/png;base64,AA' } })
  assert.equal(payload.brief, undefined)
})

test('the suggested name skips taken names', () => {
  const roster = { bots: [{ name: 'New Bot' }, { name: 'Kimi' }] }
  assert.equal(freshBotName(roster), 'New Bot 2')
  assert.equal(freshBotName(roster, 'Kimi'), 'Kimi 2')
  assert.equal(freshBotName(roster, 'Writer'), 'Writer')
})

// #698: the Bot exists once the card reports it, so a first send that fails must leave the
// user on the new Bot's chat with the failure, not on a card whose Create can only answer
// "a Bot with that name already exists".
test('a failed first send still opens the new Bot and shows the failure', async () => {
  const calls = []
  const actions = {
    openSession: id => calls.push(['open', id]),
    showDetails: (id, tab) => calls.push(['details', id, tab]),
    send: async (id, text) => { calls.push(['send', id, text]); throw new Error('the turn could not be opened') },
    notify: text => calls.push(['notify', text]),
  }
  await afterCreate({ id: 'writer', text: '  帮我写周报  ', actions })
  assert.deepEqual(calls, [
    ['open', 'writer'],
    ['details', 'writer', 'settings'],
    ['send', 'writer', '帮我写周报'],
    ['notify', 'the turn could not be opened'],
  ])
  assert.ok(!calls.some(([kind, text]) => kind === 'notify' && String(text).includes('already exists')), 'no duplicate-Bot complaint')
})

test('the new Bot is opened even when the composer had nothing typed, and a sent line reports nothing', async () => {
  const opened = []
  const silent = { openSession: id => opened.push(id), showDetails: () => {}, send: async () => { throw new Error('should not send') }, notify: text => opened.push(`notify:${text}`) }
  await afterCreate({ id: 'quiet', text: '', actions: silent })
  await afterCreate({ id: 'quiet', text: '   ', actions: silent })
  assert.deepEqual(opened, ['quiet', 'quiet'])
  const sent = []
  const working = { openSession: () => {}, showDetails: () => {}, send: async (id, text) => sent.push([id, text]), notify: text => sent.push(['notify', text]) }
  await afterCreate({ id: 'writer', text: 'Review the notes', actions: working })
  assert.deepEqual(sent, [['writer', 'Review the notes']])
})
