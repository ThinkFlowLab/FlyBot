import Fastify, { FastifyInstance, FastifyRequest } from "fastify";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ApiError } from "./errors.js";
import { Platform, Principal } from "./platform.js";
import { ensureBotctl } from "./botctl-build.js";
import { marked } from "marked";
import { registerOwnerMcp } from "./owner-mcp.js";
import { injectOAuthMeta, oauthErrorPage } from "./oauth.js";
import { loadTrustProxy, TrustProxySetting } from "./trust-proxy.js";
import { registerFlyBotWorkspace } from "./flybot-workspace/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const UI_HTML = () => readFileSync(join(here, "..", "public", "index.html"), "utf8");

export function buildServer(platform: Platform, opts: { logger?: boolean; fixedBaseUrl?: boolean; trustProxy?: TrustProxySetting } = {}): FastifyInstance {
  // #75 ①: X-Forwarded-For is believed only from the peers this deployment names (TRUST_PROXY, loopback by
  // default), so a direct caller cannot choose the address the limits and audit rows read. The startup line in
  // main.ts says which peers those are, and what an unnamed proxy would cost.
  const trustProxy = opts.trustProxy ?? loadTrustProxy(process.env.TRUST_PROXY).setting;
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 256 * 1024, trustProxy });
  // Without PUBLIC_BASE_URL, derive links (invites, /botctl, /guide) from the Host the client used.
  if (!opts.fixedBaseUrl) app.addHook("onRequest", async (req) => { if (req.headers.host) platform.publicBaseUrl = `${req.protocol}://${req.headers.host}`; });
  const page = (name: string) => readFileSync(join(here, "..", "public", name), "utf8");

  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof ApiError) return reply.status(err.status).send({ error: { code: err.code, message: err.message, ...err.extra } });
    if (err.validation || err.statusCode === 400 || err.code === "FST_ERR_CTP_INVALID_JSON_BODY") return reply.status(400).send({ error: { code: "invalid_request", message: err.message } });
    if (err.statusCode === 413) return reply.status(413).send({ error: { code: "payload_too_large", message: err.message } });
    // A body under a content-type the server has no parser for is a caller-side mistake (curl -d sends
    // application/x-www-form-urlencoded unless told otherwise), so it is a 415 with a code the caller can
    // act on rather than the catch-all 500 that blames the server.
    if (err.statusCode === 415) return reply.status(415).send({ error: { code: "invalid_request", message: "unsupported content type: send application/json" } });
    app.log.error(err);
    return reply.status(500).send({ error: { code: "internal_error", message: "internal error" } });
  });
  // An unknown path, or a real path with the wrong method, answers in the same { error: { code, message } }
  // shape as every route. Fastify's default body ({"message","error","statusCode"}) carries no error.code,
  // so the console (public/ui.js) and botctl show "Something went wrong (undefined)" instead of the refusal.
  app.setNotFoundHandler((req, reply) => {
    const path = String(req.url ?? "").split("?")[0];
    return reply.status(404).send({ error: { code: "not_found", message: `no such route: ${req.method} ${path}` } });
  });

  const auth = (req: FastifyRequest): Principal => {
    const h = req.headers.authorization;
    const p = platform.authenticate(h?.startsWith("Bearer ") ? h.slice(7) : undefined);
    if (p.kind === "owner" && p.scope === "connector") throw new ApiError(403, "connector_token_rest_forbidden", "connector tokens work at /mcp and the FlyBot REST routes only; use the MCP tools at /mcp or log in for this route");
    return p;
  };
  // Connector token (FlyBot / MCP) or owner login. Used for per-bot access management and webhooks.
  const ownerAny = (req: FastifyRequest) => {
    const h = req.headers.authorization;
    const p = platform.authenticate(h?.startsWith("Bearer ") ? h.slice(7) : undefined);
    if (p.kind !== "owner") throw new ApiError(403, "owner_only", "owner or connector token required");
    return p;
  };
  const P = (req: FastifyRequest) => req.params as Record<string, string>;
  const B = (req: FastifyRequest) => (req.body ?? {}) as any;
  const Q = (req: FastifyRequest) => req.query as Record<string, string>;
  // Query numbers are parsed here, before anything reaches SQLite. `limit` is a page bound: absent or
  // empty takes the documented default, and anything that is not a non-negative integer is a 400 — a
  // NaN would reach SQLite as an internal error and a negative number is read by SQLite as "unlimited".
  // 0 is a real (empty) page. The 200-delivery ceiling stays in the storage layer (`webhookDeliveries`).
  const limitQ = (raw: unknown, fallback: number, max?: number) => {
    const s = raw === undefined || raw === null ? "" : String(raw).trim();
    if (!s) return fallback;
    const n = Number(s);
    if (!Number.isSafeInteger(n) || n < 0) throw new ApiError(400, "invalid_request", "limit must be a non-negative integer");
    return max === undefined ? n : Math.min(n, max);
  };
  /**
   * An optional cursor (`after`): the integer a previous answer ended on, or nothing. It is deliberately stricter
   * than `intQ` below: that one answers a malformed `since` with the first page, which is published behaviour for
   * `/v1/events` and stays. A room read cannot do that — "start over" means replaying the whole room window — so a
   * value that is not a non-negative integer is a 400 here instead of a silent first page or a `seq > 1.5` half-page.
   */
  const cursorQ = (raw: unknown) => {
    const s = raw === undefined || raw === null ? "" : String(raw).trim();
    if (!s) return undefined;
    const n = Number(s);
    if (!Number.isSafeInteger(n) || n < 0) throw new ApiError(400, "invalid_request", "after must be a non-negative integer");
    return n;
  };
  /**
   * A key that may carry one value. Fastify hands a repeated key over as an array, and a route that reads a single
   * value out of it reads "not sent": `?end_claims=1&end_claims=1` compared an array against `"1"`, answered 204 and
   * ended nothing, while `?subject=a&subject=b` bound the array to SQLite and answered 500. Anything that is not one
   * string is refused here, before the route sees it; a key sent once behaves exactly as before, empty value included.
   */
  const oneQ = (raw: unknown, name: string): string | undefined => {
    if (raw === undefined || raw === null) return undefined;
    if (typeof raw === "string") return raw;
    throw new ApiError(400, "invalid_request", `${name} must be sent once`);
  };
  // The events cursor is not a page bound: a malformed `since` is answered with the first page, as before.
  const intQ = (raw: unknown, o: { fallback: number; min?: number; max?: number }) => {
    const s = typeof raw === "string" ? raw.trim() : "";
    const n = s ? Number(s) : NaN;
    let v = Number.isFinite(n) ? Math.floor(n) : NaN;
    if (!Number.isFinite(v) || v < (o.min ?? 0)) v = o.fallback;
    return o.max === undefined ? v : Math.min(v, o.max);
  };

  // ---- public
  app.get("/", async (_req, reply) => reply.redirect("/ui"));
  app.get("/friends", async (_req, reply) => reply.redirect("/ui#/friends"));
  app.get("/i/:code", async (_req, reply) => reply.type("text/html; charset=utf-8").send(page("invite.html")));
  // A room invite link (Bot Social #39). The FlyBot client parses the link itself; a person who opens it in
  // a browser gets the same preview the API answers, with nothing to install.
  // Two shapes reach this page: a face-room ticket is one segment (/r/<ticket>), a local room's link names
  // the Bot to knock on and is two (/r/@handle/<ticket>, Bot Social #61). Both serve the same file; the page
  // tells them apart by path shape and asks the matching preview endpoint. The handle is display-only and
  // never reflected by the server.
  const roomInvitePage = async (_req: FastifyRequest, reply: any) =>
    reply.type("text/html; charset=utf-8").send(page("room-invite.html"));
  app.get("/r/:ticket", roomInvitePage);
  app.get("/r/:handle/:ticket", roomInvitePage);
  app.get("/botctl", async (_req, reply) => {
    const js = (await ensureBotctl()).replace("__BOTSOCIAL_DEFAULT_URL__", platform.publicBaseUrl);
    return reply.type("text/javascript; charset=utf-8").header("content-disposition", 'attachment; filename="botctl"').send(js);
  });
  const guideMd = () => readFileSync(join(here, "..", "docs", "AGENT_GUIDE.md"), "utf8").replaceAll("{{BASE_URL}}", platform.publicBaseUrl);
  app.get("/guide.md", async (_req, reply) => reply.type("text/markdown; charset=utf-8").send(guideMd()));
  app.get("/guide", async (_req, reply) => reply.type("text/html; charset=utf-8").send(page("guide.html").replace("<!--GUIDE-->", await marked.parse(guideMd()))));
  // The login page learns that GitHub sign-in exists from one injected tag, and only when the startup config
  // enabled it: unconfigured, the response is the file itself, byte for byte (§10).
  app.get("/ui", async (_req, reply) => reply.type("text/html; charset=utf-8").send(injectOAuthMeta(UI_HTML(), platform.oauthProviderId)));
  app.get("/ui.js", async (_req, reply) => reply.type("text/javascript; charset=utf-8").header("cache-control", "no-cache").send(page("ui.js")));
  registerOwnerMcp(app, platform);
  app.get("/connect", async (_req, reply) => reply.type("text/html; charset=utf-8").header("cache-control", "no-cache").send(page("connect.html")));
  // The one name for "the client this request came from". All limiters read it here; which peers are
  // believed for X-Forwarded-For is decided once by the Fastify trustProxy setting (TRUST_PROXY, #75 ①),
  // not at each gate.
  const clientAddress = (req: FastifyRequest) => req.ip;
  // Login, sign-up and both onboarding gates share one bounded bucket set (#75): a burst against any of them
  // spends the same per-address / per-username budget, and a refused attempt is not recorded again.
  const authGate = async (req: FastifyRequest, reply: any) => {
    const username = (req.body as any)?.username;
    const block = platform.authAttempt({ ip: clientAddress(req), account: typeof username === "string" ? username : null });
    if (!block) return;
    const message = block.scope === "account"
      ? "too many attempts for this account; try again later"
      : "too many sign-ups or sign-ins from this address; try again later";
    return reply.status(429).send({ error: { code: "rate_limited", message, retry_after: block.retry_after, scope: block.scope } });
  };
  app.post("/v1/onboard/flybot", { preHandler: authGate }, async (req, reply) => reply.status(201).send(platform.onboardFlybot(B(req))));
  app.get("/v1/homes/:id/members", async (req) => platform.listHomeMembers(auth(req), P(req).id));
  app.post("/v1/homes/:id/members", async (req, reply) => reply.status(201).send(platform.addHomeMember(auth(req), P(req).id, B(req))));
  app.delete("/v1/homes/:id/members/:member", async (req) => platform.removeHomeMember(auth(req), P(req).id, P(req).member));
  app.post("/v1/attachments", { bodyLimit: Math.ceil(platform.attachmentLimits.maxBytes / 3) * 4 + 64 * 1024 }, async (req, reply) => reply.status(201).send(platform.uploadAttachment(auth(req), B(req))));
  app.get("/v1/attachments", async (req) => platform.listAttachments(ownerAny(req)));
  app.get("/v1/attachments/:id", async (req) => platform.getAttachment(auth(req), { attachment_id: P(req).id, bot_id: oneQ(Q(req).bot_id, "bot_id") }));
  app.get("/v1/homes/:id/remote-bots", async (req) => platform.remoteBots(ownerAny(req), P(req).id));
  app.get("/v1/remote-bots", async (req) => {
    const p = ownerAny(req);
    const home = oneQ(Q(req).home, "home"), homeId = oneQ(Q(req).home_id, "home_id");
    return platform.listRemoteBots(p, home || homeId);
  });
  app.get("/v1/bots/:id/grants", async (req) => platform.listBotGrants(ownerAny(req), P(req).id));
  app.post("/v1/bots/:id/grants", async (req, reply) => reply.status(201).send(platform.grantBotToFriend(ownerAny(req), P(req).id, B(req).friend_owner_id, B(req).friend_bot_id)));
  app.delete("/v1/bots/:id/grants/:grantId", async (req) => platform.revokeBotGrant(ownerAny(req), P(req).grantId, P(req).id));
  // Recipient side: the grantee removes a grant given to one of their bots (the granting owner's list_bot_grants drops it).
  app.delete("/v1/remote-bots/:grantId", async (req) => platform.declineBotGrant(ownerAny(req), P(req).grantId, oneQ(Q(req).bot_id, "bot_id") || undefined));
  app.post("/v1/homes/:id/send", async (req, reply) => reply.status(202).send(platform.sendAsMember(auth(req), B(req))));
  app.post("/v1/onboard", { preHandler: authGate }, async (req, reply) => reply.status(201).send(platform.onboard(B(req))));
  const setupMd = () => readFileSync(join(here, "..", "docs", "SETUP.md"), "utf8").replaceAll("{{BASE_URL}}", platform.publicBaseUrl);
  app.get("/setup", async (_req, reply) => reply.type("text/markdown; charset=utf-8").header("cache-control", "no-cache").send(setupMd()));
  app.get("/setup.md", async (_req, reply) => reply.type("text/markdown; charset=utf-8").send(setupMd()));
  app.post("/v1/connector-tokens", async (req, reply) => reply.status(201).send(platform.createConnectorToken(auth(req), B(req))));
  app.get("/v1/connector-tokens", async (req) => ({ tokens: platform.listConnectorTokens(auth(req)) }));
  app.delete("/v1/connector-tokens/:id", async (req) => platform.revokeConnectorToken(auth(req), P(req).id));
  // Webhook via shell (so a secret header from an env var never passes through the model). Accepts connector or login owner tokens.
  // Same handle rule as the platform: exact spelling first, then the unique case-insensitive match.
  const myBotId = (p: Principal, id?: string) => {
    const bots = platform.listBots(p);
    const raw = String(id ?? "").trim().replace(/^@/, "");
    if (!id) { const first = bots[0]; if (!first) throw new ApiError(404, "bot_not_found"); return first.id as string; }
    const exact = bots.find((x: any) => x.id === id) ?? bots.find((x: any) => String(x.handle).replace(/^@/, "") === raw);
    const hits = exact ? [exact] : bots.filter((x: any) => String(x.handle).replace(/^@/, "").toLowerCase() === raw.toLowerCase());
    if (hits.length > 1) throw new ApiError(409, "ambiguous_handle", `"${raw}" matches ${hits.length} Bots that differ only by case; name the exact handle`);
    const b = hits[0];
    if (!b) throw new ApiError(404, "bot_not_found");
    return b.id as string;
  };
  app.put("/v1/connector/webhook", async (req) => { const p = ownerAny(req); const b = B(req); return platform.setWebhook(p, myBotId(p, b.bot_id), { url: b.url, headers: b.headers }); });
  app.get("/v1/connector/webhook", async (req) => { const p = ownerAny(req); return platform.getWebhook(p, myBotId(p, oneQ(Q(req).bot_id, "bot_id"))); });
  app.post("/v1/connector/webhook/test", async (req) => { const p = ownerAny(req); return platform.testWebhook(p, myBotId(p, B(req).bot_id)); });
  app.delete("/v1/connector/webhook", async (req) => { const p = ownerAny(req); return platform.clearWebhook(p, myBotId(p, oneQ(Q(req).bot_id, "bot_id"))); });
  app.get("/healthz", async () => ({ ok: true }));
  app.get("/v1/platform", async () => platform.platformInfo());

  // ---- owners
  app.post("/v1/owners", { preHandler: authGate }, async (req, reply) => reply.status(201).send(platform.registerOwner(B(req))));
  app.post("/v1/auth/login", { preHandler: authGate }, async (req) => platform.login(B(req)));
  // Sign out this login token on the server too, not only in localStorage.
  app.post("/v1/auth/logout", async (req) => {
    const h = req.headers.authorization;
    const p = auth(req);
    return platform.logout(p, h?.startsWith("Bearer ") ? h.slice(7) : undefined);
  });
  app.get("/v1/me", async (req) => platform.me(auth(req)));
  app.patch("/v1/me", async (req) => platform.updateSettings(auth(req), B(req)));
  // ---- GitHub OAuth (#76). The gate runs before auth on every route in this feature: an unconfigured
  // instance answers 404 oauth_not_configured before it ever looks at the Authorization header (§7).
  const oauthGate = () => {
    if (!platform.oauth.enabled) throw new ApiError(404, "oauth_not_configured", "GitHub sign-in is not configured on this server");
  };
  // Login-token only. `auth()` already refuses a connector token; this refuses a bot token too, which is why
  // `ownerAny()` is not used anywhere in this feature.
  const requireOwner = (req: FastifyRequest) => {
    const p = auth(req);
    if (p.kind !== "owner") throw new ApiError(403, "owner_only", "owner login token required");
    return p;
  };
  app.get("/v1/auth/oauth/providers", async (req) => { oauthGate(); return platform.oauthProviders(requireOwner(req)); });
  app.post("/v1/auth/oauth/:provider/start", async (req, reply) => {
    oauthGate();
    const r = platform.oauthLinkStart(requireOwner(req), P(req).provider, B(req));
    return reply.header("cache-control", "no-store").header("set-cookie", r.cookie).send({ authorize_url: r.authorize_url, expires_at: r.expires_at });
  });
  app.post("/v1/auth/oauth/:provider/signin", async (req, reply) => {
    oauthGate();
    const r = platform.oauthSigninStart(req.ip);
    return reply.header("cache-control", "no-store").header("set-cookie", r.cookie).send({ authorize_url: r.authorize_url });
  });
  // Silent: Fastify logs `req.url`, and this one carries ?code=&state= (§13). Never the global error handler.
  app.get("/v1/auth/oauth/:provider/callback", { logLevel: "silent" }, async (req, reply) => {
    oauthGate();
    const out = await platform.oauthCallback(P(req).provider, Q(req), req.headers.cookie);
    reply.header("set-cookie", out.clearCookie).header("cache-control", "no-store").header("referrer-policy", "no-referrer");
    if (out.status === 400) {
      return reply.status(400).type("text/html; charset=utf-8")
        .send(oauthErrorPage(out.apiCode ?? "oauth_state_invalid", "state_invalid", "This sign-in link expired or was opened in another browser. Start again."));
    }
    if (out.status !== 302) {
      return reply.status(out.status).send({ error: { code: out.apiCode ?? "oauth_provider_rejected", message: "GitHub returned a response we could not read; try again" } });
    }
    return reply.status(302).header("location", out.location ?? "/ui").send();
  });
  app.post("/v1/auth/oauth/signin/exchange", async (req) => { oauthGate(); return platform.oauthExchange(B(req)); });
  app.get("/v1/me/identities", async (req) => { oauthGate(); return platform.oauthIdentities(requireOwner(req)); });
  app.delete("/v1/me/identities/:provider", async (req, reply) => {
    oauthGate();
    platform.oauthUnlink(requireOwner(req), P(req).provider, B(req));
    return reply.status(204).send();
  });
  // ---- bots & keys
  app.post("/v1/bots", async (req, reply) => reply.status(201).send(platform.registerBot(auth(req), B(req))));
  app.get("/v1/bots", async (req) => ({ bots: platform.listBots(auth(req)) }));
  app.get("/v1/bots/:id/profile", async (req) => platform.profile(auth(req), P(req).id));
  // Owner (login or connector token) sets display_name and/or avatar/color; avatar/color null clears.
  app.patch("/v1/bots/:id/profile", async (req) => platform.updateBotProfile(ownerAny(req), P(req).id, B(req)));
  app.post("/v1/bots/:id/keys", async (req, reply) => reply.status(201).send(platform.addKey(auth(req), P(req).id, B(req))));
  app.delete("/v1/bots/:id/keys/:kid", async (req) => platform.revokeKey(auth(req), P(req).id, P(req).kid));
  app.get("/v1/bots/:id/webhook", async (req) => platform.getWebhook(auth(req), P(req).id));
  app.put("/v1/bots/:id/webhook", async (req) => platform.setWebhook(auth(req), P(req).id, B(req)));
  app.delete("/v1/bots/:id/webhook", async (req) => platform.clearWebhook(auth(req), P(req).id));
  app.post("/v1/bots/:id/webhook/test", async (req) => platform.testWebhook(auth(req), P(req).id));
  app.get("/v1/bots/:id/webhook/deliveries", async (req) => platform.webhookDeliveries(auth(req), P(req).id, limitQ(Q(req).limit, 30)));
  app.post("/v1/bots/:id/resume", async (req) => platform.resumeBot(auth(req), P(req).id));
  app.post("/v1/bots/:id/token", async (req) => platform.rotateBotToken(auth(req), P(req).id));
  app.post("/v1/emergency-stop", async (req) => platform.emergencyStop(auth(req), B(req)));

  // ---- relationships & grants
  app.post("/v1/relationships", async (req, reply) => reply.status(201).send(platform.requestRelationship(auth(req), B(req))));
  app.get("/v1/relationships", async (req) => ({ relationships: platform.listRelationships(auth(req)) }));
  app.put("/v1/relationships/:id/settings", async (req) => platform.updateRelationshipSettings(auth(req), P(req).id, B(req)));
  app.post("/v1/invites", async (req, reply) => reply.status(201).send(platform.createInvite(auth(req), B(req))));
  app.get("/v1/invites", async (req) => ({ invites: platform.listInvites(auth(req)) }));
  app.get("/v1/invites/:code", async (req) => platform.inviteInfo(P(req).code));
  app.delete("/v1/invites/:code", async (req) => platform.revokeInvite(auth(req), P(req).code));
  app.post("/v1/invites/:code/join", async (req, reply) => reply.status(201).send(platform.joinInvite(auth(req), P(req).code, B(req))));
  app.get("/v1/friends-overview", async (req) => platform.friendsOverview(auth(req), oneQ(Q(req).bot_id, "bot_id") || undefined));
  app.get("/v1/friends", async (req) => ({ friends: platform.listFriends(auth(req)) }));
  app.post("/v1/relationships/:id/consent", async (req) => platform.consent(auth(req), P(req).id, B(req)));
  app.delete("/v1/relationships/:id", async (req) => platform.removeRelationship(auth(req), P(req).id));
  app.post("/v1/blocks", async (req) => platform.block(auth(req), B(req)));
  app.post("/v1/blocks/:id/undo", async (req) => platform.undoBlock(auth(req), P(req).id));
  app.post("/v1/relationships/:id/grants", async (req, reply) => reply.status(201).send(platform.addGrant(auth(req), P(req).id, B(req))));
  app.post("/v1/grant-requests", async (req, reply) => reply.status(202).send(platform.requestGrant(auth(req), B(req))));
  app.delete("/v1/grants/:id", async (req) => platform.revokeGrant(auth(req), P(req).id));

  // ---- conversations
  app.post("/v1/conversations", async (req, reply) => reply.status(201).send(platform.createConversation(auth(req), B(req))));
  app.get("/v1/conversations", async (req) => ({ conversations: platform.listConversations(auth(req)) }));
  app.get("/v1/conversations/:id", async (req) => platform.getConversation(auth(req), P(req).id));
  app.post("/v1/conversations/:id/messages", async (req, reply) => reply.status(202).send(platform.draftMessage(auth(req), P(req).id, B(req))));
  app.post("/v1/conversations/:id/actions", async (req, reply) => reply.status(202).send(platform.draftAction(auth(req), P(req).id, B(req))));
  app.post("/v1/conversations/:id/close", async (req) => platform.closeConversation(auth(req), P(req).id, B(req)));
  app.post("/v1/conversations/:id/extend", async (req) => platform.extendConversation(auth(req), P(req).id, B(req)));

  // ---- approvals
  app.get("/v1/approvals", async (req) => ({ approvals: platform.listApprovals(auth(req), oneQ(Q(req).status, "status") ?? "pending") }));
  app.post("/v1/approvals/:id/decision", async (req) => platform.decideApproval(auth(req), P(req).id, B(req)));

  // ---- calendar
  app.post("/v1/calendar/freebusy", async (req) => platform.freebusy(auth(req), B(req)));
  app.post("/v1/calendar/entries", async (req, reply) => reply.status(201).send(platform.addCalendarEntry(auth(req), B(req))));
  app.get("/v1/calendar/entries", async (req) => ({ entries: platform.listCalendar(auth(req)) }));

  // ---- events & audit
  app.get("/v1/events", async (req) => platform.listEvents(auth(req), intQ(Q(req).since, { fallback: 0 }), limitQ(Q(req).limit, 100, 500)));
  app.get("/v1/audit-events", async (req) => platform.auditEvents(auth(req), { subject: oneQ(Q(req).subject, "subject"), limit: limitQ(Q(req).limit, 1000) }));
  // One week of face rooms, read-only: the caller's own seats decide the scope, the recap carries every field.
  app.get("/v1/digest", async (req) => platform.weekDigest(auth(req)));

  // ---- face-to-face rooms (FlyBot #83). Accepts owner login tokens, connector tokens
  // (the same Bearer FlyBot already stores from /v1/onboard/flybot), and bot tokens
  // (a bot token may only bring / act as itself).
  const faceAuth = (req: FastifyRequest): Principal => {
    const h = req.headers.authorization;
    return platform.authenticate(h?.startsWith("Bearer ") ? h.slice(7) : undefined);
  };
  const faceIp = (req: FastifyRequest) => req.ip;
  // Console search: the sidebar finds a chat or a face room by its title face. Owner login, connector token or a
  // Bot's own token; each answers only what that caller's list routes answer, so a hit is always something the
  // caller could have scrolled to.
  app.get("/v1/search", async (req) => platform.searchConsole(faceAuth(req), oneQ(Q(req).q, "q")));
  app.post("/v1/face-rooms/join", async (req, reply) => reply.status(200).send(platform.joinFaceRoom(faceAuth(req), B(req), { ip: faceIp(req) })));
  // Invites into an established room (#39): mint, revoke, preview (public), join by ticket.
  app.post("/v1/face-rooms/:id/invites", async (req, reply) => reply.status(201).send(platform.mintFaceRoomInvite(faceAuth(req), P(req).id, { ip: faceIp(req) })));
  app.delete("/v1/face-rooms/:id/invites/:ticket", async (req) => platform.revokeFaceRoomInvite(faceAuth(req), P(req).id, P(req).ticket));
  app.get("/v1/face-rooms/invites/:ticket", async (req) => platform.previewFaceRoomInvite(P(req).ticket, { ip: faceIp(req) }));
  app.post("/v1/face-rooms/join-invite", async (req, reply) => reply.status(200).send(platform.joinFaceRoomByInvite(faceAuth(req), B(req), { ip: faceIp(req) })));
  // Local room invites (#60): a ticket for a room that lives in one FlyBot home. Same tokens as the face-room routes.
  app.post("/v1/local-room-invites", async (req, reply) => reply.status(201).send(platform.mintLocalRoomInvite(faceAuth(req), B(req), { ip: faceIp(req) })));
  app.get("/v1/local-room-invites/:ticket", async (req) => {
    // Public; a token is optional and only adds the claimer for the two owners the ticket binds.
    const h = req.headers.authorization;
    const p = h?.startsWith("Bearer ") ? platform.authenticate(h.slice(7)) : null;
    return platform.previewLocalRoomInvite(p, P(req).ticket, { ip: faceIp(req) });
  });
  app.post("/v1/local-room-invites/:ticket/claim", async (req) => platform.claimLocalRoomInvite(faceAuth(req), P(req).ticket, B(req), { ip: faceIp(req) }));
  // `?end_claims=1` (the room is gone) also ends the reach of every home that joined; without it they keep their seats.
  app.delete("/v1/local-room-invites/:ticket", async (req, reply) => {
    const endClaims = oneQ((req.query as Record<string, unknown> | undefined)?.end_claims, "end_claims");
    platform.revokeLocalRoomInvite(faceAuth(req), P(req).ticket, { endClaims: endClaims === "1" || endClaims === "true" });
    return reply.status(204).send();
  });
  // The minting owner ends one home's claim (it removed that guest from the room).
  app.delete("/v1/local-room-invites/:ticket/claims/:home", async (req, reply) => { platform.endLocalRoomInviteClaim(faceAuth(req), P(req).ticket, P(req).home); return reply.status(204).send(); });
  // Presence ("thinking"): owner login, connector token or the Bot's own token (a Bot token acts only as itself).
  app.put("/v1/presence", async (req) => platform.setPresence(faceAuth(req), B(req)));
  app.get("/v1/presence", async (req) => {
    const p = faceAuth(req);
    const botId = oneQ(Q(req).bot_id, "bot_id"), roomId = oneQ(Q(req).room_id, "room_id");
    return platform.listPresence(p, { bot_id: botId || undefined, room_id: roomId || undefined });
  });
  app.get("/v1/face-rooms", async (req) => platform.listFaceRooms(faceAuth(req)));
  app.get("/v1/face-rooms/:id", async (req) => {
    const p = faceAuth(req);
    const after = cursorQ(Q(req).after);
    const as = oneQ(Q(req).as, "as"), bot = oneQ(Q(req).bot, "bot"), asBot = oneQ(Q(req).as_bot, "as_bot");
    return platform.getFaceRoom(p, P(req).id, { after, as_bot: as ?? bot ?? asBot });
  });
  app.post("/v1/face-rooms/:id/start", async (req) => platform.startFaceRoom(faceAuth(req), P(req).id));
  app.post("/v1/face-rooms/:id/leave", async (req) => platform.leaveFaceRoom(faceAuth(req), P(req).id, B(req)));
  // Room lead (FlyBot #476): only the room creator's owner token; roles: your own Bots' role labels.
  app.post("/v1/face-rooms/:id/lead", async (req) => platform.setFaceRoomLead(faceAuth(req), P(req).id, B(req)));
  app.post("/v1/face-rooms/:id/note", async (req) => platform.setFaceRoomNote(faceAuth(req), P(req).id, B(req)));
  app.put("/v1/face-rooms/:id/roles", async (req) => platform.setFaceRoomRoles(faceAuth(req), P(req).id, B(req)));
  app.post("/v1/face-rooms/:id/messages", async (req, reply) => reply.status(202).send(platform.draftFaceRoomMessage(faceAuth(req), P(req).id, B(req))));

  // FlyBot shared state (teams, members, invites, messenger, discover) for users' own DS-Bots.
  registerFlyBotWorkspace(app, platform);

  return app;
}
