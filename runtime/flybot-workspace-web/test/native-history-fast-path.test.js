import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { importHistory } from '../features/agents/history.js'

test('opening or sending in a mapped conversation skips the native event scan', async () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec(`CREATE TABLE agent_messages (id TEXT PRIMARY KEY, conversation_id TEXT, created INTEGER, meta TEXT, status TEXT, role TEXT, text TEXT);
      CREATE TABLE native_agent_events (message_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, event_seq INTEGER, source TEXT NOT NULL);
      INSERT INTO agent_messages VALUES ('earlier','c',1,'{}','succeeded','assistant','Earlier answer'),
        ('in-flight','c',2,'{"nativePending":true}','running','assistant',''),
        ('stopped','c',3,'{}','cancelled','assistant','Partial answer'),
        ('failed','c',4,'{"clientKey":"web-attempt","error":"agents/failed"}','failed','assistant','');
      INSERT INTO native_agent_events VALUES ('earlier','s',5,'adopted');`)
    const rt = { eventsBackwards() { throw new Error('Mapped history must not be scanned') } }
    assert.deepEqual(await importHistory({ db, rt, conversationId: 'c', sessionId: 's' }), { imported: 0, matched: 0 })
  } finally {
    db.close()
  }
})

test('history adoption appends a same-second question before its answer', async t => {
  const db = new DatabaseSync(':memory:')
  t.after(() => db.close())
  db.exec(`CREATE TABLE agent_messages (id TEXT PRIMARY KEY, conversation_id TEXT, created INTEGER, meta TEXT, status TEXT,
      role TEXT, text TEXT);
    INSERT INTO agent_messages VALUES
      ('zzz','c',1,'{}','sent','user','Question'),
      ('aaa','c',1,'{}','succeeded','assistant','Answer');`)
  const events = []
  const session = {
    surface: {nodes: [{}]},
    get seq() { return events.length },
    eventAt(seq) { return events[seq] },
    append(type, data) {
      const event = {type, data, seq: events.length}
      events.push(event)
      return event
    },
  }
  let maintaining = false
  const agent = {
    session,
    async whenIdle() {},
    async runMaintenance(job) {
      maintaining = true
      try { return await job(new AbortController().signal) }
      finally { maintaining = false }
    },
  }
  const rt = {async *eventsBackwards() {}, resolveAgent: async () => agent}
  const ctx = {
    sessions: {flush: async () => {}},
    agents: {turnBoundaryOf() {
      assert.equal(maintaining, true)
      return {lastTurn: events.findLast(event => event.type === 'turn/end')?.data.turn ?? 0}
    }},
  }
  assert.deepEqual(await importHistory({db, rt, ctx, bot: {}, conversationId: 'c', sessionId: 's'}),
    {imported: 2, matched: 0})
  assert.deepEqual(events.filter(event => /^(user|assistant)\/message$/.test(event.type))
    .map(event => event.data.source.flybotWorkspaceMessageId), ['zzz', 'aaa'])
})

test('a composed reply with an owned native receipt never creates a synthetic turn', async t => {
  const db = new DatabaseSync(':memory:')
  t.after(() => db.close())
  db.exec(`CREATE TABLE agent_messages (id TEXT PRIMARY KEY, conversation_id TEXT, created INTEGER, meta TEXT, status TEXT,
    role TEXT, text TEXT);
    INSERT INTO agent_messages VALUES
      ('combined','c',1,'{"engine":"ds-bot","session_id":"s","turn_id":"turn-2"}','succeeded','assistant','First pass and final answer');`)
  const rt = {resolveAgent() { assert.fail('An owned receipt does not require replay or a native scan') }}
  const args = {db, rt, conversationId:'c', sessionId:'s', bot:{}}
  assert.deepEqual(await importHistory(args), {imported:0, matched:1})
  const record = db.prepare('SELECT * FROM native_agent_events').get()
  assert.deepEqual({...record}, {message_id:'combined', session_id:'s', event_seq:null, source:'native'})
  assert.deepEqual(await importHistory(args), {imported:0, matched:0})
})
