// A Project State file that is there but cannot be read must not be dropped on the floor. The
// reader already answers `not a repository`, `absent` and `too large` with the reason instead of
// an empty document; a listed name that exists and fails to read is the same kind of answer.
// Today `listProjectState` catches every failure and lists nothing, so a folder whose PROJECT.md
// is a folder, or is unreadable, reads as `no Project State files in this folder` — the one
// answer that says there is nothing to read. The name and the reason belong in the answer:
// `unreadable: PROJECT.md (<code>)`, with the name written the way the other rows write it
// (relative to the working folder, because the answer can be pasted into a public issue).
//
// The control is a folder with no Project State file at all, which must keep answering exactly
// `no Project State files` — an answer that says "nothing here" is wrong only when something is.
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

const NO_FILES = 'project state: no Project State files in this folder'
// The rows this reader answers with one per line; `unreadable` is the one this test is about.
const rows = listing => listing.split('\n').slice(1)
const unreadable = listing => rows(listing).filter(line => line.startsWith('unreadable: '))

// A folder the reader calls a repository, with nothing in it that this reader lists. The test
// writes the one state file it wants, so the red case is the only thing in the folder.
function emptyRepository() {
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-project-state-unreadable-'))
  mkdirSync(join(dir, '.git'))
  return dir
}

async function boot({ dir } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-project-state-unreadable-home-'))
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
  const tool = args => ctx.registeredTools.get('project_state').execute(args, exec)
  const stop = async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) }
  return { ctx, rt, home, tool, stop }
}

test('#2461: a Project State name that is a folder is answered as unreadable, never as no files', async (t) => {
  const dir = emptyRepository()
  mkdirSync(join(dir, 'PROJECT.md'))
  const { tool, stop } = await boot({ dir })
  t.after(async () => { await stop(); rmSync(dir, { recursive: true, force: true, maxRetries: 5 }) })

  const listing = await tool({})
  assert.notEqual(listing, NO_FILES, 'the folder is not empty: one listed name is there and could not be read')
  assert.equal(listing.split('\n')[0], 'project state:', 'the answer still opens as the listing it is')
  assert.deepEqual(unreadable(listing).map(line => line.replace(/ \([^)]+\)$/, '')), ['unreadable: PROJECT.md'],
    'the name is written the way the rows write it, relative to the working folder')
  for (const line of unreadable(listing)) assert.match(line, /^unreadable: PROJECT\.md \([^)\n]+\)$/,
    'the reason travels with the name, so a reader knows it is not an absent file')
})

test('#2461: a Project State file that cannot be read keeps its name and reason beside the rows that can', async (t) => {
  const dir = emptyRepository()
  mkdirSync(join(dir, 'PROJECT.md'))
  writeFileSync(join(dir, 'ROADMAP.md'), '# Roadmap\n')
  const { tool, stop } = await boot({ dir })
  t.after(async () => { await stop(); rmSync(dir, { recursive: true, force: true, maxRetries: 5 }) })

  const listing = await tool({})
  const roadmap = rows(listing).find(line => line.startsWith('ROADMAP.md\t'))
  assert.ok(roadmap, 'the file that can be read is still listed, with its size, hash and mtime')
  assert.equal(roadmap.split('\t').length, 4)
  assert.deepEqual(unreadable(listing).length, 1, 'and the one that cannot be read is named once, not swallowed')
})

// A root process reads a chmod 000 file, so this case is declared skipped rather than run there —
// the shape `core/test/diagnostics.test.js` already uses for its own root-only cases.
test('#2461: a state file the process may not read answers its code, not an empty folder', {
  skip: process.getuid?.() === 0 ? 'root reads a chmod 000 file' : undefined,
}, async (t) => {
  const dir = emptyRepository()
  writeFileSync(join(dir, 'PROJECT.md'), '# Project\n')
  chmodSync(join(dir, 'PROJECT.md'), 0o000)
  const { tool, stop } = await boot({ dir })
  t.after(async () => {
    await stop()
    chmodSync(join(dir, 'PROJECT.md'), 0o600)
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
  })

  const listing = await tool({})
  assert.notEqual(listing, NO_FILES, 'an unreadable file is not an absent one')
  assert.match(listing, /(^|\n)unreadable: PROJECT\.md \(EACCES\)($|\n)/,
    'the errno is what tells a reader to fix permissions rather than look for another file')
})

test('#2461: a folder with no Project State file still answers exactly no files', async (t) => {
  const dir = emptyRepository()
  const { tool, stop } = await boot({ dir })
  t.after(async () => { await stop(); rmSync(dir, { recursive: true, force: true, maxRetries: 5 }) })

  assert.equal(await tool({}), NO_FILES)
})
