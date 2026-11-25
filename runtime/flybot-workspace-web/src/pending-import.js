// Boot importer for extension-point features that do not use featurekit.
// Only manager-delivered, feature-matching files on this user's private volume.
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { requireBundleTarget } from '../featurekit/bundle.js'

export async function importPending({ host, db, migrate }) {
  db.exec('CREATE TABLE IF NOT EXISTS ot_boot_imports (digest TEXT PRIMARY KEY, imported INTEGER NOT NULL)')
  const dir = join(host.dataDir, 'flybot-workspace', 'import')
  let files
  try { files = readdirSync(dir).filter(name => /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,120}\.bundle$/.test(name)).sort() }
  catch (error) { if (error.code === 'ENOENT') return []; throw error }
  const results = []
  for (const name of files) {
    const path = join(dir, name)
    try {
      const text = readFileSync(path, 'utf8'), bundle = JSON.parse(text)
      if (bundle.feature !== host.name) continue
      requireBundleTarget(bundle, host.identity?.routingInstanceId ?? host.identity?.instanceId)
      const digest = createHash('sha256').update(text).digest('hex')
      if (!db.prepare('SELECT 1 FROM ot_boot_imports WHERE digest=?').get(digest)) {
        await migrate(bundle)
        db.prepare('INSERT INTO ot_boot_imports VALUES(?,?)').run(digest, Math.floor(Date.now() / 1000))
      }
      unlinkSync(path)
      results.push({ status: 'imported' })
    } catch (error) {
      // A bounded classifier, never arbitrary thrown messages or bundle data.
      const reason = error?.code === 'EACCES' ? 'permission' : error?.message === 'import target mismatch' ? 'target' : 'validation'
      // Never log bundle data, secret material, or arbitrary thrown messages.
      host.log('pending import rejected (' + reason + '); file retained')
      results.push({ status: 'rejected' })
    }
  }
  return results
}
