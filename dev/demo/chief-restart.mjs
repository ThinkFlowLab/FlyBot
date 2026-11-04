// Real unmanaged DSH restart and original scheduled delivery; inference is a fixture.
import assert from 'node:assert/strict'
export function chiefRestartModel() {
  let calls = 0, release
  return {
    get started() { return calls > 0 },
    finishHeld() { release?.([{ type: 'text', text: '{"summary":"Late old invocation","decisions":[]}' }]) },
    reply({ body }) {
      if (!JSON.stringify(body.messages ?? []).includes('chief-unmanaged-restart-fixture')) return undefined
      if (++calls === 1) return new Promise(resolve => { release = resolve })
      return [{ type: 'text', text: '{"summary":"Inspected the current shared state after recovery","decisions":[]}' }]
    },
  }
}
export async function checkChiefRestart({ api, saved, waitFor, restart, model }) {
  const invite = await api('auth-invite'), owner = await api('auth-redeem', { token: invite.token, displayName: 'Recovery fixture owner' })
  const call = (endpoint, body = {}) => api(endpoint, body, owner.sessionToken)
  const { project } = await call('project-create', { name: 'Disposable unmanaged Chief restart', repository: null })
  await call('project-agents', { projectId: project.id })
  await call('project-chief-configure', { projectId: project.id, enabled: true, inspection: { prompt: 'chief-unmanaged-restart-fixture: inspect only current shared facts', when: { kind: 'every', seconds: 60 }, lifecycle: { runTimeoutMs: 60000, queueTimeoutMs: 60000, recoveryDelayMs: 100, maxRecoveries: 2, stopTimeoutMs: 500, maxStopAttempts: 2 } } })
  await call('project-chief-inspect', { projectId: project.id, requestId: 'first-held-inspection' })
  const prior = await waitFor(() => {
    const run = Object.values(saved()?.projectExecutions ?? {}).find(row => row.projectId === project.id && row.purpose === 'inspection' && row.status === 'running')
    return model.started && run?.workerId && run.executionBoundary?.kind === 'native-in-process' ? run : null
  }, 'first native inspection is actually answering')
  assert.equal(prior.processScope.kind, 'unmanaged-process')
  assert.match(prior.processScope.pidNamespace, /^pid:\[\d+\]$/)
  const chief = saved().projectAgents[`public-${project.id}`], began = Date.now()
  await restart()
  model.finishHeld()
  const outcome = await waitFor(async () => {
    const current = await call('project-chief-state', { projectId: project.id })
    const scheduled = current.runs.find(row => row.source?.scheduleId && row.source?.occurrenceId && row.status === 'done')
    return current.health.lastSuccessAt >= began && scheduled ? { current, scheduled } : null
  }, 'post-restart original scheduled occurrence completes')
  const old = saved().projectExecutions[prior.id]
  assert.equal(old.exitProof.kind, 'native-chief-prior-host-exited')
  assert.equal(saved().projectAgents[`public-${project.id}`].sessionId, chief.sessionId)
  assert.equal(new Set((old.invocationHistory ?? []).map(row => row.number)).size, (old.invocationHistory ?? []).length)
  assert.ok(outcome.current.health.lastSuccessAt)
  assert.equal(Object.values(saved().tasks).filter(task => task.projectId === project.id).length, 0)
  return { milestone: '2347-unmanaged-chief-restart', runtime: 'actual DSH', transport: 'real DSH HTTP', model: 'deterministic fixture', recoveryMs: Date.now() - began,
    checks: ['actual unmanaged host killed during native Chief inspection', 'birth-checked prior native host exit', 'same resident Chief Session', 'later original scheduled occurrence completed without manual inspect', 'late old result cannot add an invocation verdict'],
    notRun: ['paid model', 'live project', 'unknown external SDK/container exit recovery', 'deployment'] }
}
