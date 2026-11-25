/**
 * GitHub OAuth (#76): the schema, the one provider implementation, the startup config gate and the
 * pure helpers the routes share. The flow itself lives in `platform.ts`; this file holds no mutable
 * state and never reads `platform.publicBaseUrl` — the origin comes from the startup config only
 * (§11.1), because that field follows the request `Host` header under `trustProxy`.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { sha256Hex } from "./crypto.js";

export const OAUTH_SCHEMA = `
CREATE TABLE IF NOT EXISTS oauth_identities (
  provider   TEXT NOT NULL,
  subject    TEXT NOT NULL,
  owner_id   TEXT NOT NULL REFERENCES owners(id),
  login      TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (provider, subject)
);
CREATE UNIQUE INDEX IF NOT EXISTS oauth_identities_owner ON oauth_identities (provider, owner_id);
CREATE TABLE IF NOT EXISTS oauth_states (
  state_hash    TEXT PRIMARY KEY,
  provider      TEXT NOT NULL,
  mode          TEXT NOT NULL CHECK (mode IN ('link','signin')),
  owner_id      TEXT,
  cookie_hash   TEXT,
  code_verifier TEXT,
  redirect_uri  TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  consumed_at   TEXT,
  CHECK ((code_verifier IS NOT NULL AND length(code_verifier) BETWEEN 43 AND 128)
         OR (code_verifier IS NULL AND consumed_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS oauth_states_owner ON oauth_states (owner_id, expires_at);
CREATE TABLE IF NOT EXISTS oauth_step_codes (
  code_hash  TEXT PRIMARY KEY,
  provider   TEXT NOT NULL,
  owner_id   TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);
CREATE TABLE IF NOT EXISTS oauth_attempts (
  action      TEXT NOT NULL CHECK (action IN ('signin','connect','unbind')),
  attempt_key TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS oauth_attempts_key ON oauth_attempts (action, attempt_key, created_at);
`;

// ---------------------------------------------------------------- config

export interface OAuthOptions {
  clientId?: string | null;
  clientSecret?: string | null;
  publicBaseUrl?: string | null;
}

export interface OAuthConfig {
  enabled: boolean;
  clientId?: string;
  clientSecret?: string;
  /** Normalized origin (§11.1): scheme + host + port, no trailing slash. */
  baseUrl?: string;
  /** The one redirect string the process ever uses. */
  redirectUri?: string;
  /** One startup line, never carrying the configured value. */
  warning?: string;
}

export const OAUTH_CALLBACK_PATH = "/v1/auth/oauth/github/callback";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * `PUBLIC_BASE_URL` is parsed once and reduced to an origin. Every failure is a reason to leave the
 * feature off, never to repair the value: GitHub stores one exact callback string, so silently
 * stripping a path would just move the failure to the first real sign-in.
 */
export function normalizeOAuthBaseUrl(raw: string): { baseUrl: string; loopbackHttp?: boolean } | { error: string } {
  let url: URL;
  try { url = new URL(raw); } catch { return { error: "must be an absolute URL with a host" }; }
  if (!url.host) return { error: "must be an absolute URL with a host" };
  if (url.username || url.password) return { error: "must not carry user info" };
  if (url.pathname !== "/") return { error: "must be a bare origin without a path" };
  if (url.search || url.hash) return { error: "must not carry a query or a fragment" };
  const loopbackHttp = url.protocol === "http:" && LOOPBACK.has(url.hostname);
  if (url.protocol !== "https:" && !loopbackHttp) return { error: "must be https" };
  return { baseUrl: url.origin, ...(loopbackHttp ? { loopbackHttp: true } : {}) };
}

/**
 * All three values or the feature is off. `given` (when supplied) is the complete source — the
 * tests and any embedding caller never inherit the ambient environment; `main.ts` passes nothing
 * and the three env values are read here, once, at startup.
 */
