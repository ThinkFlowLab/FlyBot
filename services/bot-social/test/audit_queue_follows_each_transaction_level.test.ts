import assert from "node:assert/strict";
import { test } from "node:test";
import { startServer } from "./helpers.js";

/**
 * An audit row names a write that happened, so it must follow the level of transaction that made that write.
 *
 * Holding records until the outermost commit is not enough on its own: a nested transaction is a savepoint, and a
 * savepoint that fails can be caught by the transaction around it, which then commits. If the nested level's records
 * sit in the outermost queue, that commit appends a row describing a write the savepoint already took back — the
 * same lie the outer queue was built to stop, one level down. So each level holds its own records: a commit hands
 * them to the enclosing level, and a rollback drops that level's records and leaves the enclosing level's alone.
 *
 * Nothing in `src/` builds that shape today (the only `catch` around a transaction is in `atomically`, and it
 * rethrows), so these tests drive the mechanism through the transaction wrapper itself.
 */

const heldRows = (s: any, action: string) =>
  s.platform.audit.db.prepare("SELECT subject FROM audit_events WHERE action = ? ORDER BY seq").all(action) as any[];

test("an inner transaction that fails and is caught by the enclosing one leaves no row on the outer commit", async (t) => {
  const s: any = await startServer();
  t.after(s.stop);
  const p: any = s.platform;

  // The inner savepoint writes, then fails. The enclosing transaction swallows the failure and commits its own write.
  p.db.transaction(() => {
    try {
      p.db.transaction(() => {
        p.run("CREATE TABLE test_nested_rollback (x INTEGER)");
        p.audit.append("test", "test.inner.rolled_back", "inner", [], {});
        throw new Error("the inner transaction rolls back");
      })();
    } catch (e) {
      assert.match(String(e), /the inner transaction rolls back/);
    }
    p.audit.append("test", "test.inner.rolled_back", "outer", [], {});
  })();

  assert.deepEqual(
    heldRows(s, "test.inner.rolled_back").map((r) => r.subject),
    ["outer"],
    "the rolled-back level's row must not ride the enclosing commit",
  );
  assert.throws(() => p.db.prepare("SELECT * FROM test_nested_rollback").all(), /no such table/, "the inner write did roll back");
  assert.equal(p.audit.verify().ok, true);
});

test("both levels commit: each row reaches the log once, in the order the writes were made", async (t) => {
  const s: any = await startServer();
  t.after(s.stop);
  const p: any = s.platform;

  p.db.transaction(() => {
    p.db.transaction(() => p.audit.append("test", "test.both.commit", "inner", [], {}))();
    p.audit.append("test", "test.both.commit", "outer", [], {});
  })();

  assert.deepEqual(
    heldRows(s, "test.both.commit").map((r) => r.subject),
    ["inner", "outer"],
    "one row per write, in the order written",
  );
  assert.equal(p.audit.verify().ok, true);
});

test("an inner commit inside an outer rollback takes its rows down with the outer write", async (t) => {
  const s: any = await startServer();
  t.after(s.stop);
  const p: any = s.platform;

  assert.throws(
    () =>
      p.db.transaction(() => {
        p.db.transaction(() => p.audit.append("test", "test.outer.rollback", "inner", [], {}))();
        throw new Error("the outer transaction rolls back");
      })(),
    /the outer transaction rolls back/,
  );

  assert.deepEqual(heldRows(s, "test.outer.rollback"), [], "no row survives the outermost rollback");
  assert.equal(p.audit.verify().ok, true);
});
