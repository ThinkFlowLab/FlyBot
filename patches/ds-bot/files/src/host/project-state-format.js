// A physical format fence prevents old JSON binaries from replaying new contracts.
const FORMAT = 'flybot-project-state/v1'
export function encodeProjectState(state) {
  if (!state.projectCompatibility && !Object.values(state.tasks ?? {}).some(task => task.projectTask)) return state
  return { ...state, version: 4, stateFormat: FORMAT, logicalVersion: 2 }
}
export function decodeProjectState(state) {
  if (state?.version !== 4 || state.stateFormat !== FORMAT || state.logicalVersion !== 2) return state
  const { stateFormat: _format, logicalVersion: _version, ...logical } = state
  return { ...logical, version: 2 }
}
