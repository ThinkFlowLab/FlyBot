// Owner console (public/ui.js): error text, validation, copy and loading states (#15, #17).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { startServer } from "./helpers.js";
import { loadConsole, pub } from "./ui_helpers.js";

test("errText: never a bare code; ERR entry, else server message, else a generic sentence", () => {
  const { errText, ERR } = loadConsole(["errText", "ERR"]);
  assert.equal(errText("invalid_credentials", "invalid_credentials", 401), "Wrong username or password.");
  assert.equal(errText("invite_not_found", "invite_not_found", 404), "This invite does not exist or was revoked.");
  assert.equal(errText("invalid_request", "username: 2-32 chars [a-z0-9._-]", 400), "Username: 2-32 chars [a-z0-9._-].");
  assert.equal(errText("invalid_request", "password must be >= 6 chars", 400), "Password must be >= 6 chars.");
  // #127: four codes that reach /ui get a sentence plus an action, never the generic fallback.
  assert.equal(errText("approval_not_found", "approval_not_found", 404), "This approval was already handled or withdrawn. Refresh the page.");
  assert.equal(errText("grant_not_found", "grant_not_found", 404), "That access was already removed. Refresh to see the current list.");
  assert.equal(errText("relationship_not_found", "relationship_not_found", 404), "That friendship is no longer there. Refresh the page.");
  assert.equal(errText("bot_frozen", "bot is frozen (emergency stop)", 403), "This Bot is emergency-stopped. Resume it under My Bots before sharing it.");
  // code-only errors and bare statuses get a sentence that still names the code
  assert.equal(errText("weird_code", "weird_code", 418), "Something went wrong (weird_code). Please try again.");
  assert.equal(errText(undefined, undefined, 502), "Something went wrong (502). Please try again.");
  for (const code of ["owner_only", "forbidden", "rate_limited", "payload_too_large", "connector_token_rest_forbidden", "unauthorized"]) {
    const t = errText(code, code, 400);
    assert.ok(t.length > 15 && /[.!?]$/.test(t) && !t.includes(code), `${code} -> ${t}`);
  }
  assert.match(ERR.connector_token_rest_forbidden, /connector token for assistants .*not a login token/);
});

test("login reasons cover invalid, connector, bot and signed-out tokens", () => {
  const { LOGIN_MSG } = loadConsole(["LOGIN_MSG"]);
  assert.equal(LOGIN_MSG.invalid, "That token is not valid or was revoked.");
  assert.match(LOGIN_MSG.connector, /connector token/);
  assert.match(LOGIN_MSG.bot, /Bot token/);
  assert.equal(LOGIN_MSG.signed_out, "You were signed out. Please sign in again.");
});

test("client-side validation matches the server rules", () => {
  const { usernameError, passwordError, handleError, calRangeError, codeOf } = loadConsole(["usernameError", "passwordError", "handleError", "calRangeError", "codeOf"]);
  assert.match(usernameError("a"), /2–32 characters/);
  assert.equal(usernameError("alice.b_1-x"), "");
  assert.equal(usernameError(""), "Enter a username.");
  assert.match(passwordError("123", true), /at least 6/);
  assert.equal(passwordError("123", false), ""); // login: the server decides
  assert.equal(passwordError("123456", true), "");
  assert.equal(handleError(""), "Handle is required.");
  assert.equal(handleError("  "), "Handle is required.");
  assert.match(handleError("bad handle!"), /2–40 characters/);
  assert.equal(handleError("@alice.bot"), "");
  assert.equal(calRangeError("", ""), "Pick both a start and an end time.");
  assert.equal(calRangeError("2026-10-20T10:00", "2026-10-20T09:00"), "The end must be after the start.");
  assert.equal(calRangeError("2026-10-20T10:00", "2026-10-20T10:00"), "The end must be after the start.");
  assert.equal(calRangeError("2026-10-20T10:00", "2026-10-20T11:00"), "");
  assert.equal(codeOf("https://x.test/i/AbC123"), "AbC123");
  assert.equal(codeOf("  AbC123 "), "AbC123");
  assert.equal(codeOf(""), "");
});

test("plural reads correctly for 0, 1 and 2", () => {
  const { plural } = loadConsole(["plural"]);
  assert.equal(plural(0, "Friend request", "Friend requests"), "0 Friend requests");
  assert.equal(plural(1, "item needs", "items need"), "1 item needs");
  assert.equal(plural(2, "item needs", "items need"), "2 items need");
});

test("the invite 'Copy message for them' text is three complete lines with balanced parentheses (#125)", () => {
  const ui = pub("ui.js");
  const m = /#cpm"\)\.onclick = \(\) => copy\(`([^`]*)`\)/.exec(ui);
  assert.ok(m, "the copy-message handler is one template literal");
  const text = m[1];
  assert.equal((text.match(/\(/g) || []).length, (text.match(/\)/g) || []).length, "parentheses balance");
  assert.equal(text.split(/\\n/).length, 3, "three self-contained lines");
  assert.ok(text.includes("${r.url}"), "the invite URL stays intact");
});

test("console copy: no stray-space possessive, invite list refreshes, revoke asks first, push form starts collapsed", () => {
  const ui = pub("ui.js");
  assert.ok(!ui.includes(" 's \""), "possessive typo");
  assert.ok(!ui.includes("no bot yet.<a"), "missing space after the no-Bot sentence");
  assert.match(ui, /PAGES\.invites\.refreshList = async/);
  assert.match(ui, /confirm\("Revoke this invite\? Anyone who has the link can no longer use it\."\)/);
  assert.ok(!/\$\{w\.configured \? "" : "open"\}/.test(ui), "push form must not be open when push is off");
  assert.ok(!ui.includes('toast("Error: "'), "toasts are sentences, not 'Error: code'");
  assert.ok(!ui.includes("your bots are all fine"), "no 'all fine' wording that ignores the no-Bot case");
});

test("pages show a loading state from static HTML", () => {
  assert.match(pub("index.html"), /<div id="root"><div class="boot"[^>]*>.*Loading…/);
  assert.match(pub("connect.html"), /id="c"><div class="boot"[^>]*>.*Loading…/);
  assert.match(pub("invite.html"), /id="c">Loading…/);
});

let S: Awaited<ReturnType<typeof startServer>>;
before(async () => { S = await startServer(); });
after(async () => { await S.stop(); });

test("invite page: friendly unknown-invite text and console capability labels", async () => {
  const html = await (await fetch(S.base + "/i/doesnotexist")).text();
  assert.ok(html.includes('invite_not_found:"This invite does not exist or was revoked."'));
  assert.ok(!html.includes("esc(i.error.code)"), "raw error code must not be rendered");
  assert.ok(html.includes('"chat.public":"Chat"') && html.includes('"profile.read":"Profile"'));
  const { CAP_LABEL } = loadConsole(["CAP_LABEL"]);
  for (const [k, v] of Object.entries(CAP_LABEL)) assert.ok(html.includes(`"${k}":"${v}"`), `invite page label for ${k}`);
  // The API the page reads still answers with the code it maps.
  const r = await fetch(S.base + "/v1/invites/doesnotexist");
  assert.equal(r.status, 404);
  assert.equal((await r.json()).error.code, "invite_not_found");
});
