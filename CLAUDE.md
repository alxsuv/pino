# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A minimal Node.js HTTP reverse proxy in front of `api.anthropic.com`. Zero runtime dependencies, no build step. Clients point `ANTHROPIC_BASE_URL` at the proxy; it forwards everything to upstream, optionally mutating `/v1/messages` requests to improve prompt caching and/or shrink the request body.

## Running

```bash
npm start                                               # pure pass-through on :8787
AUTO_CACHE=1 npm start                               # force 1h TTL + auto-inject breakpoints
TRANSFORM_FILE=./src/transforms/default.js npm start    # load custom body mutator
LOG_BODIES=1 LOG_DIR=./logs npm start                   # dump req/resp to disk

# Typical full dev invocation:
AUTO_CACHE=1 TRANSFORM_FILE=./src/transforms/default.js \
  DROP_TOOLS=NotebookEdit,CronCreate,CronDelete,CronList \
  LOG_BODIES=1 npm start

# Or invoke the bin directly (same thing):
node bin/pino-proxy.js
```

Requires Node >= 20 (ESM, top-level `await`). No tests and no linter yet.

## Layout

```
bin/pino-proxy.js          # shebang entry — imports startServer() and calls it
src/server.js              # createServer() + startServer(); the HTTP request handler lives here
src/config.js              # env parsing (loadConfig), TRANSFORM_FILE loader, constants (UPSTREAM_HOST, BETA_FLAG, ceilings)
src/cache.js               # rewriteCacheControl, injectBreakpointIfAbsent, ensureBetaHeader, countCacheBreakpoints
src/logger.js              # ts/fileTs/log, sanitizeHeaders, writeRequestLog, createResponseLogStream
src/model.js               # rewriteSystemModelRefs — rewrites model ID/name refs in system blocks for MODEL_OVERRIDE
src/transforms/default.js  # env-driven example transform (DROP_TOOLS, STRIP_ANSI, TRIM_BASH_GIT)
```

## Architecture

### src/server.js — the server

Single HTTP server on `127.0.0.1:$PORT` that streams every request to `api.anthropic.com` over HTTPS. Request bodies are buffered (not streamed) so they can be parsed and mutated; responses are streamed straight through (and optionally tee'd to a log file).

Mutation only applies when **all** of these hold: `POST`, path is `/v1/messages` (or `/v1/messages/count_tokens`), `content-type: application/json`, body is non-empty, and at least one of `AUTO_CACHE` / `TRANSFORM_FILE` / `MODEL_OVERRIDE` is set. Otherwise the bytes are forwarded untouched.

Order of operations on the parsed body:
1. `MODEL_OVERRIDE` — replaces `body.model` and rewrites model-name references in `body.system` blocks via `rewriteSystemModelRefs` (from `src/model.js`).
2. `transformFn(body)` from `TRANSFORM_FILE` (user-supplied, can mutate in place or return a new object).
3. `injectBreakpointIfAbsent` — places up to four `cache_control: { type: "ephemeral" }` markers within the **4-breakpoint API ceiling** (`BREAKPOINT_CEILING`):
   1. **Strip small system breakpoints** — removes client-sent `cache_control` from any `system` block shorter than `MIN_SYSTEM_CACHE_CHARS` (500). Caching <125 tokens isn't worth burning a slot; Claude Code sends a wasteful breakpoint on a tiny system entry that this pass reclaims.
   2. **Tools** — last entry in `body.tools` → 1h TTL.
   3. **System** — last entry in `body.system` → 1h TTL (skipped if any system block already has a breakpoint).
   4. **`messages[0]` reminders** — last cacheable block in the first message → 1h TTL. Only placed when `messages.length > 1` (otherwise the rolling tail covers it). Caches the static `<system-reminder>` / CLAUDE.md / skills-catalog blocks that Claude Code stuffs into msg[0].
   5. **Rolling tail** — last `text`/`tool_result`/`image` block across messages → default (5m) TTL. Moves every turn. String-form `content` is normalized to an array so string messages are cacheable.
4. `rewriteCacheControl` — recursively bumps every existing `ephemeral` cache_control to `ttl: "1h"`.
5. `ensureBetaHeader` — appends `extended-cache-ttl-2025-04-11` to `anthropic-beta` (required for 1h TTL).

Key invariant: the tail breakpoint uses `TAIL_TTL` (default `5m`, optionally `1h`) because it moves every turn. `injectBreakpointIfAbsent` returns the set of tail blocks it placed; `rewriteCacheControl` is passed that set as `skip` so the tail's TTL is preserved while every other ephemeral breakpoint is still bumped to 1h.

`LOG_BODIES=1` writes `<reqId>.req.json` (post-mutation, with auth headers redacted) and `<reqId>.resp.log` (raw upstream bytes with a header preamble) per request into `LOG_DIR`.

### src/transforms/default.js — the example body mutator

Exports `transform(body)`. Environment-driven:
- `DROP_TOOLS=Name1,Name2` — remove tools from `body.tools` **and** scrub their names out of any `<system-reminder>` block that advertises deferred tools / ToolSearch. Both must be done together or the reminder will reference tools the model can't call.
- `STRIP_ANSI=0` to disable (default on) — strips ANSI escapes from message content and tool results so they cache cleanly.
- `TRIM_BASH_GIT=1` — truncates the Bash tool description at the `# Committing changes with git` section.
- `TOOL_OVERRIDES` — per-tool-name hook for ad-hoc description edits.

When adding new mutations, inspect `logs/*.req.json` first to see the actual shape of `body.tools` / `body.system` / `body.messages` for the client you're proxying.

## Gotchas

- `loadTransform()` in `src/config.js` uses `await import(...)` — the server won't start if the transform module fails to load. `TRANSFORM_FILE` resolves relative to `process.cwd()`.
- The proxy binds to `127.0.0.1` only — not reachable from other hosts by design.
- Headers are copied verbatim except `host` and `content-length`; that includes `x-api-key` and `authorization` going to upstream (redacted only in logs).
- `countCacheBreakpoints` is called before injection to enforce the 4-cap, but the function counts *existing* breakpoints on the body — if a transform adds breakpoints, they count toward the cap.
