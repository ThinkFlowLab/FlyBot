import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/model-menu.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'node', write: false,
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const module = { exports: {} }
runInNewContext(bundle.outputFiles[0].text, {
  module, exports: module.exports,
  require: name => {
    const platform = {
      react: {
        createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
        useState: initial => [initial, () => {}],
        useEffect: () => {},
      },
      'react-dom': {},
      '@deepseek-ai/dsh-client-ui-primitives': {},
    }
    if (!(name in platform)) throw new Error(`no platform module ${name}`)
    return platform[name]
  },
})
const { groupModels, ModelChoiceDock, effortRows, TurnErrorCell, missingModelKey, KeyHelpLink, KEY_HELP_URL } = module.exports

function nodes(tree, match) {
  if (!tree || typeof tree !== 'object') return []
  return [...(match(tree) ? [tree] : []), ...(tree.children ?? []).flatMap(child => nodes(child, match))]
}

function dock(models, { model, ready = true } = {}) {
  const picked = []
  const bot = { id: 'chief', name: 'Chief', model }
  const roster = { ready, byId: { chief: bot }, models, defaultModel: models[0]?.ref }
  const tree = ModelChoiceDock({
    sessionId: bot.id, useRoster: select => select(roster),
    actions: { updateBot: (id, patch) => { picked.push([id, patch.model]); return Promise.resolve() } },
  })
  return { tree, picked }
}

const models = [
  { ref: 'official/flash', provider: 'official', providerName: 'DeepSeek', name: 'DeepSeek Flash' },
  { ref: 'local/flash', provider: 'local', providerName: 'Ollama', name: 'DeepSeek Flash' },
  { ref: 'official/pro', provider: 'official', providerName: 'DeepSeek', name: 'DeepSeek Pro' },
]

test('the first model choice shows provider groups and keeps each model route', () => {
  const { tree, picked } = dock(models)
  const groups = nodes(tree, node => node.props.className === 'bt-model-choice-group')
  assert.deepEqual(groups.map(group => group.props['aria-label']), ['DeepSeek', 'Ollama'])
  assert.deepEqual(groups.map(group => nodes(group, node => node.props.className === 'bt-model-choice-provider')[0].children[0]), ['DeepSeek', 'Ollama'])
  const buttons = groups.map(group => nodes(group, node => node.type === 'button'))
  assert.deepEqual(buttons.map(list => list.map(button => button.children[0])), [['DeepSeek Flash', 'DeepSeek Pro'], ['DeepSeek Flash']])
  assert.match(buttons[0][0].props.title, /official\/flash.*Harness default/)
  buttons[1][0].props.onClick()
  buttons[0][0].props.onClick()
  assert.deepEqual(picked, [['chief', 'local/flash'], ['chief', 'official/flash']])
  assert.equal(nodes(tree, node => node.type === 'button' && node.children.includes('Manage models')).length, 1)
})

test('providers with the same display name stay distinct, and unnamed providers use their id', () => {
  const entries = [
    { ...models[0], providerName: 'Cloud' },
    { ...models[1], providerName: 'Cloud' },
    { ref: 'custom/flash', provider: 'custom', name: 'Flash' },
  ]
  const groups = groupModels(entries)
  assert.deepEqual(Array.from(groups, ([label, list]) => [label, Array.from(list, model => model.ref)]), [
    ['Cloud (official)', ['official/flash']],
    ['Cloud (local)', ['local/flash']],
    ['custom', ['custom/flash']],
  ])
})

test('an unavailable model offers the same provider groups', () => {
  const { tree } = dock(models, { model: 'gone/flash' })
  assert.deepEqual(nodes(tree, node => node.props.className === 'bt-model-choice-group').map(group => group.props['aria-label']), ['DeepSeek', 'Ollama'])
  assert.ok(nodes(tree, node => node.props.className === 'bt-bubble')[0].children[0].includes('not available anymore'))
})

test('an empty catalog offers setup choices, and a ready model needs no choice dock', () => {
  const { tree } = dock([])
  assert.deepEqual(nodes(tree, node => node.type === 'button').map(button => button.children[0]), [
    'Enter a DeepSeek API key', 'Open settings to set up a custom model',
  ])
  // The shell's key dialog keeps only a typed or pasted key, so the guide is linked too (#451).
  assert.equal(nodes(tree, node => node.type === KeyHelpLink).length, 1)
  assert.equal(dock(models, { model: models[0].ref }).tree, null)
  assert.equal(dock(models, { ready: false }).tree, null)
})

