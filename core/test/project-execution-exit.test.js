import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

test('the actual pool host adapter cannot confirm an unknown missing worker from Bot absence alone', async t => {
  const home = await mkdtemp(join(tmpdir(), 'flybot-exit-adapter-'))
  const ctx = fakeContext()
  const rt = createRuntime(ctx, { home })
  t.after(async () => { await ctx.dispose(); await rm(home, { recursive: true, force: true }) })
  let adapter
  rt.projectPools.connect = value => { adapter = value; return () => {} }
  rt.flybot.scope('flybot-workflow').projects.execution.connectPools({ release: async () => {} }, () => ({ ok: true }))
  assert.equal(await adapter.release('unknown-native-carrier'), false)
})

test('physical exit query accepts only matching persisted facts and never infers an unknown worker', async () => {
  const { executionExitConfirmed } = await import('../src/host/project-execution-exit.js')
  const rt = { state: {}, botOf: () => undefined }
  assert.equal(executionExitConfirmed(rt, 'unknown'), false)
  const scope = { kind: 'systemd-control-group', killMode: 'control-group', invocationId: 'a'.repeat(32) }
  rt.state.projectResourceLeases = { legacy: { id: 'legacy', status: 'released', worker: { kind: 'native', botId: 'legacy-native' }, processScope: scope, releaseProof: { kind: 'systemd-prior-invocation-exited', previousInvocationId: scope.invocationId } } }
  assert.equal(executionExitConfirmed(rt, 'legacy-native'), true)
  rt.state.projectResourceLeases.legacy.releaseProof.previousInvocationId = 'b'.repeat(32)
  assert.equal(executionExitConfirmed(rt, 'legacy-native'), false)
  rt.state.projectHarnessWorkers = { sdk: { id: 'sdk', status: 'released', generation: 3, leaseId: 'sdk-lease', releaseProof: { kind: 'sdk-stop-ack-and-process-exit', generation: 3 } } }
  rt.state.projectResourceLeases['sdk-lease'] = { status: 'running' }
  assert.equal(executionExitConfirmed(rt, 'sdk'), false)
  rt.state.projectResourceLeases['sdk-lease'].status = 'released'
  assert.equal(executionExitConfirmed(rt, 'sdk'), true)
  rt.state.projectNativeWorkers = { native: { id: 'native', version: 'project-native-worker/v2', status: 'quiescent', generation: 1, sessionId: 'native-session', bindingKey: 'key', releaseProof: { kind: 'native-agent-quiescent', registeredWorkEmpty: true, workerId: 'native', generation: 1, sessionId: 'native-session', bindingKey: 'key' } } }
  assert.equal(executionExitConfirmed(rt, 'native'), true)
  rt.botOf = id => id === 'native' ? { id } : undefined
  assert.equal(executionExitConfirmed(rt, 'native'), false)
})
