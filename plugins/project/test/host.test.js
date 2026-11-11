// The plugin's own half (#2684): what `apply()` puts on a core runtime, and what the owner switch
// takes away. The domain's behavior is covered by the tests next to this file, which moved here
// from `core/test/project-*.test.js`; this one pins the plugin boundary itself:
//
//   - the two Project tools are registered here and nowhere else, with the same names the core's
//     TEAM_TOOLS lists;
//   - the four seams the store, meetings and channel already call are installed;
//   - `pluginEnabled('project') === false` registers none of it (read from the state file the host
//     points at, the way the core reads every switch);
//   - the helpers the plugin binds are the names the core's own seam carries.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime, provideFlyBot } from 'ds-bot'
import { apply } from '../index.js'
import { bindHost, REQUIRED } from '../src/host.js'
import { HELPER_NAMES } from '../../../core/src/host/project-host.js'
import { fakeContext } from '../../../core/test/fake-ctx.js'

const TEAM = {
  version: 1, mainBotIds: ['a'],
  bots: { a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 } },
  rooms: {}, agents: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {}, revision: 0,
}

function coreContext() {
  const ctx = fakeContext()
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: { create: async () => ({ sessionId: 's1' }), resolveAgent: async id => ({ agent: { session: { id }, id, status: 'idle', cancel() {} } }), selectModel: async () => {}, page: async () => ({ records: [], hasMore: false }) },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  return ctx
}

// `projectEnabled: false` writes the owner switch into the state file the core reads at startup.
function boot({ projectEnabled = true, dir } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'flybot-project-plugin-'))
  const team = projectEnabled ? TEAM : { ...TEAM, flybot: { plugins: { project: { enabled: false } } } }
  writeFileSync(join(home, 'state.json'), JSON.stringify(team))
  const ctx = coreContext()
  const rt = createRuntime(ctx, { home })
  provideFlyBot(ctx, rt.flybot)
  const result = apply({ flybot: rt.flybot, effect: exec => exec() })
  const stop = () => rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  return { ctx, rt, result, home, stop, dir }
}

const tools = ctx => [...ctx.registeredTools.keys()].sort()
// The core's own modules register their tools on the same runtime; this test is about the two the
// Project domain adds and the seams it installs.
const projectTools = ctx => tools(ctx).filter(name => name.startsWith('project_'))

test('#2684 apply() installs the Project domain on the core runtime and registers its tools', () => {
  const { ctx, rt, result, stop } = boot()
  try {
    assert.deepEqual(projectTools(ctx), ['project_digest', 'project_state'])
    assert.equal(typeof rt.projectBoard, 'function')
    assert.equal(typeof rt.projectChief.create, 'function')
    assert.equal(typeof rt.projectTeam, 'function')
    assert.equal(typeof rt.projectAssistant.create, 'function')
    assert.equal(typeof result.dispose, 'function')
    // A second apply must not register the tools again (the fake context would keep one entry, but
    // a real ctx.tools.register of the same name throws) and must not install a second domain.
    const again = apply({ flybot: rt.flybot, effect: exec => exec() })
    assert.deepEqual(projectTools(ctx), ['project_digest', 'project_state'])
    assert.equal(again.project, result.project)
  } finally { stop() }
})

test('#2684 the owner switch off registers no tool and no seam', () => {
  const { ctx, rt, result, stop } = boot({ projectEnabled: false })
  try {
    assert.deepEqual(projectTools(ctx), [])
    assert.equal(rt.projectBoard, undefined)
    assert.equal(rt.projectChief, undefined)
    assert.equal(rt.projectTeam, undefined)
    assert.equal(rt.projectAssistant, undefined)
    assert.equal(result.project, undefined)
    // The store keeps its documented fallback: a Project is still created, just without a Chief.
    assert.equal(typeof rt.flybot.projects.read, 'function')
  } finally { stop() }
})

test('#2684 project_state answers the Project State listing it always did', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'flybot-project-state-'))
  mkdirSync(join(dir, '.git'))
  writeFileSync(join(dir, 'PROJECT.md'), '# Project\n')
  const { ctx, stop } = boot()
  try {
    const tool = ctx.registeredTools.get('project_state')
    const exec = { agent: { id: 'a', session: { header: { cwd: dir } } } }
    const listing = await tool.execute({}, exec)
    assert.match(listing, /^project state:\nPROJECT\.md\t\d+ bytes\tsha256:[0-9a-f]{64}\t\d{4}-\d{2}-\d{2}T/)
    assert.equal(await tool.execute({ file: 'PROJECT.md' }, exec), '# Project\n')
    assert.equal(await tool.execute({ file: '../etc/passwd' }, exec), 'not listed: ../etc/passwd is not a Project State file')
  } finally { stop(); rmSync(dir, { recursive: true, force: true, maxRetries: 5 }) }
})

test('#2684 the plugin binds exactly the helpers the core seam names', () => {
  // `test/host-bind.js` bound the core's own implementations for the pure-function tests; the names
  // the plugin insists on and the names the core hands over are one list.
  assert.deepEqual([...REQUIRED].sort(), [...HELPER_NAMES].sort())
  assert.doesNotThrow(() => bindHost(new Proxy({}, { get: (_, name) => () => name })))
})
