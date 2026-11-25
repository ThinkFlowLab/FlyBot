/**
 * A file is never destroyed without the line that names its end.
 *
 * `cleanupAttachments` sweeps files past `expires_at`: it deletes the rows and then writes one
 * `attachment.expired` line per destroyed row. The audit log is a second SQLite file (design §7.4), so those two
 * writes are not in one transaction: the DELETE commits on its own, and the line is appended after it. When the
 * audit store refuses that append — a full disk, a locked file, a failing append — the rows are already gone and
 * the lines never exist. The uploader's chain then reads `attachment.uploaded`, maybe `attachment.downloaded`, and
 * nothing at all, the delivered message keeps naming a file that no longer exists, and no later sweep can repair
 * it: the row the line would have named is not there to find. `GET /v1/attachments` sweeps at its head, so the
 * same residue is reachable through a plain read, which answers `500 internal_error` after the bytes are gone.
 *
 * The order is what can be fixed here. The audit log is a second database and there is no two-phase commit across
 * the two, so the sweep writes every line first and destroys the rows last: a line that cannot be written aborts
 * before any row is touched, and the next sweep — the next read, the next upload — finds the file still there and
 * records the end it could not record the first time. A line already written for a row that a failed DELETE left
 * standing is not written twice: the sweep reads the chain first and skips a row it has already named.
 *
 * On master 52d2304d.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { friends, startServer } from "./helpers.js";

const b64 = (s: string) => Buffer.from(s).toString("base64");
const past = () => new Date(Date.now() - 3600e3).toISOString();

type S = Awaited<ReturnType<typeof startServer>>;

/** One stored file for this owner's Bot, past its deadline, so the next sweep destroys it. */
async function doomedUpload(s: S, A: any, name: string) {
  const up: any = await A.owner.req("POST", "/v1/attachments", { bot_id: A.bot.id, name, content_base64: b64("never sent") });
  s.platform.db.prepare("UPDATE attachments SET expires_at = ? WHERE id = ?").run(past(), up.attachment.id);
  return up.attachment as { id: string; name: string; sha256: string };
}

const fileRows = (s: S, id: string) =>
  (s.platform.db.prepare("SELECT COUNT(*) n FROM attachments WHERE id = ?").get(id) as any).n as number;

/** Every `attachment.expired` line the chain holds for one file. */
const endLines = (s: S, id: string) =>
  (s.platform.audit.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action = 'attachment.expired' AND subject = ?").get(id) as any).n as number;

/** The owner's read door, which sweeps at its head. */
async function readAttachments(base: string, token: string) {
  const r = await fetch(`${base}/v1/attachments`, { headers: { authorization: `Bearer ${token}` } });
  let body: any = null;
  try { body = await r.json(); } catch { body = null; }
  return { status: r.status, body };
}

test("a file whose end cannot be written is still stored, and the next sweep names it", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A } = await friends(s.base);
  const file = await doomedUpload(s, A, "orphan.txt");

  // The audit store refuses the one line this sweep has to write, and only that line.
  s.platform.audit.db.exec(`CREATE TEMP TRIGGER refuse_attachment_line BEFORE INSERT ON audit_events
    WHEN NEW.action = 'attachment.expired' BEGIN SELECT RAISE(ABORT, 'audit store refused the line'); END;`);

  // The read door sweeps: it answers 500 because its sweep threw, and the file it could not record is still there.
  const failed = await readAttachments(s.base, String(A.owner.token));
  assert.equal(failed.status, 500);
  assert.equal(failed.body?.error?.code, "internal_error");
  assert.deepEqual({ rows: fileRows(s, file.id), lines: endLines(s, file.id) }, { rows: 1, lines: 0 },
    "the file whose line cannot be written is still stored: nothing is destroyed before the line that names its end");

  // The refusal is gone and the next sweep still finds the file: it writes the line it owed and destroys the row.
  s.platform.audit.db.exec("DROP TRIGGER refuse_attachment_line");
  assert.equal(s.platform.cleanupAttachments(), 1);
  assert.deepEqual({ rows: fileRows(s, file.id), lines: endLines(s, file.id) }, { rows: 0, lines: 1 });
  const line = s.platform.audit.db.prepare("SELECT actor, owners, data FROM audit_events WHERE action = 'attachment.expired' AND subject = ?").get(file.id) as any;
  assert.equal(line.actor, "platform");
  assert.deepEqual(JSON.parse(line.owners), [A.owner_id]);
  assert.deepEqual(JSON.parse(line.data), { name: "orphan.txt", size: Buffer.byteLength("never sent"), sha256: file.sha256 });
});

test("a destroyed file lands with its line, and a second sweep writes nothing twice", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A } = await friends(s.base);
  const file = await doomedUpload(s, A, "plan.txt");

  assert.equal(s.platform.cleanupAttachments(), 1);
  assert.deepEqual({ rows: fileRows(s, file.id), lines: endLines(s, file.id) }, { rows: 0, lines: 1 });
  // The rows are gone, so the second sweep has nothing to say about them.
  assert.equal(s.platform.cleanupAttachments(), 0);
  assert.deepEqual({ rows: fileRows(s, file.id), lines: endLines(s, file.id) }, { rows: 0, lines: 1 });
});

test("a line already written for a file a failed DELETE left standing is not written again", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A } = await friends(s.base);
  const file = await doomedUpload(s, A, "kept.txt");

  // The line lands, then the destructive statement is refused: the row survives, named once.
  s.platform.db.exec(`CREATE TEMP TRIGGER refuse_attachment_delete BEFORE DELETE ON attachments
    BEGIN SELECT RAISE(ABORT, 'store refused the delete'); END;`);
  assert.throws(() => s.platform.cleanupAttachments(), /store refused the delete/);
  assert.deepEqual({ rows: fileRows(s, file.id), lines: endLines(s, file.id) }, { rows: 1, lines: 1 });

  // The next sweep destroys the row it has already named, and does not name it a second time.
  s.platform.db.exec("DROP TRIGGER refuse_attachment_delete");
  assert.equal(s.platform.cleanupAttachments(), 1);
  assert.deepEqual({ rows: fileRows(s, file.id), lines: endLines(s, file.id) }, { rows: 0, lines: 1 });
});