test('the Thinking section always offers Default, so a picked level can be cleared', () => {
  const efforts = [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }]
  assert.deepEqual([...effortRows({ efforts, defaultEffort: 'high' }).map(row => row.effort)], [undefined, 'low', 'high'])
  assert.deepEqual([...effortRows({ efforts }).map(row => row.effort)], [undefined, 'low', 'high'])
  assert.equal(effortRows({ efforts: [] }).length, 0)
})

test("a friend's Bot never gets the lost-model picker; an ended share says why instead", () => {
  const remoteDock = (remote) => {
    const bot = { id: 'r', name: '助手', model: 'flybot-remote/bot.friend.home', remote }
    const roster = { ready: true, byId: { r: bot }, models, defaultModel: models[0].ref }
    return ModelChoiceDock({ sessionId: 'r', useRoster: select => select(roster), actions: { updateBot: () => { throw new Error('no pick') } } })
  }
  assert.equal(remoteDock({ handle: 'bot.friend.home' }), null)
  const gone = remoteDock({ handle: 'bot.friend.home', gone: true })
  assert.ok(gone)
  const flat = JSON.stringify(gone, (key, value) => typeof value === 'function' ? value.name : value)
  assert.doesNotMatch(flat, /bt-model-chip|Pick another model/)
  assert.match(flat, /RemoteGoneDock/)
})

test('a run that failed for a missing API key offers the model setup right under it (#405)', () => {
  const raw = 'llm-deepseek: no API key for provider route "deepseek-official"; store DEEPSEEK_API_KEY through the credentials service (the web Models page writes it), or export DEEPSEEK_API_KEY in the launching environment'
  assert.equal(missingModelKey(raw).route, 'deepseek-official')
  assert.equal(missingModelKey('The model service failed'), undefined)
  const chatT = key => ({ 'message.turnError': '本轮运行失败', 'message.failure.quota': 'quota gone' })[key] ?? key
  const tree = TurnErrorCell({ node: { data: { message: raw } }, t: chatT, actions: { canSignIn: () => false } })
  const text = node => nodes(node, () => true).flatMap(item => item.children.filter(child => typeof child === 'string')).join(' ')
  assert.match(text(tree), /本轮运行失败/)
  assert.doesNotMatch(text(tree), /DEEPSEEK_API_KEY|launching environment/)
  const labels = nodes(tree, node => node.type === 'button').map(button => button.children[0])
  assert.deepEqual([...labels], ['Enter a DeepSeek API key', 'Open settings to set up a custom model'])
  assert.equal(nodes(tree, node => node.type === KeyHelpLink).length, 1)
  // The raw provider text is never drawn, not even on hover (a provider may echo a key).
  assert.equal(nodes(tree, node => node.props.className === 'bt-turn-error-message')[0].props.title, undefined)
  const echoed = TurnErrorCell({ node: { data: { message: 'No API key found for sk-abc123', code: 'AUTH' } }, t: chatT, actions: {} })
  assert.ok(!JSON.stringify(echoed).includes('sk-abc123'))
  // Another route opens the model settings; any other failure reads as DSH writes it, no buttons.
  const other = TurnErrorCell({ node: { data: { message: 'no API key for provider route "openrouter"' } }, t: chatT, actions: {} })
  assert.deepEqual([...nodes(other, node => node.type === 'button').map(button => button.children[0])], ['Manage models'])
  assert.equal(nodes(other, node => node.type === KeyHelpLink).length, 0)
  // A provider that does not name its route is not assumed to be DeepSeek.
  const unnamed = TurnErrorCell({ node: { data: { message: 'API key not configured' } }, t: chatT, actions: {} })
  assert.deepEqual([...nodes(unnamed, node => node.type === 'button').map(button => button.children[0])], ['Manage models'])
  const quota = TurnErrorCell({ node: { data: { message: 'raw quota text', code: 'QUOTA' } }, t: chatT, actions: {} })
  assert.match(text(quota), /quota gone/)
  assert.match(text(quota), /QUOTA/)
  assert.equal(nodes(quota, node => node.type === 'button').length, 0)
  const plain = TurnErrorCell({ node: { data: { message: 'socket hang up' } }, t: chatT, actions: {} })
  assert.match(text(plain), /socket hang up/)
})

test('the DeepSeek key guide opens FlyBot\'s doc in a new tab (#451)', () => {
  const link = KeyHelpLink()
  assert.equal(link.type, 'a')
  assert.equal(link.props.href, KEY_HELP_URL)
  assert.match(KEY_HELP_URL, /^https:\/\/github\.com\/ThinkFlowLab\/FlyBot\/blob\/main\/docs\/deepseek-api-key\.md$/)
  assert.equal(link.props.target, '_blank')
  assert.equal(link.props.rel, 'noopener noreferrer')
  assert.deepEqual([...link.children], ['How to set a DeepSeek API key'])
})
