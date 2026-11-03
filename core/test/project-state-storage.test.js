import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { install } from '../src/host/store.js'
import { createProjectEffects } from '../src/host/project-effects.js'

function fixture(t, saved) {
  const home = mkdtempSync(join(tmpdir(), 'flybot-sql-migration-')), statePath = join(home, 'state.json'), runtimes = []
  if (saved !== undefined) writeFileSync(statePath, typeof saved === 'string' ? saved : JSON.stringify(saved))
  async function start(mode) {
    const disposers = [], warnings = [], rt = { home, statePath, config: { ...(mode ? { stateStorage: mode } : {}) }, warn: (...args) => warnings.push(args), autoRoomName: () => 'Group', retitleRoom: async () => {},
      ctx: { effect(fn) { disposers.push(fn()) } },
    }
    install(rt)
    rt.projectEffects = createProjectEffects(rt)
    let closed = false
    const close = async () => { if (!closed) { closed = true; await rt.projectEffects.close(); for (const fn of disposers.reverse()) await fn?.() } }
    runtimes.push(close)
    await rt.load()
    return { rt, close, warnings }
  }
  t.after(async () => { for (const close of runtimes.reverse()) await close(); rmSync(home, { recursive: true, force: true }) })
  return { home, statePath, start, path: join(home, 'state.sqlite') }
}
const saved = () => ({ version: 2, revision: 7, members: { owner: { id: 'owner', designatedChiefId: 'chief' } }, mainBotIds: ['chief'], bots: { chief: { id: 'chief', ownerId: 'owner', sessionId: 'chief-session', name: 'Chief' } }, projects: { p: { id: 'p', ownerUserId: 'owner', status: 'active', roles: { members: [], maintainers: [] } } }, tasks: { task: { id: 'task', projectId: 'p', title: 'Retain current work', status: 'working', collaboration: { history: [{ id: 'offer', status: 'accepted' }], claim: { id: 'claim', generation: 7 } } } }, projectTaskSessions: { role: { logicalSessionId: 'role', bindings: [{ backendSessionId: 'sdk-thread' }] } }, projectEffects: {} })

test('Store migration preserves working identities, fences JSON writes and automatically reopens SQL authority', async t => {
  const f = fixture(t, saved()), first = await f.start('sqlite')
  assert.equal(first.rt.readOnly(), undefined)
  assert.equal(first.rt.stateStorage.status().backend, 'sqlite')
  const guardText = readFileSync(f.statePath, 'utf8'), guard = JSON.parse(guardText)
  assert.equal(guard.version, 3); assert.equal(guard.phase, 'active')
  assert.equal(createHash('sha256').update(readFileSync(join(f.home, guard.migration.backup))).digest('hex'), guard.migration.sha256)
  first.rt.state.tasks.task.status = 'blocked'
  await first.rt.save()
  assert.equal(readFileSync(f.statePath, 'utf8'), guardText)
  await first.close()
  const second = await f.start()
  assert.equal(second.rt.stateStorage.status().backend, 'sqlite')
  assert.equal(second.rt.state.tasks.task.status, 'blocked')
  assert.equal(second.rt.state.tasks.task.collaboration.claim.id, 'claim')
  assert.equal(second.rt.state.tasks.task.collaboration.history[0].id, 'offer')
  assert.equal(second.rt.state.bots.chief.sessionId, 'chief-session')
  assert.equal(second.rt.state.projectTaskSessions.role.bindings[0].backendSessionId, 'sdk-thread')
  await second.close()
  const forbidden = await f.start('json')
  assert.match(forbidden.rt.readOnly(), /SQLite.*authority|roll back/)
  assert.equal(readFileSync(f.statePath, 'utf8'), guardText)
})

test('malformed or invalid-identity JSON cannot migrate into an empty SQL replacement', async t => {
  for (const source of ['{broken', { ...saved(), bots: { chief: { id: 'chief', ownerId: 'unknown' } } }]) {
    const f = fixture(t, source), original = readFileSync(f.statePath, 'utf8'), current = await f.start('sqlite')
    assert.ok(current.rt.readOnly())
    assert.equal(existsSync(f.path), false)
    assert.equal(readFileSync(f.statePath, 'utf8'), original)
  }
})

