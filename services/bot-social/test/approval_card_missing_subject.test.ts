/**
 * #516: a card whose subject row was never written must not take the owner's whole list down.
 *
 * `approvalCard` reads the row each card points at. Three of those reads dereference the row without checking it —
 * `outbound_message` (messages), `relationship_request` (relationships) and `invite` (invites) — so one card left
 * behind by a torn write makes `GET /v1/approvals` answer `500 internal_error` for every card that owner owns. The
 * `action` branch already lists such a card without its detail (#509) and `face_room_message` did from the start.
 *
 * Two draft doors also wrote the card first and the row it points at second, with no transaction between them, so a
 * store-side refusal of the second statement left the card behind and nothing ever deletes it: `draftMessage` and
 * `draftFaceRoomMessage`. Both now write the pair as one write, and the decision door settles an orphan card by id
 * with a named `409 invalid_state` instead of a 500.
 *
 * Red first on c3f86c57: the list answers 500 with three orphan cards next to a real one; the orphan message and
 * relationship cards answer 500 to their decision; each refused draft leaves `approvals` 0 → 1.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { friends, inDays, startServer } from "./helpers.js";

const ownerOf = (A: any) => ({ kind: "owner" as const, ownerId: A.owner_id });
const count = (s: any, sql: string, ...args: unknown[]) => (s.platform.db.prepare(sql).get(...args) as any).n as number;
const meeting = () => ({
  type: "schedule_meeting", summary: "sync",
  params: { duration_minutes: 30, window: { start: inDays(1, 0), end: inDays(8, 23) } },
});

/** One orphan card of each of the three kinds, inserted directly — the state a torn write leaves behind. */
function insertOrphans(s: any, A: any) {
  const ins = s.platform.db.prepare(
    "INSERT INTO approvals (id, owner_id, kind, subject_id, bot_id, conversation_id, summary, reasons, risk_flags, hold_reason, created_at, expires_at, note) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
  );
  const now = new Date();
  const rows: [string, string, string][] = [
    ["apr_orphan_msg", "outbound_message", "msg_never_written"],
    ["apr_orphan_rel", "relationship_request", "rel_never_written"],
    ["apr_orphan_inv", "invite", "inv_never_written"],
  ];
  for (const [id, kind, subject] of rows) {
    ins.run(id, A.owner_id, kind, subject, A.bot.id, null, `orphan ${kind}`,
      JSON.stringify(["mvp.all_outbound_requires_approval"]), "[]", null,
      now.toISOString(), new Date(now.getTime() + 3600e3).toISOString(), null);
  }
  return rows.map(([id]) => id);
}

test("#516: one real card and three orphan cards still read as four cards, orphans without a detail", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  const cid = (await A.bot.startConversation(B.bot.id, meeting())).conversation_id as string;
  const draft: any = await A.bot.draftMessage(cid, { text: "the line that was really written" });
  assert.equal(draft.status, "pending_approval");
  const orphans = insertOrphans(s, A);

  const before = s.platform.db.prepare("SELECT id, status, decision FROM approvals WHERE owner_id = ? ORDER BY id").all(A.owner_id);
  const queue: any = await A.owner.req("GET", "/v1/approvals");
  assert.equal(queue.approvals.length, 4, "the owner's list answers 200 with every card it holds");
  const byId = new Map(queue.approvals.map((a: any) => [a.approval_id, a]));
  const real: any = byId.get(draft.approval_id);
  assert.equal(real.message.payload.text, "the line that was really written", "the real card keeps its full detail");
  for (const id of orphans) {
    const card: any = byId.get(id);
    assert.ok(card, `the orphan card ${id} is listed`);
    assert.equal(card.message, undefined, "an orphan message card carries no message detail");
    assert.equal(card.relationship, undefined, "an orphan relationship card carries no relationship detail");
    assert.equal(card.invite, undefined, "an orphan invite card carries no invite detail");
    assert.equal(card.status, "pending", "reading a card settles nothing");
  }

  // A second read is the same read: nothing was written by looking.
  await A.owner.req("GET", "/v1/approvals");
  assert.deepEqual(
    s.platform.db.prepare("SELECT id, status, decision FROM approvals WHERE owner_id = ? ORDER BY id").all(A.owner_id),
    before,
    "reading the list writes no approval row",
  );
});

