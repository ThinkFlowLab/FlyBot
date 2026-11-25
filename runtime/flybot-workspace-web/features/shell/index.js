// Core shell feature: proves the request reached this user's own DS-Bot.
import { PLUGIN_VERSION } from '../../src/dispatch.js'

export default function shell(host) {
  return {
    endpoints: {
      async identity() {
        return {
          served_by: 'ds-bot',
          plugin: '@flybot-workspace/web',
          version: PLUGIN_VERSION,
          instance_id: host.identity.instanceId,
          runtime_attached: Boolean(host.currentRuntime()),
        }
      },
    },
  }
}
