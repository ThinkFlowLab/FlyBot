// Shared harness for the GitHub OAuth suites: a stubbed GitHub that counts its calls, a server whose
// OAuth config is explicit (never taken from the ambient environment), and cookie helpers — the tests
// drive the callback by hand, so no jar is needed.
import { AddressInfo } from "node:net";
import { Platform } from "../src/platform.js";
import { buildServer } from "../src/server.js";
import { OwnerClient } from "../src/client.js";

export type TokenMode = "ok" | "500" | "timeout" | "no_token" | "rejected";
export type UserMode = "ok" | "html" | "huge";

/** The two endpoints the provider is allowed to call, and nothing else. */
export function githubStub(init: { id?: number | string; login?: string } = {}) {
  const calls = { token: 0, user: 0 };
  const tokenBodies: URLSearchParams[] = [];
  const tokenHeaders: Record<string, string>[] = [];
  const userHeaders: Record<string, string>[] = [];
  const urls: string[] = [];
  let profile: any = { id: init.id ?? 42, login: init.login ?? "octocat" };
  let tokenMode: TokenMode = "ok";
  let userMode: UserMode = "ok";
  const fetchImpl = async (input: any, init2: any = {}) => {
    const url = String(input);
    urls.push(url);
    if (url === "https://github.com/login/oauth/access_token") {
      calls.token++;
      tokenBodies.push(new URLSearchParams(String(init2.body ?? "")));
      tokenHeaders.push({ ...(init2.headers as Record<string, string>) });
      if (tokenMode === "500") return new Response("upstream boom", { status: 500 });
      if (tokenMode === "timeout") throw Object.assign(new Error("This operation was aborted"), { name: "TimeoutError" });
      if (tokenMode === "no_token") return new Response(JSON.stringify({ token_type: "bearer" }), { status: 200, headers: { "content-type": "application/json" } });
      if (tokenMode === "rejected") return new Response(JSON.stringify({ error: "bad_verification_code" }), { status: 400, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ access_token: "gho_stub_token", token_type: "bearer" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url === "https://api.github.com/user") {
      calls.user++;
      userHeaders.push({ ...(init2.headers as Record<string, string>) });
      if (userMode === "html") return new Response("<html>not json</html>", { status: 200, headers: { "content-type": "text/html" } });
      if (userMode === "huge") return new Response(JSON.stringify({ id: 42, login: "x".repeat(70_000) }), { status: 200, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify(profile), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  return {
    fetchImpl: fetchImpl as unknown as typeof fetch,
    calls, tokenBodies, tokenHeaders, userHeaders, urls,
    setProfile: (p: any) => { profile = p; },
    setTokenMode: (m: TokenMode) => { tokenMode = m; },
    setUserMode: (m: UserMode) => { userMode = m; },
  };
}

export type Stub = ReturnType<typeof githubStub>;

export interface OAuthServerOptions {
  oauth?: Record<string, unknown>;
  stub?: Stub;
  now?: () => number;
  logger?: any;
}

/** Enabled by default with an explicit https origin; pass `oauth: {}` for the unconfigured instance. */
export async function oauthServer(o: OAuthServerOptions = {}) {
  const stub = o.stub ?? githubStub();
  const platform = new Platform({
    oauth: o.oauth ?? { clientId: "test-client-id", clientSecret: "test-client-secret", publicBaseUrl: "https://bots.example.com" },
    fetchImpl: stub.fetchImpl,
    ...(o.now ? { now: o.now } : {}),
  });
  const app = buildServer(platform, { logger: o.logger });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  return { platform, app, base, stub, stop: async () => { await app.close(); platform.close(); } };
}

let seq = 0;
export async function register(base: string, password = "secret-pw") {
  const username = `oauthuser${++seq}`;
  const { client, owner_id } = await OwnerClient.register(base, username, password, "Owner");
  return { owner: client, owner_id, password };
}

export const setCookieOf = (res: Response): string => {
  const many = (res.headers as any).getSetCookie?.() as string[] | undefined;
  return many?.[0] ?? res.headers.get("set-cookie") ?? "";
};
export const cookieValueOf = (setCookie: string): string => {
  const pair = String(setCookie).split(";")[0];
  return pair.slice(pair.indexOf("=") + 1);
};
export const stateOf = (authorizeUrl: string): string => new URL(authorizeUrl).searchParams.get("state") ?? "";

export interface LinkStart { res: Response; json: any; cookie: string; setCookie: string }

export async function startLink(base: string, token: string, password: string | undefined, provider = "github"): Promise<LinkStart> {
  const res = await fetch(`${base}/v1/auth/oauth/${provider}/start`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(password === undefined ? {} : { current_password: password }),
  });
  const json = await res.json().catch(() => ({}));
  const setCookie = setCookieOf(res);
  return { res, json, setCookie, cookie: cookieValueOf(setCookie) };
}

export async function startSignin(base: string, provider = "github", headers: Record<string, string> = {}) {
  const res = await fetch(`${base}/v1/auth/oauth/${provider}/signin`, { method: "POST", headers });
  const json = await res.json().catch(() => ({}));
  const setCookie = setCookieOf(res);
  return { res, json, setCookie, cookie: cookieValueOf(setCookie) };
}

export async function callback(base: string, p: { code?: string; state?: string; error?: string; cookie?: string | null; query?: string; headers?: Record<string, string> }) {
  const qs = new URLSearchParams();
  if (p.code !== undefined) qs.set("code", p.code);
  if (p.state !== undefined) qs.set("state", p.state);
  if (p.error !== undefined) qs.set("error", p.error);
  const query = p.query ?? qs.toString();
  return fetch(`${base}/v1/auth/oauth/github/callback${query ? `?${query}` : ""}`, {
    redirect: "manual",
    headers: { ...(p.cookie ? { cookie: `bs_oauth=${p.cookie}` } : {}), ...(p.headers ?? {}) },
  });
}

/** Link an identity for an owner through the real flow; returns the identity subject. */
export async function linkGithub(s: { base: string; stub: Stub }, ownerToken: string, password = "secret-pw", code = "code-1") {
  const start = await startLink(s.base, ownerToken, password);
  const cb = await callback(s.base, { code, state: stateOf(start.json.authorize_url), cookie: start.cookie });
  return { start, cb };
}

export async function exchange(base: string, code: string) {
  const res = await fetch(`${base}/v1/auth/oauth/signin/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ code }),
  });
  return { res, json: await res.json().catch(() => ({})) };
}

/** A raw request that always parses JSON (or reports the body type). */
export async function call(base: string, method: string, path: string, opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...(opts.body !== undefined ? { "content-type": "application/json" } : {}), ...(opts.headers ?? {}) },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let json: any = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  return { res, json };
}
