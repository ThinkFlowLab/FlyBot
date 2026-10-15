// test.yml: the shape that a merge queue and the required `tests-ok` check rely on (text checks; no YAML parser needed).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const text = readFileSync(new URL('../workflows/test.yml', import.meta.url), 'utf8')
const triggers = text.slice(text.indexOf('\non:\n'), text.indexOf('\nconcurrency:'))
const job = name => {
  const start = text.indexOf(`\n  ${name}:\n`)
  assert.ok(start >= 0, `no job ${name}`)
  const next = text.slice(start + 1).search(/\n {2}[a-z][\w-]*:\n/)
  return text.slice(start, next < 0 ? undefined : start + 1 + next)
}

test('triggers: pull_request, merge_group (no filters), push only on main, dispatch', () => {
  assert.match(triggers, /^ {2}pull_request:\s*$/m)
  assert.match(triggers, /^ {2}merge_group:\s*$/m, 'a merge queue needs merge_group or required checks never report on queue entries')
  assert.match(triggers, /^ {2}workflow_dispatch:\s*$/m)
  assert.match(triggers, /^ {2}push:\n {4}branches: \[main\]$/m, 'push stays on main so gh-readonly-queue/* branches do not run twice')
  const mergeGroup = triggers.slice(triggers.search(/^ {2}merge_group:/m)).split('\n').slice(1).filter(l => l.trim() && !l.trim().startsWith('#'))
  assert.ok(!/^ {4}(paths|paths-ignore|branches)/.test(mergeGroup[0] ?? ''), 'merge_group takes no path or branch filters')
  assert.match(triggers, /paths-ignore: \['docs\/\*\*', '\*\*\/\*\.md'\]/, 'paths-ignore is on push only')
  assert.ok(triggers.indexOf('paths-ignore') < triggers.indexOf('pull_request:'), 'paths-ignore must stay under push, not pull_request or merge_group')
})

test('no job is skipped on merge_group: nothing keys on the pull_request event', () => {
  assert.doesNotMatch(text, /github\.event\.pull_request/)
  assert.doesNotMatch(text, /event_name\s*[!=]=\s*'pull_request'/)
  for (const name of ['test', 'plugins', 'package']) assert.doesNotMatch(job(name), /^\s+if:/m, `${name} must run for every event`)
})

test('tests-ok: always runs and is green only when test, plugins and package are', () => {
  const ok = job('tests-ok')
  assert.match(ok, /^ {4}name: tests-ok$/m)
  assert.match(ok, /^ {4}if: always\(\)$/m)
  assert.match(ok, /needs: \[test, plugins, package\]/)
  assert.match(ok, /\[ "\$TEST" = success \] && \[ "\$PLUGINS" = success \] && \[ "\$PACKAGE" = success \]/)
})

test('main keeps its run (no cancel), every other ref, queue branches included, cancels', () => {
  assert.match(text, /cancel-in-progress: \$\{\{ github\.ref != 'refs\/heads\/main' \}\}/)
  assert.match(text, /group: test-\$\{\{ github\.ref \}\}/)
})
