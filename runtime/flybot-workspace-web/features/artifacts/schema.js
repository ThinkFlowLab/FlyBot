// Artifact tables for this user's DS-Bot (legacy artifacts.py SCHEMA, without
// cross-feature FK to workspaces/users: this volume is already private to one owner).
export const MIGRATIONS = [`
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  title TEXT NOT NULL,
  title_hash TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('document')),
  body TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision >= 1),
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  UNIQUE(workspace_id, key_hash),
  UNIQUE(workspace_id, title_hash));
CREATE INDEX IF NOT EXISTS artifact_workspace ON artifacts(workspace_id, id);
CREATE TABLE IF NOT EXISTS artifact_versions (
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK(revision >= 1),
  title TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('document', 'website', 'whiteboard', 'media')),
  body TEXT NOT NULL,
  board TEXT,
  mime TEXT,
  byte_count INTEGER,
  sha256 TEXT,
  filename TEXT,
  created INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  PRIMARY KEY (artifact_id, revision));
CREATE INDEX IF NOT EXISTS artifact_version_item ON artifact_versions(artifact_id, revision);
`, `
CREATE TABLE IF NOT EXISTS ot_users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  is_owner INTEGER NOT NULL CHECK(is_owner IN (0,1)));
CREATE TABLE IF NOT EXISTS artifact_favorites (
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  created INTEGER NOT NULL,
  PRIMARY KEY (artifact_id, user_id));
CREATE TABLE IF NOT EXISTS artifact_meta (
  artifact_id TEXT PRIMARY KEY REFERENCES artifacts(id) ON DELETE CASCADE,
  render TEXT NOT NULL CHECK(render IN ('website')));
CREATE TABLE IF NOT EXISTS artifact_sources (
  artifact_id TEXT PRIMARY KEY REFERENCES artifacts(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('automation_run','agent_task')),
  source_id TEXT NOT NULL,
  automation_id TEXT,
  automation_title TEXT,
  task_kind TEXT,
  created INTEGER NOT NULL,
  UNIQUE(workspace_id, source_kind, source_id));
CREATE TABLE IF NOT EXISTS artifact_shares (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  token_prefix TEXT NOT NULL,
  created INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  expires INTEGER,
  revoked INTEGER NOT NULL CHECK(revoked IN (0,1)),
  revoked_at INTEGER);
CREATE INDEX IF NOT EXISTS artifact_share_item ON artifact_shares(artifact_id, id);
CREATE TABLE IF NOT EXISTS artifact_media (
  artifact_id TEXT PRIMARY KEY REFERENCES artifacts(id) ON DELETE CASCADE,
  mime TEXT NOT NULL,
  byte_count INTEGER NOT NULL CHECK(byte_count >= 1),
  sha256 TEXT NOT NULL,
  filename TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS artifact_boards (
  artifact_id TEXT PRIMARY KEY REFERENCES artifacts(id) ON DELETE CASCADE,
  board TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS artifact_slides (
  artifact_id TEXT PRIMARY KEY REFERENCES artifacts(id) ON DELETE CASCADE,
  deck TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS artifact_dashboards (
  artifact_id TEXT PRIMARY KEY REFERENCES artifacts(id) ON DELETE CASCADE,
  dashboard TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS artifact_chat_sources (
  artifact_id TEXT PRIMARY KEY REFERENCES artifacts(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  agent_id TEXT,
  created INTEGER NOT NULL,
  conversation_title TEXT,
  UNIQUE(workspace_id, message_id));
`, `
CREATE TABLE artifact_spreadsheets (
  artifact_id TEXT PRIMARY KEY REFERENCES artifacts(id) ON DELETE CASCADE,
  workbook TEXT NOT NULL);
`, `
CREATE INDEX IF NOT EXISTS artifact_workspace_recent ON artifacts(workspace_id, updated DESC, id);
`, `
ALTER TABLE artifact_shares ADD COLUMN revocation_confirmed_at INTEGER;
`, `
CREATE INDEX IF NOT EXISTS artifact_chat_sources_conversation ON artifact_chat_sources(workspace_id, agent_id, conversation_id);
`, `
ALTER TABLE artifact_shares ADD COLUMN source_revision INTEGER;
`, `
CREATE TABLE artifact_share_keys (
  id INTEGER PRIMARY KEY CHECK(id=1),
  secret TEXT NOT NULL
);
ALTER TABLE artifact_shares ADD COLUMN recovery_version INTEGER NOT NULL DEFAULT 0;
`, `
CREATE TABLE artifact_team_run_sources (
  artifact_id TEXT PRIMARY KEY REFERENCES artifacts(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK(position BETWEEN 0 AND 7),
  run_title TEXT NOT NULL,
  UNIQUE(workspace_id, run_id, position));
`, `
CREATE TABLE artifact_restores (
  artifact_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  source_revision INTEGER NOT NULL,
  request_key TEXT,
  PRIMARY KEY (artifact_id, revision),
  UNIQUE (artifact_id, request_key),
  FOREIGN KEY (artifact_id, revision) REFERENCES artifact_versions(artifact_id, revision) ON DELETE CASCADE);
`, `
CREATE TABLE artifact_document_parents (
  artifact_id TEXT PRIMARY KEY REFERENCES artifacts(id) ON DELETE CASCADE,
  parent_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  CHECK (artifact_id <> parent_id));
CREATE INDEX artifact_document_parent ON artifact_document_parents(parent_id);
`]

export const IMPORT_TABLES = {
  ot_users: ['id', 'username', 'is_owner'],
  artifacts: ['id', 'workspace_id', 'title', 'title_hash', 'kind', 'body', 'revision', 'created', 'updated', 'created_by', 'updated_by', 'key_hash', 'request_hash'],
  artifact_favorites: ['artifact_id', 'user_id', 'created'],
  artifact_meta: ['artifact_id', 'render'],
  artifact_sources: ['artifact_id', 'workspace_id', 'source_kind', 'source_id', 'automation_id', 'automation_title', 'task_kind', 'created'],
  artifact_shares: ['id', 'artifact_id', 'workspace_id', 'token_hash', 'token_prefix', 'created', 'created_by', 'expires', 'revoked', 'revoked_at'],
  artifact_media: ['artifact_id', 'mime', 'byte_count', 'sha256', 'filename'],
  artifact_boards: ['artifact_id', 'board'],
  artifact_slides: ['artifact_id', 'deck'],
  artifact_dashboards: ['artifact_id', 'dashboard'],
  artifact_chat_sources: ['artifact_id', 'workspace_id', 'conversation_id', 'message_id', 'agent_id', 'created'],
  artifact_versions: ['artifact_id', 'revision', 'title', 'kind', 'body', 'board', 'mime', 'byte_count', 'sha256', 'filename', 'created', 'created_by'],
}
