import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPlane } from '../index.js'
import { ComposeBackend } from '../src/lifecycle.mjs'
import { openStore } from '../src/store.mjs'

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'plane-compose-'))
  const instancesDir = join(dataDir, 'instances')
  const calls = []
  const backend = new ComposeBackend({ instancesDir, runner: (...args) => calls.push(args) })
  const store = openStore(dataDir)
  const plane = createPlane({ dataDir, store, backend })
  const cleanup = () => rmSync(dataDir, { recursive: true, force: true })
  return { dataDir, instancesDir, backend, store, plane, calls, cleanup }
}

test('materialize writes a compose project named flybot-<id> on a loopback port', async () => {
  const { instancesDir, plane, cleanup } = setup()
  try {
    const created = await plane.createInstance({ workspaceId: 'ws-1', name: 'main', ownerId: 'acct-a' })
    const composePath = join(instancesDir, created.id, 'compose.yaml')
    const text = readFileSync(composePath, 'utf8')
    assert.match(text, new RegExp(`^name: flybot-${created.id}$`, 'm'))
    assert.match(text, /network_mode: host/m)
    const port = Number(text.match(/FLYBOT_PORT: "(\d+)"/)[1])
    assert.ok(port >= 31000 && port <= 31999, `expected a loopback-range port, got ${port}`)
    assert.equal(created.hostPort, port)
  } finally {
    cleanup()
  }
})

test('the control token lives only in control.env (0600), never in compose.yaml', async () => {
  const { instancesDir, plane, cleanup } = setup()
  try {
    const created = await plane.createInstance({ workspaceId: 'ws-1', name: 'main', ownerId: 'acct-a' })
    const dir = join(instancesDir, created.id)
    const compose = readFileSync(join(dir, 'compose.yaml'), 'utf8')
    assert.ok(!compose.includes(created.controlToken))
    assert.match(compose, /env_file:\n\s+- control\.env/)
    const control = readFileSync(join(dir, 'control.env'), 'utf8')
    assert.ok(control.includes(`FLYBOT_CONTROL_TOKEN=${created.controlToken}`))
    assert.equal(statSync(join(dir, 'control.env')).mode & 0o777, 0o600)
  } finally {
    cleanup()
  }
})

test('materialize is idempotent and never spawns a container (runner call count 0)', async () => {
  const { instancesDir, backend, plane, calls, cleanup } = setup()
  try {
    const created = await plane.createInstance({ workspaceId: 'ws-1', name: 'main', ownerId: 'acct-a' })
    const dir = join(instancesDir, created.id)
    const record = plane.getInstance(created.id)
    const first = backend.materialize(record, { controlToken: created.controlToken })
    const firstCompose = readFileSync(join(dir, 'compose.yaml'), 'utf8')
    const second = backend.materialize(record, { controlToken: created.controlToken })
    const secondCompose = readFileSync(join(dir, 'compose.yaml'), 'utf8')
    assert.equal(firstCompose, secondCompose)
    assert.deepEqual(second, first)

    await plane.startInstance(created.id)
    await plane.stopInstance(created.id)
    assert.equal(calls.length, 0, 'this slice must not spawn docker compose')
  } finally {
    cleanup()
  }
})
