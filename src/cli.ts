import {
  defaultConfigPath,
  ensureConfigWritten,
  loadConfig,
  looksLikeTailscaleUrl,
  readSharedAgentMemoryEnv,
  type SourceName,
} from "./config.js";
import { runDiscover, runStatus, runSync } from "./sync.js";

interface CliArgs {
  mode: "discover" | "sync" | "status";
  configPath: string;
  source: string;
  limit: number;
  inputPath: string;
  dryRun: boolean;
  concurrency: number;
  timeoutMs: number;
  help: boolean;
}

function warnUrlSource(baseUrl: string): void {
  const shared = readSharedAgentMemoryEnv();
  if (shared.usingLocal) {
    console.log(`agentmemory: ${baseUrl} (AGENTMEMORY_URL_LOCAL / LAN)`);
    if (shared.primaryUrl) {
      console.log(`hooks/MCP stay on: ${shared.primaryUrl}`);
    }
  } else {
    console.log(`agentmemory: ${baseUrl}`);
  }
  if (looksLikeTailscaleUrl(baseUrl)) {
    console.warn(
      "warning: import URL is Tailscale (100.x). For faster bulk sync set AGENTMEMORY_URL_LOCAL=http://192.168.0.102:3111 in ~/.agentmemory/.env (keeps AGENTMEMORY_URL for daily use).",
    );
  }
  if (
    shared.fromFileUrl &&
    shared.fromProcessUrl &&
    shared.fromFileUrl !== shared.fromProcessUrl &&
    !shared.usingLocal
  ) {
    console.warn(
      `note: shell AGENTMEMORY_URL=${shared.fromProcessUrl}; file has ${shared.fromFileUrl}`,
    );
  }
}

function printHelp(): void {
  console.log(`am-history-importer — import Codex/Cursor history into Agent Memory

Usage:
  am-history-importer discover [--config PATH] [--source codex,cursor] [--limit N] [--input PATH]
  am-history-importer sync     [--config PATH] [--source codex,cursor] [--limit N] [--input PATH]
                               [--concurrency N] [--dry-run]
  am-history-importer status   [--config PATH]

Options:
  --config PATH        Config JSON (default: ~/.agentmemory/history-importer/config.json)
  --source LIST        Comma-separated: codex,cursor
  --limit N            Max sessions to process
  --input PATH         Zip / rollout dir / cursaves snapshot / state.vscdb
  --concurrency N      Parallel sessions while writing (default: 8)
  --timeout-ms N       Per-request HTTP timeout (default: 180000)
  --dry-run            Parse and checkpoint-check without writing to Agent Memory

Env:
  AGENTMEMORY_URL         Daily hooks/MCP (e.g. Tailscale)
  AGENTMEMORY_URL_LOCAL   Optional LAN URL used only by this importer
  AGENTMEMORY_SECRET      Bearer secret (or ~/.agentmemory/.env)

Speed tip (LAN):
  Keep AGENTMEMORY_URL on Tailscale for daily hooks/MCP.
  Set AGENTMEMORY_URL_LOCAL=http://192.168.0.102:3111 for this importer only.
  This tool speaks HTTP REST to Agent Memory — not SSH.
`);
}

function parseArgs(argv: string[]): CliArgs {
  const mode = (argv[0] || "sync") as CliArgs["mode"];
  const result: CliArgs = {
    mode: ["discover", "sync", "status"].includes(mode) ? mode : "sync",
    configPath: "",
    source: "",
    limit: 0,
    inputPath: "",
    dryRun: false,
    concurrency: 8,
    timeoutMs: 0,
    help: false,
  };

  const start = ["discover", "sync", "status"].includes(argv[0] || "") ? 1 : 0;
  for (let i = start; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") result.help = true;
    else if (arg === "--dry-run") result.dryRun = true;
    else if (arg === "--config") result.configPath = argv[++i] || "";
    else if (arg?.startsWith("--config=")) result.configPath = arg.slice(9);
    else if (arg === "--source") result.source = argv[++i] || "";
    else if (arg?.startsWith("--source=")) result.source = arg.slice(9);
    else if (arg === "--limit") result.limit = Number.parseInt(argv[++i] || "0", 10) || 0;
    else if (arg?.startsWith("--limit=")) {
      result.limit = Number.parseInt(arg.slice(8), 10) || 0;
    } else if (arg === "--concurrency") {
      result.concurrency = Number.parseInt(argv[++i] || "8", 10) || 8;
    } else if (arg?.startsWith("--concurrency=")) {
      result.concurrency = Number.parseInt(arg.slice(14), 10) || 8;
    } else if (arg === "--timeout-ms") {
      result.timeoutMs = Number.parseInt(argv[++i] || "0", 10) || 0;
    } else if (arg?.startsWith("--timeout-ms=")) {
      result.timeoutMs = Number.parseInt(arg.slice(13), 10) || 0;
    } else if (arg === "--input") result.inputPath = argv[++i] || "";
    else if (arg?.startsWith("--input=")) result.inputPath = arg.slice(8);
    else if (!arg.startsWith("-") && !result.inputPath) result.inputPath = arg;
  }

  if (!["discover", "sync", "status"].includes(argv[0] || "") && argv[0]) {
    result.mode = "sync";
  }

  return result;
}

function parseSources(raw: string): SourceName[] | undefined {
  if (!raw.trim()) return undefined;
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (s === "claude-code" || s === "claude" ? "codex" : s));
  const out: SourceName[] = [];
  for (const p of parts) {
    if (p === "codex" || p === "cursor") out.push(p);
    else if (p === "all") return undefined;
    else console.warn(`ignoring unknown source: ${p}`);
  }
  return out.length ? out : undefined;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const { path: configPath } = ensureConfigWritten(
    args.configPath || defaultConfigPath(),
  );
  const config = loadConfig(configPath);
  if (args.timeoutMs > 0) {
    config.agentMemory.timeoutMs = args.timeoutMs;
  }
  const sources = parseSources(args.source);
  const runOpts = {
    sources,
    limit: args.limit,
    inputPath: args.inputPath || undefined,
    dryRun: args.dryRun,
    concurrency: args.concurrency,
  };

  if (args.mode === "status") {
    const status = runStatus(config);
    console.log(JSON.stringify(status, null, 2));
    return;
  }

  if (args.mode === "discover") {
    console.log(`config: ${configPath}`);
    warnUrlSource(config.agentMemory.baseUrl);
    const items = await runDiscover(config, runOpts);
    console.log(`discovered: ${items.length}`);
    for (const item of items.slice(0, 50)) {
      console.log(
        `- ${item.source}:${item.sessionId} obs=${item.observationCount} project=${item.project || "-"} title=${JSON.stringify((item.title || "").slice(0, 50))}${item.skippedReason ? ` skip=${item.skippedReason}` : ""}`,
      );
    }
    if (items.length > 50) console.log(`… and ${items.length - 50} more`);
    return;
  }

  // sync
  console.log(`config: ${configPath}`);
  warnUrlSource(config.agentMemory.baseUrl);
  console.log(`checkpoint: ${config.checkpointDbPath}`);
  const stats = await runSync(config, runOpts);
  console.log(JSON.stringify(stats, null, 2));
  if (stats.failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