test('prepared migration recovers exact backup; loss of an active database never imports stale state', async t => {
  const f = fixture(t, saved()), first = await f.start('sqlite')
  await first.close()
  const guard = JSON.parse(readFileSync(f.statePath, 'utf8'))
  for (const suffix of ['', '-wal', '-shm']) rmSync(f.path + suffix, { force: true })
  const missing = await f.start('sqlite')
  assert.match(missing.rt.readOnly(), /authoritative SQLite database is missing/)
  assert.equal(existsSync(f.path), false)
  await missing.close()
  writeFileSync(f.statePath, JSON.stringify({ ...guard, phase: 'prepared' }))
  const recovered = await f.start()
  assert.equal(recovered.rt.readOnly(), undefined)
  assert.equal(recovered.rt.state.tasks.task.collaboration.claim.id, 'claim')
  assert.equal(JSON.parse(readFileSync(f.statePath, 'utf8')).phase, 'active')
})

test('SQL state and Effect commit together, recover after restart and acknowledge only a committed transaction', async t => {
  const f = fixture(t, saved()), first = await f.start('sqlite'), { rt } = first
  let executions = 0
  rt.projectEffects.register('fixture.execute', { run: async () => ({ count: ++executions }) })
  const spec = { kind: 'fixture.execute', key: 'once', projectId: 'p', taskId: 'task', payload: { claimId: 'claim' } }
  const token = rt.projectEffects.stage(spec)
  rt.state.tasks.task.status = 'queued'
  const db = new DatabaseSync(f.path)
  db.exec("CREATE TRIGGER fail_effect BEFORE INSERT ON state_records WHEN NEW.namespace='projectEffects' BEGIN SELECT RAISE(ABORT,'fixture effect write failure'); END")
  await assert.rejects(rt.projectEffects.persist(token), /fixture effect write failure/)
  await rt.projectEffects.drain()
  assert.equal(executions, 0); assert.equal(rt.projectEffects.intentCommitted(token), false)
  assert.equal(JSON.parse(db.prepare("SELECT document FROM state_records WHERE namespace='tasks' AND id='task'").get().document).status, 'working')
  db.exec('DROP TRIGGER fail_effect'); db.close()
  await rt.projectEffects.persist(token)
  assert.equal(rt.projectEffects.intentCommitted(token), true)
  await first.close()
  const second = await f.start()
  second.rt.projectEffects.register('fixture.execute', { run: async () => ({ count: ++executions }) })
  second.rt.projectEffects.recover()
  await second.rt.projectEffects.drain()
  await second.rt.projectEffects.drain()
  assert.equal(executions, 1)
  assert.equal(second.rt.state.projectEffects[token.id].status, 'done')
  assert.equal(second.rt.state.tasks.task.status, 'queued')
})

test('readonly Store does not acknowledge Effects and refresh adopts current SQL state before takeover', async t => {
  const f = fixture(t, saved()), first = await f.start('sqlite')
  await first.close()
  writeFileSync(join(f.home, 'state.lock'), JSON.stringify({ pid: process.ppid, host: hostname(), token: 'external-holder' }))
  const second = await f.start()
  assert.match(second.rt.readOnly(), /another dsh/)
  second.rt.projectEffects.register('fixture.readonly', { run: async () => { throw new Error('Must not execute') } })
  // stage itself is denied on read-only hosts; a no-op save cannot grant durability.
  assert.throws(() => second.rt.projectEffects.stage({ kind: 'fixture.readonly', key: 'denied', projectId: 'p', payload: {} }), /writable/)
  const before = second.rt.state.revision
  await second.rt.save()
  assert.equal(second.rt.state.revision, before)
  rmSync(join(f.home, 'state.lock'))
  await second.rt.refresh()
  assert.equal(second.rt.readOnly(), undefined)
  second.rt.state.tasks.task.status = 'blocked'
  await second.rt.save()
  assert.equal(second.rt.stateStorage.status().backend, 'sqlite')
})

test('offline export and rollback retain latest facts and reopen JSON without two writable authorities', async t => {
  const { exportSqliteState, rollbackSqliteState } = await import('../src/host/project-state-migration.js')
  const f = fixture(t, saved()), first = await f.start('sqlite')
  first.rt.state.tasks.task.status = 'blocked'
  await first.rt.save()
  const guard = JSON.parse(readFileSync(f.statePath, 'utf8')), output = join(f.home, 'private-export.json')
  assert.throws(() => exportSqliteState({ home: f.home, output, expectedMigrationId: guard.migration.id }), /Stop the current/)
  await first.close()
  const exported = exportSqliteState({ home: f.home, output, expectedMigrationId: guard.migration.id })
  assert.equal(JSON.parse(readFileSync(output, 'utf8')).tasks.task.status, 'blocked')
  assert.equal(exported.sha256, createHash('sha256').update(readFileSync(output)).digest('hex'))
  assert.throws(() => rollbackSqliteState({ home: f.home, expectedMigrationId: 'outdated' }), /ID changed/)
  const result = rollbackSqliteState({ home: f.home, expectedMigrationId: guard.migration.id })
  assert.equal(result.backend, 'json'); assert.equal(existsSync(f.path), false)
  assert.equal(existsSync(join(f.home, result.archiveFile)), true)
  assert.equal(rollbackSqliteState({ home: f.home, expectedMigrationId: guard.migration.id, resume: true }).already, true)
  const second = await f.start()
  assert.equal(second.rt.readOnly(), undefined)
  assert.equal(second.rt.stateStorage.status().backend, 'json')
  assert.equal(second.rt.state.tasks.task.status, 'blocked')
  assert.equal(second.rt.state.tasks.task.collaboration.claim.id, 'claim')
})

