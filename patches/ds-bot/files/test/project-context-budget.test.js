import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createContextBudget, resolveContextBudget, countContextTokens, checkContextPrompt } from '../src/host/project-context-budget.js'

test('operator model and Harness budgets reserve tools/output/protocol and fail closed on invalid configuration', () => {
  const config = { defaults: { windowTokens: 12000, threshold: 0.8, outputTokens: 1000, toolTokens: 1000, protocolTokens: 500 }, harnesses: { codex: { windowTokens: 20000 } }, models: { precise: { windowTokens: 10000, memoryTokens: 400 } } }
  const budget = createContextBudget(config, { harness: 'codex', model: 'precise' })
  assert.equal(budget.windowTokens, 10000)
  assert.equal(budget.inputTokens, 5500)
  assert.equal(budget.limits.memoryTokens, 400)
  assert.equal(budget.estimator, 'utf8-upper-bound')
  assert.equal(createContextBudget(config, { harness: 'codex', model: 'other' }).windowTokens, 20000)
  for (const change of [{ windowTokens: 0 }, { threshold: 1 }, { memoryTokens: -1 }, { outputTokens: 20000 }, { estimator: 'pretend-exact' }]) assert.throws(() => createContextBudget({ defaults: { ...config.defaults, ...change } }), { code: 'bot/context-budget' })
})

test('unknown capacity remains explicit while provider metadata cannot be enlarged by an operator override', async () => {
  const unknown = createContextBudget({})
  assert.equal(unknown.windowTokens, null)
  assert.equal(unknown.capacitySource, 'unknown')
  assert.equal(unknown.inputTokens, null)
  const rt = { config: { projectContext: { defaults: { windowTokens: 20000 } } }, ctx: { llm: { resolveModelInfo: async (provider, model) => { assert.equal(provider, 'local'); assert.equal(model, 'model'); return { context: { contextWindow: 10000 }, defaultMaxTokens: 1000 } } } } }
  const resolved = await resolveContextBudget(rt, { model: 'local/model', execution: { harness: 'flybot' } })
  assert.equal(resolved.windowTokens, 10000)
  assert.equal(resolved.capacitySource, 'operator-and-provider-min')
  rt.ctx.llm.resolveModelInfo = async () => { throw new Error('Provider unavailable') }
  assert.equal((await resolveContextBudget(rt, { model: 'local/model' })).capacitySource, 'operator')
})

test('whole prompt accounting includes fixed policy and current input, and never silently trims required constraints', () => {
  const budget = createContextBudget({ defaults: { windowTokens: 3000, outputTokens: 500, toolTokens: 500, protocolTokens: 200 } })
  assert.equal(countContextTokens('测试', budget), 6)
  const accepted = checkContextPrompt('Mandatory role rules and input', budget)
  assert.equal(accepted.withinBudget, true)
  assert.equal(accepted.reserved.outputTokens, 500)
  assert.throws(() => checkContextPrompt('Required policy '.repeat(300), budget), { code: 'bot/context-budget' })
  const unknown = checkContextPrompt('Input with unknown model capacity', createContextBudget({}))
  assert.equal(unknown.withinBudget, null)
  assert.equal(unknown.estimated, true)
})

test('context tool pages share a result budget, retain immutable hashes and cannot fake complete sources', async () => {
  const { contextValuePage, fitContextToolResult } = await import('../src/host/project-context-budget.js')
  const budget = createContextBudget({ defaults: { windowTokens: 10000, toolTokens: 1200 } })
  const source = { text: '原始证据'.repeat(2000) }
  const page = contextValuePage(source, budget)
  const result = fitContextToolResult({ reads: [page], tasks: Array.from({ length: 50 }, (_, i) => ({ id: 't-' + i, title: 'Old task '.repeat(80) })) }, budget)
  assert.ok(countContextTokens(JSON.stringify(result), budget) <= 1200)
  assert.ok(result.retrieval.omitted.tasks > 0)
  assert.ok(result.reads[0].nextOffset > 0)
  assert.equal(result.reads[0].sha256, page.sha256)
  assert.throws(() => contextValuePage({ text: 'Changed source' }, budget, { sha256: page.sha256 }), /changed/)
  assert.throws(() => contextValuePage(source, budget, { offset: -1 }), /offset/)
  assert.throws(() => fitContextToolResult({ mandatory: 'Required constraints '.repeat(200) }, budget), /mandatory/)
})

test('budget resolution selects only the actual Project owner resource profile', async () => {
  const rt = { config: { projectContext: { models: { 'actual-profile-model': { windowTokens: 20000 } } } }, readProject: id => { assert.equal(id, 'p'); return { ownerUserId: 'owner' } },
    projectResources: { setting: (projectId, resourceId) => { assert.equal(projectId, 'p'); assert.equal(resourceId, 'r'); return { profiles: { owner: { codex: { model: 'actual-profile-model' } }, other: { codex: { model: 'foreign-model' } } } } } } }
  const result = await resolveContextBudget(rt, { model: 'native-default', execution: { harness: 'codex' } }, { projectId: 'p', resourceId: 'r' })
  assert.equal(result.model, 'actual-profile-model')
  assert.equal(result.windowTokens, 20000)
  assert.throws(() => createContextBudget({ harnesses: { codex: null } }, { harness: 'codex' }), /object/)
})
