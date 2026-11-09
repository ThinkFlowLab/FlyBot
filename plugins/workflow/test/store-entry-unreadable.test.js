// A store that parses but whose workflow entries are not workflows is the same failure
// as a store that does not parse: the read answers `store-unreadable` instead of throwing.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createWorkflowService } from '../src/service.js'

const STORE_VERSION = 1

function openWith(entry) {
  const dir = mkdtempSync(join(tmpdir(), 'store-entry-'))
  writeFileSync(join(dir, 'workflows.json'), JSON.stringify({ version: STORE_VERSION, workflows: [entry], runs: {} }))
  const svc = createWorkflowService({ dir, persist: true, now: () => 1, bots: () => [], warn: () => {} })
  return { svc, dir }
}

for (const [label, entry] of [
  ['an entry that is not an object', null],
  ['an entry with no nodes', { id: 'w1', name: 'Broken' }],
  ['an entry whose nodes are not a list', { id: 'w1', name: 'Broken', nodes: null, edges: [], layers: [] }],
]) {
  test(`a store with ${label} answers store-unreadable`, () => {
    const { svc, dir } = openWith(entry)
    try {
      const state = svc.state()
      assert.equal(state.ok, false, 'the read answered a list instead of the failure')
      assert.equal(state.code, 'store-unreadable')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
}
