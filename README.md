<div align="center">
  <img src="./logo/pino.png" alt="Pino proxy" width="250" />

# Pino proxy

[![License](https://img.shields.io/github/license/alxsuv/pino)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2020-43853d?logo=node.js&logoColor=white)](https://nodejs.org)
[![Zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](./package.json)
[![GitHub stars](https://img.shields.io/github/stars/alxsuv/pino?style=social)](https://github.com/alxsuv/pino/stargazers)

[![Saves ~90% on Claude Code API](https://img.shields.io/badge/Claude%20Code%20API-~90%25%20saved-blueviolet?style=for-the-badge&logo=anthropic&logoColor=white)](#savings-math)

</div>


> **Aggressively trim your Claude Code API bill.** Zero runtime dependencies, no build step, no SaaS. A ~500-line local reverse proxy that auto-places prompt-cache breakpoints the way Claude Code *should* be placing them.

A tiny local HTTP reverse proxy in front of `api.anthropic.com`. It forwards everything to upstream untouched **except** `/v1/messages` requests, where it optionally:

- **Auto-injects prompt-cache breakpoints** on the chunks Claude Code leaves uncached — most importantly `tools` (~24k tokens, zero breakpoints out of the box) and the static reminders block in `messages[0]`.
- **Upgrades TTL to 1h** on cacheable content that doesn't change often. Claude Code does set `cache_control: {type: "ephemeral"}` on the system prompt, but **omits the `ttl` field** — which silently falls back to the new 5-minute default, so a thoughtful turn that takes a few minutes to read can blow past the window and re-pay the 1.25× write on the next turn. The proxy rewrites every ephemeral breakpoint to `ttl: "1h"` (except the rolling tail, which stays at 5m on purpose so you don't overpay the 2.0× write multiplier on a breakpoint that moves every turn).
- **Drops unused tools** and scrubs their names from system reminders, shrinking request size.
- **Strips ANSI escape codes** so terminal output in tool results caches cleanly.
- **Makes the system prompt editable** — any part of the request body can be rewritten via a user-supplied `transform(body)` hook. No built-in system-prompt edits ship out of the box; the hook is the extension point.

Designed primarily for **Claude Code**, where the same ~24k-token tool catalog ships uncached on every turn, and the ~8k-token system prompt is on a fragile 5-minute timer — Claude Code's `cache_control` omits `ttl` and silently falls back to the 5-minute default, which a single thoughtful turn (long generation, slow tool call, user reading output) is enough to blow past.

### Proof, from a real session

Two consecutive API requests proxied through pino-proxy. Numbers are raw `usage` fields from the Anthropic API response:

```text
# Turn N                           # Turn N+1
input_tokens:                  6   input_tokens:                  6
cache_read_input_tokens:  83_324   cache_read_input_tokens:  83_910   ← the previous tail, cached
cache_creation:                    cache_creation:
  ephemeral_5m_input_tokens: 586     ephemeral_5m_input_tokens: 252   ← only the moving delta written
  ephemeral_1h_input_tokens:   0     ephemeral_1h_input_tokens:   0
output_tokens:               195   output_tokens:               802
```

Opus pricing for this pair: **~$0.34 with the proxy vs ~$2.60 without** (input + output, computed from the `usage` numbers above) — a 5m rolling tail plus 1h caching on tools / system / reminders does the heavy lifting. See [Savings math](#savings-math) for the full breakdown.

## Quickstart

### 1. Clone and install

```bash
git clone https://github.com/alxsuv/pino
cd pino
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

## How to Verify (The Smoking Gun)

You don't have to take my word for it. You can see what Claude Code actually ships in 60 seconds:

1. **Start the proxy in pass-through mode** (captures logs but doesn't mutate anything yet):
   ```bash
   LOG_BODIES=1 npm start
   ```

2. **Run any command in Claude Code** (e.g., `claude "hi"`).

3. **Inspect the captured request**:
   ```bash
   # 1. Tools: zero cache_control entries. The ~24k-token tool catalog is uncached.
   jq '[.body.tools[] | select(.cache_control)] | length' logs/*.req.json

   # 2. System: cache_control IS set, but ttl is missing → silent 5m default.
   jq '.body.system[]? | select(.cache_control) | {len: (.text|length), cache_control}' logs/*.req.json
   ```

   Expected output: tools count is `0`, and every system `cache_control` is the bare `{"type":"ephemeral"}` with no `ttl` key. That bare form means **5 minutes** — long enough that a thoughtful turn can expire it and force a re-write next turn.

4. **Now, enable the fix**:
   Restart the proxy with `AUTO_CACHE=1`:
   ```bash
   AUTO_CACHE=1 LOG_BODIES=1 npm start
   ```

   Re-run the same `jq` queries against the new `logs/*.req.json` and you'll see breakpoints added to `tools`, every ephemeral rewritten to `ttl: "1h"` (except the rolling tail), and `anthropic-beta` carrying `extended-cache-ttl-2025-04-11`.

5. **Run another command and watch the hits**:
   Your Anthropic API dashboard (or the response `usage` field) will now show `cache_read_input_tokens` capturing ~90% of your input bill.

## How the caching works

The Anthropic API allows up to **4 cache breakpoints** per request. Each breakpoint tells the API "cache everything up to and including this block" so subsequent requests with the same prefix hit the cache at 0.1× base input price instead of 1× base.

This proxy places them as follows (within the 4-slot ceiling):

1. **Last `tools` entry** → 1h TTL. Claude Code ships **zero** breakpoints on `tools`, so the entire ~24k-token catalog is re-billed at full input price every turn. This is the single biggest win.
2. **Last `system` block** → 1h TTL. The Claude Code system prompt is ~8k tokens and stable for hours. Claude Code does set `cache_control` on system blocks, but without `ttl`, so it falls back to the 5m default — long enough that a thoughtful turn can expire the window and force a 1.25× re-write next turn on all ~8k tokens. The proxy rewrites it to 1h (and strips wasteful breakpoints on system blocks <500 chars — Claude Code puts one on a ~57-char block, burning a full slot to cache ~15 tokens).
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

### Per-API-call savings (Claude Sonnet, $3 / $15 per M input/output)

A "turn" below means **one HTTP round trip to `api.anthropic.com`**, not one user message. (One user message expands into many round trips — see [Round-trip multiplier](#round-trip-multiplier-the-bigger-win) below.) Numbers reflect a typical Claude Code request, steady-state mid-session:

| Chunk                             | Tokens  | Without proxy | With proxy (cache hit) | Savings            |
|-----------------------------------|---------|---------------|------------------------|--------------------|
| `tools`                           | 24,400  | $0.0732       | $0.00732               | **$0.0659**        |
| `system`                          | 8,200   | $0.0246       | $0.00246               | **$0.0221**        |
| `messages[0]` reminders           | 5,000   | $0.0150       | $0.00150               | **$0.0135**        |
| Prior-turn history (rolling tail) | ~15,000 | $0.0450       | $0.00450               | **$0.0405**        |
| **Per-call total (input)**        | ~52,600 | **$0.158**    | **$0.0158**            | **~$0.142 (−90%)** |

> **Note on the "Without proxy" column:**
> - `tools` and `messages[0]` reminders are charged at full 1.0× because Claude Code ships **zero breakpoints** on them — they are genuinely uncached, every turn, no asterisk.
> - `system` and the rolling tail *do* get a (TTL-less, 5m default) breakpoint from Claude Code, so within a 5-minute window they would read at 0.1× and the gap would be smaller. The table charges them at 1.0× to represent the worst case where the 5m window expires between turns and forces a re-write — which a single thoughtful turn (long generation, slow tool call, user reading output) is enough to trigger. That's exactly the failure mode this proxy targets; the 1h TTL it writes is much harder to expire by accident.

First turn pays a **cache-write surcharge**: `(24.4k + 8.2k + 5k) × $3 × (2.0 − 1.0) / 1M = $0.113` extra. Breakeven at **turn 2**; every turn after is pure win.

### Round-trip multiplier (the bigger win)

The per-call savings above already look good — but in practice they get multiplied by the number of round trips per user message, and that's the number that makes the bill scary.

The Anthropic API is **stateless**: every HTTP request carries the full conversation context (system + tools + prior messages + prior tool results). Claude Code's loop also makes **one round trip per tool call** — Read, Grep, Edit, Bash, another Read, etc. So a single user prompt like "fix this bug" routinely expands into:

- ~10–20 round trips for a small task
- ~30–50 for a typical debugging or feature-implementation message
- 100+ for a long agentic task or a `/plan`-style multi-phase run

Each of those round trips re-ships the ~24k-token tool catalog at full input price (no breakpoint) and risks the system prompt's TTL-less 5-minute window expiring (1.25× re-write).

**What it costs in real money** at three round-trip volumes (per-call totals from the table above × N, including the one-time cache-write surcharge):

| Volume                              | Pricing tier        | Without proxy | With proxy | Saved        |
|-------------------------------------|---------------------|---------------|------------|--------------|
| 10 trips (small task)               | Sonnet ($3/M input) | ~$1.58        | ~$0.27     | **~$1.31**   |
|                                     | Opus ($15/M input)  | ~$7.90        | ~$1.36     | **~$6.54**   |
| 30 trips (typical user message)     | Sonnet              | ~$4.74        | ~$0.59     | **~$4.15**   |
|                                     | Opus                | ~$23.70       | ~$2.94     | **~$20.76**  |
| 100 trips (heavy session)           | Sonnet              | ~$15.80       | ~$1.69     | **~$14.11**  |
|                                     | Opus                | ~$79.00       | ~$8.46     | **~$70.54**  |

Numbers are input-only; output costs are unchanged (output isn't cached). The cache-write surcharge (~$0.11 Sonnet / ~$0.57 Opus) is paid once per cache window, not once per round trip — so on a session that stays inside the 1h TTL, you pay it once at the start and every subsequent round trip is a pure cache read at 0.1×.

> **Note on billing models.** The dollar figures above apply to **pay-as-you-go API usage** (Claude Code authenticated with an `x-api-key`). If you use Claude Code via a **Pro / Max subscription**, your flat monthly fee obviously doesn't change — but **everything above still matters, because cached tokens count fractionally against your 5-hour rate-limit window**. The same ~10× savings ratio that shows up as cash on the API shows up as session length on a subscription: turns that would have eaten your usage in two hours can now run for six, eight, or longer before you hit the cap. On a heavy debugging day, that's the difference between getting blocked at 3pm and shipping the feature by EOD. The request-shrinking features (`DROP_TOOLS`, `STRIP_ANSI`, `TRIM_BASH_GIT`) compound this further — see [Request-size savings](#request-size-savings-drop_tools--ansi-strip).

**Why caching dominates trimming.** Trimming the tool catalog (e.g., `DROP_TOOLS=…` shaves ~3k tokens) saves you `3k × N round trips` *without* caching. With caching, it only saves you `3k × 1 cache write + 3k × (N−1) cache reads` — roughly an order of magnitude smaller win. Caching is the load-bearing optimization; trimming is a useful add-on once caching is in place.

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
