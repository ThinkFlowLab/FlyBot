// DSH plugin entry for the FlyBot FlyBot runtime image.
// Boots the pinned DS-Bot runtime with the image's FlyBot integration and attaches the FlyBot social
// façade. This file must keep living at runtime/flybot-image/plugin/ so the
// relative imports into the vendored trees resolve. Do not copy it out of this
// layout; the image profile uses a link: dependency to this directory.
import { createRuntime } from '../../ds-bot-upstream/ds-bot/index.js'
import { applyOnRuntime } from '../../flybot-social-host/index.js'
import { registerFlybotRoute } from '../../flybot-web-slots/index.js'
import { loadBotSocialConfig } from '../bot-social-config.js'
import { startBridge, runTurn, prepareNativeChat, textOnlyCompletion } from '../ds-bot-bridge.mjs'
import { normalizeImportedSession } from '../../flybot-workspace-web/features/agents/history.js'
import { attachRuntime } from '../../flybot-workspace-web/src/host.js'
import { boundName } from '../../flybot-workspace-web/features/skills/index.js'
import { nativeSkillFilter, reconcileStartupSkills } from '../../flybot-workspace-web/features/skills/library.js'
import { assertNativeConsentOverlay } from '../native-ds-bot-overlay.mjs'

// This wrapper stands in for DS-Bot and also reads the native turn
// boundary projection when importing FlyBot's previous chat history.
export const name = 'flybot-workspace-flybot'
export const inject = ['agents', 'llm', 'tools', 'systemPrompt', 'sessionController', 'sessions', 'sessionTitle', 'workspaceRegistry', 'connection']

export function apply(ctx, config = {}) {
  assertNativeConsentOverlay()
  // Prepare is detached/read-only: no Session is entered, persisted or announced.
  // Install before core agent restoration, whose projections read old imports.
  normalizeImportedSession(ctx.sessions.prepare('flybot-workspace-import-schema-' + globalThis.crypto.randomUUID()))
  const dataDir = process.env.DSH_HOME ?? '/data'
  const filterNativeCapabilities = nativeSkillFilter(dataDir, boundName)
  const rt = createRuntime(ctx, { ...config, filterNativeCapabilities })
  ctx.effect(() => {
    void reconcileStartupSkills(rt, dataDir, boundName)
      .catch(error => rt.warn('flybot-workspace: could not reconcile startup skills: %s', error.name))
  }, 'flybot-workspace: startup skill consent')
  // Publish once, after the complete bridge services exist. Early pending imports
  // must not capture a permanently incomplete frozen runtime handle.
  const collaboration = loadBotSocialConfig()
  const attached = applyOnRuntime(rt, ctx, {
    inboxPollMs: 15_000,
    facePollMs: 4_000,
    presence: true,
    ...(config.social ?? {}),
    ...(collaboration.server ? {
      server: collaboration.server,
      ...(collaboration.displayName ? { displayName: collaboration.displayName } : {}),
    } : {}),
  })
  registerFlybotRoute(ctx, attached.flybot)
  // FlyBot features send native turns to this user's DS-Bot.
  if (config.flybotWorkspaceBridge !== false && process.env.FLYBOT_WORKSPACE_DS_BOT_BRIDGE !== '0') {
    const { bridge } = startBridge(rt, ctx)
    // Services for @flybot-workspace/web features (chat, skills): native DS-Bot turns in
    // this user's own runtime, serialized per Bot while its part is active.
    const chatTurn = async (key, text, requestId, {signal} = {}) => {
      signal?.throwIfAborted()
      const botId = await bridge.setup()
      return bridge.exclusive(async () => {
        signal?.throwIfAborted()
        await bridge.prepareModel()
        signal?.throwIfAborted()
        const sessionId = await bridge.selectConversation(key)
        signal?.throwIfAborted()
        bridge.requireModel(botId)
        return runTurn(rt, ctx, botId, text, requestId, undefined, [], {sessionId, signal})
      }, botId)
    }
    const mainBot = async () => { await bridge.setup(); return bridge.botId }
    const prepareMappedChat = async (botId, sessionId) => {
      await bridge.prepareModel()
      return prepareNativeChat(rt, botId, sessionId)
    }
    const attachmentStore = () => ctx.get?.('attachments')
    const nativeTurn = (botId, savedSessionId, text, requestId, options = {}) => bridge.exclusive(async () => {
      options.signal?.throwIfAborted()
      const sessionId = await prepareMappedChat(botId, savedSessionId)
      const parts = [], stored = []
      const uploads = ctx.get?.('fileUploads')
      for (const file of options.files || []) {
        if (!uploads) throw Object.assign(new Error('Native attachment service unavailable'), {code:'agents/attachment-unavailable'})
        const bytes = async function* () { yield file.data }
        const scope = {sessionId, name:file.title, data:bytes()}
        const image = file.mime.startsWith('image/')
        const result = image ? await uploads.uploadImageStream({...scope, mediaType:file.mime}) : await uploads.uploadStream(scope)
        // Prompt images may be normalized by DSH. A shared work's download
        // must keep the exact bytes of the saved revision.
        const original = file.resource && image
          ? await attachmentStore().saveFileStream({name:file.title,data:bytes()}) : null
        const ref = original || (image ? result.image : result.file)
        parts.push({type:'file', receiptId:result.receiptId})
        stored.push({title:file.title, mime:original ? file.mime : ref.mediaType || file.mime, bytes:ref.bytes, image:image && !original, ref})
      }
      if (stored.length) options.onStaged?.(stored)
      bridge.requireModel(botId)
      const turn = () => runTurn(rt, ctx, botId, text, requestId, undefined, parts, {
        sessionId, onProgress: options.onProgress, onPhase: options.onPhase, signal: options.signal,
        managedGroup: options.managedGroup, interactive: options.interactive,
      })
      return options.personalTeamScope && rt.flybotWorkspaceTeam
        ? rt.flybotWorkspaceTeam.run({botId,sessionId,requestId,scope:options.personalTeamScope}, turn)
        : turn()
    }, botId)
    const readNativeAttachment = async file => {
      const store = attachmentStore()
      if (!store) throw new Error('Native attachment service unavailable')
      if (file.image) return Buffer.from((await store.readImage(file.ref)).data)
      const chunks = []
      let bytes = 0
      for await (const chunk of store.readFileStream(file.ref)) {
        bytes += chunk.byteLength
        if (bytes > file.bytes) throw new Error('Native attachment size mismatch')
        chunks.push(chunk)
      }
      if (bytes !== file.bytes) throw new Error('Native attachment size mismatch')
      return Buffer.concat(chunks)
    }
    const privateText = (prompt, options) => textOnlyCompletion(bridge, prompt, options)
    attachRuntime({ rt, ctx, chatTurn, mainBot, prepareMappedChat, nativeTurn, readNativeAttachment,
      textOnly: privateText, backgroundTextOnly: privateText, exclusive: bridge.exclusive, legacySession: bridge.legacySession })
  } else attachRuntime({ rt, ctx })
  return attached
}

export { createRuntime }
