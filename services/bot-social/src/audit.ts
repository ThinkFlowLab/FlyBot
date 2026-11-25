import Database from "better-sqlite3";
import { jcs, sha256Hex } from "./crypto.js";
import { newId } from "./ids.js";

export interface AuditRecord {
  seq: number; id: string; ts: string; actor: string; action: string; subject: string | null;
  owners: string[]; data: unknown; prev_hash: string; hash: string;
}

const GENESIS = "0".repeat(64);

/**
 * Append-only, hash-chained audit log kept in its own SQLite database (design §7.4 / §9.13).
 * hash = SHA-256(prev_hash || JCS(record-without-hash)).
 * UPDATE/DELETE are rejected by triggers.
 */
export class AuditLog {
  db: Database.Database;
  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE, ts TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL,
        subject TEXT, owners TEXT NOT NULL, data TEXT NOT NULL, prev_hash TEXT NOT NULL, hash TEXT NOT NULL
      );
      CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_events BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_events BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
    `);
  }

  static recordHash(prev: string, r: Omit<AuditRecord, "hash" | "prev_hash">): string {
    return sha256Hex(prev + jcs({ seq: r.seq, id: r.id, ts: r.ts, actor: r.actor, action: r.action, subject: r.subject, owners: r.owners, data: r.data }));
  }

  head(): { seq: number; hash: string } {
    const row = this.db.prepare("SELECT seq, hash FROM audit_events ORDER BY seq DESC LIMIT 1").get() as { seq: number; hash: string } | undefined;
    return row ?? { seq: 0, hash: GENESIS };
  }

  append(actor: string, action: string, subject: string | null, owners: (string | null | undefined)[], data: unknown = {}): AuditRecord {
    // The head read and the write it extends are one transaction that must take the write lock before it reads.
    // Opened deferred, the read leaves the connection on a snapshot; if another connection commits an append before
    // this one writes, SQLite answers `SQLITE_BUSY_SNAPSHOT` immediately (the busy handler is not consulted), the row
    // is never written, and a caller whose own write already committed is left with an error and a gap in the chain.
    // `immediate` takes the write lock up front, so the only possible outcome is waiting for the other writer.
    const run = () => {
      const head = this.head();
      const rec = {
        seq: head.seq + 1, id: newId("aud"), ts: new Date().toISOString(), actor, action, subject,
        owners: [...new Set(owners.filter((o): o is string => !!o))].sort(), data: JSON.parse(JSON.stringify(data ?? {})),
      };
      const hash = AuditLog.recordHash(head.hash, rec);
      this.db.prepare("INSERT INTO audit_events (seq,id,ts,actor,action,subject,owners,data,prev_hash,hash) VALUES (?,?,?,?,?,?,?,?,?,?)")
        .run(rec.seq, rec.id, rec.ts, actor, action, subject, JSON.stringify(rec.owners), JSON.stringify(rec.data), head.hash, hash);
      return { ...rec, prev_hash: head.hash, hash };
    };
    // A caller that already holds a transaction on this connection owns the lock (and its rollback): joining it is
    // the only legal move — `immediate` cannot start inside another transaction. Callers that defer their audit rows
    // until their own commit (`auditFollowsCommit`) arrive here after that commit, so they take the path above.
    if (this.db.inTransaction) return run();
    return this.db.transaction(run).immediate();
  }

  private parse(row: any): AuditRecord {
    return { ...row, owners: JSON.parse(row.owners), data: JSON.parse(row.data) };
  }

  /** Whether the chain holds any record with exactly this action and subject, however old. `list` answers a page
   *  (the newest N, default 1000), so a caller asking "was this already written?" cannot ask it that way: a record
   *  outside the page is simply absent from the answer. This reads the table for the question itself. */
  has(action: string, subject: string): boolean {
    return this.db.prepare("SELECT 1 FROM audit_events WHERE action = ? AND subject = ? LIMIT 1").get(action, subject) !== undefined;
  }

  list(opts: { owner?: string; subject?: string; limit?: number } = {}): AuditRecord[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.owner) { where.push("owners LIKE ?"); args.push(`%"${opts.owner}"%`); }
    if (opts.subject) { where.push("(subject = ? OR data LIKE ?)"); args.push(opts.subject, `%${opts.subject}%`); }
    // A page is the NEWEST N records, still ascending: every reader (console, botctl, docs) treats the
    // last row as the latest. The older shape returned the OLDEST N, so a busy account could never read
    // its latest events. The bound is also enforced here: SQLite reads a negative LIMIT as "unlimited"
    // and rejects a REAL one ("datatype mismatch"), so anything but a safe non-negative integer is 1000.
    const limit = typeof opts.limit === "number" && Number.isSafeInteger(opts.limit) && opts.limit >= 0 ? opts.limit : 1000;
    const sql = `SELECT * FROM (SELECT * FROM audit_events ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY seq DESC LIMIT ?) ORDER BY seq ASC`;
    return (this.db.prepare(sql).all(...args, limit) as any[]).map((r) => this.parse(r));
  }

  /** Number of records that list this owner (what an owner may see of the chain). */
  countFor(owner: string): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE owners LIKE ?").get(`%"${owner}"%`) as { n: number }).n;
  }

  /** Recompute the whole chain. */
  verify(): { ok: boolean; count: number; head: string; broken_at?: number } {
    let prev = GENESIS;
    let count = 0;
    for (const row of this.db.prepare("SELECT * FROM audit_events ORDER BY seq ASC").iterate() as Iterable<any>) {
      const r = this.parse(row);
      if (r.prev_hash !== prev || AuditLog.recordHash(prev, r) !== r.hash) return { ok: false, count, head: prev, broken_at: r.seq };
      prev = r.hash;
      count++;
    }
    return { ok: true, count, head: prev };
  }
}
