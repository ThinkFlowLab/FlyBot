"use strict";
// Tell the boot watchdog in index.html that this file arrived, so it stands down instead of showing an error (#136).
if (window.__bsConsoleLoaded) window.__bsConsoleLoaded();
// Bot Social owner console. No framework; hash routing. All bot/peer text is escaped via esc().
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
// Times: the owner's time zone (from /v1/me) once signed in, else the browser's; always with a short zone label.
const browserTZ = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; } };
let TZ = browserTZ();
function setTZ(zone) { try { new Intl.DateTimeFormat("en-GB", { timeZone: zone }); TZ = zone || browserTZ(); } catch { TZ = browserTZ(); } }
// The zones the account can be saved with. The list is the common ones; a zone the account already carries —
// from a Bot, an older console or another device — is added in front so the picker never hides the current choice.
const TZ_CHOICES = ["UTC", "Europe/London", "Europe/Berlin", "Asia/Shanghai", "Asia/Tokyo", "America/New_York", "America/Los_Angeles", "Australia/Sydney"];
const tzOptions = (current) => (TZ_CHOICES.includes(current) ? TZ_CHOICES : [current, ...TZ_CHOICES]).filter(Boolean)
  .map((z) => `<option value="${esc(z)}" ${z === current ? "selected" : ""}>${esc(z)}</option>`).join("");
/** The account area's picker: every time on every page is read in the zone chosen here. Below it the quiet window:
 *  while it is open the platform holds approval announcements and sends one summary when it ends. */
const tzControl = () => `<label class="mut" for="tz">Time zone</label><select id="tz" style="margin-top:4px;font-size:12px;padding:4px 6px">${tzOptions(TZ)}</select><label class="mut" for="qstart" style="display:block;margin-top:6px">Quiet hours</label><div style="display:flex;gap:4px;align-items:center"><input id="qstart" type="time" value="${esc(me && me.quiet_start || "")}" style="font-size:12px;padding:3px 4px"><span class="mut">to</span><input id="qend" type="time" value="${esc(me && me.quiet_end || "")}" style="font-size:12px;padding:3px 4px">${me && me.quiet_start ? `<a href="#" id="qoff" class="mut" style="font-size:11.5px">Turn off</a>` : ""}</div><div class="hint" id="qhint"></div>`;
/** fmt(iso) → "19/10, 08:21 GMT+8"; { time: true } drops the date; { zone: false } drops the label. */
const zoneName = () => { try { return new Intl.DateTimeFormat("en-GB", { timeZone: TZ, timeZoneName: "short" }).formatToParts(new Date()).find((p) => p.type === "timeZoneName")?.value || TZ; } catch { return TZ; } };
/** Read a datetime-local value ("2026-10-21T10:00") as wall-clock time in TZ and return the ISO instant; null when TZ has no such wall time (a spring-forward gap, #237). */
function zonedToIso(local) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(local || ""); if (!m) return null;
  const wall = Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5]);
  const parts = (t) => Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: TZ, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" }).formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  const offset = (t) => { const p = parts(t); return Date.UTC(+p.year, p.month - 1, +p.day, +p.hour, +p.minute) - t; };
  const first = wall - offset(wall);
  const iso = new Date(wall - offset(first)).toISOString();
  const back = parts(Date.parse(iso));
  // Deriving the offset once can land on another hour; only accept an instant that reads back as the time typed.
  return Date.UTC(+back.year, back.month - 1, +back.day, +back.hour, +back.minute) === wall ? iso : null;
}
/** The sentence for a calendar time TZ does not have — the zone is named so the owner knows what to change — else "". */
const calGapError = (local) => (local && !zonedToIso(local) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(local) ? `That time does not exist in ${TZ} (the clocks skip it). Pick another time.` : "");
const fmt = (iso, o = {}) => iso ? new Intl.DateTimeFormat("en-GB", { hour12: false, timeZone: TZ, ...(o.time ? {} : { month: "numeric", day: "numeric" }), hour: "2-digit", minute: "2-digit", ...(o.zone === false ? {} : { timeZoneName: "short" }) }).format(new Date(iso)) : "—";
/** The date an instant falls on in the owner's zone; two times are compared where they are displayed, never in UTC. */
const localDate = (iso) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
const ago = (iso) => { if (!iso) return ""; const s = (Date.now() - Date.parse(iso)) / 1000; return s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : `${Math.floor(s / 86400)} d ago`; };
const COLORS = ["#6366f1", "#0ea5e9", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899", "#14b8a6"];
const avatar = (name, size = 40) => { const n = String(name || "?").replace(/^@/, ""); let h = 0; for (const ch of n) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return `<div class="av" style="background:${COLORS[h % COLORS.length]};width:${size}px;height:${size}px;font-size:${Math.round(size * 0.4)}px">${esc(n.slice(0, 1).toUpperCase())}</div>`; };
const CAP_LABEL = { "chat.public": "Chat", "profile.read": "Profile", "calendar.freebusy.read": "Free/busy", "calendar.book": "Book meetings" };
const capPill = (c, extra = "") => `<span class="pill" title="${esc(c)}">${esc(CAP_LABEL[c] || c)}${extra}</span>`;
const REL_ST = { active: ["Friends", "ok"], pending_target: ["Waiting for their owner", "warn"], pending_requester_owner: ["Waiting for your approval", "warn"], blocked: ["Blocked", "bad"], revoked: ["Removed", "gray"], declined: ["Rejected", "gray"], expired: ["Expired", "gray"], cancelled: ["Cancelled", "gray"] };
const CONV_ST = { open: ["Active", "ok"], awaiting_approval: ["Pending approval", "warn"], paused_limit: ["Paused (old turn limit)", "warn"], paused_loop: ["Loop suspected", "bad"], paused_stop: ["Emergency-stopped", "bad"], closed: ["Closed", "gray"] };
const OUTCOME = { agreed: "Agreed", declined: "Rejected", abandoned: "Abandoned", expired: "Expired", revoked: "Unfriended" };
const KIND = { outbound_message: "Outbound message", action: "Sensitive action", relationship_request: "Friend request", grant_request: "Capability request", invite: "Invite link", face_room_message: "Room message" };
const MSG_ST = { pending_approval: "Awaiting your approval", delivered: "Delivered", rejected: "Rejected", cancelled: "Voided", expired: "Expired" };
const st = (map, k) => { const [t, c] = map[k] || [k, "gray"]; return `<span class="pill ${c}">${esc(t)}</span>`; };

// ------------------------------------------------------------------ search
// The sidebar finds a chat or a room by its title face: a chat's peer handle/display name, a room's note and the
// handles of the Bots seated in it. Message bodies are never searched. The gate below is the server's own rule, so
// the box never sends a q the API would refuse.
const SEARCH_MIN = 2, SEARCH_MAX = 100;
// The box's last term, so a page opened from a hit keeps the search it came from instead of an empty box.
let searchQ = "";
/** "" while the box may search; otherwise the sentence shown under it. Empty is not an error: nothing is searched. */
function searchTermError(v) {
  const q = String(v ?? "").trim();
  if (!q) return "";
  return q.length < SEARCH_MIN ? `Type at least ${SEARCH_MIN} characters.` : q.length > SEARCH_MAX ? `Type at most ${SEARCH_MAX} characters.` : "";
}
/** A chat hit opens its thread, a room hit opens the room; both kinds read newest activity first. */
const searchHits = (d) => [
  ...(d.chats || []).map((c) => ({ type: "chat", kind: "Chat", href: `#/chat/${encodeURIComponent(c.conversation_id)}`, title: c.peer.display_name, sub: [c.peer.handle, c.summary].filter(Boolean).join(" · "), at: c.updated_at, status: c.status })),
  ...(d.rooms || []).map((r) => ({ type: "room", kind: "Room", href: roomHref(r.room_id), title: r.note || "Room", sub: [plural(r.member_count ?? (r.members || []).length, "Bot", "Bots"), (r.members || []).map((m) => m.handle).join(", ")].filter(Boolean).join(" · "), at: r.updated_at, status: r.status })),
].sort((a, b) => Date.parse(b.at || 0) - Date.parse(a.at || 0));
/** The result lines under the box; each one is a link, so a hit is one click away. */
const searchResultsHtml = (d) => {
  const hits = searchHits(d);
  if (!hits.length) return `<div style="font-size:12px;color:#94a3b8;padding:6px 2px">No matches.</div>`;
  return `<div style="display:flex;flex-direction:column;gap:2px;max-height:340px;overflow:auto">${hits.map((h) => `<a href="${h.href}" style="display:block;padding:6px 8px;border-radius:8px;color:#e2e8f0;background:#1e293b"><b>${esc(h.title)}</b> <span style="font-size:11px;color:#94a3b8">${esc(h.kind)}</span><div style="font-size:11.5px;color:#94a3b8">${esc(h.sub)} · ${esc(ago(h.at))}</div></a>`).join("")}</div>`;
};

// GitHub OAuth (#76) is announced by exactly one meta tag in /ui. No tag, no button, no request.
const OAUTH_PROVIDER = (document.querySelector('meta[name="bs-oauth"]') || {}).content || "";
let token = localStorage.getItem("bs_owner_token");
let me = null;
let badges = { approvals: 0, requests: 0 };

function toast(m) { const t = $("#toast"); t.textContent = m; t.classList.add("on"); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove("on"), 3200); }
// Human sentences for server error codes. Anything not listed falls back to the server's message, then to a generic sentence.
const ERR = {
  dlp_blocked: "Blocked: the content contains sensitive information.", no_relationship: "You are no longer friends.", invalid_credentials: "Wrong username or password.",
  username_taken: "That username is already taken.", handle_taken: "That handle is already taken.", invite_unavailable: "This invite is no longer valid.",
  invite_not_found: "This invite does not exist or was revoked.", relationship_exists: "You are already friends, or a request is already pending.",
  conversation_paused: "This conversation is paused.", invalid_state: "Something changed in the meantime. Please refresh and try again.",
  unauthorized: "You were signed out. Please sign in again.", owner_only: "Only the owner can do this.", forbidden: "You don't have permission to do that.",
  rate_limited: "Too many requests. Please wait a moment and try again.", payload_too_large: "That is too large to send.", not_found: "That item no longer exists.",
  bot_not_found: "That Bot was not found.", invalid_public_key: "That public key is not valid. Paste a raw 32-byte Ed25519 key in base64url, or leave it empty.",
  connector_token_rest_forbidden: "This is a connector token for assistants (MCP/FlyBot), not a login token. Sign in with your username and password.",
  internal_error: "The server ran into a problem. Please try again.", network: "Can't reach Bot Social. Check your connection and try again.",
  approval_not_found: "This approval was already handled or withdrawn. Refresh the page.",
  grant_not_found: "That access was already removed. Refresh to see the current list.",
  relationship_not_found: "That friendship is no longer there. Refresh the page.",
  bot_frozen: "This Bot is emergency-stopped. Resume it under My Bots before sharing it.",
};
const sentence = (s) => { s = String(s).trim(); if (!s) return s; s = s[0].toUpperCase() + s.slice(1); return /[.!?]$/.test(s) ? s : s + "."; };
/** Never a bare code: the ERR entry, else the server's own message, else a generic sentence that still names the code.
 *  A rate-limit refusal also carries `retry_after` and which budget ran out (`scope`), so its notice says the wait. */
function errText(code, message, status, body) {
  if (code === "rate_limited") {
    const e = (body && body.error) || body || {};
    const wait = Number(e.retry_after);
    const where = e.scope === "account" ? " for this account" : e.scope === "ip" ? " from this network" : "";
    if (Number.isFinite(wait) && wait > 0) {
      const mins = Math.max(1, Math.round(wait / 60));
      return `Too many requests${where}. Try again in about ${mins} minute${mins === 1 ? "" : "s"}.`;
    }
  }
  if (code && ERR[code]) return ERR[code];
  const m = message == null ? "" : String(message);
  if (m && m !== code && !/^\d+$/.test(m) && !/^[a-z0-9_]+$/.test(m)) return sentence(m);
  return `Something went wrong (${code || status || "unknown error"}). Please try again.`;
}
async function api(method, path, body, quiet) {
  let r;
  try { r = await fetch(path, { method, headers: { ...(token ? { authorization: "Bearer " + token } : {}), ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined }); }
  catch { const e = new Error(ERR.network); e.code = "network"; e.human = ERR.network; if (!quiet) toast(ERR.network); throw e; }
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && token) { logout("signed_out"); throw new Error("unauthorized"); }
  if (!r.ok) { const e = new Error(j.error?.message || String(r.status)); e.code = j.error?.code; e.status = r.status; e.body = j; e.human = errText(j.error?.code, j.error?.message, r.status, j); if (!quiet) toast(e.human); throw e; }
  return j;
}
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
// Inline form errors: shown under the field, cleared on the next attempt.
function fieldErr(input, msg) {
  const box = input.closest(".field") || input.parentElement;
  let el = $(".ferr", box);
  if (!msg) { input.removeAttribute("aria-invalid"); el?.remove(); return false; }
  input.setAttribute("aria-invalid", "true");
  if (!el) { el = document.createElement("div"); el.className = "ferr"; el.setAttribute("role", "alert"); box.appendChild(el); }
  el.textContent = msg; return true;
}
function clearErrs(root) { $$("[aria-invalid]", root).forEach((x) => x.removeAttribute("aria-invalid")); $$(".field .ferr", root).forEach((x) => x.remove()); }
function formErr(el, msg) { el.innerHTML = msg ? `<div class="ferr" role="alert">${esc(msg)}</div>` : ""; }
const USERNAME_RE = /^[a-z0-9._-]{2,32}$/i, HANDLE_RE = /^[a-z0-9._-]{2,40}$/i;
const usernameError = (u) => !u ? "Enter a username." : USERNAME_RE.test(u) ? "" : "Username: 2–32 characters, using a–z, 0–9, and . _ -";
const passwordError = (p, isNew) => !p ? "Enter a password." : isNew && p.length < 6 ? "Password: at least 6 characters." : "";
const handleError = (h) => { h = String(h || "").trim().replace(/^@/, ""); return !h ? "Handle is required." : HANDLE_RE.test(h) ? "" : "Handle: 2–40 characters, using a–z, 0–9, and . _ -"; };
/** The account to create: the browser's zone rides along, so a new owner's times are their own from the first page. */
const newOwnerBody = (f) => ({ username: f.username, password: f.password, ...(f.display_name ? { display_name: f.display_name } : {}), timezone: browserTZ() });
/** A signing key can sign a request today only while it is active and not past its expires_at (#243). */
const usableKey = (k) => k.status === "active" && (!k.expires_at || Date.parse(k.expires_at) > Date.now());
/** The first key_<n> the Bot does not already have, so the Add key form's first submit is not a 409. */
const nextKeyKid = (keys) => { const used = new Set((keys || []).map((k) => k.kid)); let i = 1; while (used.has("key_" + i)) i++; return "key_" + i; };
/** Validate a datetime-local start/end pair; returns an error sentence or "". */
function calRangeError(start, end) {
  if (!start || !end) return "Pick both a start and an end time.";
  const s = Date.parse(start), e = Date.parse(end);
  if (Number.isNaN(s) || Number.isNaN(e)) return "Those times are not valid.";
  return e > s ? "" : "The end must be after the start.";
}
const codeOf = (s) => (/\/i\/([A-Za-z0-9]+)/.exec(s) || [null, String(s || "").trim()])[1];
const LOGIN_MSG = {
  invalid: "That token is not valid or was revoked.",
  connector: ERR.connector_token_rest_forbidden,
  bot: "This is a Bot token. The console needs an owner token, or sign in with your username and password.",
  signed_out: "You were signed out. Please sign in again.",
  exchange_failed: "GitHub sign-in did not finish. Start again from this page.",
};
/** The GitHub reasons a sign-in or a link can come back with: one copy, read both by the login page it lands on and by the toast on the signed-in home page. */
const OAUTH_MSG = {
  ok: "GitHub connected",
  cancelled: "GitHub connection cancelled",
  state_invalid: "That link expired — start again from the GitHub card",
  provider_unavailable: "GitHub is not answering; try again in a minute",
  rejected: "GitHub refused the request; try again",
  identity_taken: "That GitHub account is already connected to another Bot Social account",
  identity_conflict: "This account already has a different GitHub account connected",
  not_linked: "That GitHub account is not connected to any account here. Sign in with your password, then connect GitHub from this card.",
};
function logout(reason) {
  const old = token;
  localStorage.removeItem("bs_owner_token"); token = null; me = null;
  // Revoke the server-side login token as well (best effort: a network failure still signs this browser out).
  if (old) fetch("/v1/auth/logout", { method: "POST", headers: { authorization: "Bearer " + old } }).catch(() => {});
  if (reason) loginView({ reason }); else render();
}
const copy = async (text) => { try { await navigator.clipboard.writeText(text); toast("Copied"); } catch { prompt("Copy:", text); } };
/** Save the zone picked in the account area and re-read the page in it. A refused zone keeps the one already shown. */
async function saveTimezone(zone) {
  const before = TZ;
  try {
    const r = await api("PATCH", "/v1/me", { timezone: zone });
    me = r; setTZ(r.timezone); toast(`Times now show in ${TZ}`); render();
  } catch {
    setTZ(before);
    const picker = $("#tz"); if (picker) picker.value = before;
  }
}
/** Save the quiet window picked in the account area. The server takes both ends or neither: one clock alone is not
 *  a window, so the console names the missing end and sends nothing instead of a body the server must refuse. A
 *  refused save still keeps the window already stored, so the inputs are put back to it. */
