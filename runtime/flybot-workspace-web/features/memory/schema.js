// Memory tables inside the user's DS-Bot (legacy flybot_workspace/memory.py SCHEMA,
// minus references to platform users/workspaces). ot_users maps legacy user
// ids to usernames for display; is_owner marks this DS-Bot's account.
export const MIGRATIONS = [`
CREATE TABLE IF NOT EXISTS ot_users (id TEXT PRIMARY KEY, username TEXT NOT NULL, is_owner INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS memory_pages (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, title TEXT NOT NULL, title_hash TEXT NOT NULL, body TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision >= 1), created INTEGER NOT NULL, updated INTEGER NOT NULL,
 created_by TEXT NOT NULL, updated_by TEXT NOT NULL, key_hash TEXT NOT NULL, request_hash TEXT NOT NULL,
 UNIQUE(workspace_id, key_hash), UNIQUE(workspace_id, title_hash));
CREATE TABLE IF NOT EXISTS memory_page_versions (
 page_id TEXT NOT NULL REFERENCES memory_pages(id) ON DELETE CASCADE, workspace_id TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision >= 1), title TEXT NOT NULL, body TEXT NOT NULL, created INTEGER NOT NULL,
 created_by TEXT NOT NULL, PRIMARY KEY(page_id, revision));
CREATE INDEX IF NOT EXISTS memory_page_version_owner ON memory_page_versions(workspace_id, page_id, revision);
CREATE TABLE IF NOT EXISTS memory_actions (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, title TEXT NOT NULL, notes TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('open', 'done')), due_at INTEGER CHECK(due_at IS NULL OR due_at >= 0),
 memory_page_id TEXT REFERENCES memory_pages(id) ON DELETE SET NULL, revision INTEGER NOT NULL CHECK(revision >= 1),
 created INTEGER NOT NULL, updated INTEGER NOT NULL, created_by TEXT NOT NULL, updated_by TEXT NOT NULL,
 key_hash TEXT NOT NULL, request_hash TEXT NOT NULL, UNIQUE(workspace_id, key_hash));
CREATE TABLE IF NOT EXISTS memory_page_topics (
 page_id TEXT NOT NULL REFERENCES memory_pages(id) ON DELETE CASCADE, workspace_id TEXT NOT NULL,
 name TEXT NOT NULL, name_hash TEXT NOT NULL, PRIMARY KEY (page_id, name_hash));
CREATE INDEX IF NOT EXISTS memory_page_topic_workspace ON memory_page_topics(workspace_id, name_hash, page_id);
CREATE TABLE IF NOT EXISTS memory_links (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
 left_id TEXT NOT NULL REFERENCES memory_pages(id) ON DELETE CASCADE,
 right_id TEXT NOT NULL REFERENCES memory_pages(id) ON DELETE CASCADE,
 created INTEGER NOT NULL, created_by TEXT NOT NULL, key_hash TEXT NOT NULL, request_hash TEXT NOT NULL,
 UNIQUE(workspace_id, left_id, right_id), UNIQUE(workspace_id, key_hash), CHECK(left_id < right_id));
CREATE INDEX IF NOT EXISTS memory_link_workspace ON memory_links(workspace_id, id);
CREATE TABLE IF NOT EXISTS memory_suggestions (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, page_id TEXT NOT NULL REFERENCES memory_pages(id) ON DELETE CASCADE,
 kind TEXT NOT NULL, summary TEXT NOT NULL, payload TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('open', 'accepted', 'ignored')), created INTEGER NOT NULL, decided INTEGER, applied TEXT);
CREATE INDEX IF NOT EXISTS memory_suggestion_page ON memory_suggestions(workspace_id, page_id, id);
CREATE TABLE IF NOT EXISTS memory_profiles (
 workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, professional TEXT NOT NULL, work_style TEXT NOT NULL,
 communication TEXT NOT NULL, revision INTEGER NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY(workspace_id, user_id));
CREATE TABLE IF NOT EXISTS memory_preferences (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, text TEXT NOT NULL, text_hash TEXT NOT NULL,
 position INTEGER NOT NULL, created INTEGER NOT NULL, key_hash TEXT NOT NULL, request_hash TEXT NOT NULL,
 UNIQUE(workspace_id, user_id, text_hash), UNIQUE(workspace_id, user_id, key_hash));
CREATE INDEX IF NOT EXISTS memory_preference_owner ON memory_preferences(workspace_id, user_id, position, id);
`, `
CREATE TABLE memory_capture_settings (workspace_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)));
CREATE TABLE memory_capture_items (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, agent_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
  created INTEGER NOT NULL, available INTEGER NOT NULL, failures INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','ready','saved')),
  title TEXT, body TEXT, source_title TEXT, excerpt TEXT,
  page_id TEXT REFERENCES memory_pages(id) ON DELETE CASCADE);
CREATE INDEX memory_capture_pending ON memory_capture_items(state,available,id);
CREATE INDEX memory_capture_workspace ON memory_capture_items(workspace_id,state,created);
CREATE INDEX memory_capture_page ON memory_capture_items(workspace_id,page_id);
`, `
ALTER TABLE memory_capture_items ADD COLUMN origin TEXT NOT NULL DEFAULT 'auto' CHECK(origin IN ('auto','selected'));
CREATE TABLE memory_capture_reviewed (message_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL);
CREATE INDEX memory_capture_selected ON memory_capture_items(workspace_id,agent_id,conversation_id,origin,state,available);
`, `
ALTER TABLE memory_capture_items ADD COLUMN source_message_id TEXT;
ALTER TABLE memory_capture_items ADD COLUMN source_batch TEXT;
`, `
CREATE TABLE memory_capture_groups (
  workspace_id TEXT NOT NULL, conversation_id TEXT NOT NULL, generation TEXT NOT NULL,
  membership INTEGER NOT NULL, cursor INTEGER NOT NULL, next_scan INTEGER NOT NULL,
  PRIMARY KEY(workspace_id,conversation_id));
CREATE INDEX memory_capture_groups_due ON memory_capture_groups(next_scan);
`, `
CREATE TABLE memory_action_draft_saves (
  workspace_id TEXT NOT NULL, owner_id TEXT NOT NULL, key_hash TEXT NOT NULL,
  request_hash TEXT NOT NULL, action_ids TEXT NOT NULL,
  PRIMARY KEY (workspace_id,owner_id,key_hash));
`, `
CREATE INDEX IF NOT EXISTS memory_page_workspace_recent ON memory_pages(workspace_id, updated DESC, id);
`, `
CREATE TABLE memory_meeting_sources (
  workspace_id TEXT NOT NULL, meeting_id TEXT NOT NULL,
  page_id TEXT NOT NULL UNIQUE REFERENCES memory_pages(id) ON DELETE CASCADE,
  meeting_revision INTEGER NOT NULL, page_revision INTEGER NOT NULL,
  PRIMARY KEY(workspace_id, meeting_id));
`, `
CREATE TABLE memory_shared_meeting_action_sources (
  action_id TEXT PRIMARY KEY REFERENCES memory_actions(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL, share_id TEXT NOT NULL, revision INTEGER NOT NULL, action_index INTEGER NOT NULL);
CREATE INDEX memory_shared_meeting_action_receipt
  ON memory_shared_meeting_action_sources(workspace_id, share_id, revision);
`, `
CREATE TABLE IF NOT EXISTS memory_chat_action_sources (
  action_id TEXT PRIMARY KEY REFERENCES memory_actions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('agent','social')),
  workspace_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  agent_id TEXT,
  revision INTEGER);
`, `
CREATE TABLE memory_owned_meeting_action_sources (
  action_id TEXT PRIMARY KEY REFERENCES memory_actions(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL, meeting_id TEXT NOT NULL, revision INTEGER NOT NULL, action_index INTEGER NOT NULL);
`, `
CREATE TABLE memory_page_reads (
 page_id TEXT NOT NULL REFERENCES memory_pages(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision >= 1),
 PRIMARY KEY(page_id, user_id));
`, `
CREATE TABLE memory_page_pins (
 page_id TEXT NOT NULL REFERENCES memory_pages(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL,
 PRIMARY KEY(page_id, user_id));
CREATE INDEX memory_pins_by_user ON memory_page_pins(user_id, page_id);
`]

