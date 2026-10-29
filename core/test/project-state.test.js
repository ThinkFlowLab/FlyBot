import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const TEAM = {
  version: 1, mainBotIds: ['a'],
  bots: { a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 } },
  rooms: {}, agents: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {}, revision: 0,
}

// A Project State folder: `.git` so it reads as a repository, the files the reader answers
// for, and one decision file.
function projectStateFolder() {
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-project-state-'))
  mkdirSync(join(dir, '.git'))
  mkdirSync(join(dir, 'docs'))
  mkdirSync(join(dir, 'decisions'))
  writeFileSync(join(dir, 'PROJECT.md'), '# Project\none\n')
  writeFileSync(join(dir, 'ROADMAP.md'), '# Roadmap\n')
  writeFileSync(join(dir, 'LESSONS.md'), '# Lessons\n')
  writeFileSync(join(dir, 'docs/governance.md'), '# Governance\n')
  writeFileSync(join(dir, 'decisions/0001-first.md'), '# First decision\n')
  writeFileSync(join(dir, 'README.md'), 'not project state\n')
  return dir
}

async function boot({ dir } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-project-state-home-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  const ctx = fakeContext()
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => (dir === undefined ? undefined : { path: dir }), resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: { create: async () => ({ sessionId: 's1' }), resolveAgent: async id => ({ agent: { session: { id }, id, status: 'idle', cancel() {} } }), selectModel: async () => {}, page: async () => ({ records: [], hasMore: false }) },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  const rt = apply(ctx, { home })
  await ctx.flybot.ready()
  const exec = { agent: { id: 'a', session: { header: { cwd: dir } } } }
  const tool = (args, agentExec = exec) => ctx.registeredTools.get('project_state').execute(args, agentExec)
  const stop = async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) }
  return { ctx, rt, home, tool, stop }
}

test('#1702: list returns each Project State file with bytes, a stable sha256 and its mtime', async (t) => {
  const dir = projectStateFolder()
  const { tool, stop } = await boot({ dir })
  t.after(async () => { await stop(); rmSync(dir, { recursive: true, force: true, maxRetries: 5 }) })

  const first = await tool({})
  const rows = first.split('\n').slice(1).map(line => line.split('\t'))
  const paths = rows.map(row => row[0]).sort()
  assert.deepEqual(paths, ['LESSONS.md', 'PROJECT.md', 'ROADMAP.md', 'decisions/0001-first.md', 'docs/governance.md'])
  for (const row of rows) {
    assert.match(row[1], /^\d+ bytes$/)
    assert.match(row[2], /^sha256:[0-9a-f]{64}$/)
    assert.match(row[3], /^\d{4}-\d{2}-\d{2}T/)
  }
  const project = rows.find(row => row[0] === 'PROJECT.md')
  assert.equal(project[1], `${readFileSync(join(dir, 'PROJECT.md')).length} bytes`)
  // Same bytes, same hash — across calls and across a fresh listing.
  assert.equal(await tool({}), first)

  // One byte changes the content hash.
  writeFileSync(join(dir, 'PROJECT.md'), '# Project\nONE\n')
  const changed = await tool({})
  const changedRow = changed.split('\n').slice(1).map(line => line.split('\t')).find(row => row[0] === 'PROJECT.md')
  assert.notEqual(changedRow[2], project[2])
  assert.equal(changedRow[1], project[1], 'the byte size stayed the same; only the hash moved')
})

test('#1702: read one returns its bytes, bounded, and reports a missing file', async (t) => {
  const dir = projectStateFolder()
  const { tool, stop } = await boot({ dir })
  t.after(async () => { await stop(); rmSync(dir, { recursive: true, force: true, maxRetries: 5 }) })

  assert.equal(await tool({ file: 'decisions/0001-first.md' }), '# First decision\n')
  assert.equal(await tool({ file: 'PROJECT.md' }), '# Project\none\n')
  assert.match(await tool({ file: 'decisions/missing.md' }), /^absent: decisions\/missing\.md$/)
  assert.match(await tool({ file: 'README.md' }), /^not listed: README\.md is not a Project State file$/)
  assert.match(await tool({ file: '../PROJECT.md' }), /^not listed:/)

  const large = 'x'.repeat(200_001)
  writeFileSync(join(dir, 'decisions/big.md'), large)
  assert.match(await tool({ file: 'decisions/big.md' }), /^too large: decisions\/big\.md is 200001 bytes \(bound 200000\)$/)
  const listed = await tool({})
  const bigRow = listed.split('\n').find(line => line.startsWith('decisions/big.md\t'))
  assert.match(bigRow, /\t200001 bytes\t/, 'a file over the read bound still lists with its size')
})

test('#1702: a folder with no repository answers not a repository', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-project-state-nogit-'))
  writeFileSync(join(dir, 'PROJECT.md'), '# Project\n')
  const { tool, stop } = await boot({ dir })
  t.after(async () => { await stop(); rmSync(dir, { recursive: true, force: true, maxRetries: 5 }) })

  assert.match(await tool({}), /^not a repository: /)
  assert.match(await tool({ file: 'PROJECT.md' }), /^not a repository: /)
})

test('#1702: calling the reader changes no prompt, section or tool registration', async (t) => {
  const dir = projectStateFolder()
  const { ctx, tool, stop } = await boot({ dir })
  t.after(async () => { await stop(); rmSync(dir, { recursive: true, force: true, maxRetries: 5 }) })

  const calls = [...ctx.calls]
  const sections = new Map(ctx.sections)
  const tools = [...ctx.registeredTools.keys()].sort()
  await tool({})
  await tool({ file: 'PROJECT.md' })
  assert.deepEqual(ctx.calls, calls, 'a read registers nothing and fires no effect')
  assert.deepEqual([...ctx.sections.keys()].sort(), [...sections.keys()].sort(), 'no prompt section is added')
  assert.deepEqual([...ctx.registeredTools.keys()].sort(), tools, 'no tool is added or replaced')
})
