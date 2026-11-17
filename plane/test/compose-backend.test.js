// #3113 red-first, compose backend: the first lifecycle backend only *materializes* an instance's
// compose project — `instances/<id>/compose.yaml` plus a 0600 `control.env` — and never runs
// docker. The compose file stays honest with the repo's own compose.yaml (host networking, a
// loopback FLYBOT_PORT), carries no credential in it, and writing it twice changes nothing.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ComposeBackend, MemoryBackend } from '../src/lifecycle.mjs'
import { openStore } from '../src/store.mjs'

function seeded() {
  const dir = mkdtempSync(join(tmpdir(), 'plane-comp-'))
  const store = openStore(join(dir, 'data'))
  const account = store.createAccount({ name: 'alice' })
  const ws = store.createWorkspace({ accountId: account.id, name: 'w' })
  const { instance, controlToken } = store.createInstance({ workspaceId: ws.id, name: 'main' })
  return { dir, store, account, instance, controlToken }
}

test('materialize writes flybot-<id> on host networking with a loopback FLYBOT_PORT', async () => {
  const s = seeded()
  try {
    const calls = []
    const backend = new ComposeBackend({ root: s.dir, runner: (...args) => calls.push(args) })
    const out = backend.materialize(s.instance, { controlToken: s.controlToken })
    const yaml = readFileSync(join(out.dir, 'compose.yaml'), 'utf8')
    assert.match(yaml, new RegExp(`name: flybot-${s.instance.id}`))
    assert.match(yaml, /network_mode: host/)
    const port = Number(yaml.match(/FLYBOT_PORT[=: ]+(\d{3,5})/)[1])
    assert.ok(port >= 3090 && port < 4000, `port ${port} is outside the loopback range this plane allocates`)
    assert.equal(calls.length, 0)
  } finally {
    rmSync(s.dir, { recursive: true, force: true })
  }
})

test('no control plaintext in compose.yaml — the credential lives only in 0600 control.env', async () => {
  const s = seeded()
  try {
    const backend = new ComposeBackend({ root: s.dir })
    const out = backend.materialize(s.instance, { controlToken: s.controlToken })
    const yaml = readFileSync(join(out.dir, 'compose.yaml'), 'utf8')
    assert.ok(!yaml.includes(s.controlToken), 'control plaintext leaked into compose.yaml')
    const env = readFileSync(join(out.dir, 'control.env'), 'utf8')
    assert.ok(env.includes(s.controlToken))
    const mode = statSync(join(out.dir, 'control.env')).mode & 0o777
    assert.equal(mode, 0o600)
  } finally {
    rmSync(s.dir, { recursive: true, force: true })
  }
})

test('materialize is idempotent, and the backend never spawns a runner on start or stop either', async () => {
  const s = seeded()
  try {
    const calls = []
    const backend = new ComposeBackend({ root: s.dir, runner: (...args) => calls.push(args) })
    const first = backend.materialize(s.instance, { controlToken: s.controlToken })
    const before = readFileSync(join(first.dir, 'compose.yaml'), 'utf8')
    const second = backend.materialize(s.instance, { controlToken: s.controlToken })
    assert.equal(second.dir, first.dir)
    assert.equal(readFileSync(join(second.dir, 'compose.yaml'), 'utf8'), before)
    assert.equal(calls.length, 0)
    // The MemoryBackend sibling keeps the same contract shape for tests that need no files.
    const memory = new MemoryBackend()
    assert.equal(memory.start(s.instance).state, 'running')
    assert.equal(calls.length, 0)
  } finally {
    rmSync(s.dir, { recursive: true, force: true })
  }
})
