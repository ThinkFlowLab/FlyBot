import { createHash } from 'node:crypto'
import { nativeGroupTurns } from './native-group-turns.js'

const ROOM_ID = /^otc_[0-9A-HJKMNP-TV-Z]{26}$/
const MESSAGE_ID = /^otm_[0-9A-HJKMNP-TV-Z]{26}$/
const POLL_INTERVAL = 1500
const PROGRESS_HEARTBEAT = 5000
const MAX_HISTORY = 40
const MAX_LINE = 4000
const revoked = new Set(['social/native_round_not_found', 'social/native_round_unavailable', 'social/conversation_not_found', 'social/agent_not_found'])
const messageRoute = /^\/v1\/ot\/conversations\/(otc_[0-9A-HJKMNP-TV-Z]{26})\/messages$/

function isNativeGroup(conversation) {
  return conversation?.kind === 'group' && typeof conversation.group_agent_routing?.native_group_host === 'string'
}

function localRoom(rt, conversation, room) {
  const seats = room?.flybotWorkspace?.native_bot_seats ?? room?.members
  const candidates = conversation?.agents ?? []
  if (!room || !isNativeGroup(conversation) || room.flybotWorkspace?.conversation_id !== conversation.id ||
      conversation.group_agent_routing.native_group_coordinator !== true || !seats ||
      candidates.length < 2 || candidates.length > 12 || candidates.length !== seats.length) return false
  return agentByPair(rt, room).size === candidates.length
}

const targetKey = (owner, ref) => JSON.stringify([owner, ref])

function agentByPair(rt, room) {
  const owner = room.flybotWorkspace.native_group_host
  const seats = room.flybotWorkspace.native_bot_seats ?? room.members
  return new Map(seats.flatMap(seat => {
    if (typeof seat !== 'string') return [[targetKey(seat.owner_id, seat.agent_ref), seat.id]]
    const ref = rt.botOf(seat)?.flybotWorkspace?.agent_id
    return ref ? [[targetKey(owner, ref), seat]] : []
  }))
}

function eligibleMessage(method, path, body) {
  if (method !== 'POST' || !body || typeof body.body !== 'string' || !body.body.trim() || !body.client_key) return undefined
  const room = messageRoute.exec(path)?.[1]
  const permitted = ['body', 'mentions', 'agent_mentions', 'client_key', 'workspace', 'direct', 'group_agent_request']
  return room && Object.entries(body).every(([key, value]) => value == null || permitted.includes(key)) ? room : undefined
}

function exchangePath(room, message) {
  return `/v1/ot/conversations/${room.flybotWorkspace.conversation_id}/native-rounds/${message}`
}