export function oauthConfigFrom(env: Record<string, string | undefined>, given?: OAuthOptions): OAuthConfig {
  const explicit = given !== undefined;
  const pick = (v: string | null | undefined) => (typeof v === "string" ? v.trim() : "");
  const clientId = pick(explicit ? given!.clientId : env.BOTSOCIAL_GITHUB_CLIENT_ID);
  const clientSecret = pick(explicit ? given!.clientSecret : env.BOTSOCIAL_GITHUB_CLIENT_SECRET);
  const rawBase = pick(explicit ? given!.publicBaseUrl : env.PUBLIC_BASE_URL);
  if (!clientId || !clientSecret) return { enabled: false };
  if (!rawBase) return { enabled: false, warning: "oauth: disabled (PUBLIC_BASE_URL is required for GitHub sign-in)" };
  const norm = normalizeOAuthBaseUrl(rawBase);
  if ("error" in norm) return { enabled: false, warning: `oauth: disabled (PUBLIC_BASE_URL ${norm.error})` };
  return {
    enabled: true,
    clientId,
    clientSecret,
    baseUrl: norm.baseUrl,
    redirectUri: norm.baseUrl + OAUTH_CALLBACK_PATH,
    ...(norm.loopbackHttp ? { warning: "oauth: enabled on a loopback http origin; GitHub requires https for a real callback" } : {}),
  };
}

// ---------------------------------------------------------------- cookies

export const OAUTH_COOKIE = "bs_oauth";
export const OAUTH_COOKIE_PATH = "/v1/auth/oauth";
export const OAUTH_COOKIE_MAX_AGE = 600;

export function oauthBindingCookie(value: string, cfg: OAuthConfig): string {
  const secure = cfg.baseUrl?.startsWith("https:") ? "; Secure" : "";
  return `${OAUTH_COOKIE}=${value}; Max-Age=${OAUTH_COOKIE_MAX_AGE}; Path=${OAUTH_COOKIE_PATH}; HttpOnly${secure}; SameSite=Lax`;
}

export function oauthClearCookie(cfg: OAuthConfig): string {
  const secure = cfg.baseUrl?.startsWith("https:") ? "; Secure" : "";
  return `${OAUTH_COOKIE}=; Max-Age=0; Path=${OAUTH_COOKIE_PATH}; HttpOnly${secure}; SameSite=Lax`;
}

