// Same runtime records, transactional durable authority. No model, dispatcher or
// second queue lives here. History rows and immutable payloads bound SQL records.
import { createRequire } from 'node:module'
import { createHash, randomUUID } from 'node:crypto'
import { constants, chmodSync, closeSync, existsSync, fsyncSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const require = createRequire(import.meta.url)
const APPLICATION_ID = 0x464c5942, SCHEMA = 1, FILE_THRESHOLD = 65536, MAX_PAYLOAD = 16 * 1024 * 1024
const historyNames = new Set(['history', 'waitHistory', 'requirementsHistory', 'results', 'roleSessionHistory', 'resumptions', 'versions'])
const hash = value => createHash('sha256').update(value).digest('hex')
const fail = message => Object.assign(new Error(message), { code: 'bot/state-sqlite' })
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const put = (object, key, value) => Object.defineProperty(object, key, { value, enumerable: true, writable: true, configurable: true })

export function requireSqliteRuntime() {
  const [major, minor] = process.versions.node.split('.').map(Number)
  if (major < 22 || major === 22 && minor < 18) throw fail('SQLite state requires Node.js22.18 or newer; JSON storage has not been migrated')
  return require('node:sqlite').DatabaseSync
}

function normalize(value) {
  const histories = []
  function visit(row, path) {
    if (Array.isArray(row) && historyNames.has(path.at(-1))) {
      row.forEach((item, position) => histories.push({ path: JSON.stringify(path), position, text: JSON.stringify(item) }))
      return []
    }
    if (Array.isArray(row)) return row.map((item, index) => visit(item, [...path, index]))
    if (!record(row)) return row
    const result = {}
    for (const [key, item] of Object.entries(row)) put(result, key, visit(item, [...path, key]))
    return result
  }
  return { document: JSON.stringify(visit(value, [])), fingerprint: hash(JSON.stringify(value)), histories }
}

function snapshotRecords(snapshot) {
  const records = [], roots = {}
  for (const [key, value] of Object.entries(snapshot)) {
    if (key === '$root') throw fail('Reserved state namespace')
    put(roots, key, record(value) ? 'map' : 'value')
    if (record(value)) for (const [id, row] of Object.entries(value)) records.push({ namespace: key, id, ...normalize(row) })
    else records.push({ namespace: '$root', id: key, ...normalize(value) })
  }
  return { roots: JSON.stringify(roots), records }
}

export function openSqliteState({ path, payloadRoot = join(dirname(path), 'state-payloads'), readOnly = false, initial, migration = null }) {
  path = resolve(path); payloadRoot = resolve(payloadRoot)
  let info
  try { info = lstatSync(path) } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (info && (!info.isFile() || info.isSymbolicLink())) throw fail('SQLite state must be a registered regular file')
  if (!readOnly) mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const DatabaseSync = requireSqliteRuntime()
  if (!readOnly && !info) { const fd = openSync(path, 'wx', 0o600); closeSync(fd) }
  const db = new DatabaseSync(path, { readOnly, timeout: 5000, enableForeignKeyConstraints: true, enableDoubleQuotedStringLiterals: false, allowExtension: false })
  let closed = false, expectedRevision = null
  const scalar = sql => Object.values(db.prepare(sql).get())[0]
  const rollback = () => { try { db.exec('ROLLBACK') } catch { /* No transaction remains after certain SQLite failures. */ } }
  const meta = key => db.prepare('SELECT value FROM state_meta WHERE key=?').get(key)?.value
  const setMeta = (key, value) => db.prepare('INSERT INTO state_meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value))
  function ensurePayloadRoot(create = false) {
    if (!existsSync(payloadRoot) && !create) throw fail('State payload directory is missing')
    if (!existsSync(payloadRoot)) mkdirSync(payloadRoot, { recursive: true, mode: 0o700 })
    if (!lstatSync(payloadRoot).isDirectory() || lstatSync(payloadRoot).isSymbolicLink() || realpathSync(payloadRoot) !== payloadRoot) throw fail('State payload directory binding changed')
  }
  function readPayload(row) {
    let text = row.document
    if (row.storage === 'file') {
      if (!/^[a-f0-9]{64}$/.test(row.digest)) throw fail('Invalid state payload reference')
      ensurePayloadRoot()
      const file = join(payloadRoot, row.digest + '.json'), info = lstatSync(file)
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_PAYLOAD) throw fail('Invalid bounded state payload file')
      const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      try {
        const current = fstatSync(fd)
        if (current.ino !== info.ino || current.dev !== info.dev) throw fail('State payload changed during read')
        const buffer = Buffer.alloc(MAX_PAYLOAD + 1), size = readSync(fd, buffer, 0, buffer.length, 0)
        if (size > MAX_PAYLOAD) throw fail('State payload exceeds its read budget')
        text = buffer.subarray(0, size).toString('utf8')
      } finally { closeSync(fd) }
    } else if (row.storage !== 'inline' || typeof text !== 'string') throw fail('Invalid state payload storage')
    if (Buffer.byteLength(text) > MAX_PAYLOAD || hash(text) !== row.digest) throw Object.assign(fail('State payload content hash changed'), { stateIssue: { kind: 'payload-hash', namespace: row.namespace ?? null, id: row.id ?? null, path: row.path ?? null, position: row.position ?? null, storage: row.storage, expectedSha256: row.digest, actualSha256: hash(text) } })
    try { return JSON.parse(text) } catch { throw Object.assign(fail('State payload JSON is malformed'), { stateIssue: { kind: 'payload-json', namespace: row.namespace ?? null, id: row.id ?? null, storage: row.storage, expectedSha256: row.digest } }) }
  }
  function payload(text) {
    const digest = hash(text), size = Buffer.byteLength(text)
    if (size > MAX_PAYLOAD) throw fail('State record exceeds bounded payload size; retain a file reference instead')
    if (size <= FILE_THRESHOLD) return { storage: 'inline', document: text, digest }
    ensurePayloadRoot(true)
    const file = join(payloadRoot, digest + '.json')
    if (!existsSync(file)) {
      const temp = join(payloadRoot, `.${randomUUID()}.tmp`), fd = openSync(temp, 'wx', 0o600)
      try { writeFileSync(fd, text, 'utf8'); fsyncSync(fd) } finally { closeSync(fd) }
      try { linkSync(temp, file) } catch (error) { if (error.code !== 'EEXIST') throw error }
      finally { unlinkSync(temp) }
      const directory = openSync(payloadRoot, 'r')
      try { fsyncSync(directory) } finally { closeSync(directory) }
    }
    readPayload({ storage: 'file', document: null, digest })
    return { storage: 'file', document: null, digest }
  }
  function write(snapshot, { initializing = false } = {}) {
    if (closed || readOnly) throw fail('SQLite state is closed or read-only')
    if (!record(snapshot) || snapshot.version !== 2) throw fail('SQLite needs a validated version-2 state')
    const prepared = snapshotRecords(snapshot)
    if (!initializing) db.exec('BEGIN IMMEDIATE')
    try {
      const revision = Number(meta('revision') ?? 0)
      if (revision !== expectedRevision) throw fail('SQLite state revision conflict; reload before changing facts')
      const previous = new Map(db.prepare('SELECT namespace,id,fingerprint FROM state_records').all().map(row => [JSON.stringify([row.namespace, row.id]), row]))
      const changes = []
      const upsert = db.prepare('INSERT INTO state_records(namespace,id,document,storage,digest,fingerprint) VALUES (?,?,?,?,?,?) ON CONFLICT(namespace,id) DO UPDATE SET document=excluded.document,storage=excluded.storage,digest=excluded.digest,fingerprint=excluded.fingerprint')
      const historyUpsert = db.prepare('INSERT INTO state_history(namespace,id,path,position,document,storage,digest) VALUES (?,?,?,?,?,?,?) ON CONFLICT(namespace,id,path,position) DO UPDATE SET document=excluded.document,storage=excluded.storage,digest=excluded.digest')
      for (const row of prepared.records) {
        const key = JSON.stringify([row.namespace, row.id]), prior = previous.get(key)
        previous.delete(key)
        if (prior?.fingerprint === row.fingerprint) continue
        const data = payload(row.document)
        upsert.run(row.namespace, row.id, data.document, data.storage, data.digest, row.fingerprint)
        const oldHistory = new Map(db.prepare('SELECT path,position,digest FROM state_history WHERE namespace=? AND id=?').all(row.namespace, row.id).map(item => [JSON.stringify([item.path, item.position]), item]))
        for (const entry of row.histories) {
          const key = JSON.stringify([entry.path, entry.position]), old = oldHistory.get(key), digest = hash(entry.text)
          oldHistory.delete(key)
          if (old?.digest === digest) continue
          const data = payload(entry.text)
          historyUpsert.run(row.namespace, row.id, entry.path, entry.position, data.document, data.storage, data.digest)
        }
        for (const item of oldHistory.values()) db.prepare('DELETE FROM state_history WHERE namespace=? AND id=? AND path=? AND position=?').run(row.namespace, row.id, item.path, item.position)
        changes.push({ namespace: row.namespace, id: row.id, operation: 'upsert' })
      }
      for (const row of previous.values()) {
        db.prepare('DELETE FROM state_records WHERE namespace=? AND id=?').run(row.namespace, row.id)
        changes.push({ namespace: row.namespace, id: row.id, operation: 'delete' })
      }
      const rootsChanged = meta('roots') !== prepared.roots
      const next = revision + (changes.length || rootsChanged ? 1 : 0)
      if (rootsChanged) setMeta('roots', prepared.roots)
      if (next !== revision) {
        setMeta('revision', next)
        for (const row of changes.sort((a, b) => a.namespace.localeCompare(b.namespace) || a.id.localeCompare(b.id))) db.prepare('INSERT INTO state_changes(revision,namespace,id,operation) VALUES (?,?,?,?)').run(next, row.namespace, row.id, row.operation)
      }
      const lastSequence = Number(scalar('SELECT COALESCE(MAX(sequence),0) FROM state_changes'))
      if (!initializing) db.exec('COMMIT')
      // No fallible IO between COMMIT and the Store's Effects acknowledgement.
      expectedRevision = next
      return { revision: next, changed: changes.length, lastSequence }
    } catch (error) { if (!initializing) rollback(); throw error }
  }
  try {
    const schema = Number(scalar('PRAGMA user_version')), app = Number(scalar('PRAGMA application_id'))
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()
    const fresh = schema === 0 && app === 0 && tables.length === 0
    if (!fresh && (schema !== SCHEMA || app !== APPLICATION_ID)) throw fail('Unsupported or foreign SQLite state schema/version')
    if (fresh && (readOnly || initial === undefined)) throw fail('SQLite initialization needs validated initial state')
    if (!readOnly) {
      chmodSync(path, 0o600)
      db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000')
      if (scalar('PRAGMA journal_mode') !== 'wal' || Number(scalar('PRAGMA synchronous')) !== 2 || Number(scalar('PRAGMA foreign_keys')) !== 1) throw fail('Required SQLite durability configuration was not applied')
    }
    if (fresh) {
      db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE state_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT;
        CREATE TABLE state_records(namespace TEXT NOT NULL,id TEXT NOT NULL,document TEXT,storage TEXT NOT NULL CHECK(storage IN ('inline','file')),digest TEXT NOT NULL,fingerprint TEXT NOT NULL,PRIMARY KEY(namespace,id)) STRICT;
        CREATE TABLE state_history(namespace TEXT NOT NULL,id TEXT NOT NULL,path TEXT NOT NULL,position INTEGER NOT NULL,document TEXT,storage TEXT NOT NULL CHECK(storage IN ('inline','file')),digest TEXT NOT NULL,PRIMARY KEY(namespace,id,path,position),FOREIGN KEY(namespace,id) REFERENCES state_records(namespace,id) ON DELETE CASCADE) STRICT;
        CREATE TABLE state_changes(sequence INTEGER PRIMARY KEY AUTOINCREMENT,revision INTEGER NOT NULL,namespace TEXT NOT NULL,id TEXT NOT NULL,operation TEXT NOT NULL CHECK(operation IN ('upsert','delete')),UNIQUE(revision,namespace,id)) STRICT;
        PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=${SCHEMA};`)
      expectedRevision = 0
      setMeta('migration', JSON.stringify(migration))
      write(initial, { initializing: true })
      db.exec('COMMIT')
    } else expectedRevision = Number(meta('revision'))
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw fail('SQLite state revision is malformed')
  } catch (error) { rollback(); db.close(); throw error }
  function read() {
    if (closed) throw fail('SQLite state is closed')
    db.exec('BEGIN')
    try {
      const revision = Number(meta('revision'))
      if (!Number.isSafeInteger(revision) || revision < 1) throw fail('SQLite state revision is malformed')
      const roots = JSON.parse(meta('roots')), state = {}, values = new Map()
      for (const [key, kind] of Object.entries(roots)) {
        if (!['map', 'value'].includes(kind)) throw fail('SQLite state root descriptor changed')
        if (kind === 'map') put(state, key, {})
      }
      for (const row of db.prepare('SELECT * FROM state_records ORDER BY namespace,id').all()) {
        const value = readPayload(row)
        values.set(JSON.stringify([row.namespace, row.id]), value)
        if (row.namespace === '$root') {
          if (roots[row.id] !== 'value') throw fail('SQLite value root scope changed')
          put(state, row.id, value)
        } else {
          if (!Object.hasOwn(state, row.namespace) || roots[row.namespace] !== 'map') throw fail('SQLite record root scope changed')
          put(state[row.namespace], row.id, value)
        }
      }
      for (const row of db.prepare('SELECT * FROM state_history ORDER BY namespace,id,path,position').all()) {
        let target = values.get(JSON.stringify([row.namespace, row.id]))
        const path = JSON.parse(row.path)
        if (!Array.isArray(path) || !path.length) throw fail('SQLite history path changed')
        for (const key of path) {
          if (target === null || typeof target !== 'object' || !Object.hasOwn(target, key)) throw fail('SQLite history owner changed')
          target = target[key]
        }
        if (!Array.isArray(target) || target.length !== row.position) throw fail('SQLite history sequence is malformed')
        target.push(readPayload(row))
      }
      for (const row of db.prepare('SELECT namespace,id,fingerprint FROM state_records').all()) {
        const actual = hash(JSON.stringify(values.get(JSON.stringify([row.namespace, row.id]))))
        if (actual !== row.fingerprint) throw Object.assign(fail('SQLite record/history fingerprint changed'), { stateIssue: { kind: 'record-fingerprint', namespace: row.namespace, id: row.id, expectedSha256: row.fingerprint, actualSha256: actual } })
      }
      db.exec('COMMIT'); expectedRevision = revision
      return state
    } catch (error) { rollback(); throw error }
  }
  return { read, write, verify() { read(); return { revision: expectedRevision } }, stamp: () => String(meta('revision')),
    metadata: () => ({ schema: SCHEMA, revision: Number(meta('revision')), migration: JSON.parse(meta('migration')), journalMode: scalar('PRAGMA journal_mode'), synchronous: Number(scalar('PRAGMA synchronous')) }),
    changes({ after = 0, limit = 50 } = {}) {
      if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw fail('Invalid SQLite change cursor or limit')
      const items = db.prepare('SELECT sequence,revision,namespace,id,operation FROM state_changes WHERE sequence>? ORDER BY sequence LIMIT ?').all(after, limit)
      return { items: items.map(row => ({ ...row })), next: items.at(-1)?.sequence ?? after }
    },
    close() { if (!closed) { closed = true; db.close() } },
  }
}
