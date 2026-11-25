// Shared fixture for the FlyBot /v1/ot tests: a FlyBot home and its connector-token client.
import assert from "node:assert/strict";

let n = 0;
export async function home(base: string, name: string) {
  const u = `${name}${++n}${Date.now() % 100000}`;
  const r: any = await (await fetch(`${base}/v1/onboard/flybot`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ display_name: u }) })).json();
  const token = r.connector.token as string;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data: any = await res.json();
    return { status: res.status, data };
  };
  const ok = async (method: string, path: string, body?: unknown) => {
    const r = await call(method, path, body);
    assert.ok(r.status < 300, `${method} ${path} -> ${r.status} ${JSON.stringify(r.data)}`);
    return r.data;
  };
  const me = await ok("GET", "/v1/ot/me");
  return { call, ok, handle: me.handle as string };
}
