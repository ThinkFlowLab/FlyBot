// Native FlyBot services run inside the user's DS-Bot plugin. Its model
// provider holds a per-boot placeholder token and talks to this loopback proxy.
// Only the proxy resolves the user's model settings or the operator startup
// file and forwards the configured model name and secret to the upstream.
import { randomBytes } from 'node:crypto'
import { createServer, request as httpRequest } from 'node:http'
import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { splitRef } from '../ds-bot-upstream/ds-bot/src/host/text.js'
import { addPrivateChat, livePrivateChat } from '../flybot-workspace-web/lib/native-chat.js'
import { request as httpsRequest } from 'node:https'
import { STREAM_LIMIT, streamHttpTask, validateModelEndpoint } from './model-http-policy.mjs'
import { loadModelApi, redact } from './model-api.js'

export const MODEL_OVERRIDE = Symbol.for('flybot-workspace.model-api.override')
export function userModelOverride(scope = globalThis) {
  const resolve = scope[MODEL_OVERRIDE]
  if (typeof resolve !== 'function') return null
  try { return resolve() || null } catch { return null }
}
export const PROVIDER = 'flybot-workspace'
export const MODEL_ID = 'flybot-workspace-model'
const MODEL_REF = `${PROVIDER}/${MODEL_ID}`
function modelInput(modelApi) {
  const model = String(modelApi?.model || '').toLowerCase()
  const isDeepSeekFlash = model === 'deepseek-flash' || model === 'deepseek-v4-flash-vision-exp'
    || /^deepseek-v4\.1-flash(?:-\d{4,8})?$/.test(model)
  return isDeepSeekFlash ? ['text','image'] : ['text']
}

function providerModel(input) {
  return {id:MODEL_ID,name:'FlyBot model',contextWindow:128000,maxTokens:8192,input}
}

export const DEFAULT_PORT = 18731
const BODY_LIMIT = 24 * 1024 * 1024

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > BODY_LIMIT) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value))
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': body.length, 'Cache-Control': 'no-store' })
  res.end(body)
}

// Forward one OpenAI chat-completions request to the configured upstream. The
// model name and credential always come from modelApi, never from DS-Bot.
export async function forwardModel(modelApi, raw, res, { httpRequester = httpRequest, httpsRequester = httpsRequest } = {}) {
  const httpTask = validateModelEndpoint(modelApi?.base_url, modelApi?.http_endpoint_grant)
  const base = httpTask ? modelApi.base_url : String(modelApi.base_url || '').replace(/\/+$/, '')
  let parsed
  try { parsed = JSON.parse(raw.toString('utf8')) } catch { return sendJson(res, 400, { error: { message: 'invalid JSON body' } }) }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return sendJson(res, 400, { error: { message: 'invalid body' } })
  parsed.model = modelApi.model
  const body = Buffer.from(JSON.stringify(parsed))
  const headers = {
    'Authorization': 'Bearer ' + modelApi.api_key,
    'Content-Type': 'application/json',
    'Accept': parsed.stream ? 'text/event-stream' : 'application/json',
    'Content-Length': body.length,
  }
  const relay = (status, upstreamHeaders, stream) => new Promise(resolve => {
    res.writeHead(status, { 'Content-Type': upstreamHeaders['content-type'] || 'application/json', 'Cache-Control': 'no-store' })
    let bytes = 0
    stream.on('data', chunk => { bytes += chunk.length; if (bytes > STREAM_LIMIT) stream.destroy(new Error('model response too large')) })
    res.on('close', () => { if (!res.writableFinished) stream.destroy() })
    stream.pipe(res)
    stream.on('end', resolve)
    stream.on('error', () => { res.destroy(); resolve() })
    stream.on('close', resolve)
  })
  const downstream = new AbortController()
  const closed = () => { if (!res.writableFinished) downstream.abort() }
  res.once?.('close', closed)
  if (res.destroyed) closed()
  const signal = AbortSignal.any([downstream.signal, AbortSignal.timeout(180000)])
  try {
    if (httpTask) {
      return await streamHttpTask(base, modelApi.http_endpoint_grant, { method: 'POST', redirect: 'error', headers, body, signal }, relay, httpRequester)
    }
    const url = new URL(base + '/chat/completions')
    const requester = url.protocol === 'https:' ? httpsRequester : httpRequester
    return await new Promise((resolve, reject) => {
      const req = requester(url, { method: 'POST', headers, agent: false, signal }, response => {
        if (response.statusCode >= 300 && response.statusCode < 400) { response.destroy(); reject(new Error('Model redirect rejected')); return }
        resolve(relay(response.statusCode, response.headers, response))
      })
      req.on('error', () => reject(new Error('model request failed')))
      req.end(body)
    })
  } finally { res.off?.('close', closed) }
}

