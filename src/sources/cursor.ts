import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, basename } from "node:path";
import { gunzipSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import type { DiscoverItem, ImportObservation, ImportSession } from "../ir.js";
import { deriveProject, sha256Text } from "../config.js";

const MAX_TEXT = 20_000;
const BUBBLE_USER = 1;
const BUBBLE_ASSISTANT = 2;

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function walkFiles(
  root: string,
  pred: (name: string, full: string) => boolean,
  out: string[] = [],
): string[] {
  if (!existsSync(root)) return out;
  let st;
  try {
    st = statSync(root);
  } catch {
    return out;
  }
  if (st.isFile()) {
    if (pred(basename(root), root)) out.push(root);
    return out;
  }
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) walkFiles(full, pred, out);
    else if (pred(entry.name, full)) out.push(full);
  }
  return out;
}

class SqliteKv {
  private db: DatabaseSync;
  private tmpDir: string | null = null;

  constructor(dbPath: string) {
    try {
      this.db = new DatabaseSync(dbPath, { readOnly: true });
      this.db.prepare("SELECT 1").get();
    } catch {
      const dir = join(tmpdir(), `am-cursor-${Date.now()}-${Math.random().toString(16).slice(2)}`);
      mkdirSync(dir, { recursive: true });
      this.tmpDir = dir;
      const tmpDb = join(dir, "state.vscdb");
      copyFileSync(dbPath, tmpDb);
      for (const suffix of ["-wal", "-shm"]) {
        const side = dbPath + suffix;
        if (existsSync(side)) copyFileSync(side, tmpDb + suffix);
      }
      this.db = new DatabaseSync(tmpDb);
      try {
        this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      } catch {
        /* ignore */
      }
    }
  }

  getItem(key: string, table = "ItemTable"): string | null {
    try {
      const row = this.db
        .prepare(`SELECT value FROM ${table} WHERE key = ?`)
        .get(key) as { value: string | Uint8Array | null } | undefined;
      if (!row || row.value == null) return null;
      if (typeof row.value === "string") return row.value;
      return Buffer.from(row.value).toString("utf8");
    } catch {
      return null;
    }
  }

  getJson<T = unknown>(key: string, table = "ItemTable"): T | null {
    const raw = this.getItem(key, table) ?? this.getItem(key, "cursorDiskKV");
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  listKeys(prefix: string, table = "cursorDiskKV"): string[] {
    try {
      const rows = this.db
        .prepare(`SELECT key FROM ${table} WHERE key LIKE ?`)
        .all(`${prefix}%`) as Array<{ key: string }>;
      return rows.map((r) => r.key);
    } catch {
      return [];
    }
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* ignore */
    }
    if (this.tmpDir) {
      rmSync(this.tmpDir, { recursive: true, ignoreErrors: true });
    }
  }
}

interface BubbleHeader {
  bubbleId?: string;
  type?: number;
}

interface ComposerData {
  name?: string;
  createdAt?: number | string;
  lastUpdatedAt?: number | string;
  fullConversationHeadersOnly?: BubbleHeader[];
  conversationMap?: Record<string, BubbleBody>;
}

interface BubbleBody {
  type?: number;
  text?: string;
  richText?: string;
  createdAt?: string | number;
  toolResults?: unknown;
  toolFormerData?: unknown;
}

interface SnapshotFile {
  version?: number;
  composerId?: string;
  sourceProjectPath?: string;
  projectIdentifier?: string;
  composerData?: ComposerData;
  bubbleEntries?: Record<string, BubbleBody>;
}

function msToIso(value: unknown): string {
  if (typeof value === "string" && value.includes("T")) return value;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return new Date().toISOString();
  const ms = n < 1e12 ? n * 1000 : n;
  return new Date(ms).toISOString();
}

function bubbleText(b: BubbleBody | undefined): string {
  if (!b) return "";
  if (typeof b.text === "string" && b.text.trim()) return b.text.trim();
  if (typeof b.richText === "string" && b.richText.trim()) {
    // richText is often stringified ProseMirror JSON — keep raw truncated
    return b.richText.trim();
  }
  return "";
}

