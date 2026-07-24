import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  readdirSync,
  statSync,
} from "node:fs";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import type { DiscoverItem, ImportObservation, ImportSession } from "../ir.js";
import { deriveProject, sha256File } from "../config.js";

const MAX_TEXT = 20_000;
const MAX_TOOL_OUTPUT = 8_000;

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function toText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    if (entry.type === "text" && typeof entry.text === "string") {
      parts.push(entry.text);
    }
  }
  return parts.join("\n");
}

function extractToolUses(
  content: unknown,
): Array<{ id: string; name: string; input: unknown }> {
  if (!Array.isArray(content)) return [];
  const out: Array<{ id: string; name: string; input: unknown }> = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    if (entry.type === "tool_use") {
      out.push({
        id: typeof entry.id === "string" ? entry.id : "",
        name: typeof entry.name === "string" ? entry.name : "unknown",
        input: entry.input,
      });
    }
  }
  return out;
}

function extractToolResults(
  content: unknown,
): Array<{ toolUseId: string; output: unknown; isError: boolean }> {
  if (!Array.isArray(content)) return [];
  const out: Array<{ toolUseId: string; output: unknown; isError: boolean }> =
    [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    if (entry.type === "tool_result") {
      out.push({
        toolUseId:
          typeof entry.tool_use_id === "string" ? entry.tool_use_id : "",
        output: entry.content,
        isError: entry.is_error === true,
      });
    }
  }
  return out;
}

function walkJsonlFiles(root: string, out: string[] = []): string[] {
  if (!existsSync(root)) return out;
  let st;
  try {
    st = statSync(root);
  } catch {
    return out;
  }
  if (st.isFile()) {
    if (root.endsWith(".jsonl")) out.push(root);
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
    if (entry.isDirectory()) walkJsonlFiles(full, out);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(full);
  }
  return out;
}

function sessionIdFromPath(path: string): string | null {
  const base = basename(path, ".jsonl");
  if (/^[0-9a-f-]{36}$/i.test(base)) return base;
  return null;
}

function toDiscoverItem(session: ImportSession): DiscoverItem {
  return {
    source: session.source,
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

async function parseClaudeJsonl(path: string): Promise<ImportSession | null> {
  const contentHash = sha256File(path);
  const st = statSync(path);
  const fallbackId = sessionIdFromPath(path) || createHash("sha1").update(path).digest("hex").slice(0, 36);

  let sessionId = "";
  let cwd = "";
  let startedAt = "";
  let endedAt = "";
  let title = "";
  const observations: ImportObservation[] = [];

  const rl = createInterface({
    input: createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (typeof entry.sessionId === "string" && entry.sessionId) {
      sessionId = entry.sessionId;
    }
    if (typeof entry.cwd === "string" && entry.cwd.trim()) {
      cwd = entry.cwd.trim();
    }

    const ts =
      typeof entry.timestamp === "string"
        ? entry.timestamp
        : new Date(st.mtimeMs).toISOString();
    if (!startedAt) startedAt = ts;
    endedAt = ts;

    const message = entry.message as Record<string, unknown> | undefined;
    const role = message?.role;
    const content = message?.content;
    const type = entry.type;

    if (type === "user" && role === "user") {
      const toolResults = extractToolResults(content);
      if (toolResults.length > 0) {
        for (const result of toolResults) {
          const output =
            typeof result.output === "string"
              ? truncate(result.output, MAX_TOOL_OUTPUT)
              : truncate(JSON.stringify(result.output ?? ""), MAX_TOOL_OUTPUT);
          observations.push({
            timestamp: ts,
            type: result.isError ? "other" : "tool",
            toolName: result.toolUseId || "tool_result",
            toolInput: { toolUseId: result.toolUseId },
            toolOutput: output,
          });
        }
      } else {
        const text = truncate(toText(content), MAX_TEXT);
        if (text.trim()) {
          if (!title) title = truncate(text.replace(/\s+/g, " ").trim(), 80);
          observations.push({
            timestamp: ts,
            type: "conversation",
            userPrompt: text,
          });
        }
      }
    } else if (type === "assistant" && role === "assistant") {
      const text = truncate(toText(content), MAX_TEXT);
      if (text.trim()) {
        observations.push({
          timestamp: ts,
          type: "conversation",
          assistantResponse: text,
        });
      }
      for (const tool of extractToolUses(content)) {
        observations.push({
          timestamp: ts,
          type: "tool",
          toolName: tool.name,
          toolInput: tool.input,
        });
      }
    }
  }

  const effectiveId = sessionId || fallbackId;
  if (observations.length === 0) return null;

  const project = deriveProject(cwd);
  if (!title) title = project;

  return {
    source: "claude",
    sessionId: effectiveId,
    project,
    cwd: cwd || undefined,
    title,
    startedAt: startedAt || new Date(st.mtimeMs).toISOString(),
    endedAt: endedAt || new Date(st.mtimeMs).toISOString(),
    contentHash,
    observations,
    sourcePath: path,
  };
}

function collectRoots(roots: string[], inputPath?: string): string[] {
  if (inputPath) return [inputPath];
  return roots;
}

export async function loadAllClaudeSessions(
  roots: string[],
  opts: { inputPath?: string; limit?: number } = {},
): Promise<ImportSession[]> {
  const sessions: ImportSession[] = [];
  const scanRoots = collectRoots(roots, opts.inputPath);

  const files: string[] = [];
  for (const root of scanRoots) {
    walkJsonlFiles(root, files);
  }

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
      const session = await parseClaudeJsonl(file);
      if (session) sessions.push(session);
    } catch (err) {
      console.warn(
        `skip claude file ${file}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  sessions.sort((a, b) => (a.endedAt < b.endedAt ? 1 : -1));
  if (opts.limit && opts.limit > 0) return sessions.slice(0, opts.limit);
  return sessions;
}

export async function discoverClaude(
  roots: string[],
  opts: { inputPath?: string; limit?: number } = {},
): Promise<DiscoverItem[]> {
  const sessions = await loadAllClaudeSessions(roots, opts);
  return sessions.map(toDiscoverItem);
}
