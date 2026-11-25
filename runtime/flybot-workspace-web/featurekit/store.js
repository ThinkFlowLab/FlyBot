// Per-user FlyBot storage inside this DS-Bot's own volume:
// /data/flybot-workspace/features/<name>/<name>.sqlite3 (node:sqlite on Node 24).
// Each feature owns its file and declares ordered migrations; nothing about one
// user is stored in another user's volume.
import { DatabaseSync } from 'node:sqlite'

// file: an absolute path inside the feature's private directory (host.featureDir()).
export function openStore(file) {
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;')
  db.exec(`CREATE TABLE IF NOT EXISTS ot_feature_migrations (
    feature TEXT NOT NULL, version INTEGER NOT NULL, applied INTEGER NOT NULL,
    PRIMARY KEY(feature, version))`)
  return wrap(db)
}

function wrap(db) {
  const store = {
    db,
    run: (sql, ...args) => db.prepare(sql).run(...args),
    get: (sql, ...args) => db.prepare(sql).get(...args) ?? null,
    all: (sql, ...args) => db.prepare(sql).all(...args),
    exec: (sql) => db.exec(sql),
    transaction(fn) {
      db.exec('BEGIN IMMEDIATE')
      try {
        const result = fn(store)
        db.exec('COMMIT')
        return result
      } catch (error) {
        try { db.exec('ROLLBACK') } catch { /* already rolled back */ }
        throw error
      }
    },
    migrate(feature, migrations) {
      for (const [index, sql] of migrations.entries()) {
        const version = index + 1
        if (store.get('SELECT 1 AS ok FROM ot_feature_migrations WHERE feature=? AND version=?', feature, version)) continue
        store.transaction(() => {
          db.exec(sql)
          store.run('INSERT INTO ot_feature_migrations VALUES(?,?,?)', feature, version, Math.floor(Date.now() / 1000))
        })
      }
    },
    close: () => db.close(),
  }
  return store
}