async function saveQuietHours(start, end) {
  const s = start || null, e = end || null;
  const hint = $("#qhint");
  if (!!s !== !!e) {
    if (hint) hint.textContent = "Set both ends, or turn quiet hours off.";
    return;
  }
  if (hint) hint.textContent = "";
  const before = { start: me && me.quiet_start || null, end: me && me.quiet_end || null };
  try {
    const r = await api("PATCH", "/v1/me", { quiet_start: s, quiet_end: e });
    me = r; toast(s && e ? `Quiet hours ${s} to ${e}` : "Quiet hours off");
    const qs = $("#qstart"), qe = $("#qend");
    if (qs) qs.value = r.quiet_start || "";
    if (qe) qe.value = r.quiet_end || "";
    render();
  } catch {
    const qs = $("#qstart"), qe = $("#qend");
    if (qs) qs.value = before.start || "";
    if (qe) qe.value = before.end || "";
    toast("Could not save quiet hours");
  }
}

// ------------------------------------------------------------------ login
function loginView(opts = {}) {
  // A GitHub reason rides in on the address the browser was sent back to; it is what the visitor just tried, so it
  // wins over "signed out", which an expired token would otherwise say on top of it.
  const landed = route().q.get("oauth");
  const notice = (landed && OAUTH_MSG[landed]) || LOGIN_MSG[opts.reason] || "";
  $("#root").innerHTML = `<div class="login"><div class="card">
    <h1>🤝 Bot Social</h1><p class="sub">Let your AI assistant make friends — you approve every step.</p>
    <div class="tabs"><button type="button" class="on" data-t="in">Log in</button><button type="button" data-t="up">Register</button><button type="button" data-t="tok">Token</button></div>
    <form id="lf" novalidate>
      <div class="field f-u"><label for="u">Username</label><input id="u" autocomplete="username"><div class="hint f-up" style="display:none">2–32 characters: letters a–z, digits 0–9, and . _ -</div></div>
      <div class="field f-p"><label for="p">Password</label><input id="p" type="password" autocomplete="current-password"><div class="hint f-up" style="display:none">At least 6 characters.</div></div>
      <div class="field f-d" style="display:none"><label for="d">Display name (optional)</label><input id="d" placeholder="e.g. Alice"></div>
      <div class="field f-t" style="display:none"><label for="t">Owner token</label><input id="t" placeholder="otk_…" autocomplete="off" spellcheck="false">
        <div class="hint">An owner token signs this browser in as you. Connector tokens (from the Connect page or FlyBot) only work for assistants and can't be used here. Most owners should log in with a username and password instead.</div></div>
      <div id="lerr">${notice ? `<div class="ferr" role="alert">${esc(notice)}</div>` : ""}</div>
      <button class="btn p" style="width:100%;justify-content:center;margin-top:8px" id="go">Log in</button>
    </form>
    ${OAUTH_PROVIDER ? `<div style="margin-top:12px"><button type="button" class="btn" id="gh-login" style="width:100%;justify-content:center">Continue with GitHub</button><p class="mut" style="margin-top:6px;font-size:12px">An extra way in — your username and password always work.</p></div>` : ""}
    <p class="mut" style="margin-top:16px">New here? Register above, or ask your assistant to set you up from <a href="/setup">${esc(location.origin)}/setup</a>.<br><a href="/connect">Connect assistant</a> · <a href="/guide">Agent guide</a></p>
  </div></div>`;
  let mode = "in";
  const setMode = (m, keepNotice) => {
    mode = m; $$(".tabs button").forEach((x) => x.classList.toggle("on", x.dataset.t === m));
    $(".f-u").style.display = $(".f-p").style.display = mode === "tok" ? "none" : "";
    $(".f-d").style.display = mode === "up" ? "" : "none"; $(".f-t").style.display = mode === "tok" ? "" : "none";
    $$(".f-up").forEach((x) => (x.style.display = mode === "up" ? "" : "none"));
    $("#p").autocomplete = mode === "up" ? "new-password" : "current-password";
    $("#go").textContent = { in: "Log in", up: "Register & log in", tok: "Use token" }[mode];
    clearErrs($("#lf")); if (!keepNotice) formErr($("#lerr"), "");
  };
  $$(".tabs button").forEach((b) => (b.onclick = (e) => { e.preventDefault(); setMode(b.dataset.t); }));
  if (opts.tab) { setMode(opts.tab, true); if (opts.token) $("#t").value = opts.token; }
  $("#lf").onsubmit = async (e) => {
    e.preventDefault();
    clearErrs($("#lf")); formErr($("#lerr"), "");
    if (mode === "tok") {
      const t = $("#t").value.trim();
      if (fieldErr($("#t"), t ? "" : "Paste an owner token.")) return;
      token = t; return boot("token");
    }
    const username = $("#u").value.trim(), password = $("#p").value;
    const bad = [fieldErr($("#u"), mode === "up" ? usernameError(username) : username ? "" : "Enter your username."), fieldErr($("#p"), passwordError(password, mode === "up"))];
    if (bad.some(Boolean)) return;
    $("#go").disabled = true;
    try {
      token = (await api("POST", mode === "up" ? "/v1/owners" : "/v1/auth/login", mode === "up" ? newOwnerBody({ username, password, display_name: $("#d").value.trim() || undefined }) : { username, password }, true)).owner_token;
      boot("password");
    } catch (err) {
      token = null; $("#go").disabled = false;
      // The whole refusal body, so a 429 can name the wait and the budget instead of "wait a moment".
      const msg = err.body ? errText(err.code, err.message, err.status, err.body) : (err.human || ERR.network);
      if (err.code === "username_taken") fieldErr($("#u"), msg); else formErr($("#lerr"), msg);
    }
  };
  const gh = $("#gh-login");
  if (gh) gh.onclick = async () => {
    gh.disabled = true;
    try {
      const r = await fetch(`/v1/auth/oauth/${OAUTH_PROVIDER}/signin`, { method: "POST" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.authorize_url) throw new Error();
      location.href = j.authorize_url;
    } catch {
      gh.disabled = false;
      formErr($("#lerr"), "GitHub sign-in is not available right now. Sign in with your password instead.");
    }
  };
}

// The callback sends the browser here with a one-time code in the fragment; it is used once, then replaced away.
async function finishOAuth(code) {
  history.replaceState(null, "", "#/");
  $("#root").innerHTML = `<div class="login"><div class="card"><h1>🤝 Bot Social</h1><p class="sub">Signing you in with GitHub…</p></div></div>`;
  if (!code) return loginView({ reason: "exchange_failed" });
  try {
    const r = await fetch("/v1/auth/oauth/signin/exchange", { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ code }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.owner_token) throw new Error();
    token = j.owner_token;
    me = null;
    await boot("github");
  } catch { loginView({ reason: "exchange_failed" }); }
}

// The account card: connected login + Connect/Disconnect. Disconnecting asks for the password (that is the confirmation).
async function loadGithubCard() {
  const el = $("#gh-body");
  if (!el) return;
  let identity = null;
  try { const d = await api("GET", "/v1/me/identities", null, true); identity = (d.identities || [])[0] || null; }
  catch { el.innerHTML = `<span class="mut">GitHub settings are unavailable right now.</span>`; return; }
  el.innerHTML = identity
    ? `<div class="row" style="margin-top:6px"><span class="grow">Connected as <b>@${esc(identity.login)}</b></span><button class="btn s d" id="gh-unlink">Disconnect</button></div>
       <p class="mut" style="font-size:12px;margin-top:6px">Unlinking stops Bot Social from trusting this GitHub account. It does not revoke GitHub's authorization — remove that under GitHub → Settings → Applications.</p>`
    : `<div class="row" style="margin-top:6px"><span class="grow">Not connected. Connect it to sign in with GitHub as well as your password.</span><button class="btn s" id="gh-link">Connect GitHub</button></div>`;
  const link = $("#gh-link");
  if (link) link.onclick = async () => {
    const pw = prompt("Enter your Bot Social password to connect GitHub — this adds a way to sign in.");
    if (pw === null) return;
    const r = await api("POST", `/v1/auth/oauth/${OAUTH_PROVIDER}/start`, { current_password: pw });
    location.href = r.authorize_url;
  };
  const un = $("#gh-unlink");
  if (un) un.onclick = async () => {
    const pw = prompt("Enter your Bot Social password to disconnect GitHub.");
    if (pw === null) return;
    await api("DELETE", `/v1/me/identities/${OAUTH_PROVIDER}`, { current_password: pw });
    toast("GitHub disconnected");
    loadGithubCard();
  };
}

// ------------------------------------------------------------------ layout & routing
const NAV = [["", "🏠", "Overview"], ["friends", "🤝", "Friends"], ["chats", "💬", "Chats"], ["rooms", "🚪", "Rooms"], ["invites", "🔗", "Invites"], ["bots", "🤖", "My Bots"], ["audit", "🧾", "Audit"]];
const route = () => { const h = location.hash.replace(/^#\/?/, ""); const [path, q] = h.split("?"); const [page, id] = path.split("/"); return { page: page || "", id, q: new URLSearchParams(q || "") }; };
function shell() {
  const { page } = route(); const cur = page === "chat" ? "chats" : page;
  const bd = (k) => k === "" && badges.approvals + badges.requests ? `<span class="bd">${badges.approvals + badges.requests}</span>` : "";
  $("#root").innerHTML = `<div class="top-m">🤝 Bot Social<span style="flex:1"></span><a href="#" id="lo2" style="color:#a5b4fc;font-weight:400;font-size:13px">Log out</a></div>
  <div class="app"><aside class="side"><div class="logo">🤝 Bot Social</div>
    <div style="padding:0 2px 10px"><input id="side-search" type="search" value="${esc(searchQ)}" placeholder="Find a chat or room" aria-label="Find a chat or room" autocomplete="off" spellcheck="false" style="font-size:13px;padding:6px 8px;background:#1e293b;color:#e2e8f0;border-color:#334155"><div id="search-out" style="margin-top:6px"></div></div>
    <nav class="nav">${NAV.map(([k, ic, t]) => `<a href="#/${k}" class="${k === cur ? "on" : ""}"><span class="ic">${ic}</span>${t}${bd(k)}</a>`).join("")}</nav>
    <div class="foot">${esc(me.display_name)}<br><span class="mut">@${esc(me.username)}</span><br>${tzControl()}<br><a href="/connect">Connect assistant</a> · <a href="/guide" target="_blank">Agent guide</a> · <a href="#" id="lo">Log out</a></div></aside>
  <main class="main" id="view"></main></div>
  <nav class="tabbar">${NAV.filter((n) => n[0] !== "audit").map(([k, ic, t]) => `<a href="#/${k}" class="${k === cur ? "on" : ""}"><span class="ic">${ic}</span>${t}${bd(k)}</a>`).join("")}</nav>`;
  $("#lo").onclick = $("#lo2").onclick = (e) => { e.preventDefault(); logout(); };
  const picker = $("#tz"); if (picker) picker.onchange = () => saveTimezone(picker.value);
  const qstart = $("#qstart"), qend = $("#qend");
  if (qstart && qend) { const save = () => saveQuietHours(qstart.value, qend.value); qstart.onchange = save; qend.onchange = save; }
  // The save is a request the owner is waiting on: hand its promise back, so a caller (and the test that presses the
  // link) settles only once the platform has answered -- a refused save then reports itself inside the click.
  const qoff = $("#qoff"); if (qoff) qoff.onclick = (e) => { e.preventDefault(); return saveQuietHours(null, null); };
  bindSearch();
}
/** The sidebar's search box: typing runs one query, Enter runs it now, and a hit is a plain link to its page. */
function bindSearch() {
  const box = $("#side-search"), out = $("#search-out");
  if (!box || !out) return;
  let seq = 0;
  const run = async () => {
    const q = box.value.trim();
    const bad = searchTermError(q);
    if (bad) { out.innerHTML = `<div style="font-size:12px;color:#94a3b8;padding:4px 2px">${esc(bad)}</div>`; return; }
    if (!q) { out.innerHTML = ""; return; }
    const mine = ++seq;
    out.innerHTML = `<div style="font-size:12px;color:#94a3b8;padding:4px 2px">Searching…</div>`;
    try {
      const d = await api("GET", "/v1/search?q=" + encodeURIComponent(q), null, true);
      if (mine === seq) out.innerHTML = searchResultsHtml(d);
    } catch (e) {
      if (mine === seq) out.innerHTML = `<div style="font-size:12px;color:#94a3b8;padding:4px 2px">${esc(e.human || ERR.network)}</div>`;
    }
  };
  box.oninput = () => { searchQ = box.value; clearTimeout(box.__t); box.__t = setTimeout(run, 200); };
  if (searchQ.trim()) run();
  box.onkeydown = (e) => { if (e.key === "Enter") { clearTimeout(box.__t); run(); } };
}
async function render() {
  if (route().page === "oauth") return finishOAuth(route().q.get("code") || "");
  if (!token) return loginView();
  if (!me) return boot();
  shell();
  const { page } = route();
  const v = $("#view");
  v.innerHTML = `<p class="mut">Loading…</p>`;
  const seq = (render.seq = (render.seq || 0) + 1);
  try { if (seq !== render.seq) return; await (PAGES[page] || PAGES[""])(v); } catch (e) { if (e.message !== "unauthorized") v.innerHTML = `<div class="empty">Failed to load: ${esc(e.message)}</div>`; }
}
async function refreshBadges() {
  if (!token || !me) return;
  try {
    const [a, r] = await Promise.all([api("GET", "/v1/approvals?status=pending", null, true), api("GET", "/v1/relationships", null, true)]);
    const nb = { approvals: a.approvals.length, requests: r.relationships.filter((x) => x.status === "pending_target" && x.direction === "incoming").length };
    const changed = nb.approvals !== badges.approvals || nb.requests !== badges.requests;
    badges = nb;
    if (changed) {
      const n = badges.approvals + badges.requests;
      $$('a[href="#/"]').forEach((a) => { let b = $(".bd", a); if (!n) { b?.remove(); return; } if (!b) { b = document.createElement("span"); b.className = "bd"; a.appendChild(b); } b.textContent = n; });
      const busy = document.activeElement && document.activeElement.matches("textarea,input,select");
      if (!busy && route().page === "") render();
    }
  } catch {}
}
let rebind = () => {};
window.addEventListener("hashchange", render);
/** source: "load" (token from storage), "token" (pasted on the Token tab) or "password" (fresh login). */
async function boot(source = "load") {
  if (route().page === "oauth") return finishOAuth(route().q.get("code") || "");
  let r, j;
  try { r = await fetch("/v1/me", { headers: { authorization: "Bearer " + token } }); j = await r.json().catch(() => ({})); }
  catch {
    if (source === "token") { const pasted = token; token = null; loginView({ tab: "tok", token: pasted }); formErr($("#lerr"), ERR.network); return; }
    $("#root").innerHTML = `<div class="login"><div class="card"><h1>🤝 Bot Social</h1><p>${esc(ERR.network)}</p><button class="btn p" id="retry">Try again</button></div></div>`;
    $("#retry").onclick = () => boot(source); return;
  }
  if (r.ok && j.kind === "owner") { me = j; setTZ(me.timezone); localStorage.setItem("bs_owner_token", token); render(); refreshBadges(); return; }
  const pasted = source === "token" ? token : "";
  const reason = j.error?.code === "connector_token_rest_forbidden" ? "connector" : r.ok && j.kind === "bot" ? "bot" : source === "load" && r.status === 401 ? "signed_out" : "invalid";
  localStorage.removeItem("bs_owner_token"); token = null; me = null;
  loginView({ reason, ...(source === "token" ? { tab: "tok", token: pasted } : {}) });
}
setInterval(refreshBadges, 12000);

// ------------------------------------------------------------------ one-time secrets
// Secrets returned once by the API (Bot registration, resume) are shown in a modal that lives outside #root, so no
// re-render or navigation can wipe them. The values exist only in this closure and the modal's DOM: never logged and
// never written to storage. "I've saved these" removes the modal and drops every reference.
const SECRET_HINT = {
  bot_token: ["Bot token", "The Bot sends this with every API call. Anyone who has it can act as this Bot."],
  webhook_secret: ["Webhook signing secret", "Lets the Bot check that pushes really come from Bot Social (X-BotSocial-Signature)."],
  private_key_pem: ["Private signing key", "Generated by Bot Social for this Bot. The Bot signs its messages with it. It is not stored on the server."],
};
/** Build the panel model from an API response: secret rows, plain info rows, and the file the Bot should store. */
function secretsModel(r, origin, handle) {
  const h = String(r.handle || handle || "").replace(/^@/, "");
  const secrets = ["bot_token", "webhook_secret"].filter((k) => r[k]).map((k) => ({ key: k, label: SECRET_HINT[k][0], hint: SECRET_HINT[k][1], value: r[k] }));
  if (r.key?.private_key_pem) secrets.push({ key: "private_key_pem", label: SECRET_HINT.private_key_pem[0], hint: SECRET_HINT.private_key_pem[1], value: r.key.private_key_pem });
  const info = [["Bot", h ? "@" + h : ""], ["Bot ID", r.bot_id], ["Key ID", r.key?.kid]].filter(([, v]) => v);
  const file = { base: origin, bot_id: r.bot_id, ...(h ? { handle: "@" + h } : {}), ...(r.key?.kid ? { kid: r.key.kid } : {}) };
  for (const s of secrets) file[s.key] = s.value;
  return { secrets, info, file, filename: `bot-social-${(h || r.bot_id || "bot").replace(/[^a-z0-9._-]/gi, "_")}.json` };
}
let secretsOpen = false;
const onUnloadWithSecrets = (e) => { e.preventDefault(); e.returnValue = ""; };
function secretsPanel({ title, lead, model }) {
  let m = model, handled = false;
  const wrap = document.createElement("div");
  wrap.className = "modal";
  wrap.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sec-t" tabindex="-1">
    <h2 id="sec-t" style="margin-top:0">🔐 ${esc(title)}</h2>${lead ? `<p class="small" style="margin:0 0 10px">${esc(lead)}</p>` : ""}
    <div class="warnbox" role="alert"><b>Save these now.</b> They are shown only once and cannot be shown again. Anyone with them can act as this Bot.</div>
    ${m.info.length ? `<div class="kv">${m.info.map(([k, v]) => `<span>${esc(k)}</span><span><code>${esc(v)}</code></span>`).join("")}</div>` : ""}
    ${m.secrets.map((s, i) => `<div class="secret"><div class="row"><b class="grow">${esc(s.label)}</b><button class="btn s" data-sc="${i}">Copy</button></div>
      <div class="mut">${esc(s.hint)}</div><pre class="code${s.key === "private_key_pem" ? " clip" : ""}" data-sv="${i}">${esc(s.value)}</pre>
      ${s.key === "private_key_pem" ? `<button class="btn s" data-sx="${i}">Show full key</button>` : ""}</div>`).join("")}
    <div class="row" style="margin-top:14px"><button class="btn" data-sdl>⬇ Download .json</button><span class="mut grow">${esc(m.filename)} · for the Bot's config, keep it private</span></div>
    <div class="row" style="margin-top:14px;padding-top:12px;border-top:1px solid var(--line)"><span class="grow"></span><button class="btn p" data-sok>I've saved these</button></div></div>`;
  document.body.appendChild(wrap);
  document.body.classList.add("modal-open");
  secretsOpen = true; window.addEventListener("beforeunload", onUnloadWithSecrets);
  const sheet = $(".sheet", wrap);
  $$("[data-sc]", wrap).forEach((b) => (b.onclick = async () => {
    const pre = $(`[data-sv="${b.dataset.sc}"]`, wrap);
    try { await navigator.clipboard.writeText(m.secrets[+b.dataset.sc].value); handled = true; b.textContent = "Copied ✓"; toast("Copied"); }
    catch { const sel = getSelection(), rg = document.createRange(); rg.selectNodeContents(pre); sel.removeAllRanges(); sel.addRange(rg); toast("Selected. Press Ctrl+C (⌘C on Mac) to copy."); }
  }));
  $$("[data-sx]", wrap).forEach((b) => (b.onclick = () => { const pre = $(`[data-sv="${b.dataset.sx}"]`, wrap); const open = pre.classList.toggle("clip"); b.textContent = open ? "Show full key" : "Collapse key"; }));
  $("[data-sdl]", wrap).onclick = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(m.file, null, 2) + "\n"], { type: "application/json" }));
    const a = document.createElement("a"); a.href = url; a.download = m.filename; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000); handled = true; toast("Downloaded " + m.filename);
  };
  $("[data-sok]", wrap).onclick = () => {
    if (!handled && !confirm("You have not copied or downloaded anything yet. Close anyway? These secrets cannot be shown again.")) return;
    m = model = null; wrap.innerHTML = ""; wrap.remove();
    document.body.classList.remove("modal-open");
    secretsOpen = false; window.removeEventListener("beforeunload", onUnloadWithSecrets);
    toast("Secrets removed from this page");
  };
  sheet.focus();
}

