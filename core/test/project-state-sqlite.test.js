import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { openSqliteState } from '../src/host/project-state-sqlite.js'

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'flybot-sql-state-'))
  const options = { path: join(home, 'state.sqlite'), payloadRoot: join(home, 'state-payloads') }
  const connections = []
  t.after(() => { for (const db of connections.reverse()) db.close(); rmSync(home, { recursive: true, force: true }) })
  const open = more => { const db = openSqliteState({ ...options, ...more }); connections.push(db); return db }
  return { home, options, open }
}
const initial = () => ({ version: 2, revision: 1, members: { owner: { id: 'owner' } }, tasks: { task: { id: 'task', status: 'working', collaboration: { history: [{ id: 'offer-1' }] } } }, projectEffects: { effect: { id: 'effect', status: 'pending' } } })

test('SQLite roundtrips identities, normalizes history and commits only changed rows', t => {
  const f = fixture(t), state = initial(), db = f.open({ initial: state })
  assert.deepEqual(db.read(), state)
  assert.equal(db.metadata().journalMode, 'wal')
  assert.equal(db.metadata().synchronous, 2)
  const reader = new DatabaseSync(f.options.path, { readOnly: true })
  t.after(() => reader.close())
  assert.equal(reader.prepare('SELECT count(*) AS n FROM state_history').get().n, 1)
  assert.equal(JSON.parse(reader.prepare("SELECT document FROM state_records WHERE namespace='tasks' AND id='task'").get().document).collaboration.history.length, 0)
  assert.equal(db.write(state).changed, 0)
  state.tasks.task.collaboration.history.push({ id: 'offer-2' })
  state.projectEffects.effect.status = 'done'
  const before = db.changes({ limit: 100 }).next
  const result = db.write(state)
  assert.equal(result.changed, 2)
  assert.deepEqual(db.read(), state)
  assert.deepEqual(db.changes({ after: before }).items.map(({ namespace, id, operation }) => ({ namespace, id, operation })), [{ namespace: 'projectEffects', id: 'effect', operation: 'upsert' }, { namespace: 'tasks', id: 'task', operation: 'upsert' }])
})

test('an interrupted SQL transaction commits neither Task nor Effect and can retry', t => {
  const f = fixture(t), state = initial(), db = f.open({ initial: state })
  const control = new DatabaseSync(f.options.path)
  t.after(() => control.close())
  control.exec("CREATE TRIGGER fail_effect BEFORE UPDATE ON state_records WHEN NEW.namespace='projectEffects' BEGIN SELECT RAISE(ABORT,'fixture transaction failure'); END")
  state.tasks.task.status = 'accepted'; state.projectEffects.effect.status = 'done'
  assert.throws(() => db.write(state), /fixture transaction failure/)
  assert.deepEqual(f.open({ readOnly: true }).read(), initial())
  control.exec('DROP TRIGGER fail_effect')
  db.write(state)
  assert.deepEqual(f.open({ readOnly: true }).read(), state)
})

test('stale database revisions cannot overwrite a different writer; readonly connections never commit', t => {
  const f = fixture(t), state = initial(), first = f.open({ initial: state }), stale = f.open({})
  stale.read()
  state.tasks.task.status = 'blocked'; first.write(state)
  assert.throws(() => stale.write(initial()), /revision conflict/)
  const observer = f.open({ readOnly: true })
  assert.equal(observer.read().tasks.task.status, 'blocked')
  assert.throws(() => observer.write(initial()), /read.only/i)
  assert.equal(observer.stamp(), first.stamp())
})

test('large records use immutable hashed files and fail closed on content damage', t => {
  const f = fixture(t), state = initial()
  state.tasks.large = { id: 'large', payload: 'bounded data '.repeat(10000) }
  const db = f.open({ initial: state }), inspector = new DatabaseSync(f.options.path, { readOnly: true })
  t.after(() => inspector.close())
  const row = inspector.prepare("SELECT storage,document,digest FROM state_records WHERE namespace='tasks' AND id='large'").get()
  assert.equal(row.storage, 'file'); assert.equal(row.document, null)
  assert.deepEqual(JSON.parse(readFileSync(join(f.options.payloadRoot, row.digest + '.json'), 'utf8')), state.tasks.large)
  assert.deepEqual(db.read(), state)
  writeFileSync(join(f.options.payloadRoot, row.digest + '.json'), 'corrupt payload')
  assert.throws(() => db.read(), /hash changed/)
})

