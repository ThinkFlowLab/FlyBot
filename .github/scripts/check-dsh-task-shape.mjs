// A part handoff moves a task by rewriting one row of DeepSeek Harness's schedule storage: `moveSchedules`
// in core/src/host/schedules.js runs the write in `service.serialize(...)`, reads the row table through
// `(await service.getDomain()).table('tasks')` and puts `{ ...task, sessionId: toId }` back (#1245).
//
// Both members are `private` in dsh-schedule's own typings (lib/types/index.d.ts: `private getDomain;`
// and `private serialize;`), and the row belongs to a storage domain declared inside the package, so a
// rename or a new row shape does not throw anywhere a test can see: the outer `catch` in `moveSchedules`
// turns it into one `rt.warn`, the task stays on the part being archived, and the board simply stops
// waking it. This is the check that goes red instead (#1257).
//
// It needs the real package, so it runs where a profile installs it: the DSH harness the unit tests
// already use (`npm run harness` in core/, `DSH_HARNESS`). It fails rather than skips when the package or
// a member is gone — a skip is not a pin. Only public exports are used: `ScheduleService`,
// `scheduleDomain` and `createAtScheduleRecord`.
//
// What it does not open: the domain handle itself. `table(name)` lives on dsh-storage-domain's
// DomainImpl, which that package does not export, and opening a real domain means booting the storage
// facility with a backend. So the table name is pinned where it is declared instead — `scheduleDomain
// .tables.tasks` must exist and its row schema must accept exactly the row moveSchedules writes.
//
// Usage: node .github/scripts/check-dsh-task-shape.mjs [harness-dir]
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const PACKAGE = '@deepseek-ai/dsh-schedule'

// The row `moveSchedules` reads and writes, and the record members it reads off that row.
export const ROW_MEMBERS = ['sessionId', 'record', 'status', 'deliveryHistory']
export const RECORD_MEMBERS = ['id', 'title', 'kind', 'scheduledAt']
export const STATUS_MEMBERS = ['active']

export const REMEDY = [
  'moveSchedules (core/src/host/schedules.js) writes one task row through the private members',
  '  service.serialize(async () => { const tasks = (await service.getDomain()).table(\'tasks\'); ... })',
  `and the row shape {${ROW_MEMBERS.join(', ')}} whose record carries {${RECORD_MEMBERS.join(', ')}}`,
  `with status values {${STATUS_MEMBERS.join(', ')}} (dsh-schedule 0.2.x keeps getDomain and serialize private).`,
  'Both members and that row shape are private on the DSH side: when DSH is upgraded, re-confirm this',
  'path (and this check) before bumping the harness pin in core/dev/harness/package.json. A rename here',
  'does not throw where anyone sees it — it leaves every moved task on the part being archived behind',
  'one rt.warn, and the board stops waking it with no red anywhere.',
]

// DSH_HARNESS is what the plugin and frontend suites already read; the harness directory is the fallback,
// and it is the same order test/harness-resolve.mjs uses so a local run and CI resolve the same package.
export function harnessDir(args = process.argv.slice(2)) {
  const arg = args.find((value) => !value.startsWith('--'))
  if (arg) return resolve(arg)
  if (process.env.DSH_HARNESS) return resolve(process.env.DSH_HARNESS)
  return resolve(import.meta.dirname, '..', '..', 'core', 'dev', 'harness')
}

// The package as a profile would load it: resolved from the harness, reported with its own version, so a
// failure names the version whose shape moved rather than only the path it came from.
export function loadSchedule(dir) {
  if (!existsSync(dir)) throw new Error(`no harness at ${dir} (run \`npm run harness\` in core/ or set DSH_HARNESS)`)
  const require = createRequire(pathToFileURL(join(dir, 'package.json')))
  let manifest
  try {
    manifest = require.resolve(`${PACKAGE}/package.json`)
  } catch {
    throw new Error(`${PACKAGE} is not installed in the harness at ${dir} (run \`npm run harness\` in core/ or set DSH_HARNESS)`)
  }
  const version = JSON.parse(readFileSync(manifest, 'utf8')).version
  const entry = require.resolve(PACKAGE)
  return { version, entry, load: () => import(pathToFileURL(entry).href) }
}

