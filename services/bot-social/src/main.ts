// Load botsocial.env before any module that reads process.env at import time (policy.ts LIMITS does).
import "./load-env.js";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { ensureBotctl } from "./botctl-build.js";
import { Platform } from "./platform.js";
import { loadKmsKey } from "./custody.js";
import { buildServer } from "./server.js";
import { loadTrustProxy, trustProxyStartupLine } from "./trust-proxy.js";

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "127.0.0.1";
const dataDir = process.env.DATA_DIR || "data";
const dbPath = process.env.BOTSOCIAL_DB ?? `${dataDir}/botsocial.db`;
const auditPath = process.env.BOTSOCIAL_AUDIT_DB ?? `${dataDir}/audit.db`;
for (const p of [dbPath, auditPath]) if (p !== ":memory:") mkdirSync(dirname(p), { recursive: true });

const kmsKey = loadKmsKey(process.env.BOTSOCIAL_KMS_KEY, process.env.BOTSOCIAL_KMS_KEY_FILE ?? `${dataDir}/kms.key`);
const platform = new Platform({ kmsKey, dbPath, auditPath, webhooks: {
  debounceMs: Number(process.env.WEBHOOK_DEBOUNCE_SECONDS ?? 20) * 1000,
  maxPerHour: Number(process.env.WEBHOOK_MAX_PER_HOUR ?? 30),
  allowPrivate: process.env.WEBHOOK_ALLOW_PRIVATE === "1",
}, attachments: {
  maxBytes: Number(process.env.BOTSOCIAL_ATTACHMENT_MAX_MB ?? 20) * 1024 * 1024,
  ttlMs: Number(process.env.BOTSOCIAL_ATTACHMENT_TTL_DAYS ?? 7) * 24 * 3600 * 1000,
  ownerBudgetBytes: Number(process.env.BOTSOCIAL_ATTACHMENT_BUDGET_MB ?? 512) * 1024 * 1024,
}, publicBaseUrl: process.env.PUBLIC_BASE_URL || `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}` });
if (platform.oauth.warning) console.warn(platform.oauth.warning);
const trustProxy = loadTrustProxy(process.env.TRUST_PROXY);
const app = buildServer(platform, { logger: process.env.LOG === "1", fixedBaseUrl: !!process.env.PUBLIC_BASE_URL, trustProxy: trustProxy.setting });
console.log(trustProxyStartupLine(trustProxy));
await ensureBotctl().catch((e) => console.warn("botctl build skipped:", e.message));
await app.listen({ port, host });
console.log(`Bot Social listening on http://${host}:${port}  · UI /ui · guide /guide · botctl /botctl · pid ${process.pid}`);
// Expired attachments are deleted hourly (and on every upload). The same tick is the platform's own delivery moment:
// a batch held through quiet hours leaves when the window ends even if the owner never opens the account again.
const cleanup = setInterval(() => {
  try { platform.cleanupAttachments(); } catch (e: any) { console.warn("attachment cleanup failed:", e.message); }
  try { platform.flushHeldApprovals(); } catch (e: any) { console.warn("held approval flush failed:", e.message); }
}, 3600e3);
cleanup.unref();
const shutdown = async () => { await app.close(); platform.close(); process.exit(0); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
