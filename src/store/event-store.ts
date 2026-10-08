import { Database } from "bun:sqlite";
import type { Actor, EventBody, StoredEvent } from "../domain/types.ts";

interface Row {
  seq: number;
  ts: string;
  type: string;
  thread: string | null;
  actor: string;
  payload: string;
}

export class EventStore {
  private readonly db: Database;

  constructor(path: string, options: { exclusive?: boolean } = {}) {
    this.db = new Database(path, { create: true });
    if (options.exclusive) {
      // The daemon holds the database exclusively for its lifetime, so a second daemon cannot start on the same project.
      try {
        this.db.exec("PRAGMA journal_mode = WAL;");
        this.db.exec("PRAGMA locking_mode = EXCLUSIVE;");
        this.db.exec("BEGIN EXCLUSIVE");
        this.db.exec("COMMIT");
      } catch (e) {
        this.db.close();
        if (/locked|busy/i.test(e instanceof Error ? e.message : String(e))) throw new Error("daemon already running");
        throw e;
      }
    } else {
      this.db.exec("PRAGMA journal_mode = WAL;");
    }
    this.db.exec(`CREATE TABLE IF NOT EXISTS events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      type TEXT NOT NULL,
      thread TEXT,
      actor TEXT NOT NULL,
      payload TEXT NOT NULL
    )`);
  }

  append(bodies: EventBody[], actor: Actor, now: Date = new Date()): StoredEvent[] {
    const ts = now.toISOString();
    const insert = this.db.prepare(
      "INSERT INTO events (ts, type, thread, actor, payload) VALUES (?, ?, ?, ?, ?) RETURNING seq",
    );
    // Manual transaction: db.transaction() leaves internal statements unfinalized, which keeps the connection (and its lock) alive after close().
    try {
      this.db.exec("BEGIN");
      try {
        const stored = bodies.map((body) => {
          const row = insert.get(ts, body.type, body.thread ?? null, JSON.stringify(actor), JSON.stringify(body.payload)) as {
            seq: number;
          };
          return { ...body, seq: row.seq, ts, actor } as StoredEvent;
        });
        this.db.exec("COMMIT");
        return stored;
      } catch (e) {
        this.db.exec("ROLLBACK");
        throw e;
      }
    } finally {
      insert.finalize();
    }
  }

  since(seq: number): StoredEvent[] {
    const stmt = this.db.prepare("SELECT * FROM events WHERE seq > ? ORDER BY seq");
    try {
      return (stmt.all(seq) as Row[]).map(toEvent);
    } finally {
      stmt.finalize();
    }
  }

  all(): StoredEvent[] {
    return this.since(0);
  }

  close(): void {
    this.db.close();
  }
}

function toEvent(row: Row): StoredEvent {
  return {
    seq: row.seq,
    ts: row.ts,
    type: row.type,
    ...(row.thread !== null ? { thread: row.thread } : {}),
    actor: JSON.parse(row.actor),
    payload: JSON.parse(row.payload),
  } as StoredEvent;
}