test("#516: an orphan card is settled by id with a named 409 and reads cancelled", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A } = await friends(s.base);
  const orphans = insertOrphans(s, A);

  for (const id of orphans) {
    try {
      await A.owner.req("POST", `/v1/approvals/${id}/decision`, { decision: "approved" });
      assert.fail(`deciding the orphan card ${id} must be refused`);
    } catch (e: any) {
      assert.equal(e.status, 409, `orphan ${id} answers a named 409, not ${e.status}`);
      assert.equal(e.code, "invalid_state", `orphan ${id} names the state it is in`);
    }
  }

  const all: any = await A.owner.req("GET", "/v1/approvals?status=all");
  for (const id of orphans) {
    const card: any = all.approvals.find((a: any) => a.approval_id === id);
    assert.equal(card.status, "cancelled", `orphan ${id} is settled as cancelled`);
  }
  assert.equal(count(s, "SELECT COUNT(*) n FROM approvals WHERE owner_id = ? AND status = 'pending'", A.owner_id), 0,
    "no orphan card is left pending");
});

test("#516: a message draft whose messages row is refused leaves no card and no line", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  const cid = (await A.bot.startConversation(B.bot.id, meeting())).conversation_id as string;
  const before = {
    approvals: count(s, "SELECT COUNT(*) n FROM approvals WHERE owner_id = ?", A.owner_id),
    messages: count(s, "SELECT COUNT(*) n FROM messages WHERE conversation_id = ?", cid),
  };

  // The second statement of the door, refused: the state a store-side failure leaves.
  s.platform.db.exec("CREATE TRIGGER refuse_messages_insert BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'store refused the messages write'); END");

  await assert.rejects(
    A.bot.draftMessage(cid, { text: "a line whose row the store will not take" }),
    (e: any) => {
      assert.ok(e.status >= 500, `a refused messages write fails the draft, not answers ${e.status}`);
      return true;
    },
  );

  assert.deepEqual(
    {
      approvals: count(s, "SELECT COUNT(*) n FROM approvals WHERE owner_id = ?", A.owner_id),
      messages: count(s, "SELECT COUNT(*) n FROM messages WHERE conversation_id = ?", cid),
    },
    before,
    "the refused draft leaves no card and no message row",
  );
  const queue: any = await A.owner.req("GET", "/v1/approvals");
  assert.equal(queue.approvals.length, 0, "and the owner's queue reads with no card for that draft");
});

test("#516: a face-room draft whose face_room_drafts row is refused leaves no card and no draft", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  s.platform.enableCustody({ kind: "owner", ownerId: A.owner_id }, A.bot.id, { private_key_pem: A.kp.privateKeyPem });
  s.platform.enableCustody({ kind: "owner", ownerId: B.owner_id }, B.bot.id, { private_key_pem: B.kp.privateKeyPem });
  const join = async (who: typeof A) => {
    const r = await who.owner.req("POST", "/v1/face-rooms/join", { code: "626262", bots: [who.bot.id] });
    return r.room_id as string;
  };
  const roomId = await join(A);
  assert.equal(await join(B), roomId);
  const before = {
    approvals: count(s, "SELECT COUNT(*) n FROM approvals WHERE owner_id = ?", A.owner_id),
    drafts: count(s, "SELECT COUNT(*) n FROM face_room_drafts WHERE room_id = ?", roomId),
  };

  s.platform.db.exec("CREATE TRIGGER refuse_face_room_draft_insert BEFORE INSERT ON face_room_drafts BEGIN SELECT RAISE(ABORT, 'store refused the face_room_drafts write'); END");

  assert.throws(
    () => s.platform.draftFaceRoomMessage(ownerOf(A), roomId, { text: "a room line whose row the store will not take" }),
    (e: any) => {
      assert.ok(e.status === undefined || e.status >= 500, `a refused face_room_drafts write fails the draft, not answers ${e.status}`);
      return true;
    },
  );

  assert.deepEqual(
    {
      approvals: count(s, "SELECT COUNT(*) n FROM approvals WHERE owner_id = ?", A.owner_id),
      drafts: count(s, "SELECT COUNT(*) n FROM face_room_drafts WHERE room_id = ?", roomId),
    },
    before,
    "the refused draft leaves no card and no face-room draft row",
  );
  const queue: any = await A.owner.req("GET", "/v1/approvals");
  assert.equal(queue.approvals.length, 0, "and the owner's queue reads with no card for that draft");
});
