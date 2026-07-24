import { AmClient } from "./am-client.js";
import { CheckpointStore } from "./checkpoint.js";
import {
  amSessionId,
  type ImporterConfig,
  type SourceName,
} from "./config.js";
import type { DiscoverItem, ImportSession, SyncStats } from "./ir.js";
import {
  discoverCodex,
  loadAllCodexSessions,
} from "./sources/codex.js";
import {
  discoverClaude,
  loadAllClaudeSessions,
} from "./sources/claude.js";
import {
  discoverCursor,
  loadAllCursorSessions,
} from "./sources/cursor.js";

export interface RunOptions {
  sources?: SourceName[];
  limit?: number;
  inputPath?: string;
  dryRun?: boolean;
  /** Max sessions writing to AM at once (I/O concurrency, not CPU threads). */
  concurrency?: number;
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const runners = Array.from(
    { length: Math.min(Math.max(1, concurrency), Math.max(1, items.length)) },
    async () => {
      while (true) {
        const i = next;
        next += 1;
        if (i >= items.length) return;
        results[i] = await worker(items[i], i);
      }
    },
  );
  await Promise.all(runners);
  return results;
}

function selectedSources(
  config: ImporterConfig,
  sources?: SourceName[],
): SourceName[] {
  const wanted = sources?.length
    ? sources
    : (["codex", "cursor", "claude"] as SourceName[]);
  return wanted.filter((s) => config.sources[s]?.enabled);
}

