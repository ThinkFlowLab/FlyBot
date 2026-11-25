// FlyBot team-run sharing on Bot Social. The owner's DS-Bot executes the run (features/team-runs);
// this stores only a teammate-visible snapshot (title, goal, status, step summaries) on a team they
// belong to. Private prompts, memory and credentials never come here.
import type { FastifyInstance } from "fastify";
import { assert } from "../errors.js";
import { newId } from "../ids.js";
import { createHash } from "node:crypto";
import { body, OtContext, params, query, text } from "./core.js";
import { requireMember } from "./teams.js";

export const SHARES_SCHEMA = `
CREATE TABLE IF NOT EXISTS ot_shared_runs (
  id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES ot_teams(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL, run_ref TEXT NOT NULL, title TEXT NOT NULL, goal TEXT NOT NULL,
  status TEXT NOT NULL, snapshot TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE (team_id, owner_id, run_ref)
);
CREATE INDEX IF NOT EXISTS ot_shared_runs_team ON ot_shared_runs(team_id, updated_at);
CREATE TABLE IF NOT EXISTS ot_public_shares (
  token_hash TEXT PRIMARY KEY, owner_id TEXT NOT NULL, ref TEXT NOT NULL, title TEXT NOT NULL,
  kind TEXT NOT NULL, body TEXT NOT NULL, expires_at INTEGER, revoked INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
`;

const STATUSES = new Set(["running", "succeeded", "failed", "cancelled"]);
const SNAPSHOT_MAX = 100_000;
const REF = /^[A-Za-z0-9._:-]{1,80}$/;

function view(ot: OtContext, r: any, detail = true) {
  return {
    id: r.id, team_id: r.team_id, run_ref: r.run_ref, title: r.title, status: r.status,
    ...(detail ? {goal: r.goal, snapshot: JSON.parse(r.snapshot)} : {}),
    owner: ot.profileView(r.owner_id), created_at: r.created_at, updated_at: r.updated_at,
  };
}

function parseSnapshot(raw: unknown) {
  assert(raw !== undefined && raw !== null && typeof raw === "object" && !Array.isArray(raw), 400, "invalid_request", "snapshot must be an object");
  const texted = JSON.stringify(raw);
  assert(texted.length <= SNAPSHOT_MAX, 400, "invalid_request", "snapshot is too large");
  const steps = Array.isArray((raw as any).steps) ? (raw as any).steps.slice(0, 8) : [];
  // Only the teammate-visible fields: status and a short output, never the instruction or raw errors.
  return JSON.stringify({
    progress: (raw as any).progress ?? null,
    steps: steps.map((s: any) => ({
      position: Number(s?.position) || 0,
      agent_name: String(s?.agent_name ?? "").slice(0, 80),
      status: String(s?.status ?? "").slice(0, 20),
      output: String(s?.output ?? "").slice(0, 2000),
    })),
  });
}

