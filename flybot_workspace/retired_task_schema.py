"""Historical task, approval and agent routing tables retained for imports and audits."""

SCHEMA = '''
CREATE TABLE IF NOT EXISTS runtime_keys (
 id TEXT PRIMARY KEY,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 name TEXT NOT NULL,
 token_hash TEXT NOT NULL UNIQUE,
 prefix TEXT NOT NULL,
 created INTEGER NOT NULL,
 expires INTEGER,
 revoked INTEGER NOT NULL CHECK(revoked IN (0,1)));
CREATE INDEX IF NOT EXISTS runtime_key_user ON runtime_keys(user_id, id);
CREATE TABLE IF NOT EXISTS runtime_devices (
 user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 device_id TEXT NOT NULL UNIQUE,
 created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS runtime_connections (
 id TEXT PRIMARY KEY,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 key_id TEXT NOT NULL REFERENCES runtime_keys(id) ON DELETE CASCADE,
 hostname TEXT NOT NULL,
 created INTEGER NOT NULL,
 last_seen INTEGER NOT NULL,
 UNIQUE(key_id));
CREATE INDEX IF NOT EXISTS runtime_connection_user ON runtime_connections(user_id, last_seen, id);
CREATE TABLE IF NOT EXISTS runtime_tasks (
 id TEXT PRIMARY KEY,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 connection_id TEXT NOT NULL REFERENCES runtime_connections(id) ON DELETE CASCADE,
 kind TEXT NOT NULL,
 prompt TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('queued','claimed','succeeded','failed')),
 result TEXT,
 created INTEGER NOT NULL,
 updated INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS runtime_task_connection ON runtime_tasks(connection_id, status, created, id);
CREATE INDEX IF NOT EXISTS runtime_task_user ON runtime_tasks(user_id, created, id);
CREATE TABLE IF NOT EXISTS runtime_task_meta (
 task_id TEXT PRIMARY KEY REFERENCES runtime_tasks(id) ON DELETE CASCADE,
 workspace_id TEXT,
 deadline INTEGER NOT NULL,
 access_issued INTEGER NOT NULL CHECK(access_issued IN (0,1)));
CREATE TABLE IF NOT EXISTS composio_principals (
 task_id TEXT PRIMARY KEY REFERENCES runtime_tasks(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 scope TEXT NOT NULL CHECK(scope IN ('group','scheduled','dsh')),
 source_type TEXT NOT NULL,
 source_id TEXT NOT NULL,
 created INTEGER NOT NULL,
 revoked INTEGER);
CREATE INDEX IF NOT EXISTS composio_principal_user ON composio_principals(user_id, scope, created);
CREATE TABLE IF NOT EXISTS composio_scheduled_grants (
 automation_id TEXT NOT NULL,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
 revision INTEGER NOT NULL CHECK(revision >= 1),
 updated INTEGER NOT NULL,
 PRIMARY KEY(automation_id, user_id));
CREATE TABLE IF NOT EXISTS connected_tool_owners (
 task_id TEXT PRIMARY KEY REFERENCES runtime_tasks(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS connected_tool_schemas (
 task_id TEXT NOT NULL REFERENCES runtime_tasks(id) ON DELETE CASCADE,
 name TEXT NOT NULL, connection_id TEXT NOT NULL,
 version TEXT NOT NULL, schema_json TEXT NOT NULL, key_blob TEXT NOT NULL,
 PRIMARY KEY(task_id,name));
CREATE TABLE IF NOT EXISTS connected_tool_calls (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES runtime_tasks(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id), call_id TEXT NOT NULL,
 name TEXT NOT NULL, connection_id TEXT NOT NULL, arguments TEXT NOT NULL,
 status TEXT NOT NULL, result TEXT, created INTEGER NOT NULL, expires INTEGER NOT NULL,
 UNIQUE(task_id,call_id));
CREATE TABLE IF NOT EXISTS workspace_agent_bindings (
 agent_id TEXT PRIMARY KEY REFERENCES workspace_agents(id) ON DELETE CASCADE,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 instance_id TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision >= 1),
 bound_by TEXT NOT NULL REFERENCES users(id),
 created INTEGER NOT NULL,
 updated INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS workspace_agent_binding_instance
 ON workspace_agent_bindings(workspace_id, instance_id);
CREATE TABLE IF NOT EXISTS instance_runtime_keys (
 instance_id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 key_id TEXT NOT NULL UNIQUE REFERENCES runtime_keys(id),
 token_blob TEXT NOT NULL,
 issued_job_id TEXT NOT NULL,
 created INTEGER NOT NULL,
 updated INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS agent_message_dispatch (
 message_id TEXT PRIMARY KEY REFERENCES agent_messages(id) ON DELETE CASCADE,
 source TEXT NOT NULL CHECK(source IN ('instance','connection')),
 instance_id TEXT,
 connection_id TEXT);
'''