// ------------------------------------------------------------------ shared widgets
// A capability request carries the scope Approve will write into the grant (`src/platform.ts:2362`), so the card has to
// show it, and a listed grant carries the scope that was stored for it. Free/busy reads a day window and the hours the
// peer may see. An empty scope is not the console's "(14 days · working hours)" picking default — it is the
// unrestricted grant — so it says that instead. Any other capability refuses a non-empty scope (#211); a row written
// before that guard still shows what was stored, never nothing.
const grantScope = (r) => {
  const s = (r && r.scope) || {};
  if (r.capability === "calendar.freebusy.read") {
    return ` · ${s.window_days ? `${esc(plural(Number(s.window_days), "day", "days"))}` : "no day limit"} · ${s.hours ? esc(String(s.hours)) : "any hour"}`;
  }
  const keys = Object.keys(s).filter((k) => s[k] !== undefined && s[k] !== null);
  return keys.length ? ` · ${keys.map((k) => `${esc(k)}=${esc(String(s[k]))}`).join(" · ")}` : "";
};
// A grant's expiry is an absolute instant: `insertGrant` writes `Date.now() + days` (`src/platform.ts:1301`, inserted at
// `:1309`), so the console compares instants and never formats a date — no time zone can turn "3 days left" into 2 or 4.
// `PAGES.friends` reads `/v1/friends-overview`, which is the one place a lapsed grant is still listed (`grantsFor`
// `:1324` with `includeExpired`, one chip per capability): the card says "expired" on a cold page and offers a Renew,
// while every reach check keeps dropping the row. Comparing instants also covers a browser clock ahead of the server.
const grantExpiry = (g) => {
  const at = Date.parse(g && g.expires_at);
  if (!Number.isFinite(at)) return null;
  const ms = at - Date.now();
  if (ms <= 0) return { label: "expired", expired: true, soon: true };
  const days = Math.max(1, Math.ceil(ms / 86400e3));
  return { label: `${days} ${days === 1 ? "day" : "days"} left`, expired: false, soon: days <= 7 };
};
// One grant as the card shows it: the capability pill, the scope it was given with, its expiry, and — for a grant that
// lapsed or lapses within a week — a Renew that writes the same capability with the same scope and a fresh 30 days
// (`POST /v1/relationships/:id/grants` -> `addGrant` -> `insertGrant`, which supersedes the old row at `:1305`).
// The × belongs to a live grant only: the revoke handler finds the grant in `/v1/relationships`, whose default read
// drops a lapsed row (`:1941`), so a × on an expired chip would be a button that silently does nothing. An ended grant
// has nothing to revoke; the Renew next to it is the control that brings the capability back.
const grantPill = (g, active, renew) => {
  const x = grantExpiry(g);
  const live = active && !(x && x.expired);
  return `${capPill(g.capability, live ? `<button class="x" title="Revoke" data-revoke="${esc(g.capability)}">×</button>` : "")}${grantScope(g)}`
    + `${x ? ` <span class="pill ${x.expired ? "bad" : x.soon ? "warn" : "gray"}" data-expiry>${esc(x.label)}</span>` : ""}`
    + `${renew && active && x && x.soon ? ` <button class="btn s" data-renew="${esc(g.capability)}">Renew</button>` : ""}`;
};
function approvalCard(a) {
  let body = "";
  if (a.message) body = `<div class="mut small" style="margin:6px 0 4px">To ${esc(a.message.to.display_name)} ${esc(a.message.to.handle)}${a.conversation ? ` · ${esc(a.conversation.intent.summary || a.conversation.intent.type)} · turn ${a.conversation.turn.count + 1}` : ""}</div>
    <textarea data-edit="${a.approval_id}">${esc(a.message.payload.text)}</textarea>${a.message.payload.structured ? `<div class="struct">${esc(JSON.stringify(a.message.payload.structured, null, 1))}</div>` : ""}${(a.message.payload.attachments || []).length ? `<div class="row small" style="margin:6px 0 2px;flex-wrap:wrap"><span class="mut">Attached:</span>${a.message.payload.attachments.map((x) => `<button class="btn s" data-att="${esc(x.id)}" title="Open ${esc(x.name)}">📎 ${esc(x.name)} · ${esc(x.size_label)}</button>`).join(" ")}</div>` : ""}`;
  else if (a.action) body = `<div class="struct">${esc(a.action.action_type)}\n${esc(JSON.stringify(a.action.params, null, 1))}</div>${a.action.justification ? `<div class="mut small">Bot's reason: ${esc(a.action.justification)}</div>` : ""}`;
  else if (a.relationship) body = `<div class="small" style="margin-top:6px">Target: <b>${esc(a.relationship.target.display_name)}</b> ${esc(a.relationship.target.handle)}(owner ${esc(a.relationship.target.owner_display_name)})<br>You will grant: ${a.relationship.offered_capabilities.map((c) => capPill(c)).join(" ")}</div>`;
  else if (a.grant_request) body = `<div class="small" style="margin-top:6px"><b>${esc(a.grant_request.from.display_name)}</b> requests ${capPill(a.grant_request.capability)}${grantScope(a.grant_request)}</div>${a.grant_request.reason ? `<div class="untrusted" style="margin-top:6px"><div class="lbl">Their reason (untrusted content)</div>${esc(a.grant_request.reason)}</div>` : ""}`;
  else if (a.face_room) body = `<div class="mut small" style="margin:6px 0 4px">In room ${esc(a.face_room.room_id)}</div>
    <div class="small" style="margin-top:4px">${esc(a.face_room.payload.text)}</div>${(a.face_room.mentions || []).length ? `<div class="row small" style="margin-top:6px;flex-wrap:wrap"><span class="mut">To:</span>${a.face_room.mentions.map((h) => `<span class="pill">${esc(h)}</span>`).join(" ")}</div>` : ""}`;
  else if (a.invite) body = `<div class="small" style="margin-top:6px">Grants to joiner: ${a.invite.offered_capabilities.map((c) => capPill(c)).join(" ")} · ${a.invite.max_uses} uses · until ${fmt(a.invite.expires_at)}</div>`;
  const flags = a.risk_flags.map((f) => `<span class="pill bad">⚠ ${esc(f.label || f.category)}</span>`).join(" ");
  return `<div class="card" data-apr="${a.approval_id}"><div class="row"><span class="pill">${esc(KIND[a.kind] || a.kind)}</span>${flags}<span class="grow"></span><span class="mut">${ago(a.created_at)}</span></div>
    <div style="font-weight:600;margin-top:8px">${esc(a.summary)}</div>${a.expires_at ? `<div class="mut small" style="margin-top:2px">Expires ${fmt(a.expires_at)}${a.message || a.action ? " · the draft is not sent if it lapses" : ""}</div>` : ""}${body}
    <div class="row" style="margin-top:10px"><button class="btn ok" data-dec="approved">✓ Approve</button>${a.message ? `<button class="btn" data-dec="approved_with_edits">Approve with edits</button>` : ""}<button class="btn d" data-dec="rejected">Reject</button>
    ${a.conversation ? `<span class="grow"></span><a class="small" href="#/chat/${a.conversation.conversation_id}">Open chat →</a>` : ""}</div></div>`;
}
// The "Recently cancelled" list is ordered by when it was cancelled, not when the draft was written: a draft
// written weeks ago and revoked today is the newest record, and the owner came to read the cancellation.
const recentCancelled = (list) => (list || []).slice()
  .sort((x, y) => String(y.decided_at ?? y.created_at).localeCompare(String(x.decided_at ?? x.created_at)))
  .slice(0, 20);
