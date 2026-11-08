// The host's own files carry the user's content: a Bot's memory, the saved team, the index of
// every conversation part, the decision log, the OCR cache and the notes of a running turn. They
// are written by a process whose umask the host does not control, so without an explicit mode a
// stock `022` leaves them world-readable, and an atomic rewrite replaces a `chmod 0600` the owner
// made with the ambient `0644` (#2697).
//
// Every test here sets `umask 022` in-process and puts it back afterwards: this box runs `077`,
// which hides the defect. A scratch home is created `0755` first, the mode a stock shell gives it.
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { install as installImages } from '../src/host/images.js'
import { install as installResume } from '../src/host/resume.js'
import { fakeContext } from './fake-ctx.js'

const TEAM = {
  version: 1,
  mainBotIds: ['m1'],
  revision: 1,
  bots: {
    m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief of Staff', model: 'deepseek/v4', instructions: '', createdAt: 1 },
    b2: { id: 'b2', sessionId: 'b2', name: 'Writer', role: '写手', model: 'deepseek/v4', instructions: '', createdAt: 2 },
  },
  rooms: {
    r1: {
      id: 'r1', name: 'Launch', named: true, members: ['b2', 'm1'], admin: 'b2', mode: 'everyone', notice: '', sessions: {},
      seq: 2,
      log: [{ who: 'User', text: '私聊内容：帮我把这封离职信改短一点', seq: 1 }, { who: 'Writer', botId: 'b2', text: '好的，已改短。', seq: 2 }],
    },
  },
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

const mode = path => (statSync(path).mode & 0o777).toString(8).padStart(4, '0')
const tick = (ms = 40) => new Promise(resolve => setTimeout(resolve, ms))

// A scratch root widened to 0755, then a home under it, created the way `mkdir(..., { recursive:
// true })` leaves it under `umask 022`. `apply` gets a home that already exists at 0755.
function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-private-'))
  chmodSync(dir, 0o755)
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }))
  const home = join(dir, 'dsh', 'bot')
  mkdirSync(home, { recursive: true })
  assert.equal(mode(home), '0755', 'the scratch home must start world-readable, or this test proves nothing')
  return { dir, home }
}

function start(home, config = {}) {
  if (!existsSync(join(home, 'state.json'))) writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM), { mode: 0o600 })
  const ctx = fakeContext()
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => ['v4'], resolveModelInfo: async () => ({}) },
    sessionController: {
      create: async () => ({ sessionId: 's1' }),
      resolveAgent: async sessionId => ({ agent: { session: { id: sessionId }, ctx: { tools: { restrict: () => () => {} }, effect: fn => fn() }, followup() {} } }),
      selectModel: async () => {},
      page: async () => ({ records: [], hasMore: false }),
    },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {}, messageProjections: [] },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = options => { route = options; return register(options) }
  apply(ctx, { home, ...config })
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))).json()
  const tool = (name, args, sessionId) => ctx.registeredTools.get(name).execute(args, { agent: { id: sessionId } })
  return { ctx, call, tool, stop: async () => { await ctx.dispose() } }
}

test('Bot memory, its topics and its snapshot are private, and a narrowed file stays narrowed', async (t) => {
  const before = process.umask()
  process.umask(0o022)
  t.after(() => process.umask(before))
  const { home } = scratch(t)
  const host = start(home)
  t.after(host.stop)

  await host.tool('remember', { text: '- 用户的家庭住址是杭州西湖区文三路 100 号 [source: part 1 #1]' }, 'b2')
  await tick()

  const entry = join(home, 'memory', 'bots', 'b2', 'MEMORY.md')
  assert.match(readFileSync(entry, 'utf8'), /杭州西湖区/)
  assert.equal(mode(entry), '0600')
  for (const dir of [home, join(home, 'memory'), join(home, 'memory', 'bots'), join(home, 'memory', 'bots', 'b2')]) {
    assert.equal(mode(dir), '0700', dir)
  }

  // The frozen per-Session snapshot holds the same text under the same mode.
  host.ctx.sections.get('bot-memory').text({ agent: { id: 'b2' } })
  const snapshot = join(home, 'memory', 'snapshots', 'b2.md')
  assert.match(readFileSync(snapshot, 'utf8'), /杭州西湖区/)
  assert.equal(mode(snapshot), '0600')

  // The owner narrows the file by hand; the next rewrite must keep that, not put 0600 back.
  chmodSync(entry, 0o400)
  await host.tool('remember', { text: '- 用户偏好 DeepSeek 模型 [source: part 1 #2]' }, 'b2')
  await tick()
  assert.match(readFileSync(entry, 'utf8'), /DeepSeek/)
  assert.equal(mode(entry), '0400')
})

test('the saved team is private, also when it was seeded 0600', async (t) => {
  const before = process.umask()
  process.umask(0o022)
  t.after(() => process.umask(before))
  const { home } = scratch(t)
  const state = join(home, 'state.json')
  const host = start(home)
  t.after(host.stop)
  assert.equal(mode(state), '0600')

  await host.call('state', {})
  await host.call('add-agent')
  await tick(120)

  // The file carries a group message, and the team keeps the mode the owner gave it.
  assert.match(readFileSync(state, 'utf8'), /私聊内容/)
  assert.equal(mode(state), '0600')
  assert.equal(mode(home), '0700')
})

