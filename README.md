# am-history-importer

One-shot import of **Codex** and **Cursor** chat history into a remote [Agent Memory](https://github.com/rohitg00/agentmemory) daemon. Idempotent via a local SQLite checkpoint — re-running the same data skips already-synced sessions.

Claude Code is out of scope here (use official `import-jsonl`).

**用户手册（中文）：** [docs/使用手册.md](docs/使用手册.md)

## Install

```bash
pnpm install
pnpm build
```

Requires Node.js 22+.

## Configure

Uses `~/.agentmemory/.env`:

```
# Daily hooks / MCP — Tailscale
AGENTMEMORY_URL=http://100.73.230.28:3111

# Bulk import only — LAN (this importer prefers LOCAL when set)
AGENTMEMORY_URL_LOCAL=http://192.168.0.102:3111

AGENTMEMORY_SECRET=...
```

First run writes `~/.agentmemory/history-importer/config.json` (see `am-history-importer.config.example.json`).

## Quick start

```bash
node dist/cli.js discover --limit 20
node dist/cli.js sync --source codex --limit 5 --concurrency 4
node dist/cli.js sync --concurrency 4
node dist/cli.js status
```

Second run on the same data should look like: `discovered=N, synced=0, skipped=N`.

See the [中文使用手册](docs/使用手册.md) for full flags, FAQ, and Windows/Mac notes.

## How it writes

For each session:

1. `POST /agentmemory/session/start`
2. Many `POST /agentmemory/observe` (`prompt_submit` for user; assistant/tools as `post_tool_use`)
3. `POST /agentmemory/session/end`

Session IDs in Agent Memory are namespaced: `import-codex-<uuid>`, `import-cursor-<composerId>`.

## Speed

Bottleneck is usually **HTTP to Agent Memory** (one request per observation), not CPU.

- Keep `AGENTMEMORY_URL` on Tailscale for daily hooks.
- Set `AGENTMEMORY_URL_LOCAL` to LAN for this importer only.
- Default per-request timeout is **0 = wait until done**. Optional hard cap: `--timeout-ms 180000`.
- Failed HTTP calls retry up to 3 times (including 502/503/504).
- Prefer `--concurrency 2`–`4` if the NAS returns many 504s.

Plain `http://` is already unencrypted; SSH is not used.