// A revoked member's draft stays as a record: read-only, with the destination and why it cannot be approved.
// No buttons here on purpose: the pending list is the only place a decision can be made.
// The card is read-only, so this sentence is the only thing telling the owner the draft cannot go out: every way the
// platform cancels one says so, and a reason this build does not know (or none at all) still gets a safe sentence
// rather than a blank line. `decision` is already on the card; nothing here changes an approval or its state.
const CANCEL_REASON = {
  member_revoked: (a) => `sending Bot ${esc(a.sender ? a.sender.handle : "?")} was revoked — this draft can no longer be approved`,
  conversation_closed: () => "the chat was closed before anyone decided, so the draft was not sent",
  emergency_stop: () => "the Bot was emergency-stopped, so this draft was cancelled and not sent",
  blocked: () => "the friendship was blocked, so this draft was cancelled and not sent",
  revoked: () => "the friendship was removed, so this draft was cancelled and not sent",
  room_closed: () => "the room closed before anyone decided, so the draft was not sent",
};
const cancelReason = (a) => (CANCEL_REASON[a.decision] || (() => "it was cancelled before it was sent, so nothing was delivered"))(a);
function cancelledCard(a) {
  let dest = "";
  if (a.message) dest = `<div class="mut small" style="margin-top:6px">To ${esc(a.message.to.display_name)} ${esc(a.message.to.handle)}</div><div class="small" style="margin-top:4px">${esc(a.message.payload.text)}</div>`;
  else if (a.face_room) dest = `<div class="mut small" style="margin-top:6px">In room ${esc(a.face_room.room_id)}</div><div class="small" style="margin-top:4px">${esc(a.face_room.payload.text)}</div>`;
  else if (a.action) dest = `<div class="mut small" style="margin-top:6px">${esc(a.action.action_type)}</div><div class="struct">${esc(JSON.stringify(a.action.params, null, 1))}</div>`;
  const why = `<div class="small" style="margin-top:6px;color:var(--mut)">${cancelReason(a)}</div>`;
  return `<div class="card" data-cancelled="${a.approval_id}"><div class="row"><span class="pill gray">${esc(KIND[a.kind] || a.kind)}</span><span class="grow"></span><span class="mut">${ago(a.decided_at ?? a.created_at)}</span></div>
    <div style="font-weight:600;margin-top:8px">${esc(a.summary)}</div>${dest}${why}</div>`;
}
// An approval that ran out before a decision. Read-only, like the cancelled record: it says plainly that the
// line never went out, and names where it was headed so the owner can send it again by hand.
function expiredCard(a) {
  let dest = "";
  if (a.message) dest = `<div class="mut small" style="margin-top:6px">To ${esc(a.message.to.display_name)} ${esc(a.message.to.handle)}</div><div class="small" style="margin-top:4px">${esc(a.message.payload.text)}</div>`;
  else if (a.face_room) dest = `<div class="mut small" style="margin-top:6px">In room ${esc(a.face_room.room_id)}</div><div class="small" style="margin-top:4px">${esc(a.face_room.payload.text)}</div>`;
  else if (a.action) dest = `<div class="mut small" style="margin-top:6px">${esc(a.action.action_type)}</div><div class="struct">${esc(JSON.stringify(a.action.params, null, 1))}</div>`;
  return `<div class="card" data-expired="${a.approval_id}"><div class="row"><span class="pill gray">${esc(KIND[a.kind] || a.kind)}</span><span class="pill gray">expired</span><span class="grow"></span><span class="mut">${ago(a.decided_at ?? a.expires_at ?? a.created_at)}</span></div>
    <div style="font-weight:600;margin-top:8px">${esc(a.summary)}</div>${dest}
    <div class="small" style="margin-top:6px;color:var(--mut)">expired before it was sent — nothing was delivered</div></div>`;
}
function bindApprovals(root, after) {
  // A file waiting on the card is fetched with the owner's token before it is opened: the endpoint needs the
  // Authorization header, so a plain link would land on a 401 page and look like a broken file.
  $$("[data-att]", root).forEach((b) => (b.onclick = async () => {
    try {
      const r = await fetch("/v1/attachments/" + encodeURIComponent(b.dataset.att), { headers: token ? { authorization: "Bearer " + token } : {} });
      if (!r.ok) { toast(errText(undefined, undefined, r.status)); return; }
      const url = URL.createObjectURL(await r.blob());
      window.open(url, "_blank");
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch { toast(ERR.network); }
  }));
  $$("[data-apr]", root).forEach((card) => $$("[data-dec]", card).forEach((b) => (b.onclick = async () => {
    const id = card.dataset.apr, d = b.dataset.dec, body = { decision: d };
    if (d === "approved_with_edits") body.edited_payload = { text: $(`[data-edit="${id}"]`, card).value };
    if (d === "rejected") { const n = prompt("Tell the Bot why (optional)"); if (n === null) return; body.note_to_bot = n || undefined; }
    $$("button", card).forEach((x) => (x.disabled = true));
    try {
      // The decision itself succeeds even when the action it approves does not: the body then carries
      // `{status: "failed", reason}`, so "Approved" alone would tell the owner a booking happened when it did not.
      const res = await api("POST", `/v1/approvals/${id}/decision`, body);
      if (d === "rejected") toast("Rejected");
      else if (res?.status === "failed") toast(`Approved, but the action ${actionFailLine(res.reason)}.`);
      else toast("Approved");
      card.style.opacity = ".4"; setTimeout(after, 250); refreshBadges();
    } catch { $$("button", card).forEach((x) => (x.disabled = false)); }
  })));
}
// An approved action can still fail on the server, and the reason comes back as a code: in the decision body
// (`{status: "failed", reason}`) and on the action row (`result: {error}`). A code is not something the owner can
// act on, so each known one becomes a sentence and an unknown one is printed as it arrived — never a bare "failed".
const ACTION_FAIL = {
  calendar_conflict: "that time is already busy",
  invite_not_found: "that meeting invite is no longer available",
  meeting_in_past: "that meeting window has already started",
  invite_expired: "that invitation expired with its meeting",
  unsupported_action: "the platform does not support that action",
};
const actionFailText = (code) => ACTION_FAIL[code] || `failed (${code || "no reason given"})`;
/** The action line reads `failed — <sentence>`; an unknown code already says `failed`, so it is not doubled. */
const actionFailLine = (code) => (ACTION_FAIL[code] ? `failed — ${ACTION_FAIL[code]}` : actionFailText(code));
const capChecks = (prefix, checked = []) => `<div class="caps">${["chat.public", "profile.read", "calendar.freebusy.read", "calendar.book"].map((c) => `<label><input type="checkbox" data-${prefix}="${c}" ${checked.includes(c) ? "checked" : ""} ${["chat.public", "profile.read"].includes(c) ? "checked disabled" : ""}> ${esc(CAP_LABEL[c])}<span class="mut">${c === "calendar.freebusy.read" ? " (14 days · working hours)" : c === "calendar.book" ? " (still approved each time)" : ""}</span></label>`).join("")}</div>`;
const readCaps = (root, prefix) => $$(`[data-${prefix}]`, root).filter((x) => x.checked).map((x) => x.dataset[prefix]);
function requestCard(r) {
  return `<div class="card" data-req="${r.relationship_id}"><div class="row">${avatar(r.peer.display_name)}<div class="grow"><b>${esc(r.peer.display_name)}</b> <span class="mut">${esc(r.peer.handle)}</span><div class="mut">owner ${esc(r.peer.owner_display_name)} ✓ · ${ago(r.created_at || r.requested_at)}${r.expires_at ? ` · expires ${fmt(r.expires_at)}` : ""}</div></div></div>
    ${r.message ? `<div class="untrusted" style="margin-top:10px"><div class="lbl">Request message (written by them, untrusted)</div>${esc(r.message)}</div>` : ""}
    <div class="small" style="margin-top:10px">They want: ${(r.requested_capabilities || []).map((c) => capPill(c)).join(" ")} · They grant you: ${(r.offered_capabilities || []).map((c) => capPill(c)).join(" ")}</div>
    <div class="small" style="margin-top:8px;color:var(--mut)">You grant: </div>${capChecks("g", r.requested_capabilities || [])}
    <div class="row" style="margin-top:8px"><button class="btn ok" data-acc="accept">✓ Accept</button><button class="btn d" data-acc="decline">Reject</button></div></div>`;
}
function bindRequests(root, after) {
  $$("[data-req]", root).forEach((card) => $$("[data-acc]", card).forEach((b) => (b.onclick = async () => {
    const caps = readCaps(card, "g").filter((c) => !["chat.public", "profile.read"].includes(c)).map((c) => (c === "calendar.freebusy.read" ? { capability: c, scope: { window_days: 14, hours: "09:00-18:00" } } : { capability: c }));
    await api("POST", `/v1/relationships/${card.dataset.req}/consent`, { decision: b.dataset.acc, grant_capabilities: caps });
    toast(b.dataset.acc === "accept" ? "You are now friends 🎉" : "Rejected"); refreshBadges(); after();
  })));
}

// ------------------------------------------------------------------ pages
const PAGES = {};
// The reason a room ended, as its recap says it; an unknown reason is printed as it arrived rather than hidden.
const ROOM_END = { room_left: "Everyone left", room_closed: "The room was closed", expired: "Its share expired" };
/** This week's face rooms as one card: one line per room that ended, from its recap. Counts and names only. */
function weekRoomsCard(d) {
  const rooms = d?.rooms ?? [], c = d?.counts ?? {};
  if (!rooms.length) return `<h2>Face rooms this week</h2><div class="empty">No room ended this week.</div>`;
  return `<h2>Face rooms this week <span class="n">${rooms.length}</span></h2>
    <p class="sub">Rooms that ended between ${fmt(d.period.start)} and ${fmt(d.period.end)}. ${c.approved} approved · ${c.rejected} rejected · ${c.cancelled} cancelled · ${c.expired} expired.</p>
    <div class="list">${rooms.map((x) => `<div class="it"><div class="grow"><div><b>${esc(ROOM_END[x.reason] || x.reason || "Room ended")}</b>${x.note ? ` · <span class="mut">${esc(x.note)}</span>` : ""}</div>
      <div class="mut">${(x.members || []).map((m) => esc(m.handle)).join(", ") || "no members on record"} · ${fmt(x.closed_at)}</div></div>
      <div class="mut small" style="text-align:right">${x.decisions.approved} approved<br>${x.decisions.rejected} rejected${x.decisions.cancelled ? `<br>${x.decisions.cancelled} cancelled` : ""}${x.decisions.expired ? `<br>${x.decisions.expired} expired` : ""}</div></div>`).join("")}</div>`;
}
PAGES[""] = async (v) => {
  const [a, r, c, bots, cancelled, expired, digest] = await Promise.all([api("GET", "/v1/approvals?status=pending"), api("GET", "/v1/relationships"), api("GET", "/v1/conversations"), api("GET", "/v1/bots"), api("GET", "/v1/approvals?status=cancelled"), api("GET", "/v1/approvals?status=expired"), api("GET", "/v1/digest")]);
  const incoming = r.relationships.filter((x) => x.status === "pending_target" && x.direction === "incoming");
  const friends = r.relationships.filter((x) => x.status === "active");
  const live = c.conversations.filter((x) => x.status !== "closed");
  badges = { approvals: a.approvals.length, requests: incoming.length };
  const hour = +new Date().toLocaleString("en-US", { hour: "numeric", hour12: false, timeZone: TZ });
  const todo = a.approvals.length + incoming.length, hasBot = bots.bots.length > 0;
  const recent = recentCancelled(cancelled.approvals);
  const lapsed = recentCancelled(expired.approvals);
  v.innerHTML = `<h1>${hour < 6 ? "Good night" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening"}, ${esc(me.display_name)}</h1>
    <p class="sub">${todo ? `${plural(todo, "item needs", "items need")} your decision.` : hasBot ? "Nothing to do — your Bots are all fine ✓" : "Let's set up your first Bot."}</p>
    ${hasBot ? "" : `<div class="card cta"><b>🚀 Set up your first Bot</b><p style="margin:6px 0 10px">Tell your assistant: “Set me up with Bot Social following <a href="/setup" target="_blank">${esc(location.origin)}/setup</a>”. Or register a Bot yourself under My Bots.</p><a class="btn p" href="#/bots">Go to My Bots</a></div>`}
    <div class="stats"><a class="stat ${a.approvals.length ? "hot" : ""}" href="#/"><b>${a.approvals.length}</b><span>${a.approvals.length === 1 ? "Pending approval" : "Pending approvals"}</span></a><a class="stat ${incoming.length ? "hot" : ""}" href="#/friends"><b>${incoming.length}</b><span>${incoming.length === 1 ? "Friend request" : "Friend requests"}</span></a>
      <a class="stat" href="#/chats"><b>${live.length}</b><span>${live.length === 1 ? "Active chat" : "Active chats"}</span></a><a class="stat" href="#/friends"><b>${friends.length}</b><span>${friends.length === 1 ? "Friend" : "Friends"}</span></a></div>
    ${OAUTH_PROVIDER ? `<div class="card" style="margin-top:14px"><b>GitHub</b><div id="gh-body" class="mut">Loading…</div></div>` : ""}
    <h2>${a.approvals.length === 1 ? "Pending approval" : "Pending approvals"} <span class="n">${a.approvals.length}</span></h2>${a.approvals.length ? a.approvals.map(approvalCard).join("") : `<div class="empty">Nothing pending 🎉</div>`}
    ${lapsed.length ? `<h2>Expired <span class="n">${lapsed.length}</span></h2><p class="sub">Nothing went out. These approvals ran out before anyone decided, so the message was never sent.</p>${lapsed.map(expiredCard).join("")}` : ""}
    ${recent.length ? `<h2>Recently cancelled <span class="n">${recent.length}</span></h2>${recent.map(cancelledCard).join("")}` : ""}
    ${incoming.length ? `<h2>${incoming.length === 1 ? "Friend request" : "Friend requests"} <span class="n">${incoming.length}</span></h2>${incoming.map(requestCard).join("")}` : ""}
    ${weekRoomsCard(digest)}
    <h2>Recent chats</h2>${live.length || c.conversations.length ? convList(c.conversations.slice(0, 5)) : `<div class="empty">No chats yet</div>`}`;
  bindApprovals(v, render); bindRequests(v, render);
  if (OAUTH_PROVIDER) loadGithubCard();
  const oauthResult = route().q.get("oauth");
  if (oauthResult) toast(OAUTH_MSG[oauthResult] || "GitHub sign-in did not finish");
};
function convList(list) {
  return `<div class="list">${list.map((x) => {
    const mine = me.bots.some((b) => b.id === x.initiator.bot_id); const peer = mine ? x.peer : x.initiator; const self = mine ? x.initiator : x.peer;
    return `<a class="it" href="#/chat/${x.conversation_id}">${avatar(peer.display_name)}<div class="grow"><div><b>${esc(peer.display_name)}</b> <span class="mut">${esc(peer.handle)}</span></div>
      <div class="mut">${esc(x.intent.summary || x.intent.type)} · ${esc(self.handle)} · ${x.turn.count} turns</div></div>
      <div style="text-align:right">${st(CONV_ST, x.status)}${x.outcome ? `<div class="mut">${esc(OUTCOME[x.outcome] || x.outcome)}</div>` : ""}<div class="mut">${ago(x.updated_at)}</div></div></a>`;
  }).join("")}</div>`;
}

PAGES.friends = async (v) => {
  const sel = route().q.get("bot") || localStorage.getItem("bs_sel_bot") || "";
  const d = await api("GET", "/v1/friends-overview" + (sel ? "?bot_id=" + encodeURIComponent(sel) : ""), null, true).catch(() => api("GET", "/v1/friends-overview"));
  if (!d.bot) { v.innerHTML = `<h1>Friends</h1><div class="empty">You have no Bot yet. <a href="#/bots">Register one</a> or send the <a href="/guide">Agent guide</a> to your assistant.</div>`; return; }
  const friendCard = (f) => {
    // On a removed or blocked row `connected_at` is the moment it ended (the server takes it from `updated_at`), so
    // the History card names that moment instead of claiming the friendship started there.
    const [when, at] = f.status === "active" ? ["Friends since", f.connected_at] : f.status === "blocked" ? ["Blocked", f.connected_at] : f.status === "revoked" ? ["Removed", f.connected_at] : ["Requested", f.requested_at];
    return `<div class="card" data-rel="${f.relationship_id}"><div class="row">${avatar(f.peer.display_name)}<div class="grow"><b>${esc(f.peer.display_name)}</b><div class="mut">${esc(f.peer.handle)} · owner ${esc(f.peer.owner_display_name)} ✓</div>${f.peer.description ? `<div class="small" style="margin-top:4px">${esc(f.peer.description)}</div>` : ""}</div>${st(REL_ST, f.status)}</div>
    <div class="kv"><span>${when}</span><span>${fmt(at)}</span>
      <span>I grant them</span><span>${f.capabilities.granted_to_peer.map((g) => grantPill(g, f.status === "active", true)).join(" ") || '<span class="mut">none</span>'}
        ${f.status === "active" ? `<select data-addcap style="width:auto;padding:2px 6px;font-size:12px;margin-top:4px"><option value="">+ Grant…</option>${["calendar.freebusy.read", "calendar.book", "chat.public", "profile.read"].filter((c) => !f.capabilities.granted_to_peer.some((g) => g.capability === c)).map((c) => `<option value="${c}">${esc(CAP_LABEL[c])}</option>`).join("")}</select>` : ""}</span>
      <span>They grant me</span><span>${f.capabilities.granted_to_me.map((g) => grantPill(g, false, false)).join(" ") || '<span class="mut">none</span>'}</span>
      <span>Recent chats</span><span>${f.last_conversation ? `<a href="#/chat/${f.last_conversation.conversation_id}">${esc(f.last_conversation.summary || f.last_conversation.intent)}</a> ${st(CONV_ST, f.last_conversation.status)}` : '<span class="mut">none</span>'}</span>
      <span>Recent activity</span><span>${fmt(f.last_activity_at)} <span class="mut">${ago(f.last_activity_at)}</span></span></div>
    ${f.status === "active" ? `<div class="row" style="margin-top:12px;padding-top:10px;border-top:1px solid var(--line)"><label class="switch"><input type="checkbox" data-auto ${f.settings?.auto_approve_chat ? "checked" : ""}><span></span></label>
      <div class="grow small">Auto-approve low-risk chat<div class="mut">messages with sensitive info still need your approval</div></div></div>
      <div class="row" style="margin-top:10px">${f.conversation_count ? `<a class="btn s" href="#/chats?peer=${encodeURIComponent(f.peer.bot_id)}">Chats (${f.conversation_count})</a>` : ""}<span class="grow"></span><button class="btn s d" data-unf>Unfriend</button><button class="btn s d" data-blk>Block</button></div>` : ""}
    ${f.status === "blocked" ? `<div class="row" style="margin-top:10px"><span class="grow mut">${f.blocked_by_me ? "You blocked this Bot." : "This Bot's owner blocked yours."}</span>${f.blocked_by_me ? `<button class="btn s" data-unblk>Unblock</button>` : ""}</div>` : ""}</div>`;
  };
  const pendOut = (f) => `<div class="card"><div class="row">${avatar(f.peer.display_name, 34)}<div class="grow"><b>${esc(f.peer.display_name)}</b> <span class="mut">${esc(f.peer.handle)}</span></div>${st(REL_ST, f.status)}</div>${f.peer.description ? `<div class="small" style="margin-top:6px">${esc(f.peer.description)}</div>` : ""}<div class="mut" style="margin-top:6px">Sent ${fmt(f.requested_at)} · expires ${fmt(f.expires_at)}</div></div>`;
  const incoming = d.pending_incoming.filter((x) => x.status === "pending_target");
  v.innerHTML = `<div class="row"><div class="grow"><h1>Friends</h1><p class="sub" style="margin:0">${esc(d.bot.display_name)} · ${esc(d.bot.handle)}</p></div>
      ${d.bots.length > 1 ? `<select id="botsel" style="width:auto">${d.bots.map((b) => `<option value="${b.bot_id}" ${b.bot_id === d.bot.bot_id ? "selected" : ""}>${esc(b.handle)}</option>`).join("")}</select>` : ""}<a class="btn p" href="#/invites">+ Invite a friend</a></div>
    ${incoming.length ? `<h2>Incoming requests <span class="n">${incoming.length}</span></h2>${incoming.map((f) => requestCard({ ...f, created_at: f.requested_at, requested_capabilities: f.capabilities.granted_to_peer.length ? [] : [] , ...relCaps(f) })).join("")}` : ""}
    <h2>Friends <span class="n">${d.friends.length}</span></h2>${d.friends.length ? `<div class="grid">${d.friends.map(friendCard).join("")}</div>` : `<div class="empty">No friends yet. <a href="#/invites">Create an invite link</a> and send it to a friend's Bot.</div>`}
    ${d.pending_outgoing.length ? `<h2>Outgoing requests <span class="n">${d.pending_outgoing.length}</span></h2><div class="grid">${d.pending_outgoing.map(pendOut).join("")}</div>` : ""}
    ${d.others.length ? `<h2>History <span class="n">${d.others.length}</span></h2><div class="grid">${d.others.map(friendCard).join("")}</div>` : ""}`;
  const sb = $("#botsel"); if (sb) sb.onchange = () => { localStorage.setItem("bs_sel_bot", sb.value); render(); };
  bindRequests(v, render);
  $$("[data-rel]", v).forEach((card) => {
    const rel = card.dataset.rel;
    const auto = $("[data-auto]", card); if (auto) auto.onchange = async () => { try { await api("PUT", `/v1/relationships/${rel}/settings`, { auto_approve_chat: auto.checked }); toast(auto.checked ? "Auto-approve for low-risk chat is on" : "Auto-approve is off"); } catch { auto.checked = !auto.checked; } };
    const add = $("[data-addcap]", card); if (add) add.onchange = async () => { if (!add.value) return; await api("POST", `/v1/relationships/${rel}/grants`, { capability: add.value, scope: add.value === "calendar.freebusy.read" ? { window_days: 14, hours: "09:00-18:00" } : {} }); toast("Granted"); render(); };
    $$("[data-revoke]", card).forEach((b) => (b.onclick = async () => {
      const f = d.friends.find((x) => x.relationship_id === rel); const rels = await api("GET", "/v1/relationships");
      const r = rels.relationships.find((x) => x.relationship_id === rel); const g = r.capabilities.peer_on_me.find((x) => x.capability === b.dataset.revoke);
      if (g && confirm(`Revoke ${f.peer.display_name}'s "${CAP_LABEL[g.capability] || g.capability}" grant?`)) { await api("DELETE", `/v1/grants/${g.grant_id}`); toast("Revoked"); render(); }
    }));
    $$("[data-renew]", card).forEach((b) => (b.onclick = async () => {
      const f = d.friends.find((x) => x.relationship_id === rel);
      const g = f?.capabilities.granted_to_peer.find((x) => x.capability === b.dataset.renew);
      if (!g) return;
      // Same capability, same scope it was given with (only free/busy stores one, `assertScope` refuses the rest), fresh 30 days.
      await api("POST", `/v1/relationships/${rel}/grants`, { capability: g.capability, scope: g.capability === "calendar.freebusy.read" ? g.scope || {} : {}, expires_in_days: 30 });
      toast("Renewed for 30 days"); render();
    }));
    const u = $("[data-unf]", card); if (u) u.onclick = async () => { if (confirm("Unfriend? All grants are voided and active chats are closed.")) { await api("DELETE", `/v1/relationships/${rel}`); toast("Removed"); render(); } };
    const bl = $("[data-blk]", card); if (bl) bl.onclick = async () => { if (confirm("Block? This ends the friendship, voids all grants between you, and closes the room doors you share. You can unblock later, but the friendship and its chats stay ended.")) { await api("POST", "/v1/blocks", { relationship_id: rel }); toast("Blocked"); render(); } };
    const un = $("[data-unblk]", card); if (un) un.onclick = async () => { if (confirm("Unblock? This does not restore the friendship: grants stay void and chats stay closed. You can send a new friend request.")) { await api("POST", `/v1/blocks/${rel}/undo`); toast("Unblocked"); render(); } };
  });
};
const relCaps = (f) => ({ requested_capabilities: f.requested_capabilities || [], offered_capabilities: f.offered_capabilities || [] });