// Loopback model server for the native DS-Bot provider.
export function createBridgeServer(state, { log = () => {}, forward = forwardModel } = {}) {
  return createServer(async (req, res) => {
    try {
      // Browsers attach Origin; nothing legitimate here does (DNS-rebinding guard).
      if (req.headers.origin !== undefined) return sendJson(res, 403, { error: { message: 'forbidden' } })
      const path = (req.url || '').split('?')[0]
      if (path === '/v1/models' && req.method === 'GET') {
        if (req.headers.authorization !== 'Bearer ' + state.token) return sendJson(res, 401, { error: { message: 'unauthorized' } })
        return sendJson(res, 200, { object: 'list', data: [{ id: MODEL_ID, object: 'model', owned_by: 'flybot-workspace' }] })
      }
      if (path === '/v1/chat/completions' && req.method === 'POST') {
        if (req.headers.authorization !== 'Bearer ' + state.token) return sendJson(res, 401, { error: { message: 'unauthorized' } })
        const raw = await readBody(req)
        const modelApi = state.startupModel()
        if (!modelApi) return sendJson(res, 503, { error: { message: 'No model is configured for this FlyBot runtime yet.' } })
        try { await forward(modelApi, raw, res) } catch (error) {
          if (res.destroyed) return
          log('ds-bot-bridge: model upstream failed: ' + redact(error?.message || 'error'))
          if (!res.headersSent) sendJson(res, 502, { error: { message: 'upstream model request failed' } })
          else res.destroy()
        }
        return
      }
      sendJson(res, 404, { error: { message: 'not found' } })
    } catch (error) {
      if (!res.headersSent) sendJson(res, error?.status || 400, { error: { message: 'bad request' } })
    }
  })
}

const PROGRESS_TEXT_LIMIT = 20_000
const PROGRESS_INTERVAL_MS = 50

async function streamedCompletion(body, onProgress) {
  if (!body) throw new Error('Text inference did not return a stream')
  let pending = '', text = ''
  for await (const chunk of body.pipeThrough(new TextDecoderStream())) {
    pending += chunk
    let frame
    while ((frame = /\r?\n\r?\n/.exec(pending))) {
      const data = pending.slice(0, frame.index).split(/\r?\n/)
        .filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
      pending = pending.slice(frame.index + frame[0].length)
      if (!data) continue
      if (data === '[DONE]') return text
      const payload = JSON.parse(data)
      if (payload.error) throw new Error('Text inference stream failed')
      const choice = payload.choices?.[0]
      const next = choice?.delta?.content
      if (typeof next === 'string' && next) {
        text += next.slice(0, PROGRESS_TEXT_LIMIT - text.length)
        onProgress(text.toWellFormed())
      }
      if (choice?.finish_reason === 'stop' || choice?.finish_reason === 'length' ||
          text.length === PROGRESS_TEXT_LIMIT) return text
    }
    if (pending.length > 512 * 1024) throw new Error('Text inference event is too large')
  }
  throw new Error('Text inference stream ended early')
}

export async function textOnlyCompletion(bridge, prompt, {system, onProgress, signal} = {}) {
  await bridge.setup()
  const stream = typeof onProgress === 'function'
  const timeout = AbortSignal.timeout(170000)
  const messages = [...(system ? [{role:'system', content:system}] : []), {role:'user', content:prompt}]
  const response = await fetch(bridge.baseURL + '/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + bridge.state.token },
    body: JSON.stringify({ model: MODEL_ID, messages, stream }),
    signal: signal ? AbortSignal.any([timeout, signal]) : timeout, redirect: 'error',
  })
  if (!response.ok) throw new Error('Text-only model inference failed')
  const text = stream && response.headers.get('content-type')?.includes('text/event-stream')
    ? await streamedCompletion(response.body, onProgress)
    : (await response.json()).choices?.[0]?.message?.content
  if (typeof text !== 'string' || !text.trim()) throw new Error('Text-only model returned no text')
  return text.slice(0, PROGRESS_TEXT_LIMIT).toWellFormed()
}

