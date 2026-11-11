// The helpers this package takes from its host (#2830). The Project plugin ships as its own
// package, so its code cannot import `core/src/*`; the core hands the few pure helpers the two
// packages share over through `flybot.projectHost()` in the plugin's `apply()`.
//
// Every function here reads the binding at call time, so a module-scope arrow that closes over
// `cut` (the board's `oneLine`, the dossier's `capped`) keeps working after the bind. A package
// used without `apply()` — a unit test of a pure function — binds the core's own implementations
// in `test/host.js`, which is also the check that the seam carries the functions this package
// thinks it does.
let bound = null

// The values below are only placeholders until the host binds: they are the numbers and labels
// the core owns (`core/src/host/constants.js`), and `test/host.test.js` holds the two together.
export let MAX_ENTRY = 600
export let ASSISTANT_ROLE = 'Project Assistant'
export let output = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] }

export function bindHost(helpers) {
  if (helpers === null || typeof helpers !== 'object') throw new Error('@flybot/project: the host seam must hand over an object of helpers')
  for (const name of REQUIRED) {
    if (helpers[name] === undefined) throw new Error(`@flybot/project: the host seam is missing "${name}"`)
  }
  bound = helpers
  MAX_ENTRY = helpers.MAX_ENTRY
  ASSISTANT_ROLE = helpers.ASSISTANT_ROLE
  output = helpers.output
  return bound
}

export function boundHost() {
  return bound
}

// The helpers without which the domain cannot answer: a host that binds a partial bag fails at
// `apply()` with the name, not at the first board read with a TypeError.
export const REQUIRED = Object.freeze([
  'cut', 'codePoints', 'dirKind', 'defineTool', 'output', 'columnOf', 'priorityOf', 'advanceRefusal',
  'workDirFor', 'dayKey', 'MAX_ENTRY', 'ASSISTANT_ROLE',
  'inQuietHours', 'clockIn', 'quietHoursOf', 'readQuietHours',
])

const need = (name) => {
  const value = bound?.[name]
  if (typeof value !== 'function') throw new Error(`@flybot/project: the host helper "${name}" is not bound; the plugin's apply() binds it`)
  return value
}

export const cut = (text, max) => need('cut')(text, max)
export const codePoints = text => need('codePoints')(text)
export const dirKind = path => need('dirKind')(path)
export const defineTool = def => need('defineTool')(def)
export const columnOf = task => need('columnOf')(task)
export const priorityOf = task => need('priorityOf')(task)
export const advanceRefusal = meeting => need('advanceRefusal')(meeting)
export const workDirFor = (runtime, exec) => need('workDirFor')(runtime, exec)
export const dayKey = (ms, timeZone) => need('dayKey')(ms, timeZone)
export const inQuietHours = (...args) => need('inQuietHours')(...args)
export const clockIn = (...args) => need('clockIn')(...args)
export const quietHoursOf = (...args) => need('quietHoursOf')(...args)
export const readQuietHours = (...args) => need('readQuietHours')(...args)