export function registerShares(app: FastifyInstance, ot: OtContext) {
  app.put("/v1/ot/teams/:id/shared-runs", async (req) => {
    const me = ot.me(req);
    const { team } = requireMember(ot, params(req).id, me.ownerId);
    const b = body(req);
    assert(typeof b.run_ref === "string" && REF.test(b.run_ref), 400, "invalid_request", "run_ref is invalid");
    const title = text(b.title, "title", { min: 1, max: 80 });
    const goal = text(b.goal, "goal", { min: 1, max: 2000, multiline: true });
    assert(STATUSES.has(String(b.status)), 400, "invalid_request", "status is invalid");
    const snapshot = parseSnapshot(b.snapshot);
    const now = ot.now();
    const existing = ot.get<any>("SELECT * FROM ot_shared_runs WHERE team_id = ? AND owner_id = ? AND run_ref = ?", team.id, me.ownerId, b.run_ref);
    const id = existing?.id ?? newId("otsr");
    if (existing) {
      ot.run("UPDATE ot_shared_runs SET title = ?, goal = ?, status = ?, snapshot = ?, updated_at = ? WHERE id = ?", title, goal, b.status, snapshot, now, id);
    } else {
      assert(ot.get<any>("SELECT COUNT(*) AS n FROM ot_shared_runs WHERE team_id = ? AND owner_id = ?", team.id, me.ownerId).n < 100, 429, "too_many_shares", "share limit reached");
      ot.tx(() => {
        ot.run("INSERT INTO ot_shared_runs(id, team_id, owner_id, run_ref, title, goal, status, snapshot, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
          id, team.id, me.ownerId, b.run_ref, title, goal, b.status, snapshot, now, now);
        const owner = ot.profileView(me.ownerId);
        for (const m of ot.all<any>("SELECT owner_id FROM ot_team_members WHERE team_id = ? AND suspended = 0 AND owner_id != ?", team.id, me.ownerId)) {
          ot.notify(m.owner_id, "team.run_shared", {
            team_id: team.id, team_name: team.name, workspace_id: team.workspace_id, share_id: id, title, owner,
          });
        }
      });
    }
    return view(ot, ot.get("SELECT * FROM ot_shared_runs WHERE id = ?", id));
  });
  app.get("/v1/ot/teams/:id/shared-runs", async (req) => {
    const me = ot.me(req);
    const { team } = requireMember(ot, params(req).id, me.ownerId);
    const summary = query(req).summary === "1";
    const fields = summary ? "id, team_id, owner_id, run_ref, title, status, created_at, updated_at" : "*";
    return { runs: ot.all<any>(`SELECT ${fields} FROM ot_shared_runs WHERE team_id = ? ORDER BY updated_at DESC, id DESC LIMIT 200`, team.id)
      .map((r) => view(ot, r, !summary)) };
  });
  app.get("/v1/ot/teams/:id/shared-runs/:share", async (req) => {
    const me = ot.me(req);
    const { team } = requireMember(ot, params(req).id, me.ownerId);
    const r = ot.get<any>("SELECT * FROM ot_shared_runs WHERE id = ? AND team_id = ?", params(req).share, team.id);
    assert(r, 404, "share_not_found", "no such shared run");
    return view(ot, r);
  });
  app.delete("/v1/ot/teams/:id/shared-runs/:share", async (req) => {
    const me = ot.me(req);
    const { team } = requireMember(ot, params(req).id, me.ownerId);
    const r = ot.get<any>("SELECT * FROM ot_shared_runs WHERE id = ? AND team_id = ?", params(req).share, team.id);
    assert(r, 404, "share_not_found", "no such shared run");
    assert(r.owner_id === me.ownerId, 403, "forbidden", "only the owner can unshare this run");
    ot.run("DELETE FROM ot_shared_runs WHERE id = ?", r.id);
    return { unshared: true };
  });

  // ---- public read-only artifact shares (replaces the platform's /share/<token> page).
  // The owner's DS-Bot keeps the share record and publishes a snapshot keyed by
  // sha256("share:" + token); the raw token is never stored by Bot Social.
  const HASH = /^[0-9a-f]{64}$/;
  const TOKEN = /^[A-Za-z0-9_-]{43}$/;
  function visibleShare(token: unknown) {
    if (typeof token !== "string" || !TOKEN.test(token)) return null;
    const hash = createHash("sha256").update("share:" + token).digest("hex");
    const row = ot.get<any>("SELECT * FROM ot_public_shares WHERE token_hash = ?", hash);
    return row && !row.revoked && (row.expires_at == null || row.expires_at > ot.now()) ? row : null;
  }

  // Only the text exposed by the share page is eligible. Older snapshots may
  // describe other formats as documents, so the copy is always a text document.
  const copyable = (row: {kind: string; title: string; body: string}) =>
    row.kind === "document" && row.title.trim().length <= 80 && row.body.length <= 8000 && Boolean(row.body.trim());

  app.put("/v1/ot/public-shares", async (req) => {
    const me = ot.me(req);
    const b = body(req);
    assert(typeof b.token_hash === "string" && HASH.test(b.token_hash), 400, "invalid_request", "token_hash must be 64 hex characters");
    assert(typeof b.ref === "string" && REF.test(b.ref), 400, "invalid_request", "ref is invalid");
    const title = text(b.title, "title", { min: 1, max: 200 });
    const kind = text(b.kind ?? "document", "kind", { min: 1, max: 40 });
    assert(typeof (b.body ?? "") === "string" && String(b.body ?? "").length <= 200_000, 400, "invalid_request", "body is too large");
    const expires = b.expires_at == null ? null : Number(b.expires_at);
    assert(expires === null || Number.isInteger(expires), 400, "invalid_request", "expires_at must be epoch milliseconds");
    const prior = ot.get<any>("SELECT owner_id FROM ot_public_shares WHERE token_hash = ?", b.token_hash);
    assert(!prior || prior.owner_id === me.ownerId, 409, "conflict", "share already exists");
    const now = ot.now();
    ot.run(`INSERT INTO ot_public_shares(token_hash, owner_id, ref, title, kind, body, expires_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(token_hash) DO UPDATE SET title = excluded.title, kind = excluded.kind, body = excluded.body, expires_at = excluded.expires_at, revoked = 0, updated_at = excluded.updated_at`,
      b.token_hash, me.ownerId, b.ref, title, kind, String(b.body ?? ""), expires, now, now);
    return { published: true };
  });
  app.delete("/v1/ot/public-shares/:hash", async (req) => {
    const me = ot.me(req);
    const r = ot.run("UPDATE ot_public_shares SET revoked = 1, updated_at = ? WHERE token_hash = ? AND owner_id = ?", ot.now(), String(params(req).hash), me.ownerId);
    assert(r.changes === 1, 404, "share_not_found", "no such share of yours");
    return { revoked: true };
  });
  app.get("/v1/ot/public-shares/:hash", async (req, reply) => {
    const me = ot.me(req);
    const hash = String(params(req).hash);
    assert(HASH.test(hash) && ot.get(`SELECT 1 FROM ot_public_shares
      WHERE token_hash=? AND owner_id=? AND revoked=0 AND (expires_at IS NULL OR expires_at>?)`,
      hash, me.ownerId, ot.now()), 404, "share_not_found", "share is unavailable");
    reply.header("Cache-Control", "private, no-store");
    return { active: true };
  });
  app.post("/v1/ot/public-shares/resolve", async (req, reply) => {
    ot.me(req);
    const row = visibleShare(body(req).token);
    assert(row && copyable(row), 404, "share_not_found", "share is unavailable");
    reply.header("Cache-Control", "no-store");
    return {title:row.title, body:row.body};
  });
  app.get("/share/:token", async (req, reply) => {
    const token = String(params(req).token);
    const notFound = () => reply.status(404).type("text/html; charset=utf-8").header("Cache-Control", "no-store").send("<!DOCTYPE html><meta charset=utf-8><title>链接不可用</title><p>这个分享链接不存在、已过期或已被撤销。</p>");
    const row = visibleShare(token);
    if (!row) return notFound();
    const esc = (v: string) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
    reply.header("Content-Type", "text/html; charset=utf-8");
    reply.header("Cache-Control", "no-store");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("X-Robots-Tag", "noindex");
    reply.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    return reply.send(`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(row.title)} · FlyBot</title>
<style>body{font-family:system-ui,sans-serif;max-width:46rem;margin:2rem auto;padding:0 1rem;line-height:1.6;color:#1a1a1a}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}.meta{color:#666;font-size:.9rem}.copy{display:inline-block;padding:.45rem .9rem;border:1px solid #2b6b49;border-radius:.5rem;color:#21573a}</style></head>
<body><p class="meta">只读分享 · ${esc(ot.profileView(row.owner_id).display_name || "")}</p><h1>${esc(row.title)}</h1>${copyable(row) ? `<a class="copy" href="/space#shared-work=${token}">保存文字副本</a>` : ""}<pre>${esc(row.body)}</pre></body></html>`);
  });
}
