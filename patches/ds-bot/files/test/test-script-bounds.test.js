import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// `node --test` fans out to `availableParallelism() - 1` files at once — 191 on a 192-core box —
// and a child whose spawn fails (`EAGAIN`) never exits, so the run wedges at the same output for as
// long as the shell stays open (#2725). The `test` script therefore has to name a small fan-out and
// a per-file deadline itself rather than inherit the host's core count.
const root = new URL('../../', import.meta.url)
const read = path => readFileSync(new URL(path, root), 'utf8')
const script = JSON.parse(read('core/package.json')).scripts.test
const flag = name => {
  const match = script.match(new RegExp(`--${name}=(\\d+)(?:\\s|$)`))
  return match ? Number(match[1]) : null
}

test('the test script bounds its fan-out instead of inheriting the core count', () => {
  const concurrency = flag('test-concurrency')
  assert.notEqual(concurrency, null, 'npm test passes no --test-concurrency, so it starts one child per core')
  assert.ok(concurrency >= 1, `--test-concurrency=${concurrency} starts no test file`)
  assert.ok(concurrency <= 8, `--test-concurrency=${concurrency} is not a small constant; a high-core host spawns that many at once`)
})

test('the test script gives every test file a deadline', () => {
  const timeout = flag('test-timeout')
  assert.notEqual(timeout, null, 'npm test passes no --test-timeout, so one stuck file holds the run open')
  assert.ok(timeout >= 60000, `--test-timeout=${timeout} is too short for the slower host files`)
  assert.ok(timeout <= 300000, `--test-timeout=${timeout} is longer than a run of the whole suite`)
})

test('the test script still runs the harness resolver over the whole suite', () => {
  assert.ok(script.includes('--import ./test/harness-resolve.mjs'), 'the harness resolver is what makes `@deepseek-ai/*` load in the tests')
  assert.ok(script.includes('"test/*.test.js"'), 'the glob is the whole suite; a narrower one would hide files')
})

// The flag has to reach node's own parser, not just sit in package.json: this runs the same deadline
// over a file that would otherwise never return, and reads the cancellation it produces.
test('a stuck test file fails inside the deadline instead of hanging', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flybot-stuck-'))
  try {
    writeFileSync(join(dir, 'stuck.test.js'), [
      "import { test } from 'node:test'",
      "test('deliberately stuck', () => new Promise(resolve => setTimeout(resolve, 60000)))",
      '',
    ].join('\n'))
    let output = ''
    let status = 0
    try {
      output = execFileSync(process.execPath, ['--test', '--test-timeout=750', join(dir, 'stuck.test.js')], {
        encoding: 'utf8',
        // A node that ignored the flag would hang here; killing it makes this test fail instead.
        timeout: 30000,
        stdio: ['ignore', 'pipe', 'pipe'],
        // Inherited from the runner around this file, it makes the child run as a test child of
        // this one: it exits 0 at once and never parses `--test-timeout` at all.
        env: { ...process.env, NODE_TEST_CONTEXT: undefined },
      })
    } catch (error) {
      output = `${error.stdout ?? ''}${error.stderr ?? ''}`
      status = error.status
    }
    assert.notEqual(status, 0, 'the stuck file has to fail, not pass or be killed from outside')
    assert.match(output, /test timed out after 750ms/, 'node has to cancel it through the deadline and name the failure')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// The plain CI path is `npm test`, which is where the bounds live; a step that spells out its own
// `node --test` would go back to starting one child per core (#2723 owns the coverage invocation).
test('CI runs the plain suite through npm test, so it inherits the bounds', () => {
  const lines = read('.github/actions/flybot-tests/action.yml').split('\n')
  const start = lines.findIndex(line => line.trim() === '- name: Unit tests')
  assert.notEqual(start, -1, 'the plain unit-test step is gone')
  const step = lines.slice(start, start + 6).map(line => line.trim())
  assert.ok(step.includes("if: inputs.coverage != 'true'"), 'the plain step no longer guards on coverage')
  assert.ok(step.includes('run: npm test'), 'the plain CI step must call npm test, not its own node --test invocation')
})
