import assert from 'node:assert/strict'
import fs from 'node:fs'
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime, provideFlyBot } from '../index.js'
import { homeLock } from '../src/host/home-lock.js'
import { fakeContext } from './fake-ctx.js'

const tempHome = (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-lock-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  return home
}

test('the first host takes the lock and a second live host only reads', (t) => {
  const path = join(tempHome(t), 'state.lock')
  const first = homeLock(path, { pid: 101, isAlive: () => true })
  const second = homeLock(path, { pid: 202, isAlive: () => true })
  t.after(() => { first.release(); second.release() })
  assert.equal(first.claim(), undefined)
  assert.equal(first.owns(), true)
  assert.equal(second.claim().pid, 101)
  assert.equal(second.owns(), false)
  first.release()
  assert.equal(existsSync(path), false)
  assert.equal(second.claim(), undefined)
  assert.equal(second.owns(), true)
})

test('a lock whose same-host process has exited is taken over', (t) => {
  const path = join(tempHome(t), 'state.lock')
  writeFileSync(path, JSON.stringify({ pid: 101, host: hostname(), token: 'gone' }))
  const dead = homeLock(path, { pid: 202, isAlive: () => false })
  t.after(() => dead.release())
  assert.equal(dead.claim(), undefined)
  assert.equal(dead.owns(), true)
  dead.release()
})

test('an old same-host lock stays live while its process is alive', (t) => {
  const path = join(tempHome(t), 'state.lock')
  writeFileSync(path, JSON.stringify({ pid: 101, host: hostname(), token: 'old' }))
  const old = new Date(Date.now() - 120_000)
  utimesSync(path, old, old)
  const late = homeLock(path, { pid: 202, isAlive: () => true })
  t.after(() => late.release())
  assert.equal(late.claim().token, 'old')
  assert.equal(late.owns(), false)
})

test('an old lock from another host is taken over', (t) => {
  const path = join(tempHome(t), 'state.lock')
  writeFileSync(path, JSON.stringify({ pid: 101, host: 'elsewhere', token: 'far' }))
  const old = new Date(Date.now() - 120_000)
  utimesSync(path, old, old)
  const near = homeLock(path, { pid: 202, isAlive: () => false })
  t.after(() => near.release())
  assert.equal(near.claim(), undefined)
  assert.equal(near.owns(), true)
})

test('a stale-lock recheck does not delete a new owner token', (t) => {
  const path = join(tempHome(t), 'state.lock')
  writeFileSync(path, JSON.stringify({ pid: 101, host: hostname(), token: 'stale' }))
  const old = new Date(Date.now() - 120_000)
  utimesSync(path, old, old)
  const originalRead = fs.readFileSync
  let reads = 0
  fs.readFileSync = (file, ...args) => {
    const contents = originalRead(file, ...args)
    if (file === path && ++reads === 3) {
      writeFileSync(path, JSON.stringify({ pid: 303, host: hostname(), token: 'new-owner' }))
      return originalRead(file, ...args)
    }
    return contents
  }
  syncBuiltinESMExports()
  const late = homeLock(path, { pid: 202, isAlive: pid => pid === 303 })
  t.after(() => {
    late.release()
    fs.readFileSync = originalRead
    syncBuiltinESMExports()
  })
  assert.equal(late.claim().token, 'new-owner')
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).token, 'new-owner')
})

test('a holder that finds another token in the file knows it lost the lock', (t) => {
  const path = join(tempHome(t), 'state.lock')
  const lock = homeLock(path, { pid: 101 })
  t.after(() => lock.release())
  assert.equal(lock.claim(), undefined)
  writeFileSync(path, JSON.stringify({ pid: 303, host: hostname(), token: 'other' }))
  assert.equal(lock.owns(), false)
  lock.release()
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).token, 'other')
})

const TEAM = {
  version: 1,
  mainBotIds: ['m1'],
  revision: 7,
  bots: { m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief of Staff', lab: 'deepseek', instructions: '', createdAt: 1 } },
  rooms: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

function start(t, home) {
  const ctx = fakeContext()
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => {
    route = options
    return register(options)
  }
  // createRuntime + provideFlyBot is what apply() does, and it keeps the runtime so a
  // test can reach a save that no request drives (#1027).
  const rt = createRuntime(ctx, { home })
  provideFlyBot(ctx, rt.flybot)
  t.after(() => ctx.dispose())
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))).json()
  call.ctx = ctx
  call.rt = rt
  return call
}

