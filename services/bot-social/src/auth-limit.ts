/** Bounded attempt limiter for the password doors: login, owner sign-up and both onboarding gates.
 *
 *  One bucket set is shared by every door: a handful of attempts from one client address (and, when the
 *  request names a username, against that normalised username) fills the bucket for all of them. Buckets are
 *  in memory and pruned on use; a hard ceiling on how many keys are tracked keeps a stream of unique keys
 *  from growing the map without bound (the old per-onboarding map was never pruned).
 */
import { limitFromEnv } from "./policy.js";

export interface AuthRateLimits {
  /** Attempts allowed from one client address inside the window. */
  perIp: number;
  /** Attempts allowed for one normalised username inside the window. */
  perAccount: number;
  windowMs: number;
  /** Hard ceiling on tracked buckets, so a stream of unique keys cannot grow the map without bound. */
  maxBuckets: number;
}

export const DEFAULT_AUTH_RATE_LIMITS: AuthRateLimits = {
  perIp: 10,
  perAccount: 5,
  windowMs: 10 * 60 * 1000,
  maxBuckets: 10_000,
};

/** Which bucket refused an attempt, and how long (whole seconds) until it has room again. */
export interface AuthRateBlock {
  scope: "ip" | "account";
  retry_after: number;
}

/** Env vars (all optional, positive integers). Operator note: see botsocial.env.example. */
export function loadAuthRateLimits(override: Partial<AuthRateLimits> = {}): AuthRateLimits {
  const env: Partial<AuthRateLimits> = {
    perIp: envN("BOTSOCIAL_AUTH_RATE_LIMIT_PER_IP", DEFAULT_AUTH_RATE_LIMITS.perIp),
    perAccount: envN("BOTSOCIAL_AUTH_RATE_LIMIT_PER_ACCOUNT", DEFAULT_AUTH_RATE_LIMITS.perAccount),
    windowMs: envMs("BOTSOCIAL_AUTH_RATE_LIMIT_WINDOW_SECONDS", DEFAULT_AUTH_RATE_LIMITS.windowMs / 1000),
    maxBuckets: envN("BOTSOCIAL_AUTH_RATE_LIMIT_MAX_BUCKETS", DEFAULT_AUTH_RATE_LIMITS.maxBuckets),
  };
  return { ...DEFAULT_AUTH_RATE_LIMITS, ...omitUndef(env), ...omitUndef(override) };
}

function envN(name: string, fallback: number): number | undefined {
  const v = process.env[name];
  if (v === undefined) return undefined;
  return limitFromEnv(v, fallback);
}
function envMs(name: string, fallbackSeconds: number): number | undefined {
  const n = envN(name, fallbackSeconds);
  return n === undefined ? undefined : n * 1000;
}
function omitUndef<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** Usernames are matched case-insensitively for budgeting only; the account lookup keeps its exact spelling. */
export function authAccountKey(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const key = raw.trim().toLowerCase().slice(0, 64);
  return key || null;
}

export class AuthRateLimiter {
  private buckets = new Map<string, number[]>();
  constructor(private limits: AuthRateLimits, private now: () => number) {}

  /** How many buckets are currently tracked (bounded by `maxBuckets`). */
  get size(): number {
    return this.buckets.size;
  }

  /** Count one attempt against the address and the account (when named).
   *  Returns a refusal when either bucket is full; a refused attempt is not recorded, so waiting it out
   *  is the only way back and a refusal cannot extend the block by itself. */
  take(keys: { ip?: string | null; account?: string | null }): AuthRateBlock | null {
    const now = this.now();
    const checked: { key: string; limit: number; scope: "ip" | "account" }[] = [];
    if (keys.ip) checked.push({ key: `ip:${keys.ip}`, limit: this.limits.perIp, scope: "ip" });
    const account = authAccountKey(keys.account);
    if (account) checked.push({ key: `account:${account}`, limit: this.limits.perAccount, scope: "account" });

    const live = checked.map((b) => ({ ...b, hits: this.prune(b.key, now) }));
    for (const b of live) {
      if (b.hits.length >= b.limit) {
        const oldest = b.hits[b.hits.length - b.limit];
        return { scope: b.scope, retry_after: Math.max(1, Math.ceil((oldest + this.limits.windowMs - now) / 1000)) };
      }
    }
    // Delete + re-insert moves the key to the end, so the map stays in least-recently-used order.
    for (const b of live) { this.buckets.delete(b.key); this.buckets.set(b.key, [...b.hits, now]); }
    this.capBuckets(now);
    return null;
  }

  /** Forget one account's attempts after a password door accepted that name and its secret.
   *
   *  Only the account bucket is cleared: the address bucket still remembers the burst, so wrong passwords followed by
   *  one success from the same client cannot buy extra tries across accounts, and the per-account ceiling still stops
   *  a guesser who only ever fails. A refusal happens before the password check, so a refused attempt never clears. */
  forgiveAccount(raw: unknown): void {
    const account = authAccountKey(raw);
    if (account) this.buckets.delete(`account:${account}`);
  }

  /** Timestamps still inside the window for one bucket; drops the key when nothing is left. */
  private prune(key: string, now: number): number[] {
    const hits = this.buckets.get(key);
    if (!hits) return [];
    const live = hits.filter((t) => now - t < this.limits.windowMs);
    if (live.length) this.buckets.set(key, live);
    else this.buckets.delete(key);
    return live;
  }

  /** Drop expired buckets and, if that is not enough, the least recently used ones until under the cap. */
  private capBuckets(now: number) {
    if (this.buckets.size <= this.limits.maxBuckets) return;
    for (const key of this.buckets.keys()) this.prune(key, now);
    while (this.buckets.size > this.limits.maxBuckets) {
      const oldest = this.buckets.keys().next().value as string | undefined;
      if (oldest === undefined) return;
      this.buckets.delete(oldest);
    }
  }
}
