import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { botRowTitle, modelOf } from '../src/client/text.js'

test('#366: a Bot row\'s hover title names the model it runs on', () => {
  assert.equal(botRowTitle('Coder', 'DeepSeek V4 Pro', true), 'Coder · DeepSeek V4 Pro')
  assert.equal(botRowTitle('Coder', 'DeepSeek V4 Pro', false), 'Coder · DeepSeek V4 Pro')
  // No model yet: a wide row shows its name already, a narrow (avatar-only) row still names the Bot.
  assert.equal(botRowTitle('Coder', undefined, true), undefined)
  assert.equal(botRowTitle('Coder', '', false), 'Coder')
})

test('#366: the model a row names is the served name of the chosen model, else the one it last ran on', () => {
  const roster = { models: [{ ref: 'deepseek/deepseek-v4-pro', name: 'DeepSeek V4 Pro', providerName: 'DeepSeek' }] }
  assert.equal(modelOf({ model: 'deepseek/deepseek-v4-pro' }, roster).name, 'DeepSeek V4 Pro')
  assert.equal(modelOf({ appliedModel: 'deepseek/deepseek-v4-pro' }, roster).name, 'DeepSeek V4 Pro')
  // A model no provider serves anymore is still named, by its id.
  assert.deepEqual(modelOf({ model: 'kimi/kimi-k2' }, roster), { ref: 'kimi/kimi-k2', name: 'kimi-k2', provider: 'kimi', served: false })
  assert.equal(modelOf({}, roster), undefined)
})

test('#366: every own Bot row (the tree draws the same row) takes that title; a friend\'s Bot keeps its own', () => {
  const sidebar = readFileSync(new URL('../src/client/sidebar.js', import.meta.url), 'utf8')
  const row = sidebar.slice(sidebar.indexOf('function BotRow('), sidebar.indexOf('function RemoteMark('))
  assert.match(row, /className: 'bt-row', [^\n]*\n[^\n]*\n\s*'data-bot-id': id, title: remote \? shown : botRowTitle\(shown, modelOf\(bot, roster\)\?\.name, wide\), onClick/)
  assert.match(sidebar, /function TreeNode\([\s\S]*?h\(BotRow, \{ \.\.\.rowProps, bot, asRow: true/)
})
