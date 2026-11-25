import assert from "node:assert/strict";
import { test } from "node:test";
import { expectApiError, friends, startServer } from "./helpers.js";

// `structured` is the machine-readable half of a message: a schema name and a few fields, not a document. It is a
// contract between two Bots, so the platform bounds it by size the way it bounds a file by bytes -- a 400 for a value
// that is not an object, and the 413 class (with `size_bytes` / `limit_bytes`, as `attachment_storage_full` already
// answers) for one that serializes past 32 KiB. Anything bigger belongs in an attachment, which has its own limits.
//
// The bound has to hold on both doors that can introduce the field: the draft a Bot signs and the edit an owner
// makes on a held line. A refused draft writes nothing at all -- no message, no card, no event, no audit line -- and
// spends none of the Bot's hourly draft budget, so a caller cannot probe the limit for free.

const SIZE_LIMIT = 32768;
/** A JSON object whose serialized form is exactly `n` bytes: `{"pad":"…"}`, the wrapper is 10 bytes. */
const sized = (n: number) => ({ pad: "x".repeat(n - 10) });
const PROPOSAL = {
  schema: "meeting.proposal/1",
  duration_minutes: 30,
  slots: [
    { start: "2026-11-10T02:00:00.000Z", end: "2026-11-10T02:30:00.000Z" },
    { start: "2026-11-10T05:00:00.000Z", end: "2026-11-10T05:30:00.000Z" },
    { start: "2026-11-11T02:00:00.000Z", end: "2026-11-11T02:30:00.000Z" },
  ],
  modality: "video",
};

/** Two friends that may chat either way, one open conversation, A's Bot drafts into it. */
async function pair(t: any) {
  const s = await startServer();
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  const conv = await A.bot.startConversation(B.bot.id, { type: "general_chat", summary: "structured cap" });
  const cid = conv.conversation_id as string;
  const draft = (payload: any = { text: "draft text" }) =>
    A.bot.req("POST", `/v1/conversations/${cid}/messages`, A.bot.envelope("message.draft", payload, { conversation_id: cid })) as Promise<any>;
  const decide = (aprId: string, body: any) => A.owner.req("POST", `/v1/approvals/${aprId}/decision`, body);
  const count = (table: string) => (s.platform.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as any).n as number;
  const audit = () => (s.platform.audit as any).countFor(A.owner_id) as number;
  const row = (sql: string, ...args: any[]) => s.platform.db.prepare(sql).get(...args) as any;
  return { s, A, B, cid, draft, decide, count, audit, row };
}

test("a: structured on the draft door must be an object or null", async (t) => {
  const h = await pair(t);
  // Everything a JSON body can carry besides an object: each is refused with the edit door's own wording.
  const cases: Array<[string, unknown]> = [["string", "oops"], ["number", 7], ["boolean", true], ["array", [{ a: 1 }]]];
  for (const [label, structured] of cases) {
    const err = await expectApiError(h.draft({ text: `a ${label}`, structured }), 400, "invalid_request");
    assert.match(err.message, /payload\.structured must be an object or null/, label);
  }
});

test("b: a structured payload past 32 KiB is refused with its size and the limit", async (t) => {
  const h = await pair(t);
  const err = await expectApiError(h.draft({ text: "too big", structured: sized(SIZE_LIMIT + 1) }), 413, "structured_too_large");
  const body = (err as any).body?.error ?? {};
  assert.equal(body.size_bytes, SIZE_LIMIT + 1, "the caller is told how big its payload was");
  assert.equal(body.limit_bytes, SIZE_LIMIT, "and what the limit is");
  assert.match(String(err.message), /32768/, "the message names the limit");
  assert.match(String(err.message), /attachment/i, "and the way out: larger payloads belong in an attachment");
});

