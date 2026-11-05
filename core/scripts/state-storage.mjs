// Offline private operator interface; no account credentials are accepted here.
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { exportSqliteState, rollbackSqliteState, verifySqliteState } from '../src/host/project-state-migration.js'

let verifying = false
try {
  const [command, ...args] = process.argv.slice(2), options = {}
  verifying = command === 'verify'
  if (!['inspect', 'verify', 'export', 'rollback'].includes(command)) throw new Error('Usage: node core/scripts/state-storage.mjs inspect|verify|export|rollback --home PATH [--migration ID] [--output PATH] [--resume]')
  for (let i = 0; i < args.length; i++) {
    const key = args[i]
    if (!['--home', '--migration', '--output', '--resume'].includes(key) || Object.hasOwn(options, key)) throw new Error('Unknown or duplicate migration option')
    if (key === '--resume') options[key] = true
    else if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Migration option requires a value')
    else options[key] = args[++i]
  }
  if (!options['--home']) throw new Error('An explicit private --home is required')
  if (command === 'verify' && Object.keys(options).some(key => key !== '--home')) throw new Error('verify accepts only --home and never performs a migration')
  const home = resolve(options['--home'])
  let result
  if (command === 'inspect') {
    const guard = JSON.parse(readFileSync(resolve(home, 'state.json'), 'utf8'))
    result = { backend: guard.storage === 'sqlite' ? 'sqlite' : 'json', phase: guard.phase ?? null, migrationId: guard.migration?.id ?? null }
  } else if (command === 'verify') result = verifySqliteState({ home })
  else if (command === 'export') result = exportSqliteState({ home, expectedMigrationId: options['--migration'], output: options['--output'] ? resolve(options['--output']) : null })
  else result = rollbackSqliteState({ home, expectedMigrationId: options['--migration'], resume: options['--resume'] === true })
  process.stdout.write(JSON.stringify(result) + '\n')
} catch (error) { (verifying ? process.stdout : process.stderr).write(JSON.stringify({ ok: false, code: error.code ?? 'bot/state-migration', message: error.stateIssue || error.code === 'bot/state-migration' ? error.message : 'State storage operation refused', ...(error.stateIssue ? { issue: error.stateIssue } : {}) }) + '\n'); process.exitCode = 1 }
