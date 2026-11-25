import { createHash } from 'node:crypto'
import { livePrivateChat } from '../../lib/native-chat.js'
import { sharedBotSocial } from '../../lib/c/bot-social.js'

const SETUP_TOOLS = new Set(['list_bots', 'create_bot', 'create_group'])

export function asksToSetUpTeam(text) {
  if (typeof text !== 'string') return false
  const prompt = text.normalize('NFKC').trim()
  return /^(?:(?:请|你|帮我|替我|给我|麻烦)\s*)*(?:新建|组建|创建|搭建|建立|建)[^，。！？\n]{0,24}(?:团队|小队|小组)(?!页面|网页|主页|网站|图标|文档|介绍|卡片)/u.test(prompt) ||
    /^(?:(?:please|can you|could you|help me)\s+)*(?:create|build|assemble|form|set up)\s+(?:[a-z-]+\s+){0,6}(?:team|squad)\b(?:\s*(?:[.!?,;:\n]|$)|\s+(?:to|for|of|with|named|called)\b)/i.test(prompt)
}

export function attachPersonalTeamCreation(rt, { host, binding, publishBot }) {
  if (rt.flybotWorkspaceTeam) return
  const active = new Map()
  const allowed = ({botId, workspaceId, agentId}) => {
    const personal = binding()
    const link = rt.botOf(botId)?.flybotWorkspace
    return rt.isMain(botId) && personal?.workspace_id === workspaceId &&
      personal.agent_id === agentId && link?.workspace_id === workspaceId && link.agent_id === agentId
  }
  const current = sessionId => {
    const turn = active.get(rt.chatOwners.get(sessionId))
    return turn && allowed(turn) && livePrivateChat(rt,turn.botId,turn.sessionId) === sessionId ? turn : null
  }
  const key = (requestId, ...parts) =>
    createHash('sha256').update(JSON.stringify([requestId, ...parts])).digest('hex')
  const chatUrl = (workspaceId, target) => '/chat#' + new URLSearchParams({workspace:workspaceId,...target})

  async function includeBots(members, workspaceId) {
    for (const bot of members) {
      const link = bot.flybotWorkspace
      if (rt.botOf(bot.id) !== bot || bot.private || bot.hidden ||
          (link?.agent_id && link.workspace_id !== workspaceId)) {
        throw new Error(`Bot "${bot.name}" is not available in this workspace.`)
      }
    }
    for (const bot of members) {
      if (bot.flybotWorkspace?.agent_id) continue
      await publishBot({workspace_id:workspaceId, name:bot.name, summary:bot.role, instructions:bot.instructions,
        idempotency_key:key('existing-native-bot',bot.id)}, link => {
        if (rt.botOf(bot.id) !== bot || bot.private || bot.hidden || bot.flybotWorkspace?.agent_id) {
          throw new Error(`Bot "${bot.name}" changed. Check the team before trying again.`)
        }
        bot.flybotWorkspace = {...bot.flybotWorkspace,...link}
        return bot
      })
    }
  }

  rt.flybotWorkspaceTeam = {
    async run({botId,sessionId,requestId,scope}, runTurn) {
      const turn = {...scope,botId,sessionId,requestId}
      if (!allowed(turn) || livePrivateChat(rt,botId,sessionId) !== sessionId) return runTurn()
      active.set(botId,turn)
      try { return await runTurn() }
      finally { if (active.get(botId) === turn) active.delete(botId) }
    },
    setupTools(sessionId) {
      return current(sessionId)?.setupPending ? SETUP_TOOLS : null
    },
    scope(sessionId) {
      const turn = current(sessionId)
      if (!turn) return null
      const {workspaceId,requestId} = turn
      return {
        setupPending:turn.setupPending === true,
        async createBot({name,role,instructions}, createNativeBot) {
          const agent = await publishBot({workspace_id:workspaceId, name, summary:role, instructions,
            idempotency_key:key(requestId,'bot',name.toLowerCase())}, createNativeBot)
          return {name:agent.name, url:chatUrl(workspaceId,{agent:agent.id})}
        },
        async createGroup({name,members,admin,notice,mode,section}) {
          if (!members.length || members.length > 10) throw new Error('Choose one to ten Bots by exact name.')
          if (admin || mode || section) throw new Error('Create the shared group with members and a name first. Set its leader, reply mode, or section in group settings.')
          const title = String(name ?? '').trim() || members.map(bot => bot.name).join(' · ').slice(0,80).toWellFormed()
          const announcement = typeof notice === 'string' ? notice.trim() : ''
          if (title.length > 80 || /[\u0000-\u001f\u007f]/.test(title) || announcement.length > 2000) {
            throw new Error('The group name must be at most 80 characters and the notice at most 2000.')
          }
          await includeBots(members,workspaceId)
          const botIds = members.map(bot => bot.id)
          const social = sharedBotSocial(host)
          const group = await social.createNativeGroup({workspace_id:workspaceId,title,bot_ids:botIds,
            request_key:key(requestId,'group',title,...botIds.slice().sort())})
          turn.setupPending = false
          let noticeSaved = true
          if (announcement) {
            const path = '/v1/ot/conversations/' + group.conversation_id + '/announcement'
            try {
              const current = (await social.get(path)).announcement
              if (current.revision === 0) await social.post(path,{revision:0,body:announcement})
              else noticeSaved = current.body === announcement
            } catch {
              noticeSaved = false
            }
          }
          return {title, noticeSaved, url:chatUrl(workspaceId,{social:group.conversation_id})}
        },
      }
    },
  }
}