function turnProgress(onProgress) {
  if (typeof onProgress !== 'function') return
  let committed = '', draft = '', sent = ''
  let timer, nextSend = 0
  function send() {
    clearTimeout(timer)
    timer = undefined
    const snapshot = (committed && draft ? committed + '\n\n' + draft : committed || draft).trimStart()
    if (snapshot === sent) return
    sent = snapshot
    nextSend = Date.now() + PROGRESS_INTERVAL_MS
    try { void Promise.resolve(onProgress(snapshot)).catch(() => {}) } catch {}
  }
  return {
    append(text) {
      const remaining = PROGRESS_TEXT_LIMIT - committed.length - draft.length - (committed ? 2 : 0)
      if (!text || remaining <= 0) return
      draft += text.slice(0, remaining)
      if (timer !== undefined) return
      const wait = nextSend - Date.now()
      if (wait <= 0) send()
      else timer = setTimeout(send, wait)
    },
    commit(texts) {
      const writing = sent || draft
      for (const text of texts) {
        const remaining = PROGRESS_TEXT_LIMIT - committed.length - (committed ? 2 : 0)
        if (remaining <= 0) break
        committed += (committed ? '\n\n' : '') + text.slice(0, remaining)
      }
      draft = ''
      if (writing) send()
    },
    discard() {
      draft = ''
      send()
    },
    reset() {
      committed = ''
      draft = ''
      send()
    },
    dispose() { clearTimeout(timer) },
  }
}

function ownsLiveChat(rt, botId, sessionId) {
  return livePrivateChat(rt, botId, sessionId) === sessionId
}

export async function prepareNativeChat(rt, botId, savedSessionId) {
  const bot = rt.botOf(botId)
  const sessionId = livePrivateChat(rt, botId, savedSessionId)
  if (!sessionId) throw new Error('Mapped native chat is no longer active')
  if (rt.flybotWorkspaceApps && (rt.isMain?.(botId) || bot.capabilities?.includes('ot-apps'))) {
    try { await rt.flybotWorkspaceApps.sync() }
    catch { rt.warn?.('FlyBot app tools could not be refreshed before this turn') }
  }
  const ref = await rt.applyModel(bot)
  const route = splitRef(ref)
  if (route) {
    // A session's own composer can select a different model independently.
    // Reapply the Bot's route only to the part receiving this message.
    const effort = bot.appliedEffort
    await rt.selectSessionModel(sessionId, {...route, ...(effort === undefined ? {} : {reasoningEffort:effort})})
  }
  if (rt.chatOf(botId) !== sessionId) await rt.applyPermission(bot, sessionId, undefined)
  return sessionId
}