export function nativeGroupRelay({ rt, raw, sync, turn, log }) {
  if (typeof rt.beginSharedRoomRound !== 'function' || typeof rt.sharedRoomCursor !== 'function' ||
      typeof rt.workingInRoom !== 'function' || typeof rt.groupLinesAfter !== 'function') return null
  const activeLaunches = new Set()
  const progressSent = new WeakMap()
  const polling = new AbortController()
  const distributed = nativeGroupTurns({raw, turn, exchangePath, signal:polling.signal, report})
  if (turn) rt.sharedRoomTextTurn = distributed.execute
  let running = false
  let requested = false
  let inboxPending = true
  let timer

  const findRoom = conversationId => Object.values(rt.state.rooms).find(room => room.flybotWorkspace?.conversation_id === conversationId)
  const save = () => rt.save({required:true})
  const historyOf = room => room.flybotWorkspace.native_history ??= {through:0, cursor:0, mirrored:[]}
  const busy = room => activeLaunches.has(room.id) || rt.roomActive(room.id) || rt.workingInRoom(room).length > 0 || rt.roomBatchPending?.(room.id) === true

  async function send(post, method, path, body) {
    const id = eligibleMessage(method, path, body)
    if (!id || rt.readOnly?.() !== undefined) return post(body)
    const conversation = await raw.get('/v1/ot/conversations/' + id)
    if (!isNativeGroup(conversation)) return post(body)
    try {
      const result = await post({...body, native_round:true})
      wake()
      return result
    } catch (error) {
      // A roster can change between reading the group and committing a send.
      if (!['social/native_round_unavailable', 'social/native_round_conflict'].includes(error?.code)) throw error
      return post(body)
    }
  }

  async function seedHistory(room, item, bots) {
    const history = historyOf(room)
    if (history.through >= item.seq - 1) return
    const route = `/v1/ot/conversations/${item.conversation_id}/messages?limit=${MAX_HISTORY}&before=${item.seq}`
    const page = await raw.get(route)
    if (!Array.isArray(page?.messages)) throw new Error('Invalid shared group history')
    const kept = new Set(history.mirrored)
    for (const line of await rt.groupLinesAfter(room.id, history.cursor)) kept.add(line.flybotWorkspaceMessageId)
    for (const message of [...page.messages].sort((a,b) => a.seq - b.seq)) {
      if (message.seq <= history.through || kept.has(message.id) || message.retracted || !message.body ||
          !MESSAGE_ID.test(message.id) || message.seq >= item.seq) continue
      const botId = message.author?.kind === 'agent' ? bots.get(targetKey(message.author.owner?.owner_id, message.author.agent_ref)) : undefined
      const botName = botId && (rt.botOf(botId)?.name ?? room.flybotWorkspace.native_bot_seats?.find(seat => seat?.id === botId)?.name)
      rt.logRoom(room, {
        who: botName || message.author?.name || message.author?.display_name || 'Member',
        ...(botId ? {botId} : {}),
        text:message.body.slice(0, MAX_LINE).toWellFormed(),
        flybotWorkspaceMessageId:message.id,
        ...(Number.isFinite(message.created_at) ? {time:message.created_at} : {}),
      })
    }
    history.through = item.seq - 1
    history.cursor = rt.sharedRoomCursor(room.id)
    await save()
  }

  async function mirror(room, exchange) {
    const lines = await rt.groupLinesAfter(room.id, exchange.cursor)
    for (const line of lines) {
      const remote = line.nativeTurnId && room.flybotWorkspace.native_bot_seats?.find(seat => seat?.id === line.botId)
      if (line.kind === undefined && line.botId && (room.members.includes(line.botId) || remote) && line.text?.trim() &&
          (!exchange.text_only || line.flybotWorkspaceSharedRoundId === exchange.id)) {
        const ref = remote?.agent_ref ?? rt.botOf(line.botId)?.flybotWorkspace?.agent_id
        if (ref) {
          const key = createHash('sha256').update(JSON.stringify([room.id, line.seq])).digest('hex')
          const posted = await raw.post(exchangePath(room, exchange.id) + '/lines', {
            agent_ref:ref, body:line.text.trim().slice(0, MAX_LINE).toWellFormed(), client_key:'native:' + key,
            ...(remote ? {agent_owner_id:remote.owner_id,turn_id:line.nativeTurnId} : {}),
          })
          const {mirrored} = historyOf(room)
          if (MESSAGE_ID.test(posted?.id || '') && !mirrored.includes(posted.id)) {
            mirrored.push(posted.id)
            if (mirrored.length > MAX_HISTORY) mirrored.shift()
          }
        }
      }
      exchange.cursor = Math.max(exchange.cursor, line.seq)
    }
    if (lines.length) await save()
  }

  async function publishProgress(room, exchange) {
    const refs = [...new Set(rt.workingInRoom(room).map(({bot}) => bot?.flybotWorkspace?.agent_id).filter(Boolean))]
    const key = JSON.stringify(refs)
    const prior = progressSent.get(exchange)
    const now = Date.now()
    if ((!prior && !refs.length) || (prior?.key === key && (!refs.length || now - prior.at < PROGRESS_HEARTBEAT))) return
    await raw.post(exchangePath(room, exchange.id) + '/progress', {working_agent_refs:refs})
    progressSent.set(exchange, {key, at:now})
  }

  async function clear(room, exchange) {
    if (room.flybotWorkspace.native_exchange !== exchange) return
    delete room.flybotWorkspace.native_exchange
    await save()
  }

  async function abandon(room, exchange, finish) {
    if (busy(room)) {
      await rt.stopRoomWork(room.id)
      if (busy(room)) return
    }
    if (finish) {
      try { await raw.post(exchangePath(room, exchange.id), {action:'finish'}) }
      catch (error) { if (!revoked.has(error?.code)) throw error }
    }
    await clear(room, exchange)
  }

  async function launch(room, item, bots) {
    const prior = room.flybotWorkspace.native_exchange
    if (prior?.dispatched) return
    const path = exchangePath(room, item.message_id)
    // A running item without this host's pre-claim marker may already have
    // performed tools. Finish it without risking a duplicate execution.
    if (item.state === 'running' && !prior) {
      await raw.post(path, {action:'finish'})
      return
    }
    const selected = Array.isArray(item.agent_mentions)
      ? item.agent_mentions.map(target => bots.get(targetKey(target.owner_id, target.agent_id))).filter(Boolean) : []
    await seedHistory(room, item, bots)
    const exchange = prior ?? {id:item.message_id, cursor:rt.sharedRoomCursor(room.id), dispatched:false}
    room.flybotWorkspace.native_exchange = exchange
    await save()
    if (item.state === 'queued') {
      const result = await raw.post(path, {action:'start', ...(item.text_only ? {text_only:true} : {})})
      if (result?.started !== true) {
        await clear(room, exchange)
        return
      }
    }
    // Commit before calling tools. A restart after this point can flush
    // durable native lines, but cannot start the same round a second time.
    exchange.dispatched = true
    exchange.text_only = item.text_only === true
    await save()
    const conversation = await sync(await raw.get('/v1/ot/conversations/' + item.conversation_id))
    const nowShared = conversation?.team_id || (conversation?.members?.length ?? 0) > 1
    if (rt.state.rooms[room.id] !== room || !localRoom(rt, conversation, room) || (nowShared && !exchange.text_only)) {
      await abandon(room, exchange, true)
      return
    }
    activeLaunches.add(room.id)
    try {
      if (!item.agent_mentions?.length || selected.length) {
        await rt.beginSharedRoomRound(room.id, {text:item.body, sourceId:item.message_id, mentions:selected.length ? selected : undefined,
          ...(exchange.text_only ? {textOnly:true} : {}),
          ...(item.author?.display_name ? {author:item.author.display_name.slice(0, 80).toWellFormed()} : {})})
      }
    } finally {
      activeLaunches.delete(room.id)
      wake()
    }
  }

  async function tick() {
    if (running) { requested = true; return }
    if (polling.signal.aborted || rt.readOnly?.() !== undefined) return
    running = true
    try {
      const query = inboxPending ? '' : '?wait_ms=10000'
      const inbox = await raw.get('/v1/ot/native-group-inbox' + query, {signal:polling.signal})
      if (!Array.isArray(inbox?.items)) return
      const items = inbox.items
      const turns = Array.isArray(inbox.turns) ? inbox.turns : []
      distributed.accept(turns)
      inboxPending = items.length > 0 || turns.length > 0
      const byId = new Map(items.map(item => [item.message_id, item]))
      for (const room of Object.values(rt.state.rooms)) {
        const exchange = room.flybotWorkspace?.native_exchange
        if (!exchange || !MESSAGE_ID.test(exchange.id)) continue
        const item = byId.get(exchange.id)
        if (!item) {
          // Only running items are guaranteed to be included without a page
          // limit. A pre-claim marker can still be waiting for its queued item.
          if (exchange.dispatched) await abandon(room, exchange, true)
          else await clear(room, exchange)
          continue
        }
        if (!exchange.dispatched) continue
        try {
          if (item.text_only === true && exchange.text_only !== true) {
            await abandon(room, exchange, true)
            continue
          }
          await distributed.poll(room, exchange)
          await mirror(room, exchange)
          if (!busy(room)) {
            await raw.post(exchangePath(room, exchange.id), {action:'finish'})
            byId.delete(exchange.id)
            await clear(room, exchange)
          } else await publishProgress(room, exchange)
        } catch (error) {
          if (!revoked.has(error?.code)) { report(error); continue }
          byId.delete(exchange.id)
          await abandon(room, exchange, true)
        }
      }
      for (const item of items) {
        if (!byId.has(item.message_id) || !ROOM_ID.test(item.conversation_id) ||
            !MESSAGE_ID.test(item.message_id) || !Number.isSafeInteger(item.seq) ||
            !['queued', 'running'].includes(item.state) || typeof item.body !== 'string' || !item.body.trim()) continue
        let room = findRoom(item.conversation_id)
        if (room && (busy(room) || (room.flybotWorkspace.native_exchange && room.flybotWorkspace.native_exchange.id !== item.message_id))) continue
        try {
          const conversation = await sync(await raw.get('/v1/ot/conversations/' + item.conversation_id))
          room = findRoom(item.conversation_id)
          if (!localRoom(rt, conversation, room)) {
            if (room) await raw.post(exchangePath(room, item.message_id), {action:'finish'})
            continue
          }
          await launch(room, item, agentByPair(rt, room))
        } catch (error) {
          const exchange = room?.flybotWorkspace.native_exchange
          if (revoked.has(error?.code) && exchange?.id === item.message_id) await abandon(room, exchange, true)
          else if (!revoked.has(error?.code) && error?.code !== 'social/native_round_busy') report(error)
        }
      }
    } catch (error) {
      report(error)
    } finally {
      running = false
      if (requested && !polling.signal.aborted) {
        requested = false
        wake()
      }
    }
  }

  function report(error) {
    if (!['social/not-connected', 'social/not-configured', 'social/unreachable', 'social/unauthorized','social/http_404'].includes(error?.code)) {
      log('Native shared group relay will retry: ' + String(error?.code ?? 'error'))
    }
  }

  const wake = () => {
    if (polling.signal.aborted) return
    inboxPending = true
    if (running) requested = true
    else if (timer === undefined) {
      timer = setTimeout(() => { timer = undefined; void tick() }, 0)
      timer.unref?.()
    }
  }
  const removeListener = rt.onRoomLine?.(room => {
    if (room.flybotWorkspace?.native_exchange?.dispatched) wake()
  })
  const interval = setInterval(() => {
    if (inboxPending || Object.values(rt.state.rooms).some(room => room.flybotWorkspace?.native_exchange)) wake()
    else if (!running && timer === undefined && !polling.signal.aborted) void tick()
  }, POLL_INTERVAL)
  interval.unref?.()
  rt.ctx?.on?.('dispose', () => {
    polling.abort()
    clearInterval(interval)
    clearTimeout(timer)
    removeListener?.()
  })
  wake()
  return {send}
}
