import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { assert } from "../errors.js";
import { body, hashCode, one, params, query, text, type OtContext } from "./core.js";
import { requireMember } from "./teams.js";
import { studioLiveState } from "./studio-live.js";

export const STUDIO_SCHEMA = `
CREATE TABLE IF NOT EXISTS ot_studio_documents (
  id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES ot_teams(id) ON DELETE CASCADE,
  title TEXT NOT NULL, body TEXT NOT NULL, revision INTEGER NOT NULL,
  created_by TEXT NOT NULL, updated_by TEXT NOT NULL, updated_at INTEGER NOT NULL,
  key_hash TEXT NOT NULL, request_hash TEXT NOT NULL, deleted_at INTEGER,
  UNIQUE (team_id, created_by, key_hash)
);
CREATE INDEX IF NOT EXISTS ot_studio_documents_recent
  ON ot_studio_documents(team_id, updated_at DESC, id) WHERE deleted_at IS NULL;
CREATE TABLE IF NOT EXISTS ot_studio_revisions (
  document_id TEXT NOT NULL REFERENCES ot_studio_documents(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
  editor_id TEXT NOT NULL, updated_at INTEGER NOT NULL, restored_from INTEGER,
  PRIMARY KEY (document_id, revision)
);
INSERT OR IGNORE INTO ot_studio_revisions (document_id, revision, title, body, editor_id, updated_at)
  SELECT id, revision, title, body, updated_by, updated_at FROM ot_studio_documents WHERE deleted_at IS NULL;
`;

const HEX_ID = /^[0-9a-f]{32}$/;
const CREATE_KEY = /^[A-Za-z0-9_-]{16,64}$/;
const MAX_DOCUMENTS = 100;
const MAX_REVISIONS = 30;
const COLLECTION = "/v1/ot/teams/:team/studio/documents";
const DETAIL = COLLECTION + "/:document";
const HISTORY = DETAIL + "/versions";
const LIVE = DETAIL + "/live";
const SUMMARY = `d.id, d.title, d.revision, d.created_by, d.updated_at,
  COALESCE(creator.display_name, '') AS creator_name,
  COALESCE(editor.display_name, '') AS editor_name`;
const DOCUMENTS = `FROM ot_studio_documents d
  LEFT JOIN ot_profiles creator ON creator.owner_id=d.created_by
  LEFT JOIN ot_profiles editor ON editor.owner_id=d.updated_by`;

type Scope = { teamId: string; ownerId: string; role: string };
type Summary = {
  id: string; title: string; revision: number; created_by: string; updated_at: number;
  creator_name: string; editor_name: string;
};
type Document = Summary & {body: string};
type Revision = {revision: number; title: string; updated_by: string; updated_at: number; restored_from: number | null};
const HISTORY_FIELDS = `r.revision, r.title, COALESCE(editor.display_name, '') AS updated_by,
  r.updated_at, r.restored_from`;
const HISTORY_ROWS = `FROM ot_studio_revisions r LEFT JOIN ot_profiles editor ON editor.owner_id=r.editor_id`;

function scope(ot: OtContext, req: FastifyRequest): Scope {
  const { ownerId } = ot.me(req);
  const target = params(req).team;
  const teamId = HEX_ID.test(target)
    ? ot.get<{id: string}>("SELECT id FROM ot_teams WHERE workspace_id=?", target)?.id
    : target;
  assert(teamId, 404, "team_not_found", "no such team");
  const { team, role } = requireMember(ot, teamId, ownerId);
  assert(team.workspace_id && team.slug, 404, "team_not_found", "no such team");
  return { teamId, ownerId, role };
}

function requireSourceWorkspace(ot: OtContext, access: Scope, workspace: unknown) {
  assert(typeof workspace === "string" && HEX_ID.test(workspace), 400, "invalid_request", "Invalid source workspace");
  const source = ot.get<{id: string}>("SELECT id FROM ot_teams WHERE workspace_id=? AND slug IS NOT NULL", workspace);
  assert(source, 404, "team_not_found", "no such team");
  requireMember(ot, source.id, access.ownerId);
}

