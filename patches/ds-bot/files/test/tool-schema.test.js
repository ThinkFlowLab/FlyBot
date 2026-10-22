import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { defineTool as dshDefineTool } from '@deepseek-ai/dsh-tools'
import { apply } from '../index.js'
import { toParameterMap } from '../src/host/hooks.js'
import { defineTool } from '../src/host/tool-schema.js'
import { fakeContext } from './fake-ctx.js'

// #<issue>: a strict OpenAI-compatible gateway does not read JSON Schema defaults. It normalises an
// absent `required` or `properties` on an object node to null and then rejects the whole chat request
// ("null is not of type \"array\"" / "null is not of type \"object\""), so one argument-less tool
// breaks every turn. Every schema FlyBot registers must therefore carry both members explicitly.
// The class: no-parameter tools, all-optional tools, and nested object params.

const team = () => ({
  version: 1, mainBotIds: ['a'], bots: { a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 } },
  rooms: {}, agents: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {}, revision: 0,
})

// The definition that reached ctx.tools.register is what DSH hands the model, so the fake context's
// record is the thing to assert on.
let home
let ctx
let tools

before(() => {
  home = mkdtempSync(join(tmpdir(), 'ds-bot-tool-schema-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(team()))
  ctx = fakeContext()
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: { create: async () => ({ sessionId: 's1' }), resolveAgent: async () => undefined, selectModel: async () => {}, page: async () => ({ records: [], hasMore: false }) },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  apply(ctx, { home })
  tools = new Map(ctx.registeredTools)
})

after(async () => {
  await ctx.dispose()
  rmSync(home, { recursive: true, force: true, maxRetries: 5 })
})

const isObject = node => node !== null && typeof node === 'object' && !Array.isArray(node)

// Every object node in a schema, with the path that names it in a failure.
export function objectNodes(node, path = 'parameters', out = []) {
  if (Array.isArray(node)) {
    node.forEach((child, index) => objectNodes(child, `${path}[${index}]`, out))
    return out
  }
  if (!isObject(node)) return out
  for (const [key, value] of Object.entries(node)) {
    if (key === 'properties' && isObject(value)) {
      for (const [name, child] of Object.entries(value)) objectNodes(child, `${path}.${name}`, out)
    } else if (['items', 'additionalProperties', 'oneOf', 'anyOf', 'allOf', 'not'].includes(key)) {
      objectNodes(value, `${path}.${key}`, out)
    }
  }
  if (node.type === 'object') out.push({ node, path })
  return out
}

test('every registered tool says properties and required explicitly', () => {
  assert.ok(tools.size > 10, `expected the plugin's tools, got ${tools.size}`)
  for (const [name, tool] of tools) {
    for (const { node, path } of objectNodes(tool.parameters)) {
      assert.ok(Object.hasOwn(node, 'properties'), `${name}: ${path} must carry an explicit "properties"`)
      assert.ok(isObject(node.properties), `${name}: ${path}.properties must be an object`)
      assert.ok(Object.hasOwn(node, 'required'), `${name}: ${path} must carry an explicit "required"`)
      assert.ok(Array.isArray(node.required), `${name}: ${path}.required must be an array`)
    }
  }
})

test('a tool with no parameters declares properties {} and required []', () => {
  // These take no arguments, so the schema that reaches the model carried neither member.
  for (const name of ['bot_schedules', 'list_bots', 'list_models', 'list_secrets', 'list_capabilities', 'group_relay']) {
    const tool = tools.get(name)
    assert.ok(tool, `${name} must be registered`)
    assert.deepEqual(tool.parameters.properties, {}, name)
    assert.deepEqual(tool.parameters.required, [], name)
  }
})

test('a tool whose parameters are all optional declares required []', () => {
  for (const name of ['update_bot', 'read_own_chat', 'recall']) {
    const tool = tools.get(name)
    assert.ok(tool, `${name} must be registered`)
    assert.deepEqual(tool.parameters.required, [], `${name} has no mandatory parameter`)
    assert.ok(Object.keys(tool.parameters.properties).length > 0, `${name} still lists its optional parameters`)
  }
})

test('required names exactly the mandatory parameters', () => {
  const expected = {
    message_bot: ['to', 'message'],
    create_bot: ['name', 'role', 'instructions'],
    delete_group: ['group'],
    post_to_group: ['group', 'message'],
    ask_user: ['question', 'options'],
    save_capability: ['name', 'kind'],
    remember: ['text'],
  }
  for (const [name, names] of Object.entries(expected)) {
    const tool = tools.get(name)
    assert.ok(tool, `${name} must be registered`)
    assert.deepEqual([...tool.parameters.required].sort(), [...names].sort(), name)
  }
})

test('nested object parameters are complete too', () => {
  // ask_user's options is an array of object items; save_capability takes free-form objects.
  const options = tools.get('ask_user').parameters.properties.options
  const item = options.items
  assert.equal(item.type, 'object')
  assert.ok(Object.hasOwn(item, 'properties'), 'options item carries properties')
  assert.deepEqual(item.required, ['label'])
  for (const name of ['env', 'headers']) {
    const param = tools.get('save_capability').parameters.properties[name]
    assert.equal(param.type, 'object', name)
    assert.ok(Object.hasOwn(param, 'properties'), `${name} carries an explicit properties`)
    assert.ok(Object.hasOwn(param, 'required'), `${name} carries an explicit required`)
    assert.deepEqual(param.properties, {}, `${name} declares no keys`)
    assert.deepEqual(param.required, [], name)
  }
})

test('the completed shape survives DSH compiling the parameter map', () => {
  // toParameterMap hands DSH a parameter map, which has no place to express an empty `required`
  // (#768 review). The map is what DSH compiles, so what it compiles is what must be asserted:
  // this prints the schema at both ends, for the three shapes in the symptom.
  const cases = {
    // no parameters at all
    bot_schedules: undefined,
    // a JSON Schema object with no properties
    list_bots: { type: 'object', properties: {} },
    // every parameter optional
    update_bot: { type: 'object', properties: { name: { type: 'string' }, role: { type: 'string' } } },
  }
  for (const [label, input] of Object.entries(cases)) {
    const compiled = defineTool({ name: label, description: 'x', parameters: toParameterMap(input), output: { schema: { type: 'string' }, render: () => [] }, execute: () => 'x' })
    assert.equal(compiled.parameters.type, 'object', label)
    assert.ok(Object.hasOwn(compiled.parameters, 'properties'), `${label}: DSH's compiled schema lacks properties`)
    assert.ok(Object.hasOwn(compiled.parameters, 'required'), `${label}: DSH's compiled schema lacks required`)
    assert.deepEqual(compiled.parameters.required, [], label)
  }
  // Without the completion the same compile drops `required`; DSH's own defineTool does that.
  const bare = dshDefineTool({ name: 'x', description: 'x', parameters: toParameterMap(cases.update_bot), output: { schema: { type: 'string' }, render: () => [] }, execute: () => 'x' })
  assert.ok(!Object.hasOwn(bare.parameters, 'required'), 'DSH alone leaves required out — that is the defect the wrapper fixes')
})
