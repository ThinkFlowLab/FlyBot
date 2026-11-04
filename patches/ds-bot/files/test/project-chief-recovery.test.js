import assert from 'node:assert/strict'
import { test } from 'node:test'
import { nativeChiefBoundary, classifyChiefRecovery } from '../src/host/project-chief-recovery.js'
const scope = () => {
  const run = { id: 'run', projectId: 'p', invocation: 2, workerId: 'native-chief-job-run', executionBoundary: { version: 'chief-execution-boundary/v1', kind: 'native-in-process', runId: 'run', invocation: 2, botId: 'chief', sessionId: 'original', carrierGeneration: 1, exchangeId: 'exchange' } }
  return { run, state: { projectResourceLeases: {}, projectHarnessWorkers: {}, projectAgents: { 'public-p': { botId: 'chief', sessionId: 'original', carrierGeneration: 1, lastRequest: { chiefRunId: 'run', chiefInvocation: 2, exchangeId: 'exchange' } } } } }
}
test('native host exit boundary rejects SDK admissions, unknown leases and stale invocation identities', () => {
  const f = scope(); assert.equal(nativeChiefBoundary(f.state, f.run).boundary.kind, 'native-in-process')
  f.state.projectHarnessWorkers.w = { chiefRunId: 'run', chiefInvocation: 2, status: 'unreachable' }
  assert.equal(nativeChiefBoundary(f.state, f.run), null)
  delete f.state.projectHarnessWorkers.w
  f.state.projectResourceLeases.l = { projectId: 'p', chiefRunId: 'run', chiefInvocation: 2, status: 'unreachable', worker: { kind: 'sdk', handle: 'w' } }
  assert.equal(nativeChiefBoundary(f.state, f.run), null)
  f.state.projectResourceLeases = {}; f.run.executionBoundary.invocation = 1
  assert.equal(nativeChiefBoundary(f.state, f.run), null)
  delete f.run.executionBoundary
  assert(nativeChiefBoundary(f.state, f.run), 'legacy native handle still requires the exact persisted request binding')
  f.state.projectAgents['public-p'].lastRequest.chiefInvocation = 1
  assert.equal(nativeChiefBoundary(f.state, f.run), null)
})
test('Chief recovery feedback distinguishes stale state, missing authority, unknown exit and unsupported routes', () => {
  for (const [error, kind] of [[new Error('Chief routing snapshot is stale'), 'stale-snapshot'], [new Error('worker exit unconfirmed'), 'worker-exit-unknown'], [Object.assign(new Error('denied'), { code: 'bot/forbidden' }), 'authority-unavailable'], [new Error('Interrupted delivery needs recovery'), 'unsupported-route']]) assert.equal(classifyChiefRecovery(error).kind, kind)
  assert.equal(classifyChiefRecovery(new Error('worker exit unconfirmed')).retryable, true)
  assert.equal(classifyChiefRecovery(Object.assign(new Error('denied'), { code: 'bot/forbidden' })).retryable, false)
})

test('legacy unmanaged namespace assurance is operator-owned and bound to one exact old native invocation', async () => {
  const { corroboratedNativeScope, scopeDigest } = await import('../src/host/project-chief-recovery.js')
  const old = { kind: 'unmanaged-process', hostPid: 12, startTicks: '10', bootId: 'same' }, run = { id: 'run', invocation: 2 }
  const record = { runId: 'run', invocation: 2, scopeSha256: scopeDigest(old), pidNamespace: 'pid:[123]' }
  assert.equal(corroboratedNativeScope(old, run), old)
  assert.equal(corroboratedNativeScope(old, { ...run, invocation: 3 }, [record]), old)
  assert.equal(corroboratedNativeScope({ ...old, startTicks: '11' }, run, [record]).pidNamespace, undefined)
  assert.equal(corroboratedNativeScope(old, run, [record]).pidNamespace, 'pid:[123]')
  assert.equal(old.pidNamespace, undefined)
})

test('input snapshot, authority and content failures retain distinct recovery facts', () => {
  for (const [kind, expected] of [['stale-snapshot', 'stale-snapshot'], ['stale-or-foreign-batch', 'stale-snapshot'], ['foreign-input', 'authority-unavailable'], ['source-revoked', 'authority-unavailable'], ['content-changed', 'source-changed'], ['snapshot-schema', 'input-protocol']]) {
    const result = classifyChiefRecovery({ message: 'Receipt was refused', receiptFeedback: { kind } })
    assert.equal(result.kind, expected); assert.equal(result.retryable, false)
    assert.match(result.actions[0], /never rebase/)
  }
})
