<div align="center">
  <img src="./logo/pino.png" alt="Pino proxy" width="250" />

# Pino proxy

[![License](https://img.shields.io/github/license/alxsuv/pino-proxy)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2020-43853d?logo=node.js&logoColor=white)](https://nodejs.org)
[![Zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](./package.json)
[![GitHub stars](https://img.shields.io/github/stars/alxsuv/pino-proxy?style=social)](https://github.com/alxsuv/pino-proxy/stargazers)

[![Saves ~90% on Claude Code API](https://img.shields.io/badge/Claude%20Code%20API-~90%25%20saved-blueviolet?style=for-the-badge&logo=anthropic&logoColor=white)](#savings-math)

</div>


> **Aggressively trim your Claude Code API bill.** Zero runtime dependencies, no build step, no SaaS. A ~500-line local reverse proxy that auto-places prompt-cache breakpoints the way Claude Code *should* be placing them.

A tiny local HTTP reverse proxy in front of `api.anthropic.com`. It forwards everything to upstream untouched **except** `/v1/messages` requests, where it optionally:

- **Auto-injects prompt-cache breakpoints** so large-but-static chunks (tools, system prompt, reminders, prior turns) get cached.
- **Upgrades TTL to 1h** on cacheable content that doesn't change often — while keeping the rolling tail at 5m so you don't overpay the 2.0× write multiplier on a breakpoint that moves every turn.
- **Drops unused tools** and scrubs their names from system reminders, shrinking request size.
- **Strips ANSI escape codes** so terminal output in tool results caches cleanly.
- **Makes the system prompt editable** — any part of the request body can be rewritten via a user-supplied `transform(body)` hook. No built-in system-prompt edits ship out of the box; the hook is the extension point.

Designed primarily for **Claude Code**, where the same ~8k-token system prompt and ~24k-token tool catalog ship on every turn.

### Proof, from a real session

Two consecutive turns proxied through pino-proxy. Numbers are raw `usage` fields from the Anthropic API response:

```text
# Turn N                           # Turn N+1
input_tokens:                  6   input_tokens:                  6
cache_read_input_tokens:  83_324   cache_read_input_tokens:  83_910   ← the previous tail, cached
cache_creation:                    cache_creation:
  ephemeral_5m_input_tokens: 586     ephemeral_5m_input_tokens: 252   ← only the moving delta written
  ephemeral_1h_input_tokens:   0     ephemeral_1h_input_tokens:   0
output_tokens:               195   output_tokens:               802
```

Opus pricing for this pair: **~$0.14 with the proxy vs ~$1.26 without** — a 5m rolling tail plus 1h caching on tools / system / reminders does the heavy lifting. See [Savings math](#savings-math) for the full breakdown.

## Quickstart

### 1. Clone and install

```bash
git clone https://github.com/alxsuv/pino-proxy
cd pino-proxy
```

No `npm install` needed — zero runtime dependencies. Requires Node >= 20.

### 2. Start the proxy

**Linux / macOS (bash/zsh):**

```bash
# pure pass-through on :8787
npm start

# typical dev setup: auto-cache + transforms + logs
AUTO_CACHE=1 \
TRANSFORM_FILE=./src/transforms/default.js \
DROP_TOOLS=NotebookEdit,CronCreate,CronDelete,CronList,RemoteTrigger,PushNotification,Monitor \
LOG_BODIES=1 \
npm start

# or invoke the bin directly
node bin/pino-proxy.js
```

**Windows (PowerShell):**

```powershell
# pure pass-through on :8787
npm start

# typical dev setup: auto-cache + transforms + logs
$env:AUTO_CACHE=1
$env:TRANSFORM_FILE="./src/transforms/default.js"
$env:DROP_TOOLS="NotebookEdit,CronCreate,CronDelete,CronList"
$env:LOG_BODIES=1
npm start

# or invoke the bin directly
node bin/pino-proxy.js
```

**Windows (cmd.exe):**

```cmd
:: pure pass-through on :8787
npm start

:: typical dev setup: auto-cache + transforms + logs
set AUTO_CACHE=1
set TRANSFORM_FILE=./src/transforms/default.js
set DROP_TOOLS=NotebookEdit,CronCreate,CronDelete,CronList
set LOG_BODIES=1
npm start
```

### 3. Point your client at it

**Linux / macOS:**

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8787
```

**Windows (PowerShell):**

```powershell
$env:ANTHROPIC_BASE_URL="http://127.0.0.1:8787"
```

**Windows (cmd.exe):**

```cmd
set ANTHROPIC_BASE_URL=http://127.0.0.1:8787
```

## How the caching works

The Anthropic API allows up to **4 cache breakpoints** per request. Each breakpoint tells the API "cache everything up to and including this block" so subsequent requests with the same prefix hit the cache at 0.1× base input price instead of 1× base.

This proxy places them as follows (within the 4-slot ceiling):

1. **Last `tools` entry** → 1h TTL. Tool catalog rarely changes; caching it saves ~24k tokens/turn.
2. **Last `system` block** → 1h TTL. The ~8k-token Claude Code system prompt is stable for hours.
3. **Last cacheable block of `messages[0]`** → 1h TTL. Claude Code stuffs static reminders (CLAUDE.md, skills catalog, deferred-tools list — ~5k tokens) into the first user message. Cached once per session.
4. **Rolling tail** → 5m TTL by default (configurable via `TAIL_TTL=1h`). The last `text`/`tool_result`/`image` block across all messages. Moves each turn so every new turn reads the prior turn's prefix from cache and only pays base price for the delta. 5m is the right default because the tail rarely survives an hour of reuse; paying the 2.0× write multiplier for a breakpoint that moves constantly is wasteful.

Before injecting, the proxy also **strips client-sent breakpoints on system blocks smaller than 500 chars** — caching ~125 tokens burns a full slot that's better spent on `messages[0]` reminders.

## Savings math

Anthropic pricing multipliers (all relative to base input):

| Operation             | Multiplier |
|-----------------------|------------|
| Base input (uncached) | 1.0×       |
| Cache write, 5m TTL   | 1.25×      |
| Cache write, 1h TTL   | 2.0×       |
| Cache read (hit)      | 0.1×       |

### Per-turn savings (Claude Sonnet, $3 / $15 per M input/output)

Typical Claude Code request, steady-state mid-session:

| Chunk                             | Tokens  | Without proxy | With proxy (cache hit) | Savings            |
|-----------------------------------|---------|---------------|------------------------|--------------------|
| `tools`                           | 24,400  | $0.0732       | $0.00732               | **$0.0659**        |
| `system`                          | 8,200   | $0.0246       | $0.00246               | **$0.0221**        |
| `messages[0]` reminders           | 5,000   | $0.0150       | $0.00150               | **$0.0135**        |
| Prior-turn history (rolling tail) | ~15,000 | $0.0450       | $0.00450               | **$0.0405**        |
| **Per-turn total (input)**        | ~52,600 | **$0.158**    | **$0.0158**            | **~$0.142 (−90%)** |

First turn pays a **cache-write surcharge**: `(24.4k + 8.2k + 5k) × $3 × (2.0 − 1.0) / 1M = $0.113` extra. Breakeven at **turn 2**; every turn after is pure win.

### Session-scale savings

A typical Claude Code debugging session = 30–50 turns. Using 40 turns as a baseline:

| Pricing tier        | Without proxy | With proxy | Saved per session |
|---------------------|---------------|------------|-------------------|
| Sonnet ($3/M input) | ~$6.31        | ~$0.74     | **~$5.57**        |
| Opus ($15/M input)  | ~$31.56       | ~$3.72     | **~$27.84**       |

Numbers are input-only; output costs are unchanged (output isn't cached). Exact savings depend on how much context churns — long running sessions benefit most.

### Request-size savings (`DROP_TOOLS` + ANSI strip)

Independent of caching, body mutations reduce wire size:

- `DROP_TOOLS=NotebookEdit,CronCreate,CronDelete,CronList,RemoteTrigger,PushNotification,Monitor` → **~3,300 tokens** dropped per turn.
- `STRIP_ANSI=1` → strips SGR escapes from `/context` output, terminal colors, etc. Roughly halves `tool_result` size on affected turns (~500–2,000 tokens).
- `TRIM_BASH_GIT=1` → drops git-commit + PR-creation subsections of the Bash tool description. ~1,800 tokens saved if you don't use git through Claude Code.

### Claude Code tool drop reference

Claude Code ships with a sizeable tool catalog. Not every session uses every tool, and each one you drop shaves ~100–800 tokens off the tool schema on every turn. Below is a practical cheat-sheet of what each tool does and whether it's usually safe to drop.

Legend: 🟢 safe to drop if unused · 🟡 drop with caveats (feature goes away) · 🔴 don't drop (Claude Code breaks without it)

| Tool                                                 | What it does                                                     | Drop?                                                                               |
|------------------------------------------------------|------------------------------------------------------------------|-------------------------------------------------------------------------------------|
| `Bash`                                               | Run shell commands.                                              | 🔴 Keep. Core to almost everything.                                                 |
| `Read`                                               | Read local files (text, images, PDFs, notebooks).                | 🔴 Keep.                                                                            |
| `Edit`                                               | Exact-string edits in an existing file.                          | 🔴 Keep.                                                                            |
| `Write`                                              | Create or overwrite files.                                       | 🔴 Keep.                                                                            |
| `Glob`                                               | Find files by pattern.                                           | 🔴 Keep. Much cheaper than `find` via Bash.                                         |
| `Grep`                                               | Search file contents (ripgrep wrapper).                          | 🔴 Keep. Much cheaper than `grep -r` via Bash.                                      |
| `TaskCreate` / `TaskUpdate` / `TaskList` / `TaskGet` | Track multi-step work in a persistent task list.                 | 🟡 Drop if you never want task tracking — Claude will also stop planning via todos. |
| `TaskOutput` / `TaskStop`                            | Inspect/kill background `run_in_background` tasks.               | 🟡 Drop only if you also never run long background commands.                        |
| `AskUserQuestion`                                    | Structured multiple-choice questions with previews.              | 🟡 Drop to force free-text clarification instead.                                   |
| `EnterPlanMode` / `ExitPlanMode`                     | Plan-mode workflow (design before implementing).                 | 🟡 Drop if you never use `/plan`. Claude will plan in prose.                        |
| `EnterWorktree` / `ExitWorktree`                     | Create/exit git worktrees for isolated work.                     | 🟢 Drop unless you actively use worktrees.                                          |
| `NotebookEdit`                                       | Edit Jupyter `.ipynb` cells.                                     | 🟢 Drop unless you work with notebooks.                                             |
| `WebFetch`                                           | Fetch a URL and summarize its content.                           | 🟡 Drop if you never need web lookups — breaks doc-fetching.                        |
| `WebSearch`                                          | Search the web (US-only).                                        | 🟡 Drop if you don't need live web info.                                            |
| `CronCreate` / `CronDelete` / `CronList`             | Schedule prompts on cron; session-only by default.               | 🟢 Drop unless you use in-session scheduling.                                       |
| `Monitor`                                            | Background event-stream watcher (tail logs, poll APIs).          | 🟢 Drop unless you need live monitoring.                                            |
| `PushNotification`                                   | Push desktop/mobile notifications via Remote Control.            | 🟢 Drop. Rarely needed.                                                             |
| `RemoteTrigger`                                      | Call the claude.ai remote-trigger API (routines/schedules).      | 🟢 Drop unless you manage scheduled remote agents.                                  |
| `Skill`                                              | Invoke a named skill (`/skills`).                                | 🟡 Drop only if you never use skills or slash-commands.                             |
| `mcp__ide__getDiagnostics`                           | Pull IDE diagnostics (only appears with IDE extension attached). | 🟢 Drop if you don't use the IDE extension.                                         |

A conservative starter set: `DROP_TOOLS=NotebookEdit,CronCreate,CronDelete,CronList,RemoteTrigger,PushNotification,Monitor,EnterWorktree,ExitWorktree`.

Check `logs/*.req.json` after a turn to see which tools your client actually ships — the catalog varies by Claude Code version and which MCP servers you have loaded.

## Environment variables

| Var              | Default  | What it does                                                                                                      |
|------------------|----------|-------------------------------------------------------------------------------------------------------------------|
| `PORT`           | `8787`   | Local port to bind (always `127.0.0.1`).                                                                          |
| `AUTO_CACHE`     | off      | Enable cache breakpoint injection + 1h TTL rewrite + beta header.                                                 |
| `TAIL_TTL`       | `5m`     | TTL for the rolling-tail breakpoint. `5m` (recommended) or `1h`. Other slots are always 1h.                       |
| `TRANSFORM_FILE` | —        | Path to a JS module exporting `transform(body)` for custom body edits.                                            |
| `DROP_TOOLS`     | —        | Comma-separated tool names to remove from `body.tools` *(requires `TRANSFORM_FILE=./src/transforms/default.js`)*. |
| `STRIP_ANSI`     | `1`      | Strip ANSI escapes from message text + tool results. Set to `0` to disable.                                       |
| `TRIM_BASH_GIT`  | `0`      | Truncate the Bash tool description at its "Committing changes" section.                                           |
| `LOG_BODIES`     | off      | Dump post-mutation request JSON + raw response bytes to `LOG_DIR`.                                                |
| `LOG_DIR`        | `./logs` | Where to write body dumps.                                                                                        |

## Architecture in 30 seconds

```
bin/pino-proxy.js          # CLI entry (shebang)
src/server.js              # HTTP server + request handler, exports startServer()
src/config.js              # env parsing, constants, transform loader
src/cache.js               # breakpoint inject/rewrite, beta header
src/logger.js              # timestamps, sanitizers, request/response log writers
src/transforms/default.js  # example body mutator (env-driven)
```

- `src/server.js` — HTTP server on `127.0.0.1:$PORT`. Buffers request bodies, parses JSON on matching paths, runs transform → inject → rewrite → beta-header pipeline, streams responses through.
- `src/transforms/default.js` — Example body mutator. Env-driven. Handles tool drops, ANSI stripping, per-tool description rewrites.
- Logging: `LOG_BODIES=1` writes `<reqId>.req.json` (post-mutation, auth redacted) + `<reqId>.resp.log` (raw response) per request.

See [CLAUDE.md](./CLAUDE.md) for full internals, order of operations, gotchas, and pointers for extending the transform pipeline.

## Caveats

- The proxy binds to `127.0.0.1` only — not reachable from other hosts.
- Header passthrough is verbatim: `x-api-key` / `authorization` go upstream as-is (redacted only in logs).
- Savings math is illustrative — actual numbers depend on your usage patterns, model choice, and how stable your context is across turns.