function sessionFromComposer(opts: {
  composerId: string;
  composerData: ComposerData;
  bubbles: Record<string, BubbleBody>;
  projectPath?: string;
  sourcePath: string;
  contentHash: string;
}): ImportSession | null {
  const headers = opts.composerData.fullConversationHeadersOnly || [];
  const observations: ImportObservation[] = [];
  let startedAt = "";
  let endedAt = "";

  const pushBubble = (header: BubbleHeader, body: BubbleBody | undefined) => {
    const text = truncate(bubbleText(body), MAX_TEXT);
    if (!text) return;
    const ts = msToIso(body?.createdAt || opts.composerData.createdAt);
    if (!startedAt) startedAt = ts;
    endedAt = ts;
    const type = header.type ?? body?.type;
    if (type === BUBBLE_USER) {
      observations.push({ timestamp: ts, type: "conversation", userPrompt: text });
    } else if (type === BUBBLE_ASSISTANT) {
      observations.push({
        timestamp: ts,
        type: "conversation",
        assistantResponse: text,
      });
      // Optional tool results attached to assistant bubble
      if (body?.toolResults) {
        const tools = Array.isArray(body.toolResults)
          ? body.toolResults
          : [body.toolResults];
        for (const tool of tools) {
          if (!tool || typeof tool !== "object") continue;
          const t = tool as Record<string, unknown>;
          const name =
            (typeof t.name === "string" && t.name) ||
            (typeof t.toolName === "string" && t.toolName) ||
            "tool";
          observations.push({
            timestamp: ts,
            type: "tool",
            toolName: name,
            toolInput: t.params ?? t.input ?? {},
            toolOutput: truncate(
              typeof t.result === "string"
                ? t.result
                : JSON.stringify(t.result ?? t.output ?? ""),
              8000,
            ),
          });
        }
      }
    }
  };

  if (headers.length > 0) {
    for (const header of headers) {
      const id = header.bubbleId;
      if (!id) continue;
      const body =
        opts.bubbles[id] ||
        opts.composerData.conversationMap?.[id];
      pushBubble(header, body);
    }
  } else {
    // Legacy conversationMap-only
    const map = opts.composerData.conversationMap || opts.bubbles;
    for (const [id, body] of Object.entries(map)) {
      pushBubble({ bubbleId: id, type: body.type }, body);
    }
  }

  if (observations.length === 0) return null;

  const now = new Date().toISOString();
  const cwd = opts.projectPath;
  return {
    source: "cursor",
    sessionId: opts.composerId,
    project: deriveProject(cwd) || opts.composerData.name || "cursor",
    cwd,
    title: opts.composerData.name || `cursor:${opts.composerId.slice(0, 8)}`,
    startedAt: startedAt || msToIso(opts.composerData.createdAt) || now,
    endedAt: endedAt || msToIso(opts.composerData.lastUpdatedAt) || now,
    contentHash: opts.contentHash,
    observations,
    sourcePath: opts.sourcePath,
  };
}

function parseSnapshotFile(path: string): ImportSession | null {
  const raw = path.endsWith(".gz")
    ? gunzipSync(readFileSync(path))
    : readFileSync(path);
  const data = JSON.parse(raw.toString("utf8")) as SnapshotFile;
  const composerId =
    data.composerId ||
    basename(path).replace(/\.json(\.gz)?$/i, "").replace(/\.\d+$/, "");
  const composerData = data.composerData || {};
  const bubbles = data.bubbleEntries || {};
  const st = statSync(path);
  const contentHash = createHash("sha256")
    .update(`${st.size}:${st.mtimeMs}:${path}`)
    .digest("hex");

  return sessionFromComposer({
    composerId,
    composerData,
    bubbles,
    projectPath: data.sourceProjectPath,
    sourcePath: path,
    contentHash,
  });
}

function findGlobalDb(roots: string[]): string | null {
  for (const root of roots) {
    if (root.endsWith("state.vscdb") && existsSync(root)) return root;
    const candidate = join(root, "state.vscdb");
    if (existsSync(candidate)) return candidate;
    // root may be globalStorage itself
    if (basename(root) === "globalStorage") {
      const p = join(root, "state.vscdb");
      if (existsSync(p)) return p;
    }
  }
  return null;
}

function loadFromGlobalDb(globalDbPath: string): ImportSession[] {
  const db = new SqliteKv(globalDbPath);
  const sessions: ImportSession[] = [];
  try {
    const headers =
      db.getJson<{ allComposers?: Array<Record<string, unknown>> }>(
        "composer.composerHeaders",
        "ItemTable",
      )?.allComposers || [];

    const composerIds = new Set<string>();
    for (const h of headers) {
      if (typeof h.composerId === "string") composerIds.add(h.composerId);
    }

    // Also scan composerData:* keys
    for (const key of [
      ...db.listKeys("composerData:", "cursorDiskKV"),
      ...db.listKeys("composerData:", "ItemTable"),
    ]) {
      const id = key.slice("composerData:".length);
      if (id) composerIds.add(id);
    }

    for (const composerId of composerIds) {
      const composerData =
        db.getJson<ComposerData>(`composerData:${composerId}`, "cursorDiskKV") ||
        db.getJson<ComposerData>(`composerData:${composerId}`, "ItemTable");
      if (!composerData) continue;

      const bubbles: Record<string, BubbleBody> = {
        ...(composerData.conversationMap || {}),
      };
      const bubbleKeys = [
        ...db.listKeys(`bubbleId:${composerId}:`, "cursorDiskKV"),
        ...db.listKeys(`bubbleId:${composerId}:`, "ItemTable"),
      ];
      for (const key of bubbleKeys) {
        const bubbleId = key.slice(`bubbleId:${composerId}:`.length);
        const body =
          db.getJson<BubbleBody>(key, "cursorDiskKV") ||
          db.getJson<BubbleBody>(key, "ItemTable");
        if (body) bubbles[bubbleId] = body;
      }

      const headerEntry = headers.find((h) => h.composerId === composerId);
      const wi = headerEntry?.workspaceIdentifier as
        | { uri?: { fsPath?: string; path?: string } }
        | undefined;
      const projectPath =
        wi?.uri?.fsPath ||
        wi?.uri?.path ||
        (typeof headerEntry?.name === "string" ? undefined : undefined);

      const fingerprint = sha256Text(
        JSON.stringify({
          composerId,
          headers: composerData.fullConversationHeadersOnly?.length,
          bubbles: Object.keys(bubbles).length,
          name: composerData.name,
          lastUpdatedAt: composerData.lastUpdatedAt,
        }),
      );

      const session = sessionFromComposer({
        composerId,
        composerData: {
          ...composerData,
          name:
            composerData.name ||
            (typeof headerEntry?.name === "string" ? headerEntry.name : undefined),
        },
        bubbles,
        projectPath,
        sourcePath: `${globalDbPath}#${composerId}`,
        contentHash: fingerprint,
      });
      if (session) sessions.push(session);
    }
  } finally {
    db.close();
  }
  return sessions;
}