test("c: a refused draft writes nothing and spends no draft budget", async (t) => {
  const h = await pair(t);
  const before = {
    messages: h.count("messages"),
    approvals: h.count("approvals"),
    events: h.count("events"),
    audit: h.audit(),
  };
  const turn = h.row("SELECT turn_count FROM conversations WHERE id = ?", h.cid).turn_count;
  await expectApiError(h.draft({ text: "bad shape", structured: "oops" }), 400, "invalid_request");
  await expectApiError(h.draft({ text: "too big", structured: sized(SIZE_LIMIT + 1) }), 413, "structured_too_large");
  assert.equal(h.count("messages"), before.messages, "no message row");
  assert.equal(h.count("approvals"), before.approvals, "no approval card");
  assert.equal(h.count("events"), before.events, "no event");
  assert.equal(h.audit(), before.audit, "no audit line");
  assert.equal(h.row("SELECT turn_count FROM conversations WHERE id = ?", h.cid).turn_count, turn, "the conversation did not move");

  // The budget is the messages it wrote in the last hour, so nothing was spent and the next legal draft goes through.
  const ok = await h.draft({ text: "the first real draft", structured: PROPOSAL });
  assert.equal(ok.status, "pending_approval");
});

test("d: exactly 32 KiB, null and absent stay legal and take the normal approval path", async (t) => {
  const h = await pair(t);
  const atLimit = await h.draft({ text: "at the limit", structured: sized(SIZE_LIMIT) });
  assert.equal(atLimit.status, "pending_approval");
  assert.equal(atLimit.approval_id !== undefined, true, "a held line carries its card");
  assert.equal(h.row("SELECT status FROM approvals WHERE id = ?", atLimit.approval_id).status, "pending", "and the card waits for the owner");

  const cleared = await h.draft({ text: "explicit null", structured: null });
  assert.equal(cleared.status, "pending_approval");
  const absent = await h.draft({ text: "no structured at all" });
  assert.equal(absent.status, "pending_approval");

  // The repo's own typed shape is the case the limit is sized for, not the case it is sized against.
  const proposal = await h.draft({ text: "Does Wednesday work?", structured: PROPOSAL });
  assert.equal(proposal.status, "pending_approval");
  // The repo's own meeting.proposal/1 with demo's three slots is 292 bytes: the limit is for a contract, not a document.
  assert.equal(Buffer.byteLength(JSON.stringify(PROPOSAL), "utf8"), 292);
});

test("e: the owner's edit door refuses the same oversize and writes nothing", async (t) => {
  const h = await pair(t);
  const d = await h.draft({ text: "held line", structured: PROPOSAL });
  const before = {
    messages: h.count("messages"),
    approvals: h.count("approvals"),
    events: h.count("events"),
    audit: h.audit(),
  };
  const err = await expectApiError(
    h.decide(d.approval_id, { decision: "approved_with_edits", edited_payload: { text: "edited", structured: sized(SIZE_LIMIT + 1) } }),
    413, "structured_too_large",
  );
  const body = (err as any).body?.error ?? {};
  assert.equal(body.size_bytes, SIZE_LIMIT + 1);
  assert.equal(body.limit_bytes, SIZE_LIMIT);
  assert.equal(h.row("SELECT status FROM approvals WHERE id = ?", d.approval_id).status, "pending", "the card stays pending");
  assert.equal(h.row("SELECT status FROM messages WHERE id = ?", d.message_id).status, "pending_approval", "the line stays held");
  assert.equal(h.count("messages"), before.messages, "no row written");
  assert.equal(h.count("approvals"), before.approvals);
  assert.equal(h.count("events"), before.events, "the peer hears nothing");
  assert.equal(h.audit(), before.audit, "no audit line");

  // The edit door keeps its own wording for a value that is not an object at all.
  const shape = await expectApiError(
    h.decide(d.approval_id, { decision: "approved_with_edits", edited_payload: { text: "edited", structured: "oops" } }),
    400, "invalid_request",
  );
  assert.match(shape.message, /edited_payload\.structured must be an object or null/);
  assert.equal(h.row("SELECT status FROM approvals WHERE id = ?", d.approval_id).status, "pending");
});
