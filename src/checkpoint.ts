import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface CheckpointRow {
  source: string;
  sessionId: string;
  contentHash: string;
  syncedAt: string;
  obsCount: number;
  amSessionId: string;
  sourcePath?: string;
}

export class CheckpointStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS synced_sessions (
        source TEXT NOT NULL,
        session_id TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        synced_at TEXT NOT NULL,
        obs_count INTEGER NOT NULL DEFAULT 0,
        am_session_id TEXT NOT NULL,
        source_path TEXT,
        PRIMARY KEY (source, session_id)
      );
      CREATE INDEX IF NOT EXISTS idx_synced_at ON synced_sessions(synced_at);
    `);
  }

  get(source: string, sessionId: string): CheckpointRow | null {
    const row = this.db
      .prepare(
        `SELECT source, session_id AS sessionId, content_hash AS contentHash,
                synced_at AS syncedAt, obs_count AS obsCount,
                am_session_id AS amSessionId, source_path AS sourcePath
         FROM synced_sessions WHERE source = ? AND session_id = ?`,
      )
      .get(source, sessionId) as CheckpointRow | undefined;
    return row ?? null;
  }

  shouldSkip(source: string, sessionId: string, contentHash: string): boolean {
    const existing = this.get(source, sessionId);
    return Boolean(existing && existing.contentHash === contentHash);
  }

  markSynced(row: CheckpointRow): void {
    this.db
      .prepare(
        `INSERT INTO synced_sessions
          (source, session_id, content_hash, synced_at, obs_count, am_session_id, source_path)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(source, session_id) DO UPDATE SET
           content_hash = excluded.content_hash,
           synced_at = excluded.synced_at,
           obs_count = excluded.obs_count,
           am_session_id = excluded.am_session_id,
           source_path = excluded.source_path`,
      )
      .run(
        row.source,
        row.sessionId,
        row.contentHash,
        row.syncedAt,
        row.obsCount,
        row.amSessionId,
        row.sourcePath ?? null,
      );
  }

  count(source?: string): number {
    if (source) {
      const row = this.db
        .prepare(`SELECT COUNT(*) AS c FROM synced_sessions WHERE source = ?`)
        .get(source) as { c: number };
      return row.c;
    }
    const row = this.db
      .prepare(`SELECT COUNT(*) AS c FROM synced_sessions`)
      .get() as { c: number };
    return row.c;
  }

  list(limit = 50): CheckpointRow[] {
    return this.db
      .prepare(
        `SELECT source, session_id AS sessionId, content_hash AS contentHash,
                synced_at AS syncedAt, obs_count AS obsCount,
                am_session_id AS amSessionId, source_path AS sourcePath
         FROM synced_sessions
         ORDER BY synced_at DESC
         LIMIT ?`,
      )
      .all(limit) as CheckpointRow[];
  }

  close(): void {
    this.db.close();
  }
}
