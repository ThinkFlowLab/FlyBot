// The Project domain on the host runtime (#2830). The core used to install these six modules
// from `core/src/host/project-*.js`; it now hands the plugin its runtime through
// `flybot.projectHost()` and this file puts the same seams on it in the same order, so the core's
// store, meetings and channel call `rt.projectBoard`, `rt.projectChief`, `rt.projectTeam` and
// `rt.projectAssistant` exactly as before.
//
// Installing twice is a no-op: the domain is one set of registrations (two tools, the board
// endpoints' readers, the Project Chief and the assistant), and a second `ctx.tools.register` of
// the same name would fail the whole plugin. The marker lives on the runtime because that is the
// object the seams belong to.
import { install as installState } from './project-state.js'
import { install as installBoard } from './project-board.js'
import { install as installChief } from './project-chief.js'
import { install as installTeam } from './project-team.js'
import { install as installAssistant } from './project-assistant.js'

export const INSTALLED = 'flybotProjectDomain'

export function installProjectDomain(rt) {
  if (rt === null || typeof rt !== 'object') throw new Error('@flybot/project: installProjectDomain needs the host runtime')
  if (rt[INSTALLED] !== undefined) return rt[INSTALLED]
  // The order is the core's own `MODULES` order: the state reader is a leaf, the board reads it and
  // the metrics, the Chief and the dossier read the board's roles, and the assistant reads the
  // board and the state reader. The metrics module has no seam of its own — the board composes it.
  installState(rt)
  installChief(rt)
  installBoard(rt)
  installTeam(rt)
  installAssistant(rt)
  const domain = { chief: rt.projectChief, board: rt.projectBoard, team: rt.projectTeam, assistant: rt.projectAssistant }
  Object.defineProperty(rt, INSTALLED, { value: domain, configurable: true })
  return domain
}
