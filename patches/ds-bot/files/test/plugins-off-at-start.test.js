// #2939: a start with a feature plugin switched off said nothing anywhere — the plugin's own
// `apply()` returns early and no log line is written — so a user who could only paste a log
// saw a missing Project surface and no way to tell a switch from a bug. The start snapshot
// that already answers "on or off" for this process is the one source of the line, and it is
// written once per start, only when at least one feature plugin is off.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const LINE = 'flybot: feature plugins off at start: '

// One start: the switches state.json saves are what install() reads, and diagnostics hands
// the finished line to `ctx.logger.warn('%s', line)`, so the logger sees the text the user sees.
function start(switches = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dsb-plugins-off-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 2, mainBotIds: [], members: {}, bots: {}, rooms: {}, agents: {}, capabilities: { items: {} },
    exchanges: [], exchangeTurns: {}, revision: 0, flybot: { plugins: switches },
  }))
  const logged = []
  const ctx = fakeContext()
  ctx.logger.warn = (...args) => {
    logged.push(typeof args[0] === 'string' && args[0] === '%s' && args.length === 2 ? args[1] : args.map(String).join(' '))
  }
  createRuntime(ctx, { home, diagnosticsFile: false })
  const said = () => logged.filter(line => line.startsWith(LINE))
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { said, stop }
}

const count = (line, id) => line.split(id).length - 1

test('a start with project off says so in exactly one line (#2939)', async () => {
  const run = start({ project: { enabled: false } })
  try {
    assert.deepEqual(run.said(), [`${LINE}project`], 'one line, naming project')
  } finally {
    await run.stop()
  }
})

test('a start with every switch on says nothing (#2939)', async () => {
  const run = start()
  try {
    assert.deepEqual(run.said(), [], 'no per-start noise while every feature plugin is on')
  } finally {
    await run.stop()
  }
})

test('a start with three switches off says one line naming all three (#2939)', async () => {
  const run = start({
    social: { enabled: false },
    workflow: { enabled: false },
    project: { enabled: false },
  })
  try {
    const said = run.said()
    assert.equal(said.length, 1, 'still one line, not one line per plugin')
    for (const id of ['social', 'workflow', 'project']) assert.equal(count(said[0], id), 1, `${id} is named once`)
    assert.deepEqual(said, [`${LINE}social, workflow, project`])
  } finally {
    await run.stop()
  }
})
