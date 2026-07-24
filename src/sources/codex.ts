import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { join, basename } from "node:path";
import { createInterface } from "node:readline";
import { unzipSync, strFromU8 } from "fflate";
import type { DiscoverItem, ImportObservation, ImportSession } from "../ir.js";
import { deriveProject, sha256Text } from "../config.js";

const SESSION_EXPORT_KIND = "codex-session-export";
const MAX_TEXT = 20_000;
const MAX_TOOL_OUTPUT = 8_000;

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function isNoiseUserText(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (t.startsWith("# AGENTS.md")) return true;
  if (t.includes("<environment_context>")) return true;
  if (t.includes("<permissions instructions>")) return true;
  if (t.startsWith("<INSTRUCTIONS>")) return true;
  return false;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const p = part as Record<string, unknown>;
    if (typeof p.text === "string") parts.push(p.text);
    else if (typeof p.output_text === "string") parts.push(p.output_text);
    else if (p.type === "input_text" && typeof p.text === "string") parts.push(p.text);
    else if (p.type === "output_text" && typeof p.text === "string") parts.push(p.text);
  }
  return parts.join("\n");
}

export function classifySessionKind(title: string, cwd: string): string {
  const titleL = title.trim().toLowerCase();
  const cwdL = cwd.trim().toLowerCase();
  if (
    titleL.includes("subagent") ||
    titleL.includes("sub-agent") ||
    titleL.includes("agent run") ||
    cwdL.includes("/subagent") ||
    cwdL.includes("\\subagent") ||
    cwdL.includes("subagent/") ||
    cwdL.includes("subagent\\")
  ) {
    return "subagent";
  }
  if (
    titleL.includes("external") ||
    titleL.includes("imported") ||
    titleL.includes("cli run") ||
    cwdL.includes("imported") ||
    cwdL.includes("/external") ||
    cwdL.includes("\\external")
  ) {
    return "external";
  }
  return "conversation";
}

function walkRolloutFiles(root: string, out: string[] = []): string[] {
  if (!existsSync(root)) return out;
  let st;
  try {
    st = statSync(root);
  } catch {
    return out;
  }
  if (st.isFile()) {
    if (/rollout-.*\.jsonl$/i.test(basename(root)) || root.endsWith(".jsonl")) {
      out.push(root);
    }
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
    if (entry.isDirectory()) walkRolloutFiles(full, out);
    else if (/rollout-.*\.jsonl$/i.test(entry.name)) out.push(full);
  }
  return out;
}

function sessionIdFromMeta(meta: Record<string, unknown>): string | null {
  const payload = (meta.payload as Record<string, unknown>) || meta;
  const id = payload.id || payload.session_id || meta.id || meta.session_id;
  return typeof id === "string" && id ? id : null;
}

function cwdFromMeta(meta: Record<string, unknown>): string | undefined {
  const payload = (meta.payload as Record<string, unknown>) || meta;
  const cwd = payload.cwd;
  return typeof cwd === "string" && cwd.trim() ? cwd.trim() : undefined;
}

