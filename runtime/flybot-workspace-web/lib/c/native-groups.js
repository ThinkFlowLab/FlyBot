// Bot Social is the one shared conversation store. A native roster room holds a
// stable pointer to it; native and plugin views read/write the SAME messages and
// membership, rather than copying a second chat log. No model call on import.
import { createHash, randomUUID } from 'node:crypto'
import { nativeGroupCreation } from './native-group-create.js'
import { nativeGroupDirectory } from './native-group-directory.js'
import { nativeGroupRelay, prepareNativeRoomStream } from './native-group-relay.js'
const installed = new WeakMap()
const replyModes = new Set(['default', 'everyone', 'lead', 'mentions'])
const groupAgentId = /^[A-Za-z0-9._:-]{1,80}$/
const objectId = /^[0-9a-f]{32}$/
// The native picker's inline chip uses a text codec. Preserve ordinary code
// samples and links, and let Bot Social validate the exact selections.
const nativeMention = /```[\s\S]*?(?:```|$)|`[^`\n]*`|@\[(?:\\[\\[\]]|[^\\\]\n])+\]\(ot-agent:([A-Za-z0-9._:-]{1,80})\/([A-Za-z0-9._:-]{1,80})\)|\[[^\]\n]*\]\([^\s)]*(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\)/g

function nativeGroupMessage(text) {
  const targets = new Map()
  const body = text.replace(nativeMention, (value, owner_id, agent_id) => {
    if (!owner_id) return value
    targets.set(owner_id + '/' + agent_id, {owner_id, agent_id})
    return ' '
  })
  if (!targets.size) return {body:text}
  if (!body.trim()) throw Object.assign(new Error('Add a message for the selected agents.'), {code:'bot/invalid'})
  return {body:body.trim(), agent_mentions:[...targets.values()]}
}

function replyTarget(value) {
  if (!value || typeof value.owner_id !== 'string' || !groupAgentId.test(value.owner_id) ||
      typeof value.agent_id !== 'string' || !groupAgentId.test(value.agent_id)) return null
  return {owner_id:value.owner_id, agent_id:value.agent_id}
}

function projectedReplyPolicy(conversation, revision = conversation.group_management?.revision) {
  const routing = conversation.group_agent_routing
  const policy = routing?.policy
  if (!replyModes.has(policy?.mode)) return undefined
  const lead = replyTarget(policy.lead)
  const targets = (conversation.agents || []).flatMap(agent => {
    const pair = replyTarget({owner_id:agent.owner?.owner_id, agent_id:agent.agent_ref})
    return pair ? [{...pair, name:agent.name, owner_name:agent.owner.display_name || agent.owner.handle,
      owner_handle:agent.owner.handle}] : []
  })
  return {mode:policy.mode, ...(lead ? {lead} : {}),
    ...(policy.lead_unavailable === true ? {lead_unavailable:true} : {}),
    context:routing.mode, default:routing.default, can_edit:routing.can_edit === true,
    ...(Number.isSafeInteger(revision) ? {revision} : {}), targets}
}

const activityRevision = version => /^\d+\.\d+\.\d+\.\d+$/.test(version || '') ? Number(version.split('.')[1]) : -1

function replyPolicyChange(patch) {
  if (!patch || !replyModes.has(patch.mode) || !Number.isSafeInteger(patch.revision) || patch.revision < 0 ||
      Object.keys(patch).some(key => !['mode', 'revision', 'lead'].includes(key))) {
    throw new Error('Invalid shared group reply policy')
  }
  const lead = replyTarget(patch.lead)
  if (patch.mode === 'lead' ? !lead || Object.keys(patch.lead).length !== 2 : Object.hasOwn(patch, 'lead')) {
    throw new Error('Choose one eligible shared group agent')
  }
  return {action:'reply_policy', mode:patch.mode, revision:patch.revision, ...(lead ? {lead} : {})}
}

export function nativeGroupClient(host, raw) {
  async function install() {
    const s = host.currentRuntime?.()
    if (!s?.rt?.state) return null
    const { rt } = s
    if (installed.has(rt)) return installed.get(rt)
    const roomFor = id => rt.roomOf(id)?.flybotWorkspace?.conversation_id
    const snapshots = new Map()
    const pendingSave = new Set()
    const left = new Map()
    const groupRoom = cid => Object.values(rt.state.rooms).find(room => room.flybotWorkspace?.conversation_id === cid)
    const mapped = (conversation, room) => ({...conversation, native_room_id:room.id, native_session_id:room.id})
    const syncOne = async conversation => {
      if (conversation?.kind !== 'group' || conversation.public_agent) return conversation
      const title = conversation.title || 'FlyBot group'
      const revision = conversation.group_management?.revision
      if (left.has(conversation.id)) {
        if (!Number.isSafeInteger(revision) || revision <= left.get(conversation.id)) return conversation
        left.delete(conversation.id)
      }
      const latest = snapshots.get(conversation.id)
      let room = groupRoom(conversation.id)
      const latestManagement = room?.flybotWorkspace.management_revision
      const activity = activityRevision(conversation.activity_version)
      if (room && ((Number.isSafeInteger(revision) && revision < latestManagement) ||
          (!(revision > latestManagement) && activity >= 0 && activity < latest?.activity))) return mapped(conversation, room)
      const ownedAgents = (conversation.agents || []).filter(agent => agent.mine)
      const participants = (conversation.members || []).map(m => ({ id: m.owner_id, handle: m.handle, kind: 'human', remote: true, name: m.display_name || m.handle, platform_user_id: m.platform_user_id }))
      const projectedRevision = revision ?? (latest?.version === conversation.activity_version ? room?.flybotWorkspace.reply_policy?.revision : undefined)
      const replyPolicy = projectedReplyPolicy(conversation, projectedRevision)
      const nativeHost = conversation.group_agent_routing?.native_group_host
      const coordinator = conversation.group_agent_routing?.native_group_coordinator === true
      const roster = conversation.agents || []
      const administrator = replyPolicy?.mode === 'lead' && !replyPolicy.lead_unavailable ? replyPolicy.lead : null
      const adminSeat = administrator && ownedAgents.find(agent => agent.owner?.owner_id === administrator.owner_id &&
        agent.agent_ref === administrator.agent_id)
      const adminAgent = adminSeat && (await host.call('agents/byId', {id:adminSeat.agent_ref})).agent
      const admin = (adminAgent && !adminAgent.native_deleted && adminAgent.native_bot_id) || null
      const signature = JSON.stringify([title, conversation.team_id, revision, conversation.activity_version,
        participants, roster.map(agent => [agent.owner?.owner_id, agent.agent_ref, agent.name, agent.mine]), replyPolicy, admin, nativeHost, coordinator])
      if (room && latest?.signature === signature) return mapped(conversation, room)
      const localBots = new Set()
      const localSeats = new Map()
      for (const agent of ownedAgents) {
        const mappedAgent = agent === adminSeat ? adminAgent : (await host.call('agents/byId', {id:agent.agent_ref})).agent
        if (mappedAgent && !mappedAgent.native_deleted && mappedAgent.native_bot_id) {
          localBots.add(mappedAgent.native_bot_id)
          localSeats.set(agent.agent_ref, mappedAgent.native_bot_id)
        }
      }
      const locals = [...localBots]
      const collidingNames = new Set(roster.filter((agent, index) => roster.findIndex(item =>
        item.name?.toLowerCase() === agent.name?.toLowerCase()) !== index).map(agent => agent.name?.toLowerCase()))
      const nativeSeats = coordinator ? roster.flatMap(agent => {
        const target = replyTarget({owner_id:agent.owner?.owner_id,agent_id:agent.agent_ref})
        if (!target) return []
        const local = localSeats.get(agent.agent_ref)
        if (agent.mine) return local ? [local] : []
        const id = 'ot-remote:' + createHash('sha256').update(JSON.stringify([target.owner_id,target.agent_id])).digest('hex')
        const name = collidingNames.has(agent.name?.toLowerCase()) ? `${agent.name} (${agent.owner.handle})` : agent.name
        return [{id,name,owner_id:target.owner_id,agent_ref:target.agent_id,remote:true}]
      }) : undefined
      const nativeAdmin = coordinator && administrator && !adminSeat
        ? nativeSeats.find(seat => seat?.owner_id === administrator.owner_id && seat.agent_ref === administrator.agent_id)?.id
        : undefined
      const announcement = await raw.get('/v1/ot/conversations/'+encodeURIComponent(conversation.id)+'/announcement')
      const mode = replyPolicy?.mode === 'everyone' || replyPolicy?.lead_unavailable ? 'everyone' : 'admin'
      const state = {name:title, members:locals, remoteParticipants:participants, notice:announcement.announcement.body, mode, admin}
      let created = false
      if (!room) {
        // Shared groups allow duplicate and longer titles than DS-Bot's native creator.
        const nativeTitle = title.replace(/\s+/g, ' ')
        if (rt.createRoom && locals.length >= 2 && locals.length <= 12 && nativeTitle.length <= 60 &&
            !rt.findRooms?.(nativeTitle).length) {
          room = await rt.createRoom({name:title,members:locals,mode,admin})
        } else {
          const id = await rt.createSession(title)
          room = {id,named:true,createdAt:Date.now(),createdBy:null}
          rt.state.rooms[id] = room
        }
        Object.assign(room, {origin:'flybot-workspace',flybotWorkspace:{conversation_id:conversation.id}})
        created = true
      }
      const changed = created || Object.keys(state).some(key => JSON.stringify(room[key]) !== JSON.stringify(state[key])) ||
        room.flybotWorkspace.team_id !== conversation.team_id || (Number.isSafeInteger(revision) && latestManagement !== revision) ||
        room.flybotWorkspace.account_group !== (conversation.account_group === true) ||
        room.flybotWorkspace.native_group_host !== nativeHost ||
        JSON.stringify(room.flybotWorkspace.native_bot_seats) !== JSON.stringify(nativeSeats) ||
        room.flybotWorkspace.native_group_admin !== nativeAdmin ||
        JSON.stringify(room.flybotWorkspace.reply_policy) !== JSON.stringify(replyPolicy)
      if (changed) {
        Object.assign(room, state)
        room.flybotWorkspace.team_id = conversation.team_id
        if (Number.isSafeInteger(revision)) room.flybotWorkspace.management_revision = revision
        room.flybotWorkspace.account_group = conversation.account_group === true
        if (typeof nativeHost === 'string') room.flybotWorkspace.native_group_host = nativeHost
        else delete room.flybotWorkspace.native_group_host
        if (nativeSeats) room.flybotWorkspace.native_bot_seats = nativeSeats
        else delete room.flybotWorkspace.native_bot_seats
        if (nativeAdmin) room.flybotWorkspace.native_group_admin = nativeAdmin
        else delete room.flybotWorkspace.native_group_admin
        if (replyPolicy) room.flybotWorkspace.reply_policy = replyPolicy
        else delete room.flybotWorkspace.reply_policy
        pendingSave.add(conversation.id)
      }
      if (prepareNativeRoomStream(rt, room, created ? 0 : undefined)) pendingSave.add(conversation.id)
      if (pendingSave.has(conversation.id)) {
        await rt.save({required:true})
        pendingSave.delete(conversation.id)
      }
      snapshots.set(conversation.id, {signature, activity, version:conversation.activity_version})
      return mapped(conversation, room)
    }
    let queue = Promise.resolve()
    const ordered = task => { const next = queue.then(task); queue = next.catch(() => {}); return next }
    const sync = conversation => ordered(() => syncOne(conversation))
    const turn = async (agent, text, signal) => (await host.call('agents/groupTextTurn', {
      agent_id:agent, text:text.slice(-42000).toWellFormed(), signal, onProgress:() => {},
    })).text
    const relay = nativeGroupRelay({rt,raw,sync,turn,log:host.log ?? (() => {})})
    const create = nativeGroupCreation(host, raw, rt, sync)
    const directory = nativeGroupDirectory(host, raw)
    const originalMobile = rt.mobileEndpoint.bind(rt)
    rt.mobileEndpoint = async (endpoint, p) => {
      if (endpoint === 'flybot-workspace-group-workspaces') return create.workspaces(p)
      if (endpoint === 'flybot-workspace-group-create') return create.create(p)
      if (endpoint === 'flybot-workspace-group-directory') return directory.list(p)
      if (endpoint === 'flybot-workspace-group-open') return ordered(async () => {
        const group = await directory.get(p)
        const opened = await syncOne(group)
        const room = rt.roomOf(opened.native_room_id)
        if (!room || room.flybotWorkspace?.conversation_id !== group.id) {
          throw Object.assign(new Error('Could not open the shared group. Refresh the list and try again.'),{code:'bot/refused'})
        }
        return {conversation_id:group.id,room}
      })
      const cid = endpoint === 'room-chat' && roomFor(p?.roomId)
      if (!cid) return originalMobile(endpoint, p)
      await sync(await raw.get('/v1/ot/conversations/' + encodeURIComponent(cid)))
      const before = p?.cursor?.beforeSeq
      const data = await raw.get('/v1/ot/conversations/' + encodeURIComponent(cid) + '/messages?limit=100' + (Number.isInteger(before) ? '&before=' + before : ''))
      const room = rt.roomOf(p.roomId)
      const work = room?.flybotWorkspace?.native_exchange && rt.workingInRoom?.(room)
      let activity
      if (typeof room?.flybotWorkspace.native_group_host === 'string') {
        const progress = await raw.get('/v1/ot/conversations/' + encodeURIComponent(cid) + '/reply-progress')
        activity = {running:(progress.working_bots?.length ?? 0) > 0 || Boolean(work && rt.roomActive(room.id)),
          speaking:work?.[0]?.bot.id ?? progress.working_bots?.[0]?.id ?? null, working_bots:progress.working_bots ?? []}
      } else if (work) activity = {running:rt.roomActive(room.id) || work.length > 0, speaking:work[0]?.bot.id ?? null}
      else activity = await host.call('agents/groupActivity', { conversation_id: cid })
      return { roomId: p.roomId, items: (data.messages || []).map(m => ({
        id: m.id, kind: m.mine === true ? 'user' : 'bot',
        name: m.author?.name || m.author?.display_name || m.author?.handle || '',
        text: m.retracted ? '' : m.body, time: m.created_at, source_message_id: m.id, revision: m.revision,
      })), cursor: data.messages?.[0]?.seq > 1 ? { beforeSeq: data.messages[0].seq } : null, ...activity }
    }
    const originalSend = rt.sendUser.bind(rt)
    rt.sendUser = async p => {
      const cid = roomFor(p?.sessionId)
      if (!cid) return originalSend(p)
      if (!Array.isArray(p.content) || p.content.some(c => c.type !== 'text')) throw new Error('Shared groups currently accept text only')
      const path = '/v1/ot/conversations/' + encodeURIComponent(cid) + '/messages'
      const body = {
        ...nativeGroupMessage(p.content.map(c => c.text).join('\n')), client_key:String(p.requestId || randomUUID()).slice(0,80),
      }
      return relay ? relay.send(data => raw.post(path, data), 'POST', path, body) : raw.post(path, body)
    }
    const originalUpdate = rt.updateRoom.bind(rt)
    rt.updateRoom = async (id, patch, ...rest) => {
      const cid = roomFor(id)
      if (!cid) return originalUpdate(id, patch, ...rest)
      patch = Object.fromEntries(Object.entries(patch).filter(([,v]) => v !== undefined))
      const base = '/v1/ot/conversations/' + encodeURIComponent(cid)
      if (Object.hasOwn(patch, 'flybotWorkspaceReplyPolicy')) {
        if (rest[0] !== undefined) throw new Error('Only a human can change shared group reply settings')
        if (Object.keys(patch).length !== 1) throw new Error('Save the shared group reply policy on its own')
        const update = patch.flybotWorkspaceReplyPolicy
        const refresh = () => raw.get(base).then(sync)
        if (update?.refresh === true && Object.keys(update).length === 1) {
          await refresh()
          return {room:rt.roomOf(id), changes:[]}
        }
        const change = replyPolicyChange(update)
        const shared = rt.roomOf(id).flybotWorkspace
        if (shared.reply_policy?.can_edit !== true) throw new Error('Only the group owner can change who answers')
        if (!Number.isSafeInteger(shared.reply_policy.revision)) throw new Error('Refresh the shared group settings before saving')
        let scope
        if (shared.team_id) {
          const directory = await raw.get('/v1/ot/workspaces')
          const workspace = directory.workspaces?.find(item => item.id === shared.team_id)?.workspace_id
          if (!objectId.test(workspace || '')) throw new Error('This group’s workspace is unavailable')
          scope = {workspace}
        } else if (shared.account_group) scope = {direct:true}
        else throw new Error('This shared group has no reply policy scope')
        try {
          const result = await raw.post(base + '/management', {...change, ...scope})
          if (result?.conversation?.id !== cid || !Number.isSafeInteger(projectedReplyPolicy(result.conversation)?.revision)) {
            throw new Error('Could not confirm the shared group reply policy')
          }
          await sync(result.conversation)
          return {room:rt.roomOf(id), changes:[]}
        } catch (error) {
          await refresh().catch(() => {})
          throw error
        }
      }
      if (patch.members) {
        const previous = rt.roomOf(id).members || []
        patch.add = patch.members.filter(bid => !previous.includes(bid))
        patch.remove = previous.filter(bid => !patch.members.includes(bid))
        delete patch.members
      }
      const allowed = new Set(['name','add','remove','notice','remoteParticipants'])
      if (Object.keys(patch).some(k => !allowed.has(k))) throw new Error('Change shared group settings in FlyBot; unsupported native changes are not applied locally')
      if (patch.remoteParticipants !== undefined) {
        if (!Array.isArray(patch.remoteParticipants) || patch.remoteParticipants.length > 200 || patch.remoteParticipants.some(h => typeof h !== 'string' || !/^[A-Za-z0-9._-]{1,80}$/.test(h))) throw new Error('Provide member handles, not native Bot IDs')
        const current = await raw.get(base), me = await raw.get('/v1/ot/me')
        const wanted = [...new Set(patch.remoteParticipants)]
        if (!wanted.includes(me.handle)) throw new Error('Use Leave group to remove yourself')
        const previous = (current.members || []).map(m=>m.handle)
        for (const handle of wanted.filter(h=>!previous.includes(h))) await raw.post(base+'/members', {handle})
        for (const handle of previous.filter(h=>!wanted.includes(h))) await raw.del(base+'/members/'+encodeURIComponent(handle))
      }
      if (patch.name !== undefined) await raw.patch(base, { title: patch.name })
      for (const bid of patch.add || []) {
        const bot = rt.botOf(bid)
        if (!bot?.flybotWorkspace?.agent_id) throw new Error('Assign this native Bot to a workspace before adding it to a shared group')
        await raw.put(base + '/agents/' + encodeURIComponent(bot.flybotWorkspace.agent_id), { name: bot.name, auto_reply: false })
      }
      for (const bid of patch.remove || []) {
        const bot = rt.botOf(bid)
        if (bot?.flybotWorkspace?.agent_id) await raw.del(base + '/agents/' + encodeURIComponent(bot.flybotWorkspace.agent_id))
      }
      if (patch.notice !== undefined) {
        const current = await raw.get(base + '/announcement')
        await raw.post(base + '/announcement', { body: patch.notice, revision: current.announcement.revision })
      }
      const result = await sync(await raw.get(base))
      return { room: rt.roomOf(result.native_room_id), changes: [] }
    }
    const originalDelete = rt.deleteRoom.bind(rt)
    rt.deleteRoom = async id => {
      const cid = roomFor(id)
      if (cid) {
        const me = await raw.get('/v1/ot/me')
        await raw.del('/v1/ot/conversations/' + encodeURIComponent(cid) + '/members/' + encodeURIComponent(me.handle))
        snapshots.delete(cid)
      }
      return originalDelete(id)
    }
    const archive = (cid, revision) => {
      if (Number.isSafeInteger(revision)) left.set(cid, Math.max(revision, left.get(cid) ?? -1))
      return ordered(async () => {
        const room = groupRoom(cid)
        if (room && !(room.flybotWorkspace.management_revision > revision)) await originalDelete(room.id)
        snapshots.delete(cid)
        pendingSave.delete(cid)
      })
    }
    const api = { sync, archive, relay, create: create.create }
    installed.set(rt, api)
    return api
  }
  void install().catch(error => host.log?.('Native shared-group hooks unavailable: ' + String(error.code || 'error')))
  const syncForPlugin = async (api, conversation) => {
    try { return await api.sync(conversation) }
    catch {
      host.log?.('Native group projection will retry when opened.')
      return conversation
    }
  }
  const request = async (method, path, body, options) => {
    const conversations = path.startsWith('/v1/ot/conversations')
    const api = conversations ? await install() : null
    const post = data => raw.request(method, path, data, options)
    const result = api?.relay && method === 'POST' ? await api.relay.send(post, method, path, body) : await post(body)
    if (!api) return result
    if (path.endsWith('/management')) {
      if (result?.left === true && result.conversation_id) {
        void api.archive(result.conversation_id, body?.revision).catch(() => host.log?.('Native group archive will need to be retried.'))
      } else if (result?.conversation?.kind === 'group') {
        return {...result,conversation:await syncForPlugin(api, result.conversation)}
      }
      return result
    }
    if (Array.isArray(result?.conversations)) {
      const conversations = await Promise.all(result.conversations.map(conversation => syncForPlugin(api, conversation)))
      return { ...result, conversations }
    }
    if (result?.kind === 'group' && result.id) return syncForPlugin(api, result)
    return result
  }
  async function createNativeGroup(payload) {
    const api = await install()
    if (!api) throw new Error('The native group service is not ready')
    return api.create(payload)
  }
  return { ...raw, request, createNativeGroup, get: (path,options) => request('GET',path,undefined,options), post: (path,b={}) => request('POST',path,b), put: (path,b={}) => request('PUT',path,b), patch: (path,b={}) => request('PATCH',path,b), del: path => request('DELETE',path) }
}
