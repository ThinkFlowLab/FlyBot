// The Project domain, applied to a runtime the way a profile has it (#2684).
//
// The domain — Project State, the board, the Project's own Chief, the team dossier, the metrics
// and the assistant — lives in `plugins/project` now, and it installs its seams in its own
// `apply()`. A core test that reads a Project through the store, the channel or the board needs
// the plugin applied to the runtime it built, exactly as a profile mounts it; the plugin's own
// suite covers the domain itself and lives in `plugins/project/test/`.
import { apply as applyProject } from '../../plugins/project/index.js'

export function installProjectDomain(rt) {
  return applyProject({ flybot: rt.flybot })
}