export function readOAuthCookie(header: string | undefined): string | undefined {
  for (const part of String(header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== OAUTH_COOKIE) continue;
    return part.slice(eq + 1).trim() || undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------- PKCE + hashes

/** One verifier: 32 random bytes in base64url = 43 characters, the minimum the CHECK and GitHub accept. */
export function newPkceVerifier(): string { return randomBytes(32).toString("base64url"); }
export function pkceChallenge(verifier: string): string { return createHash("sha256").update(verifier).digest("base64url"); }
export const newOAuthSecret = () => randomBytes(32).toString("base64url");

/** A correlation id in the database's own trust domain (D3): no key, no HMAC, recomputable from the row. */
export const subjectFingerprint = (subject: string) => sha256Hex(subject).slice(0, 12);

export function timingSafeEqualString(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// ---------------------------------------------------------------- the provider

export interface OAuthProfile { subject: string; login: string }

export interface OAuthAuthorizeArgs {
  state: string;
  redirectUri: string;
  codeChallenge: string;
  clientId: string;
  prompt?: string;
}

export interface OAuthExchangeArgs {
  code: string;
  codeVerifier: string;
  redirectUri: string;
  clientId: string;
  clientSecret: string;
}

export interface OAuthProvider {
  readonly id: string;
  readonly label: string;
  readonly scopes: readonly string[];
  readonly pkce: "S256";
  authorizeUrl(a: OAuthAuthorizeArgs): string;
  exchange(a: OAuthExchangeArgs, fetchImpl: typeof fetch): Promise<OAuthProfile>;
}

/** What went wrong at GitHub, in the three shapes the callback can act on. */
export type OAuthExchangeFailure = "rejected" | "provider_unavailable" | "bad_profile";
export class OAuthExchangeError extends Error {
  constructor(readonly kind: OAuthExchangeFailure) { super(kind); }
}

const TOKEN_URL = "https://github.com/login/oauth/access_token";
const USER_URL = "https://api.github.com/user";
const MAX_BODY = 64 * 1024;
const TIMEOUT_MS = 10_000;

async function readBody(res: Response, failure: OAuthExchangeFailure): Promise<string> {
  const text = await res.text();
  if (text.length > MAX_BODY) throw new OAuthExchangeError(failure);
  return text;
}

function isJson(res: Response): boolean {
  return (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase() === "application/json";
}

export const GITHUB_PROVIDER: OAuthProvider = {
  id: "github",
  label: "GitHub",
  scopes: [],
  pkce: "S256",
  authorizeUrl(a) {
    const url = new URL("https://github.com/login/oauth/authorize");
    url.searchParams.set("client_id", a.clientId);
    url.searchParams.set("redirect_uri", a.redirectUri);
    url.searchParams.set("state", a.state);
    url.searchParams.set("code_challenge", a.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    if (a.prompt) url.searchParams.set("prompt", a.prompt);
    return url.toString();
  },
  async exchange(a, fetchImpl) {
    let tokenRes: Response;
    try {
      tokenRes = await fetchImpl(TOKEN_URL, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: a.clientId,
          client_secret: a.clientSecret,
          code: a.code,
          redirect_uri: a.redirectUri,
          code_verifier: a.codeVerifier,
        }).toString(),
        redirect: "error",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch { throw new OAuthExchangeError("provider_unavailable"); }
    if (tokenRes.status >= 400 && tokenRes.status < 500) throw new OAuthExchangeError("rejected");
    if (!tokenRes.ok) throw new OAuthExchangeError("provider_unavailable");
    const tokenText = await readBody(tokenRes, "provider_unavailable");
    let tokenJson: any;
    try { tokenJson = JSON.parse(tokenText); } catch { throw new OAuthExchangeError("provider_unavailable"); }
    const accessToken = typeof tokenJson?.access_token === "string" ? tokenJson.access_token : "";
    if (!accessToken) throw new OAuthExchangeError("provider_unavailable");

    let userRes: Response;
    try {
      userRes = await fetchImpl(USER_URL, {
        headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch { throw new OAuthExchangeError("provider_unavailable"); }
    if (!userRes.ok) throw new OAuthExchangeError(userRes.status < 500 ? "rejected" : "provider_unavailable");
    if (!isJson(userRes)) throw new OAuthExchangeError("bad_profile");
    const userText = await readBody(userRes, "bad_profile");
    let user: any;
    try { user = JSON.parse(userText); } catch { throw new OAuthExchangeError("bad_profile"); }
    const subject = String(user?.id ?? "");
    const login = String(user?.login ?? "");
    // GitHub's numeric id: no 0, no leading zeros, at most 16 digits. A login is displayed only.
    if (!/^[1-9][0-9]{0,15}$/.test(subject)) throw new OAuthExchangeError("bad_profile");
    if (!/^[A-Za-z0-9-]{1,39}$/.test(login)) throw new OAuthExchangeError("bad_profile");
    return { subject, login };
  },
};

export const OAUTH_PROVIDERS: Readonly<Record<string, OAuthProvider>> = { github: GITHUB_PROVIDER };

// ---------------------------------------------------------------- console signal

export const OAUTH_META = '<meta name="bs-oauth" content="github">';

/** One string insert on one known marker, from the startup constant; no marker, no tag, never a 500. */
export function injectOAuthMeta(html: string, providerId: string | null): string {
  if (!providerId) return html;
  const marker = "</head>";
  const at = html.indexOf(marker);
  if (at < 0) return html;
  return html.slice(0, at) + `<meta name="bs-oauth" content="${providerId}">` + html.slice(at);
}

/** The callback's 400: a page, built here, never through the JSON error handler (§13). */
export function oauthErrorPage(apiCode: string, fragment: string, message: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Sign-in failed</title></head>
<body data-error="${apiCode}">
<h1>Sign-in failed</h1>
<p>${message}</p>
<p><a href="/ui#/login?oauth=${fragment}">Back to sign in</a></p>
</body></html>`;
}