async function parseRolloutFile(
  path: string,
  opts: { skipSubagent: boolean },
): Promise<ImportSession | null> {
  const hash = createHash("sha256");
  const st = statSync(path);
  hash.update(`${st.size}:${st.mtimeMs}:${path}`);

  let sessionId: string | null = null;
  let cwd: string | undefined;
  let title = "";
  let startedAt = "";
  let endedAt = "";
  const observations: ImportObservation[] = [];
  const pendingTools = new Map<string, { name: string; input: unknown; ts: string }>();

  const rl = createInterface({
    input: createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    const type = obj.type;
    const ts =
      typeof obj.timestamp === "string"
        ? obj.timestamp
        : new Date().toISOString();
    if (!startedAt) startedAt = ts;
    endedAt = ts;

    if (type === "session_meta") {
      if (!sessionId) sessionId = sessionIdFromMeta(obj);
      if (!cwd) cwd = cwdFromMeta(obj);
      continue;
    }

    const payload = (obj.payload as Record<string, unknown>) || {};

    if (type === "event_msg") {
      const ptype = payload.type;
      if (ptype === "user_message" && typeof payload.message === "string") {
        const text = truncate(payload.message.trim(), MAX_TEXT);
        if (text && !isNoiseUserText(text)) {
          if (!title) title = text.slice(0, 80);
          observations.push({
            timestamp: ts,
            type: "conversation",
            userPrompt: text,
          });
        }
      } else if (
        ptype === "agent_message" &&
        typeof payload.message === "string"
      ) {
        const text = truncate(payload.message.trim(), MAX_TEXT);
        if (text) {
          observations.push({
            timestamp: ts,
            type: "conversation",
            assistantResponse: text,
          });
        }
      }
      continue;
    }

    if (type === "response_item") {
      const ptype = payload.type;
      if (ptype === "message") {
        const role = payload.role;
        const text = truncate(contentText(payload.content).trim(), MAX_TEXT);
        if (!text) continue;
        if (role === "user") {
          if (isNoiseUserText(text)) continue;
          // Prefer event_msg when present; still accept response_item-only files.
          if (!observations.some((o) => o.userPrompt === text)) {
            if (!title) title = text.slice(0, 80);
            observations.push({
              timestamp: ts,
              type: "conversation",
              userPrompt: text,
            });
          }
        } else if (role === "assistant") {
          if (!observations.some((o) => o.assistantResponse === text)) {
            observations.push({
              timestamp: ts,
              type: "conversation",
              assistantResponse: text,
            });
          }
        }
      } else if (ptype === "function_call" || ptype === "custom_tool_call") {
        const callId =
          (typeof payload.call_id === "string" && payload.call_id) ||
          (typeof payload.id === "string" && payload.id) ||
          `${observations.length}`;
        const name =
          (typeof payload.name === "string" && payload.name) || "tool";
        let input: unknown = payload.arguments ?? payload.input ?? {};
        if (typeof input === "string") {
          try {
            input = JSON.parse(input);
          } catch {
            /* keep string */
          }
        }
        pendingTools.set(callId, { name, input, ts });
      } else if (
        ptype === "function_call_output" ||
        ptype === "custom_tool_call_output"
      ) {
        const callId =
          (typeof payload.call_id === "string" && payload.call_id) ||
          (typeof payload.id === "string" && payload.id) ||
          "";
        const pending = callId ? pendingTools.get(callId) : undefined;
        const outputRaw =
          typeof payload.output === "string"
            ? payload.output
            : typeof payload.content === "string"
              ? payload.content
              : JSON.stringify(payload.output ?? payload.content ?? "");
        observations.push({
          timestamp: pending?.ts || ts,
          type: "tool",
          toolName: pending?.name || "tool",
          toolInput: pending?.input ?? {},
          toolOutput: truncate(outputRaw, MAX_TOOL_OUTPUT),
        });
        if (callId) pendingTools.delete(callId);
      }
    }
  }

  // Flush tools without outputs
  for (const pending of pendingTools.values()) {
    observations.push({
      timestamp: pending.ts,
      type: "tool",
      toolName: pending.name,
      toolInput: pending.input,
      toolOutput: "",
    });
  }

  if (!sessionId) {
    const m = basename(path).match(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    );
    sessionId = m?.[0] || sha256Text(path).slice(0, 32);
  }

  const kind = classifySessionKind(title, cwd || "");
  if (opts.skipSubagent && kind === "subagent") return null;

  // Drop empty / system-instruction-only sessions
  const meaningful = observations.filter(
    (o) =>
      o.userPrompt ||
      o.assistantResponse ||
      (o.toolName && o.toolName !== "tool"),
  );
  if (meaningful.length === 0) return null;

  // Dedup: if we collected both event_msg and response_item duplicates, keep order unique by hash of content
  const seen = new Set<string>();
  const deduped: ImportObservation[] = [];
  for (const o of meaningful) {
    const key = sha256Text(
      `${o.timestamp}|${o.userPrompt || ""}|${o.assistantResponse || ""}|${o.toolName || ""}|${JSON.stringify(o.toolInput || {})}|${String(o.toolOutput || "").slice(0, 200)}`,
    );
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(o);
  }

  const contentHash = hash.digest("hex");
  const now = new Date().toISOString();
  return {
    source: "codex",
    sessionId,
    project: deriveProject(cwd),
    cwd,
    title: title || `codex:${sessionId.slice(0, 8)}`,
    startedAt: startedAt || now,
    endedAt: endedAt || now,
    contentHash,
    observations: deduped,
    sourcePath: path,
  };
}

function toDiscoverItem(session: ImportSession): DiscoverItem {
  return {
    source: "codex",
    sessionId: session.sessionId,
    title: session.title,
    cwd: session.cwd,
    project: session.project,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    observationCount: session.observations.length,
    contentHash: session.contentHash,
    sourcePath: session.sourcePath,
  };
}

export async function loadAllCodexSessions(
  roots: string[],
  opts: { skipSubagent?: boolean; inputPath?: string; limit?: number } = {},
): Promise<ImportSession[]> {
  const skipSubagent = opts.skipSubagent ?? true;
  const sessions: ImportSession[] = [];

  if (opts.inputPath?.toLowerCase().endsWith(".zip")) {
    sessions.push(
      ...(await loadCodexZipSessions(opts.inputPath, { skipSubagent })),
    );
  } else {
    const files: string[] = [];
    if (opts.inputPath) walkRolloutFiles(opts.inputPath, files);
    else for (const root of roots) walkRolloutFiles(root, files);

    files.sort((a, b) => {
      try {
        return statSync(b).mtimeMs - statSync(a).mtimeMs;
      } catch {
        return 0;
      }
    });

    for (const file of files) {
      if (opts.limit && opts.limit > 0 && sessions.length >= opts.limit) break;
      try {
        const session = await parseRolloutFile(file, { skipSubagent });
        if (session) sessions.push(session);
      } catch (err) {
        console.warn(
          `skip codex file ${file}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  }

  sessions.sort((a, b) => (a.endedAt < b.endedAt ? 1 : -1));
  if (opts.limit && opts.limit > 0) return sessions.slice(0, opts.limit);
  return sessions;
}

export async function discoverCodex(
  roots: string[],
  opts: { skipSubagent?: boolean; inputPath?: string; limit?: number } = {},
): Promise<DiscoverItem[]> {
  const sessions = await loadAllCodexSessions(roots, opts);
  return sessions.map(toDiscoverItem);
}

export async function loadCodexSession(
  item: DiscoverItem,
  opts: { skipSubagent?: boolean } = {},
): Promise<ImportSession | null> {
  if (!item.sourcePath) return null;
  if (
    item.sourcePath.toLowerCase().endsWith(".zip") ||
    item.sourcePath.includes(".zip#")
  ) {
    const zipPath = item.sourcePath.split("#")[0];
    const sessions = await loadCodexZipSessions(zipPath, {
      skipSubagent: opts.skipSubagent ?? true,
      onlyId: item.sessionId,
    });
    return sessions[0] || null;
  }
  return parseRolloutFile(item.sourcePath, {
    skipSubagent: opts.skipSubagent ?? true,
  });
}

interface ZipManifestSession {
  sessionId?: string;
  title?: string;
  cwd?: string;
  relativeRolloutPath?: string;
  fileEntry?: string;
}

interface ZipManifest {
  kind?: string;
  packageVersion?: number;
  sessions?: ZipManifestSession[];
}

async function loadCodexZipSessions(
  zipPath: string,
  opts: { skipSubagent: boolean; onlyId?: string },
): Promise<ImportSession[]> {
  const bytes = readFileSync(zipPath);
  const unzipped = unzipSync(new Uint8Array(bytes));
  const manifestFile = unzipped["manifest.json"];
  if (!manifestFile) throw new Error("zip missing manifest.json");

  const manifest = JSON.parse(strFromU8(manifestFile)) as ZipManifest;
  if (manifest.kind !== SESSION_EXPORT_KIND) {
    throw new Error(`unsupported zip kind: ${manifest.kind}`);
  }
  if (manifest.packageVersion !== 1) {
    throw new Error(`unsupported packageVersion: ${manifest.packageVersion}`);
  }

  const results: ImportSession[] = [];
  const entries = manifest.sessions || [];

  for (const entry of entries) {
    const sid = entry.sessionId;
    if (opts.onlyId && sid !== opts.onlyId) continue;
    const rel =
      entry.relativeRolloutPath ||
      entry.fileEntry ||
      (sid ? `files/${sid}/rollout.jsonl` : "");
    if (!rel) continue;

    // Try common path variants inside zip
    const candidates = [
      rel,
      rel.replace(/^\.\//, ""),
      `files/${sid}/rollout.jsonl`,
    ];
    let text: string | null = null;
    let usedPath = rel;
    for (const c of candidates) {
      const found = unzipped[c] || unzipped[c.replace(/\\/g, "/")];
      if (found) {
        text = strFromU8(found);
        usedPath = c;
        break;
      }
    }
    if (!text) {
      // Fallback: any key ending with rollout.jsonl under session id
      for (const key of Object.keys(unzipped)) {
        if (sid && key.includes(sid) && key.endsWith("rollout.jsonl")) {
          text = strFromU8(unzipped[key]);
          usedPath = key;
          break;
        }
      }
    }
    if (!text) continue;

    const tmpHash = createHash("sha256").update(text).digest("hex");
    // Parse from string via temp-like line iteration
    const session = await parseRolloutText(text, {
      skipSubagent: opts.skipSubagent,
      sourcePath: `${zipPath}#${usedPath}`,
      contentHash: tmpHash,
      fallbackCwd: entry.cwd,
      fallbackTitle: entry.title,
      fallbackId: sid,
    });
    if (session) results.push(session);
  }
  return results;
}

async function parseRolloutText(
  text: string,
  opts: {
    skipSubagent: boolean;
    sourcePath: string;
    contentHash: string;
    fallbackCwd?: string;
    fallbackTitle?: string;
    fallbackId?: string;
  },
): Promise<ImportSession | null> {
  // Write-free parse: reuse file parser by streaming lines from string
  const { writeFileSync, unlinkSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join: pathJoin } = await import("node:path");
  const dir = mkdtempSync(pathJoin(tmpdir(), "am-codex-"));
  const file = pathJoin(dir, "rollout.jsonl");
  writeFileSync(file, text, "utf8");
  try {
    const session = await parseRolloutFile(file, {
      skipSubagent: opts.skipSubagent,
    });
    if (!session) return null;
    return {
      ...session,
      sessionId: opts.fallbackId || session.sessionId,
      cwd: session.cwd || opts.fallbackCwd,
      project: deriveProject(session.cwd || opts.fallbackCwd),
      title: opts.fallbackTitle || session.title,
      contentHash: opts.contentHash,
      sourcePath: opts.sourcePath,
    };
  } finally {
    try {
      unlinkSync(file);
    } catch {
      /* ignore */
    }
  }
}
