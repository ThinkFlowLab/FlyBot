import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { nativeAgents } from '../features/agents/native.js'

test('a conversation rename is retried on its original native Session and newer titles win', async () => {
  const db = new DatabaseSync(':memory:')
  db.exec("CREATE TABLE agent_conversations(id TEXT PRIMARY KEY, agent_id TEXT); INSERT INTO agent_conversations VALUES('c','a')")
  const renamed = []
  const logs = []
  let pauseTitle
  let owner = 'bot-a'
  let available = true
  const host = {
    log: message => logs.push(message),
    async runtime() {
      if (!available) throw new Error('runtime unavailable')
      return {
        rt: {
          botOf: id => ({ id, sessionId: 'session-a' }),
          chatOwners: new Map([['session-a', owner]]),
          resolveAgent: async id => ({ session: { id } }),
        },
        ctx: { sessionTitle: { async rename(session, title) {
          if (title === 'Earlier') await pauseTitle()
          renamed.push([session.id, title])
        } } },
      }
    },
  }
  const row = { id: 'a' }
  const key = 'agent:a:c'
  const adapter = nativeAgents({ host, db })
  db.exec(`INSERT INTO native_agent_objects VALUES('a','bot-a','name'),('b','bot-b','other');
    INSERT INTO native_agent_sessions VALUES('agent:a:c','a','session-a'),('agent:b:c','b','session-b')`)

  const pending = () => db.prepare('SELECT title FROM native_agent_pending_titles WHERE conversation_id=?').get('c')?.title
  adapter.markSessionTitle('c', 'Retained')
  available = false
  await adapter.renameSession(row, key)
  assert.equal(pending(), 'Retained')
  assert.equal(logs.length, 1)
  available = true
  owner = 'bot-b'
  await adapter.renameSession(row, key)
  assert.equal(pending(), 'Retained')
  assert.deepEqual(renamed, [])
  await adapter.renameSession({ id: 'b' }, 'agent:b:c')
  assert.equal(pending(), 'Retained')
  assert.deepEqual(renamed, [])

  owner = 'bot-a'
  const afterRestart = nativeAgents({ host, db })
  await afterRestart.renameSession(row, key)
  assert.deepEqual(renamed, [['session-a', 'Retained']])
  assert.equal(pending(), undefined)
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  pauseTitle = () => { entered.resolve(); return release.promise }
  afterRestart.markSessionTitle('c', 'Earlier')
  const first = afterRestart.renameSession(row, key)
  await entered.promise
  afterRestart.markSessionTitle('c', 'Latest')
  const second = afterRestart.renameSession(row, key)
  release.resolve()
  await Promise.all([first, second])
  assert.deepEqual(renamed.slice(-2), [['session-a', 'Earlier'], ['session-a', 'Latest']])
  assert.equal(pending(), undefined)
  db.close()
})
