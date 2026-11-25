import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_ATTACHMENT_LIMITS } from "../src/attachments.js";
import { ownerWithBot, startServer } from "./helpers.js";

// An owner sits behind every upload, and the per-file / per-message / TTL limits say nothing about how many bytes
// one owner may keep. Every uploaded byte is sealed into SQLite, so one owner token (or a leaked bot key, or a
// runaway routine) could write gigabytes until the disk — not the upload — fails. The budget is the owner-level
// ceiling: summed over that owner's stored rows, checked before anything is written.

const b64 = (n: number) => Buffer.alloc(n, "a").toString("base64");

async function upload(base: string, token: string, botId: string, bytes: number) {
  const r = await fetch(base + "/v1/attachments", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ bot_id: botId, name: "note.txt", mime: "text/plain", content_base64: b64(bytes) }),
  });
  return { status: r.status, body: await r.json() as any };
}

const stored = (s: any) => s.platform.db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(size),0) AS used FROM attachments").get();

test("the default owner budget exists and is larger than one file", () => {
  assert.ok(Number.isInteger(DEFAULT_ATTACHMENT_LIMITS.ownerBudgetBytes), "the limits object carries an owner budget");
  assert.equal(DEFAULT_ATTACHMENT_LIMITS.ownerBudgetBytes, 512 * 1024 * 1024, "512 MiB = 25 files of 20 MB");
  assert.ok(DEFAULT_ATTACHMENT_LIMITS.ownerBudgetBytes > DEFAULT_ATTACHMENT_LIMITS.maxBytes, "the ceiling is above one file");
});

test("an upload over the owner's budget is refused whole, and the ceiling does not lock the door", async (t) => {
  const s = await startServer({ attachments: { maxBytes: 1024, ownerBudgetBytes: 1500 } });
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");

  const first = await upload(s.base, A.owner.token, A.bot.id, 1000);
  assert.equal(first.status, 201);

  const second = await upload(s.base, A.owner.token, A.bot.id, 1000);
  assert.equal(second.status, 413, "1000 + 1000 is over the 1500-byte budget");
  assert.equal(second.body.error.code, "attachment_storage_full");
  assert.equal(second.body.error.used_bytes, 1000);
  assert.equal(second.body.error.limit_bytes, 1500);
  assert.deepEqual(stored(s), { n: 1, used: 1000 }, "the refused upload stored no bytes");

  // The refusal is a ceiling, not a lock: a file that still fits goes through after it.
  const fits = await upload(s.base, A.owner.token, A.bot.id, 400);
  assert.equal(fits.status, 201);
  assert.deepEqual(stored(s), { n: 2, used: 1400 });

  // 1400 + 400 is over again, and this refusal stores nothing either.
  const over = await upload(s.base, A.owner.token, A.bot.id, 400);
  assert.equal(over.status, 413);
  assert.equal(over.body.error.used_bytes, 1400);
  assert.deepEqual(stored(s), { n: 2, used: 1400 }, "the second refusal stored no bytes");
});

test("the budget is per owner: another owner's uploads are untouched", async (t) => {
  const s = await startServer({ attachments: { maxBytes: 1024, ownerBudgetBytes: 1500 } });
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const B = await ownerWithBot(s.base, "ben");

  assert.equal((await upload(s.base, A.owner.token, A.bot.id, 1000)).status, 201);

  const other = await upload(s.base, B.owner.token, B.bot.id, 1000);
  assert.equal(other.status, 201, "B has its own ceiling");
  assert.equal(other.body.limits.used_bytes, 1000, "B sees only B's bytes");

  const aOver = await upload(s.base, A.owner.token, A.bot.id, 1000);
  assert.equal(aOver.status, 413, "A is still over A's own budget");
  assert.equal(aOver.body.error.used_bytes, 1000);
  assert.equal(aOver.body.error.limit_bytes, 1500);

  const bFits = await upload(s.base, B.owner.token, B.bot.id, 400);
  assert.equal(bFits.status, 201, "B's ceiling is not moved by A's refusal");
});

test("a successful upload echoes the owner's used bytes in its limits", async (t) => {
  const s = await startServer({ attachments: { maxBytes: 1024, ownerBudgetBytes: 1500 } });
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");

  const one = await upload(s.base, A.owner.token, A.bot.id, 600);
  assert.equal(one.status, 201);
  assert.equal(one.body.limits.used_bytes, 600);
  assert.equal(one.body.limits.ownerBudgetBytes, 1500, "the echoed limits carry the ceiling too");

  const two = await upload(s.base, A.owner.token, A.bot.id, 300);
  assert.equal(two.status, 201);
  assert.equal(two.body.limits.used_bytes, 900, "the echo is the running total, not the file's size");
});
