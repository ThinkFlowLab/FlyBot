// DSH plugin entry: FlyBot inside the user's own DS-Bot.
// Registers DSH-authenticated Fetch routes on the shared /api channel, including:
//   GET  /api/flybot-workspace/page?path=/chat/   the FlyBot pages bundled in the image
//   POST /api/flybot-workspace                    {endpoint: '<feature>/<op>', payload}
//   GET  /api/flybot-workspace/reply-stream        private reply events
// DSH applies its Host/Origin fence and browser-session authentication before
// either handler runs; this plugin adds no authentication bypass of its own.
// Features: features/<name>/index.js (src/features.js), never edits to this file.
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPageHandler, PAGE_PATH } from './src/pages.js'
import {
  createDispatch, API_PATH, createGatewayDispatch, GATEWAY_PATH, createLegacyDispatch, LEGACY_PATH,
  createReplyStreamDispatch, REPLY_STREAM_PATH,
} from './src/dispatch.js'
import { COMPUTER_PATH } from './src/computer.js'
import { runtime } from './src/host.js'
import { loadIdentity } from './src/identity.js'
import { CHAT_DIRECTORY_FEATURES, loadFeatures } from './src/features.js'

export const name = 'flybot-workspace-web'
export const inject = ['connection']

const HERE = dirname(fileURLToPath(import.meta.url))

export function apply(ctx, config = {}) {
  if (!ctx?.connection?.fetch?.register || !ctx?.effect) {
    throw new Error('flybot-workspace-web: dsh connection fetch registry is required')
  }
  const dataDir = config.dataDir ?? process.env.DSH_HOME ?? '/data'
  const identity = loadIdentity({ env: process.env, dataDir })
  const pagesDir = config.pagesDir ?? join(HERE, 'pages')
  const pageSettings = Promise.withResolvers()
  const chatDirectory = Promise.withResolvers()
  const features = loadFeatures({
    dir: config.featuresDir ?? join(HERE, 'features'), identity, dataDir,
    onRegistered(name, table, loaded) {
      if (name === 'settings') pageSettings.resolve(table['settings/get'])
      if (name === 'teams' && CHAT_DIRECTORY_FEATURES.every(feature => loaded.includes(feature))) {
        chatDirectory.resolve(table['teams/v1'])
      }
    },
  })
  // Even images without the settings feature can serve the default-language document.
  void features.then(({table}) => {
    pageSettings.resolve(table['settings/get'])
    chatDirectory.resolve(undefined)
  }, () => {
    pageSettings.resolve(undefined)
    chatDirectory.resolve(undefined)
  })
  const page = createPageHandler({
    pagesDir, identity,
    async getShellSettings() {
      const read = await pageSettings.promise
      const result = await read?.()
      return result?.settings?.values
    },
  })
  const dispatch = createDispatch({ endpoints: async () => (await features).table })
  ctx.effect(() => ctx.connection.fetch.register({
    path: PAGE_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: page,
  }), 'flybot-workspace-web: page route')
  ctx.effect(() => ctx.connection.fetch.register({
    path: API_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: dispatch,
  }), 'flybot-workspace-web: api route')
  ctx.effect(() => ctx.connection.fetch.register({
    path: REPLY_STREAM_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: createReplyStreamDispatch({ endpoints: async () => (await features).table }),
  }), 'flybot-workspace-web: private reply streams')
  ctx.effect(() => ctx.connection.fetch.register({
    path: COMPUTER_PATH,
    methods: ['GET', 'POST', 'DELETE'],
    requestBody: 'buffered',
    fetch: async request => {
      const { computers } = await runtime()
      if (!computers) return new Response(null, {status:404})
      return computers.handler(async (workspace_id, id) => {
        const {table} = await features
        return table['agents/computerTarget']?.({workspace_id,id},{internal:true}).catch(() => null)
      })(request)
    },
  }), 'flybot-workspace-web: Bot computer')
  // External Agent API: the platform forwards /v1/gateway/* here (cookie = this
  // DS-Bot's launch session; token = X-OT-Gateway-Token, already bound to this instance).
  ctx.effect(() => ctx.connection.fetch.register({
    path: GATEWAY_PATH,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: createGatewayDispatch({ endpoints: async () => (await features).table }),
  }), 'flybot-workspace-web: external agent api')
  ctx.effect(() => ctx.connection.fetch.register({
    path: LEGACY_PATH,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE'],
    requestBody: 'buffered',
    fetch: createLegacyDispatch({ endpoints: async () => (await features).table, chatDirectory: chatDirectory.promise }),
  }), 'flybot-workspace-web: legacy /v1')
  return { identity, features }
}

export { attachRuntime } from './src/host.js'
