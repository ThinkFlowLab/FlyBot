import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_HARNESS_ID,
  HARNESS_PRO_VERIFIERS,
  HARNESS_TIER_LABELS,
  defaultHarness,
  harnessPro,
  harnessTierOrder,
  install,
  resolveHarness,
  routeHarness,
} from '../src/host/harness.js'

const here = dirname(fileURLToPath(import.meta.url))

test('Step 0 default harness names prompt, tools, model, step·retry, and verifiers', () => {
  const harness = defaultHarness()
  assert.equal(harness.id, DEFAULT_HARNESS_ID)
  assert.equal(harness.prompt.module, './prompt.js')
  assert.equal(harness.tools.module, './tools.js')
  assert.equal(harness.model.module, './models.js')
  assert.equal(harness.stepRetry.module, './turns.js')
  assert.ok(harness.verifiers.note)
})

test('default harness keeps the Step 0 shape', () => {
  const harness = defaultHarness()
  assert.deepEqual(Object.keys(harness), ['id', 'prompt', 'tools', 'model', 'stepRetry', 'verifiers', 'exceptions'])
  assert.deepEqual(Object.keys(harness.prompt), ['module', 'section'])
  assert.deepEqual(Object.keys(harness.tools), ['module'])
  assert.deepEqual(Object.keys(harness.model), ['module', 'note'])
  assert.deepEqual(Object.keys(harness.stepRetry), ['module', 'note'])
  assert.deepEqual(Object.keys(harness.verifiers), ['note'])
  assert.equal(harness.id, 'default')
  assert.equal(resolveHarness().id, 'default')
  assert.equal(resolveHarness('default').id, 'default')
})

test('unknown harness ids still throw', () => {
  assert.throws(() => resolveHarness('magpie'), /unknown harness/)
  assert.throws(() => resolveHarness('harness:lite'), /unknown harness/)
})

test('tree prompt exception is listed outside the default harness file', () => {
  const tree = defaultHarness().exceptions.find(entry => entry.id === 'tree-prompt')
  assert.equal(tree.path, 'plugins/tree')
  for (const id of ['lite', 'medium', 'heavy']) {
    const tier = resolveHarness(id).exceptions.find(entry => entry.id === 'tree-prompt')
    assert.equal(tier.path, 'plugins/tree', id)
  }
})

test('lite, medium, and heavy load with distinct ordered budgets', () => {
  const order = harnessTierOrder()
  assert.deepEqual(order.failures, [], order.failures.join('; '))
  assert.equal(order.ok, true)
  const lite = resolveHarness('lite')
  const medium = resolveHarness('medium')
  const heavy = resolveHarness('heavy')
  assert.equal(lite.applied, false)
  assert.equal(medium.applied, false)
  assert.equal(heavy.applied, false)
  assert.ok(lite.prompt.maxChars < medium.prompt.maxChars)
  assert.ok(medium.prompt.maxChars < heavy.prompt.maxChars)
  assert.ok(lite.tools.maxCalls < medium.tools.maxCalls)
  assert.ok(medium.tools.maxCalls < heavy.tools.maxCalls)
  assert.ok(lite.model.maxTokens < medium.model.maxTokens)
  assert.ok(medium.model.maxTokens < heavy.model.maxTokens)
  assert.ok(lite.stepRetry.maxSteps < medium.stepRetry.maxSteps)
  assert.ok(medium.stepRetry.maxSteps < heavy.stepRetry.maxSteps)
  assert.ok(lite.stepRetry.maxRetries < medium.stepRetry.maxRetries)
  assert.ok(medium.stepRetry.maxRetries <= heavy.stepRetry.maxRetries)
  assert.ok(lite.tools.allow.length < medium.tools.allow.length)
  assert.equal(heavy.tools.allow, null)
  for (const tool of lite.tools.allow) assert.ok(medium.tools.allow.includes(tool), tool)
  for (const blocked of ['create_bot', 'delete_group', 'stop_bot']) {
    assert.equal(medium.tools.allow.includes(blocked), false, blocked)
  }
})

test('tier tool budgets name tools the host registers', () => {
  const files = [
    'tools.js', 'memory.js', 'schedules.js', 'secrets.js', 'browser.js', 'decisions.js', 'groups.js',
  ]
  const names = new Set()
  for (const file of files) {
    const text = readFileSync(join(here, '../src/host', file), 'utf8')
    for (const match of text.matchAll(/defineTool\(\{[\s\S]*?name: '([a-z0-9_]+)'/g)) names.add(match[1])
  }
  for (const id of ['lite', 'medium']) {
    for (const tool of resolveHarness(id).tools.allow) assert.ok(names.has(tool), `${id} ${tool}`)
  }
})

test('triage routes one harness label and leaves every other label on default', () => {
  assert.deepEqual(HARNESS_TIER_LABELS, {
    lite: 'harness:lite',
    medium: 'harness:medium',
    heavy: 'harness:heavy',
  })
  assert.equal(routeHarness([]).id, 'default')
  assert.equal(routeHarness(['agent-ready', 'risk:T2']).id, 'default')
  assert.equal(routeHarness(['harness:lite']).id, 'lite')
  assert.equal(routeHarness([{ name: 'harness:medium' }, { name: 'bug' }]).id, 'medium')
  assert.equal(routeHarness({ labels: [{ name: 'Harness:Heavy' }] }).id, 'heavy')
  assert.equal(routeHarness(['harness:lite', 'harness:lite']).id, 'lite')
  assert.throws(() => routeHarness(['harness:lite', 'harness:heavy']), /one harness tier label/)
  assert.throws(() => routeHarness(['harness:turbo']), /unknown harness label/)
})

test('HarnessPro checks a tier offline against CI, eval, and rsi-baseline', () => {
  assert.deepEqual([...HARNESS_PRO_VERIFIERS], ['ci', 'core/dev/eval', 'rsi-baseline'])
  for (const id of ['default', 'lite', 'medium', 'heavy']) {
    const report = harnessPro(resolveHarness(id))
    assert.equal(report.ok, true, `${id} ${report.failures.join('; ')}`)
  }
  const drifted = resolveHarness('lite')
  drifted.prompt = { ...drifted.prompt, module: './other-prompt.js' }
  assert.equal(harnessPro(drifted).ok, false)
  const unverified = resolveHarness('medium')
  unverified.verifiers = { offline: ['ci'] }
  const missing = harnessPro(unverified)
  assert.equal(missing.ok, false)
  assert.ok(missing.failures.includes('verifiers.offline'))
  const leaked = resolveHarness('heavy')
  leaked.model = { ...leaked.model, apiKey: 'sk-live-secret' }
  assert.equal(harnessPro(leaked).ok, false)
})

test('install keeps the process harness on default and exposes routing', () => {
  const rt = {}
  install(rt)
  assert.equal(rt.harness.id, 'default')
  assert.equal(rt.resolveHarness('heavy').id, 'heavy')
  assert.equal(rt.routeHarness(['harness:lite']).id, 'lite')
  assert.equal(rt.harness.id, 'default')
})