test('while another dsh holds the team, the channel reads it, refuses changes, then takes over', async (t) => {
  const home = tempHome(t)
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  // The test runner's parent process: alive, on this host, and not this process.
  writeFileSync(join(home, 'state.lock'), JSON.stringify({ pid: process.ppid, host: hostname(), token: 'other' }))
  const call = start(t, home)

  const view = (await call('state', {})).value
  assert.deepEqual(view.bots.map(bot => bot.name), ['Chief'])
  assert.match(view.readOnly, new RegExp(`open in another dsh \\(Web or Desktop, pid ${process.ppid} on `))
  const refused = await call('set-prefs', { theme: 'dark' })
  assert.equal(refused.error.code, 'bot/read-only')
  assert.equal(JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).prefs, undefined)

  // The other host saves a change: the reading host follows the file.
  writeFileSync(join(home, 'state.json'), JSON.stringify({ ...TEAM, revision: 8, prefs: { theme: 'light' } }))
  const followed = (await call('state', {})).value
  assert.equal(followed.revision, 8)
  assert.equal(followed.prefs.theme, 'light')

  // The other host exits: the next request takes over and saves.
  rmSync(join(home, 'state.lock'))
  assert.equal((await call('set-prefs', { theme: 'dark' })).ok, true)
  const saved = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  assert.equal(saved.prefs.theme, 'dark')
  assert.equal(saved.revision, 9)
  assert.equal(JSON.parse(readFileSync(join(home, 'state.lock'), 'utf8')).pid, process.pid)
  assert.equal((await call('state', {})).value.readOnly, null)
})

test('a reading host follows the other host\'s keys, never writes them, and keeps them after taking over', async (t) => {
  const home = tempHome(t)
  const secretsPath = join(home, 'secrets.json')
  const key = (name, value) => ({ name, value, purpose: '', scope: 'all', requestedBy: null, createdAt: 1, updatedAt: 1 })
  const writeKeys = (keys, revision) => {
    writeFileSync(secretsPath, JSON.stringify({ version: 1, secrets: keys }))
    writeFileSync(join(home, 'state.json'), JSON.stringify({ ...TEAM, revision }))
  }
  writeKeys([key('FIRST_KEY', 'first-value-1')], 7)
  writeFileSync(join(home, 'state.lock'), JSON.stringify({ pid: process.ppid, host: hostname(), token: 'other' }))
  const call = start(t, home)
  const names = async () => (await call('state', {})).value.secrets.map(secret => secret.name)

  assert.deepEqual(await names(), ['FIRST_KEY'])
  assert.equal((await call('secret-set', { name: 'MINE', value: 'mine-value-1' })).error.code, 'bot/read-only')
  const asked = await call.ctx.registeredTools.get('request_secret').execute({ name: 'MINE', purpose: 'x' }, { agent: { id: 'm1' } })
  assert.match(asked, /^No card can be shown now\. The Bot team in .* is open in another dsh/)
  assert.deepEqual((await call('state', {})).value.secretRequests, {})

  // The other host saves a second key; this one follows instead of keeping its first copy.
  writeKeys([key('FIRST_KEY', 'first-value-1'), key('SECOND_KEY', 'second-value-2')], 8)
  assert.deepEqual(await names(), ['FIRST_KEY', 'SECOND_KEY'])

  // After taking over, a new key joins both instead of replacing the file with an old copy.
  writeKeys([key('FIRST_KEY', 'first-value-1'), key('SECOND_KEY', 'second-value-2'), key('THIRD_KEY', 'third-value-3')], 9)
  rmSync(join(home, 'state.lock'))
  assert.equal((await call('secret-set', { name: 'MINE', value: 'mine-value-1' })).ok, true)
  const saved = JSON.parse(readFileSync(secretsPath, 'utf8')).secrets.map(secret => secret.name).sort()
  assert.deepEqual(saved, ['FIRST_KEY', 'MINE', 'SECOND_KEY', 'THIRD_KEY'])
})

test('#1027: a save in a stale read-only window takes the lock and writes', async (t) => {
  const home = tempHome(t)
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  writeFileSync(join(home, 'state.lock'), JSON.stringify({ pid: process.ppid, host: hostname(), token: 'other' }))
  const call = start(t, home)
  assert.match((await call('state', {})).value.readOnly, /open in another dsh/)

  // The other host closes; this window has not read since.
  rmSync(join(home, 'state.lock'))

  // A save no request drives (a plugin, a scheduled task, a retitle) takes the free lock
  // and writes, instead of being dropped until some later state call refreshes.
  await call.rt.save()
  assert.equal(JSON.parse(readFileSync(join(home, 'state.lock'), 'utf8')).pid, process.pid)
  assert.equal(JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).revision, 8)
  assert.equal((await call('state', {})).value.readOnly, null)
})