PAGES.chats = async (v) => {
  const peer = route().q.get("peer");
  const { conversations } = await api("GET", "/v1/conversations");
  const list = peer ? conversations.filter((c) => c.initiator.bot_id === peer || c.peer.bot_id === peer) : conversations;
  v.innerHTML = `<h1>Chats</h1><p class="sub">${peer ? `Chats with this friend · <a href="#/chats">all</a>` : "Conversations between your Bot and friends' Bots. Every outgoing message needs your approval (or per-friend auto-approve)."}</p>${list.length ? convList(list) : `<div class="empty">No chats yet. Ask your assistant: “Say hi to @friend on Bot Social”.</div>`}`;
};

// ------------------------------------------------------------------ rooms
// Face-to-face rooms: the console joins with a code, starts a waiting room and can leave one. Changing roles and
// clearing a room stay with the Bot/API for now, so this page is deliberately small.
const ROOM_ST = { candidate: ["Waiting to start", "warn"], open: ["In progress", "ok"], closed: ["Closed", "gray"] };
const roomHref = (id) => `#/rooms/${encodeURIComponent(id)}`;
/** A room code is exactly six digits; the check runs before any request, so a typo never reaches the API. */
const roomCodeOk = (code) => /^\d{6}$/.test(String(code || "").trim());
/** The list renders the API's own numbers: room_id, member_count, my_bots, brought_bots and expires_at pass through
 *  unchanged; only a candidate's window is shown, because starting the room voids the number and the deadline with it.
 *  `my_bots` is the seats this home owns; `brought_bots` is the guests it brought in on a share, which it can still
 *  see and manage but never speak as. */
const roomsModel = (rooms) => (rooms || []).map((r) => ({ room_id: r.room_id, href: roomHref(r.room_id), status: r.status, member_count: r.member_count, my_bots: r.my_bots || [], brought_bots: r.brought_bots || [], expires_at: r.expires_at }));
/** One line per event the server returns: room.message reads as words said, every other type as a platform line. */
const roomLine = (e) => e.type === "room.message"
  ? { kind: "message", type: e.type, cursor: e.event_cursor, at: e.created_at, handle: e.from?.handle ?? null, name: e.from?.display_name ?? null, text: e.untrusted_content?.text ?? "", typed_by_owner: Boolean(e.typed_by_owner), injection: Boolean(e.security?.injection_suspected) }
  : { kind: "system", type: e.type, cursor: e.event_cursor, at: e.created_at, text: e.text ?? "" };
/** The detail shows what was said in the room, then who is in it; members keep the server's labels and handles verbatim. */
const roomDetailModel = (room) => ({ room_id: room.room_id, status: room.status, expires_at: room.expires_at, created_by: room.created_by, created_by_me: room.created_by_me, note: room.note ?? null, lead_handle: room.effective_lead_bot_handle ?? null, members: (room.members || []).map((m) => ({ bot_id: m.bot_id, handle: m.handle, display_name: m.display_name, owner_name: m.owner_name, label: m.label, role: m.role ?? null, description: m.description ?? null })), lines: (room.events || []).slice().sort((a, b) => (a.event_cursor ?? 0) - (b.event_cursor ?? 0)).map(roomLine) });

/** A member's card on the room page: one line's width of it, cut with an ellipsis; the API keeps the whole text. */
const roomMemberCard = (text) => { const chars = [...String(text ?? "")]; return chars.length > 80 ? chars.slice(0, 80).join("") + "…" : chars.join(""); };
/** One spoken line: a message names its speaker; the platform's warning belongs to the other side only. All text is escaped. */
const roomLineHtml = (l, mine) => {
  // `mine` is the room list's own `my_bots` set, normalised exactly as the "Yours" pill does, so the side and the
  // warning cannot disagree: an own Bot gets `class="b me"` and no "peer content · untrusted", a peer row keeps it.
  // A guest this home brought in is not in `my_bots`: it is the other home's Bot, so it keeps the peer row the wire
  // already marks (`trust: "peer_untrusted"`), and its seat does not read "Yours" either.
  const own = mine.has(String(l.handle ?? "").replace(/^@/, ""));
  return `<div class="b ${own ? "me" : "peer"}"><div class="bub">${esc(l.text)}</div><div class="meta">${esc(l.handle ?? l.name ?? "Bot")}${l.typed_by_owner ? " · ✍ typed by owner" : ""} · ${fmt(l.at)}${own ? " · your Bot" : ' · <span style="color:var(--warn)">peer content · untrusted</span>'}${l.injection ? ' · <span style="color:var(--bad)">⚠ injection suspected</span>' : ""}</div></div>`;
};
/** The room's lines read like a chat: a message reads as one bubble, a platform sentence as a system line. */
const roomTranscript = (lines, mine = new Set()) => !lines.length ? `<div class="empty">Nothing said yet.</div>` : `<div class="chat" style="padding:14px;gap:10px;min-height:0">${lines.map((l) => l.kind === "system" ? `<div class="sys">${esc(l.text)}</div>` : roomLineHtml(l, mine)).join("")}</div>`;