function fields(req: FastifyRequest, keys: string[]): Record<string, unknown> {
  const value: unknown = body(req);
  assert(value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).every(key => keys.includes(key)), 400, "invalid_request", "Unexpected document fields");
  return value as Record<string, unknown>;
}

function content(value: Record<string, unknown>) {
  return {
    title: text(value.title, "title", { min: 1, max: 120 }),
    body: text(value.body, "body", { max: 60_000, multiline: true }),
  };
}

function expectedRevision(value: unknown): number {
  assert(typeof value === "number" && Number.isSafeInteger(value) && value >= 1,
    400, "invalid_request", "Invalid revision");
  return value;
}

function canDelete(access: Scope, row: Summary) {
  return access.ownerId === row.created_by || access.role === "owner" || access.role === "admin";
}

function summary(access: Scope, row: Summary) {
  return { id: row.id, title: row.title, revision: row.revision, updated_at: row.updated_at,
    updated_by: row.editor_name, created_by: row.creator_name, can_delete: canDelete(access, row) };
}

function detail(ot: OtContext, access: Scope, id: string) {
  assert(HEX_ID.test(id), 404, "document_not_found", "no such document");
  const row = ot.get<Document>(`SELECT ${SUMMARY}, d.body ${DOCUMENTS}
    WHERE d.team_id=? AND d.id=? AND d.deleted_at IS NULL`, access.teamId, id);
  assert(row, 404, "document_not_found", "no such document");
  return row;
}

function currentRevision(ot: OtContext, access: Scope, id: string) {
  assert(HEX_ID.test(id), 404, "document_not_found", "no such document");
  const row = ot.get<{revision: number}>(`SELECT revision FROM ot_studio_documents
    WHERE team_id=? AND id=? AND deleted_at IS NULL`, access.teamId, id);
  assert(row, 404, "document_not_found", "no such document");
  return row.revision;
}

function revisionNumber(value: string) {
  assert(/^[1-9][0-9]{0,15}$/.test(value), 400, "invalid_request", "Invalid revision");
  return expectedRevision(Number(value));
}

function snapshot(ot: OtContext, id: string, restoredFrom: number | null = null) {
  ot.run(`INSERT INTO ot_studio_revisions (document_id, revision, title, body, editor_id, updated_at, restored_from)
    SELECT id, revision, title, body, updated_by, updated_at, ? FROM ot_studio_documents WHERE id=?`, restoredFrom, id);
  ot.run(`DELETE FROM ot_studio_revisions WHERE document_id=? AND revision <=
    (SELECT revision FROM ot_studio_documents WHERE id=?) - ?`, id, id, MAX_REVISIONS);
}

function update(ot: OtContext, access: Scope, id: string, revision: number, draft: {title: string; body: string},
    restoredFrom: number | null = null) {
  const result = ot.run(`UPDATE ot_studio_documents
    SET title=?,body=?,revision=revision+1,updated_by=?,updated_at=?
    WHERE team_id=? AND id=? AND revision=? AND deleted_at IS NULL`,
  draft.title, draft.body, access.ownerId, ot.now(), access.teamId, id, revision);
  assert(result.changes === 1, 409, "revision_conflict", "The document has a newer revision");
  snapshot(ot, id, restoredFrom);
  return { document: view(access, detail(ot, access, id)) };
}

function view(access: Scope, row: Document) {
  return { ...summary(access, row), body: row.body };
}

function checkRevision(current: number, expected: number) {
  assert(current === expected, 409, "revision_conflict", "The document has a newer revision");
}

