// The Session's working folder (#2684): the cwd its Agent runs in, else the folder the Bot or room
// is set to work in, else the team workspace. Undefined only when none of them is known.
//
// This lived in `project-state.js` while that reader was the only caller; the meetings module
// needs the same answer (the folder a decision is archived in), so it is its own module now that
// the Project domain moved to `plugins/project` — the plugin gets it back through the host seam
// `flybot.projectHost()` (`core/src/host/project-host.js`).
export function workDirFor(rt, exec) {
  const cwd = exec?.agent?.session?.header?.cwd
  if (typeof cwd === 'string' && cwd !== '') return cwd
  const botId = rt.selfOf?.(exec?.agent?.id) ?? exec?.agent?.id
  const dir = rt.workDirOf?.({ botId, roomId: exec?.agent?.session?.header?.roomId })
  if (typeof dir === 'string' && dir !== '') return dir
  return rt.teamFolder?.()
}
