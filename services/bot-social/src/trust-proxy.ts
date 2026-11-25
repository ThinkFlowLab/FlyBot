import { isIP } from "node:net";

/**
 * Which peers may speak for a client through `X-Forwarded-For` (#75 ①).
 *
 * The address behind the limits and the audit rows is Fastify's `req.ip`: the socket peer unless a proxy is
 * believed. `TRUST_PROXY` names the proxies a deployment has in front of it, and defaults to `loopback` so a
 * same-host nginx (`proxy_pass 127.0.0.1:8787`) keeps working while a direct client on the internet cannot
 * choose its own address with a made-up header. A proxy on another host (Docker bridge, another machine) is
 * not believed until its address or CIDR is named; while it is unnamed every client behind it looks like that
 * one proxy, so the address-based limits answer 429 for all of them.
 *
 * Accepted values: `false` (believe no forwarded header), `loopback` (Fastify's loopback preset), or a comma
 * or space separated list of IPs/CIDRs. Trusting every peer (`true`) is deliberately not a value: a direct
 * deployment would hand each caller control of its own address.
 */
export type TrustProxySetting = false | "loopback" | string[];
export type TrustProxyKind = "default" | "false" | "loopback" | "cidrs";

export interface TrustProxyConfig {
  kind: TrustProxyKind;
  /** The value handed to Fastify's `trustProxy`. */
  setting: TrustProxySetting;
  /** The peers named in the value, for the startup line. Empty when no header is believed. */
  peers: string[];
  raw: string;
}

const refusal = (raw: string, why: string) =>
  new Error(`TRUST_PROXY ${why} (got "${raw.trim()}"); use false, loopback, or a comma-separated list of IPs/CIDRs (true is not offered: name the proxy instead)`);

/** One entry is an IP (`10.1.2.3`, `::1`) or an IP/CIDR (`10.0.0.0/8`, `fd00::/8`); a name is not enough. */
function checkEntry(token: string, raw: string) {
  const slash = token.indexOf("/");
  const addr = slash === -1 ? token : token.slice(0, slash);
  const family = isIP(addr);
  if (!family) throw refusal(raw, `entry "${token}" is not an IP address or CIDR`);
  if (slash !== -1) {
    const prefix = token.slice(slash + 1);
    const max = family === 4 ? 32 : 128;
    if (!/^\d{1,3}$/.test(prefix) || Number(prefix) > max) throw refusal(raw, `entry "${token}" needs a prefix between 0 and ${max}`);
  }
  return token;
}

export function loadTrustProxy(raw: string | undefined): TrustProxyConfig {
  const text = String(raw ?? "").trim();
  if (!text) return { kind: "default", setting: "loopback", peers: ["loopback"], raw: "" };
  const tokens = text.split(/[\s,]+/).filter(Boolean);
  if (tokens.length === 1 && tokens[0].toLowerCase() === "false") return { kind: "false", setting: false, peers: [], raw: text };
  if (tokens.length === 1 && tokens[0].toLowerCase() === "loopback") return { kind: "loopback", setting: "loopback", peers: ["loopback"], raw: text };
  if (tokens.some((t) => t.toLowerCase() === "false" || t.toLowerCase() === "loopback")) throw refusal(text, "cannot mix false or loopback with address entries");
  const peers = tokens.map((t) => checkEntry(t, text));
  if (peers.length === 0) throw refusal(text, "names no address");
  return { kind: "cidrs", setting: peers, peers, raw: text };
}

/** The one startup line that says which peers are believed, and what an unnamed proxy costs. */
export function trustProxyStartupLine(c: TrustProxyConfig): string {
  if (c.kind === "false") {
    return "Trusted proxy headers: none (TRUST_PROXY=false). X-Forwarded-For is ignored, so behind a proxy every client shares the proxy's address and the address-based limits answer 429 for all of them; name the proxy in TRUST_PROXY to fix that.";
  }
  if (c.kind === "cidrs") {
    return `Trusted proxy headers from: ${c.peers.join(", ")} (TRUST_PROXY). Only those peers' X-Forwarded-For is believed; a client asking from anywhere else cannot choose its own address.`;
  }
  const named = c.kind === "default" ? "loopback only (TRUST_PROXY default)" : "loopback only (TRUST_PROXY=loopback)";
  return `Trusted proxy headers: ${named}. A reverse proxy on another address must be named in TRUST_PROXY (its IP or CIDR); until it is, every client behind it shares one address and the address-based limits answer 429 for all of them.`;
}
