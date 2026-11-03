// Physical exit is independent of Bot deletion and of whether context can resume.
import { ownEntry } from './store.js'
import { nativeExitConfirmed } from './project-native-sessions.js'
import { confirmedWorkerExit } from './project-task-sessions.js'
import { supervisorProofMatches } from './project-process-proof.js'
export function executionExitConfirmed(rt, workerId) {
  if (rt.botOf(workerId)) return false
  const state = rt.state, sdk = ownEntry(state.projectHarnessWorkers ?? {}, workerId)
  if (sdk) return confirmedWorkerExit(state, sdk) && Boolean(!sdk.leaseId || ownEntry(state.projectResourceLeases ?? {}, sdk.leaseId)?.status === 'released')
  const native = ownEntry(state.projectNativeWorkers ?? {}, workerId)
  if (nativeExitConfirmed(state, native)) return !native.leaseId || ownEntry(state.projectResourceLeases ?? {}, native.leaseId)?.status === 'released'
  const leases = Object.values(state.projectResourceLeases ?? {}).filter(row => row.worker?.kind === 'native' && row.worker.botId === workerId)
  if (!leases.length) return false
  for (const lease of leases) if (lease.status !== 'released' || !supervisorProofMatches(lease.processScope, lease.releaseProof)) return false
  return true
}
