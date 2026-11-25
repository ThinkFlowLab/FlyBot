// The FlyBot data root, resolved the way the core does (core/src/host/folders.js#dshHomeOf):
// a blank DSH_HOME counts as unset, `~` expands, and the answer is absolute. A peer plugin
// cannot import core/, so the rule is kept here rather than depending on a core path.
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const expandHome = text => (text === '~' ? homedir() : /^~[\\/]/.test(text) ? join(homedir(), text.slice(2)) : text)

export const dshHomeOf = (value = process.env.DSH_HOME) => resolve(expandHome(value?.trim() ? value : join(homedir(), '.dsh')))
