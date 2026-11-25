// B4 connectors feature: the user's own Composio key/connections, custom MCP
// servers and per-call owner approvals, executed in this user's DS-Bot and
// exposed to it as the native MCP capability "ot-apps" (loopback, token path).
// Endpoints: connectors/<op> and connectors/v1 (legacy /v1/composio/* and
// /v1/mcp/servers* compat). /v1/composio/callback stays on the platform (it is
// a static bounce page). Composio is strictly per-user: no admin fallback.
import { join } from 'node:path'
import { compatHandler } from '../../lib/b4/compat.js'
import { loadSealKey, loadImportSealKey } from '../../lib/b4/seal.js'
import { importJsonBundles } from '../../lib/b4/importer.js'
import { createConnectors, importApplier, IMPORT_TABLES } from './connectors.js'
import { createCapabilityPublisher, startToolServer } from './tool-server.js'

export default function connectors(host) {
  const dir = host.featureDir()
  const sealKey = loadSealKey({ fallbackFile: join(dir, 'seal.key'), preferFallback: true })
  const api = createConnectors({ dir, sealKey, identity: host.identity })
  const imported = importJsonBundles({ host, feature: { name: 'connectors', importTables: IMPORT_TABLES }, store: api.store, sealKey: loadImportSealKey(), apply: importApplier(sealKey), log: host.log })
  let sync = async () => false
  if (process.env.FLYBOT_WORKSPACE_APPS_MCP !== '0') {
    const tools = startToolServer(api, { port: Number(process.env.FLYBOT_WORKSPACE_APPS_MCP_PORT) || 0 })
    tools.server.unref?.()
    const publisher = createCapabilityPublisher({ runtime: () => host.currentRuntime(), ready: tools.ready, wanted: api.hasTools })
    let pending = null
    sync = () => {
      clearTimeout(pending)
      pending = null
      return publisher.sync()
    }
    const schedule = (delay = 0) => {
      if (pending) return
      pending = setTimeout(() => { pending = null; sync().then((done) => { if (done === false && !host.currentRuntime()?.mainBot) schedule(5000) }).catch(error => { host.log(`apps capability sync failed: ${String(error?.code ?? error?.message ?? 'error').slice(0, 80)}`); schedule(15000) }) }, delay)
      pending.unref?.()
    }
    const apps = Object.freeze({ connectedToolkits: api.connectedToolkits, sync })
    const attach = runtime => {
      if (!runtime?.rt) return
      runtime.rt.flybotWorkspaceApps = apps
      schedule()
    }
    api.onChange(() => { publisher.invalidate(); schedule(250) })
    const current = host.currentRuntime()
    if (current?.rt) attach(current)
    else host.runtime({ timeoutMs: 600_000 }).then(attach, () => {})
  }
  return {
    imported,
    pages: ['settings'],
    endpoints: {
      overview: async () => api.overview(),
      approvals: async () => api.approvals(),
      decide: async payload => api.decide(payload?.id, { decision: payload?.decision }),
      servers: async () => api.listServers(),
      tools: async () => ({ tools: await api.discover({ force: true }) }),
      syncCapability: async () => ({ attached: await sync() }),
      v1: compatHandler(api.legacy),
    },
  }
}
