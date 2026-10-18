// DS Bot: a team of long-lived Bots on top of ordinary dsh root Sessions.
// Every Bot is one root Session; the roster, rooms, and the bot-to-bot exchange log live
// in one JSON file under DSH_HOME so they survive restarts without new Session event types.
import { join } from 'node:path'
import * as diagnostics from './src/host/diagnostics.js'
import * as store from './src/host/store.js'
import * as memberAuth from './src/host/member-auth.js'
import * as authz from './src/host/authz.js'
import * as roomMembership from './src/host/room-membership.js'
import * as reach from './src/host/reach.js'
import * as tasks from './src/host/tasks.js'
import * as models from './src/host/models.js'
import * as permissions from './src/host/permissions.js'
import * as turns from './src/host/turns.js'
import * as delivery from './src/host/delivery.js'
import * as roster from './src/host/roster.js'
import * as folders from './src/host/folders.js'
import * as agents from './src/host/agents.js'
import * as prompt from './src/host/prompt.js'
import * as timeContext from './src/host/time-context.js'
import * as tools from './src/host/tools.js'
import * as chatIndex from './src/host/chat-index.js'
import * as groups from './src/host/groups.js'
import * as approvals from './src/host/approvals.js'
import * as resume from './src/host/resume.js'
import * as memory from './src/host/memory.js'
import * as parts from './src/host/parts.js'
import * as images from './src/host/images.js'
import * as browser from './src/host/browser.js'
import * as secrets from './src/host/secrets.js'
import * as connectors from './src/host/connectors.js'
import * as connectorAccess from './src/host/connector-access.js'
import * as capabilities from './src/host/capabilities.js'
import * as schedules from './src/host/schedules.js'
import * as automationDefault from './src/host/automation-default.js'
import * as usage from './src/host/usage.js'
import * as update from './src/host/update.js'
import * as dshUpdate from './src/host/dsh-update.js'
import * as hooks from './src/host/hooks.js'
import * as remoteChat from './src/host/remote-chat.js'
import * as channel from './src/host/channel.js'

export { COLORS } from './src/host/constants.js'

export const name = 'ds-bot'
export const inject = ['llm', 'tools', 'systemPrompt', 'sessionController', 'sessions', 'sessionTitle', 'workspaceRegistry', 'connection']

// Each module's install(rt) registers its listeners, tools, and effects, and puts on `rt`
// the functions other modules call; they call them through `rt` at run time, never during
// install. Listeners run and tools are listed in registration order, so this order holds:
// usage meters model requests after every listener that rewrites them.
const MODULES = [diagnostics, store, memberAuth, authz, models, permissions, turns, delivery, roster, folders, agents, prompt, timeContext, tools, chatIndex, groups, roomMembership, reach, tasks, approvals, resume, memory, parts, images, secrets, connectors, connectorAccess, capabilities, schedules, automationDefault, browser, usage, update, dshUpdate, hooks, remoteChat, channel]

export function apply(ctx, config = {}) {
  const rt = createRuntime(ctx, config)
  // FlyBot: feature plugins reach the extension API as ctx.flybot (inject: ['flybot']).
  provideFlyBot(ctx, rt.flybot)
}

// Registers rt.flybot as the Cordis service `flybot`: ctx.provide where the context has it
// (Cordis 4 requires a provide before a service exists), else ctx.set, else a plain
// property for test contexts.
export function provideFlyBot(ctx, flybot) {
  const provide = typeof ctx.provide === 'function' ? ctx.provide.bind(ctx) : typeof ctx.reflect?.provide === 'function' ? ctx.reflect.provide.bind(ctx.reflect) : undefined
  if (provide) {
    provide('flybot', flybot)
    return
  }
  if (typeof ctx.set === 'function') {
    try {
      ctx.set('flybot', flybot)
      return
    } catch { /* the key is refused: fall through to the plain property */ }
  }
  ctx.flybot = flybot
}

export function createRuntime(ctx, config = {}) {
  const dshHome = folders.dshHomeOf(process.env.DSH_HOME)
  const home = config.home ?? join(dshHome, 'bot')
  const rt = {
    ctx,
    config,
    dshHome,
    home,
    statePath: join(home, 'state.json'),
    defaults: {
      mainName: config.mainName ?? 'Chief',
      mainRole: config.mainRole ?? 'Chief of Staff',
    },
  }
  for (const module of MODULES) module.install(rt)
  return rt
}
