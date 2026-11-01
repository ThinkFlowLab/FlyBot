// Roster: creating, changing, and deleting Bots and group chats, the Main Bot role, and
// the first Main Bot of a new team.
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { MAX_AVATAR_IMAGE, ROOM_MAX_MEMBERS, ROOM_MODES, ROOM_NAME_MAX, ROOM_NOTICE_MAX } from './constants.js'
import { currentColor, cut, isColor, unquote } from './text.js'
import { nameProblem } from '../shared/mentions.js'
import { cleanExternal } from './room-participant-external.js'
import { ownEntry } from './store.js'

export function install(rt) {
  const { ctx, config, home, defaults, state } = rt

  let bootstrapping = null

  async function ensureWorkspace() {
    if (state.workspaceId && ctx.workspaceRegistry.get(state.workspaceId)) return state.workspaceId
    const path = config.workspace ?? join(home, 'workspace')
    await mkdir(path, { recursive: true })
    const workspace = await ctx.workspaceRegistry.resolveByPath(path) ?? await ctx.workspaceRegistry.create(path, 'FlyBot')
    state.workspaceId = workspace.id
    await rt.save()
    return workspace.id
  }

  // `dir` is a working folder outside the team workspace. Such a Session is made by cwd
  // alone, so it joins no DSH workspace and the user's own project lists stay as they are.
  async function createSession(title, { dir } = {}) {
    // A Bot's tools run here too; while another dsh holds the team, a new Session would
    // belong to no saved Bot.
    const readOnly = rt.readOnly()
    if (readOnly !== undefined) throw new Error(readOnly)
    const usable = dir !== undefined && await rt.isFolder(dir)
    if (dir !== undefined && !usable) rt.warn('ds-bot: the working folder %s is gone; %s starts in the team workspace', dir, title)
    const { sessionId } = await ctx.sessionController.create(usable ? { cwd: dir } : { workspaceId: await ensureWorkspace() })
    const agent = await rt.resolveAgent(sessionId)
    await ctx.sessionTitle.rename(agent.session, title)
    return sessionId
  }

  function cleanAvatar(input) {
    if (input === null || typeof input !== 'object') return undefined
    const avatar = {}
    if (typeof input.shape === 'string' && /^[a-z][\w-]{0,31}$/.test(input.shape)) avatar.shape = input.shape
    if (typeof input.image === 'string') {
      if (!/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(input.image)) throw new Error('Avatar images must be PNG, JPEG, WebP, or GIF')
      if (input.image.length > MAX_AVATAR_IMAGE) throw new Error('Avatar image is too large')
      avatar.image = input.image
    }
    return Object.keys(avatar).length > 0 ? avatar : undefined
  }

  const freshName = (base) => {
    const stem = base.slice(0, 34)
    if (!rt.findBot(stem)) return stem
    let index = 2
    while (rt.findBot(`${stem} ${index}`)) index += 1
    return `${stem} ${index}`
  }

  // `pickModel` leaves the model to the user: the chat opens on a model card. So does a
  // Bot made when no model is served.
  async function createBot({ name: botName, role = '', instructions = '', color, brief = '', createdBy, main = false, avatar, model, effort, workDir, pickModel = false, systemPrompt, fields, remote, external, ownerId: explicitOwnerId, hidden, ephemeral }) {
    const cleanName = cut(String(botName ?? '').trim(), 40).text
    // A friend's Bot (remote-chat.js) keeps its own name: it is not a team member, so
    // team names never clash with it and creating it starts no turn.
    const isRemote = typeof remote?.handle === 'string'
    if (!isRemote) {
      const problem = nameProblem(cleanName)
      if (problem !== undefined) throw new Error(problem)
      if (rt.findBot(cleanName)) throw new Error(`A Bot named ${cleanName} already exists`)
    } else if (cleanName === '') throw new Error('A friend\'s Bot needs a name')
    const cleanAvatarValue = cleanAvatar(avatar)
    // Validated before the Session exists: a record that cannot be run leaves nothing behind (#198).
    const externalRecord = cleanExternal(external)
    // The model is fixed at creation, so a later change of the DSH default leaves it alone.
    // A Bot made by another Bot (create_bot, a tree child) with no model named starts on its
    // maker's effective model and thinking level (#410; the level resolved against that
    // model, as applyModel does for the maker), set before its first request, so it never
    // tries an unconfigured profile default first. A friend's Bot is never a maker here.
    // A run Bot (#1582) is not a Bot's child either: `createdBy` on one names the caller whose
    // connector switches cap it, not a maker, so it starts on the profile default like the board,
    // the canvas and the API do. Its model must not change with whoever pressed start.
    const maker = !model && !pickModel && !isRemote && !ephemeral && createdBy ? rt.botOf(createdBy) : undefined
    // A brief is a parent's context (`create_bot`), so it becomes instructions only when
    // another Bot made this one. A line the user typed in the new-Bot card is their first
    // request: the client sends it as a turn, and it is never saved as a standing rule (#645).
    const parentBrief = !isRemote && createdBy ? rt.botOf(createdBy) : undefined
    const inherited = maker && !maker.remote ? await rt.desiredModel(maker) : undefined
    const modelRef = model ? await rt.resolveModel(model) : pickModel ? undefined : inherited ?? await rt.defaultModel()
    const inheritedEffort = effort === undefined && inherited !== undefined ? maker.effort : undefined
    const effortId = modelRef === undefined ? undefined
      : effort !== undefined ? await rt.resolveEffort(modelRef, effort)
        : inheritedEffort !== undefined ? await rt.resolveEffort(modelRef, inheritedEffort).catch(() => undefined) : undefined
    const dir = workDir === undefined || workDir === null ? undefined : await rt.cleanWorkDir(workDir)
    // Every Bot binds to the team's one owner (#47), resolved before the Session exists
    // so a failure here leaves nothing to clean up.
    const ownerId = explicitOwnerId ?? rt.initialOwnerId()
    // A run Bot is hidden and marked before the first save. Only create() may set the
    // marker; a later fields.set cannot turn a team Bot into one (#1373).
    const runPlugin = ephemeral && typeof ephemeral === 'object' && typeof ephemeral.plugin === 'string'
      ? ephemeral.plugin.slice(0, 80) : ''
    const run = runPlugin !== '' ? { plugin: runPlugin } : undefined
    const id = await createSession(cleanName, { dir })
    try {
      state.bots[id] = {
        id,
        name: cleanName,
        role: cut(String(role).trim(), 24).text,
        // A color is only stored when the user picks one; otherwise the id picks it.
        ...(isColor(currentColor(color)) ? { color: currentColor(color) } : {}),
        ...(cleanAvatarValue ? { avatar: cleanAvatarValue } : {}),
        ...(modelRef ? { model: modelRef } : {}),
        ...(effortId ? { effort: effortId } : {}),
        ...(dir ? { workDir: dir } : {}),
        instructions: [String(instructions).trim(), parentBrief && brief ? `Why you exist: ${String(brief).trim()}` : ''].filter(Boolean).join('\n\n'),
        createdAt: Date.now(),
        createdBy: createdBy ?? null,
        ownerId,
        capabilities: [],
        // FlyBot (hooks.js): extra system prompt text and per-plugin custom fields.
        ...(typeof systemPrompt === 'string' && systemPrompt.trim() ? { systemPrompt: systemPrompt.trim() } : {}),
        ...(fields && typeof fields === 'object' && Object.keys(fields).length > 0 ? { fields: JSON.parse(JSON.stringify(fields)) } : {}),
        ...(isRemote ? { remote: JSON.parse(JSON.stringify(remote)) } : {}),
        ...(externalRecord ? { external: externalRecord } : {}),
        ...(hidden === true || run ? { hidden: true } : {}),
        ...(run ? { ephemeral: run } : {}),
      }
      if (main && !run) {
        state.mainBotIds.push(id)
        rt.syncDesignatedChief()
        // A second owner's first Main Bot becomes their designated Chief (#50).
        const owner = state.members[ownerId]
        if (owner && (owner.designatedChiefId === undefined || owner.designatedChiefId === null)) {
          owner.designatedChiefId = id
        }
      }
      const bot = state.bots[id]
      if (isRemote) {
        await rt.save()
        void rt.waitForModel(bot).then(() => rt.applyModel(bot)).catch(error => rt.warn('ds-bot: route for %s not applied: %s', cleanName, error))
        return bot
      }
      await rt.save()
      // Nothing is sent on creation (#645): the user's first message is what starts a turn.
      if (modelRef !== undefined) {
        void rt.waitForModel(bot)
          .then(() => rt.applyModel(bot).catch(error => rt.warn('ds-bot: model for %s not applied: %s', cleanName, error)))
      }
      return bot
    } catch (error) {
      // The Bot's Session was already made: archive it instead of leaving an orphan.
      delete state.bots[id]
      state.mainBotIds = state.mainBotIds.filter(other => other !== id)
      rt.chatOwners.delete(id)
      // The Main role was rolled back too, so the owner's designated Chief follows.
      rt.syncDesignatedChief()
      // A save that another change queued meanwhile still carries this Bot; a later
      // one writes the team without it.
      void rt.save().catch(() => {})
      await ctx.workspaceRegistry.archiveSession(id)
        .catch(archiveError => rt.warn('ds-bot: archiving the Session for %s failed: %s', cleanName, archiveError))
      throw error
    }
  }

  async function duplicateBot(id) {
    const bot = rt.botOf(id)
    if (bot === undefined) throw new Error('Unknown Bot')
    const served = (await rt.catalog()).some(entry => entry.ref === bot.model)
    // Through rt.createBot so a copy is placed by plugins like any new Bot.
    return rt.createBot({
      name: freshName(`${bot.name} copy`),
      role: bot.role,
      instructions: bot.instructions,
      color: bot.color,
      avatar: bot.avatar,
      model: served ? bot.model : undefined,
      effort: served ? bot.effort : undefined,
      // A folder that went away since leaves the copy in the team workspace.
      workDir: bot.workDir !== undefined && await rt.isFolder(bot.workDir) ? bot.workDir : undefined,
    })
  }

  async function updateBot(id, patch) {
    const bot = rt.botOf(id)
    if (bot === undefined) throw new Error('Unknown Bot')
    // Checked first, so a folder that does not pass leaves the rest unchanged too.
    const moving = patch.workDir !== undefined
    const workDir = moving ? await rt.cleanWorkDir(patch.workDir ?? '') : undefined
    if (patch.name !== undefined) {
      const next = cut(String(patch.name).trim(), 40).text
      const clash = rt.findBot(next)
      if (next === '' || (clash && clash.id !== id)) throw new Error(`Name ${next} is not available`)
      // A name saved before the rule stays usable until it changes.
      const problem = next === bot.name ? undefined : nameProblem(next)
      if (problem !== undefined) throw new Error(problem)
      bot.name = next
      const agent = await rt.resolveAgent(rt.chatOf(id))
      await ctx.sessionTitle.rename(agent.session, next)
      await followMemberNames(Object.values(state.rooms).filter(room => room.members.includes(id)))
    }
    if (patch.role !== undefined) bot.role = cut(String(patch.role).trim(), 24).text
    if (patch.instructions !== undefined) bot.instructions = String(patch.instructions).trim()
    let modelChanged = false
    if (patch.color !== undefined) {
      if (patch.color === null) delete bot.color
      else if (isColor(currentColor(patch.color))) bot.color = currentColor(patch.color)
    }
    if (patch.avatar !== undefined) {
      const avatar = cleanAvatar(patch.avatar)
      if (avatar) bot.avatar = avatar
      else delete bot.avatar
    }
    // A friend's Bot always runs on its relay route; its model is not the user's to change.
    if (bot.remote !== undefined) { delete patch.model; delete patch.effort }
    if (patch.model !== undefined) {
      if (patch.model === null || patch.model === '') delete bot.model
      else bot.model = await rt.resolveModel(patch.model)
      modelChanged = true
    }
    if (patch.effort !== undefined) {
      if (patch.effort === null || patch.effort === '') delete bot.effort
      else {
        const ref = bot.model ?? bot.appliedModel
        if (ref === undefined) throw new Error('Pick a model before choosing a thinking level')
        bot.effort = await rt.resolveEffort(ref, patch.effort)
      }
      modelChanged = true
    }
    if (patch.permission !== undefined) await rt.setPermission(bot, patch.permission)
    const moved = moving && workDir !== bot.workDir
    if (moving) {
      if (workDir === undefined) delete bot.workDir
      else bot.workDir = workDir
    }
    await rt.save()
    if (modelChanged) await rt.applyModel(bot, { force: true })
    if (moved) void rt.followFolder(bot.id)
    return bot
  }

  async function setFlags(id, { pinned, hidden }) {
    const entry = rt.botOf(id) ?? rt.roomOf(id) ?? ownEntry(state.agents, id)
    if (entry === undefined) throw new Error('Unknown conversation')
    if (typeof pinned === 'boolean') entry.pinned = pinned
    if (typeof hidden === 'boolean') entry.hidden = hidden
    await rt.save()
    return entry
  }

  // ---------------------------------------------------------------------------
  // Group chat settings. The user and every Main Bot may change any group; a group's
  // admin may change its own group but not delete it. Only a member can be admin.

  const roomBusy = id => [...rt.roomProgress.values()].some(round => round.roomId === id)
  const autoRoomName = (members, room) => {
    const humans = (room?.participants ?? []).filter(p => p.kind === 'human' && p.leftSeq === undefined)
      .map(p => p.displayName || p.id)
    const people = humans.length > 0 ? humans : ['You']
    const remotes = (room?.participants ?? []).filter(p => p.remote && p.leftSeq === undefined)
      .map(p => p.displayName || p.handle)
    return [...people, ...members.map(id => rt.botOf(id)?.name).filter(Boolean), ...remotes].join(', ')
  }
  const cleanNotice = text => cut(String(text ?? '').trim(), ROOM_NOTICE_MAX).text

  function cleanRoomName(text, selfId) {
    const next = cut(unquote(text).replace(/\s+/g, ' '), ROOM_NAME_MAX).text
    if (next !== '' && rt.findRooms(next).some(room => room.id !== selfId)) throw new Error(`Another group chat is already called "${next}"`)
    return next
  }

  async function retitleRoom(room) {
    try {
      const agent = await rt.resolveAgent(room.id)
      await ctx.sessionTitle.rename(agent.session, room.name)
    } catch (error) {
      rt.warn('ds-bot: group title for %s not updated: %s', room.name, error)
    }
  }

  // Groups without a chosen name are named after their members, so they follow renames.
  async function followMemberNames(rooms = Object.values(state.rooms)) {
    for (const room of rooms) {
      if (room.named) continue
      const next = autoRoomName(room.members, room)
      if (next === room.name) continue
      room.name = next
      await retitleRoom(room)
      // The guests already seated hold the name they were given at join, and nothing else tells them: the
      // same one `join` as an explicit rename (#1949). The guard above is the "the name really moved"
      // condition, so a rename that leaves the computed name alone still sends nothing.
      void rt.notifyRoomShare?.(room, { op: 'join' })
    }
  }

  function checkMembers(members, { floor = true } = {}) {
    if (floor && members.length < 2) throw new Error('A group chat needs at least two Bots')
    if (members.length > ROOM_MAX_MEMBERS) throw new Error(`A group chat holds at most ${ROOM_MAX_MEMBERS} Bots`)
  }

  async function createRoom({ members: memberIds = [], name: roomName, notice, mode, admin, createdBy, participants, actor } = {}) {
    const fromParticipants = Array.isArray(participants)
      ? participants.filter(p => p?.kind === 'bot' && !p.remote && !p.handle).map(p => p.id)
      : []
    const remotesFromMembers = [...memberIds, ...fromParticipants]
      .map(id => rt.botOf(id))
      .filter(bot => bot?.remote?.handle)
      .map(bot => ({ kind: 'bot', remote: true, handle: bot.remote.handle }))
    const remotes = [
      ...(Array.isArray(participants) ? participants.filter(p => p?.kind === 'bot' && (p.remote || p.handle)) : []),
      ...remotesFromMembers,
    ].filter((p, i, all) => all.findIndex(other => (other.handle || other.id) === (p.handle || p.id)) === i)
    const members = [...new Set([...memberIds, ...fromParticipants])].filter(id => {
      const bot = rt.botOf(id)
      return bot && !bot.remote
    })
    if (members.length >= 2) checkMembers(members)
    else if (members.length + remotes.length < 2 || members.length === 0) checkMembers(members)
    const custom = cleanRoomName(roomName ?? '')
    // A Main Bot leads the groups it makes; a group the user makes is led by a Main
    // Bot member when it has one.
    const adminId = admin !== undefined ? admin : (members.includes(createdBy) ? createdBy : members.find(rt.isMain) ?? null)
    if (adminId !== null && !members.includes(adminId)) throw new Error('The admin must be a member of the group')
    if (mode !== undefined && !ROOM_MODES.includes(mode)) throw new Error(`Reply mode must be one of ${ROOM_MODES.join(', ')}`)
    const title = custom || autoRoomName(members)
    // The group's own Session only relays, so it stays in the team workspace; the
    // group's folder is for its members' Sessions.
    const id = await createSession(title)
    try {
      state.rooms[id] = {
        id,
        name: title,
        ...(custom ? { named: true } : {}),
        members,
        admin: adminId,
        mode: mode ?? 'admin',
        notice: cleanNotice(notice),
        createdAt: Date.now(),
        createdBy: createdBy ?? null,
      }
      const drafts = Array.isArray(participants) && participants.length > 0
        ? participants
        : remotes.length > 0
          ? [...members.map(botId => ({ kind: 'bot', id: botId, role: botId === adminId ? 'admin' : 'member' })), ...remotes]
          : undefined
      if (drafts) {
        rt.applyParticipants(state.rooms[id], drafts, actor)
        if (!custom) {
          state.rooms[id].name = autoRoomName(state.rooms[id].members, state.rooms[id])
        }
      }
      await rt.save()
      if (remotes.length > 0) void rt.notifyRoomShare?.(state.rooms[id], { op: 'join' })
      return state.rooms[id]
    } catch (error) {
      // The group's Session was already made: archive it instead of leaving an orphan.
      delete state.rooms[id]
      void rt.save().catch(() => {})
      await ctx.workspaceRegistry.archiveSession(id)
        .catch(archiveError => rt.warn('ds-bot: archiving the Session for %s failed: %s', title, archiveError))
      throw error
    }
  }

  // `actorId` is the Bot asking, or undefined for the user. `actor` is the signed-in
  // human when member-auth is on. Returns what changed, in words.
  async function updateRoom(id, patch, actorId, actor) {
    const room = rt.roomOf(id)
    if (room === undefined) throw new Error('Unknown group chat')
    const humanAdmin = actor && rt.canManageParticipants?.(room, actor)
    const byMain = actorId === undefined || rt.isMain(actorId)
    const byAdmin = !byMain && rt.isAdminOf(room, actorId)
    if (!byMain && !byAdmin && !humanAdmin) throw new Error(`Only the user, a Main Bot, or the admin of "${room.name}" can change it`)
    // A face-to-face room's admin is its lead (#476): each person brings their own Bots, and the room creator picks the lead.
    if (byAdmin && room.origin === 'face-to-face' && (patch.members !== undefined || patch.add !== undefined || patch.remove !== undefined || patch.admin !== undefined)) {
      throw new Error(`In "${room.name}", each person brings their own Bots and the room creator picks the lead`)
    }
    let members = Array.isArray(patch.members) ? [...new Set(patch.members)] : [...room.members]
    for (const member of patch.add ?? []) if (!members.includes(member)) members.push(member)
    members = members.filter(member => !(patch.remove ?? []).includes(member) && rt.botOf(member))
    // #1764: only a patch that changes membership is judged by the two-Bot floor. A face-to-face
    // or inbound-share room's seats are synced, not patched, so its local list is not its membership.
    const changesMembers = patch.members !== undefined || patch.add !== undefined || patch.remove !== undefined
    if (changesMembers) {
      const syncedSeats = room.origin === 'face-to-face' || room.origin === 'inbound-share'
      checkMembers(members, { floor: !syncedSeats })
    }
    let admin = room.admin ?? null
    if (patch.admin !== undefined) {
      admin = patch.admin || null
      if (admin === null && byAdmin) throw new Error('Hand the admin role to another member instead of leaving the group without one')
      if (admin !== null && !members.includes(admin)) throw new Error(`${rt.botOf(admin)?.name ?? 'That Bot'} must be a member to be the admin`)
    }
    if (admin !== null && !members.includes(admin)) {
      if (byAdmin && admin === actorId) throw new Error('Hand the admin role to another member before leaving the group')
      admin = null
    }
    if (patch.mode !== undefined && !ROOM_MODES.includes(patch.mode)) throw new Error(`Reply mode must be one of ${ROOM_MODES.join(', ')}`)
    // The one Bot that divides this room's board (#1182). Empty clears it, and the admin plans.
    let taskLead = room.taskLead ?? null
    if (patch.taskLead !== undefined) {
      if (room.origin === 'face-to-face') throw new Error('A face-to-face room has no group task board')
      taskLead = patch.taskLead || null
      if (taskLead !== null && !members.includes(taskLead)) throw new Error(`${rt.botOf(taskLead)?.name ?? 'That Bot'} must be a member to lead the board`)
    }
    if (taskLead !== null && !members.includes(taskLead)) taskLead = null
    const name = patch.name === undefined ? undefined : cleanRoomName(patch.name, room.id)
    const notice = patch.notice === undefined ? undefined : cleanNotice(patch.notice)
    const moving = patch.workDir !== undefined
    if (moving && byAdmin) throw new Error(`Only the user or a Main Bot can set the folder of "${room.name}"`)
    const workDir = moving ? await rt.cleanWorkDir(patch.workDir ?? '') : undefined

    const changes = []
    // What the room itself says about this patch. A seat change already writes its own joined/left line,
    // and a working folder is not something the others need a line about, so only the room's own settings
    // are collected here: one patch draws at most one event.
    const settings = []
    const names = ids => ids.map(member => rt.botOf(member)?.name).filter(Boolean).join(', ')
    const added = members.filter(member => !room.members.includes(member))
    const removed = room.members.filter(member => !members.includes(member))
    if (added.length > 0) changes.push(`added ${names(added)}`)
    if (removed.length > 0) changes.push(`removed ${names(removed)}`)
    if (Array.isArray(room.participants)) {
      for (const botId of added) await rt.addRoomParticipant(room.id, { kind: 'bot', id: botId }, actor)
      for (const botId of removed) await rt.removeRoomParticipant(room.id, { kind: 'bot', id: botId }, actor)
    } else {
      // A member who leaves and comes back starts from a fresh look at the log.
      for (const member of removed) {
        if (room.seen) delete room.seen[member]
        rt.dropGroupSession(room, member)
      }
      room.members = members
    }
    if (admin !== (room.admin ?? null)) {
      changes.push(admin ? `made ${rt.botOf(admin).name} the admin` : 'removed the admin')
      // A seat change that empties the admin says "removed the admin" in `changes` alone: the room's line
      // about it would repeat the joined/left line the seat change already writes.
      if (patch.admin !== undefined) settings.push(admin ? `made ${rt.botOf(admin)?.name ?? 'someone'} the admin` : 'removed the admin')
    }
    room.admin = admin
    if (taskLead !== (room.taskLead ?? null)) {
      if (taskLead) room.taskLead = taskLead
      else delete room.taskLead
      const lead = taskLead ? rt.botOf(taskLead).name : ''
      changes.push(taskLead ? `made ${lead} the task lead` : 'the admin leads the board again')
      if (patch.taskLead !== undefined) settings.push(taskLead ? `made ${lead} the task lead` : 'let the admin lead the board again')
    }
    if (patch.mode !== undefined && patch.mode !== room.mode) {
      room.mode = patch.mode
      changes.push(patch.mode === 'admin' ? 'plain messages now go to the admin first' : 'every member now replies in turn')
      settings.push(patch.mode === 'admin' ? 'switched plain messages to the admin first' : 'switched the room to every member replying in turn')
    }
    const noticeChanged = notice !== undefined && notice !== (room.notice ?? '')
    if (noticeChanged) {
      room.notice = notice
      changes.push(notice ? 'updated the notice' : 'cleared the notice')
      settings.push(notice ? 'updated the group notice' : 'cleared the notice')
    }
    // Members' group conversations move on to the folder at their next turn there.
    if (moving && workDir !== room.workDir) {
      if (workDir === undefined) delete room.workDir
      else room.workDir = workDir
      changes.push(workDir ? `every member now works in ${workDir} here` : 'every member works in its own folder again')
    }
    const before = room.name
    if (name !== undefined) {
      if (name !== '') {
        room.named = true
        room.name = name
      } else {
        delete room.named
      }
    }
    if (Array.isArray(patch.addParticipants)) {
      for (const draft of patch.addParticipants) await rt.addRoomParticipant(room.id, draft, actor)
    }
    if (Array.isArray(patch.removeParticipants)) {
      for (const ref of patch.removeParticipants) await rt.removeRoomParticipant(room.id, ref, actor)
    }
    if (!room.named) room.name = autoRoomName(room.members, room)
    const nameChanged = room.name !== before
    if (nameChanged) {
      changes.push(`renamed it "${room.name}"`)
      // An unnamed room's title follows its members; that move is not a rename someone asked for, so only
      // an explicit name in the patch draws a line.
      if (patch.name !== undefined) settings.push(`renamed the room to “${room.name}”`)
      await retitleRoom(room)
    }
    await rt.save()
    // A rename and a notice edit are membership pushes like a seat change: the guests already in the room
    // hold the old name and the old notice and nothing else tells them. One `join` carries both fields
    // (#1949), so a rename is not waiting on the next line and a save that changes both sends one envelope,
    // not two. Sent after the save, like the join at creation; a save that changes neither sends nothing.
    if (nameChanged || noticeChanged) void rt.notifyRoomShare?.(room, { op: 'join' })
    // The same settings change is a line in the room itself: the envelope above tells the guests, this
    // tells everyone already holding the room that something moved. It is the quiet room sender, not a
    // Bot, so it draws as an event and opens no turn.
    if (settings.length > 0) showSettings(room, settings, actor, actorId)
    return { room, changes }
  }

  function showSettings(room, settings, actor, actorId) {
    const who = actor?.displayName ?? rt.botOf(actorId)?.name ?? 'Someone'
    const said = settings.length === 1 ? settings[0] : `${settings.slice(0, -1).join(', ')} and ${settings.at(-1)}`
    try {
      void Promise.resolve(rt.postToRoom?.(room, { id: 'face-notice', name: who }, `${who} ${said}`, { quiet: true, notice: true }))
        .catch(error => rt.warn('ds-bot: the settings line for %s was not shown: %s', room.name, error))
    } catch (error) {
      rt.warn('ds-bot: the settings line for %s was not shown: %s', room.name, error)
    }
  }

  async function deleteRoom(id) {
    const room = rt.roomOf(id)
    if (room === undefined) throw new Error('Unknown group chat')
    // #884: a room's invite links and the seats they admitted end with it, at Bot Social too.
    await Promise.resolve(rt.dropRoomInvites?.(room)).catch(error => rt.warn('ds-bot: links of %s not withdrawn: %s', room.name, error))
    for (const botId of Object.keys(room.sessions ?? {})) rt.dropGroupSession(room, botId)
    delete state.rooms[id]
    delete state.questions[id]
    rt.roomInbox.delete(id)
    const failed = await saveForDelete()
    // Armed scheduled tasks refuse a plain archive and would keep delivering into
    // the deleted group; the session-stop that stopActivity runs removes them.
    await ctx.workspaceRegistry.archiveSession(id, { stopActivity: true })
      .catch(error => rt.warn('ds-bot: group chat %s not archived: %s', room.name, error))
    if (failed !== undefined) throw failed
  }

  // The first Main Bot is the sidebar tile. `replace` gives a Main Bot's place to
  // another Bot in one step, so the team never has none; `primary` moves a Bot to the
  // front and keeps the others.
  async function setMain(id, main, { primary = false, replace } = {}) {
    const bot = rt.botOf(id)
    if (bot === undefined) throw new Error('Unknown Bot')
    const others = state.mainBotIds.filter(other => other !== id)
    let next
    if (!main) {
      if (!rt.isMain(id)) return
      if (others.length === 0) throw new Error('The team needs at least one Main Bot')
      next = others
    } else if (replace !== undefined && replace !== id) {
      const at = others.indexOf(replace)
      if (at === -1) throw new Error('Only a Main Bot can be replaced')
      // The Main list is deployment-wide, so a swap is only within one owner: taking another
      // member's Main Bot's place demotes it for them (#613). authz.js refuses the endpoint for
      // the same reason; this keeps the state invariant for every caller.
      if ((rt.botOf(replace)?.ownerId ?? null) !== (bot.ownerId ?? null)) throw new Error('Only a Bot of the same owner can take a Main Bot’s place')
      next = others.with(at, id)
    } else if (primary) {
      next = [id, ...others]
    } else {
      next = rt.isMain(id) ? state.mainBotIds : [...others, id]
    }
    // The sidebar shows every Main Bot, so a hidden Bot would vanish again once demoted.
    if (main) delete bot.hidden
    state.mainBotIds = next
    rt.syncDesignatedChief()
    await rt.save()
  }

  // #638: retire a Bot instead of deleting it. The tree already reads fields['flybot-tree'].retired:
  // adoption skips the record and it no longer counts against maxChildren, while its chat, its parts
  // and its memory stay where they are. `hidden` keeps it out of the default Bot list the way the
  // tree's own archive does (#452); Search still finds it. Deletion stays the owner's click.
  async function archiveBot(id, { reason = '' } = {}) {
    const bot = rt.botOf(id)
    if (bot === undefined) throw new Error('Unknown Bot')
    if (rt.isMain(id)) throw new Error('A Main Bot cannot be archived; give up its Main Bot role first')
    const why = String(reason ?? '').trim().slice(0, 200)
    if (why !== '') bot.archivedReason = why
    if (typeof rt.setBotField === 'function') rt.setBotField(id, 'flybot-tree', 'retired', true)
    else {
      bot.fields ??= {}
      bot.fields['flybot-tree'] ??= {}
      bot.fields['flybot-tree'].retired = true
    }
    bot.hidden = true
    // A retired Bot means what a deleted one does to the board (#1709): the cards it holds fail
    // instead of waiting for a Bot that will not run again. `hooks` does this for deletion.
    await rt.taskBotDeleted?.(id, 'the responsible Bot was retired')
    // Retiring disarms its own chat Session (#1709): `schedules` installs after `roster`, and a
    // host without the module (a test that mounts only the roster) simply has nothing to pause.
    const freed = typeof rt.pauseBotSchedules === 'function' ? await rt.pauseBotSchedules(id) : undefined
    // #1801: retirement ends outside reach the way deletion does. A grant left behind still lets
    // the friend's Bot wake this one and spend the owner's budget, unseen; reach() reads grants,
    // so clearing them is the refusal. `reach` installs after `roster`, hence the optional call.
    if (state.grants?.[id] !== undefined) {
      delete state.grants[id]
      await rt.reachChanged?.(id)
    }
    await rt.save()
    return { bot, freed }
  }

  async function deleteBot(id) {
    const bot = rt.botOf(id)
    if (bot === undefined) throw new Error('Unknown Bot')
    if (rt.isMain(id)) throw new Error('A Main Bot cannot be deleted; remove its Main Bot role first')
    // Before the Bot and its group Sessions leave the state, which the archive reads.
    const archived = rt.archiveBotMemory(id)
    const current = rt.chatOf(id)
    // Questions and exchange turns are kept per Session, so every part of the chat is cleared.
    const parts = new Set([id, current, ...(bot.segments ?? []).map(segment => segment.sessionId)])
    // #1453: keep who owned every Session this deletion empties — the own chat and its parts, the
    // group Session and its parts — before the Bot and its seats leave the state, so an in-flight
    // call fails closed instead of keeping the owner's connectors. The record only grows: nothing
    // here prunes an older entry.
    state.retiredSessions ??= {}
    for (const part of parts) state.retiredSessions[part] = id
    for (const room of Object.values(state.rooms)) {
      if (!room.members.includes(id)) continue
      const sessionId = room.sessions?.[id]
      if (sessionId !== undefined) state.retiredSessions[sessionId] = id
      for (const segment of room.segments?.[id] ?? []) state.retiredSessions[segment.sessionId] = id
    }
    delete state.bots[id]
    delete state.remoteContacts?.[id]
    for (const part of parts) {
      delete state.questions[part]
      delete state.exchangeTurns[part]
      delete state.remoteTypedTurns?.[part]
    }
    // A card it asked in a group (#550) has nobody left to answer.
    for (const [key, question] of Object.entries(state.questions)) {
      if (question?.botId === id) delete state.questions[key]
    }
    const touched = []
    for (const room of Object.values(state.rooms)) {
      if (!room.members.includes(id)) continue
      room.members = room.members.filter(member => member !== id)
      if (room.admin === id) room.admin = null
      if (room.taskLead === id) delete room.taskLead
      rt.dropGroupSession(room, id)
      touched.push(room)
    }
    await followMemberNames(touched)
    await rt.forgetBotSecrets(id)
    await archived
    rt.syncDesignatedChief()
    const failed = await saveForDelete()
    // Same as deleteRoom: stopActivity removes the Session's armed scheduled tasks.
    // Past parts are archived too: a part move can leave tasks on the old Session,
    // which otherwise stays armed and invisible. Already-archived ids are a no-op.
    for (const part of parts) {
      await ctx.workspaceRegistry.archiveSession(part, { stopActivity: true })
        .catch(error => rt.warn('ds-bot: Bot %s not archived: %s', bot.name, error))
    }
    if (failed !== undefined) throw failed
  }

  // A deletion whose save fails stays in memory, and the next save writes it, so its
  // Sessions are stopped anyway: left armed, their scheduled tasks would keep running
  // with nothing in the team to show or delete them. Only a host that lost the team
  // to another dsh keeps them, since the other host's copy still has them.
  async function saveForDelete() {
    try {
      await rt.save()
      return undefined
    } catch (error) {
      if (error?.code === 'ELOCKLOST' || rt.readOnly() !== undefined) throw error
      return error
    }
  }

  async function bootstrap() {
    await rt.load()
    void rt.syncModels()
    if (state.mainBotIds.some(id => rt.botOf(id))) return
    // Only the team's first Main Bot is stored as the DeepSeek whale; other Bots get a
    // look from their id, and a Bot made Main Bot later keeps its own.
    // Through rt.createBot (the plugin wrapper), not the module-local one, so plugins hear
    // `bot.created` for the first Main Bot exactly as for any other new Bot (the tree adopts it).
    bootstrapping ??= rt.createBot({ name: defaults.mainName, role: defaults.mainRole, main: true, color: 'deepseek', avatar: { shape: 'whale' }, pickModel: true })
      .finally(() => { bootstrapping = null })
    await bootstrapping
  }

  Object.assign(rt, {
    ensureWorkspace, createSession, createBot, duplicateBot, updateBot, setFlags,
    roomBusy, autoRoomName, retitleRoom, createRoom, updateRoom, deleteRoom,
    setMain, archiveBot, deleteBot, bootstrap,
  })
}
