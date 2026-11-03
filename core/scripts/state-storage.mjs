// Offline private operator interface; no account credentials are accepted here.
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { exportSqliteState, rollbackSqliteState } from '../src/host/project-state-migration.js'

try {
  const [command, ...args] = process.argv.slice(2), options = {}
  if (!['inspect', 'export', 'rollback'].includes(command)) throw new Error('Usage: node core/scripts/state-storage.mjs inspect|export|rollback --home PATH [--migration ID] [--output PATH] [--resume]')
  for (let i = 0; i < args.length; i++) {
    const key = args[i]
    if (!['--home', '--migration', '--output', '--resume'].includes(key) || Object.hasOwn(options, key)) throw new Error('Unknown or duplicate migration option')
    if (key === '--resume') options[key] = true
    else if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Migration option requires a value')
    else options[key] = args[++i]
  }
  if (!options['--home']) throw new Error('An explicit private --home is required')
  const home = resolve(options['--home'])
  let result
  if (command === 'inspect') {
    const guard = JSON.parse(readFileSync(resolve(home, 'state.json'), 'utf8'))
    result = { backend: guard.storage === 'sqlite' ? 'sqlite' : 'json', phase: guard.phase ?? null, migrationId: guard.migration?.id ?? null }
  } else if (command === 'export') result = exportSqliteState({ home, expectedMigrationId: options['--migration'], output: options['--output'] ? resolve(options['--output']) : null })
  else result = rollbackSqliteState({ home, expectedMigrationId: options['--migration'], resume: options['--resume'] === true })
  process.stdout.write(JSON.stringify(result) + '\n')
} catch (error) { process.stderr.write(`State storage operation refused: ${error.message}\n`); process.exitCode = 1 }
