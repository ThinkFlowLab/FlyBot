import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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

// A symlink is a name for a file somewhere else, and this reader answers for one folder. A name
// that stands for a link is therefore absent — the same answer as a file that is not there — and
// never the target's text. `readdir` already leaves a link out of the listing, and the read has to
// agree with it; a name from a record can reach the same file without ever being listed.
test('#2037: a symlinked Project State file is not followed, it answers as absent', async (t) => {
  const dir = projectStateFolder()
  const outside = mkdtempSync(join(tmpdir(), 'ds-bot-project-state-outside-'))
  writeFileSync(join(outside, 'secret.md'), '# Outside secret\n')
  const { tool, stop } = await boot({ dir })
  t.after(async () => {
    await stop()
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
    rmSync(outside, { recursive: true, force: true, maxRetries: 5 })
  })

  symlinkSync(join(outside, 'secret.md'), join(dir, 'decisions/0002-link.md'))
  assert.equal(await tool({ file: 'decisions/0002-link.md' }), 'absent: decisions/0002-link.md', 'a link answers like a missing file, never with the text it points at')

  rmSync(join(dir, 'PROJECT.md'))
  symlinkSync(join(outside, 'secret.md'), join(dir, 'PROJECT.md'))
  assert.equal(await tool({ file: 'PROJECT.md' }), 'absent: PROJECT.md', 'the same answer for a named Project State file')
  const lines = (await tool({})).split('\n')
  assert.equal(lines.some(line => line.startsWith('PROJECT.md\t')), false, 'a link is not listed either')
  assert.equal(lines.some(line => line.startsWith('decisions/0002-link.md\t')), false, 'and neither is a linked decision')
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

// #2055: the `decisions` entry itself must be a real directory. `readdir` follows a link, and so
// does the leaf `lstat` of `decisions/<name>.md`, so a Project whose `decisions` points at another
// folder listed and read that folder's files as its own. A link — at a real folder or at a missing
// path — and a plain file answer exactly like a folder that has no `decisions` directory: no row,
// no hash, and `absent` for a read. The control is a real folder, which must keep working.
function replaceDecisions(dir, target) {
  rmSync(join(dir, 'decisions'), { recursive: true, force: true })
  symlinkSync(target, join(dir, 'decisions'))
}

test('#2055: a decisions folder that is a symlink to a real folder outside the Project lists and opens nothing', async (t) => {
  const dir = projectStateFolder()
  const outside = mkdtempSync(join(tmpdir(), 'ds-bot-project-state-outside-'))
  writeFileSync(join(outside, 'outside.md'), '# Outside\n')
  const { tool, stop } = await boot({ dir })
  t.after(async () => {
    await stop()
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
    rmSync(outside, { recursive: true, force: true, maxRetries: 5 })
  })

  replaceDecisions(dir, outside)
  const listing = await tool({})
  assert.equal(listing.split('\n').some(line => line.startsWith('decisions/')), false, 'another folder\'s files are not this Project\'s listing')
  assert.equal(listing.includes('outside.md'), false, 'not even the name, so no title and no sha256 reach the answer')
  assert.equal(await tool({ file: 'decisions/outside.md' }), 'absent: decisions/outside.md', 'a read answers as a folder with no decisions, never with the text it points at')
  assert.equal(listing.includes('PROJECT.md\t'), true, 'the named Project State files are unaffected')
})

test('#2055: a decisions folder that is a symlink to a path that does not exist reads as no decisions', async (t) => {
  const dir = projectStateFolder()
  const { tool, stop } = await boot({ dir })
  t.after(async () => { await stop(); rmSync(dir, { recursive: true, force: true, maxRetries: 5 }) })

  replaceDecisions(dir, join(dir, 'nowhere-decisions'))
  const listing = await tool({})
  assert.equal(listing.split('\n').some(line => line.startsWith('decisions/')), false, 'a dangling link lists nothing')
  assert.equal(await tool({ file: 'decisions/0001-first.md' }), 'absent: decisions/0001-first.md', 'and a read is absent, with no error naming the target')
})

// The listing is not the only door: `project_state` with a `file` goes `readProjectState` →
// `readListedFile` → `fileAt`, which never calls `readdir`. So the same link is asked here without
// a listing first, and the answer is the one an absent folder gives.
test('#2055: a decision read by name under a linked folder answers absent, with no listing first', async (t) => {
  const dir = projectStateFolder()
  const outside = mkdtempSync(join(tmpdir(), 'ds-bot-project-state-outside-read-'))
  writeFileSync(join(outside, 'outside.md'), '# Outside\n')
  const { tool, stop } = await boot({ dir })
  t.after(async () => {
    await stop()
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
    rmSync(outside, { recursive: true, force: true, maxRetries: 5 })
  })

  replaceDecisions(dir, outside)
  assert.equal(await tool({ file: 'decisions/outside.md' }), 'absent: decisions/outside.md', 'the leaf lstat would see a plain file, so the folder above it decides')
  assert.equal(await tool({ file: 'decisions/0001-first.md' }), 'absent: decisions/0001-first.md', 'a name from the old real folder is absent too, never read through the link')
})

test('#2055: a decisions folder that is a plain file, not a directory, reads as no decisions', async (t) => {
  const dir = projectStateFolder()
  const { tool, stop } = await boot({ dir })
  t.after(async () => { await stop(); rmSync(dir, { recursive: true, force: true, maxRetries: 5 }) })

  rmSync(join(dir, 'decisions'), { recursive: true, force: true })
  writeFileSync(join(dir, 'decisions'), 'not a folder\n')
  const listing = await tool({})
  assert.equal(listing.split('\n').some(line => line.startsWith('decisions/')), false, 'a plain file where the folder should be lists nothing')
  assert.equal(await tool({ file: 'decisions/0001-first.md' }), 'absent: decisions/0001-first.md', 'and nothing throws')
})

test('#2055: a real decisions folder keeps listing, hashing and reading its files', async (t) => {
  const dir = projectStateFolder()
  const { tool, stop } = await boot({ dir })
  t.after(async () => { await stop(); rmSync(dir, { recursive: true, force: true, maxRetries: 5 }) })

  const row = (await tool({})).split('\n').find(line => line.startsWith('decisions/0001-first.md\t'))
  assert.ok(row, 'the control still lists its decision')
  const sha = /sha256:([0-9a-f]{64})/.exec(row)[1]
  assert.equal(sha, createHash('sha256').update(readFileSync(join(dir, 'decisions/0001-first.md'))).digest('hex'), 'with the hash of the bytes it read')
  assert.equal(await tool({ file: 'decisions/0001-first.md' }), '# First decision\n', 'and the read returns the file itself')
})