test('#1032: a change made before save() lands; taking over does not replace it with what the other host left', async (t) => {
  const home = tempHome(t)
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  writeFileSync(join(home, 'state.lock'), JSON.stringify({ pid: process.ppid, host: hostname(), token: 'other' }))
  const call = start(t, home)
  assert.match((await call('state', {})).value.readOnly, /open in another dsh/)

  // The other host saves once more and closes while this window is read-only, and a writer
  // here changes state before its save — the shape every host path uses.
  writeFileSync(join(home, 'state.json'), JSON.stringify({ ...TEAM, revision: 8, prefs: { theme: 'light' } }))
  rmSync(join(home, 'state.lock'))
  call.rt.state.prefs.theme = 'dark'
  await call.rt.save()

  // This window writes what it has (revision 7 in memory, so 8 on disk); the change is not
  // replaced by the copy the other host left, and the revision it bumps is its own.
  const saved = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  assert.equal(saved.prefs.theme, 'dark')
  assert.equal(saved.revision, 8)
  assert.equal((await call('state', {})).value.readOnly, null)
})

test('#1032: mutate() adopts what the other host left before the change, so both survive', async (t) => {
  const home = tempHome(t)
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  writeFileSync(join(home, 'state.lock'), JSON.stringify({ pid: process.ppid, host: hostname(), token: 'other' }))
  const call = start(t, home)
  assert.match((await call('state', {})).value.readOnly, /open in another dsh/)

  writeFileSync(join(home, 'state.json'), JSON.stringify({ ...TEAM, revision: 8, prefs: { theme: 'light' } }))
  rmSync(join(home, 'state.lock'))
  // The write-path entry: take over and adopt first, then change, then write.
  await call.rt.mutate(() => { call.rt.state.prefs.locale = 'zh' })

  const saved = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  assert.equal(saved.prefs.theme, 'light')
  assert.equal(saved.prefs.locale, 'zh')
  assert.equal(saved.revision, 9)
  assert.equal((await call('state', {})).value.readOnly, null)
})

test('#1041: a save() that takes over the lock says so once, naming the host it took it from', async (t) => {
  const home = tempHome(t)
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  writeFileSync(join(home, 'state.lock'), JSON.stringify({ pid: process.ppid, host: hostname(), token: 'other' }))
  const call = start(t, home)
  // rt.warn reaches ctx.logger.warn at call time (src/host/diagnostics.js), so replacing it
  // after start() still catches every line the store prints.
  const said = []
  call.ctx.logger.warn = (format, line) => { said.push(format === '%s' ? line : `${format} ${line}`) }
  const takeovers = () => said.filter(line => /the other dsh has closed/.test(line))

  assert.match((await call('state', {})).value.readOnly, /open in another dsh/)
  assert.equal(takeovers().length, 0)

  // The other host closes and this window has not read since: a write no request drives
  // takes the free lock, and says so once with the host that let go.
  rmSync(join(home, 'state.lock'))
  await call.rt.save()
  assert.equal(takeovers().length, 1)
  assert.match(takeovers()[0], new RegExp(`was pid ${process.ppid} on ${hostname()}`))
  assert.equal(JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).revision, 8)

  // A window that already holds the lock writes without announcing a takeover.
  await call.rt.save()
  assert.equal(takeovers().length, 1)
})

test('read-only host (#14): FlyBot queries answer, plugin reads answer, writes and polling stop', async (t) => {
  const home = tempHome(t)
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  writeFileSync(join(home, 'state.lock'), JSON.stringify({ pid: process.ppid, host: hostname(), token: 'other' }))
  const call = start(t, home)
  await call('state', {})
  const fb = call.ctx.flybot.scope('social')
  let wrote = 0
  fb.api.handle('social/list', async () => ['x'], { read: true })
  fb.api.handle('social/change', async () => { wrote += 1; return true })
  assert.equal(fb.readOnly(), true)
  assert.equal((await call('flybot/bots', {})).ok, true)
  assert.equal((await call('flybot/approvals', {})).ok, true)
  assert.deepEqual((await call('flybot/social/list', {})).value, ['x'])
  assert.equal((await call('flybot/social/change', {})).error.code, 'bot/read-only')
  assert.equal((await call('flybot/decide', { id: 'x', decision: 'approve' })).error.code, 'bot/read-only')
  assert.equal(wrote, 0)
  fb.remote.publish([{ handle: '@a.b.home', name: 'A' }])
  assert.deepEqual(fb.remote.list(), [])
})