export function registerStudio(app: FastifyInstance, ot: OtContext) {
  const live = studioLiveState(ot);
  app.get(COLLECTION, async (req, reply) => ot.tx(() => {
    const access = scope(ot, req);
    reply.header("Cache-Control", "private, no-store");
    const rows = ot.all<Summary>(`SELECT ${SUMMARY} ${DOCUMENTS}
      WHERE d.team_id=? AND d.deleted_at IS NULL ORDER BY d.updated_at DESC, d.id LIMIT ?`,
    access.teamId, MAX_DOCUMENTS);
    return { items: rows.map(row => summary(access, row)) };
  }));

  app.post(COLLECTION, async (req, reply) => {
    const result = ot.db.transaction(() => {
      const access = scope(ot, req);
      const input = fields(req, ["title", "body", "client_key", "source_workspace_id"]);
      if (input.source_workspace_id !== undefined) requireSourceWorkspace(ot, access, input.source_workspace_id);
      const draft = content(input);
      assert(typeof input.client_key === "string" && CREATE_KEY.test(input.client_key),
        400, "invalid_request", "Invalid client_key");
      const keyHash = hashCode(input.client_key);
      const requestHash = hashCode(JSON.stringify(input.source_workspace_id === undefined
        ? draft : {...draft, source_workspace_id:input.source_workspace_id}));
      const prior = ot.get<{id: string; request_hash: string; deleted_at: number | null}>(`
        SELECT id, request_hash, deleted_at FROM ot_studio_documents
        WHERE team_id=? AND created_by=? AND key_hash=?`, access.teamId, access.ownerId, keyHash);
      if (prior) {
        assert(prior.request_hash === requestHash, 409, "idempotency_conflict", "Idempotency key reused");
        assert(prior.deleted_at === null, 409, "document_deleted", "This document was deleted");
        return { status: 200, document: view(access, detail(ot, access, prior.id)) };
      }
      const count = ot.get<{n: number}>(`SELECT COUNT(*) AS n FROM ot_studio_documents
        WHERE team_id=? AND deleted_at IS NULL`, access.teamId)!.n;
      assert(count < MAX_DOCUMENTS, 409, "document_limit", "This team has reached the document limit");
      const id = randomBytes(16).toString("hex");
      ot.run(`INSERT INTO ot_studio_documents
        (id, team_id, title, body, revision, created_by, updated_by, updated_at, key_hash, request_hash)
        VALUES (?,?,?,?,1,?,?,?,?,?)`, id, access.teamId, draft.title, draft.body, access.ownerId,
      access.ownerId, ot.now(), keyHash, requestHash);
      snapshot(ot, id);
      return { status: 201, document: view(access, detail(ot, access, id)) };
    }).immediate();
    return reply.code(result.status).send({ document: result.document });
  });

  app.get(DETAIL, async (req, reply) => ot.tx(() => {
    const access = scope(ot, req);
    reply.header("Cache-Control", "private, no-store");
    const id = params(req).document;
    const filters = query(req);
    assert(Object.keys(filters).every(key => key === "revision"), 400, "invalid_request", "Unexpected document query");
    const requested = one(filters.revision, "revision");
    if (requested !== undefined) {
      const revision = revisionNumber(requested);
      if (currentRevision(ot, access, id) === revision) return { unchanged: true, revision };
    }
    return { document: view(access, detail(ot, access, id)) };
  }));

  app.get(LIVE, async (req, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const access = scope(ot, req);
    const id = params(req).document;
    const filters = query(req);
    assert(Object.keys(filters).length === 1, 400, "invalid_request", "A Studio watch requires one revision");
    const requested = one(filters.revision, "revision");
    assert(requested, 400, "invalid_request", "A Studio watch requires a revision");
    const known = revisionNumber(requested);
    const read = (authorized: Scope, revision: number) => ({
      ...(revision === known ? { unchanged: true, revision } : { document: view(authorized, detail(ot, authorized, id)) }),
      editors: live.editors(id, authorized.teamId, authorized.ownerId),
    });
    const current = currentRevision(ot, access, id);
    if (known !== current) return read(access, current);
    await live.wait(id, access.ownerId, reply.raw);
    return ot.tx(() => {
      const authorized = scope(ot, req);
      return read(authorized, currentRevision(ot, authorized, id));
    });
  });

  app.post(LIVE, async (req, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const access = scope(ot, req);
    const id = params(req).document;
    const {session_id, active, editing} = fields(req, ["session_id", "active", "editing"]);
    assert(Object.keys(query(req)).length === 0 && typeof session_id === "string" && CREATE_KEY.test(session_id) &&
      typeof active === "boolean" && typeof editing === "boolean", 400, "invalid_request", "Invalid Studio presence");
    currentRevision(ot, access, id);
    live.touch(id, access.ownerId, session_id, active, editing);
    return { ok: true };
  });

  app.put(DETAIL, async req => {
    const {result, changed} = ot.db.transaction(() => {
      const access = scope(ot, req);
      const row = detail(ot, access, params(req).document);
      const input = fields(req, ["title", "body", "revision"]);
      const revision = expectedRevision(input.revision);
      checkRevision(row.revision, revision);
      const draft = content(input);
      if (draft.title === row.title && draft.body === row.body) {
        return {result:{document:view(access, row)}, changed:false};
      }
      return {result:update(ot, access, row.id, revision, draft), changed:true};
    }).immediate();
    if (changed) live.update(result.document.id);
    return result;
  });

  app.get(HISTORY, async (req, reply) => ot.tx(() => {
    const access = scope(ot, req);
    const id = params(req).document;
    const current_revision = currentRevision(ot, access, id);
    reply.header("Cache-Control", "private, no-store");
    const items = ot.all<Revision>(`SELECT ${HISTORY_FIELDS} ${HISTORY_ROWS}
      WHERE r.document_id=? ORDER BY r.revision DESC LIMIT ?`, id, MAX_REVISIONS);
    return { items, current_revision, retained_limit: MAX_REVISIONS };
  }));

  app.get(HISTORY + "/:revision", async (req, reply) => ot.tx(() => {
    const access = scope(ot, req);
    const {document: id, revision} = params(req);
    const current_revision = currentRevision(ot, access, id);
    reply.header("Cache-Control", "private, no-store");
    const version = ot.get<Revision & {body: string}>(`SELECT ${HISTORY_FIELDS}, r.body ${HISTORY_ROWS}
      WHERE r.document_id=? AND r.revision=?`, id, revisionNumber(revision));
    assert(version, 404, "revision_not_found", "no such revision");
    return { version, current_revision };
  }));

  app.post(DETAIL + "/restore", async req => {
    const result = ot.db.transaction(() => {
      const access = scope(ot, req);
      const id = params(req).document;
      const current = currentRevision(ot, access, id);
      const input = fields(req, ["revision", "to"]);
      const base = expectedRevision(input.revision);
      const to = expectedRevision(input.to);
      checkRevision(current, base);
      assert(to < current, 400, "invalid_request", "Choose an earlier revision");
      const version = ot.get<{title: string; body: string}>(`SELECT title, body FROM ot_studio_revisions
        WHERE document_id=? AND revision=?`, id, to);
      assert(version, 404, "revision_not_found", "no such revision");
      return update(ot, access, id, base, version, to);
    }).immediate();
    live.update(result.document.id);
    return result;
  });

  app.delete(DETAIL, async req => {
    const id = params(req).document;
    ot.db.transaction(() => {
      const access = scope(ot, req);
      const row = detail(ot, access, id);
      assert(canDelete(access, row), 403, "forbidden", "Your role cannot delete this document");
      const revision = expectedRevision(fields(req, ["revision"]).revision);
      checkRevision(row.revision, revision);
      // Retain the create receipt after removing the contents, so a retry cannot recreate the document.
      const result = ot.run(`UPDATE ot_studio_documents SET title='',body='',deleted_at=?
        WHERE team_id=? AND id=? AND revision=? AND deleted_at IS NULL`,
      ot.now(), access.teamId, row.id, revision);
      assert(result.changes === 1, 409, "revision_conflict", "The document has a newer revision");
      ot.run("DELETE FROM ot_studio_revisions WHERE document_id=?", row.id);
    }).immediate();
    live.update(id, true);
    return { deleted: true };
  });
}
