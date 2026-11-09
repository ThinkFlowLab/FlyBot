// #2746 S2: the 8-lane ceiling is applied when the store is read, so a hand-edited
// `maxConcurrent` cannot widen it. The setter refuses 9 already, but a file edited by
// hand never goes through the setter: `maxOf` is the one guard left between a stored
// number and the scheduler.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createWorkflowService } from '../src/service.js'

const CLOCK = 1_700_000_000_000
const roster = [
  { id: 'main', name: 'Chief', role: 'lead', isMain: true, remote: false },
]

function serviceAt(dir) {
  return createWorkflowService({
    dir,
    persist: true,
    now: () => CLOCK,
    bots: () => roster,
    setTimer: () => 0,
    clearTimer: () => {},
  })
}

test('a stored maxConcurrent above 8 is clamped on read', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf-concurrency-ceiling-'))
  try {
    const first = serviceAt(dir)
    const created = first.create({ name: 'Alpha', nodes: [{ id: 'only', name: 'Only', prompt: 'Do it.' }], edges: [] })
    assert.equal(created.ok, true, created.error)
    const alpha = created.workflows.find(item => item.name === 'Alpha')
    first.dispose()

    // What a hand-edited store looks like: the setter never saw this number.
    const file = join(dir, 'workflows.json')
    const stored = JSON.parse(readFileSync(file, 'utf8'))
    stored.workflows.find(item => item.id === alpha.id).maxConcurrent = 50
    writeFileSync(file, JSON.stringify(stored))

    const reloaded = serviceAt(dir)
    const read = reloaded.state({})
    assert.equal(read.ok, true, read.error)
    assert.equal(read.workflows.find(item => item.id === alpha.id).maxConcurrent, 8, 'a read answers the ceiling, not the stored 50')
    reloaded.dispose()

    // Reading is not a write: the stored number is left exactly as the file had it.
    assert.equal(
      JSON.parse(readFileSync(file, 'utf8')).workflows.find(item => item.id === alpha.id).maxConcurrent,
      50,
      'the clamp is on the read, not a rewrite of the file',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
