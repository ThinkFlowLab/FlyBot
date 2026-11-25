import type { FastifyInstance } from "fastify";
import { assert } from "../errors.js";
import { newId } from "../ids.js";
import { body, handleKey, OtContext, params, query } from "./core.js";

export const CONTACTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS ot_contacts (
  id TEXT PRIMARY KEY, owner_a TEXT NOT NULL REFERENCES ot_profiles(owner_id),
  owner_b TEXT NOT NULL REFERENCES ot_profiles(owner_id), requested_by TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','accepted','declined','removed')),
  requested_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(owner_a, owner_b)
);
CREATE INDEX IF NOT EXISTS ot_contacts_owner_b ON ot_contacts(owner_b);
CREATE INDEX IF NOT EXISTS ot_contacts_requests ON ot_contacts(requested_by, requested_at);
`;

const HOUR = 3_600_000;
const REQUEST_LIMIT = 20;
const HANDLE = /^[a-z0-9][a-z0-9._-]{1,71}$/;

type Contact = {
  id: string; owner_a: string; owner_b: string; requested_by: string;
  status: "pending" | "accepted" | "declined" | "removed"; updated_at: number;
};
const otherOwner = (row: Contact, owner: string) => row.owner_a === owner ? row.owner_b : row.owner_a;

function profile(ot: OtContext, owner: string) {
  const {handle, display_name} = ot.profileView(owner);
  return {handle, display_name};
}

function peerByHandle(ot: OtContext, input: unknown, owner: string) {
  assert(typeof input === "string" && HANDLE.test(handleKey(input)), 400, "invalid_handle", "请输入对方的完整用户名。");
  const peer = ot.ownerByHandle(input);
  assert(peer !== owner, 400, "self_contact", "请选择其他联系人。");
  return peer;
}

function view(ot: OtContext, row: Contact, owner: string) {
  return {
    id: row.id, status: row.status, incoming: row.requested_by !== owner,
    peer: profile(ot, otherOwner(row, owner)),
  };
}

export function acceptedContact(ot: OtContext, owner: string, peer: string) {
  return Boolean(ot.get("SELECT 1 FROM ot_contacts WHERE owner_a=? AND owner_b=? AND status='accepted'", ...[owner, peer].sort()));
}

export function registerContacts(app: FastifyInstance, ot: OtContext) {
  const root = "/v1/ot/contacts";
  app.get(root, async req => {
    const {ownerId} = ot.me(req);
    const rows = ot.all<Contact>(`SELECT * FROM ot_contacts WHERE (owner_a=? OR owner_b=?)
      AND status IN ('accepted','pending') ORDER BY updated_at DESC,id`, ownerId, ownerId);
    return {items: rows.map(row => view(ot, row, ownerId))};
  });
  app.get(root + "/lookup", async req => {
    const {ownerId} = ot.me(req);
    const peer = peerByHandle(ot, query(req).handle, ownerId);
    const match = ot.get<Contact>(`SELECT * FROM ot_contacts WHERE owner_a=? AND owner_b=?
      AND status IN ('accepted','pending')`, ...[ownerId, peer].sort());
    return {peer: profile(ot, peer), relationship: match
      ? {id: match.id, status: match.status, incoming: match.requested_by !== ownerId}
      : null};
  });
  app.post(root, async req => {
    const {ownerId} = ot.me(req);
    const peer = peerByHandle(ot, body(req).handle, ownerId);
    const pair = [ownerId, peer].sort();
    return ot.tx(() => {
      const prior = ot.get<Contact>("SELECT * FROM ot_contacts WHERE owner_a=? AND owner_b=?", ...pair);
      if (prior?.status === "pending" || prior?.status === "accepted") return view(ot, prior, ownerId);
      const now = ot.now();
      assert(!prior || now - prior.updated_at >= HOUR * 24, 429, "contact_retry_later", "请于 24 小时后重试。");
      const recent = ot.get<{n:number}>("SELECT COUNT(*) AS n FROM ot_contacts WHERE requested_by=? AND requested_at>?", ownerId, now - HOUR);
      assert((recent?.n ?? 0) < REQUEST_LIMIT, 429, "contact_request_limit", "申请过于频繁，请稍后重试。");
      const id = prior?.id || newId("otcpt");
      ot.run(`INSERT INTO ot_contacts(id,owner_a,owner_b,requested_by,status,requested_at,updated_at)
        VALUES (?,?,?,?,'pending',?,?) ON CONFLICT(owner_a,owner_b) DO UPDATE SET
        status='pending', requested_by=excluded.requested_by, requested_at=excluded.requested_at, updated_at=excluded.updated_at`,
      id, ...pair, ownerId, now, now);
      return view(ot, ot.get<Contact>("SELECT * FROM ot_contacts WHERE id=?", id)!, ownerId);
    });
  });
  app.post(root + "/:id", async req => {
    const {ownerId} = ot.me(req);
    const {action} = body(req);
    return ot.tx(() => {
      const row = ot.get<Contact>("SELECT * FROM ot_contacts WHERE id=? AND (owner_a=? OR owner_b=?)", params(req).id, ownerId, ownerId);
      assert(row, 404, "contact_not_found", "没有找到联系人。");
      const incoming = row.requested_by !== ownerId;
      let status: Contact["status"];
      if ((action === "accept" || action === "decline") && row.status === "pending" && incoming) {
        status = action === "accept" ? "accepted" : "declined";
      } else if ((action === "remove" && row.status === "accepted") || (action === "cancel" && row.status === "pending" && !incoming)) {
        status = "removed";
      } else {
        assert(false, 409, "contact_state_changed", "联系人状态已更新，请刷新后重试。");
      }
      ot.run("UPDATE ot_contacts SET status=?,updated_at=? WHERE id=?", status, ot.now(), row.id);
      return view(ot, {...row, status}, ownerId);
    });
  });
}