// Join progress to the native request echo and durable turn. The settled display
// items remain the source of truth for the returned reply.
export function runTurn(rt, ctx, botId, text, requestId, timeoutMs = 170000, files = [], { onProgress, onPhase, sessionId, signal, managedGroup = false, interactive = false } = {}) {
  if (signal?.aborted) return Promise.reject(signal.reason)
  if (typeof requestId !== 'string' || !requestId) return Promise.reject(new Error('DS-Bot request identifier is required'))
  if (sessionId !== undefined && !ownsLiveChat(rt, botId, sessionId)) return Promise.reject(new Error('Mapped native chat is no longer active'))
  sessionId ??= rt.chatOf(botId)
  const admissionOnly = interactive && !managedGroup
  return new Promise((resolve, reject) => {
    const progress = turnProgress(onProgress)
    let observedTurn, observedSession, boundTurn, boundSession, attempt, lastAgent
    let stopping, stopDeadline, stopTimer
    let revision = 0
    let phase = 'preparing'
    function emitPhase(next) {
      if (next === phase || typeof onPhase !== 'function') return
      phase = next
      try { void Promise.resolve(onPhase(next)).catch(() => {}) } catch {}
    }
    let settled = false
    const parts = []
    const listeners = []
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      progress?.dispose()
      signal?.removeEventListener('abort', cancelNative)
      for (const listener of listeners) {
        try {
          if (typeof listener === 'function') listener()
          else listener?.dispose?.()
        } catch {}
      }
      const complete = () => {
        clearTimeout(stopTimer)
        if (error) reject(error)
        else resolve(value)
      }
      if (stopping) void (stopDeadline ? Promise.race([stopping, stopDeadline]) : stopping).then(complete, complete)
      else complete()
    }
    const timer = setTimeout(() => finish(admissionOnly && signal?.aborted ? signal.reason : new Error('DS-Bot turn timed out')), timeoutMs)
    const emptyReply = () => Object.assign(new Error('DS-Bot turn ended without a reply'), {code:'agents/empty-reply'})
    function cancelNative() {
      if (settled || stopping || !boundSession || boundTurn === undefined) return
      const session = boundSession, turn = boundTurn
      if (admissionOnly) {
        // Native cancellation should emit its terminal event. Bound cleanup if the
        // runtime can no longer resolve or settle a turn that the user has stopped.
        stopDeadline = new Promise(done => { stopTimer = setTimeout(done, 30_000) })
        void stopDeadline.then(() => finish(signal.reason))
      }
      stopping = Promise.resolve().then(() => rt.resolveAgent(sessionId)).then(agent => {
        // Do not stop another turn even if it now owns the same Bot or Session.
        if (settled || boundSession !== session || agent?.session !== session || boundTurn !== turn ||
            rt.live?.get(sessionId)?.turn !== turn || !ownsLiveChat(rt, botId, sessionId)) {
          if (admissionOnly) finish(signal.reason)
          return
        }
        const children = rt.stopSubagents?.(sessionId)
        agent.cancel({kind:'user'})
        return children
      }).catch(() => { if (admissionOnly) finish(signal.reason) })
    }
    signal?.addEventListener('abort', cancelNative, {once:true})
    function discardAttempt() {
      attempt = undefined
      progress?.discard()
      emitPhase('preparing')
    }
    function resetTurn() {
      boundSession = undefined
      boundTurn = undefined
      attempt = undefined
      parts.length = 0
      progress?.reset()
      emitPhase('preparing')
    }
    try {
      listeners.push(ctx.on('session/event', (session, event) => {
        if (settled || session?.id !== sessionId || !event || (boundSession && session !== boundSession)) return
        const turn = event.data?.turn
        if (event.type === 'turn/start' && Number.isSafeInteger(turn)) {
          if (session === observedSession && turn <= observedTurn) return
          if (boundTurn !== undefined && turn !== boundTurn) {
            if (admissionOnly) { finish(signal?.aborted ? signal.reason : emptyReply()); return }
            resetTurn()
          }
          observedTurn = turn
          observedSession = session
          return
        }
        if (event.type === 'user/message' && event.data?.source?.rpcId === requestId) {
          boundSession = session
          boundTurn = session === observedSession ? observedTurn : undefined
          if (admissionOnly && boundTurn !== undefined) clearTimeout(timer)
          if (signal?.aborted) cancelNative()
          return
        }
        if (!boundSession) {
          if (event.type === 'turn/end' && session === observedSession && turn === observedTurn) {
            observedTurn = undefined
            observedSession = undefined
          }
          return
        }
        if (boundTurn !== undefined && turn !== undefined && turn !== boundTurn) return
        if (attempt && attempt.step === event.data?.step && (event.type === 'assistant/attempt' || event.type === 'llm/retry-started')) {
          discardAttempt()
        }
        const start = parts.length
        for (const item of rt.displayItems(sessionId, [event]) ?? []) {
          if (item?.kind === 'bot' && typeof item.text === 'string' && item.text.trim()) parts.push(item.text)
        }
        if (event.type === 'assistant/message') {
          if (attempt?.step === event.data?.step) attempt = undefined
          progress?.commit(parts.slice(start))
        }
        if (event.type === 'turn/end') {
          if (signal?.aborted) { finish(signal.reason); return }
          const reason = event.data?.reason
          const disposed = reason?.kind === 'aborted' && reason.reason?.kind === 'disposed'
          if ((managedGroup || admissionOnly) && disposed) { finish(emptyReply()); return }
          const reply = parts.join('\n\n').trim()
          if (reply) finish(null, { text: reply, sessionId, turnId: event.data?.turnId ?? event.turnId ?? null })
          else if (event.data?.error || (managedGroup && reason && reason.kind !== 'completed')) finish(new Error('DS-Bot turn failed'))
          else finish(emptyReply())
        }
      }))
      if (progress || typeof onPhase === 'function') {
        listeners.push(ctx.on('agent/assistant-stream', ({ agent, frame }) => {
          if (settled || !boundSession || boundTurn === undefined || agent?.id !== sessionId || agent?.session !== boundSession
              || !Number.isSafeInteger(frame?.revision)) return
          if (frame.type === 'start') {
            if (frame.turn !== boundTurn || typeof frame.attemptId !== 'string' || !frame.attemptId || !Number.isSafeInteger(frame.step)
                || rt.state?.exchangeTurns?.[sessionId]?.includes(boundTurn)) return
            if (lastAgent === agent && (frame.revision <= revision || frame.attemptId === attempt?.id)) return
            if (attempt) discardAttempt()
            lastAgent = agent
            revision = frame.revision
            attempt = { id: frame.attemptId, step: frame.step }
            return
          }
          if (!attempt || lastAgent !== agent || frame.attemptId !== attempt.id || frame.revision <= revision) return
          revision = frame.revision
          if (frame.type === 'end') {
            discardAttempt()
          } else if (frame.type === 'chunk' && frame.chunk?.type === 'text-delta' && typeof frame.chunk.text === 'string') {
            progress?.append(frame.chunk.text)
            emitPhase('writing')
          } else if (frame.type === 'chunk' && frame.chunk?.type === 'reasoning-delta') {
            emitPhase('thinking')
          }
        }, { global: true }))
      }
      if (admissionOnly || progress || typeof onPhase === 'function') {
        listeners.push(ctx.on('agent/disposed', ({ agent }) => {
          if ((managedGroup || admissionOnly) && boundSession && agent?.id === sessionId && agent.session === boundSession && !settled) {
            finish(signal?.aborted ? signal.reason : emptyReply())
          } else if (agent === lastAgent && !settled) {
            resetTurn()
            observedTurn = undefined
            observedSession = undefined
            lastAgent = undefined
          }
        }, { global: true }))
      }
      Promise.resolve(rt.sendUser({ sessionId, content: [{ type: 'text', text }, ...files], requestId }))
        .catch(error => finish(error instanceof Error ? error : new Error('DS-Bot rejected the message')))
    } catch (error) {
      finish(error instanceof Error ? error : new Error('DS-Bot rejected the message'))
    }
  })
}

