import { BETA_FLAG, BREAKPOINT_CEILING, MIN_SYSTEM_CACHE_CHARS } from "./config.js";

export function rewriteCacheControl(node, counter, skip) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) rewriteCacheControl(item, counter, skip);
    return;
  }
  if (node.cache_control && node.cache_control.type === "ephemeral") {
    if (skip && skip.has(node)) {
      counter.skipped += 1;
    } else {
      const before = node.cache_control.ttl;
      if (before !== "1h") {
        node.cache_control.ttl = "1h";
        counter.rewritten += 1;
      } else {
        counter.alreadySet += 1;
      }
    }
  }
  for (const key of Object.keys(node)) {
    const v = node[key];
    if (v && typeof v === "object") rewriteCacheControl(v, counter, skip);
  }
}

export function countCacheBreakpoints(body) {
  let n = 0;
  const walk = (x) => {
    if (!x || typeof x !== "object") return;
    if (Array.isArray(x)) return x.forEach(walk);
    if (x.cache_control && x.cache_control.type === "ephemeral") n += 1;
    for (const k of Object.keys(x)) walk(x[k]);
  };
  walk(body);
  return n;
}

// Any ephemeral breakpoint inside the final message is a rolling tail — it
// moves each turn. Claude Code places its own tail now, so we can't rely on
// only handling tails we injected. Callers force these to the configured
// TAIL_TTL and exclude them from the blind 1h rewrite pass.
export function normalizeTailBreakpoints(body, tailTtl) {
  const out = new Set();
  if (!Array.isArray(body?.messages) || body.messages.length === 0) return out;
  const last = body.messages[body.messages.length - 1];
  const walk = (n) => {
    if (!n || typeof n !== "object") return;
    if (n.cache_control && n.cache_control.type === "ephemeral") {
      n.cache_control.ttl = tailTtl;
      out.add(n);
    }
    if (Array.isArray(n)) n.forEach(walk);
    else for (const k of Object.keys(n)) if (k !== "cache_control") walk(n[k]);
  };
  walk(last);
  return out;
}

function hasBreakpoint(arr) {
  return Array.isArray(arr) && arr.some(
    (x) => x && typeof x === "object" && x.cache_control && x.cache_control.type === "ephemeral",
  );
}

function stripSmallSystemBreakpoints(body) {
  if (!Array.isArray(body.system)) return 0;
  let stripped = 0;
  for (const block of body.system) {
    if (!block || typeof block !== "object") continue;
    if (!block.cache_control || block.cache_control.type !== "ephemeral") continue;
    const len = typeof block.text === "string" ? block.text.length : 0;
    if (len < MIN_SYSTEM_CACHE_CHARS) {
      delete block.cache_control;
      stripped += 1;
    }
  }
  return stripped;
}

function findLastCacheableBlockInMessage(m) {
  if (!m || typeof m !== "object") return null;
  const c = m.content;
  if (Array.isArray(c)) {
    for (let j = c.length - 1; j >= 0; j--) {
      const b = c[j];
      if (b && typeof b === "object" && (b.type === "text" || b.type === "tool_result" || b.type === "image")) {
        return b;
      }
    }
  } else if (typeof c === "string" && c.length > 0) {
    m.content = [{ type: "text", text: c }];
    return m.content[0];
  }
  return null;
}

function findLastCacheableMessageBlock(body) {
  if (!Array.isArray(body.messages) || body.messages.length === 0) return null;
  for (let i = body.messages.length - 1; i >= 0; i--) {
    const b = findLastCacheableBlockInMessage(body.messages[i]);
    if (b) return b;
  }
  return null;
}

export function injectBreakpointIfAbsent(body, opts = {}) {
  const { tailTtl = "5m" } = opts;
  const tags = [];
  const tailBlocks = new Set();

  const stripped = stripSmallSystemBreakpoints(body);
  if (stripped > 0) tags.push(`strip-sys:${stripped}`);

  if (Array.isArray(body.tools) && body.tools.length > 0 && !hasBreakpoint(body.tools)) {
    const last = body.tools[body.tools.length - 1];
    if (last && typeof last === "object") {
      last.cache_control = { type: "ephemeral", ttl: "1h" };
      tags.push("tools");
    }
  }

  if (Array.isArray(body.system) && body.system.length > 0 && !hasBreakpoint(body.system)) {
    const last = body.system[body.system.length - 1];
    if (last && typeof last === "object") {
      last.cache_control = { type: "ephemeral", ttl: "1h" };
      tags.push("system");
    }
  } else if (typeof body.system === "string" && body.system.length > 0) {
    body.system = [
      { type: "text", text: body.system, cache_control: { type: "ephemeral", ttl: "1h" } },
    ];
    tags.push("system-string");
  }

  // Dedicated breakpoint for messages[0] static reminders (CLAUDE.md + skills +
  // deferred tools catalog — ~5k tokens that never change). Only place when there
  // is a distinct tail message to follow, otherwise the tail logic below covers it.
  if (
    Array.isArray(body.messages) &&
    body.messages.length > 1 &&
    countCacheBreakpoints(body) < BREAKPOINT_CEILING
  ) {
    const first = findLastCacheableBlockInMessage(body.messages[0]);
    if (first && !first.cache_control) {
      first.cache_control = { type: "ephemeral", ttl: "1h" };
      tags.push("msg0");
    }
  }

  // Rolling tail cache: cache everything up to the most recent user/tool_result
  // content block. TTL is configurable via TAIL_TTL — default 5m since the tail
  // moves each turn. Respects the 4-breakpoint ceiling.
  if (countCacheBreakpoints(body) < BREAKPOINT_CEILING) {
    const tail = findLastCacheableMessageBlock(body);
    if (tail && !tail.cache_control) {
      tail.cache_control = { type: "ephemeral", ttl: tailTtl };
      tailBlocks.add(tail);
      tags.push(`tail:${tailTtl}`);
    }
  }

  return { tag: tags.length ? tags.join("+") : "none", tailBlocks };
}

export function ensureBetaHeader(headers) {
  const keys = Object.keys(headers);
  const betaKey = keys.find((k) => k.toLowerCase() === "anthropic-beta");
  if (!betaKey) {
    headers["anthropic-beta"] = BETA_FLAG;
    return "added";
  }
  const existing = String(headers[betaKey]);
  if (existing.split(",").map((s) => s.trim()).includes(BETA_FLAG)) {
    return "present";
  }
  headers[betaKey] = `${existing},${BETA_FLAG}`;
  return "appended";
}
