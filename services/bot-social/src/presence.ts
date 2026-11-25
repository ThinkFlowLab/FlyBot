/**
 * Ephemeral "thinking" presence between Bots that may already talk (a direct chat or a face room).
 * Memory only: never written to the database, the audit log, events or webhooks, and a restart clears it.
 * It carries no content: who (a Bot) is doing what (`thinking`) toward whom (a Bot or a room), until when.
 */
export type PresenceState = "thinking";
export interface PresenceEntry {
  botId: string;
  /** Direct chat: the peer Bot that sees it. Face room: the room id. Exactly one is set. */
  toBot?: string;
  roomId?: string;
  state: PresenceState;
  expiresMs: number;
}

export const PRESENCE_DEFAULT_TTL_S = 20;
export const PRESENCE_MIN_TTL_S = 5;
export const PRESENCE_MAX_TTL_S = 60;
export const PRESENCE_WRITES_PER_MIN = 30;

export class PresenceStore {
  private entries = new Map<string, PresenceEntry>();
  private writes = new Map<string, number[]>();

  private key(e: { botId: string; toBot?: string; roomId?: string }) { return e.roomId ? `${e.botId}|room|${e.roomId}` : `${e.botId}|bot|${e.toBot}`; }

  /** Counts one write for the Bot; false when it is over the per-minute limit. */
  allow(botId: string, nowMs: number): boolean {
    const recent = (this.writes.get(botId) ?? []).filter((t) => nowMs - t < 60_000);
    if (recent.length >= PRESENCE_WRITES_PER_MIN) { this.writes.set(botId, recent); return false; }
    recent.push(nowMs);
    this.writes.set(botId, recent);
    return true;
  }

  set(e: Omit<PresenceEntry, "expiresMs">, ttlMs: number, nowMs: number): number {
    this.prune(nowMs);
    const expiresMs = nowMs + ttlMs;
    this.entries.set(this.key(e), { ...e, expiresMs });
    return expiresMs;
  }

  clear(e: { botId: string; toBot?: string; roomId?: string }) { this.entries.delete(this.key(e)); }

  /** Live entries only. */
  live(nowMs: number): PresenceEntry[] {
    this.prune(nowMs);
    return [...this.entries.values()];
  }

  private prune(nowMs: number) {
    for (const [k, v] of this.entries) if (v.expiresMs <= nowMs) this.entries.delete(k);
    if (this.writes.size > 5000) for (const [k, v] of this.writes) if (!v.some((t) => nowMs - t < 60_000)) this.writes.delete(k);
  }
}
