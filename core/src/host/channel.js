// Client channel: the team view the browser renders, and the POST /api/bot endpoints.
import { randomUUID } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { questionReply } from './parts.js'
import { COLORS, EXTRA_COLORS, ROUTE } from './constants.js'
import { isFaceRoom } from './room-membership.js'
import { faceMentions } from './face-mentions.js'
import { unwrapUntrusted } from './delivery.js'

const LANGUAGES = { zh: 'Chinese (简体中文)', en: 'English' }

const invalid = message => Object.assign(new Error(message), { code: 'bot/invalid' })
// Programming and file system errors are DS Bot's own faults, logged with their stack;
// any other error is a refusal whose message is meant for the user.
const isInternal = error => error instanceof TypeError || error instanceof ReferenceError || error instanceof RangeError
  || error instanceof SyntaxError || (typeof error?.code === 'string' && /^E[A-Z_]+$/.test(error.code))
export function errorCode(error) {
  if (typeof error?.code === 'string' && error.code.startsWith('bot/')) return error.code
  return isInternal(error) ? 'bot/internal' : 'bot/refused'
}

export function install(rt) {
  const { ctx, state } = rt

  // The DSH interface language of the last browser that asked for the team.
  let uiLocale
  rt.uiLanguage = () => (uiLocale === undefined ? 'English' : LANGUAGES[uiLocale.split('-')[0].toLowerCase()] ?? uiLocale)

  const ok = value => ({ ok: true, value })
  const fail = (message, code = 'bot/error', details = {}) => ({ ok: false, error: { code, message, details } })
  // Models come from DSH, not state.json, so a provider added in Harness settings
  // changes the view without a new revision.
  const modelsKey = () => `${rt.cachedCatalog().map(entry => entry.reasoning ? `${entry.ref}:${JSON.stringify(entry.reasoning)}` : entry.ref).join(',')}|${rt.cachedDefault() ?? ''}`
  const view = actor => {
    const full = ({
    revision: state.revision,
    workspaceId: state.workspaceId ?? null,
    // `mainBotId` is the first Main Bot, which the sidebar shows as its tile.
    mainBotId: state.mainBotIds[0] ?? null,
    mainBotIds: state.mainBotIds,
    // `sessionId` is the Bot's current own-chat part; `parts` its earlier ones.
    // `waiting`: the Bot holds its greeting until the user picks its model.
    bots: Object.values(state.bots).map(({ segments, kickoff, ...bot }) => {
      // A friend's chat, and a local Bot's own held sends (#371): the provider says which.
      const pending = rt.listChatApprovals?.(bot, actor) ?? []
      // A local Bot's held replies to friends (#418), for its owner only: drawn on the turns they answer,
      // and a waiting one counts toward the row's wait badge.
      const held = bot.remote || (rt.authzEnforced?.() && actor && bot.ownerId !== actor.memberId) ? [] : rt.heldRepliesOf?.(bot.id) ?? []
      const waitingReplies = held.filter(reply => reply.status === 'pending').length
      return {
        ...bot,
        granted: rt.hasAnyGrant?.(bot.id) === true,
        // Who the Bot is shared with (at most three labels): a shared Bot cannot use connectors (#335).
        ...(bot.remote ? {} : { sharedWith: rt.sharedWith?.(bot.id).slice(0, 3) ?? [] }),
        sessionId: rt.chatOf(bot.id),
        parts: (segments ?? []).map(segment => segment.sessionId),
        pendingCount: pending.length + waitingReplies,
        ...(held.length ? { heldReplies: held } : {}),
        ...(kickoff ? { waiting: true } : {}),
      }
    }),
    // `parts`: the members' hidden group Sessions and their earlier segments, for usage.
    rooms: Object.values(state.rooms).map(({ log, seen, botRounds, lateRounds, sessions, segments, faceLine, ...room }) => {
      const parts = [...Object.values(sessions ?? {}), ...Object.values(segments ?? {}).flat().map(segment => segment.sessionId)]
      const last = (log ?? []).filter(line => line.kind === undefined).at(-1)
      const previewText = last ? unwrapUntrusted(last.text) : ''
      const previewWho = last && (last.authorKind === 'human' && last.who && last.who !== 'User' ? `${last.who}: ${previewText}` : last.who === 'User' ? previewText : `${last.who}：${previewText}`)
      const presented = rt.presentRoom?.({ ...room, log }, actor) ?? room
      const pending = rt.listRoomApprovals?.(presented, actor) ?? []
      return {
        ...presented,
        log: undefined,
        parts,
        pendingApprovals: pending,
        pendingCount: pending.length,
        ...(last ? { preview: previewWho } : {}),
      }
    }),
    humans: rt.publicHumans?.() ?? [],
    self: actor ? { memberId: actor.memberId, displayName: actor.displayName } : null,
    exchangeTurns: state.exchangeTurns,
    // Per Session: turn → the person's name, for friends' lines Bot Social attests they typed themselves.
    remoteTypedTurns: state.remoteTypedTurns ?? {},
    // Per friend chat: when my message left, while its reply has not come back (#443).
    remoteAwaiting: state.remoteAwaiting ?? {},
    questions: state.questions,
    // FlyBot: friends' remote Bots, chat members with a remote badge (not team Bots).
    remoteBots: rt.flybotRemoteMembers?.() ?? [],
    // The team's DSH Agent (at most one): plain dsh Sessions, not Bots.
    agents: Object.values(state.agents),
    // Key names and who may use them; values never leave the host.
    secrets: rt.secretsView(),
    capabilities: rt.capabilityLibraryView(),
    secretRequests: state.secretRequests ?? {},
    colors: [...COLORS, ...EXTRA_COLORS],
    // Friends' Bots' routes are no model a Bot can pick.
    models: rt.cachedCatalog().filter(entry => entry.provider !== 'flybot-remote'),
    defaultModel: rt.cachedDefault() ?? null,
    permissions: rt.permissionCatalog?.() ?? null,
    modelsKey: modelsKey(),
    prefs: state.prefs,
    // Whether a Desktop window should serve Bot browser reads (see browser.js).
    browser: rt.browserEnabled,
    // False when config.memory turns memory off: no Memory row or panel.
    memory: rt.memoryEnabled !== false,
    // Set while another dsh host holds the team (store.js): why this one cannot change it.
    readOnly: rt.readOnly() ?? null,
    })
    // authz.js narrows to the actor; per-session entries keep the actor's own, and
    // deployment-wide surfaces follow the same single-member rule as the writes.
    return rt.ownedView(full, actor)
  }
  // What changes without a new revision, sent with every state answer. `memoryNews`:
  // per Bot, its latest memory change; `memoryReviews`: memory reviews waiting or
  // running; `work`: per Bot, the turn it runs and its tool; per group, the members whose
  // turn there runs; the approvals waiting; and the turns that just finished or failed.
  const live = actor => {
    const full = {
      activity: rt.activityView(),
      work: { bots: rt.workView(), rooms: rt.roomWorkView(), approvals: rt.approvalsView(), ended: rt.endedView?.() ?? [] },
      memoryNews: rt.memoryNews(),
      memoryReviews: rt.memoryReviews(),
      connectors: rt.connectorsView(),
      capabilityStatuses: rt.capabilityStatusesView(),
    }
    // Plugin tool names change with a plugin reload, not with the team revision, so they ride every
    // answer, unchanged or not, and the client re-reads its hidden-row set (#419).
    return { ...rt.ownedLive(full, actor), pluginTools: rt.pluginToolNames?.() ?? [] }
  }
  // What a host that only reads the team may still answer.
  // Updates change the dsh profile, not the team, so a reading host may run them too.
  // auth-whoami is a read of the already-resolved actor; invite/redeem/revoke/remove-member write.
  const READS = new Set(['state', 'models', 'efforts', 'earlier', 'room-progress', 'room-history', 'exchange', 'usage', 'schedules', 'memory-view', 'browser-wait', 'browser-result', 'diagnostics', 'diagnostics-log', 'diagnostics-clear', 'update-check', 'update-install', 'dsh-update-install', 'repo-stars', 'approval-answer', 'auth-whoami'])

  // A chat reference chip names a Session whose snapshot rides to every recipient of
  // the message, so the author must be able to read what they share (#53, #106).
  // Actor-authored text that becomes a session user message: send, room-post,
  // answer-question, schedule-create, schedule-update. Bot-authored room posts strip chips in groups.js.
  // Menu chips encode the session id as base64url(JSON); raw ids still appear in tests.
  const decodeSessionChip = (payload) => {
    try { return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) } catch { return undefined }
  }
  const unshareableReference = (actor, text) => {
    if (!actor || !rt.authzEnforced?.() || typeof text !== 'string') return undefined
    for (const match of text.matchAll(/dsh-session:([A-Za-z0-9_-]+)/g)) {
      const id = decodeSessionChip(match[1]) ?? match[1]
      if (!rt.sessionOwnedBy?.(actor, id)) return id
    }
    return undefined
  }

  function setPrefs(body) {
    if (body.theme !== undefined) {
      if (typeof body.theme !== 'string' || !/^[a-z][\w-]{0,31}$/.test(body.theme)) throw invalid('Unknown theme')
      state.prefs.theme = body.theme
    }
    if (body.accent !== undefined) {
      if (body.accent === null || body.accent === '') delete state.prefs.accent
      else if (/^#[0-9a-f]{6}$/i.test(body.accent)) state.prefs.accent = body.accent
      else throw invalid('Accent must be a #rrggbb color')
    }
    if (body.motion !== undefined) {
      if (body.motion === null || body.motion === 'normal') delete state.prefs.motion
      else if (body.motion === 'quiet' || body.motion === 'lively') state.prefs.motion = body.motion
      else throw invalid('Motion must be quiet, normal or lively')
    }
    // Notifications are on unless switched off (#353).
    if (body.notifications !== undefined) {
      if (body.notifications === null || body.notifications === true) delete state.prefs.notifications
      else if (body.notifications === false) state.prefs.notifications = false
      else throw invalid('Notifications must be on or off')
    }
    return rt.save()
  }

  const handle = async (endpoint, payload, signal, sessionToken) => {
    try {
      const body = payload ?? {}
      await rt.refresh()
      const readOnly = rt.readOnly()
      const flybotRead = endpoint.startsWith('flybot/') && rt.flybotIsRead?.(endpoint.slice('flybot/'.length)) === true
      if (readOnly !== undefined && !READS.has(endpoint) && !flybotRead) return fail(readOnly, 'bot/read-only')
      // Actor is resolved once from the member session token; body.actorId / payload.actorId
      // grant nothing and are ignored (#48).
      const actor = sessionToken ? await rt.authenticate(sessionToken) : null
      const gate = rt.authorize(actor, endpoint, body)
      if (!gate.ok) return fail(gate.message, gate.code)
      switch (endpoint) {
        case 'state':
          if (typeof body.locale === 'string' && /^[a-z]{2,3}(-[\w-]+)?$/i.test(body.locale)) uiLocale = body.locale
          if (readOnly === undefined) await rt.bootstrap()
          await rt.catalog()
          await rt.loadSecrets()
          if (body.since === state.revision && (body.models === undefined || body.models === modelsKey())) return ok({ revision: state.revision, unchanged: true, ...live(actor) })
          return ok({ ...view(actor), ...live(actor) })
        case 'models':
          await rt.catalog({ fresh: true })
          return ok({ modelsKey: modelsKey() })
        case 'efforts':
          return ok(await rt.reasoningOf(String(body.ref ?? '')) ?? { efforts: [] })
        case 'test-model':
          await rt.load()
          return ok(await rt.testModel(String(body.id ?? '')))
        case 'duplicate-bot':
          await rt.load()
          return ok(await rt.duplicateBot(body.id))
        case 'set-prefs':
          await rt.load()
          await setPrefs(body)
          return ok(state.prefs)
        case 'exchange': {
          await rt.load()
          const pair = new Set([body.a, body.b])
          return ok(state.exchanges.filter(entry => pair.has(entry.from) && pair.has(entry.to)))
        }
        case 'earlier':
          await rt.load()
          return ok(await rt.earlierPage(String(body.sessionId ?? ''), body.cursor ?? undefined))
        case 'usage':
          await rt.load()
          return ok(await rt.usageView({ timeZone: typeof body.timeZone === 'string' ? body.timeZone.slice(0, 64) : undefined }))
        case 'room-progress':
          return ok([...rt.roomProgress.entries()].filter(([, entry]) => entry.roomId === body.roomId).map(([callId, entry]) => ({ callId, replies: entry.replies, speaking: entry.speaking ?? null })))
        case 'create-bot': {
          await rt.bootstrap()
          const bot = await rt.createBot({ name: body.name, role: body.role, color: body.color, instructions: body.instructions, brief: body.brief, avatar: body.avatar, model: body.model, effort: body.effort, workDir: body.workDir, ownerId: rt.authzEnforced() ? actor.memberId : undefined })
          return ok(bot)
        }
        case 'update-bot':
          await rt.load()
          return ok(await rt.updateBot(body.id, body))
        case 'delete-bot':
          await rt.load()
          await rt.deleteBot(body.id)
          return ok(view())
        case 'set-main':
          await rt.load()
          await rt.setMain(body.id, body.main !== false, {
            primary: body.primary === true,
            replace: typeof body.replace === 'string' ? body.replace : undefined,
          })
          return ok(view())
        case 'create-room': {
          await rt.load()
          const room = await rt.createRoom({
            members: Array.isArray(body.members) ? body.members : [],
            name: body.name,
            actor,
            ...(typeof body.admin === 'string' ? { admin: body.admin } : {}),
            ...(Array.isArray(body.participants) ? { participants: body.participants } : {}),
          })
          if (body.greet === true) await rt.greetRoom(room.id).catch(error => rt.warn('ds-bot: greeting in %s failed: %s', room.name, error))
          return ok(room)
        }
        case 'update-room': {
          await rt.load()
          const { room, changes } = await rt.updateRoom(body.id, {
            name: body.name,
            notice: body.notice,
            mode: body.mode,
            admin: body.admin,
            members: Array.isArray(body.members) ? body.members : undefined,
            add: Array.isArray(body.add) ? body.add : undefined,
            remove: Array.isArray(body.remove) ? body.remove : undefined,
            workDir: body.workDir,
            addParticipants: Array.isArray(body.addParticipants) ? body.addParticipants : undefined,
            removeParticipants: Array.isArray(body.removeParticipants) ? body.removeParticipants : undefined,
          }, undefined, actor)
          return ok({ room: view(actor).rooms.find(entry => entry.id === room.id), changes })
        }
        case 'room-history': {
          await rt.load()
          return ok(rt.roomHistory(String(body.roomId ?? body.id ?? ''), actor))
        }
        case 'room-post': {
          await rt.load()
          const leaked = unshareableReference(actor, body.text)
          if (leaked !== undefined) return fail('You do not own that chat', 'bot/forbidden')
          const line = await rt.postRoomMessage(String(body.roomId ?? body.id ?? ''), {
            text: body.text,
            authorId: body.authorId,
            authorKind: body.authorKind,
            displayName: body.displayName,
          }, actor)
          return ok(line)
        }
        case 'folders':
        case 'folder-pick':
        case 'folder-list':
          await rt.load()
          return ok(await rt.folderEndpoint(endpoint, body, signal))
        case 'add-agent':
          await rt.load()
          return ok(await rt.addAgent())
        case 'agent-session':
          await rt.load()
          return ok({ sessionId: await rt.createAgentSession(body.agentId, body.workspaceId) })
        case 'agent-adopt':
          await rt.load()
          return ok({ sessionId: await rt.adoptAgentSession(body.agentId, body.sessionId) })
        case 'agent-archive':
          await rt.load()
          await rt.archiveAgentSession(body.agentId, body.sessionId)
          return ok(true)
        case 'agent-rename':
          await rt.load()
          await rt.renameAgentSession(body.agentId, body.sessionId, body.title)
          return ok(true)
        case 'remove-agent':
          await rt.load()
          await rt.removeAgent(body.agentId)
          return ok(view())
        case 'set-flags':
          await rt.load()
          return ok(await rt.setFlags(body.id, body))
        case 'delete-room':
          await rt.load()
          await rt.deleteRoom(body.id)
          return ok(view())
        case 'approval-answer':
          rt.answerApproval(body.id, body.choice)
          return ok(true)
        case 'stop-member-work':
          return ok(await rt.stopMemberWork(String(body.roomId ?? ''), String(body.botId ?? '')))
        case 'dismiss-question':
          await rt.load()
          if (state.questions[body.sessionId] !== undefined) {
            delete state.questions[body.sessionId]
            await rt.save()
          }
          return ok(true)
        case 'secret-set':
        case 'secret-allow':
        case 'secret-cancel':
        case 'secret-update':
        case 'secret-delete':
          await rt.load()
          return ok(await rt.secretEndpoint(endpoint, body))
        case 'connector-connect':
        case 'connector-apps':
        case 'connector-app-search':
        case 'connector-app-status':
        case 'connector-disconnect':
        case 'connector-retry':
          await rt.load()
          return ok(await rt.connectorEndpoint(endpoint, body))
        case 'capability-save':
        case 'capability-delete':
        case 'capability-approve':
        case 'bot-capability':
          await rt.load()
          return ok(await rt.capabilityEndpoint(endpoint, body))
        case 'bot-connectors':
          return ok(await rt.botConnectorEndpoint(body))
        case 'schedules':
        case 'schedule-pause':
        case 'schedule-resume':
        case 'schedule-delete':
          await rt.load()
          return ok(await rt.scheduleEndpoint(endpoint, body))
        case 'schedule-create':
        case 'schedule-update': {
          await rt.load()
          const leaked = unshareableReference(actor, [body.title, body.prompt].filter(part => typeof part === 'string').join('\n'))
          if (leaked !== undefined) return fail('You do not own that chat', 'bot/forbidden')
          return ok(await rt.scheduleEndpoint(endpoint, body))
        }
        case 'memory-view':
        case 'memory-ask':
        case 'memory-forget':
          await rt.load()
          return ok(await rt.memoryEndpoint(endpoint, body))
        case 'answer-question': {
          if (typeof body.sessionId !== 'string') return fail('Nothing to send', 'bot/invalid')
          await rt.load()
          const past = rt.pastOwners.get(body.sessionId)
          const sessionId = rt.botOf(body.sessionId) ? rt.chatOf(body.sessionId) : past && past.roomId === undefined ? rt.chatOf(past.botId) : body.sessionId
          const question = state.questions[sessionId]
          if (question === undefined || question.id !== body.questionId) return fail('This question is no longer open', 'bot/stale')
          const reply = questionReply(question, body.answer)
          if (reply === undefined) return fail('Nothing to send', 'bot/invalid')
          const leaked = unshareableReference(actor, reply.text)
          if (leaked !== undefined) return fail('You do not own that chat', 'bot/forbidden')
          // Claim the question before queueing so a second answer is refused.
          delete state.questions[sessionId]
          try {
            await rt.ensureCapabilities(sessionId)
            const agent = await rt.resolveAgent(sessionId)
            agent.followup(createUserMessage({ content: [{ type: 'text', text: reply.text }], source: reply.source }))
            await ctx.sessions.flush(agent.session)
          } catch (error) {
            state.questions[sessionId] ??= question
            throw error
          }
          await rt.save()
          return ok(true)
        }
        case 'send': {
          const text = String(body.text ?? '').trim()
          if (text === '' || typeof body.sessionId !== 'string') return fail('Nothing to send', 'bot/invalid')
          await rt.load()
          const leaked = unshareableReference(actor, text)
          if (leaked !== undefined) return fail('You do not own that chat', 'bot/forbidden')
          // A Bot id or an earlier part of its own chat means the current part.
          const past = rt.pastOwners.get(body.sessionId)
          const sessionId = rt.botOf(body.sessionId) ? rt.chatOf(body.sessionId) : past && past.roomId === undefined ? rt.chatOf(past.botId) : body.sessionId
          const room = rt.roomOf(sessionId)
          if (room && isFaceRoom(room)) {
            if (actor && rt.authzEnforced() && !rt.roomMemberOf(actor, room.id)) return fail('You are not a member of that room', 'bot/forbidden')
            // Face rooms must not go through sessionController.prompt: that starts a local
            // bot round (turns/steps) and never fans the line to the other FlyBot instance.
            const line = await rt.postRoomMessage(room.id, { text, displayName: actor?.displayName }, actor)
            rt.notePostedLine?.(room.id, text)
            const who = line?.who || actor?.displayName || 'You'
            if (typeof rt.postToRoom === 'function') {
              await rt.postToRoom(room, { id: 'face-notice', name: who }, `${who}: ${text}`, { quiet: true, notice: true })
                .catch(error => rt.warn?.('ds-bot: face-room line not shown locally: %s', error))
            }
            // The line is in the room and on its way to the other home. The group Session then runs
            // the round: an @mention picks the Bot, a plain line the room's opening speaker (#287).
            // An @ that names nobody in the room gets one quiet line instead of silence.
            const missing = faceMentions(room, text, rt.botOf).unmatched
            if (missing.length > 0 && typeof rt.postToRoom === 'function') {
              const shown = [...new Set(missing)].slice(0, 3).map(word => word.replace(/[<>[\]`]/g, '')).join(', ')
              await rt.postToRoom(room, { id: 'face-notice', name: 'Room' }, `No one in this room is called ${shown}. Pick a name after @, or write @all to ask every Bot.`, { quiet: true, notice: true })
                .catch(error => rt.warn?.('ds-bot: face-room hint not shown: %s', error))
            }
          } else if (room && actor) {
            if (rt.authzEnforced() && !rt.roomMemberOf(actor, room.id)) return fail('You are not a member of that room', 'bot/forbidden')
            await rt.postRoomMessage(room.id, { text, displayName: actor.displayName }, actor)
            const agent = await rt.resolveAgent(sessionId)
            agent.followup(createUserMessage({
              content: [{ type: 'text', text }],
              source: { kind: 'user', authorId: actor.memberId, authorKind: 'human', authorName: actor.displayName },
            }))
            await ctx.sessions.flush(agent.session)
            return ok(true)
          }
          await rt.ensureCapabilities(sessionId)
          await ctx.sessionController.prompt({
            requestId: randomUUID(),
            sessionId,
            mode: 'queue',
            content: [{ type: 'text', text }],
          }, AbortSignal.timeout(30_000))
          return ok(true)
        }
        case 'update-check': {
          const fresh = body.fresh === true
          return ok({ ...(await rt.updateCheck({ fresh })), dsh: (await rt.dshUpdateCheck?.({ fresh })) ?? null })
        }
        case 'update-install':
          return ok(rt.updateStart())
        case 'dsh-update-install':
          return ok(rt.dshUpdateStart?.())
        case 'repo-stars':
          return ok(await rt.repoStars())
        // The Desktop window's long poll for read_browser, and its answers.
        case 'browser-wait': {
          if (rt.browserChannel === undefined) return fail('Bot browsers are off on this host', 'bot/browser-off')
          const clientId = typeof body.clientId === 'string' ? body.clientId.slice(0, 100) : ''
          if (clientId === '') return fail('A browser poll needs a clientId', 'bot/invalid')
          await rt.load()
          return ok(await rt.browserChannel.wait(clientId, rt.browserOpen(body.open)))
        }
        case 'browser-result':
          if (rt.browserChannel === undefined) return fail('Bot browsers are off on this host', 'bot/browser-off')
          return ok(rt.browserChannel.result(body))
        case 'diagnostics':
          await rt.load()
          return ok(await rt.diagnostics.report(body))
        case 'diagnostics-log':
          return ok(await rt.diagnostics.logText())
        case 'diagnostics-clear':
          await rt.diagnostics.clear()
          return ok(true)
        case 'tasks':
        case 'task-create':
        case 'task-accept':
        case 'task-start':
        case 'task-return':
        case 'task-accept-result':
        case 'task-cancel':
        case 'task-wait-input':
        case 'task-answer-input':
          await rt.load()
          return ok(await rt.taskEndpoint(endpoint, body, actor))
        case 'share-brief':
          await rt.load()
          await rt.setBriefShare(String(body.id ?? ''), String(body.botId ?? ''), body.share === true, actor)
          return ok(true)
        case 'auth-whoami':
          return ok(actor)
        case 'auth-invite': {
          if (!rt.authInviteAllowed(actor)) return fail('Sign in first', 'bot/unauthorized')
          const invite = await rt.createInvitation({ createdByMemberId: actor?.memberId ?? null })
          return ok(invite)
        }
        case 'auth-revoke-invite': {
          if (!actor) return fail('Sign in first', 'bot/unauthorized')
          const result = await rt.revokeInvitation(String(body.invitationId ?? ''))
          if (!result.ok) return fail(result.error, 'bot/auth')
          return ok(result)
        }
        case 'auth-redeem': {
          const result = await rt.redeemInvitation(body.token, { displayName: typeof body.displayName === 'string' ? body.displayName : null })
          if (!result.ok) return fail(result.error, 'bot/auth')
          return ok(result)
        }
        case 'auth-revoke': {
          if (!actor) return fail('Sign in first', 'bot/unauthorized')
          return ok(await rt.revokeSession(sessionToken))
        }
        case 'auth-remove-member': {
          if (!actor) return fail('Sign in first', 'bot/unauthorized')
          const removed = await rt.removeMember(String(body.memberId ?? ''))
          if (!removed.ok) return fail(removed.error, 'bot/auth')
          return ok(removed)
        }
        default:
          // FlyBot plugins' endpoints (src/host/hooks.js). The actor rides along so
          // owner-checked endpoints (held-send decisions) can bind it (#52).
          if (endpoint.startsWith('flybot/')) return ok(await rt.flybotEndpoint(endpoint.slice('flybot/'.length), body, { actor }))
          return fail(`Unknown endpoint ${endpoint}`, 'bot/not-found')
      }
    } catch (error) {
      const code = errorCode(error)
      const message = error?.message ?? String(error)
      if (code === 'bot/internal') rt.noteFailure({ source: 'api', text: `${endpoint}: ${message}`, code: error?.code ?? error?.name, stack: error?.stack })
      // A refusal may carry a plain JSON `details` object the client acts on; nothing else rides along.
      const details = error?.details !== null && typeof error?.details === 'object' && !Array.isArray(error.details) ? error.details : {}
      return fail(message, code, details)
    }
  }

  // An exact Fetch route on the shared /api channel; the browser authenticates with its session cookie.
  const route = {
    path: ROUTE,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      let body
      try { body = await request.json() } catch { body = {} }
      const sessionToken = request.headers.get('x-flybot-member-session')
      const result = await handle(String(body?.endpoint ?? ''), body?.payload, request.signal, sessionToken)
      return new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  }
  ctx.effect(() => registerRoute(ctx, route, rt.warn), 'ds-bot: api route')
  ctx.effect(() => {
    void rt.load()
    return () => {}
  }, 'ds-bot: load state')
}

// Registers the exact Fetch route, surviving a hot reload. When the plugin manager reloads
// ds-bot in a running DSH, the new instance can start before the old one is disposed; the
// connection then refuses the duplicate path ("already registered") and that refusal used to
// fail the whole apply, so once the old instance went away nothing served /api/bot and every
// browser call (Friends' Bots "Create invite link" included) got HTTP 404 until a restart.
// Here a taken path is retried until the old owner lets go.
export function registerRoute(ctx, route, warn = () => {}, { every = 100, tries = 600 } = {}) {
  let dispose
  let timer
  let stopped = false
  const attempt = (left) => {
    if (stopped) return
    try {
      dispose = ctx.connection.fetch.register(route)
    } catch (error) {
      if (!/already registered/i.test(String(error?.message ?? error)) || left <= 0) throw error
      if (left === tries) warn('ds-bot: %s is still held by the previous instance; waiting for it', route.path)
      timer = setTimeout(() => {
        try { attempt(left - 1) } catch (failure) { warn('ds-bot: could not register %s: %s', route.path, failure) }
      }, every)
      timer.unref?.()
    }
  }
  attempt(tries)
  return () => {
    stopped = true
    clearTimeout(timer)
    dispose?.()
  }
}