async function collectSessions(
  config: ImporterConfig,
  opts: RunOptions,
): Promise<ImportSession[]> {
  const selected = selectedSources(config, opts.sources);
  const sessions: ImportSession[] = [];
  const seen = new Set<string>();

  const push = (list: ImportSession[]) => {
    for (const s of list) {
      const key = `${s.source}:${s.sessionId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      sessions.push(s);
    }
  };

  for (const source of selected) {
    if (source === "codex") {
      if (opts.inputPath && isCursorInput(opts.inputPath)) continue;
      console.log(`scanning codex…${opts.limit ? ` (limit ${opts.limit})` : ""}`);
      push(
        await loadAllCodexSessions(config.sources.codex.roots, {
          skipSubagent: config.sources.codex.skipSubagent ?? true,
          inputPath: opts.inputPath,
          limit: opts.limit,
        }),
      );
    } else if (source === "cursor") {
      if (opts.inputPath?.toLowerCase().endsWith(".zip")) continue;
      if (
        opts.inputPath &&
        !isCursorInput(opts.inputPath) &&
        opts.inputPath.includes("rollout")
      ) {
        continue;
      }
      console.log(`scanning cursor…${opts.limit ? ` (limit ${opts.limit})` : ""}`);
      push(
        await loadAllCursorSessions(config.sources.cursor.roots, {
          inputPath: opts.inputPath,
          limit: opts.limit,
        }),
      );
    } else if (source === "claude") {
      if (opts.inputPath && isCursorInput(opts.inputPath)) continue;
      if (opts.inputPath?.toLowerCase().endsWith(".zip")) continue;
      console.log(`scanning claude…${opts.limit ? ` (limit ${opts.limit})` : ""}`);
      push(
        await loadAllClaudeSessions(config.sources.claude.roots, {
          inputPath: opts.inputPath,
          limit: opts.limit,
        }),
      );
    }
  }

  sessions.sort((a, b) => (a.endedAt < b.endedAt ? 1 : -1));
  if (opts.limit && opts.limit > 0) return sessions.slice(0, opts.limit);
  return sessions;
}

function isCursorInput(path: string): boolean {
  const lower = path.toLowerCase();
  if (lower.endsWith(".zip")) return false;
  if (lower.endsWith(".json.gz") || lower.endsWith(".json")) return true;
  if (lower.endsWith("state.vscdb")) return true;
  if (lower.includes("cursaves") || lower.includes("cursor")) return true;
  return !lower.includes("codex") && !lower.includes("rollout");
}

export async function runDiscover(
  config: ImporterConfig,
  opts: RunOptions = {},
): Promise<DiscoverItem[]> {
  const selected = selectedSources(config, opts.sources);
  const items: DiscoverItem[] = [];

  // When both sources are selected with a limit, split budget so we don't
  // fully scan Codex before even starting Cursor.
  const perSourceLimit =
    opts.limit && opts.limit > 0 && selected.length > 1
      ? Math.ceil(opts.limit / selected.length)
      : opts.limit;

  for (const source of selected) {
    if (source === "codex") {
      if (opts.inputPath && isCursorInput(opts.inputPath)) continue;
      console.log(
        `scanning codex…${perSourceLimit ? ` (limit ${perSourceLimit})` : ""}`,
      );
      items.push(
        ...(await discoverCodex(config.sources.codex.roots, {
          skipSubagent: config.sources.codex.skipSubagent ?? true,
          inputPath: opts.inputPath,
          limit: perSourceLimit,
        })),
      );
    } else if (source === "cursor") {
      if (opts.inputPath?.toLowerCase().endsWith(".zip")) continue;
      if (
        opts.inputPath &&
        !isCursorInput(opts.inputPath) &&
        opts.inputPath.includes("rollout")
      ) {
        continue;
      }
      console.log(
        `scanning cursor…${perSourceLimit ? ` (limit ${perSourceLimit})` : ""}`,
      );
      items.push(
        ...(await discoverCursor(config.sources.cursor.roots, {
          inputPath: opts.inputPath,
          limit: perSourceLimit,
        })),
      );
    } else if (source === "claude") {
      if (opts.inputPath && isCursorInput(opts.inputPath)) continue;
      if (opts.inputPath?.toLowerCase().endsWith(".zip")) continue;
      console.log(
        `scanning claude…${perSourceLimit ? ` (limit ${perSourceLimit})` : ""}`,
      );
      items.push(
        ...(await discoverClaude(config.sources.claude.roots, {
          inputPath: opts.inputPath,
          limit: perSourceLimit,
        })),
      );
    }
  }

  if (opts.limit && opts.limit > 0) return items.slice(0, opts.limit);
  return items;
}

export async function runSync(
  config: ImporterConfig,
  opts: RunOptions = {},
): Promise<SyncStats> {
  const stats: SyncStats = {
    discovered: 0,
    synced: 0,
    skipped: 0,
    failed: 0,
    observationsWritten: 0,
    errors: [],
  };

  const checkpoint = new CheckpointStore(config.checkpointDbPath);
  const client = new AmClient({
    baseUrl: config.agentMemory.baseUrl,
    secret: config.agentMemory.secret,
    timeoutMs: config.agentMemory.timeoutMs,
  });

  if (!opts.dryRun) {
    const ok = await client.livez();
    if (!ok) {
      checkpoint.close();
      throw new Error(
        `Agent Memory not reachable at ${config.agentMemory.baseUrl}/agentmemory/livez`,
      );
    }
  }

  const sessions = await collectSessions(config, opts);
  stats.discovered = sessions.length;

  const toWrite: ImportSession[] = [];
  for (const session of sessions) {
    if (
      checkpoint.shouldSkip(session.source, session.sessionId, session.contentHash)
    ) {
      stats.skipped += 1;
      continue;
    }
    if (opts.dryRun) {
      stats.skipped += 1;
      console.log(
        `dry-run would sync ${session.source}:${session.sessionId} obs=${session.observations.length}`,
      );
      continue;
    }
    toWrite.push(session);
  }

  const concurrency = Math.max(1, opts.concurrency ?? 8);
  if (toWrite.length > 0) {
    const t = config.agentMemory.timeoutMs;
    console.log(
      `writing ${toWrite.length} session(s) to ${config.agentMemory.baseUrl} (concurrency=${concurrency}, timeout=${t <= 0 ? "until done" : `${t}ms`})`,
    );
  }

  // Serialize checkpoint writes; session HTTP work runs in parallel.
  let checkpointChain: Promise<void> = Promise.resolve();
  const withCheckpoint = <T>(fn: () => T): Promise<T> => {
    const run = checkpointChain.then(() => fn());
    checkpointChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  await mapPool(toWrite, concurrency, async (session) => {
    const amId = amSessionId(session.source, session.sessionId);
    try {
      const written = await client.writeSession(session, amId);
      await withCheckpoint(() => {
        checkpoint.markSynced({
          source: session.source,
          sessionId: session.sessionId,
          contentHash: session.contentHash,
          syncedAt: new Date().toISOString(),
          obsCount: written,
          amSessionId: amId,
          sourcePath: session.sourcePath,
        });
        stats.synced += 1;
        stats.observationsWritten += written;
      });
      console.log(
        `synced ${session.source}:${session.sessionId} obs=${written} title=${JSON.stringify((session.title || "").slice(0, 60))}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await withCheckpoint(() => {
        stats.failed += 1;
        stats.errors.push({ sessionId: session.sessionId, error: message });
      });
      console.error(`failed ${session.source}:${session.sessionId}: ${message}`);
    }
  });

  await checkpointChain;
  checkpoint.close();
  return stats;
}

export function runStatus(config: ImporterConfig): {
  checkpointPath: string;
  total: number;
  bySource: Record<string, number>;
  recent: ReturnType<CheckpointStore["list"]>;
} {
  const checkpoint = new CheckpointStore(config.checkpointDbPath);
  const recent = checkpoint.list(20);
  const bySource = {
    codex: checkpoint.count("codex"),
    cursor: checkpoint.count("cursor"),
    claude: checkpoint.count("claude"),
  };
  const total = checkpoint.count();
  checkpoint.close();
  return {
    checkpointPath: config.checkpointDbPath,
    total,
    bySource,
    recent,
  };
}
