import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname, platform } from "node:os";
import { dirname, join, resolve } from "node:path";

export type SourceName = "codex" | "cursor";

export interface SourceConfig {
  enabled: boolean;
  roots: string[];
  skipSubagent?: boolean;
}

export interface ImporterConfig {
  machineId: string;
  checkpointDbPath: string;
  agentMemory: {
    baseUrl: string;
    secret: string;
    timeoutMs: number;
  };
  sources: {
    codex: SourceConfig;
    cursor: SourceConfig;
  };
}

const home = homedir();
const isWindows = platform() === "win32";
const appData = process.env.APPDATA || join(home, "AppData", "Roaming");
const localAppData = process.env.LOCALAPPDATA || join(home, "AppData", "Local");

export function expandHome(input: string): string {
  if (!input) return input;
  if (input === "~") return home;
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return join(home, input.slice(2));
  }
  return resolve(input);
}

function unique(paths: string[]): string[] {
  return [...new Set(paths.map(expandHome).filter(Boolean))];
}

export function defaultCodexRoots(): string[] {
  const roots = [
    join(home, ".codex", "sessions"),
    join(home, ".codex", "archived_sessions"),
  ];
  if (isWindows) {
    roots.push(
      join(appData, "Codex", "sessions"),
      join(localAppData, "Codex", "sessions"),
      join(appData, "OpenAI", "Codex", "sessions"),
      join(localAppData, "OpenAI", "Codex", "sessions"),
    );
  }
  return unique(roots);
}

export function defaultCursorRoots(): string[] {
  const roots = [
    join(home, ".cursaves", "snapshots"),
    join(appData, "Cursor", "User", "globalStorage"),
    join(appData, "Cursor", "User", "workspaceStorage"),
  ];
  if (isWindows) {
    roots.push(
      join(localAppData, "Cursor", "User", "globalStorage"),
      join(localAppData, "Cursor", "User", "workspaceStorage"),
    );
  } else if (platform() === "darwin") {
    roots.push(
      join(home, "Library", "Application Support", "Cursor", "User", "globalStorage"),
      join(home, "Library", "Application Support", "Cursor", "User", "workspaceStorage"),
    );
  } else {
    roots.push(
      join(home, ".config", "Cursor", "User", "globalStorage"),
      join(home, ".config", "Cursor", "User", "workspaceStorage"),
    );
  }
  return unique(roots);
}

export function defaultConfigPath(): string {
  return join(home, ".agentmemory", "history-importer", "config.json");
}

export function defaultCheckpointPath(): string {
  return join(home, ".agentmemory", "history-importer", "checkpoint.db");
}

function parseEnvFile(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i === -1) continue;
    env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return env;
}

export function readSharedAgentMemoryEnv(): {
  baseUrl: string;
  secret: string;
  fromFileUrl: string;
  fromProcessUrl: string;
} {
  const envPath = join(home, ".agentmemory", ".env");
  const fromFile = existsSync(envPath)
    ? parseEnvFile(readFileSync(envPath, "utf8"))
    : {};
  const fromFileUrl = fromFile.AGENTMEMORY_URL || "";
  const fromProcessUrl = process.env.AGENTMEMORY_URL || "";
  // Prefer ~/.agentmemory/.env over process.env: Cursor/MCP often injects
  // Tailscale into the shell env and would otherwise ignore the user's LAN edit.
  return {
    baseUrl: fromFileUrl || fromProcessUrl || "",
    secret:
      fromFile.AGENTMEMORY_SECRET ||
      process.env.AGENTMEMORY_SECRET ||
      "",
    fromFileUrl,
    fromProcessUrl,
  };
}

/** True for Tailscale CGNAT (100.64.0.0/10) — often slower when a VPN hijacks it. */
export function looksLikeTailscaleUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    if (!/^100\./.test(host)) return false;
    const second = Number(host.split(".")[1] || "0");
    return second >= 64 && second <= 127;
  } catch {
    return false;
  }
}

export function buildDefaultConfig(
  overrides?: Partial<{
    machineId: string;
    baseUrl: string;
    secret: string;
    checkpointDbPath: string;
  }>,
): ImporterConfig {
  const shared = readSharedAgentMemoryEnv();
  return {
    machineId: overrides?.machineId || hostname(),
    checkpointDbPath: overrides?.checkpointDbPath || defaultCheckpointPath(),
    agentMemory: {
      baseUrl: overrides?.baseUrl || shared.baseUrl || "http://localhost:3111",
      secret: overrides?.secret || shared.secret,
      timeoutMs: 120_000,
    },
    sources: {
      codex: {
        enabled: true,
        roots: defaultCodexRoots(),
        skipSubagent: true,
      },
      cursor: {
        enabled: true,
        roots: defaultCursorRoots(),
      },
    },
  };
}

export function loadConfig(configPath?: string): ImporterConfig {
  const path = expandHome(configPath || defaultConfigPath());
  const defaults = buildDefaultConfig();
  if (!existsSync(path)) return defaults;

  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<ImporterConfig> & {
    sources?: Record<string, Partial<SourceConfig>>;
  };
  const shared = readSharedAgentMemoryEnv();

  const mergeRoots = (configured: string[] | undefined, fallback: string[]) =>
    unique([...(configured || []), ...fallback]);

  // Priority: process.env / ~/.agentmemory/.env  >  config.json  >  defaults
  // (skill bootstrap often writes Tailscale into config.json and would otherwise win)
  return {
    machineId: raw.machineId || defaults.machineId,
    checkpointDbPath: expandHome(
      raw.checkpointDbPath || defaults.checkpointDbPath,
    ),
    agentMemory: {
      baseUrl:
        shared.baseUrl ||
        raw.agentMemory?.baseUrl ||
        defaults.agentMemory.baseUrl,
      secret:
        shared.secret ||
        raw.agentMemory?.secret ||
        defaults.agentMemory.secret,
      timeoutMs:
        raw.agentMemory?.timeoutMs || defaults.agentMemory.timeoutMs,
    },
    sources: {
      codex: {
        enabled: raw.sources?.codex?.enabled ?? true,
        roots: mergeRoots(
          raw.sources?.codex?.roots,
          defaults.sources.codex.roots,
        ),
        skipSubagent: raw.sources?.codex?.skipSubagent ?? true,
      },
      cursor: {
        enabled: raw.sources?.cursor?.enabled ?? true,
        roots: mergeRoots(
          raw.sources?.cursor?.roots,
          defaults.sources.cursor.roots,
        ),
      },
    },
  };
}

export function ensureConfigWritten(configPath?: string): {
  path: string;
  config: ImporterConfig;
} {
  const path = expandHome(configPath || defaultConfigPath());
  if (!existsSync(path)) {
    const config = buildDefaultConfig();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    return { path, config };
  }
  return { path, config: loadConfig(path) };
}

export function sha256Text(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function deriveProject(cwd?: string): string {
  if (!cwd) return "unknown";
  const normalized = cwd.replace(/[\\/]+$/, "");
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || normalized || "unknown";
}

export function amSessionId(source: SourceName, id: string): string {
  return `import-${source}-${id}`;
}