export function createBridge(rt, { env = process.env, port } = {}) {
  const bootstrapNative = rt.bootstrap.bind(rt)
  const state = {
    token: randomBytes(24).toString('hex'),
    // The account's own model settings (B4 @flybot-workspace/web model-api feature,
    // in-process, sealed at rest) win over the manager-mounted startup file.
    startupModel: () => { try { return userModelOverride() || loadModelApi(env) || null } catch { return null } },
  }
  const listenPort = port ?? (Number(env.FLYBOT_WORKSPACE_BRIDGE_PORT) || DEFAULT_PORT)
  const baseURL = `http://127.0.0.1:${listenPort}/v1`
  let ready = null
  let hasImageInput
  let botId = null
  const chatsPath = join(env.DSH_HOME || '/data', 'flybot-workspace-chats.json')
  let chats
  const loadChats = () => {
    if (chats) return chats
    try { chats = JSON.parse(readFileSync(chatsPath, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error; chats = {} }
    return chats
  }
  async function protectLegacyForeground(bot) {
    // Older automation and skill bridge chats were tracked outside the roster.
    // Bind the one foreground chain, if owned, before native task handoff.
    let legacy
    try { legacy = loadChats() } catch { return }
    if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy)) return
    const foreground = rt.chatOf(bot.id)
    if (!foreground) return
    const keys = bot.flybotWorkspace?.sessionKeys ?? {}
    const additions = Object.entries(legacy).filter(([key, id]) =>
      typeof id === 'string' && !Object.hasOwn(keys, key) && livePrivateChat(rt, bot.id, id) === foreground)
    if (!additions.length) return
    bot.flybotWorkspace ??= {}
    bot.flybotWorkspace.managedOpenParts = true
    bot.flybotWorkspace.sessionKeys = {...keys, ...Object.fromEntries(additions)}
    await rt.save()
  }
  async function selectConversation(id) {
    if (!id) return
    const map = loadChats()
    if (Object.hasOwn(map, id)) return prepareNativeChat(rt, botId, map[id])
    // Each FlyBot conversation gets a separate native DS-Bot chat/session.
    const bot = rt.botOf(botId)
    const freshId = await rt.createSession(bot.name, { dir: rt.workDirOf({ botId }) })
    addPrivateChat(rt, bot, {sessionId: freshId, segments: [], startedAt: Date.now()})
    await rt.save()
    const next = {...map, [id]: freshId}
    writeFileSync(chatsPath + '.tmp', JSON.stringify(next), { mode: 0o600 })
    renameSync(chatsPath + '.tmp', chatsPath)
    chats = next
    return prepareNativeChat(rt, botId, freshId)
  }

  function effectiveInput() {
    return modelInput(state.startupModel())
  }

  async function saveInput(input) {
    await rt.saveProviderModels({provider:PROVIDER,models:[providerModel(input)]})
    hasImageInput = input.includes('image')
  }

  async function setup() {
    const input = effectiveInput()
    try {
      await rt.addProvider({ provider: PROVIDER, custom: true, api: 'openai-completions', name: 'FlyBot', baseURL,
        models:[providerModel(input)],key:state.token })
      hasImageInput = input.includes('image')
    } catch (error) {
      if (!/already set up/.test(String(error?.message))) throw error
      await rt.setProviderKey(PROVIDER,state.token)
      await saveInput(input)
    }
    await bootstrapNative()
    botId = rt.state.mainBotIds.find(id => rt.botOf(id))
    if (!botId) throw new Error('DS-Bot has no Main Bot')
    // Remove the generated capability for the retired task MCP endpoint. The
    // native connector plugin manages its own separate capability (ot-apps).
    const retiredTools = rt.state.capabilities?.items?.['ot-tools']
    if (retiredTools?.kind === 'mcp' && retiredTools.transport === 'streamable-http'
      && /^http:\/\/127\.0\.0\.1:\d+\/mcp\?catalog=[a-f0-9]{16}$/.test(retiredTools.url)) {
      await rt.capabilityDelete('ot-tools', { ui: true })
    }
    const bot = rt.botOf(botId)
    await protectLegacyForeground(bot)
    if (bot.model !== MODEL_REF) await rt.updateBot(botId, { model: MODEL_REF })
    return botId
  }
  const ensureSetup = () => (ready ??= setup().catch(error => { ready = null; throw error }))

  let modelUpdates = Promise.resolve()
  function prepareModel() {
    const update = modelUpdates.then(async () => {
      await ensureSetup()
      const input = effectiveInput()
      if (input.includes('image') !== hasImageInput) await saveInput(input)
    })
    modelUpdates = update.catch(() => {})
    return update
  }

  function requireModel(botId) {
    const model = rt.botOf(botId)?.model
    if ((!model || model === MODEL_ID || model === MODEL_REF) && !state.startupModel()) {
      throw Object.assign(new Error('Configure a model API for this FlyBot runtime.'), {
        code: 'agents/model-unconfigured', status: 503,
      })
    }
  }

  // Turns and model configuration share a Bot. Operations that move a
  // thread between Bots still wait for the whole roster to be idle.
  const botTurns = new Map()
  let rosterWork = Promise.resolve()
  function exclusive(fn, botId) {
    const pending = botId ? [botTurns.get(botId)] : [...botTurns.values()]
    const run = Promise.all([rosterWork, ...pending]).then(() => fn())
    const wait = run.catch(() => {})
    if (botId) {
      botTurns.set(botId, wait)
      void wait.then(() => {
        if (botTurns.get(botId) === wait) botTurns.delete(botId)
      })
    } else {
      rosterWork = wait
    }
    return run
  }
  return {
    state, setup: ensureSetup, prepareModel, requireModel, exclusive, selectConversation,
    legacySession: key => loadChats()[key], port: listenPort, baseURL, get botId() { return botId },
  }
}

