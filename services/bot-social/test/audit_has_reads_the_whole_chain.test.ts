// "Was this already written?" is a question about the whole chain, not about the newest page.
//
// `AuditLog.list` answers a page: the newest N records (default 1000) in ascending order, which is what the console,
// `botctl` and the audit export read. Asking it whether a particular record exists therefore answers "not in the
// newest 1000" for anything older, and a caller that skipped a write on that answer would repeat a line that is
// already in the chain. The sweep that records an expired file is such a caller: it writes `attachment.expired`
// before the DELETE it describes, so a failed DELETE leaves the row standing with its line already written, and the
// next sweep must not write that line a second time — the row it asks about can be older than any page.
//
// `has(action, subject)` reads the table for the question itself, so the answer is the same at any chain length.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AuditLog } from "../src/audit.js";

test("a record older than the read page is still found by `has`, and the page is what misses it", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "audit-has-"));
  const log = new AuditLog(path.join(dir, "audit.db"));
  try {
    log.append("platform", "attachment.expired", "att-old", ["owner-a"], {});
    // Push it out of the default page: 1000 newer records, so `list()` holds seq 2..1001 and not seq 1.
    for (let i = 0; i < 1000; i++) log.append("platform", "filler.written", `att-${i}`, ["owner-a"], {});
    assert.equal(log.list().some((r) => r.subject === "att-old"), false, "the newest page no longer carries the first record");
    assert.equal(log.has("attachment.expired", "att-old"), true, "the whole chain still carries it");

    // The question is exact on both fields: a different action or a different subject is a different record.
    assert.equal(log.has("attachment.uploaded", "att-old"), false);
    assert.equal(log.has("attachment.expired", "att-never"), false);
  } finally {
    log.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
