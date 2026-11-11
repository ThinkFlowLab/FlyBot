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
//
// `enabled` is only the owner's wish. Whether the package is in this profile at all is a
// second fact, read from the profile itself (#2868): a switch can be on for a plugin that
// was never installed, and then the domain does not exist in the process whatever the row says.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const FEATURE_PLUGINS = Object.freeze([
  { id: 'social', name: 'Bot Social', package: '@flybot/social', purpose: "Chat with a friend's Bots on a Bot Social server." },
  { id: 'tree', name: 'Tree', package: '@flybot/tree', purpose: 'Run Bots as a tree under a coordinator.' },
  { id: 'timeline', name: 'Timeline', package: '@flybot/timeline', purpose: 'Read the team activity as a timeline.' },
  { id: 'workflow', name: 'Workflow', package: '@flybot/workflow', purpose: 'Run workflow graphs across several Bots.' },
  { id: 'project', name: 'Project', package: '@flybot/project', purpose: 'Run a Project: Project State, its board, its own Chief, its team and its assistant.' },
])

export const FEATURE_PLUGIN_IDS = Object.freeze(FEATURE_PLUGINS.map(plugin => plugin.id))

const known = id => FEATURE_PLUGIN_IDS.includes(id)

// The bundles this profile loads, as dsh reads them (dsh.profile.bundles) — the one list
// that says a plugin's code is here. `undefined` means there is no profile to ask: a test
// host or an embedder. Then a row keeps its old shape instead of claiming a plugin is gone,
// because that answer would be a guess (#2868).
export function profileBundles(profileDir) {
  if (typeof profileDir !== 'string' || profileDir === '') return undefined
  try {
    const profile = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
    const bundles = profile?.dsh?.profile?.bundles
    return new Set(Array.isArray(bundles) ? bundles.filter(bundle => typeof bundle === 'string') : [])
  } catch {
    return undefined
  }
}

// The switches as the Settings page shows them: on unless state.json says off. `installed`
// is the profile's answer, not the switch's: an owner can ask for a plugin this profile
// never got, and then the row says both — asked for, and not here.
export function pluginSwitches(state, bundles) {
  const saved = state?.flybot?.plugins ?? {}
  return FEATURE_PLUGINS.map(plugin => ({
    ...plugin,
    enabled: saved[plugin.id]?.enabled !== false,
    ...(bundles instanceof Set ? { installed: bundles.has(plugin.package) } : {}),
  }))
}

// Writes one switch into the state the next save persists. Only these ids are accepted,
// so a typo cannot grow a switch nobody reads.
export function setPluginSwitch(state, id, enabled, bundles) {
  const name = String(id ?? '')
  if (!known(name)) throw new Error(`flybot: unknown plugin ${JSON.stringify(name)}`)
  if (typeof enabled !== 'boolean') throw new Error('flybot: a plugin switch takes true or false')
  state.flybot ??= {}
  state.flybot.plugins ??= {}
  state.flybot.plugins[name] = { enabled }
  return pluginSwitches(state, bundles)
}

// The five switches in one read, as they answer at a start: the plugin's own apply() and
// the restart banner ask the same file, so they cannot disagree. A missing or unreadable
// file means "on", the same as a fresh install.
export function pluginSwitchesAtStart(statePath) {
  let saved = {}
  try {
    saved = JSON.parse(readFileSync(statePath, 'utf8'))?.flybot?.plugins ?? {}
  } catch {
    saved = {}
  }
  const atStart = {}
  for (const id of FEATURE_PLUGIN_IDS) atStart[id] = saved?.[id]?.enabled !== false
  return atStart
}

// Which switches no longer answer what this start read. Only those need a restart: a
// flip that comes back to the start value leaves nothing for the next start to load.
export function pluginSwitchesPending(state, atStart) {
  const pending = {}
  for (const plugin of pluginSwitches(state)) pending[plugin.id] = plugin.enabled !== atStart?.[plugin.id]
  return pending
}

// Read at the plugin's own apply(), which runs before the host has loaded the team:
// the file the last run wrote is the answer, and a missing or unreadable file means
// "on", the same as a fresh install. An id this list does not know is left alone, so a
// plugin added later without a switch here keeps loading.
export function pluginEnabledAtStart(statePath, id) {
  if (!known(id)) return true
  return pluginSwitchesAtStart(statePath)[id]
}
