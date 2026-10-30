// #1856: a workflow run belongs to a Project, but the plugin cannot write host state. `bindRun`
// is that one seam: it writes `state.projectRuns` through the same `bindProject` the endpoint
// uses, refuses an unknown Project, and a host without it answers `undefined` instead of throwing.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const seed = () => ({
  version: 1,
  mainBotIds: ['a'],
  bots: { a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 } },
  rooms: {}, agents: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {}, revision: 0,
})

async function start(t) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-project-run-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed()))
  const rt = createRuntime(fakeContext(), { home })
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  await rt.load()
  return rt
}

test('#1856: bindRun writes the run binding the board reads', async (t) => {
  const rt = await start(t)
  const project = rt.createProject({ name: 'FlyBot 开发' })
  const bound = await rt.flybot.projects.bindRun('run-abc', project.id)
  assert.equal(bound.id, project.id)
  assert.equal(rt.state.projectRuns['run-abc'], project.id)
  assert.equal(rt.flybot.projects.read(project.id).name, 'FlyBot 开发')
})

test('#1856: bindRun refuses an unknown Project and writes nothing', async (t) => {
  const rt = await start(t)
  await assert.rejects(() => rt.flybot.projects.bindRun('run-abc', 'project-missing'), /Unknown Project project-missing/)
  assert.equal(rt.state.projectRuns['run-abc'], undefined)
})

test('#1856: a host without the seam answers undefined instead of throwing', async (t) => {
  const rt = await start(t)
  rt.readProject = undefined
  rt.bindProject = undefined
  assert.equal(rt.flybot.projects.read('project-1'), undefined)
  assert.equal(await rt.flybot.projects.bindRun('run-abc', 'project-1'), undefined)
})