// Plugin entry: start the model proxy on the loopback interface.
export function startBridge(rt, ctx, options = {}) {
  const log = options.log ?? console.error
  const bridge = createBridge(rt, options)
  const bootstrapNative = rt.bootstrap.bind(rt)
  // Native roster entry must finish the same provider setup as FlyBot.
  // The bridge captures the original bootstrap above, so it can create Chief
  // after registering the authenticated provider without re-entering setup.
  rt.bootstrap = () => bridge.state.startupModel() ? bridge.setup() : bootstrapNative()
  const server = createBridgeServer(bridge.state, { log })
  server.on('error', error => log('ds-bot-bridge: loopback server error: ' + redact(error?.message || 'error')))
  server.listen(bridge.port, '127.0.0.1', () => {
    void Promise.resolve().then(async () => {
      await rt.load()
      // A restarted runtime can receive native Bot messages before either Web
      // client opens. Fresh runtimes still bootstrap on their ordinary entry.
      if (bridge.state.startupModel() && rt.readOnly?.() === undefined && rt.state.mainBotIds.some(id => rt.botOf(id))) await bridge.setup()
    }).catch(() => log('ds-bot-bridge: native provider setup will retry on the next request'))
  })
  const dispose = () => server.close()
  ctx.on?.('dispose', dispose)
  return { bridge, server, dispose }
}