test('prepared rollback blocks runtime and resumes after its database move without reviving import state', async t => {
  const { renameSync } = await import('node:fs'), { randomUUID } = await import('node:crypto')
  const { rollbackSqliteState } = await import('../src/host/project-state-migration.js')
  const { openSqliteState } = await import('../src/host/project-state-sqlite.js')
  const f = fixture(t, saved()), first = await f.start('sqlite')
  first.rt.state.tasks.task.status = 'blocked'; await first.rt.save(); await first.close()
  const guard = JSON.parse(readFileSync(f.statePath, 'utf8')), db = openSqliteState({ path: f.path, readOnly: true })
  const text = JSON.stringify(db.read(), null, 2), revision = db.metadata().revision, id = randomUUID(); db.close()
  const marker = { version: 'flybot-storage-rollback/v1', phase: 'prepared', id, migrationId: guard.migration.id, revision, exportFile: `state.rollback-${id}.json`, archiveFile: `state.sqlite.rollback-${id}`, sha256: createHash('sha256').update(text).digest('hex') }
  writeFileSync(join(f.home, marker.exportFile), text)
  writeFileSync(join(f.home, 'state-storage-rollback.json'), JSON.stringify(marker))
  renameSync(f.path, join(f.home, marker.archiveFile))
  const blocked = await f.start()
  assert.match(blocked.rt.readOnly(), /rollback is pending/)
  await blocked.close()
  assert.throws(() => rollbackSqliteState({ home: f.home, expectedMigrationId: guard.migration.id }), /explicitly resume/)
  rollbackSqliteState({ home: f.home, expectedMigrationId: guard.migration.id, resume: true })
  const recovered = await f.start()
  assert.equal(recovered.rt.readOnly(), undefined)
  assert.equal(recovered.rt.stateStorage.status().backend, 'json')
  assert.equal(recovered.rt.state.tasks.task.status, 'blocked')
})

test('migration CLI exposes only metadata and requires explicit paths and source identity', async t => {
  const { execFileSync } = await import('node:child_process')
  const f = fixture(t, saved()), first = await f.start('sqlite'); await first.close()
  const script = new URL('../scripts/state-storage.mjs', import.meta.url).pathname
  const inspect = JSON.parse(execFileSync(process.execPath, [script, 'inspect', '--home', f.home], { encoding: 'utf8' }))
  assert.equal(inspect.backend, 'sqlite'); assert.equal(inspect.phase, 'active')
  assert.equal(JSON.stringify(inspect).includes('chief-session'), false)
  const output = join(f.home, 'cli-export.json')
  const exported = JSON.parse(execFileSync(process.execPath, [script, 'export', '--home', f.home, '--migration', inspect.migrationId, '--output', output], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))
  assert.equal(exported.output, output)
  assert.equal(JSON.parse(readFileSync(output, 'utf8')).tasks.task.id, 'task')
  assert.throws(() => execFileSync(process.execPath, [script, 'export', '--home', f.home, '--output', output], { stdio: 'pipe' }))
  assert.throws(() => execFileSync(process.execPath, [script, 'inspect', '--home', f.home, '--unexpected'], { stdio: 'pipe' }))
})

test('stale readonly takeover cannot overwrite newer SQL state without refresh', async t => {
  const { openSqliteState } = await import('../src/host/project-state-sqlite.js')
  const f = fixture(t, saved()), first = await f.start('sqlite'); await first.close()
  writeFileSync(join(f.home, 'state.lock'), JSON.stringify({ pid: process.ppid, host: hostname(), token: 'external-holder' }))
  const observer = await f.start()
  const writer = openSqliteState({ path: f.path }), current = writer.read()
  current.tasks.task.status = 'blocked'; writer.write(current); writer.close()
  rmSync(join(f.home, 'state.lock'))
  observer.rt.state.tasks.task.status = 'accepted'
  await assert.rejects(observer.rt.save(), /revision conflict/)
  await observer.close()
  const recovered = await f.start()
  assert.equal(recovered.rt.state.tasks.task.status, 'blocked')
})