export async function discoverCursor(
  roots: string[],
  opts: { inputPath?: string; limit?: number } = {},
): Promise<DiscoverItem[]> {
  const sessions = await loadAllCursorSessions(roots, opts);
  return sessions.map((s) => ({
    source: "cursor" as const,
    sessionId: s.sessionId,
    title: s.title,
    cwd: s.cwd,
    project: s.project,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    observationCount: s.observations.length,
    contentHash: s.contentHash,
    sourcePath: s.sourcePath,
  }));
}

export async function loadAllCursorSessions(
  roots: string[],
  opts: { inputPath?: string; limit?: number } = {},
): Promise<ImportSession[]> {
  const sessions: ImportSession[] = [];
  const seen = new Set<string>();
  const limit = opts.limit && opts.limit > 0 ? opts.limit : 0;

  const add = (s: ImportSession | null): boolean => {
    if (!s) return false;
    if (seen.has(s.sessionId)) return false;
    seen.add(s.sessionId);
    sessions.push(s);
    return true;
  };

  const full = (): boolean => limit > 0 && sessions.length >= limit;

  const inputs = opts.inputPath ? [opts.inputPath] : roots;

  for (const root of inputs) {
    if (!existsSync(root) || full()) continue;

    const snapshots = walkFiles(
      root,
      (name) =>
        name.endsWith(".json.gz") ||
        (name.endsWith(".json") && !name.endsWith(".meta.json")),
    )
      .filter((p) => !p.endsWith(".meta.json"))
      .sort((a, b) => {
        try {
          return statSync(b).mtimeMs - statSync(a).mtimeMs;
        } catch {
          return 0;
        }
      });

    for (const snap of snapshots) {
      if (full()) break;
      try {
        add(parseSnapshotFile(snap));
      } catch {
        /* skip bad snapshot */
      }
    }

    if (full()) continue;

    if (root.endsWith("state.vscdb") || basename(root) === "state.vscdb") {
      for (const s of loadFromGlobalDb(root)) {
        add(s);
        if (full()) break;
      }
    } else {
      const globalDb = findGlobalDb([root]);
      if (globalDb) {
        for (const s of loadFromGlobalDb(globalDb)) {
          add(s);
          if (full()) break;
        }
      }
      if (full()) continue;
      const wsDbs = walkFiles(
        root,
        (name, fullPath) =>
          name === "state.vscdb" && fullPath.includes("workspaceStorage"),
      );
      for (const wsDb of wsDbs) {
        if (full()) break;
        try {
          for (const s of loadFromGlobalDb(wsDb)) {
            add(s);
            if (full()) break;
          }
        } catch {
          /* ignore */
        }
      }
    }
  }

  sessions.sort((a, b) => (a.endedAt < b.endedAt ? 1 : -1));
  if (limit > 0) return sessions.slice(0, limit);
  return sessions;
}

/** Test helper: write a minimal snapshot for fixtures */
export function writeDebugSnapshot(
  path: string,
  session: {
    composerId: string;
    name?: string;
    projectPath?: string;
    messages: Array<{ type: 1 | 2; text: string }>;
  },
): void {
  const headers = session.messages.map((m, i) => ({
    bubbleId: `b${i}`,
    type: m.type,
  }));
  const bubbleEntries: Record<string, BubbleBody> = {};
  session.messages.forEach((m, i) => {
    bubbleEntries[`b${i}`] = { type: m.type, text: m.text, createdAt: Date.now() };
  });
  const payload: SnapshotFile = {
    version: 3,
    composerId: session.composerId,
    sourceProjectPath: session.projectPath,
    composerData: {
      name: session.name || session.composerId,
      fullConversationHeadersOnly: headers,
      createdAt: Date.now(),
      lastUpdatedAt: Date.now(),
    },
    bubbleEntries,
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(payload));
}