test('the decision log is private', async (t) => {
  const before = process.umask()
  process.umask(0o022)
  t.after(() => process.umask(before))
  const { home } = scratch(t)
  const host = start(home, { decisions: true })
  t.after(host.stop)
  await host.ctx.flybot.ready()

  const out = await host.tool('record_decision', { option: '把客户的报价单直接发到公开群', choice: 'rejected', why: '泄露报价' }, 'b2')
  await tick(80)

  const log = join(home, 'decisions.jsonl')
  assert.match(out, /Recorded/)
  assert.match(readFileSync(log, 'utf8'), /泄露报价/)
  assert.equal(mode(log), '0600')
  assert.equal(mode(home), '0700')
})

test('the OCR cache of the user\'s images is private', async (t) => {
  const before = process.umask()
  process.umask(0o022)
  t.after(() => process.umask(before))
  const { home } = scratch(t)
  const ctx = fakeContext()
  Object.assign(ctx, {
    llm: {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => [{ id: 'vision', input: ['text', 'image'] }],
      resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }),
      stream: async function* () {
        yield { type: 'text-delta', index: 0, text: 'A red triangle on a bank statement dated 2026-11-01.' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  })
  const rt = {
    ctx, home, config: {}, warn: () => {}, load: async () => {}, readOnly: () => undefined,
    roomOf: () => 'r1', isBotSession: () => true, ownRequest: () => false,
    catalog: async () => [{ ref: 'deepseek/vision', name: 'Vision', input: ['image'] }],
    defaultRef: () => 'deepseek/vision', tagUsage: messages => messages,
  }
  installImages(rt)
  await rt.imagesForGroup([{ attachmentId: `sha256:${'b'.repeat(64)}`, name: 'statement.png' }], 'r1')

  const cache = join(home, 'ocr.json')
  for (let i = 0; i < 100 && !existsSync(cache); i += 1) await tick(10)
  assert.match(readFileSync(cache, 'utf8'), /bank statement/)
  assert.equal(mode(cache), '0600')
  assert.equal(mode(home), '0700')
})

test('the chat index of every part is private, SQLite or not', async (t) => {
  const before = process.umask()
  process.umask(0o022)
  t.after(() => process.umask(before))
  const { home } = scratch(t)
  const host = start(home)
  t.after(host.stop)

  try { await host.tool('read_own_chat', { query: '银行卡' }, 'b2') } catch { /* no SQLite: nothing to check */ }
  await tick(150)

  const indexPath = join(home, 'chat-index.sqlite')
  // Without `node:sqlite` read_own_chat scans the logs and no file is made; the mode is then
  // nothing this test can fail on.
  if (!existsSync(indexPath)) return
  assert.equal(mode(indexPath), '0600')
  for (const suffix of ['-wal', '-shm']) {
    if (existsSync(`${indexPath}${suffix}`)) assert.equal(mode(`${indexPath}${suffix}`), '0600')
  }
  // SQLite creates the WAL files itself, on its own time; the folder is what covers them.
  assert.equal(mode(home), '0700')
})

test('the notes of a running turn are private', async (t) => {
  const before = process.umask()
  process.umask(0o022)
  t.after(() => process.umask(before))
  const { home } = scratch(t)
  const ctx = fakeContext()
  const rt = {
    ctx, home, readOnly: () => undefined, warn: () => {},
    deliver: async () => {}, chatOf: id => id,
  }
  installResume(rt)
  t.after(() => ctx.dispose())

  await rt.deliver({ toId: 'b2', text: '用户说：帮我把这封离职信改短一点' })
  const notes = join(home, 'inflight.json')
  for (let i = 0; i < 100 && !existsSync(notes); i += 1) await tick(10)
  assert.match(readFileSync(notes, 'utf8'), /离职信/)
  assert.equal(mode(notes), '0600')
  assert.equal(mode(home), '0700')
})

test('the helpers: a private folder is 0700, a new file 0600, a rewrite keeps the mode', async (t) => {
  const before = process.umask()
  process.umask(0o022)
  t.after(() => process.umask(before))
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-private-helpers-'))
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }))
  // The module is loaded here rather than at the top of the file, so the other tests show the
  // mode the writers put on disk even before this helper exists.
  const { ensurePrivateDir, ensurePrivateDirSync, replacePrivateFile, replacePrivateFileSync, PRIVATE_DIR_MODE, PRIVATE_FILE_MODE } = await import('../src/host/private-files.js')
  assert.equal(PRIVATE_DIR_MODE, 0o700)
  assert.equal(PRIVATE_FILE_MODE, 0o600)

  const created = join(dir, 'made', 'by', 'the', 'helper')
  await ensurePrivateDir(created)
  assert.equal(mode(created), '0700')
  // An existing folder at 0755 is narrowed too: `mkdir` leaves it alone.
  chmodSync(created, 0o755)
  ensurePrivateDirSync(created)
  assert.equal(mode(created), '0700')

  const fresh = join(created, 'fresh.md')
  await replacePrivateFile(`${fresh}.tmp`, fresh, 'hello')
  assert.equal(mode(fresh), '0600')
  assert.equal(readFileSync(fresh, 'utf8'), 'hello')

  // A mode the owner chose — narrower or wider — is the one the rewrite lands with.
  writeFileSync(fresh, 'old', { mode: 0o640 })
  chmodSync(fresh, 0o640)
  replacePrivateFileSync(`${fresh}.tmp`, fresh, 'new')
  assert.equal(mode(fresh), '0640')
  assert.equal(readFileSync(fresh, 'utf8'), 'new')
})
