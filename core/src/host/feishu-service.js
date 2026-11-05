import { randomUUID, timingSafeEqual } from 'node:crypto'
import { createFeishuVault } from './feishu-vault.js'
import { createFeishuApi, FeishuError } from './feishu-api.js'
import { createFeishuTransport, FeishuSdkMissing } from './feishu-sdk.js'
import { readMessage, markdown, MAX_POST, MAX_IN, MAX_IMAGE, MAX_FILE, validateCard, toCard, cardWords } from './feishu-format.js'
import { PRODUCTS, validateCredentials, publicAddress } from '../shared/feishu.js'
import { installFeishuTools } from './feishu-tools.js'
import { createFeishuCalendars } from './feishu-calendar.js'
import { createFeishuEventServer } from './feishu-http.js'

const fail = text => Object.assign(new Error(text), { code: 'bot/forbidden' })
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b))
const memberActive = m => m && !m.removedAt && !m.disabled && m.status !== 'disabled'
const toast = (type, content) => ({ toast: { type, content } })
const safeKey = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)

export function createFeishuService(rt, { request = fetch, vault = createFeishuVault(rt.home), transport = createFeishuTransport } = {}) {
  const { state } = rt
  let calendars
  const apis = new Map(), sockets = new Map(), working = new Set(), names = new Map()
  let removeSender
  let tail = Promise.resolve(), stopped = false
  const data = () => state.feishu ??= { apps: {}, events: {}, outbox: {}, cards: {}, files: {}, grants: {}, identities: {} }
  const serial = fn => {
    const job = tail.then(fn)
    tail = job.catch(() => {})
    return job
  }
  const commit = fn => serial(async () => {
    const readOnly = rt.readOnly?.()
    if (readOnly) throw new Error(readOnly)
    const before = structuredClone(data())
    try { const value = await fn(); await rt.save(); return value }
    catch (error) { state.feishu = before; throw error }
  })
  const appOf = id => {
    const app = data().apps[id]
    if (!app) throw new Error('Unknown Feishu app')
    return app
  }
  const api = id => {
    appOf(id)
    if (!apis.has(id)) apis.set(id, createFeishuApi(() => vault.get(id), request, () => appOf(id)))
    return apis.get(id)
  }
  const principal = actor => {
    if (!actor && !rt.authzEnforced?.()) return { memberId: 'owner-1' }
    if (!actor || !memberActive(state.members?.[actor.memberId])) throw fail('Sign in first')
    return actor
  }
  const manage = (actor, app) => {
    actor = principal(actor)
    if (actor.memberId !== 'owner-1' && app?.ownerId !== actor.memberId) throw fail('Only the app owner can change this connection')
    return actor
  }
  const localBot = (id, ownerId) => {
    const bot = rt.botOf(id)
    if (!bot || bot.remote || bot.ephemeral || bot.projectAgent || (bot.ownerId ?? 'owner-1') !== ownerId) throw fail('Choose a local Bot owned by this member')
    return bot
  }
  const diagnose = async (id, kind, error) => commit(() => {
    const app = data().apps[id]
    const detail = String(error?.message ?? '')
    const message = error instanceof FeishuError && Number(error.code) === 99991672 ? 'Apply for the missing app permission, publish a new version, wait for approval, then check permissions again.'
      : error instanceof FeishuSdkMissing ? 'The Feishu long-connection SDK is not installed on the FlyBot server. Reinstall FlyBot, or rebuild the image if it runs in Docker.'
      : kind === 'connection' && /app.?id|app.?secret|auth|internal error/i.test(detail) ? 'Check App ID and App Secret. A nonexistent App ID may be reported as an internal error.'
        : kind === 'connection' && /limit|too many|50/.test(detail) ? 'The application has reached its long-connection limit (up to 50 connections).'
          : kind === 'connection' ? 'Could not connect to open.feishu.cn; check the server network, proxy and application credentials.'
            : 'Operation failed; check network, permissions and published app version'
    if (app) app.diagnostics = [...(app.diagnostics ?? []), { at: Date.now(), kind, message, ...(typeof error?.code === 'number' ? { code: error.code } : {}), ...(error instanceof FeishuError && error.detail ? { detail: error.detail } : {}) }].slice(-50)
  })
  const handle = (app, chatId) => app.legacy ? `feishu:${chatId}` : `feishu:${app.id}:${chatId}`
  const identity = (appId, openId) => {
    const row = data().identities[`${appId}:${openId}`]
    return row && memberActive(state.members?.[row.memberId]) ? row : undefined
  }
  const view = actor => {
    const who = principal(actor)
    return Object.values(data().apps).map(a => who.memberId !== 'owner-1' && a.ownerId !== who.memberId ? { id: a.id, name: a.name, mode: a.mode, linkOnly: true, identities: Object.values(data().identities).filter(i => i.appId === a.id && i.memberId === who.memberId) } : ({ ...a,
      connection: sockets.get(a.id)?.state ?? (a.mode === 'http' ? 'http' : 'off'),
      grants: data().grants[a.id] ?? {}, identities: Object.values(data().identities).filter(i => i.appId === a.id),
      cards: Object.values(data().cards).filter(c => c.appId === a.id),
      files: Object.values(data().files).filter(f => f.appId === a.id).map(f => ({ id: f.ref.attachmentId, name: f.ref.name, size: f.ref.bytes })),
      recent: Object.values(data().events).filter(e => e.appId === a.id).slice(-20).map(({ id, message, status, at }) => ({ id, chatId: message?.chatId, text: message?.text, status, at })),
      outbox: Object.values(data().outbox).filter(o => o.appId === a.id).slice(-20).map(({ id, status }) => ({ id, status })),
    }))
  }
  async function connect(id) {
    const app = appOf(id)
    await sockets.get(id)?.socket?.close?.()
    sockets.delete(id)
    if (app.mode !== 'socket' || stopped) return
    const credentials = await vault.get(id)
    const status = { state: 'connecting' }
    sockets.set(id, status)
    const adapter = transport({ credentials: () => credentials, log: () => {}, onState: s => { if (sockets.get(id) === status) status.state = s } })
    try {
      const socket = await adapter.connect(event => receive(id, event, 'socket'))
      if (sockets.get(id) !== status || stopped) { await socket.close(); return }
      Object.assign(status, { state: 'ready', socket })
    } catch (error) {
      if (sockets.get(id) === status) status.state = 'error'
      await diagnose(id, 'connection', error)
    }
  }
  async function test(id) {
    try {
      const result = await api(id).call('GET', 'bot/v3/info/')
      await commit(() => { appOf(id).botOpenId = result.bot?.open_id; appOf(id).botName = result.bot?.app_name })
      return { ok: true, bot: result.bot?.app_name }
    } catch (error) {
      return { ok: false, credentialError: error.stage === 'credentials' || !(error instanceof FeishuError), error: error.stage === 'credentials' ? 'Check App ID and App Secret. A nonexistent App ID may be reported as an internal error.' : !(error instanceof FeishuError) ? 'FlyBot cannot reach open.feishu.cn. Check the server network or proxy.' : 'Credentials accepted, but Bot information is unavailable. Enable the Bot capability and publish a version. You can continue now and test again after publishing.' }
    }
  }
  async function scopes(id) {
    const result = await api(id).call('GET', 'application/v6/scopes')
    const granted = (result.scopes ?? []).filter(s => s.grant_status === 1).map(s => s.scope_name)
    await commit(() => { appOf(id).scopes = granted })
    return granted
  }
  async function save(body, actor) {
    const id = String(body.appId ?? '')
    const existing = data().apps[id]
    const owner = manage(actor, existing)
    await rt.loadSecrets?.()
    const legacySecret = state.connectors?.feishu?.appId === id ? rt.secretValue?.('FEISHU_APP_SECRET') : undefined
    const oldCredentials = existing ? await vault.get(id) : legacySecret ? { appId: id, appSecret: legacySecret } : undefined
    const mode = body.mode ?? existing?.mode ?? 'socket'
    const credentials = { appId: id, appSecret: body.appSecret?.trim() || oldCredentials?.appSecret, ...(mode === 'http' ? { verificationToken: body.verificationToken?.trim() || oldCredentials?.verificationToken } : {}) }
    const changed = mode !== existing?.mode || credentials.appSecret !== oldCredentials?.appSecret || credentials.verificationToken !== oldCredentials?.verificationToken || body.publicUrl !== undefined && body.publicUrl !== existing?.publicUrl
    validateCredentials(credentials, mode)
    if (mode === 'http' && !publicAddress(body.publicUrl ?? existing?.publicUrl)) throw new Error('Prepare a public HTTPS event address')
    if (mode === 'http') await rt.ensureFeishuEvents?.()
    if (body.botId) localBot(body.botId, existing?.ownerId ?? owner.memberId)
    await vault.set(id, credentials)
    try {
      await commit(() => {
        const legacy = state.connectors?.feishu
        data().apps[id] = { ...existing, id, name: String(body.name ?? existing?.name ?? '飞书').slice(0, 100), ownerId: existing?.ownerId ?? owner.memberId, mode,
          publicUrl: body.publicUrl ?? existing?.publicUrl ?? '', botId: body.botId ?? existing?.botId ?? null, step: Math.max(0, Math.min(mode === 'http' ? 6 : 5, Number.isInteger(body.step) ? body.step : existing?.step ?? 1)),
          allowed: existing?.allowed ?? legacy?.allowed?.map(e => e.openId) ?? [], legacy: existing?.legacy ?? (!Object.keys(data().apps).length && (!legacy?.appId || legacy.appId === id)), createdAt: existing?.createdAt ?? Date.now() }
        if (changed) { delete data().apps[id].verifiedAt; delete data().apps[id].lastEventAt }
        if (data().apps[id].legacy) { state.connectors ??= {}; state.connectors.feishu = { ...legacy, mode: 'app', appId: id, managed: true } }
      })
    } catch (error) { await vault.set(id, oldCredentials); throw error }
    apis.delete(id)
    await rt.stopLegacyFeishu?.()
    void connect(id)
    return { apps: view(owner), test: await test(id) }
  }
  async function send(id, message, type, content, uuid, authorize) {
    const threaded = !!message.rootId
    return api(id).call('POST', threaded ? `im/v1/messages/${encodeURIComponent(message.rootId)}/reply` : 'im/v1/messages', {
      authorize, query: threaded ? undefined : { receive_id_type: 'chat_id' }, body: { ...(threaded ? { reply_in_thread: true } : { receive_id: message.chatId }), msg_type: type, content: JSON.stringify(content), ...(uuid ? { uuid } : {}) },
    })
  }
  async function sendText(id, message, text, uuid) {
    const mentions = new Map(Object.values(data().identities).filter(i => i.appId === id).map(i => [state.members?.[i.memberId]?.displayName, i.openId]).filter(([name]) => !!name))
    const rich = { zh_cn: { ...(message.title ? { title: message.title } : {}), content: [[{ tag: 'md', text: markdown(text, mentions) }]] } }
    if (Buffer.byteLength(JSON.stringify(rich)) <= MAX_POST) {
      try { return await send(id, message, 'post', rich, uuid) }
      catch (error) { if (!(error instanceof FeishuError)) throw error; await diagnose(id, 'format', error) }
    }
    return send(id, message, 'text', { text }, uuid)
  }
  async function reaction(event, remove = false) {
    if (!event.message.messageId) return
    if (remove && !event.reactionId) return
    if (!remove && (event.reactionId || event.reactionAttempts >= 5)) return
    try {
      const result = await api(event.appId).call(remove ? 'DELETE' : 'POST', `im/v1/messages/${encodeURIComponent(event.message.messageId)}/reactions${remove ? `/${encodeURIComponent(event.reactionId)}` : ''}`, remove ? {} : { body: { reaction_type: { emoji_type: 'Get' } } })
      await commit(() => { const row = data().events[event.id]; if (row) { delete row.reactionRetry; if (remove) delete row.reactionId; else row.reactionId = result.reaction_id } })
    } catch (error) {
      await commit(() => { const row = data().events[event.id]; if (row) { row.reactionAttempts = (row.reactionAttempts ?? 0) + 1; row.reactionRetry = Date.now() + Math.min(3600000, 1000 * 2 ** Math.min(row.reactionAttempts, 12)) } })
      await diagnose(event.appId, 'reaction', error)
    }
  }
  async function importFiles(event) {
    const imported = []
    for (const file of event.message.files) {
      try {
        const res = await api(event.appId).call('GET', `im/v1/messages/${encodeURIComponent(event.message.messageId)}/resources/${encodeURIComponent(file.key)}`, { query: { type: file.type }, raw: true })
        if (Number(res.headers.get('content-length')) > MAX_IN) throw new Error('Attachment exceeds 20 MB')
        const chunks = []; let size = 0
        // Exiting the stream iterator cancels its reader, including on a size error.
        for await (const chunk of res.body) { size += chunk.length; if (size > MAX_IN) throw new Error('Attachment exceeds 20 MB'); chunks.push(chunk) }
        const mime = res.headers.get('content-type') ?? 'application/octet-stream'
        const attachment = await rt.ctx.attachments[file.type === 'image' ? 'saveImage' : 'saveFile']({ data: Buffer.concat(chunks), name: String(file.name).slice(0, 200), mediaType: mime })
        imported.push({ ...attachment, name: file.name })
      } catch (error) { await diagnose(event.appId, 'attachment-receive', error) }
    }
    return imported
  }
  async function processEvent(key) {
    if (working.has(key) || stopped) return
    working.add(key)
    try {
      const event = data().events[key]
      if (!event || !['queued', 'processing'].includes(event.status)) return
      const app = appOf(event.appId), message = event.message
      const botId = app.chatBots?.[message.chatId] ?? app.botId
      const allowed = app.allowed.includes(message.openId)
      const mentioned = !message.group || message.mentions.some(m => m.id?.open_id === app.botOpenId)
      const botLimit = (app.autoRounds?.[message.chatId] ?? 0) >= 8
      const accepted = allowed && botId && mentioned && (!message.bot || app.allowBots && !botLimit) && message.openId !== app.botOpenId
      const chatHandle = handle(app, message.chatId)
      let name = chatHandle
      try {
        const info = await api(app.id).call('GET', message.group ? `im/v1/chats/${encodeURIComponent(message.chatId)}` : `contact/v3/users/${encodeURIComponent(message.openId)}`, { query: message.group ? undefined : { user_id_type: 'open_id' } })
        name = info.name ?? info.user?.name ?? name
      } catch { /* IDs are display fallbacks, never identities. */ }
      let senderName = `feishu-${message.openId}`
      const cacheKey = `${app.id}:${message.group ? message.chatId : message.openId}`
      try {
        let cached = names.get(cacheKey)
        if (!cached || cached.at < Date.now() - (message.group ? 600000 : 3600000)) {
          const users = {}; let token
          if (message.group) {
            do {
              const result = await api(app.id).call('GET', `im/v1/chats/${encodeURIComponent(message.chatId)}/members`, { query: { member_id_type: 'open_id', page_size: 100, ...(token ? { page_token: token } : {}) } })
              for (const user of result.items ?? []) users[user.member_id] = user.name
              token = result.has_more ? result.page_token : undefined
            } while (token)
          } else users[message.openId] = name === chatHandle ? senderName : name
          cached = { at: Date.now(), users }; names.set(cacheKey, cached)
        }
        senderName = cached.users[message.openId] ?? senderName
      } catch { /* Missing contact scope keeps the stable open_id label. */ }
      if (message.group) await calendars?.follow(app.id, message.chatId)
      const attachments = event.attachments ?? await importFiles(event)
      if (attachments.length) await commit(() => { for (const ref of attachments) data().files[`${app.id}:${ref.attachmentId}`] = { appId: app.id, ref } })
      await rt.remoteChats.open({ handle: chatHandle, name, plugin: 'feishu' })
      await rt.remoteChats.deliver({ handle: chatHandle, text: message.text || attachments.map(a => a.name).join(', '), name, plugin: 'feishu', human: !message.bot, ownerName: senderName, sourceId: key, feishu: { appId: app.id, rootId: message.rootId, messageId: message.messageId }, attachments })
      if (!accepted) {
        await commit(() => { data().events[key].status = !allowed ? 'refused' : !botId ? 'no-bot' : message.bot && app.allowBots && botLimit ? 'bot-limit' : 'context'; if (!message.bot && app.autoRounds) app.autoRounds[message.chatId] = 0 })
        return
      }
      localBot(botId, app.ownerId)
      const reserved = await commit(() => {
        if (Object.values(data().events).some(e => e.id !== key && e.botId === botId && ['processing', 'admitted'].includes(e.status)) || rt.liveOf?.(rt.chatOf?.(botId) ?? botId)?.turn !== undefined) return false
        Object.assign(data().events[key], { botId, attachments, status: 'processing' })
        app.autoRounds ??= {}; app.autoRounds[message.chatId] = message.bot ? (app.autoRounds[message.chatId] ?? 0) + 1 : 0
        return true
      })
      if (!reserved) return
      await reaction(data().events[key])
      const context = Object.values(data().events).filter(e => e.id !== key && e.appId === app.id && e.message?.chatId === message.chatId && e.at <= event.at && ['context', 'sent', 'responded'].includes(e.status)).slice(-10).map(e => `${e.message.openId}: ${e.message.text}`).join('\n').slice(-8000)
      const prompt = [context ? `[Earlier messages in this Feishu chat]\n${context}\n[Current request]` : '', message.text || attachments.map(a => a.name).join(', ')].filter(Boolean).join('\n')
      await rt.deliver({ toId: botId, text: prompt, role: 'feishu', exchangeId: key, fromName: senderName, untrusted: true, origin: 'other', attachments,
        feishu: { eventId: key, appId: app.id, chatId: message.chatId, openId: message.openId, rootId: message.rootId } })
      await commit(() => { if (data().events[key].status === 'processing') data().events[key].status = 'admitted' })
    } catch (error) {
      const event = data().events[key]
      if (event) { await commit(() => { event.status = 'failed' }); await diagnose(event.appId, 'delivery', error) }
    } finally { working.delete(key) }
  }
  async function receive(id, envelope, mode) {
    const app = appOf(id)
    if (mode !== app.mode) throw fail('Receiving method changed; update event and callback subscriptions and publish a version')
    const credentials = await vault.get(id)
    if (mode === 'http' && !same(envelope?.header?.token ?? envelope?.token, credentials.verificationToken)) throw fail('Verification Token does not match')
    if (envelope?.encrypt) throw fail('Encrypt Key must be empty; encrypted events are unsupported')
    if (envelope?.header?.app_id && envelope.header.app_id !== id) throw fail('Feishu app does not match')
    if (envelope?.type === 'url_verification') { await commit(() => { app.verifiedAt = Date.now() }); return { challenge: String(envelope.challenge ?? '') } }
    if (envelope?.header?.event_type === 'card.action.trigger') return trigger(id, envelope)
    const message = readMessage(envelope)
    if (!message) return { ignored: true }
    if (message.openId === app.botOpenId) return { ignored: true }
    const key = `${id}:${message.messageId}`
    const added = await commit(() => {
      if (data().events[key]) return false
      data().events[key] = { id: key, appId: id, message, status: 'queued', at: Date.now() }
      app.lastEventAt = Date.now()
      return true
    })
    if (added) void processEvent(key)
    return { duplicate: !added }
  }
  async function complete(meta, text, failure) {
    const event = data().events[meta.eventId]
    if (!event || ['sent', 'cancelled'].includes(event.status) || !data().apps[event.appId]) return
    if (failure || !text) { await commit(() => { event.status = 'failed' }); void tick(); return }
    const id = event.id
    await commit(() => { data().outbox[id] ??= { id, appId: event.appId, text, message: event.message, status: 'pending', uuid: randomUUID() }; event.status = 'responded' })
    void tick()
    await flush(id)
  }
  async function flush(id) {
    if (working.has(`send:${id}`)) return
    working.add(`send:${id}`)
    try {
      const item = data().outbox[id]
      if (!item || item.status === 'sent') return
      await sendText(item.appId, item.message, item.text, item.uuid)
      await commit(() => { item.status = 'sent'; const event = data().events[id]; if (event) event.status = 'sent' })
      const app = appOf(item.appId)
      await rt.remoteChats.deliver({ handle: handle(app, item.message.chatId), text: item.text, name: rt.botOf(data().events[id]?.botId)?.name, plugin: 'feishu', sourceId: `reply:${id}`, feishu: { appId: app.id, rootId: item.message.rootId } })
      if (data().events[id]) await reaction(data().events[id], true)
    } catch (error) {
      const item = data().outbox[id]
      if (item) { await commit(() => { item.status = 'failed' }); await diagnose(item.appId, 'send', error) }
    } finally { working.delete(`send:${id}`) }
  }
  async function card(appId, botId, message, cardValue, cardId) {
    const app = appOf(appId)
    localBot(botId, app.ownerId)
    const existing = cardId && data().cards[cardId]
    if (cardId && (!existing || existing.botId !== botId || existing.appId !== appId)) throw fail('Card is not owned by this Bot')
    const record = { ...existing, id: existing?.id ?? randomUUID(), appId, botId, message, card: validateCard(cardValue), version: (existing?.version ?? 0) + 1, submissions: existing?.submissions ?? [], closed: false }
    await commit(() => { data().cards[record.id] = record })
    try {
      const result = record.messageId ? await api(appId).call('PATCH', `im/v1/messages/${encodeURIComponent(record.messageId)}`, { body: { content: JSON.stringify(toCard(record)) } }) : await send(appId, message, 'interactive', toCard(record), record.id)
      await commit(() => { record.messageId ??= result.message_id })
    } catch (error) {
      if (!(error instanceof FeishuError)) throw error
      await diagnose(appId, 'card', error)
      await send(appId, message, 'text', { text: `${cardWords(cardValue)}\n按钮和表单需在 FlyBot 控制台中使用。` }, record.id)
    }
    return { id: record.id, version: record.version }
  }
  async function trigger(id, envelope) {
    const event = envelope.event ?? {}, value = event.action?.value ?? {}, key = `${id}:card:${envelope.header?.event_id ?? event.token ?? ''}`
    if (!envelope.header?.event_id && !event.token) throw fail('Card callback ID is missing')
    const linked = identity(id, event.operator?.open_id)
    if (!linked) return toast('error', '你的飞书账号还没有关联到 FlyBot，不能操作这张卡片。请联系管理员关联。')
    const result = await commit(() => {
      if (data().events[key]?.response) {
        const previous = data().events[key], current = data().cards[previous.cardId]
        return current ? { ...previous.response, card: { type: 'raw', data: toCard(current) } } : previous.response
      }
      const record = data().cards[value.flybot_card]
      if (!record || record.appId !== id || record.messageId !== event.context?.open_message_id || record.message.chatId !== event.context?.open_chat_id) return toast('error', '这张卡片已不存在')
      if (record.closed || value.version !== record.version || !(record.card.actions ?? []).some(a => a.id === value.action)) return toast('error', '这张卡片已更新，请使用最新卡片')
      const fields = event.action?.form_value ?? {}
      if (JSON.stringify(fields).length > 16000) return toast('error', '提交内容过长')
      record.submissions.push({ memberId: linked.memberId, openId: linked.openId, name: state.members[linked.memberId].displayName ?? linked.memberId, action: value.action, fields, at: Date.now() })
      record.closed = record.card.once !== false
      record.version += 1
      const response = { ...toast('success', '已提交'), card: { type: 'raw', data: toCard(record) } }
      data().events[key] = { id: key, appId: id, status: 'card-pending', cardId: record.id, submission: record.submissions.at(-1), response, at: Date.now() }
      return response
    })
    void dispatchCard(key)
    return result
  }
  async function dispatchCard(key) {
    if (working.has(key)) return
    working.add(key)
    try {
      const event = data().events[key]
      if (!event || !['card-pending', 'processing'].includes(event.status)) return
      const record = data().cards[event.cardId]
      if (!record || !identity(record.appId, event.submission.openId)) return
      const reserved = await commit(() => {
        if (Object.values(data().events).some(e => e.id !== key && e.botId === record.botId && ['processing', 'admitted'].includes(e.status)) || rt.liveOf?.(rt.chatOf?.(record.botId) ?? record.botId)?.turn !== undefined) return false
        event.status = 'processing'; event.message = record.message; event.botId = record.botId
        return true
      })
      if (!reserved) return
      await rt.deliver({ toId: record.botId, role: 'feishu', exchangeId: key, text: JSON.stringify({ cardId: record.id, ...event.submission }), untrusted: true, origin: 'other',
        feishu: { eventId: key, appId: record.appId, ...record.message, openId: event.submission.openId } })
      await commit(() => { if (event.status === 'processing') event.status = 'admitted' })
    } catch (error) { const event = data().events[key]; if (event) await diagnose(event.appId, 'card-action', error) }
    finally { working.delete(key) }
  }
  async function endpoint(body, actor) {
    await rt.load()
    const who = principal(actor), op = body.operation ?? 'list'
    if (op === 'list') return { apps: view(who), members: Object.values(state.members ?? {}).filter(m => memberActive(m) && (who.memberId === 'owner-1' || m.id === who.memberId)).map(m => ({ id: m.id, name: m.displayName ?? m.id })) }
    if (op === 'save') return save(body, who)
    if (op === 'webhook') { manage(who); return rt.connectorEndpoint('connector-connect', { id: 'feishu', mode: 'webhook', credentials: { webhook: body.webhook } }) }
    const id = String(body.appId ?? ''), app = appOf(id)
    if (op === 'identity') {
      const target = String(body.memberId ?? who.memberId), openId = String(body.openId ?? '')
      if (target !== who.memberId && who.memberId !== 'owner-1' || !memberActive(state.members?.[target]) || !safeKey(openId)) throw fail('Choose your own existing platform identity')
      if (who.memberId !== 'owner-1' && app.ownerId !== who.memberId && !app.allowed.includes(openId)) throw fail('Sender is not allowed on this app')
      const old = data().identities[`${id}:${openId}`]
      if (old && old.memberId !== who.memberId && who.memberId !== 'owner-1') throw fail('This identity is already linked')
      await commit(() => { data().identities[`${id}:${openId}`] = { appId: id, openId, memberId: target } })
      return { linked: true }
    }
    manage(who, app)
    if (op === 'attachment') {
      const ref = data().files[`${id}:${body.attachmentId}`]?.ref
      if (!ref) throw fail('Attachment does not belong to this Feishu app')
      const chunks = []
      if (ref.mediaType) chunks.push((await rt.ctx.attachments.readImage(ref)).data)
      else for await (const chunk of rt.ctx.attachments.readFileStream(ref)) chunks.push(chunk)
      return { name: ref.name, content_base64: Buffer.concat(chunks).toString('base64') }
    }
    if (op === 'test') return test(id)
    if (op === 'scopes') return { scopes: await scopes(id) }
    if (op === 'allow') {
      if (!safeKey(body.openId)) throw new Error('Enter an open_id')
      await commit(() => { app.allowed = body.enabled === false ? app.allowed.filter(i => i !== body.openId) : [...new Set([...app.allowed, body.openId])] })
    } else if (op === 'configure') {
      if (body.botId) localBot(body.botId, app.ownerId)
      if (body.chatId && (!safeKey(body.chatId) || ['__proto__', 'constructor', 'prototype'].includes(body.chatId))) throw new Error('Invalid Feishu chat')
      const cancelled = []
      await commit(() => {
        if (body.botId !== undefined) for (const event of Object.values(data().events)) {
          const affected = body.chatId ? event.message?.chatId === body.chatId : !app.chatBots?.[event.message?.chatId]
          if (event.appId === id && affected && event.botId !== (body.botId || app.botId) && ['processing', 'admitted'].includes(event.status)) { event.status = 'cancelled'; cancelled.push(event) }
        }
        if (body.chatId) { app.chatBots ??= {}; if (body.botId) app.chatBots[body.chatId] = body.botId; else delete app.chatBots[body.chatId] }
        if (body.botId && !body.chatId) app.botId = body.botId
        if (typeof body.allowBots === 'boolean') app.allowBots = body.allowBots
        if (Number.isInteger(body.step)) app.step = Math.max(0, Math.min(app.mode === 'http' ? 6 : 5, body.step))
      })
      for (const event of cancelled) {
        const sessionId = rt.chatOf?.(event.botId) ?? event.botId
        if (rt.liveOf?.(sessionId)?.info?.feishu?.eventId !== event.id) continue
        try { const agent = await rt.resolveAgent(sessionId); agent.cancel({ kind: 'hook', reason: 'Feishu conversation handler changed' }) }
        catch (error) { await diagnose(id, 'handler-stop', error) }
      }
    } else if (op === 'grant') {
      localBot(body.botId, app.ownerId)
      if (!PRODUCTS.some(p => p.id === body.product) || !['disabled', 'read', 'ask', 'write'].includes(body.mode)) throw new Error('Invalid Feishu grant')
      await commit(() => { data().grants[id] ??= {}; data().grants[id][body.botId] ??= {}; data().grants[id][body.botId][body.product] = body.mode })
    } else if (op === 'retry') {
      if (body.outboxId && data().outbox[body.outboxId]?.appId === id) await flush(body.outboxId)
      else if (body.eventId && data().events[body.eventId]?.appId === id && data().events[body.eventId].status === 'failed') { await commit(() => { data().events[body.eventId].status = 'queued' }); void processEvent(body.eventId) }
      else await connect(id)
    } else if (op === 'card-action') {
      const record = data().cards[body.cardId]
      if (!record || record.appId !== id) throw fail('Unknown card')
      const openId = Object.values(data().identities).find(i => i.appId === id && i.memberId === who.memberId)?.openId
      if (!openId) throw fail('Link your Feishu identity first')
      return trigger(id, { header: { event_id: randomUUID() }, event: { operator: { open_id: openId }, context: { open_message_id: record.messageId, open_chat_id: record.message.chatId }, action: { value: { flybot_card: record.id, version: record.version, action: body.action }, form_value: body.fields ?? {} } } })
    } else if (op === 'delete') {
      await commit(() => {
        delete data().apps[id]; delete data().grants[id]
        for (const name of ['events', 'outbox', 'cards', 'identities', 'files', 'calendarShares']) for (const [key, row] of Object.entries(data()[name] ?? {})) if (row.appId === id) delete data()[name][key]
        if (app.legacy && state.connectors?.feishu?.managed) delete state.connectors.feishu
      })
      await sockets.get(id)?.socket?.close?.(); sockets.delete(id); apis.delete(id); await vault.set(id, undefined)
    } else throw new Error('Unknown Feishu operation')
    return { apps: view(who) }
  }
  const authorizeTool = (botId, appId, product, write) => {
    const app = appOf(appId), bot = localBot(botId, app.ownerId), grant = data().grants[appId]?.[bot.id]?.[product] ?? 'disabled'
    if (grant === 'disabled' || write && grant === 'read') throw fail('This Feishu capability is not granted to this Bot')
    return grant
  }
  async function tick() {
    for (const event of Object.values(data().events)) {
      if (event.status === 'queued') void processEvent(event.id)
      if (event.status === 'card-pending') void dispatchCard(event.id)
      if (event.reactionRetry && event.reactionRetry < Date.now()) void reaction(event, event.status === 'sent')
    }
  }
  async function start() {
    stopped = false; await rt.load()
    removeSender?.()
    removeSender = rt.remoteChats?.onSend?.('feishu', reply)
    for (const app of Object.values(data().apps)) { if (app.mode === 'http') await rt.ensureFeishuEvents?.(); void connect(app.id) }
    for (const event of Object.values(data().events)) if (event.status === 'processing') void (event.cardId ? dispatchCard(event.id) : processEvent(event.id))
    for (const item of Object.values(data().outbox)) if (item.status === 'pending') void flush(item.id)
    await tick()
  }
  async function stop() { stopped = true; removeSender?.(); for (const s of sockets.values()) await s.socket?.close?.(); sockets.clear() }
  async function reply(message) {
    const app = Object.values(data().apps).find(a => a.legacy ? message.handle.startsWith('feishu:') && !message.handle.slice(7).includes(':') : message.handle.startsWith(`feishu:${a.id}:`))
    if (!app) return rt.replyLegacyFeishu?.(message)
    const chatId = message.handle.slice(app.legacy ? 7 : `feishu:${app.id}:`.length)
    return sendText(app.id, { chatId, title: state.members?.[app.ownerId]?.displayName ?? 'Owner' }, String(message.text), message.messageId)
  }
  const service = { endpoint, receive, complete, view, api, card, identity, authorizeTool, appOf, data, commit, diagnose, start, stop, tick, sendText, send, reply, MAX_IN, MAX_IMAGE, MAX_FILE }
  calendars = createFeishuCalendars(service)
  return Object.assign(service, { calendars })
}

export function install(rt) {
  const service = createFeishuService(rt)
  rt.feishu = service
  installFeishuTools(rt, service)
  let server, listening
  rt.ensureFeishuEvents = () => listening ??= (async () => {
    const port = Number(rt.config.feishu?.eventsPort ?? process.env.FLYBOT_FEISHU_EVENTS_PORT ?? 3082)
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Configure a valid Feishu event port')
    server = createFeishuEventServer(service)
    try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '0.0.0.0', resolve) }) }
    catch (error) { listening = undefined; throw error }
  })()
  rt.ctx.effect(() => {
    void service.start().catch(() => rt.warn('ds-bot: Feishu recovery failed'))
    const timer = setInterval(() => { void service.tick().catch(() => {}) }, 10000)
    timer.unref?.()
    return () => { clearInterval(timer); server?.close(); void service.stop() }
  }, 'ds-bot: Feishu apps')
}
