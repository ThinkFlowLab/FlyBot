// Both invite doors name a Bot in their body: `POST /v1/invites` shares one, `POST /v1/invites/{code}/join`
// joins with one. The body declares those ids as strings, but `namedOwnBot` coerces them with `String(...)`
// before it looks them up, and both call sites fall back to `inviteBotFor` when the lookup finds nothing.
// A caller that passes an array — `String([])` is the empty string — therefore reads as "no Bot named" and the
// platform shares or joins with the account's default Bot instead of refusing the body: a wrong-typed id does
// not fail, it silently acts for a different Bot. Objects, booleans and numbers take the other old path and are
// answered 404 `bot_not_found`, which names the wrong problem. A wrong-typed id is a 400 that names the field.
import assert from "node:assert/strict";
import { test } from "node:test";
import { startServer, ownerWithBot, bulkAuth } from "./helpers.js";

const post = async (base: string, path: string, token: string, body: unknown) => {
  const r = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as any };
};

/** An owner with a home Bot and two member Bots: `defaultBot` is the Bot the platform itself answers for "no Bot
 *  named", and `member` is the other one, so a body that names a Bot names a different Bot from the default. */
async function homeOwnerWithTwoBots(s: any) {
  const p: any = s.platform;
  const fly: any = p.onboardFlybot({ display_name: "Wes" });
  // Two members make "the default Bot" a real second choice, but which of them is the default is not a fixture
  // decision and cannot be read off the order they were built in: `inviteBotFor` takes the oldest member, and two
  // rows minted in the same millisecond share `created_at` — the tie then falls to a ULID whose random suffix does
  // not record which row was built first. So the fixture asks the platform for its answer and names the other
  // member, instead of assuming the first one built is the default.
  const first: any = p.addHomeMember({ kind: "owner", ownerId: fly.owner_id }, fly.home.bot_id, { name: "writer" });
  const second: any = p.addHomeMember({ kind: "owner", ownerId: fly.owner_id }, fly.home.bot_id, { name: "reader" });
  const defaultBot: any = p.inviteBotFor(fly.owner_id);
  assert(defaultBot.id === first.bot_id || defaultBot.id === second.bot_id, "the default Bot is one of the fixture's two members");
  const member: any = defaultBot.id === first.bot_id ? second : first;
  const login = await fetch(s.base + "/v1/auth/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: fly.username, password: fly.generated_password }),
  });
  const token = ((await login.json()) as any).owner_token as string;
  return { p, fly, defaultBot, member, token };
}

test("an invite names its Bot with a string or not at all", async (t) => {
  const s = await startServer(bulkAuth);
  t.after(s.stop);
  const { p, defaultBot, member, token } = await homeOwnerWithTwoBots(s);
  const invites = () => (p.get("SELECT COUNT(*) n FROM invites") as any).n;
  const lastInviteBot = () => p.bot(p.get("SELECT bot_id FROM invites ORDER BY created_at DESC, rowid DESC LIMIT 1").bot_id).handle;
  const defaultHandle = p.bot(defaultBot.id).handle;
  assert.notEqual(defaultHandle, p.bot(member.bot_id).handle, "the fixture names a Bot that is not the default Bot");

  // Controls first: they must keep their answers.
  for (const [label, body] of [["omitted", {}], ["null", { bot_id: null }]] as [string, any][]) {
    const before = invites();
    const r = await post(s.base, "/v1/invites", token, body);
    assert.equal(r.status, 201, `${label} bot_id still mints an invite`);
    assert.equal(invites(), before + 1);
    assert.equal(lastInviteBot(), defaultHandle, `${label} bot_id still means "the default Bot"`);
  }
  {
    const r = await post(s.base, "/v1/invites", token, { bot_id: member.bot_id });
    assert.equal(r.status, 201, "a string bot_id still mints an invite");
    assert.equal(lastInviteBot(), p.bot(member.bot_id).handle, "a string bot_id still names that Bot");
  }

  // The defect: a wrong-typed id is neither refused nor "not given".
  for (const [label, value] of [["an array", []], ["an array holding an empty string", [""]], ["an object", {}], ["a boolean", true], ["a number", 1.5]] as [string, unknown][]) {
    const before = invites();
    const r = await post(s.base, "/v1/invites", token, { bot_id: value });
    assert.equal(r.status, 400, `bot_id given ${label} must be refused, not answered ${r.status}`);
    assert.equal(r.body.error?.code, "invalid_request");
    assert.equal(r.body.error?.message, "bot_id must be a string");
    assert.equal(invites(), before, `bot_id given ${label} wrote no invite`);
  }
});

test("a join names its Bot with a string or not at all", async (t) => {
  const s = await startServer(bulkAuth);
  t.after(s.stop);
  const { p, member, token } = await homeOwnerWithTwoBots(s);
  const { owner: joinerOwner } = await ownerWithBot(s.base, "juno");

  const mint = async () => (await post(s.base, "/v1/invites", token, { bot_id: member.bot_id })).body.code as string;

  for (const [label, value] of [["an array", []], ["an array holding an empty string", [""]], ["an object", {}], ["a boolean", true], ["a number", 1.5]] as [string, unknown][]) {
    const code = await mint();
    const before = (p.get("SELECT COUNT(*) n FROM relationships") as any).n;
    const r = await post(s.base, `/v1/invites/${code}/join`, joinerOwner.token, { from_bot_id: value, code });
    assert.equal(r.status, 400, `from_bot_id given ${label} must be refused, not answered ${r.status}`);
    assert.equal(r.body.error?.code, "invalid_request");
    assert.equal(r.body.error?.message, "from_bot_id must be a string");
    assert.equal((p.get("SELECT COUNT(*) n FROM relationships") as any).n, before, `from_bot_id given ${label} wrote no relationship`);
  }

  // Controls, each with its own joiner: omitting the id joins with the account's default Bot, a string joins
  // with that Bot.
  {
    const { owner } = await ownerWithBot(s.base, "juno2");
    const code = await mint();
    const r = await post(s.base, `/v1/invites/${code}/join`, owner.token, { code });
    assert.equal(r.status, 201, "an unnamed join still works: " + JSON.stringify(r.body));
  }
  {
    const { owner, bot } = await ownerWithBot(s.base, "juno3");
    const code = await mint();
    const r = await post(s.base, `/v1/invites/${code}/join`, owner.token, { from_bot_id: bot.id, code });
    assert.equal(r.status, 201, "a string from_bot_id still works: " + JSON.stringify(r.body));
  }
});
