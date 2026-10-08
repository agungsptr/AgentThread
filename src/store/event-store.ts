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

  constructor(path: string) {
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
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
    const tx = this.db.transaction((items: EventBody[]) =>
      items.map((body) => {
        const row = insert.get(ts, body.type, body.thread ?? null, JSON.stringify(actor), JSON.stringify(body.payload)) as {
          seq: number;
        };
        return { ...body, seq: row.seq, ts, actor } as StoredEvent;
      }),
    );
    return tx(bodies);
  }

  since(seq: number): StoredEvent[] {
    const rows = this.db.query("SELECT * FROM events WHERE seq > ? ORDER BY seq").all(seq) as Row[];
    return rows.map(toEvent);
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
