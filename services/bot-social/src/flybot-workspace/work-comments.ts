// Shared comments on published Discover works. Private work data stays in its DS-Bot.
import type { FastifyInstance, FastifyRequest } from "fastify";
import { assert } from "../errors.js";
import { newId } from "../ids.js";
import { body, hashCode, intParam, one, params, query, text, type OtContext } from "./core.js";

export const WORK_COMMENTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS ot_work_comments (
  id TEXT PRIMARY KEY, listing_id TEXT NOT NULL REFERENCES ot_listings(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES ot_work_comments(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES owners(id), body TEXT NOT NULL,
  client_key TEXT NOT NULL, fingerprint TEXT NOT NULL, created_at INTEGER NOT NULL,
  removed INTEGER NOT NULL DEFAULT 0,
  UNIQUE(listing_id, owner_id, client_key)
);
CREATE INDEX IF NOT EXISTS ot_work_comments_page ON ot_work_comments(listing_id, parent_id, created_at, id);
CREATE INDEX IF NOT EXISTS ot_work_comments_visible ON ot_work_comments(listing_id, parent_id) WHERE removed = 0;
CREATE TABLE IF NOT EXISTS ot_work_comment_likes (
  comment_id TEXT NOT NULL REFERENCES ot_work_comments(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES owners(id), PRIMARY KEY(comment_id, owner_id)
);
`;

const COMMENT_ID = /^otwc_[0-9A-HJKMNP-TV-Z]{26}$/;
const COMMENT_CURSOR = /^([0-9]{1,16})\.(otwc_[0-9A-HJKMNP-TV-Z]{26})$/;
const CLIENT_KEY = /^[A-Za-z0-9._:-]{1,80}$/;

type Work = { id: string; owner_id: string };
type CommentRow = {
  id: string;
  parent_id: string | null;
  owner_id: string;
  body: string;
  removed: number;
  created_at: number;
  handle: string | null;
  display_name: string | null;
  reply_count: number;
  likes: number;
  liked: number;
};

const COMMENT_ROWS = `SELECT c.id, c.parent_id, c.owner_id, c.body, c.removed, c.created_at, p.handle, p.display_name,
  (SELECT COUNT(*) FROM ot_work_comments r WHERE r.listing_id = c.listing_id AND r.parent_id = c.id AND r.removed = 0) AS reply_count,
  (SELECT COUNT(*) FROM ot_work_comment_likes l WHERE l.comment_id = c.id) AS likes,
  EXISTS(SELECT 1 FROM ot_work_comment_likes l WHERE l.comment_id = c.id AND l.owner_id = ?) AS liked
  FROM ot_work_comments c LEFT JOIN ot_profiles p ON p.owner_id = c.owner_id`;

function visibleWork(ot: OtContext, slug: string) {
  const work = ot.get<Work>("SELECT id, owner_id FROM ot_listings WHERE slug = ? AND listed = 1 AND kind = 'work'", slug);
  assert(work, 404, "listing_not_found", "no such public work");
  return work;
}

export function workCommentCount(ot: OtContext, listingId: string) {
  return ot.get<{ count: number }>("SELECT COUNT(*) AS count FROM ot_work_comments WHERE listing_id = ? AND removed = 0", listingId)!.count;
}

function commentView(row: CommentRow, work: Work, viewer: string | null) {
  const removed = Boolean(row.removed);
  return {
    id: row.id, parent_id: row.parent_id, body: removed ? "" : row.body, created_at: row.created_at,
    author: removed ? null : { handle: row.handle ?? "", name: row.display_name || row.handle || "" },
    removed, reply_count: row.reply_count, likes: removed ? 0 : row.likes,
    ...(viewer === null ? {} : {
      mine: !removed && viewer === row.owner_id,
      can_remove: !removed && (viewer === row.owner_id || viewer === work.owner_id),
      liked: !removed && Boolean(row.liked),
    }),
  };
}

function requireComment(ot: OtContext, work: Work, id: string, viewer: string | null) {
  assert(COMMENT_ID.test(id), 404, "comment_not_found", "no such comment");
  const row = ot.get<CommentRow>(`${COMMENT_ROWS} WHERE c.listing_id = ? AND c.id = ?`, viewer, work.id, id);
  assert(row, 404, "comment_not_found", "no such comment");
  return row;
}

export function workCommentsPage(ot: OtContext, work: Work, viewer: string | null, input: Record<string, unknown> = {}) {
  assert(Object.keys(input).every(key => key === "parent_id" || key === "cursor" || key === "limit"),
    400, "invalid_request", "unknown comment filter");
  const parent = one(input.parent_id, "parent_id") ?? null;
  const cursor = one(input.cursor, "cursor");
  const limit = intParam(input.limit, "limit", 20, 50);
  assert(limit > 0, 400, "invalid_request", "limit must be positive");
  if (parent !== null) {
    const root = requireComment(ot, work, parent, viewer);
    assert(root.parent_id === null && (!root.removed || root.reply_count > 0),
      404, "comment_not_found", "no such comment thread");
  }

  const direction = parent === null ? "DESC" : "ASC";
  const after = parent === null ? "<" : ">";
  const filters = ["c.listing_id = ?", "c.parent_id IS ?", parent === null
    ? `(c.removed = 0 OR EXISTS(SELECT 1 FROM ot_work_comments r
      WHERE r.listing_id = c.listing_id AND r.parent_id = c.id AND r.removed = 0))`
    : "c.removed = 0"];
  const args: unknown[] = [viewer, work.id, parent];
  if (cursor !== undefined) {
    const match = COMMENT_CURSOR.exec(cursor);
    assert(match && Number.isSafeInteger(Number(match[1])), 400, "invalid_request", "invalid comment cursor");
    filters.push(`(c.created_at, c.id) ${after} (?, ?)`);
    args.push(Number(match[1]), match[2]);
  }

  const rows = ot.all<CommentRow>(`${COMMENT_ROWS} WHERE ${filters.join(" AND ")}
    ORDER BY c.created_at ${direction}, c.id ${direction} LIMIT ?`, ...args, limit + 1);
  const last = rows[limit - 1];
  return {
    items: rows.slice(0, limit).map(row => commentView(row, work, viewer)),
    cursor: rows.length > limit ? `${last.created_at}.${last.id}` : null,
    comment_count: workCommentCount(ot, work.id),
  };
}

function postComment(ot: OtContext, work: Work, viewer: string, input: Record<string, unknown>) {
  assert(input && typeof input === "object" && !Array.isArray(input) &&
    Object.keys(input).every(key => key === "body" || key === "parent_id" || key === "client_key"),
  400, "invalid_request", "invalid comment fields");
  assert(typeof input.body === "string", 400, "invalid_request", "body must be a string");
  const message = text(input.body.trim(), "body", { min: 1, max: 2000, multiline: true });
  const parent = input.parent_id ?? null;
  assert(parent === null || (typeof parent === "string" && COMMENT_ID.test(parent)), 400, "invalid_request", "invalid parent comment");
  const key = input.client_key;
  assert(typeof key === "string" && CLIENT_KEY.test(key), 400, "invalid_request", "invalid client key");
  const fingerprint = hashCode(JSON.stringify([parent, message]));
  const prior = ot.get<{ id: string; fingerprint: string }>(
    "SELECT id, fingerprint FROM ot_work_comments WHERE listing_id = ? AND owner_id = ? AND client_key = ?", work.id, viewer, key,
  );
  if (prior) {
    assert(prior.fingerprint === fingerprint, 409, "conflict", "client key already used for a different comment");
    return { row: requireComment(ot, work, prior.id, viewer), created: false };
  }
  if (parent !== null) {
    const root = requireComment(ot, work, parent, viewer);
    assert(root.parent_id === null, 400, "invalid_request", "a reply must target a top-level comment");
    assert(!root.removed, 404, "comment_not_found", "no such comment");
  }
  const id = newId("otwc");
  ot.run(`INSERT INTO ot_work_comments(id, listing_id, parent_id, owner_id, body, client_key, fingerprint, created_at)
    VALUES(?,?,?,?,?,?,?,?)`, id, work.id, parent, viewer, message, key, fingerprint, ot.now());
  return { row: requireComment(ot, work, id, viewer), created: true };
}

export function registerWorkComments(app: FastifyInstance, ot: OtContext) {
  const path = "/v1/ot/discover/:slug/comments";
  const commentsFor = (req: FastifyRequest, viewer: string | null) =>
    workCommentsPage(ot, visibleWork(ot, params(req).slug), viewer, query(req));
  app.get(path, async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    return commentsFor(req, ot.me(req).ownerId);
  });
  app.get("/w/:slug/comments", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    return commentsFor(req, null);
  });
  app.post(path, async (req, reply) => {
    const viewer = ot.me(req).ownerId;
    const result = ot.tx(() => {
      const work = visibleWork(ot, params(req).slug);
      const { row, created } = postComment(ot, work, viewer, body(req));
      return {created, data: {
        comment: commentView(row, work, viewer), comment_count: workCommentCount(ot, work.id),
        ...(row.parent_id ? {parent_reply_count: requireComment(ot, work, row.parent_id, viewer).reply_count} : {}),
        ...(created ? {} : {replayed: true}),
      }};
    });
    return reply.status(result.created ? 201 : 200).send(result.data);
  });
  app.post(path + "/:id/like", async req => {
    const viewer = ot.me(req).ownerId;
    const { enabled } = body(req);
    assert(typeof enabled === "boolean", 400, "invalid_request", "enabled must be a boolean");
    return ot.tx(() => {
      const work = visibleWork(ot, params(req).slug);
      const row = requireComment(ot, work, params(req).id, viewer);
      assert(!row.removed, 404, "comment_not_found", "no such comment");
      if (enabled) ot.run("INSERT OR IGNORE INTO ot_work_comment_likes(comment_id, owner_id) VALUES(?,?)", row.id, viewer);
      else ot.run("DELETE FROM ot_work_comment_likes WHERE comment_id = ? AND owner_id = ?", row.id, viewer);
      return { comment: commentView(requireComment(ot, work, row.id, viewer), work, viewer) };
    });
  });
  app.post(path + "/:id/remove", async req => {
    const viewer = ot.me(req).ownerId;
    return ot.tx(() => {
      const work = visibleWork(ot, params(req).slug);
      const row = requireComment(ot, work, params(req).id, viewer);
      assert(viewer === row.owner_id || viewer === work.owner_id, 403, "forbidden", "only the comment or work author can remove it");
      if (!row.removed) {
        ot.run("UPDATE ot_work_comments SET removed = 1, body = '' WHERE id = ?", row.id);
        ot.run("DELETE FROM ot_work_comment_likes WHERE comment_id = ?", row.id);
      }
      return {comment_count: workCommentCount(ot, work.id)};
    });
  });
}
