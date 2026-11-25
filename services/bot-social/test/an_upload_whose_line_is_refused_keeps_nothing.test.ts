/**
 * An upload whose audit line is refused keeps nothing.
 *
 * `uploadAttachment` stores the row and charges the owner's budget inside one transaction, then appends
 * `attachment.uploaded` to the audit store -- a second SQLite file that can refuse the line (its disk full, a
 * governance trigger). The refusal used to reach the caller alone: `POST /v1/attachments` answered `500
 * internal_error` while the row stayed stored and the owner's `used_bytes` stayed charged. No door removes a
 * stored file, so the orphan was permanent, it counted against the budget (a refused 144-byte upload made the
 * next legitimate 100-byte upload answer `413 attachment_storage_full`), and a Bot token could never learn the
 * id of the file it had stored.
 *
 * The end state of a refused line must equal the end state of a refused upload: no `attachments` row, no charge
 * against the owner's `used_bytes`, the `500` body carrying no budget figures. The line must also still never
 * name a row that was never stored, and a successful upload keeps exactly one `attachment.uploaded` line so
 * `audit.verify()` and the expired-file line still read a beginning and an end. The sweep and the read door keep
 * the #764 behaviour.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ownerWithBot, startServer } from "./helpers.js";

const b64 = (n: number) => Buffer.alloc(n, 97).toString("base64");

type S = Awaited<ReturnType<typeof startServer>>;

/** One upload, over HTTP, answered exactly as a caller sees it. */
async function upload(base: string, token: string, botId: string, bytes: number) {
  const r = await fetch(base + "/v1/attachments", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ bot_id: botId, name: "note.txt", mime: "text/plain", content_base64: b64(bytes) }),
  });
  return { status: r.status, body: (await r.json()) as any };
}

const stored = (s: S) => s.platform.db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(size),0) AS used FROM attachments").get() as any;
const usedBy = (s: S, ownerId: string) =>
  (s.platform.db.prepare("SELECT COALESCE(SUM(size),0) AS used FROM attachments WHERE owner_id = ?").get(ownerId) as any).used as number;
