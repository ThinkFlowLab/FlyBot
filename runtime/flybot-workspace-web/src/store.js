// Per-feature SQLite on the user's own volume (node:sqlite, Node >= 22.13).
import { join } from 'node:path'

let DatabaseSync
export async function openDatabase(host, file = 'state.sqlite3') {
  DatabaseSync ??= (await import('node:sqlite')).DatabaseSync
  const db = new DatabaseSync(join(host.featureDir(), file))
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;')
  return db
}

export function newId() {
  return globalThis.crypto.randomUUID().replaceAll('-', '')
}

export function fail(code, message) {
  throw Object.assign(new Error(message), { code })
}
