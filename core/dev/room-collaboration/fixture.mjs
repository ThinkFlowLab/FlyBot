// Synthetic inputs and executable assertions shared by deterministic room tests
// and later runtime trials. No model or participant behavior is defined here.
import { copyFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'

export const requirement = 'Implement totalPaid(orders, region): total only paid orders, optionally filtered by region, in integer cents. Clarify omitted-region behavior before editing. Return actual tests for independent verification.'
export const question = 'Does omitted region mean all regions, or should it be rejected?'
export const answer = 'An omitted region means all regions; an unknown region returns zero.'

const orders = [
  { id: 'A001', region: 'east', status: 'paid', amount: 100 },
  { id: 'A002', region: 'north', status: 'paid', amount: 200 },
  { id: 'A003', region: 'east', status: 'pending', amount: 300 },
  { id: 'A004', region: 'east', status: 'paid', amount: 40 },
  { id: 'A005', region: 'north', status: 'paid', amount: 60 },
]
const initial = `export function totalPaid(orders, region) {
  return orders.reduce((total, row) => total + row.amount, 0)
}
`
const header = `import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { totalPaid } from './total.mjs'
const orders = JSON.parse(readFileSync(new URL('./orders.json', import.meta.url), 'utf8'))
`
const workerTests = `${header}
assert.equal(totalPaid(orders, 'east'), 140)
assert.equal(totalPaid([], 'east'), 0)
`
// These cases are intentionally independent of the Writer's narrow self-test.
const independentTests = `${header}
assert.equal(totalPaid(orders), 400, 'omitted region includes every paid order')
assert.equal(totalPaid(orders, 'east'), 140)
assert.equal(totalPaid(orders, 'north'), 260)
assert.equal(totalPaid(orders, 'missing'), 0)
assert.equal(totalPaid([]), 0)
assert.equal(totalPaid([{ region: 'east', status: 'pending', amount: 999 }]), 0)
assert.equal(totalPaid([{ region: 'east', status: 'paid', amount: 7 }]), 7)
`

export function prepareFixture(root) {
  const dirs = { worker: join(root, 'writer'), verifier: join(root, 'verifier') }
  for (const directory of Object.values(dirs)) {
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'orders.json'), JSON.stringify(orders))
  }
  writeFileSync(join(dirs.worker, 'total.mjs'), initial)
  writeFileSync(join(dirs.worker, 'check.mjs'), workerTests)
  writeFileSync(join(dirs.verifier, 'check.mjs'), independentTests)
  return dirs
}

function execute(directory) {
  const artifact = readFileSync(join(directory, 'total.mjs'))
  // The permission flag must match the canonical path the loader realpaths to;
  // a symlinked temp root (macOS /var -> /private/var) otherwise denies every read.
  const result = spawnSync(process.execPath, [
    '--permission', `--allow-fs-read=${realpathSync(directory)}`, 'check.mjs',
  ], { cwd: directory, env: { TZ: 'UTC' }, encoding: 'utf8', timeout: 5000, maxBuffer: 32 * 1024 })
  if (result.error) throw result.error
  return {
    ok: result.status === 0, exitCode: result.status, signal: result.signal,
    sha256: createHash('sha256').update(artifact).digest('hex'),
    stdout: result.stdout, stderr: result.stderr,
  }
}

export const checkWorker = dirs => execute(dirs.worker)

export function verifyArtifact(dirs) {
  // Only the returned code crosses over; Writer-controlled tests/data stay out.
  copyFileSync(join(dirs.worker, 'total.mjs'), join(dirs.verifier, 'total.mjs'))
  return execute(dirs.verifier)
}
