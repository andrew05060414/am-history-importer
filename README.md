# am-history-importer

One-shot import of **Codex** and **Cursor** chat history into a remote [Agent Memory](https://github.com/rohitg00/agentmemory) daemon. Idempotent via a local SQLite checkpoint — re-running the same data skips already-synced sessions.

Claude Code is out of scope here (use official `import-jsonl`).

## Install

```bash
pnpm install
pnpm build
```

Requires Node.js 22+.

## Configure

Uses `~/.agentmemory/.env` when present (**this file wins** over shell/`config.json`, because Cursor/MCP often inject Tailscale into `AGENTMEMORY_URL`):

```
AGENTMEMORY_URL=http://192.168.0.102:3111
AGENTMEMORY_SECRET=...
```

First run writes `~/.agentmemory/history-importer/config.json` (see `am-history-importer.config.example.json`).

## Usage

```bash
# List sessions found on this machine
node dist/cli.js discover

# Import everything (Codex + Cursor), skip already-synced
node dist/cli.js sync

# Codex only, first 20
node dist/cli.js sync --source codex --limit 20

# Cursor snapshots / DB
node dist/cli.js sync --source cursor --limit 5

# Explicit inputs
node dist/cli.js sync --input path/to/codex-session-export.zip
node dist/cli.js sync --input ~/.cursaves/snapshots
node dist/cli.js sync --input ~/AppData/Roaming/Cursor/User/globalStorage/state.vscdb

# Checkpoint status
node dist/cli.js status
```

Second run on the same data should look like: `discovered=N, synced=0, skipped=N`.

## How it writes

For each session:

1. `POST /agentmemory/session/start`
2. Many `POST /agentmemory/observe` (`prompt_submit` for user; assistant/tools as `post_tool_use`)
3. `POST /agentmemory/session/end`

Session IDs in Agent Memory are namespaced: `import-codex-<uuid>`, `import-cursor-<composerId>`.

## Speed

Bottleneck is usually **HTTP to Agent Memory**, not CPU. Prefer LAN:

```bash
# ~/.agentmemory/.env — at home use LAN, away use Tailscale
AGENTMEMORY_URL=http://192.168.0.102:3111
```

Parallel session writers (default 8):

```bash
node dist/cli.js sync --concurrency 8
node dist/cli.js sync --concurrency 16   # if NAS still comfortable
```

This talks **HTTP REST**, not SSH. Plain `http://` is already unencrypted; SSH would add encryption overhead, not remove it.
