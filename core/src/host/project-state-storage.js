// Migration bridge for the original Store. state.json becomes a newer-version
// guard, not a second writable mirror; its validated import is retained separately.
import { createHash, randomUUID } from 'node:crypto'
import { constants, closeSync, existsSync, fsyncSync, lstatSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { encodeProjectState, decodeProjectState } from './project-state-format.js'
import { openSqliteState, requireSqliteRuntime } from './project-state-sqlite.js'

const digest = value => createHash('sha256').update(value).digest('hex')
const fail = message => Object.assign(new Error(message), { code: 'bot/state-storage' })
export function writeDurableStateFile(path, text, { exclusive = false } = {}) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temp = `${path}.${randomUUID()}.tmp`, fd = openSync(temp, 'wx', 0o600)
  try { writeFileSync(fd, text, 'utf8'); fsyncSync(fd) } finally { closeSync(fd) }
  try {
    if (exclusive) {
      try { linkSync(temp, path) }
      catch (error) {
        if (error.code !== 'EEXIST') throw error
        const info = lstatSync(path)
        if (!info.isFile() || info.isSymbolicLink() || readFileSync(path, 'utf8') !== text) throw fail('Existing migration backup content changed')
      }
    } else renameSync(temp, path)
  } finally { if (existsSync(temp)) unlinkSync(temp) }
  const directory = openSync(dirname(path), 'r')
  try { fsyncSync(directory) } finally { closeSync(directory) }
}

export function createProjectStateStorage({ home, statePath = join(home, 'state.json'), mode, validate, ensureWriter }) {
  if (mode !== undefined && !['json', 'sqlite'].includes(mode)) throw fail('stateStorage must be json or sqlite')
  const path = join(home, 'state.sqlite')
  let connection, connectionReadOnly, guard, selected = mode === 'sqlite', knownRevision = null
  function checkRollback() {
    const marker = join(home, 'state-storage-rollback.json')
    if (existsSync(marker) && JSON.parse(readFileSync(marker, 'utf8')).phase === 'prepared') throw fail('Storage rollback is pending; resume the offline migration tool before starting FlyBot')
  }
  function readGuard() {
    if (!existsSync(statePath)) return null
    const info = lstatSync(statePath)
    if ((selected || existsSync(path)) && (!info.isFile() || info.isSymbolicLink())) throw fail('State migration source must be a regular file')
    let parsed
    try { parsed = JSON.parse(readFileSync(statePath, 'utf8')) }
    catch (error) { if (selected || existsSync(path)) throw fail(`Cannot migrate malformed JSON state: ${error.message}`); return null }
    if (parsed?.storage !== 'sqlite') return null
    if (!info.isFile() || info.isSymbolicLink()) throw fail('State migration source must be a regular file')
    const proof = parsed.migration
    if (!['prepared', 'active'].includes(parsed.phase)) throw fail('SQLite migration phase is malformed')
    if (parsed.version !== 3 || !proof || typeof proof.id !== 'string' || !/^[a-f0-9]{64}$/.test(proof.sha256 ?? '') || proof.backup !== `state.sqlite-import-${proof.sha256}.json`) throw fail('SQLite migration guard is malformed')
    return parsed
  }
  function importState(proof) {
    const file = join(home, proof.backup), info = lstatSync(file)
    if (!info.isFile() || info.isSymbolicLink() || info.size > 128 * 1024 * 1024) throw fail('SQLite import backup is not a bounded regular file')
    const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    let text
    try { text = readFileSync(fd, 'utf8') } finally { closeSync(fd) }
    if (digest(text) !== proof.sha256) throw fail('SQLite import backup hash changed')
    const state = decodeProjectState(JSON.parse(text))
    validate(state)
    return state
  }
  function open(writer, initial) {
    if (connection && connectionReadOnly === !writer) return connection
    connection?.close(); connection = undefined
    const candidate = openSqliteState({ path, readOnly: !writer, ...(initial ? { initial } : {}), migration: guard.migration })
    const migration = candidate.metadata().migration
    if (migration?.id !== guard.migration.id || migration?.sha256 !== guard.migration.sha256) {
      candidate.close(); throw fail('SQLite database and migration guard identify different authorities')
    }
    connection = candidate; connectionReadOnly = !writer
    return candidate
  }
  function activate() {
    if (guard.phase === 'active') return
    ensureWriter()
    guard = { ...guard, phase: 'active' }
    writeDurableStateFile(statePath, JSON.stringify(guard, null, 2))
  }
  function assertGuard() {
    const current = readGuard()
    if (!current || current.phase !== 'active' || current.migration.id !== guard?.migration.id || current.migration.sha256 !== guard.migration.sha256) throw fail('SQLite storage authority changed; reload before writing')
  }
  return {
    get sqlite() { return selected },
    async read({ writer, readLegacy }) {
      checkRollback()
      const current = readGuard()
      if (!current && !existsSync(path)) return { state: await readLegacy(), sqlite: false }
      selected = true
      if (mode === 'json') throw fail('SQLite is the current authority; export and roll back explicitly before selecting JSON')
      if (!current) throw fail('SQLite state is missing its migration guard; refusing a second JSON authority')
      guard = current
      const initial = importState(guard.migration)
      if (!existsSync(path) && guard.phase === 'active') throw fail('The authoritative SQLite database is missing; do not import an outdated backup automatically')
      if (!existsSync(path) && !writer) return { state: initial, sqlite: true }
      if (writer) ensureWriter()
      const db = open(writer, writer ? initial : undefined), state = db.read()
      validate(state)
      knownRevision = db.stamp()
      if (writer) activate()
      return { state, sqlite: true }
    },
    initialize(state) {
      if (!selected || connection) return false
      ensureWriter(); validate(state); requireSqliteRuntime()
      guard = readGuard()
      if (!guard) {
        const text = JSON.stringify(encodeProjectState(state)), sha256 = digest(text), backup = `state.sqlite-import-${sha256}.json`
        writeDurableStateFile(join(home, backup), text, { exclusive: true })
        guard = { version: 3, storage: 'sqlite', phase: 'prepared', migration: { id: randomUUID(), backup, sha256, importedAt: Date.now() } }
        // Guard first: a crash before SQL initialization remains recoverable from
        // the verified backup and an older JSON-only binary refuses to write.
        writeDurableStateFile(statePath, JSON.stringify(guard, null, 2))
      }
      const db = open(true, importState(guard.migration))
      knownRevision = db.stamp()
      activate()
      return true
    },
    write(snapshot) {
      if (!selected || !guard) throw fail('SQLite storage has not been initialized')
      ensureWriter(); checkRollback(); assertGuard()
      const db = open(true)
      if (knownRevision !== db.stamp()) throw fail('SQLite state revision conflict; refresh before taking over')
      const result = db.write(typeof snapshot === 'string' ? JSON.parse(snapshot) : snapshot)
      knownRevision = String(result.revision)
      return result
    },
    stamp() { return connection ? `sqlite:${guard.migration.id}:${connection.stamp()}` : null },
    status() { return { backend: selected ? 'sqlite' : 'json', ready: Boolean(connection), ...(connection ? connection.metadata() : {}) } },
    changes(options) { if (!connection) throw fail('SQLite storage is not initialized'); return connection.changes(options) },
    close() { connection?.close(); connection = undefined },
  }
}
