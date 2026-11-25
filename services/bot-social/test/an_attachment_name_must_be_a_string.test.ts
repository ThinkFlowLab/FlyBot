// `POST /v1/attachments` is the door behind `uploadAttachment`. Its `name` is the one free-text field of an upload,
// and `checkFile` reads it with `String(name ?? "")`: an object became the stored file name "[object Object]", an
// array "1,2" (or "a.png" for `["a.png"]`), a boolean "true" and a number "42". All of those answered 201 with a real
// row, the sealed bytes written and the owner's storage budget charged for the file, and the peer that later receives
// the file reads that string as its name. An empty or blank name was already refused with 415 `invalid_request`
// "file name required". The field is a string: anything else is a 400 `invalid_request` "name must be a string"
// refused before `checkFile`, before the quota is read or charged, before the sealed bytes are written and before
// the audit line. An absent or `null` name keeps the 415 it always had, and a string keeps the sanitiser's output
// byte for byte.
import assert from "node:assert/strict";
import { test } from "node:test";
import { startServer, bulkAuth, ownerWithBot } from "./helpers.js";

function counts(p: any) {
  const one = (db: any, sql: string) => (db.prepare(sql).get() as any).n as number;
  return {
    attachments: one(p.db, "SELECT COUNT(*) n FROM attachments"),
    bytes: (p.db.prepare("SELECT COALESCE(SUM(size),0) n FROM attachments").get() as any).n as number,
    uploaded: one(p.audit.db, "SELECT COUNT(*) n FROM audit_events WHERE action = 'attachment.uploaded'"),
  };
}

/** One owner with one active Bot on a private server, and the upload door as the only thing under test. */
async function uploaderOnServer(t: any) {
  const s = await startServer(bulkAuth as any);
  t.after(s.stop);
  const o = await ownerWithBot(s.base, "uploader");
  const p = s.platform as any;
  const upload = async (body: unknown) => {
    const res = await fetch(s.base + "/v1/attachments", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${o.owner.token}` },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : {}) as any };
  };
  return { base: s.base, p, upload };
}

const err = (r: { body: any }) => r.body.error ?? {};
const isTypeRefusal = (r: { status: number; body: any }) =>
  r.status === 400 && err(r).code === "invalid_request" && err(r).message === "name must be a string";

// The shapes `String()` used to turn into a stored file name. Each one wrote a row and charged its bytes.
const bad: [string, unknown][] = [
  ["an object", {}],
  ["an object with its own text", { toString: () => "x" }],
  ["an array of two numbers", [1, 2]],
  ["an array holding a valid file name", ["a.png"]],
  ["a boolean true", true],
  ["a boolean false", false],
  ["a number", 42],
  ["a fraction", 1.5],
  ["zero", 0],
];

for (const [label, value] of bad) {
  test(`a file name given as ${label} is a 400 and writes nothing`, async (t) => {
    const { p, upload } = await uploaderOnServer(t);
    const before = counts(p);

    const r = await upload({ content_base64: "aGk=", mime: "text/plain", name: value });
    assert.ok(isTypeRefusal(r), `expected 400 name must be a string, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.deepEqual(counts(p), before, "no attachment row, no stored bytes and no upload audit line");
  });
}

test("a repeat of the refused upload writes nothing the second time either", async (t) => {
  const { p, upload } = await uploaderOnServer(t);
  const before = counts(p);

  for (let i = 0; i < 3; i++) {
    const r = await upload({ content_base64: "aGk=", mime: "text/plain", name: {} });
    assert.ok(isTypeRefusal(r), `attempt ${i + 1} is refused`);
  }
  assert.deepEqual(counts(p), before, "a retry cannot write the row or charge the budget");
});

test("an empty, blank, absent or null name keeps the file-name-required answer", async (t) => {
  const { p, upload } = await uploaderOnServer(t);
  const before = counts(p);

  for (const body of [
    { content_base64: "aGk=", mime: "text/plain", name: "" },
    { content_base64: "aGk=", mime: "text/plain", name: "   " },
    { content_base64: "aGk=", mime: "text/plain" },
    { content_base64: "aGk=", mime: "text/plain", name: null },
  ]) {
    const r = await upload(body);
    assert.equal(r.status, 415, `expected the unchanged 415, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(err(r).code, "invalid_request");
    assert.equal(err(r).message, "file name required");
  }
  assert.deepEqual(counts(p), before, "no attachment row, no stored bytes and no upload audit line");
});

test("a string name is stored as the sanitiser leaves it, and charges exactly its bytes", async (t) => {
  const { base, p, upload } = await uploaderOnServer(t);

  const plain = await upload({ content_base64: "aGk=", mime: "text/plain", name: "notes.txt" });
  assert.equal(plain.status, 201);
  assert.equal(plain.body.attachment.name, "notes.txt", "the name in the answer is the stored one");
  assert.equal(plain.body.attachment.size, 2);
  assert.equal(plain.body.limits.used_bytes, 2, "the budget is charged exactly once for this file");
  assert.deepEqual(p.get("SELECT name, typeof(name) t, size FROM attachments WHERE id = ?", plain.body.attachment.id), { name: "notes.txt", t: "text", size: 2 });

  // The sanitiser's own rules are untouched: a path separator is replaced, never accepted as one.
  const sanitized = await upload({ content_base64: "aGk=", mime: "text/plain", name: "../etc/passwd" });
  assert.equal(sanitized.status, 201);
  assert.equal(p.get("SELECT name FROM attachments WHERE id = ?", sanitized.body.attachment.id).name, ".._etc_passwd");
  assert.equal(sanitized.body.limits.used_bytes, 4, "the second file adds its two bytes to the first");
});

test("a refused name does not spend the storage budget a later upload needs", async (t) => {
  const { p, upload } = await uploaderOnServer(t);

  const refused = await upload({ content_base64: "aGk=", mime: "text/plain", name: [1, 2] });
  assert.ok(isTypeRefusal(refused));
  assert.deepEqual(counts(p), { attachments: 0, bytes: 0, uploaded: 0 });

  const ok = await upload({ content_base64: "aGk=", mime: "text/plain", name: "real.txt" });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.limits.used_bytes, 2, "only the accepted file's bytes are counted");
});
