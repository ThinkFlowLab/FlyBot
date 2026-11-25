// `POST /v1/invites` declares `auto_accept` as a boolean, but the door read it as `payload.auto_accept === false`,
// so only the JSON literal `false` turned the link into "ask the owner first": "false", "0", 0, {}, [] and 1.5 all
// fell through to 1 and were stored as an auto-accept invite. That is not a wording problem: joining a link built
// with `"false"` activated the relationship and wrote its grants on the spot, with no approval anywhere in the
// path — and an existing revoked relationship could be rebuilt as active, and revoked grants handed out again, by
// the same link. A wrong-typed `auto_accept` is a 400 that names the field, decided before the invite row exists.
// `undefined`/`null`/`true`/`false` keep their meanings: absent and null default to auto-accept, `false` asks first.
//
// Both doors reach the same `createInvite`: the owner's REST `POST /v1/invites` and a bot's signed `invite.create`
// envelope. Neither may read a wrong-typed `auto_accept` as yes.
//
// `expires_in_hours` is deliberately untouched: its clamp/fallback is existing behavior and out of this contract.
import assert from "node:assert/strict";
import { test } from "node:test";
import { bulkAuth, ownerWithBot, startServer } from "./helpers.js";

type Case = { label: string; raw: string };

const rowCount = (s: any, table: string) => {
  const exists = (s.platform.db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as any).n;
  return exists ? (s.platform.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as any).n as number : 0;
};
/** The audit log is its own database (`platform.audit.db`), not the platform one. Counting it through `rowCount`
 *  asked the platform database for a table it does not have, read 0 through the "no such table" guard, and so
 *  compared 0 with 0: the "wrote no audit row" assertions could never fail. */
const auditRows = (s: any) => (s.platform.audit.db.prepare("SELECT COUNT(*) n FROM audit_events").get() as any).n as number;
const invites = (s: any) => rowCount(s, "invites");
const approvals = (s: any) => rowCount(s, "approvals");
const grants = (s: any) => rowCount(s, "grants");

async function rawCreate(base: string, token: string, raw: string) {
  const r = await fetch(base + "/v1/invites", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: raw,
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : {} };
}

/** The stored flag of the newest invite, read from the row rather than from the response projection. */
const storedAutoAccept = (s: any, code: string) =>
  (s.platform.db.prepare("SELECT auto_accept FROM invites WHERE code = ?").get(code) as any).auto_accept as number;

// The six shapes Security sent at the door. They are raw bodies so the JSON literals are exactly what a caller sends.
const wrongShapes: Case[] = [
  { label: '"false" (a string)', raw: '{"auto_accept":"false"}' },
  { label: '"0" (a string)', raw: '{"auto_accept":"0"}' },
  { label: "0 (a number)", raw: '{"auto_accept":0}' },
  { label: "{} (an object)", raw: '{"auto_accept":{}}' },
  { label: "[] (an array)", raw: '{"auto_accept":[]}' },
  { label: "1.5 (a number)", raw: '{"auto_accept":1.5}' },
];

for (const c of wrongShapes) {
  test(`invite create refuses auto_accept ${c.label}`, async (t) => {
    const s = await startServer(bulkAuth);
    t.after(s.stop);
    const inviter = await ownerWithBot(s.base, "inviter");
    const before = { invites: invites(s), approvals: approvals(s), audit: auditRows(s) };
    const r = await rawCreate(s.base, inviter.owner.token, c.raw);
    assert.equal(r.status, 400, `auto_accept ${c.label} answered ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error?.code, "invalid_request");
    assert.equal(r.body.error?.message, "auto_accept must be a boolean");
    assert.equal(invites(s), before.invites, `auto_accept ${c.label} wrote no invite`);
    assert.equal(approvals(s), before.approvals, `auto_accept ${c.label} opened no approval`);
    assert.equal(auditRows(s), before.audit, `auto_accept ${c.label} wrote no audit row`);
  });
}

test("invite create keeps every boolean auto_accept meaning: absent and null auto-accept, true auto-accepts, false asks first", async (t) => {
  const s = await startServer(bulkAuth);
  t.after(s.stop);
  const inviter = await ownerWithBot(s.base, "inviter");
  for (const [label, body, want] of [
    ["omitted", {}, 1],
    ["null", { auto_accept: null }, 1],
    ["true", { auto_accept: true }, 1],
    ["false", { auto_accept: false }, 0],
  ] as [string, any, number][]) {
    const before = invites(s);
    const r = await inviter.owner.req("POST", "/v1/invites", body);
    assert.equal(invites(s), before + 1, `${label} auto_accept still mints an invite`);
    assert.equal(storedAutoAccept(s, r.code), want, `${label} auto_accept is stored as ${want}`);
    assert.equal(r.auto_accept, want === 1, `${label} auto_accept reads back as ${want === 1}`);
  }
});

test("a bot's signed invite.create refuses the same wrong auto_accept shapes before writing", async (t) => {
  const s = await startServer(bulkAuth);
  t.after(s.stop);
  const inviter = await ownerWithBot(s.base, "signed-inviter");
  for (const c of wrongShapes) {
    const before = { invites: invites(s), approvals: approvals(s), audit: auditRows(s) };
    // The envelope carries the body to the same `createInvite`; the refusal must come from that door, not the schema.
    await assert.rejects(
      () => inviter.bot.signed("/v1/invites", "invite.create", { auto_accept: JSON.parse(c.raw).auto_accept }),
      (e: any) => {
        assert.equal(e.status, 400, `signed auto_accept ${c.label} answered ${e.status}: ${e.code}`);
        assert.equal(e.code, "invalid_request", `signed auto_accept ${c.label} code`);
        assert.ok(String(e.message).endsWith("auto_accept must be a boolean"), `signed auto_accept ${c.label} message: ${e.message}`);
        return true;
      },
    );
    assert.equal(invites(s), before.invites, `signed auto_accept ${c.label} wrote no invite`);
    assert.equal(approvals(s), before.approvals, `signed auto_accept ${c.label} opened no approval`);
    assert.equal(auditRows(s), before.audit, `signed auto_accept ${c.label} wrote no audit row`);
  }
});

test("an invite whose auto_accept only looks false never hands out access", async (t) => {
  const s = await startServer(bulkAuth);
  t.after(s.stop);
  const inviter = await ownerWithBot(s.base, "host");
  const joiner = await ownerWithBot(s.base, "guest");

  // The defect shape: on the old tree this link was minted and a plain join turned it into an active friendship
  // with its grants written, nobody having approved anything.
  const beforeInvites = invites(s);
  const refused = await rawCreate(s.base, inviter.owner.token, '{"auto_accept":"false"}');
  assert.equal(refused.status, 400, `"false" must be refused, not answered ${refused.status}`);
  assert.equal(invites(s), beforeInvites, "a refused invite leaves nothing to join");

  // The same request with the real boolean is an ordinary link that still asks the owner first: the only way to
  // mean "do not auto-accept" must stay reachable, and it must not write grants either.
  const before = { rels: rowCount(s, "relationships"), grants: grants(s) };
  const link = await inviter.owner.req("POST", "/v1/invites", { auto_accept: false });
  const joined = await joiner.owner.req("POST", `/v1/invites/${link.code}/join`, { code: link.code });
  assert.notEqual(joined.status, "active", "auto_accept false still waits for the inviter's owner");
  assert.equal(joined.grants, undefined, "no grants are ready on a join that waits");
  assert.equal(rowCount(s, "relationships"), before.rels + 1, "the join wrote its pending relationship");
  assert.equal(grants(s), before.grants, "the join wrote no grant");
});