const uploadedLines = (s: S) => (s.platform.audit.db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'attachment.uploaded'").get() as any).n as number;

/** Refuse the audit store's insert of one action (or every insert, when no action is given). */
function refuseAuditLine(s: S, action?: string) {
  s.platform.audit.db.exec(`CREATE TEMP TRIGGER refuse_audit_line BEFORE INSERT ON audit_events ${action ? `WHEN NEW.action = '${action}'` : ""} BEGIN SELECT RAISE(ABORT, 'audit store refuses this line'); END`);
}

/** Refuse the store's attachment insert, the way a full disk or a trigger would. */
function refuseAttachmentRow(s: S) {
  s.platform.db.exec("CREATE TEMP TRIGGER refuse_attachment_row BEFORE INSERT ON attachments BEGIN SELECT RAISE(ABORT, 'store refuses this row'); END");
}

test("a refused audit line leaves no row, no charge and no budget figure in the 500", async (t) => {
  const s = await startServer({ attachments: { maxBytes: 1024, ownerBudgetBytes: 1500 } });
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const B = await ownerWithBot(s.base, "ben");

  refuseAuditLine(s, "attachment.uploaded");
  for (const who of [A, B]) {
    const r = await upload(s.base, who.owner.token, who.bot.id, 144);
    assert.equal(r.status, 500, "the caller is still answered the server error it was answered before");
    assert.equal(r.body.error.code, "internal_error");
    assert.equal(r.body.error.used_bytes, undefined, "a file the caller does not have carries no budget figure");
    assert.equal(r.body.error.limit_bytes, undefined, "nor the ceiling");
    assert.doesNotMatch(JSON.stringify(r.body), /used_bytes|limit_bytes/, "no budget figure anywhere in the 500 body");
  }

  assert.deepEqual(stored(s), { n: 0, used: 0 }, "the store keeps nothing for a line it refused");
  assert.equal(usedBy(s, A.owner_id), 0, "the first owner's budget is unchanged");
  assert.equal(usedBy(s, B.owner_id), 0, "and so is the second owner's");
  assert.equal(uploadedLines(s), 0, "no line was written");
});

test("a refused upload consumes no budget: the next legitimate upload still fits and answers 201", async (t) => {
  const s = await startServer({ attachments: { maxBytes: 1024, ownerBudgetBytes: 200 } });
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");

  refuseAuditLine(s, "attachment.uploaded");
  const refused = await upload(s.base, A.owner.token, A.bot.id, 144);
  assert.equal(refused.status, 500);
  assert.deepEqual(stored(s), { n: 0, used: 0 }, "the refused 144-byte upload charged nothing");

  // The refusal lifts; the budget is exactly what it was before the refused upload.
  s.platform.audit.db.exec("DROP TRIGGER refuse_audit_line");
  const fits = await upload(s.base, A.owner.token, A.bot.id, 100);
  assert.equal(fits.status, 201, "100 bytes still fit in the 200-byte budget");
  assert.equal(typeof fits.body.attachment.id, "string", "the caller learns the id of the file it stored");
  assert.equal(fits.body.limits.used_bytes, 100, "one charge, for the one file that was kept");
  assert.deepEqual(stored(s), { n: 1, used: 100 });
  assert.equal(uploadedLines(s), 1, "exactly one line, for the upload that succeeded");
});

test("a refused row never leaves a line naming it", async (t) => {
  const s = await startServer({ attachments: { maxBytes: 1024, ownerBudgetBytes: 1500 } });
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");

  refuseAttachmentRow(s);
  const r = await upload(s.base, A.owner.token, A.bot.id, 144);
  assert.equal(r.status, 500, "a store that refuses the row is still a server-side failure");
  assert.equal(uploadedLines(s), 0, "no line names a row that was never stored");
  assert.deepEqual(stored(s), { n: 0, used: 0 }, "the store keeps nothing");
  assert.equal(usedBy(s, A.owner_id), 0);
});

test("with no refusal an upload keeps one row, one charge and exactly one line", async (t) => {
  const s = await startServer({ attachments: { maxBytes: 1024, ownerBudgetBytes: 1500 } });
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");

  const r = await upload(s.base, A.owner.token, A.bot.id, 100);
  assert.equal(r.status, 201);
  const id = r.body.attachment.id as string;
  assert.equal(r.body.limits.used_bytes, 100, "the budget the caller reads is the one that was charged");
  assert.deepEqual(stored(s), { n: 1, used: 100 });
  assert.equal(uploadedLines(s), 1, "the successful path keeps its line, exactly once");
  assert.equal((s.platform.audit.db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'attachment.uploaded' AND subject = ?").get(id) as any).n, 1, "the line names the row it describes");
  assert.equal(s.platform.audit.verify().ok, true, "the chain still verifies");
});

test("the read door is unchanged: it lists what is stored, and still fails when the sweep's line is refused", async (t) => {
  const s = await startServer({ attachments: { maxBytes: 1024, ownerBudgetBytes: 1500 } });
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");

  const up = await upload(s.base, A.owner.token, A.bot.id, 100);
  assert.equal(up.status, 201);
  const id = up.body.attachment.id as string;

  const list = await fetch(s.base + "/v1/attachments", { headers: { authorization: `Bearer ${A.owner.token}` } });
  assert.equal(list.status, 200);
  const body: any = await list.json();
  assert.deepEqual(body.attachments.map((a: any) => a.id), [id], "the stored file is listed");
  assert.equal(body.used_bytes, 100, "and its bytes are the total");

  // #764's behaviour: a sweep whose `attachment.expired` line the store refuses is a server-side failure on the
  // read door, not a silent removal -- the file is still there and so is its charge.
  s.platform.db.prepare("UPDATE attachments SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 3600e3).toISOString(), id);
  refuseAuditLine(s, "attachment.expired");
  const refused = await fetch(s.base + "/v1/attachments", { headers: { authorization: `Bearer ${A.owner.token}` } });
  assert.equal(refused.status, 500, "the read door still answers 500 when the sweep cannot name the end it wrote");
  assert.deepEqual(stored(s), { n: 1, used: 100 }, "the file is not destroyed without its line");
});