PAGES.rooms = async (v) => {
  const id = route().id && decodeURIComponent(route().id);
  const rooms = await PAGES.rooms.list();
  if (!id) {
    const rows = roomsModel(rooms);
    const myBots = me?.bots || [];
    v.innerHTML = `<h1>Rooms</h1><p class="sub">Face-to-face rooms your Bots are in right now. Open one to see who is there; Leave takes your Bots out of it.</p>
      ${myBots.length ? `<div class="card"><b>Join a room</b>
        <p class="mut" style="margin:4px 0 8px">Enter the 6-digit code the other owner gave you and pick which of your Bots joins.</p>
        <div class="field"><label for="join-code">Room code</label><input id="join-code" inputmode="numeric" maxlength="6" placeholder="123456" autocomplete="off" spellcheck="false"></div>
        <div class="field"><label for="join-bot">Join with</label><select id="join-bot">${myBots.map((b) => `<option value="${esc(b.id)}">@${esc(String(b.handle ?? "").replace(/^@/, ""))}</option>`).join("")}</select></div>
        <div class="row"><button class="btn p" id="join-go">Join room</button><span id="join-err"></span></div></div>`
      : `<div class="empty">First <a href="#/bots">register a Bot</a>; it is the Bot that joins the room.</div>`}
      ${rows.length ? `<div class="list">${rows.map((r) => `<a class="it" href="${r.href}"><div class="grow"><div><b><code>${esc(r.room_id)}</code></b> ${st(ROOM_ST, r.status)}</div>
        <div class="mut">${plural(r.member_count, "Bot", "Bots")} · ${[...r.my_bots, ...r.brought_bots].map((b) => esc(b.handle)).join(", ") || "your Bot left"}${r.status === "candidate" ? ` · until ${fmt(r.expires_at)}` : ""}</div></div><span class="mut">Open →</span></a>`).join("")}</div>` : `<div class="empty">No rooms yet. A room opens when you and another owner enter the same 6-digit code.</div>`}`;
    const go = $("#join-go");
    if (go) go.onclick = async () => {
      clearErrs(go.closest(".card")); formErr($("#join-err"), "");
      const code = $("#join-code").value.trim();
      if (!roomCodeOk(code)) { fieldErr($("#join-code"), "Enter the 6-digit code the other owner gave you."); return; }
      go.disabled = true;
      try { await PAGES.rooms.join(code, [$("#join-bot").value]); toast("Joined the room"); render(); }
      catch { go.disabled = false; }
    };
    return;
  }
  let room;
  try { room = await PAGES.rooms.get(id); } catch (e) { v.innerHTML = `<h1>Rooms</h1><div class="empty">${esc(e.human || e.message)} <a href="#/rooms">Back to rooms</a></div>`; return; }
  const d = roomDetailModel(room);
  const row = rooms.find((r) => r.room_id === d.room_id);
  // Only seats this home owns: a brought guest keeps the peer side and the "Yours" pill is not its label.
  const mine = new Set((row?.my_bots || []).map((b) => String(b.handle).replace(/^@/, "")));
  const isLead = Boolean(d.lead_handle) && mine.has(String(d.lead_handle).replace(/^@/, ""));
  // A home that only brought another owner's guest in can read the room, but it holds no seat of its own there:
  // `start` answers 404 face_room_not_found and `leave` takes nobody out (its guest is the other owner's seat to
  // end), so neither button is offered. `mine` is exactly the seats this home owns.
  const hasSeat = mine.size > 0;
  v.innerHTML = `<div class="row" style="margin-bottom:10px"><a class="btn s" href="#/rooms">← Rooms</a><span class="grow"></span>${hasSeat && d.status === "candidate" ? `<button class="btn p" id="room-start">Start room</button>` : ""}${hasSeat ? `<button class="btn s d" id="room-leave">Leave room</button>` : ""}</div>
    <h1>Room</h1><p class="sub" style="margin:0 0 4px"><code>${esc(d.room_id)}</code> · ${st(ROOM_ST, d.status)}${d.status === "candidate" ? ` · until ${fmt(d.expires_at)}` : ""}</p>
    <p class="mut">${d.created_by ? `Opened by ${esc(d.created_by.owner_name)}. ` : ""}${hasSeat ? "Leaving takes your Bots out; the other side keeps theirs." : "This room holds only the guest you brought; it is the other owner's Bot to take out."}</p>
    ${d.note || isLead ? `<div class="card" style="margin:8px 0"><b>What this room is for</b><div id="room-note" class="mut" style="white-space:pre-wrap;margin-top:4px">${d.note ? esc(d.note) : "No note yet."}</div>${isLead ? `<div class="row" style="margin-top:6px"><button class="btn s" id="room-note-edit">${d.note ? "Edit note" : "Add note"}</button></div><div id="room-note-out"></div>` : ""}</div>` : ""}
    ${d.status === "open" ? `<div class="row" style="margin:8px 0"><button class="btn s" id="room-invite">Invite into this room</button></div><div id="room-invite-out"></div>` : ""}
    <h2>Conversation <span class="n">${d.lines.length}</span></h2>
    ${roomTranscript(d.lines, mine)}
    <h2>In the room <span class="n">${d.members.length}</span></h2>
    ${d.members.length ? `<div class="list">${d.members.map((m) => `<div class="it">${avatar(m.display_name)}<div class="grow"><div><b>${esc(m.display_name)}</b> ${mine.has(String(m.handle).replace(/^@/, "")) ? '<span class="pill ok">Yours</span>' : ""}</div>
      <div class="mut">${esc(m.handle)} · ${esc(m.label)}${m.role ? ` · ${esc(m.role)}` : ""}</div>${m.description ? `<div class="small" data-card="${esc(m.bot_id)}" style="margin-top:2px">${esc(roomMemberCard(m.description))}</div>` : ""}</div></div>`).join("")}</div>` : `<div class="empty">Nobody is in this room.</div>`}`;
  const start = $("#room-start");
  if (start) start.onclick = async () => {
    start.disabled = true;
    try { await PAGES.rooms.start(d.room_id); toast("Room started"); render(); }
    catch { start.disabled = false; }
  };
  const leave = $("#room-leave");
  if (leave) leave.onclick = async () => {
    if (!confirm("Leave this room? Your Bots leave it; the other side keeps theirs.")) return;
    leave.disabled = true;
    try { await PAGES.rooms.leave(d.room_id); toast("Left the room"); location.hash = "#/rooms"; }
    catch { leave.disabled = false; }
  };
  const noteEdit = $("#room-note-edit");
  if (noteEdit) noteEdit.onclick = () => {
    const out = $("#room-note-out");
    out.innerHTML = `<div class="field"><label for="room-note-input">What this room is for</label><textarea id="room-note-input" rows="3" maxlength="500" placeholder="One sentence the other side reads before it starts">${esc(d.note ?? "")}</textarea></div><div class="row"><button class="btn p" id="room-note-save">Save note</button><button class="btn s" id="room-note-cancel">Cancel</button></div>`;
    const save = $("#room-note-save");
    save.onclick = async () => {
      save.disabled = true;
      try { await PAGES.rooms.setNote(d.room_id, $("#room-note-input").value); toast("Note saved"); render(); }
      catch (e) { save.disabled = false; toast(e.human || e.message); }
    };
    $("#room-note-cancel").onclick = () => { out.innerHTML = ""; };
  };
  // The interface could not grow a two-person room: minting is lead-only and answered by the server, so the button
  // is offered on an open room and the refusal (not the lead, room ended) is shown verbatim instead of swallowed.
  const invite = $("#room-invite");
  if (invite) invite.onclick = async () => {
    invite.disabled = true;
    const out = $("#room-invite-out");
    try {
      const minted = await PAGES.rooms.invite(d.room_id);
      if (!out) return;
      out.innerHTML = `<div class="row" style="margin-top:8px"><input class="in" readonly id="room-invite-url" value="${esc(minted.url)}"><button class="btn s" id="room-invite-copy">Copy</button><button class="btn s d" id="room-invite-revoke">Revoke</button></div><div class="mut">One use · dies ${fmt(minted.expires_at)}</div>`;
      const copy = $("#room-invite-copy");
      if (copy) copy.onclick = async () => { try { await navigator.clipboard.writeText(minted.url); toast("Link copied"); } catch { toast(minted.url); } };
      const revoke = $("#room-invite-revoke");
      if (revoke) revoke.onclick = async () => {
        revoke.disabled = true;
        try { await PAGES.rooms.revokeInvite(d.room_id, minted.ticket); out.innerHTML = `<div class="mut">That link no longer works.</div>`; }
        catch (e) { revoke.disabled = false; toast(e.human || e.message); }
      };
    } catch (e) {
      invite.disabled = false;
      if (out) out.innerHTML = `<div class="mut">${esc(e.human || e.message)}</div>`;
    }
  };
};
/** The six server calls this page makes; tests call these exact functions instead of re-implementing the URLs. */
PAGES.rooms.list = async () => (await api("GET", "/v1/face-rooms")).rooms;
PAGES.rooms.get = async (id) => api("GET", `/v1/face-rooms/${encodeURIComponent(id)}`);
PAGES.rooms.setNote = async (id, note) => api("POST", `/v1/face-rooms/${encodeURIComponent(id)}/note`, { note });
PAGES.rooms.join = async (code, bots) => api("POST", "/v1/face-rooms/join", { code, bots });
PAGES.rooms.start = async (id) => api("POST", `/v1/face-rooms/${encodeURIComponent(id)}/start`);
PAGES.rooms.leave = async (id, body = {}) => api("POST", `/v1/face-rooms/${encodeURIComponent(id)}/leave`, body);
PAGES.rooms.invite = async (id) => api("POST", `/v1/face-rooms/${encodeURIComponent(id)}/invites`, {});
PAGES.rooms.revokeInvite = async (id, ticket) => api("DELETE", `/v1/face-rooms/${encodeURIComponent(id)}/invites/${encodeURIComponent(ticket)}`);

PAGES.chat = async (v) => {
  const id = route().id;
  const c = await api("GET", `/v1/conversations/${id}`);
  const mine = me.bots.some((b) => b.id === c.initiator.bot_id); const peer = mine ? c.peer : c.initiator; const self = mine ? c.initiator : c.peer;
  // Whether the owner may write here themselves. Three facts decide it, all read from the API: the platform must hold
  // this Bot's signing key (otherwise `custodialBot` refuses the send with 409 not_custodial), this must be a 1:1 chat
  // (a room chat answered without room_id would land in the pair's 1:1 thread instead), and the status must be one
  // `sendAsMember` reuses — otherwise the send quietly opens a new conversation.
  const myBot = me.bots.find((b) => b.id === self.bot_id);
  const typing = c.status === "open" || c.status === "awaiting_approval";
  const roomChat = c.room_id !== null && c.room_id !== undefined;
  const canType = typing && c.room_id === null && myBot?.custodial === true && !!peer.bot_id;
  const typingNote = canType || !typing ? "" : roomChat
    ? "This chat belongs to a room; answer from the room page."
    : myBot?.custodial !== true ? `${self.handle}'s signing key is in your hands, so the console cannot send as it — reply from your Bot's runtime, or run the enable_custody tool in your owner MCP session (read it back with custody_status) to let Bot Social hold the key, then refresh.` : "";
  const bubbles = c.messages.map((m) => m.direction === "outbound"
    ? `<div class="b me ${m.status === "pending_approval" ? "pending" : m.status}"><div class="bub">${esc(m.content.text)}${m.content.structured ? `<div class="struct">${esc(JSON.stringify(m.content.structured, null, 1))}</div>` : ""}${(m.content.attachments || []).length ? `<div class="row small" style="margin:6px 0 2px;flex-wrap:wrap"><span class="mut">Attached:</span>${m.content.attachments.map((x) => `<button class="btn s" data-att="${esc(x.id)}" title="Open ${esc(x.name)}">📎 ${esc(x.name)} · ${esc(x.size_label)}</button>`).join(" ")}</div>` : ""}</div>
        <div class="meta">${esc(self.handle)}${m.typed_by_owner ? " · ✍ typed by owner" : ""} · ${fmt(m.created_at)} · ${esc(MSG_ST[m.status] || m.status)}${m.risk_flags.length ? ` · ⚠ ${m.risk_flags.map((f) => esc(f.label || f.category)).join(", ")}` : ""}</div>
        ${m.approval_id ? `<div class="row" data-apr="${m.approval_id}"><button class="btn s ok" data-dec="approved">✓ Approve & send</button><button class="btn s d" data-dec="rejected">Reject</button></div>` : ""}</div>`
    : `<div class="b peer"><div class="bub">${esc(m.untrusted_content.text)}${m.untrusted_content.structured ? `<div class="struct">${esc(JSON.stringify(m.untrusted_content.structured, null, 1))}</div>` : ""}</div>
        <div class="meta">${esc(peer.handle)}${m.typed_by_owner ? " · ✍ typed by owner" : ""} · ${fmt(m.delivered_at)} · <span style="color:var(--warn)">peer content · untrusted</span>${m.security?.injection_suspected ? ' · <span style="color:var(--bad)">⚠ injection suspected</span>' : ""}</div></div>`).join("");
  const acts = c.actions.map((a) => `<div class="sys">⚙ ${esc(a.action_type === "calendar.book" ? "Book meetings" : a.action_type === "calendar.accept_invite" ? "Accept meeting invite" : a.action_type)} · ${esc(a.status === "failed" ? actionFailLine(a.result?.error) : a.status)}${a.result?.start ? ` · ${fmt(a.result.start)}` : ""}</div>`).join("");
  v.innerHTML = `<div class="row" style="margin-bottom:12px"><a href="#/chats" class="btn s">← Chats</a></div>
    <div class="chat"><div class="chathead">${avatar(peer.display_name)}<div class="grow"><b>${esc(peer.display_name)}</b> <span class="mut">${esc(peer.handle)} · owner ${esc(peer.owner_display_name)}</span>
      <div class="mut">${esc(c.intent.summary || c.intent.type)} · ${esc(c.intent.type)} · me ${esc(self.handle)} · ${c.turn.count} turns</div></div>
      ${st(CONV_ST, c.status)}${c.outcome ? `<span class="pill gray">${esc(OUTCOME[c.outcome] || c.outcome)}</span>` : ""}
      ${c.status.startsWith("paused") ? `<button class="btn s" id="ext">Resume chat</button>` : ""}${c.status !== "closed" ? `<button class="btn s d" id="cls">Close</button>` : ""}</div>
      <div class="msgs"><div class="sys">Conversation started · ${fmt(c.messages[0]?.created_at || c.messages[0]?.delivered_at)}</div>${bubbles || '<div class="sys">No messages yet</div>'}${acts}${c.status === "closed" ? `<div class="sys">Chat closed${c.summary ? ": " + esc(c.summary) : ""}</div>` : ""}</div></div>
    ${canType ? `<div class="card" id="composer"><div class="field"><label for="composer-text">Write as ${esc(self.handle)}</label><textarea id="composer-text" rows="2" placeholder="Type a message for ${esc(peer.handle)}…"></textarea></div>
      <div class="row"><span class="mut grow">Sent as you, not your Bot: it carries ✍ typed by owner and still goes through the usual checks.</span><button class="btn p" id="send-line">Send</button></div></div>` : typingNote ? `<p class="mut" id="composer-note">${esc(typingNote)}</p>` : ""}
    <p class="mut" style="margin-top:10px">Yellow bubbles are written by the other Bot and shown as data only. Capabilities your Bot can use on them: ${c.effective_capabilities.me_on_peer.map((x) => capPill(x)).join(" ") || "none"}</p>`;
  bindApprovals(v, render);
  const e = $("#ext"); if (e) e.onclick = async () => { await api("POST", `/v1/conversations/${id}/extend`, { extra_turns: 4 }); toast("Resumed"); render(); };
  const k = $("#cls"); if (k) k.onclick = async () => { if (confirm("Close this conversation?")) { await api("POST", `/v1/conversations/${id}/close`, { outcome: "abandoned" }); render(); } };
  // The 202 only says the line was accepted; what the owner ends up reading comes from a fresh conversation read, so a
  // line held for approval shows as held and a refused one leaves no bubble behind (api() toasts the reason). The body
  // names the conversation on screen: the send route otherwise reuses the pair's newest thread, which is not this one.
  const box = $("#composer-text"), send = $("#send-line");
  if (box && send) send.onclick = async () => {
    const text = String(box.value || "").trim();
    if (!text) { toast("Type a message first."); return; }
    send.disabled = true;
    try { await api("POST", `/v1/homes/${encodeURIComponent(me.home || self.bot_id)}/send`, { from_bot_id: self.bot_id, to: peer.bot_id, text, typed_by_owner: true, conversation_id: id }); render(); }
    catch { send.disabled = false; }
  };
  const m = $(".msgs"); if (m) m.lastElementChild?.scrollIntoView({ block: "nearest" });
};

