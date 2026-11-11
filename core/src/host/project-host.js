// The Project domain's host seam (#2830). The domain — Project State, the board, the Project's own
// Chief, the team dossier, the metrics and the assistant — moved to `plugins/project`, which ships
// as its own package and therefore cannot import `core/src/*`. The core hands it the two things it
// cannot get by itself: the runtime it puts its seams on, and the pure helpers the two packages
// share (one function each, never a copy: a second implementation of `cut` or `dayKey` would drift).
//
// The seam is the *core's* side of the contract, not a third-party plugin surface: only
// `plugins/project` asks for it, and only in its `apply()`. A core without the plugin installed
// never calls it — the store's Project endpoints then keep the fallbacks they already have (a
// Project is created without a Chief or an assistant, the board and the dossier answer empty).
//
// Every helper is a pure function or a constant; nothing here reads state or writes anything when
// the object is built, so a caller can build it once at startup.
import { ASSISTANT_ROLE, MAX_ENTRY } from './constants.js'
import { dayKey } from './day-key.js'
import { advanceRefusal } from './meetings.js'
import { dirKind } from './real-dir.js'
import { codePoints, cut } from './text.js'
import { defineTool } from './tool-schema.js'
import { output } from './tools.js'
import { workDirFor } from './work-dir.js'
import { clockIn, inQuietHours, quietHoursOf, readQuietHours } from '../shared/quiet-hours.js'
import { columnOf, priorityOf } from '../shared/task-board.js'

export const HELPER_NAMES = Object.freeze([
  'cut', 'codePoints', 'dirKind', 'defineTool', 'output', 'columnOf', 'priorityOf', 'advanceRefusal',
  'workDirFor', 'dayKey', 'MAX_ENTRY', 'ASSISTANT_ROLE',
  'inQuietHours', 'clockIn', 'quietHoursOf', 'readQuietHours',
])

export function projectHost(rt) {
  return {
    // The live runtime: the seams the domain installs (`rt.projectBoard`, `rt.projectChief`,
    // `rt.projectTeam`, `rt.projectAssistant`) are the ones the core's store, meetings and channel
    // already call by those names.
    runtime: rt,
    helpers: {
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
    },
  }
}