test('future or foreign SQLite schemas refuse to initialize and preserve existing tables', t => {
  const f = fixture(t), raw = new DatabaseSync(f.options.path)
  raw.exec('CREATE TABLE unrelated(value TEXT); INSERT INTO unrelated VALUES (\'preserve\'); PRAGMA user_version=999')
  raw.close()
  assert.throws(() => f.open({ initial: initial() }), /schema|version/i)
  const check = new DatabaseSync(f.options.path, { readOnly: true })
  assert.equal(check.prepare('SELECT value FROM unrelated').get().value, 'preserve'); check.close()
})

test('actual process death before and after COMMIT preserves the correct atomic Task/Effect boundary', async t => {
  const { spawn } = await import('node:child_process'), { once } = await import('node:events')
  for (const committed of [false, true]) {
    const f = fixture(t), seed = f.open({ initial: initial() })
    seed.close()
    const source = `import { DatabaseSync } from 'node:sqlite';
      import { writeSync } from 'node:fs';
      import { openSqliteState } from ${JSON.stringify(new URL('../src/host/project-state-sqlite.js', import.meta.url).href)};
      const options=JSON.parse(process.argv[1]);
      if(${committed}){const db=openSqliteState(options);const state=db.read();state.tasks.task.status='accepted';state.projectEffects.effect.status='done';db.write(state)}
      else{const db=new DatabaseSync(options.path);db.exec("BEGIN IMMEDIATE;UPDATE state_records SET document='{}' WHERE namespace IN ('tasks','projectEffects')")}
      writeSync(1,'boundary-ready\\n');setInterval(()=>{},1000);`
    const child = spawn(process.execPath, ['--input-type=module', '-e', source, JSON.stringify(f.options)], { stdio: ['ignore', 'pipe', 'pipe'] })
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') })
    const closed = once(child, 'close')
    let output = ''
    while (!output.includes('boundary-ready')) {
      const [chunk] = await once(child.stdout, 'data', { signal: AbortSignal.timeout(10000) })
      output += chunk.toString()
    }
    child.kill('SIGKILL')
    const [, signal] = await closed
    assert.equal(signal, 'SIGKILL')
    const state = f.open({ readOnly: true }).read()
    assert.equal(state.tasks.task.status, committed ? 'accepted' : 'working')
    assert.equal(state.projectEffects.effect.status, committed ? 'done' : 'pending')
  }
})


test('database symlinks, prototype-shaped keys and bounded change cursors respect storage boundaries', t => {
  const f = fixture(t), state = initial()
  Object.defineProperty(state.tasks, '__proto__', { value: { id: '__proto__', history: [{ id: 'owned-history' }] }, enumerable: true })
  const db = f.open({ initial: state }), copy = db.read()
  assert.equal(Object.hasOwn(copy.tasks, '__proto__'), true)
  assert.equal(copy.tasks.__proto__.history[0].id, 'owned-history')
  assert.equal(Object.getPrototypeOf(copy.tasks), Object.prototype)
  assert.equal(statSync(f.options.path).mode & 0o777, 0o600)
  for (const options of [{ limit: 0 }, { limit: 101 }, { after: -1 }, { after: '0' }]) assert.throws(() => db.changes(options))
  const first = db.changes({ limit: 1 }), second = db.changes({ after: first.next, limit: 1 })
  assert.equal(first.items.length, 1); assert.equal(second.items.length, 1)
  assert.ok(second.next > first.next)
  db.close()
  const linked = join(f.home, 'linked.sqlite')
  symlinkSync(f.options.path, linked)
  assert.throws(() => openSqliteState({ path: linked }), /regular file/)
})
