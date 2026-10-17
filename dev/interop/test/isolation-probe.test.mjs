import assert from 'node:assert/strict'
import { test } from 'node:test'
import { containerArgs, runIsolationProbe, validateImage } from '../isolation/probe.mjs'

const image = `node@sha256:${'a'.repeat(64)}`
const spec = { image, name: 'flybot-probe-synthetic-writer', workspace: '/tmp/pilot/writer', script: '/tmp/pilot/probe.mjs', role: 'writer' }

test('isolation probe refuses mutable image tags before starting resources', () => {
  for (const value of ['', 'node:24', 'node@sha256:abc', `${image}\n`, '--privileged']) assert.throws(() => validateImage(value))
  assert.equal(validateImage(image), image)
})

test('isolation probe limits mounts and drops execution privileges', () => {
  const args = containerArgs(spec)
  const value = flag => args[args.indexOf(flag) + 1]
  assert.equal(value('--network'), 'none')
  assert.equal(value('--user'), '1000:1000')
  assert.equal(value('--cap-drop'), 'ALL')
  assert.equal(value('--security-opt'), 'no-new-privileges')
  assert.equal(value('--memory'), '128m')
  assert.equal(value('--pids-limit'), '64')
  assert.ok(args.includes('--read-only'))
  assert.equal(args.filter(arg => arg === '--mount').length, 2)
  assert.ok(args.includes('type=bind,src=/tmp/pilot/writer,dst=/work'))
  assert.ok(args.includes('type=bind,src=/tmp/pilot/probe.mjs,dst=/probe.mjs,readonly'))
  assert.ok(!args.some(arg => /privileged|docker\.sock|host=|network=host/.test(arg)))
  assert.deepEqual(args.slice(args.indexOf(image) + 1), ['-i', 'PATH=/usr/local/bin:/usr/bin:/bin', 'TZ=UTC', 'node', '/probe.mjs', 'writer'])
  assert.equal(value('--entrypoint'), '/usr/bin/env')
})

test('isolation probe rejects argument or mount injection and unknown roles', () => {
  for (const patch of [
    { workspace: '/' }, { workspace: 'relative' }, { workspace: '/tmp/pilot,src=/' },
    { workspace: '/tmp/..' }, { script: '/other/probe.mjs' },
    { script: '/tmp/probe,readonly=false' }, { name: '--privileged' }, { role: 'shell' },
  ]) assert.throws(() => containerArgs({ ...spec, ...patch }))
})

test('partial container creation is cleaned up even after cancellation', async () => {
  const calls = []
  const controller = new AbortController()
  await assert.rejects(runIsolationProbe(image, { signal: controller.signal, invoke: async (args, options) => {
    calls.push(args)
    if (args[0] === 'create') { controller.abort(); throw new Error('creation interrupted') }
    if (args[0] === 'rm') assert.equal(options, undefined, 'cleanup must not use the aborted execution signal')
    return 'synthetic'
  } }), /creation interrupted/)
  const create = calls.find(args => args[0] === 'create')
  assert.deepEqual(calls.at(-1), ['rm', '--force', create[create.indexOf('--name') + 1]])
})

test('container cleanup failure cannot produce a passing isolation report', async () => {
  await assert.rejects(runIsolationProbe(image, { invoke: async args => {
    if (args[0] === 'create') throw new Error('creation failed')
    if (args[0] === 'rm') throw new Error('daemon unavailable')
    return 'synthetic'
  } }), /cleanup failed/)
})
