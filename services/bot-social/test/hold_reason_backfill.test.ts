import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.js";

const insert = (db: any, id: string, kind: string, hold: string | null) =>
  db.prepare("INSERT INTO approvals (id, owner_id, kind, subject_id, bot_id, conversation_id, summary, reasons, risk_flags, hold_reason, created_at, expires_at, note) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, "own_x", kind, `subj_${id}`, "bot_x", null, `card ${id}`, "[]", "[]", hold, new Date().toISOString(), new Date(Date.now() + 60_000).toISOString(), null);

const holdOf = (db: any, id: string) => (db.prepare("SELECT hold_reason FROM approvals WHERE id = ?").get(id) as any).hold_reason;

test("#54: face-room cards from the #51..#53 window are rewritten on open", (t) => {
  const path = join(mkdtempSync(join(tmpdir(), "bs-hold-backfill-")), "old.db");
  // The #51 shape: hold_reason exists, and a face-room card held only by the room's Auto-send switch was written as
  // `blanket_outbound`. The backfill runs on open, so inserting after the open leaves the row as it was.
  const first = openDb(path);
  insert(first, "apr_face", "face_room_message", "blanket_outbound");
  insert(first, "apr_risk", "face_room_message", "risk");
  first.close();

  // Reopening rewrites the old card; a stronger finding on a face-room card is never downgraded.
  const second = openDb(path);
  assert.equal(holdOf(second, "apr_face"), "face_room_auto_send_off", "a face-room card written before the split says why it waits");
  assert.equal(holdOf(second, "apr_risk"), "risk", "a stronger finding is never downgraded");
  second.close();

  // Opening again is a no-op: the statement matches nothing once the rows are rewritten (no one-shot flag involved).
  const third = openDb(path);
  t.after(() => third.close());
  assert.equal(holdOf(third, "apr_face"), "face_room_auto_send_off");
  assert.equal(holdOf(third, "apr_risk"), "risk");
});

test("#54: another kind keeps the owner's own blanket value", (t) => {
  const path = join(mkdtempSync(join(tmpdir(), "bs-hold-backfill-")), "old.db");
  const first = openDb(path);
  insert(first, "apr_chat", "outbound_message", "blanket_outbound");
  first.close();

  // The owner's blanket setting still applies to ordinary sends: the backfill is scoped to face-room cards only.
  const second = openDb(path);
  t.after(() => second.close());
  assert.equal(holdOf(second, "apr_chat"), "blanket_outbound");
});
