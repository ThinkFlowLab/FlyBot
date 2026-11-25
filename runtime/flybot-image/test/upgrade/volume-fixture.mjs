import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, renameSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';

const checkpoint = JSON.parse(process.argv[2]);
const statePath = '/data/bot/state.json';
const databasePath = '/data/flybot-workspace/features/agents/agents.sqlite3';
const state = JSON.parse(readFileSync(statePath));
const bot = state.bots[checkpoint.botId];
assert.ok(bot, 'the seeded native Bot is on this account volume');
const [first, second, prior, task] = checkpoint.conversations;
const key = conversation => 'agent:' + checkpoint.agentId + ':' + conversation.id;
const metadata = bot.flybotWorkspace;
assert.equal(metadata.agent_id, checkpoint.agentId);
assert.equal(metadata.workspace_id, checkpoint.workspaceId);
assert.equal(new Set(checkpoint.conversations.map(x=>x.sessionId)).size,4);
const db = new DatabaseSync(databasePath);
try {
  db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
  for (const entry of checkpoint.conversations) {
    assert.equal(metadata.sessionKeys[key(entry)], entry.sessionId);
    const row = db.prepare('SELECT agent_id, session_id FROM native_agent_sessions WHERE conversation_key=?').get(key(entry));
    assert.equal(row?.agent_id, checkpoint.agentId);
    assert.equal(row?.session_id, entry.sessionId);
  }
  for (const entry of [prior, task]) {
    // These are real DSH Sessions populated through the baseline image. Remove
    // fixture-only Web projections so upgrade must distinguish a native earlier
    // part from a distinct Bot-owned task instead of seeing two more Web chats.
    delete metadata.sessionKeys[key(entry)];
    db.prepare('DELETE FROM native_agent_events WHERE session_id=?').run(entry.sessionId);
    db.prepare('DELETE FROM native_agent_sessions WHERE conversation_key=?').run(key(entry));
    assert.equal(db.prepare('DELETE FROM agent_conversations WHERE id=? AND agent_id=?').run(entry.id, checkpoint.agentId).changes,1);
  }
  const now = Date.now();
  bot.sessionId = second.sessionId;
  bot.segments = [];
  bot.openParts = [{sessionId:first.sessionId, segments:[{sessionId:prior.sessionId, endedAt:now-2000}], startedAt:now-1000}];
  bot.tasks = [{id:checkpoint.taskId,title:checkpoint.taskTitle,status:'done',sessionId:task.sessionId,segments:[],createdAt:now-2000,updatedAt:now-1000,result:'Completed upgrade-test task'}];
  writeFileSync(statePath+'.upgrade-checkpoint', JSON.stringify(state), {mode:0o600});
  renameSync(statePath+'.upgrade-checkpoint', statePath);
  writeFileSync('/data/volume-sentinel', checkpoint.sentinel, {mode:0o600});
  db.exec('COMMIT');
} catch (error) {
  db.exec('ROLLBACK');
  throw error;
} finally {
  db.close();
}