export const IMPORT_TABLES = {
  ot_users: ['id', 'username', 'is_owner'],
  memory_pages: ['id', 'workspace_id', 'title', 'title_hash', 'body', 'revision', 'created', 'updated', 'created_by', 'updated_by', 'key_hash', 'request_hash'],
  memory_page_versions: ['page_id', 'workspace_id', 'revision', 'title', 'body', 'created', 'created_by'],
  memory_page_topics: ['page_id', 'workspace_id', 'name', 'name_hash'],
  memory_links: ['id', 'workspace_id', 'left_id', 'right_id', 'created', 'created_by', 'key_hash', 'request_hash'],
  memory_actions: ['id', 'workspace_id', 'title', 'notes', 'status', 'due_at', 'memory_page_id', 'revision', 'created', 'updated', 'created_by', 'updated_by', 'key_hash', 'request_hash'],
  memory_suggestions: ['id', 'workspace_id', 'page_id', 'kind', 'summary', 'payload', 'status', 'created', 'decided', 'applied'],
  memory_profiles: ['workspace_id', 'user_id', 'professional', 'work_style', 'communication', 'revision', 'updated'],
  memory_preferences: ['id', 'workspace_id', 'user_id', 'text', 'text_hash', 'position', 'created', 'key_hash', 'request_hash'],
}
