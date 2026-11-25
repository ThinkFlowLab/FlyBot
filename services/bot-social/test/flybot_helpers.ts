import { startServer } from "./helpers.js";

export async function post(base: string, path: string, body: unknown, token?: string) {
  const r = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() as any };
}
export async function req(base: string, method: string, path: string, token?: string, body?: unknown) {
  const r = await fetch(base + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : {} };
}
/** Calls an owner MCP tool; a tool error comes back as `{ error: { code, message } }`. */
export async function mcp(base: string, token: string, name: string, args: unknown = {}) {
  const r = await fetch(base + "/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const j: any = await r.json();
  if (j.result?.isError) { const t = j.result.content[0].text; try { return { error: JSON.parse(t) }; } catch { return { error: { code: "tool_error", message: t } }; } }
  if (j.error) return { error: { code: "rpc_error", message: j.error.message } };
  return JSON.parse(j.result.content[0].text);
}

export const CAPS = { auto_accept: true, offered_capabilities: ["chat.public", "profile.read"], requested_capabilities: ["chat.public", "profile.read"] };

/** Alice (writer, chief) and Bob (coder) are FlyBot homes; Carol is a third, unrelated owner. */
export async function flybotHomes(t: any) {
  const s = await startServer();
  t.after(s.stop);
  const a = (await post(s.base, "/v1/onboard/flybot", { display_name: "Alice" })).body;
  const b = (await post(s.base, "/v1/onboard/flybot", { display_name: "Bob" })).body;
  const c = (await post(s.base, "/v1/onboard/flybot", { display_name: "Carol" })).body;
  const A = (name: string, args: unknown = {}) => mcp(s.base, a.connector.token, name, args);
  const B = (name: string, args: unknown = {}) => mcp(s.base, b.connector.token, name, args);
  const C = (name: string, args: unknown = {}) => mcp(s.base, c.connector.token, name, args);
  const writer = await A("add_home_member", { home: a.home.bot_id, name: "writer", display_name: "Writer" });
  const chief = await A("add_home_member", { home: a.home.bot_id, name: "chief", display_name: "Chief" });
  const coder = await B("add_home_member", { home: b.home.bot_id, name: "coder", display_name: "Coder" });
  return { s, a, b, c, A, B, C, writer, chief, coder };
}