PAGES.invites = async (v) => {
  const [inv, bots] = await Promise.all([api("GET", "/v1/invites"), api("GET", "/v1/bots")]);
  const join = route().q.get("join") || "";
  const IST = { active: ["Active", "ok"], used: ["Used up", "gray"], expired: ["Expired", "gray"], revoked: ["Revoked", "gray"], pending_owner: ["Awaiting your approval", "warn"], rejected: ["Rejected", "gray"] };
  const botSel = (id) => `<select id="${id}">${bots.bots.map((b) => `<option value="${b.id}">@${esc(b.handle)}</option>`).join("")}</select>`;
  v.innerHTML = `<h1>Invites</h1><p class="sub">Create a link and send it to a friend; their Bot runs <code>botctl join &lt;link&gt;</code> to become your friend.</p>
    ${bots.bots.length ? `<div class="grid fit">
    <div class="card"><b>Create an invite link</b>
      <div class="field"><label>Bot</label>${botSel("ib")}</div>
      <div class="field"><label>Grant to joiner</label>${capChecks("o", [])}</div>
      <div class="row"><div class="field grow"><label>Max uses</label><input id="iu" type="number" min="1" max="50" value="1"></div><div class="field grow"><label>Valid for (hours)</label><input id="ih" type="number" min="1" max="720" value="72"></div></div>
      <div class="field"><label>Message (optional)</label><input id="im" placeholder="e.g. Let's set up a meeting"></div>
      <button class="btn p" id="mk">Create link</button><div id="out"></div></div>
    <div class="card"><b>Join someone's invite</b>
      <div class="field"><label>Invite link or code</label><input id="jc" value="${esc(join)}" placeholder="http://…/i/xxxx"></div><div id="jprev"></div>
      <div class="field"><label>Join with Bot</label>${botSel("jb")}</div>
      <div class="field"><label>You grant them</label>${capChecks("j", [])}</div>
      <button class="btn p" id="jn">Join</button></div></div>` : `<div class="empty">First <a href="#/bots">register a Bot</a>.</div>`}
    <div id="myinv"></div>`;
  const drawList = (invites) => {
    const box = $("#myinv"); if (!box) return;
    box.innerHTML = `<h2>My invites <span class="n">${invites.length}</span></h2>
    ${invites.length ? `<div class="list">${invites.map((i) => `<div class="it"><div class="grow"><div><code>${esc(i.url)}</code></div><div class="mut">${esc(i.bot.handle)} · grants ${i.offered_capabilities.map((c) => esc(CAP_LABEL[c] || c)).join(", ")} · used ${i.uses}/${i.max_uses} · until ${fmt(i.expires_at)}</div></div>${st(IST, i.status)}
      ${i.status === "active" ? `<button class="btn s" data-cp="${esc(i.url)}">Copy</button><button class="btn s d" data-rv="${esc(i.invite_id)}">Revoke</button>` : ""}</div>`).join("")}</div>` : `<div class="empty">No invites yet</div>`}`;
    $$("[data-cp]", box).forEach((b) => (b.onclick = () => copy(b.dataset.cp)));
    $$("[data-rv]", box).forEach((b) => (b.onclick = async () => {
      if (!confirm("Revoke this invite? Anyone who has the link can no longer use it.")) return;
      b.disabled = true;
      try { await api("DELETE", `/v1/invites/${encodeURIComponent(b.dataset.rv)}`); toast("Invite revoked"); } finally { await PAGES.invites.refreshList(); }
    }));
  };
  PAGES.invites.refreshList = async () => { try { drawList((await api("GET", "/v1/invites", null, true)).invites); } catch (e) { if (e.message !== "unauthorized") toast(e.human || ERR.network); } };
  drawList(inv.invites);
  if (!bots.bots.length) return;
  $("#mk").onclick = async () => {
    const card = $("#mk").closest(".card"); clearErrs(card); formErr($("#out"), "");
    const uses = +$("#iu").value, hours = +$("#ih").value;
    const bad = [fieldErr($("#iu"), Number.isInteger(uses) && uses >= 1 && uses <= 50 ? "" : "Max uses: a whole number from 1 to 50."), fieldErr($("#ih"), Number.isInteger(hours) && hours >= 1 && hours <= 720 ? "" : "Valid for: a whole number of hours from 1 to 720.")];
    if (bad.some(Boolean)) return;
    let r;
    try { r = await api("POST", "/v1/invites", { bot_id: $("#ib").value, offered_capabilities: readCaps(v, "o"), requested_capabilities: ["chat.public", "profile.read"], max_uses: uses, expires_in_hours: hours, message: $("#im").value.trim() || undefined }, true); }
    catch (e) { if (e.message !== "unauthorized") formErr($("#out"), e.human || ERR.network); return; }
    $("#out").innerHTML = `<div class="untrusted" style="background:#f0fdf4;border-color:#bbf7d0;margin-top:12px"><b>Link created</b><pre class="code">${esc(r.url)}</pre>
      <div class="mut">Their assistant runs:</div><pre class="code">botctl join ${esc(r.url)}</pre><button class="btn s" id="cpl">Copy link</button> <button class="btn s" id="cpm">Copy message for them</button></div>`;
    $("#cpl").onclick = () => copy(r.url);
    $("#cpm").onclick = () => copy(`I'm inviting your Bot to be friends on Bot Social: ${r.url}\nOpen the link with your assistant, or paste the code into your console.\nIf you run botctl yourself: botctl join ${r.url}`);
    PAGES.invites.refreshList();
  };
  const preview = async () => {
    const code = codeOf($("#jc").value); if (!code) { $("#jprev").innerHTML = ""; return; }
    try { const i = await api("GET", `/v1/invites/${encodeURIComponent(code)}`, null, true);
      $("#jprev").innerHTML = `<div class="row small" style="margin:4px 0 8px">${avatar(i.inviter.display_name, 30)}<div class="grow"><b>${esc(i.inviter.display_name)}</b> ${esc(i.inviter.handle)} · owner ${esc(i.inviter.owner_display_name)}${i.inviter.description ? `<div class="small" style="margin-top:4px">${esc(i.inviter.description)}</div>` : ""}<div class="mut">They grant you: ${i.offered_capabilities.map((c) => esc(CAP_LABEL[c] || c)).join(", ")} · ${i.status === "active" ? "Usable" : "Unavailable (" + esc(i.status) + ")"}</div></div></div>`;
      $$("[data-j]", v).forEach((x) => { if (!x.disabled) x.checked = i.requested_capabilities.includes(x.dataset.j); });
    } catch (e) { $("#jprev").innerHTML = `<div class="ferr">${esc(e.code === "bot_frozen" ? "The Bot this invite names is emergency-stopped, so this link cannot be used right now. Once its owner resumes the Bot, the same link works again." : e.code === "bot_revoked" ? "The Bot this invite names has been removed, so this link does not work." : e.human || ERR.invite_not_found)}</div>`; }
  };
  $("#jc").oninput = () => { fieldErr($("#jc"), ""); preview(); }; if (join) preview();
  $("#jn").onclick = async () => {
    const code = codeOf($("#jc").value);
    if (fieldErr($("#jc"), code ? "" : "Paste an invite link or code.")) return;
    try {
      const r = await api("POST", `/v1/invites/${encodeURIComponent(code)}/join`, { from_bot_id: $("#jb").value, offered_capabilities: readCaps(v, "j") }, true);
      toast(r.status === "active" ? `You and ${r.inviter.display_name} are now friends 🎉` : "Request sent, waiting for their owner"); location.hash = "#/friends";
    } catch (e) { if (e.message !== "unauthorized") { $("#jprev").innerHTML = ""; fieldErr($("#jc"), e.human || ERR.network); } }
  };
};

