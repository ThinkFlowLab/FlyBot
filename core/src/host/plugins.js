// The FlyBot feature plugins and the owner's switch for each (#2564). The Project domain is one
// of them since #2830: its code lives in plugins/project and this switch is how an owner turns
// the whole domain (tools, board, Chief, assistant) off without uninstalling anything.
//
// The switch does not install or uninstall anything: the packages stay in the DSH
// profile as they are, and the answer lives in FlyBot's own state.json. A plugin reads
// it once, in its own `apply()` at start, and returns before registering anything when
// it is off — tools, slots, endpoints and prompt text all come from that call, so they
// disappear together and come back together. That is why a flip applies at the next
// start: nothing unloads from a running session.
import { readFileSync } from 'node:fs'

export const FEATURE_PLUGINS = Object.freeze([
  { id: 'social', name: 'Bot Social', package: '@flybot/social', purpose: "Chat with a friend's Bots on a Bot Social server." },
  { id: 'tree', name: 'Tree', package: '@flybot/tree', purpose: 'Run Bots as a tree under a coordinator.' },
  { id: 'timeline', name: 'Timeline', package: '@flybot/timeline', purpose: 'Read the team activity as a timeline.' },
  { id: 'workflow', name: 'Workflow', package: '@flybot/workflow', purpose: 'Run workflow graphs across several Bots.' },
  { id: 'project', name: 'Project', package: '@flybot/project', purpose: 'Run a Project: Project State, its board, its own Chief, its team and its assistant.' },
])

export const FEATURE_PLUGIN_IDS = Object.freeze(FEATURE_PLUGINS.map(plugin => plugin.id))

const known = id => FEATURE_PLUGIN_IDS.includes(id)

// The switches as the Settings page shows them: on unless state.json says off.
export function pluginSwitches(state) {
  const saved = state?.flybot?.plugins ?? {}
  return FEATURE_PLUGINS.map(plugin => ({ ...plugin, enabled: saved[plugin.id]?.enabled !== false }))
}

// Writes one switch into the state the next save persists. Only these ids are accepted,
// so a typo cannot grow a switch nobody reads.
export function setPluginSwitch(state, id, enabled) {
  const name = String(id ?? '')
  if (!known(name)) throw new Error(`flybot: unknown plugin ${JSON.stringify(name)}`)
  if (typeof enabled !== 'boolean') throw new Error('flybot: a plugin switch takes true or false')
  state.flybot ??= {}
  state.flybot.plugins ??= {}
  state.flybot.plugins[name] = { enabled }
  return pluginSwitches(state)
}

// Read at the plugin's own apply(), which runs before the host has loaded the team:
// the file the last run wrote is the answer, and a missing or unreadable file means
// "on", the same as a fresh install. An id this list does not know is left alone, so a
// plugin added later without a switch here keeps loading.
export function pluginEnabledAtStart(statePath, id) {
  if (!known(id)) return true
  try {
    return JSON.parse(readFileSync(statePath, 'utf8'))?.flybot?.plugins?.[id]?.enabled !== false
  } catch {
    return true
  }
}