// The task row the way moveSchedules leaves it: a frozen record from the package's own constructor, wrapped
// in the row members it spreads.
export const rowFor = (module, sessionId) => ({
  sessionId,
  record: module.createAtScheduleRecord('shape-pin', 'pin the DSH task row', '2027-01-01T00:00:00+00:00', Date.parse('2026-01-01T00:00:00Z'), 'Shape pin'),
  status: 'active',
  deliveryHistory: { records: [], earlierRecordsUnavailable: true },
})

// Every failure is one line naming what moved; an empty list is the pin holding.
export function shapeProblems(module) {
  const problems = []
  const service = module.default
  if (typeof service !== 'function') problems.push(`${PACKAGE} no longer default-exports ScheduleService`)
  for (const member of ['getDomain', 'serialize']) {
    if (typeof service?.prototype?.[member] !== 'function') problems.push(`ScheduleService.prototype.${member} is not a function`)
  }
  const value = module.scheduleDomain?.tables?.tasks?.valueSchema
  if (typeof value?.parse !== 'function') {
    problems.push(`scheduleDomain.tables.tasks.valueSchema is not a schema (the task row is not declared where moveSchedules reads it)`)
    return problems
  }
  let row
  try {
    row = rowFor(module, 'session-from')
  } catch (error) {
    problems.push(`createAtScheduleRecord no longer builds the record a moved task carries: ${error?.message ?? error}`)
    return problems
  }
  const missing = RECORD_MEMBERS.filter((member) => row.record?.[member] === undefined)
  if (missing.length) problems.push(`a created record no longer carries ${missing.join(', ')}`)
  let parsed
  try {
    parsed = value.parse(row)
  } catch (error) {
    problems.push(`the task row {${ROW_MEMBERS.join(', ')}} is refused by the schema: ${error?.issues?.map((issue) => `${issue.path?.join('.') ?? ''} ${issue.message}`).join('; ') ?? error?.message ?? error}`)
    return problems
  }
  for (const member of ROW_MEMBERS.filter((name) => name !== 'sessionId')) {
    if (parsed[member] === undefined) problems.push(`a parsed row comes back without ${member}`)
  }
  if (parsed.sessionId !== 'session-from') problems.push('a parsed row comes back with a different sessionId')
  // Exactly what moveSchedules writes for the handoff: the row spread with the new session id.
  try {
    const moved = value.parse({ ...parsed, sessionId: 'session-to' })
    if (moved.sessionId !== 'session-to') problems.push('a row spread with the new sessionId does not come back moved')
  } catch (error) {
    problems.push(`the row moveSchedules writes ({ ...task, sessionId }) is refused: ${error?.message ?? error}`)
  }
  // The members are only load-bearing if their names are: a row without sessionId, or with a status the
  // move filter cannot see, has to be refused — otherwise this pin would pass on a free-form row.
  const strict = (row) => value.safeParse(row).success
  if (strict({ ...row, session: 'session-from' })) problems.push('a row renamed to {session} instead of {sessionId} is still accepted (the pin cannot see a rename)')
  if (strict({ ...row, status: 'archived' })) problems.push('a row with status "archived" is still accepted (the filter moveSchedules applies reads {active})')
  return problems
}

export function render({ version, entry, problems }) {
  if (problems.length === 0) {
    return `dsh-schedule task row: ok — ${PACKAGE}@${version} from ${entry}: getDomain/serialize present, {${ROW_MEMBERS.join(', ')}} accepted, record carries {${RECORD_MEMBERS.join(', ')}}`
  }
  return [
    `dsh-schedule task row: FAIL — ${PACKAGE}@${version} from ${entry}`,
    ...problems.map((problem) => `  - ${problem}`),
    ...REMEDY,
  ].join('\n')
}

if (process.argv[1] === import.meta.filename) {
  let loaded
  try {
    loaded = loadSchedule(harnessDir())
  } catch (error) {
    console.error(`dsh-schedule task row: FAIL — ${error.message}`)
    for (const line of REMEDY) console.error(`  ${line}`)
    process.exit(1)
  }
  const module = await loaded.load()
  const problems = shapeProblems(module)
  console.log(render({ ...loaded, problems }))
  if (problems.length > 0) process.exit(1)
}
