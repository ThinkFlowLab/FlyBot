"""Private model-assisted message operations; persisted tasks, never fake output."""
SCHEMA = """
CREATE TABLE IF NOT EXISTS message_assists (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 conversation_id TEXT NOT NULL REFERENCES social_conversations(id) ON DELETE CASCADE,
 message_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 source_revision INTEGER NOT NULL, operation TEXT NOT NULL, instruction TEXT NOT NULL,
 task_id TEXT REFERENCES runtime_tasks(id) ON DELETE SET NULL, created INTEGER NOT NULL,
 key_hash TEXT NOT NULL, request_hash TEXT NOT NULL, UNIQUE(user_id,key_hash));
CREATE TABLE IF NOT EXISTS group_announcements (
 conversation_id TEXT PRIMARY KEY REFERENCES social_conversations(id) ON DELETE CASCADE,
 body TEXT NOT NULL, revision INTEGER NOT NULL, updated INTEGER NOT NULL,
 updated_by TEXT NOT NULL REFERENCES users(id));
"""
