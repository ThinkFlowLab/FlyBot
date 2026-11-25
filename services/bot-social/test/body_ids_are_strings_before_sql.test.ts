import assert from "node:assert/strict";
import { test } from "node:test";
import { ownerWithBot, startServer } from "./helpers.js";

async function postRaw(base: string, path: string, token: string, body: unknown) {
  const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() as any };
}

test("an id in a request body is refused before it reaches SQL", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "alpha");
  const B = await ownerWithBot(s.base, "beta");
  const H = s.platform.onboardFlybot({ display_name: "homesend" });
  const login = await fetch(`${s.base}/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: H.username, password: H.generated_password }),
  });
  assert.equal(login.status, 200, "the onboarded home owner can log in");
  const homeToken = ((await login.json()) as any).owner_token as string;
  const inv = await postRaw(s.base, "/v1/invites", B.owner.token, { bot_id: B.bot.id });
  assert.equal(inv.status, 201);
  const code = inv.body.code;
  const snapshot = () => ({
    bots: s.platform.db.prepare("SELECT id, status FROM bots ORDER BY id").all(),
    relationships: (s.platform.db.prepare("SELECT COUNT(*) AS c FROM relationships").get() as any).c,
    attachments: (s.platform.db.prepare("SELECT COUNT(*) AS c FROM attachments").get() as any).c,
    messages: (s.platform.db.prepare("SELECT COUNT(*) AS c FROM messages").get() as any).c,
    approvals: (s.platform.db.prepare("SELECT COUNT(*) AS c FROM approvals").get() as any).c,
    events: (s.platform.db.prepare("SELECT COUNT(*) AS c FROM events").get() as any).c,
    calendar_entries: (s.platform.db.prepare("SELECT COUNT(*) AS c FROM calendar_entries").get() as any).c,
  });
  const before = snapshot();
  // An object became named parameters and a boolean had no binding at all, so each of these routes answered
  // 500 before any refusal could name the field. Every body below carries the value that used to reach SQL.
  const shapes: [string, unknown][] = [["an object", {}], ["an array", []], ["a boolean", true]];
  const gates: [string, string, string, (value: unknown) => Record<string, unknown>, string?][] = [
    ["the emergency stop", "/v1/emergency-stop", "bot_id", (value) => ({ bot_id: value })],
    ["a relationship request's sender", "/v1/relationships", "from_bot_id", (value) => ({ from_bot_id: value, target_bot_id: B.bot.id })],
    ["a relationship request's target", "/v1/relationships", "target_bot_id", (value) => ({ from_bot_id: A.bot.id, target_bot_id: value })],
    ["an invite join's code", `/v1/invites/${code}/join`, "code", (value) => ({ from_bot_id: A.bot.id, code: value })],
    ["an attachment's bot", "/v1/attachments", "bot_id", (value) => ({ bot_id: value, name: "x.txt", mime: "text/plain", content_base64: "aGk=" })],
    ["a home send's sender", `/v1/homes/${H.home.bot_id}/send`, "from_bot_id", (value) => ({ from_bot_id: value, to: B.bot.id, text: "hi" }), homeToken],
    // `title` and `location` are free text, not ids, but the same contract holds: a value of another type must be
    // refused before the INSERT binds it.
    ["a calendar entry's title", "/v1/calendar/entries", "title", (value) => ({ start: new Date(Date.now() + 3600e3).toISOString(), end: new Date(Date.now() + 7200e3).toISOString(), title: value })],
    ["a calendar entry's location", "/v1/calendar/entries", "location", (value) => ({ start: new Date(Date.now() + 3600e3).toISOString(), end: new Date(Date.now() + 7200e3).toISOString(), location: value })],
  ];
  for (const [label, path, field, make, token] of gates) {
    for (const [shape, value] of shapes) {
      const r = await postRaw(s.base, path, token ?? A.owner.token, make(value));
      const where = `${label} given ${shape} as ${field}`;
      assert.equal(r.status, 400, `${where} answered ${r.status}, not 400`);
      assert.equal(r.body.error.code, "invalid_request", where);
      assert.equal(r.body.error.message, `${field} must be a string`, where);
      assert.deepEqual(snapshot(), before, `${where} wrote before refusing`);
    }
  }
  const aBot = (snapshot().bots as any[]).find((b) => b.id === A.bot.id);
  assert.equal(aBot.status, "active", "the emergency stop froze the bot without a string id");
  assert.equal(snapshot().relationships, 0, "a refused request left a relationship behind");
  assert.equal(snapshot().attachments, 0, "a refused upload left an attachment behind");
  assert.equal(snapshot().messages, 0, "a refused home send left a message behind");
  assert.equal(snapshot().approvals, 0, "a refused home send left an approval behind");
  assert.equal(snapshot().calendar_entries, 0, "a refused calendar entry was inserted");
});
