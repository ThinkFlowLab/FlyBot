// @flybot/project host plugin (dsh / cordis plugin shape, same as ds-bot: name + inject + apply).
// The Project domain — Project State, the board, the Project's own Chief, its team dossier, its
// metrics and its assistant — lives in src/, moved out of the core's `src/host/project-*.js`
// (#2830). The core owns the runtime and the few pure helpers the two packages share; this
// plugin asks for them through `flybot.projectHost()` and installs the same seams on that
// runtime the core used to install itself, so `rt.projectBoard`, `rt.projectChief`,
// `rt.projectTeam`, `rt.projectAssistant` and the `project_state` / `project_digest` tools are
// exactly what they were.
//
// Owner switch (#2564): off means this process registers none of the domain's tools, endpoints,
// prompt text or background work. Read at start, so it applies at the next launch.
import { bindHost } from './src/host.js'
import { installProjectDomain } from './src/install.js'

export const name = 'flybot-project'
export const inject = ['flybot']

export function apply(ctx) {
  if (ctx.flybot?.pluginEnabled?.('project') === false) return { project: undefined, dispose() {} }
  const seam = ctx.flybot?.projectHost?.()
  // A core older than this plugin has no Project host seam. Nothing is registered and the core's
  // store keeps its own fallback (a Project is created without a Chief or an assistant), which is
  // the behavior that core has when its domain modules are not installed at all.
  if (seam === undefined || seam.runtime === undefined) {
    ctx.flybot?.warn?.('flybot-project: this core has no Project host seam, so none of the Project domain is registered (#2830)')
    return { project: undefined, dispose() {} }
  }
  bindHost(seam.helpers)
  const project = installProjectDomain(seam.runtime)
  // Nothing here polls or holds a timer: every answer is built when it is asked for, and the one
  // background beat (the 09:00 digest) is a DSH schedule on the assistant's own Session.
  const dispose = () => {}
  if (typeof ctx.effect === 'function') ctx.effect(() => dispose, 'flybot-project')
  else ctx.on?.('dispose', dispose)
  return { project, dispose }
}