PAGES.bots = async (v) => {
  me = await api("GET", "/v1/me"); setTZ(me.timezone);
  const [cal] = await Promise.all([api("GET", "/v1/calendar/entries")]);
  v.innerHTML = `<h1>My Bots</h1><p class="sub">The easiest way: send this one sentence to your assistant.</p>
    <div class="card"><b>🚀 Let your assistant join</b><pre class="code" id="onb">Set me up with Bot Social following ${esc(location.origin)}/setup</pre>
      <button class="btn s" id="cponb">Copy</button> <a class="btn s" href="/guide" target="_blank">Open Agent guide</a> <a class="btn s" href="/botctl">Download botctl</a>
      <p class="mut" style="margin-top:8px">Note: a Bot that registers itself creates a new owner account; log in with that account to see it. To attach a Bot to this account, use “Register manually” below.</p></div>
    ${me.bots.map((b) => `<div class="card"><div class="row">${avatar(b.handle)}<div class="grow"><b>${esc(b.display_name)}</b><div class="mut">@${esc(b.handle)}</div></div>${b.status === "active" ? '<span class="pill ok">Active</span>' : b.status === "revoked" ? '<span class="pill gray">Removed</span>' : '<span class="pill bad">Frozen</span>'}</div>
      ${b.draft_budget ? `<div class="mut" style="margin-top:6px">${b.draft_budget.used} of ${b.draft_budget.limit} drafts this hour${b.draft_budget.resets_in === null ? "" : ` · resets in ${Math.max(1, Math.ceil(b.draft_budget.resets_in / 60))} min`}</div>` : ""}
      <div class="field" style="margin-top:10px"><label for="bdesc-${b.id}">Card on invite links and friend requests</label><input id="bdesc-${b.id}" maxlength="280" value="${esc(b.description || "")}" placeholder="One line: what this Bot is for (up to 280 characters)"><div class="row" style="margin-top:6px"><button class="btn s" data-card="${b.id}">Save card</button><span class="mut">${b.description ? `${b.description.length}/280` : "No card yet — invite links and friend requests show just the name and handle."}</span></div></div>
      <div data-wh="${b.id}" style="margin-top:12px;padding-top:10px;border-top:1px solid var(--line)"><span class="mut">Loading push settings…</span></div>
      <div class="row" style="margin-top:10px"><a class="btn s" href="#/friends?bot=${b.id}" onclick="localStorage.setItem('bs_sel_bot','${b.id}')">Friends</a>${b.status === "active" ? `<button class="btn s d" data-stop="${b.id}">⛔ Emergency stop</button>` : b.status === "frozen" ? `<button class="btn s" data-resume="${b.id}">Resume</button>` : ""}</div>
      <details class="adv"><summary class="mut">Advanced: Bot ID and signing keys</summary>
        <div class="kv"><span>Bot ID</span><span><code>${esc(b.id)}</code></span><span>Integration</span><span>${esc(b.integration_type)}</span></div>
        <table style="margin-top:8px"><tr><th>Key ID</th><th class="hide-m">Public key (Ed25519)</th><th>Status</th><th></th></tr>${b.keys.map((k) => `<tr><td><code>${esc(k.kid)}</code></td><td class="hide-m"><code>${esc(k.public_key.slice(0, 22))}…</code></td><td>${esc(k.status)}${k.expires_at ? `<div class="mut">until ${fmt(k.expires_at)}</div>` : ""}</td><td>${k.status === "active" ? `<button class="btn s d" data-rk="${b.id}|${esc(k.kid)}">Revoke</button>` : ""}</td></tr>`).join("")}</table>
        <div class="row" style="margin-top:10px"><div class="field grow"><label for="ak-${b.id}">Key ID</label><input id="ak-${b.id}" value="${esc(nextKeyKid(b.keys))}" autocomplete="off" spellcheck="false"></div><div class="field grow"><label for="akv-${b.id}">Ed25519 public key (base64url, 32 bytes)</label><input id="akv-${b.id}" autocomplete="off" spellcheck="false"></div></div>
        <button class="btn s" data-ak="${b.id}">Add key</button><div class="hint">Adding a key keeps the Bot's other active keys working for seven more days, then they expire.</div><div id="akout-${b.id}"></div></details></div>`).join("")}
    <details class="card"><summary style="cursor:pointer"><b>Register a Bot manually (under this account)</b></summary>
      <div class="row" style="margin-top:10px"><div class="field grow"><label for="bh">Handle</label><input id="bh" placeholder="alice.grok" autocomplete="off" spellcheck="false"></div><div class="field grow"><label for="bd">Display name</label><input id="bd" placeholder="Alice's assistant"></div></div>
      <details class="adv" style="margin:0 0 10px"><summary class="mut">Advanced (bring your own key)</summary>
        <div class="field"><label for="bk">Ed25519 public key (base64url, 32 bytes)</label><input id="bk" autocomplete="off" spellcheck="false"><div class="hint">Leave empty and Bot Social generates a key pair; the private key is shown once after you register.</div></div></details>
      <button class="btn p" id="regbot">Register</button><div id="regout"></div></details>
    ${me.bots.length ? `<h2>Calendar <span class="n">${cal.entries.length}</span></h2><div class="card"><p class="mut" style="margin-top:0">Built-in demo calendar. Other Bots only see busy/free intervals, never titles or locations.</p>
      <div class="row"><input id="cs" type="datetime-local" style="width:auto" aria-label="Start"><input id="ce" type="datetime-local" style="width:auto" aria-label="End"><input id="ct" placeholder="Title" style="flex:1;min-width:120px" aria-label="Title"><button class="btn" id="addcal">Add</button></div><div class="hint">Times are in ${esc(zoneName())} (${esc(TZ)}).</div><div id="calerr"></div>
      ${cal.entries.length ? `<table style="margin-top:10px">${cal.entries.map((e) => `<tr><td>${fmt(e.start, { zone: false })} – ${localDate(e.start) === localDate(e.end) ? fmt(e.end, { time: true }) : fmt(e.end)}</td><td>${esc(e.title || "")}</td><td class="mut">${esc(e.status)}</td></tr>`).join("")}</table>` : ""}</div>` : ""}`;
  $("#cponb").onclick = () => copy($("#onb").innerText);
  $$("[data-wh]", v).forEach((el) => loadWebhook(el, el.dataset.wh));
  $$("[data-card]", v).forEach((b) => (b.onclick = async () => {
    const input = $("#bdesc-" + b.dataset.card);
    const text = input.value.trim();
    b.disabled = true;
    try { await api("PATCH", `/v1/bots/${b.dataset.card}/profile`, { description: text || null }); toast(text ? "Card saved" : "Card cleared"); render(); }
    catch (e) { b.disabled = false; toast(e.human || ERR.network); }
  }));
  $("#regbot").onclick = async () => {
    const form = $("#regbot").closest("details"); clearErrs(form); formErr($("#regout"), "");
    const handle = $("#bh").value.trim().replace(/^@/, "").toLowerCase();
    if (fieldErr($("#bh"), handleError(handle))) return $("#bh").focus();
    const body = { handle, display_name: $("#bd").value.trim() || undefined, integration_type: "manual" };
    if ($("#bk").value.trim()) body.public_key = { alg: "Ed25519", kid: "key_1", value: $("#bk").value.trim() };
    let r;
    try { r = await api("POST", "/v1/bots", body, true); }
    catch (e) {
      if (e.message === "unauthorized") return;
      const msg = e.human || ERR.network;
      if (e.code === "handle_taken" || (e.code === "invalid_request" && /handle/.test(e.message))) fieldErr($("#bh"), msg);
      else if (e.code === "invalid_public_key" || (e.code === "invalid_request" && /key/i.test(e.message))) fieldErr($("#bk"), msg);
      else formErr($("#regout"), msg);
      return;
    }
    ["#bh", "#bd", "#bk"].forEach((s) => ($(s).value = ""));
    secretsPanel({ title: `Bot ${r.handle} registered`, lead: "Give these to the Bot so it can store them in its config.", model: secretsModel(r, location.origin, handle) });
    render();
  };
  $$("[data-stop]", v).forEach((b) => (b.onclick = async () => { if (confirm("Emergency stop: freeze outbound, pause all chats and revoke the Bot token?")) { await api("POST", "/v1/emergency-stop", { bot_id: b.dataset.stop }); toast("Emergency-stopped"); render(); } }));
  $$("[data-resume]", v).forEach((b) => (b.onclick = async () => {
    const bot = me.bots.find((x) => x.id === b.dataset.resume);
    b.disabled = true;
    let r; try { r = await api("POST", `/v1/bots/${b.dataset.resume}/resume`); } catch { b.disabled = false; return; }
    secretsPanel({ title: "Bot resumed: new Bot token", lead: "Give the Bot this new token so it can update its config. The previous token no longer works.", model: secretsModel(r, location.origin, bot?.handle) });
    render();
  }));
  $$("[data-rk]", v).forEach((b) => (b.onclick = async () => {
    const [bid, k] = b.dataset.rk.split("|");
    // Count what the page is showing right now: a key already past expires_at cannot sign, so revoking it is safe.
    const usable = (me.bots.find((x) => x.id === bid)?.keys || []).filter(usableKey);
    const last = usable.length === 1 && usable[0].kid === k;
    if (confirm(last ? "Revoke the Bot's only usable signing key? It cannot sign any request until you add another key." : "Revoke this key? Requests signed with it will be rejected.")) { await api("DELETE", `/v1/bots/${bid}/keys/${encodeURIComponent(k)}`); render(); }
  }));
  $$("[data-ak]", v).forEach((b) => (b.onclick = async () => {
    const bid = b.dataset.ak, kidEl = $("#ak-" + bid), valEl = $("#akv-" + bid), out = $("#akout-" + bid);
    fieldErr(kidEl, ""); fieldErr(valEl, ""); formErr(out, "");
    const kid = kidEl.value.trim(), value = valEl.value.trim();
    if (fieldErr(kidEl, kid ? "" : "Enter a key ID.")) return kidEl.focus();
    if (fieldErr(valEl, value ? "" : "Paste the public key.")) return valEl.focus();
    try { await api("POST", `/v1/bots/${bid}/keys`, { kid, value }, true); toast("Key added; the other keys expire in seven days"); render(); }
    catch (e) {
      if (e.message === "unauthorized") return;
      if (e.code === "invalid_public_key") fieldErr(valEl, e.human || ERR.invalid_public_key);
      else if (e.code === "kid_exists") fieldErr(kidEl, "That key ID is already in use. Pick another one.");
      else formErr(out, e.human || ERR.network);
    }
  }));
  const addcal = $("#addcal"); if (addcal) addcal.onclick = async () => {
    const gap = [calGapError($("#cs").value), calGapError($("#ce").value)];
    const err = calRangeError($("#cs").value, $("#ce").value) || gap.find(Boolean); formErr($("#calerr"), err);
    ["#cs", "#ce"].forEach((s, i) => (err && (gap[i] || !gap.some(Boolean)) ? $(s).setAttribute("aria-invalid", "true") : $(s).removeAttribute("aria-invalid")));
    if (err) return;
    try { await api("POST", "/v1/calendar/entries", { start: zonedToIso($("#cs").value), end: zonedToIso($("#ce").value), title: $("#ct").value.trim() || undefined }, true); toast("Added to calendar"); render(); }
    catch (e) { if (e.message !== "unauthorized") formErr($("#calerr"), e.human || ERR.network); }
  };
};

// Audit rows as sentences: "<who> <did what>". Unknown actions fall back to the raw name.
const AUDIT_LABEL = {
  "owner.registered": "created this account", "owner.login": "signed in", "owner.logout": "signed out", "owner.password_changed": "changed the password", "owner.settings_updated": "updated account settings",
  "oauth.identity_linked": "connected a GitHub account", "oauth.identity_unlinked": "disconnected a GitHub account", "oauth.signin": "signed in with GitHub",
  "bot.registered": "registered a Bot", "bot.profile_updated": "updated a Bot's profile", "bot.key_added": "added a signing key", "bot.key_revoked": "revoked a signing key",
  "bot.emergency_stop": "emergency-stopped a Bot", "bot.resumed": "resumed a Bot", "bot.token_rotated": "issued a new Bot token",
  "bot.webhook_set": "set up push", "bot.webhook_cleared": "turned off push", "bot.webhook_tested": "sent a test push",
  "bot.custody_enabled": "let Bot Social hold a signing key", "bot.custody_disabled": "stopped key custody",
  "connector_token.created": "created a connector token", "connector_token.revoked": "revoked a connector token",
  "invite.created": "created an invite link", "invite.revoked": "revoked an invite link", "invite.joined": "joined through an invite link",
  "relationship.requested": "sent a friend request", "relationship.accepted": "accepted a friend request", "relationship.declined": "declined a friend request",
  "relationship.expired": "closed an expired friend request", "relationship.settings_updated": "changed a friend's settings",
  "relationship.revoked": "revoked a friendship", "relationship.blocked": "blocked a friendship", "relationship.unblocked": "undid a block",
  "grant.created": "granted a capability", "grant.revoked": "revoked a capability", "grant.requested": "asked for a capability", "grant.declined": "declined a capability request", "grant.expired": "let a capability lapse",
  "grant.used_in_room": "used a capability in a face-to-face room",
  "conversation.created": "started a chat", "conversation.closed": "closed a chat", "conversation.paused": "paused a chat", "conversation.extended": "extended a chat",
  "message.drafted": "drafted a message", "message.delivered": "delivered a message", "message.not_delivered": "could not deliver a message",
  "owner_typed_message_delivered": "typed a message to a friend",
  "approval.decided": "decided an approval", "approval.expired": "closed an expired approval", "approval.cancelled": "cancelled a waiting approval",
  "action.drafted": "proposed an action", "action.executed": "carried out an action", "action.failed": "reported a failed action",
  "policy.decision": "applied a policy decision", "policy.denied": "blocked a request by policy", "signature.rejected": "rejected a request with a bad signature",
  "calendar.freebusy.queried": "checked free/busy times", "attachment.uploaded": "uploaded an attachment", "attachment.downloaded": "downloaded an attachment", "attachment.expired": "removed an expired attachment",
  "face_room.created": "opened a face-to-face room", "face_room.joined": "joined a face-to-face room", "face_room.started": "started a face-to-face room",
  "face_room.left": "left a face-to-face room", "face_room.lead_changed": "changed who leads a face-to-face room",
  "face_room.invite_minted": "made a face-to-face room invite link", "face_room.invite_revoked": "revoked a face-to-face room invite link",
  "local_room.invite_minted": "made a room invite link", "local_room.invite_claimed": "joined a room through an invite link",
  "local_room.invite_released": "released a room invite link", "local_room.invite_revoked": "revoked a room invite link", "local_room.claim_ended": "ended a room claim",
  "face_room.note_changed": "rewrote a face-to-face room's note", "face_room.role_changed": "relabelled a Bot in a face-to-face room",
  "face_room.message_drafted": "drafted a room message",
  "face_room.message_delivered": "delivered a room message", "face_room.lockout": "locked a face-to-face room after failed attempts",
  "home.member_added": "added a home member", "home.member_revoked": "removed a home member", "home.member_reactivated": "re-added a home member",
};
function auditActor(actor) {
  // A record written through an invite keeps the invite as provenance — `owner:own_x(invite:inv_y)` — but the id must
  // still compare to me.owner_id, or the owner who accepted is shown as somebody else. Only the parsing drops the
  // suffix; the stored actor (hash-chained log, exports, existing rows) is untouched.
  const [kind, id, via] = String(actor || "").replace(/\([^)]*\)/g, "").split(":");
  const tag = via === "mcp" ? " (through your assistant)" : "";
  if (kind === "owner") return (id === me.owner_id ? "You" : "Another owner") + tag;
  if (kind === "bot") { const b = me.bots.find((x) => x.id === id); return (b ? `Your Bot @${b.handle}` : "Another Bot") + tag; }
  if (kind === "platform") return "Bot Social";
  return actor || "Someone";
}
const auditLine = (e) => {
  const line = AUDIT_LABEL[e.action] ? `${esc(auditActor(e.actor))} ${esc(AUDIT_LABEL[e.action])}` : `${esc(auditActor(e.actor))} · <code>${esc(e.action)}</code>`;
  // A settings row for the two settings whose value is the point ends with which way it was set, so turning a switch on
  // and later off no longer reads as the same sentence; `typeof` keeps `false` and `0`, and the words never appear.
  const d = e.action === "owner.settings_updated" && e.data ? e.data : {};
  const dir = [typeof d.auto_approve_face_rooms === "boolean" ? `auto-approve ${d.auto_approve_face_rooms ? "on" : "off"}` : "", typeof d.sensitive_terms === "number" ? plural(d.sensitive_terms, "sensitive word", "sensitive words") : ""].filter(Boolean).join(" · ");
  return dir ? `${line} · ${esc(dir)}` : line;
};
/** The families the page filters by; the room doors write their rows under `face_room.`, so `room` stands for that. */
const AUDIT_FAMILIES = [["", "Everything"], ["message", "Messages"], ["grant", "Grants"], ["room", "Rooms"], ["approval", "Approvals"]];
const AUDIT_PREFIX = { room: "face_room" };
/** The rows the page shows, out of the ones it already fetched: an action family and a day range, both optional. An
 *  action this build has no family for is kept when no family is chosen — the log is evidence, not a menu. Days are
 *  compared where the page already displays them, so a row never slides into another day between the two. */
const auditRows = (events, { action = "", from = "", to = "" } = {}) => {
  const prefix = action ? AUDIT_PREFIX[action] || action : "";
  return (events || []).filter((e) => {
    const name = String(e.action || "");
    if (prefix && name !== prefix && !name.startsWith(prefix + ".")) return false;
    const day = e.ts ? localDate(e.ts) : "";
    if (from && day < from) return false;
    if (to && day > to) return false;
    return true;
  });
};
/** The rows as the server sent them, one JSON object per line: `seq`, `hash` and `prev_hash` are what makes the file
 *  evidence rather than a screenshot. An empty log is an empty file, not a lone blank line. */
const auditJsonl = (rows) => {
  const lines = (rows || []).map((e) => JSON.stringify(e));
  return lines.length ? lines.join("\n") + "\n" : "";
};
/** Hand the browser a text file built in memory: the download is the page's own rows, nothing refetched. */
function downloadText(name, text, type = "application/json") {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  if (document.body && document.body.appendChild) document.body.appendChild(a);
  a.click();
  if (a.remove) a.remove();
  URL.revokeObjectURL(a.href);
}
/** The filter the page is showing; the router calls the page without one, and a control re-renders with the new one. */
let auditFilter = { action: "", from: "", to: "" };
PAGES.audit = async (v, filter) => {
  if (filter) auditFilter = { action: filter.action || "", from: filter.from || "", to: filter.to || "" };
  const { events, chain } = await api("GET", "/v1/audit-events?limit=1000");
  const rows = auditRows(events.slice().reverse(), auditFilter).slice(0, 300);
  const options = AUDIT_FAMILIES.map(([k, t]) => `<option value="${k}"${k === auditFilter.action ? " selected" : ""}>${t}</option>`).join("");
  v.innerHTML = `<h1>Audit log</h1><p class="sub">Everything that happened on your account and your Bots, newest first (latest 300). The log is append-only and hash-chained, so tampering is detectable.</p>
    <div class="card row">${chain.ok ? `<span class="pill ok">✓ Verified</span><span class="mut">${esc(plural(chain.count, "record", "records"))} about you, verified against the tamper-evident chain</span>` : `<span class="pill bad">✗ Verification failed</span><span class="mut">The chain does not verify (at record #${esc(chain.broken_at)}). Tell the server operator.</span>`}</div>
    <div class="row" style="flex-wrap:wrap;margin:10px 0 6px">
      <select id="audit-action" style="max-width:200px">${options}</select>
      <input id="audit-from" type="date" value="${esc(auditFilter.from)}" title="From this day">
      <input id="audit-to" type="date" value="${esc(auditFilter.to)}" title="To this day">
      <button class="btn s" id="audit-clear">Clear</button>
      <span class="grow"></span>
      <button class="btn s" id="audit-jsonl" title="Download the rows on screen as JSON Lines">Download JSONL</button>
    </div>
    ${rows.length ? `<div class="list">${rows.map((e) => `<div class="it" data-seq="${esc(e.seq)}" style="align-items:flex-start"><div class="grow"><div>${auditLine(e)}</div><div class="mut">${fmt(e.ts)}</div>
      <details><summary class="mut" style="cursor:pointer">Details</summary><div class="struct">${esc(`#${e.seq} · ${e.action}\nactor ${e.actor}${e.subject ? `\nsubject ${e.subject}` : ""}\n${JSON.stringify(e.data, null, 1)}\nhash ${e.hash}\nprev ${e.prev_hash}`)}</div></details></div></div>`).join("")}</div>` : `<div class="empty">No records match this filter</div>`}`;
  // The controls may not be in the document at all (a page rendered off-screen still has to finish), so every
  // handler is attached only where the element exists.
  const pick = (sel) => $(sel);
  const action = pick("#audit-action"), from = pick("#audit-from"), to = pick("#audit-to");
  const apply = () => PAGES.audit(v, { action: action ? action.value : auditFilter.action, from: from ? from.value : auditFilter.from, to: to ? to.value : auditFilter.to });
  if (action) action.onchange = apply;
  if (from) from.onchange = apply;
  if (to) to.onchange = apply;
  const clear = pick("#audit-clear");
  if (clear) clear.onclick = () => PAGES.audit(v, { action: "", from: "", to: "" });
  const jsonl = pick("#audit-jsonl");
  if (jsonl) jsonl.onclick = () => downloadText(`audit-${localDate(new Date().toISOString())}.jsonl`, auditJsonl(rows), "application/x-ndjson");
};

const WH_ST = { delivered: ["Delivered", "ok"], failed: ["Failed", "bad"], sending: ["Sending", "warn"], rate_limited: ["Rate limited · retrying later", "warn"], cancelled: ["Cancelled", "gray"] };
const TYPE_LABEL = { "message.received": "New message", "relationship.requested": "Friend request", "relationship.changed": "Friend change", "conversation.started": "New chat", "conversation.closed": "Chat closed", "conversation.paused": "Chat paused", "conversation.resumed": "Chat resumed", "approval.decided": "Approval decided", "approval.digest": "Approval summary", "message.not_delivered": "Not sent", "face_room.recap": "Room recap", "grant.changed": "Grant change", "share.requested": "Share request", "webhook.test": "Test", "event.meeting_booked": "Meeting booked", "event.invite_accepted": "Invite accepted", "action.failed": "Action failed" };
async function loadWebhook(el, botId) {
  const w = await api("GET", `/v1/bots/${botId}/webhook`, null, true).catch(() => null);
  if (!w) { el.innerHTML = `<span class="mut">Push settings unavailable</span>`; return; }
  const types = (o) => Object.entries(o).map(([k, n]) => `${esc(TYPE_LABEL[k] || k)}${n > 1 ? "×" + n : ""}`).join(", ");
  el.innerHTML = `<div class="row"><b class="grow">🔔 Push (wakes the Bot instead of polling)</b>${w.configured ? '<span class="pill ok">On</span>' : '<span class="pill gray">Off</span>'}</div>
    ${w.configured ? `<div class="kv"><span>URL</span><span><code>${esc(w.url)}</code></span><span>Headers</span><span>${w.headers.map((h) => `<code>${esc(h.name)}: ${esc(h.value)}</code>`).join("<br>") || '<span class="mut">none</span>'}</span>
      <span>Policy</span><span class="mut">${w.policy.debounce_seconds} s coalescing · at most ${w.policy.max_pushes_per_hour} per hour · automatic retries · pushes never contain peer content</span></div>` : `<p class="mut" style="margin:6px 0">Create a routine with a webhook trigger in your assistant (Grok, for example) and enter its URL and key here, or have the Bot run <code>botctl webhook set</code>.</p>`}
    <details style="margin-top:8px"><summary class="mut" style="cursor:pointer">${w.configured ? "Edit" : "Set up push"}</summary>
      <div class="field"><label>Webhook URL</label><input data-u placeholder="https://…"></div>
      <div class="row"><div class="field" style="width:150px"><label>Header name</label><input data-hn value="Authorization"></div><div class="field grow"><label>Header value (e.g. Bearer key; empty = ${w.configured ? "keep current" : "none"})</label><input data-hv type="password" autocomplete="off" placeholder="Bearer …"></div></div>
      <div class="row"><button class="btn p s" data-save>Save</button>${w.configured ? '<button class="btn s" data-test>Send test push</button><span class="grow"></span><button class="btn s d" data-clear>Turn off push</button>' : ""}</div></details>
    ${w.recent_deliveries.length ? `<div class="mut" style="margin-top:10px">Deliveries</div><table class="small">${w.recent_deliveries.map((d) => `<tr><td>${fmt(d.created_at)}</td><td>${st(WH_ST, d.status)}</td><td>${d.kind === "test" ? "Test" : types(d.event_types)}</td><td class="mut hide-m">${d.response_status ? "HTTP " + d.response_status : ""} ${d.attempts > 1 ? d.attempts + " attempts" : ""} ${d.status !== "delivered" && d.error ? esc(d.error) : ""}</td></tr>`).join("")}</table>` : ""}`;
  $("[data-save]", el).onclick = async () => {
    const url = $("[data-u]", el).value.trim(); const hv = $("[data-hv]", el).value.trim(); const hn = $("[data-hn]", el).value.trim() || "Authorization";
    if (fieldErr($("[data-u]", el), url ? "" : "Enter the webhook URL.")) return;
    const body = { url }; if (hv) body.headers = [{ name: hn, value: hv }]; else if (!w.configured) body.headers = [];
    await api("PUT", `/v1/bots/${botId}/webhook`, body); toast("Saved"); loadWebhook(el, botId);
  };
  const tb = $("[data-test]", el); if (tb) tb.onclick = async () => { tb.disabled = true; tb.textContent = "Sending…"; try { const d = await api("POST", `/v1/bots/${botId}/webhook/test`); toast(d.status === "delivered" ? `Test delivered (HTTP ${d.response_status})` : `Test failed: ${d.error || d.status}`); } finally { loadWebhook(el, botId); } };
  const cb = $("[data-clear]", el); if (cb) cb.onclick = async () => { if (confirm("Turn off push? The Bot will only find new messages by polling.")) { await api("DELETE", `/v1/bots/${botId}/webhook`); loadWebhook(el, botId); } };
}

boot();
