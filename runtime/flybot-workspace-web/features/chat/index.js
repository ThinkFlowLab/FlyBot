// Private chat with the personal agent, executed as native DS-Bot turns in the
// user's own DS-Bot (moved from conversations.py / personal.py / agent_memory.py).
// Private chat now delegates to the same mapped native Bot as its workspace agent.
// Former plugin:<id> Main-Bot parts and local rows are retained and adopted once.
import { openDatabase, fail } from '../../src/store.js'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('user','assistant')), text TEXT NOT NULL, created INTEGER NOT NULL, meta TEXT NOT NULL DEFAULT '{}');
CREATE INDEX IF NOT EXISTS messages_by_conversation ON messages(conversation_id, created, id);
CREATE TABLE IF NOT EXISTS chat_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`
const ID = /^[0-9a-f]{32}$/

function legacyConversations(db) {
  const messages = db.prepare('SELECT * FROM messages WHERE conversation_id=? ORDER BY created, rowid')
  return db.prepare('SELECT * FROM conversations ORDER BY created,id').all().map(conversation => ({
    ...conversation,
    messages: messages.all(conversation.id).map(message => ({...message, meta: JSON.parse(message.meta)})),
  }))
}

export default function chat(host) {
  let db
  const database = async () => {
    if (!db) { db = await openDatabase(host, 'chat.sqlite3'); db.exec(SCHEMA) }
    return db
  }
  const feature = {
    pages: ['chat'],
    endpoints: {
      async exportLegacy() {
        return {conversations: legacyConversations(await database())}
      },
    },
  }
  let linked
  const binding = async p => {
    const d = await database()
    const saved = d.prepare("SELECT value FROM chat_state WHERE key='native_personal_binding'").get()
    const existing = saved ? JSON.parse(saved.value) : await host.call('agents/personal-binding',{})
    const scope = p?.agent_id && p?.workspace_id ? {agent_id:p.agent_id,workspace_id:p.workspace_id} : existing
    if (!scope || !ID.test(scope.agent_id) || !ID.test(scope.workspace_id)) fail('chat/identity-required', 'Explicit personal agent and workspace mapping required')
    if (existing && (existing.agent_id !== scope.agent_id || existing.workspace_id !== scope.workspace_id)) fail('chat/identity-conflict', 'Personal agent mapping differs from its durable binding')
    if (!linked) {
      linked = (async () => {
        const conversations = legacyConversations(d)
        const result = await host.call('agents/adopt-personal-chat',{...scope,id:scope.agent_id,conversations})
        d.prepare("INSERT OR REPLACE INTO chat_state VALUES('native_personal_binding',?)").run(JSON.stringify(scope))
        return result
      })().catch(e => {linked=undefined;throw e})
    }
    return {...await linked,id:scope.agent_id}
  }
  for (const name of ['conversations','create','open','messages','send']) {
    feature.endpoints[name] = async (p = {}) => {
      const scope = await binding(p)
      const payload = {...p,...scope}
      if (name === 'conversations') return host.call('agents/conversations',payload)
      if (name === 'create') return (await host.call('agents/conversation-create',payload)).conversation
      if (name === 'open') return host.call('agents/openConversation',payload)
      if (name === 'messages') return host.call('agents/messages',payload)
      const out = await host.call('agents/send',{...payload,return_failed:true})
      return {user_message_id:out.message.id,message:out.message,reply:out.reply}
    }
  }
  return feature

}
