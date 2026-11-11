// The host helpers the plugin needs, bound from the core's own implementations (test-only).
//
// At runtime `apply()` binds them from `flybot.projectHost()`; a unit test of a pure function
// (rolesOf, buildDigest, blockedOf) needs them without a whole runtime, and binding the core's
// modules by their repo path is the same set the seam carries. `test/host.test.js` checks that the
// seam's list and this one are the same names, so a helper added to one cannot be missing from the
// other. The path is the repo checkout, the way plugins/tree/test/identity.test.js reads the core's
// identity module.
import { bindHost } from '../src/host.js'
import { ASSISTANT_ROLE, MAX_ENTRY } from '../../../core/src/host/constants.js'
import { dayKey } from '../../../core/src/host/day-key.js'
import { advanceRefusal } from '../../../core/src/host/meetings.js'
import { dirKind } from '../../../core/src/host/real-dir.js'
import { codePoints, cut } from '../../../core/src/host/text.js'
import { defineTool } from '../../../core/src/host/tool-schema.js'
import { output } from '../../../core/src/host/tools.js'
import { workDirFor } from '../../../core/src/host/work-dir.js'
import { clockIn, inQuietHours, quietHoursOf, readQuietHours } from '../../../core/src/shared/quiet-hours.js'
import { columnOf, priorityOf } from '../../../core/src/shared/task-board.js'

export const HELPERS = {
  cut,
  codePoints,
  dirKind,
  defineTool,
  output,
  columnOf,
  priorityOf,
  advanceRefusal,
  workDirFor,
  dayKey,
  MAX_ENTRY,
  ASSISTANT_ROLE,
  inQuietHours,
  clockIn,
  quietHoursOf,
  readQuietHours,
}

bindHost(HELPERS)
