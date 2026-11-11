// #2877: "is the Project here" as a component asks it. `flybot-registry.js` keeps the answer the
// host gave (`plugins/list` → the switch on and the package attached) and the subscribers that
// redraw; this is the one hook the surfaces use so a Project row, page, board or header seat goes
// away when that answer lands, without waiting for a reload.
import { useEffect, useState } from 'react'
import { projectPresent, registry } from './flybot-registry.js'

export function useProjectPresent() {
  const slots = registry()
  const [present, setPresent] = useState(() => projectPresent())
  useEffect(() => {
    // The answer can land between this render and its effect; re-read it before subscribing.
    setPresent(projectPresent())
    return slots.subscribe(() => setPresent(projectPresent()))
  }, [slots])
  return present
}
