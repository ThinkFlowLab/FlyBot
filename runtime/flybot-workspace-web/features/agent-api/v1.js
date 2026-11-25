// Owner-side API key routes used by the /agents/ page. External invoke stays
// on /v1/gateway/* (platform auth + forward).
import { FeatureError } from '../../featurekit/http.js'
import { createV1Endpoint } from '../../featurekit/v1.js'

const HEX = '([0-9a-f]{32})'

function wrap(fn) {
  return async (...args) => {
    try { return await fn(...args) } catch (error) {
      if (error instanceof FeatureError) throw error
      const code = String(error?.code ?? 'error').replace(/^agent-api\//, '')
      throw new FeatureError(error?.status ?? 500, code.replace(/-/g, '_'), error?.message ?? 'Request failed')
    }
  }
}

export function agentApiV1({ endpoints, log }) {
  const call = (name, payload) => endpoints[name](payload)
  const routes = [
    { pattern: new RegExp(`^/v1/workspaces/${HEX}/agents/${HEX}/api-keys/${HEX}/revoke$`), handle: wrap(async (req, workspaceId, agentId, keyId) => {
      const result = await call('key-revoke', { workspace_id: workspaceId, agent_id: agentId, key_id: keyId })
      return { status: 200, body: { key: result.key } }
    }) },
    { pattern: new RegExp(`^/v1/workspaces/${HEX}/agents/${HEX}/api-keys$`), handle: wrap(async (req, workspaceId, agentId) => {
      if (req.method === 'GET') return { status: 200, body: await call('keys', { workspace_id: workspaceId, agent_id: agentId }) }
      if (req.method === 'POST') {
        const body = await req.json()
        const result = await call('key-create', { workspace_id: workspaceId, agent_id: agentId, name: body.name, rate_per_minute: body.rate_per_minute })
        return { status: result.status ?? 201, body: { key: result.key, token: result.token } }
      }
      throw new FeatureError(400, 'invalid', 'Invalid API key request')
    }) },
  ]
  return createV1Endpoint({ feature: 'agent-api', routes, context: { log } })
}
