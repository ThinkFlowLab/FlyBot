// Write ordering in the audit log's own SQLite connection.
//
// `AuditLog.append` reads the chain head and then writes the next row in one transaction. Started as a deferred
// transaction, that pattern can upgrade to a write only if no other connection committed since the read; when one
// did, SQLite answers `SQLITE_BUSY_SNAPSHOT` at once (it never waits on the busy handler), the row is not written,
// and a caller that already committed its own business write is left with a 500 and a missing audit record.
//
// The first case reproduces that ordering deterministically: while one append is between its head read and its
// INSERT, a second connection appends. The second connection must be the one that waits, and both rows must land.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AuditLog } from "../src/audit.js";

function open(): { dir: string; log: AuditLog } {
  const dir = mkdtempSync(path.join(tmpdir(), "audit-append-"));
  return { dir, log: new AuditLog(path.join(dir, "audit.db")) };
}

test("an append that overlaps another writer lands, and the loser waits instead of failing", () => {
  const { dir, log: first } = open();
  const second = new AuditLog(path.join(dir, "audit.db"));
  // No busy handler on the contender: if the first append holds the write lock, the second is refused at once
  // rather than being silently retried for five seconds inside this test.
  second.db.pragma("busy_timeout = 0");
  let contenderRan = false;
  let contenderWaited = false;
  const readHead = first.head.bind(first);
  // Fire the other writer exactly where the race happens in production: after this append has read the head.
  first.head = () => {
    const head = readHead();
    if (!contenderRan) {
      contenderRan = true;
      try {
        second.append("probe", "other.writer", null, ["owner-probe"], {});
      } catch (e: any) {
        contenderWaited = true;
        assert.equal(e.code, "SQLITE_BUSY", `the contender must be refused by the lock, not by anything else: ${e.code} ${e.message}`);
      }
    }
    return head;
  };
  try {
    const rec = first.append("probe", "first.writer", null, ["owner-probe"], {});
    assert.equal(rec.seq, 1);
    assert.equal(contenderRan, true, "the overlapping writer ran while the first append was open");
    assert.equal(contenderWaited, true, "the overlapping append waited for the write lock instead of committing between the read and the write");
    // The contender retries and lands: both records are there, in one chain.
    const other = second.append("probe", "other.writer", null, ["owner-probe"], {});
    assert.equal(other.seq, 2);
    const rows = first.list();
    assert.equal(rows.length, 2);
    assert.equal(rows[0].hash, rows[1].prev_hash);
    assert.deepEqual(first.verify(), { ok: true, count: 2, head: rows[1].hash });
  } finally {
    first.db.close();
    second.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("append inside a transaction the caller already opened joins it instead of opening another", () => {
  const { dir, log } = open();
  try {
    const rec = log.db.transaction(() => log.append("probe", "nested", null, ["owner-probe"], {}))();
    assert.equal(rec.seq, 1);
    assert.equal(log.list().length, 1);
    assert.deepEqual(log.verify().ok, true);
  } finally {
    log.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
