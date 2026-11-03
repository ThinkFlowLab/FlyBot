// Offline operator tooling. No endpoint grants migration privileges to a Bot.
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { encodeProjectState, decodeProjectState } from './project-state-format.js'
import { homeLock } from './home-lock.js'
import { openSqliteState } from './project-state-sqlite.js'
import { writeDurableStateFile } from './project-state-storage.js'

const digest = text => createHash('sha256').update(text).digest('hex')
const fail = message => Object.assign(new Error(message), { code: 'bot/state-migration' })
function exclusively(home, action) {
  const path = join(home, 'state.lock')
  if (existsSync(path) && JSON.parse(readFileSync(path, 'utf8'))?.pid === process.pid) throw fail('Stop the current FlyBot host before migration')
  const lock = homeLock(path)
  if (lock.claim() !== undefined) throw fail('Stop the active FlyBot host before offline migration')
  try { return action() } finally { lock.release() }
}
function guardOf(home, expectedMigrationId) {
  const guard = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  if (guard.version !== 3 || guard.storage !== 'sqlite' || guard.phase !== 'active' || !expectedMigrationId || guard.migration?.id !== expectedMigrationId) throw fail('The active SQLite migration ID changed; inspect before exporting or rolling back')
  return guard
}
function snapshot(home, expectedMigrationId) {
  const guard = guardOf(home, expectedMigrationId)
  const db = openSqliteState({ path: join(home, 'state.sqlite'), readOnly: true })
  try {
    const metadata = db.metadata()
    if (metadata.migration?.id !== guard.migration.id || metadata.migration?.sha256 !== guard.migration.sha256) throw fail('SQLite and guard identities differ')
    const state = db.read()
    if (state.version !== 2) throw fail('Unsupported exported state version')
    guardOf(home, expectedMigrationId)
    return { text: JSON.stringify(encodeProjectState(state), null, 2), revision: metadata.revision }
  } finally { db.close() }
}
export function exportSqliteState({ home, output, expectedMigrationId }) {
  if (!output) throw fail('Choose a private export output file')
  return exclusively(home, () => {
    const current = snapshot(home, expectedMigrationId)
    writeDurableStateFile(output, current.text, { exclusive: true })
    return { backend: 'sqlite', revision: current.revision, sha256: digest(current.text), output }
  })
}
export function rollbackSqliteState({ home, expectedMigrationId, resume = false }) {
  return exclusively(home, () => {
    const markerPath = join(home, 'state-storage-rollback.json'), path = join(home, 'state.sqlite'), statePath = join(home, 'state.json')
    const previous = existsSync(markerPath) ? JSON.parse(readFileSync(markerPath, 'utf8')) : null
    let marker
    if (previous?.phase === 'prepared') {
      if (!resume || previous.migrationId !== expectedMigrationId) throw fail('A prepared rollback exists; explicitly resume its exact migration ID')
      marker = previous
    } else {
      if (resume && previous?.phase === 'completed' && previous.migrationId === expectedMigrationId) return { ...previous, already: true }
      if (resume) throw fail('No matching prepared rollback exists')
      const current = snapshot(home, expectedMigrationId), id = randomUUID()
      marker = { version: 'flybot-storage-rollback/v1', phase: 'prepared', id, migrationId: expectedMigrationId, revision: current.revision,
        exportFile: `state.rollback-${id}.json`, archiveFile: `state.sqlite.rollback-${id}`, sha256: digest(current.text), preparedAt: Date.now() }
      writeDurableStateFile(join(home, marker.exportFile), current.text, { exclusive: true })
      writeDurableStateFile(markerPath, JSON.stringify(marker, null, 2))
    }
    if (marker.version !== 'flybot-storage-rollback/v1' || !/^[a-f0-9-]{36}$/.test(marker.id) || marker.archiveFile !== `state.sqlite.rollback-${marker.id}` || marker.exportFile !== `state.rollback-${marker.id}.json` || !/^[a-f0-9]{64}$/.test(marker.sha256)) throw fail('Rollback recovery marker is malformed')
    const text = readFileSync(join(home, marker.exportFile), 'utf8')
    if (digest(text) !== marker.sha256 || decodeProjectState(JSON.parse(text)).version !== 2) throw fail('Rollback export hash changed')
    const currentText = readFileSync(statePath, 'utf8')
    if (digest(currentText) !== marker.sha256) {
      guardOf(home, expectedMigrationId)
      if (existsSync(path)) {
        const current = snapshot(home, expectedMigrationId)
        if (current.revision !== marker.revision || digest(current.text) !== marker.sha256) throw fail('SQL state changed after rollback preparation')
      } else if (!existsSync(join(home, marker.archiveFile))) throw fail('Rollback database archive is missing')
      // Keep DB/WAL/SHM names paired. A crash between moves leaves the marker and
      // verified export; resume finishes it before any runtime can write again.
      for (const suffix of ['', '-wal', '-shm']) {
        const source = path + suffix, target = join(home, marker.archiveFile) + suffix
        if (!existsSync(source)) continue
        if (existsSync(target)) throw fail('Rollback archive already contains a conflicting file')
        renameSync(source, target)
      }
      writeDurableStateFile(statePath, text)
    }
    marker = { ...marker, phase: 'completed', completedAt: Date.now() }
    writeDurableStateFile(markerPath, JSON.stringify(marker, null, 2))
    return { ...marker, backend: 'json', removeStateStorageSqliteConfig: true }
  })
}
