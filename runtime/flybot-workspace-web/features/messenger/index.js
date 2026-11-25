// Stream C: member messenger — DMs, groups, unread, reactions, pins, edits, @mentions and group
// agents (legacy social.py), shared through Bot Social. Group agents answer from this user's own
// DS-Bot (lib/c/agent-replies.js); nothing is executed by the platform or by another user's DS-Bot.
import { sharedBotSocial, seg, qs } from '../../lib/c/bot-social.js'
import { createAgentReplier, defaultStateFile } from '../../lib/c/agent-replies.js'
import { groupMemorySources, messengerV1, shareGroupMemory } from '../../lib/c/legacy-v1.js'

export default function messenger(host) {
  const bs = () => sharedBotSocial(host)
  const conv = (p) => `/v1/ot/conversations/${seg(p?.conversation_id, 'conversation_id')}`
  const msg = (p) => `/v1/ot/messages/${seg(p?.message_id, 'message_id')}`
  let replier
  const agentReplier = () => (replier ??= createAgentReplier({ bs: bs(), host, stateFile: defaultStateFile(host), log: host.log ?? (() => {}) }))
  const automaticReplies = typeof host.runtime === 'function' && process.env.FLYBOT_WORKSPACE_SOCIAL_AGENTS !== '0'
  // Native users can create a shared group before opening the FlyBot page.
  if (host.currentRuntime?.()) bs()
  else if (typeof host.runtime === 'function') void host.runtime().then(() => bs(), () => {})
  if (automaticReplies) agentReplier().start()
  const wakeReplies = () => {
    if (automaticReplies) agentReplier().wake()
  }
  return {
    pages: ['messenger'],
    endpoints: {
      v1: messengerV1(host, wakeReplies),
      shareGroupMemory: async (payload, call) => {
        if (!call?.internal) throw Object.assign(new Error('Internal endpoint'),{code:'messenger/not-found'})
        return shareGroupMemory(host,payload)
      },
      captureSources: async (payload, call) => {
        if (!call?.internal) throw Object.assign(new Error('Internal endpoint'),{code:'messenger/not-found'})
        return groupMemorySources(host,payload)
      },
      list: async () => {
        const data = await bs().get('/v1/ot/conversations')
        return { ...data, conversations: (data.conversations ?? []).map((c) => ({ ...c, first_unread_seq: c.unread > 0 ? c.read_seq + 1 : null })) }
      },
      openDm: async (p) => bs().post('/v1/ot/conversations', { kind: 'dm', peer: p?.handle }),
      createGroup: async (p) => bs().post('/v1/ot/conversations', { kind: 'group', title: p?.title, team_id: p?.team_id || undefined, members: p?.members ?? [] }),
      get: async (p) => bs().get(conv(p)),
      update: async (p) => bs().patch(conv(p), { title: p?.title, pinned: p?.pinned, muted: p?.muted }),
      addMember: async (p) => bs().post(`${conv(p)}/members`, { handle: p?.handle }),
      removeMember: async (p) => bs().del(`${conv(p)}/members/${seg(p?.handle, 'handle')}`),
      messages: async (p) => {
        const page = await bs().get(`${conv(p)}/messages` + qs({ before: p?.before, after: p?.after, limit: p?.limit }))
        // #358: the first message after the viewer's read cursor is the "new messages" divider.
        return { ...page, first_unread_seq: page.read_seq < page.last_seq ? page.read_seq + 1 : null }
      },
      send: async (p) => {
        const file = p?.attachment
        const attachment = file === undefined ? undefined : {title:file?.title,mime:file?.mime,data:file?.data}
        return bs().post(`${conv(p)}/messages`, {body:p?.body,voice:p?.voice,attachment,workspace:p?.workspace_id,
          mentions:p?.mentions,agent_mentions:p?.agent_mentions,reply_to:p?.reply_to,client_key:p?.client_key})
      },
      read: async (p) => bs().post(`${conv(p)}/read`, p?.seq === undefined ? {} : { seq: p.seq }),
      edit: async (p) => bs().patch(msg(p), { body: p?.body }),
      retract: async (p) => bs().del(msg(p)),
      react: async (p) => bs().post(`${msg(p)}/reactions`, { emoji: p?.emoji, on: p?.on !== false }),
      pin: async (p) => bs().post(`${msg(p)}/pin`, { on: p?.on !== false }),
      setAgent: async (p) => bs().put(`${conv(p)}/agents/${seg(p?.agent_ref, 'agent_ref')}`, { name: p?.name, auto_reply: p?.auto_reply === true }),
      removeAgent: async (p) => bs().del(`${conv(p)}/agents/${seg(p?.agent_ref, 'agent_ref')}`),
      // An explicit wake can run an inbox pass before the next background poll.
      agentsTick: async () => agentReplier().once(),
    },
  }
}
