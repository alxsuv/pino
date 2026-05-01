// Default transform for pino-proxy.
//
// Wire it up:
//   DROP_TOOLS=NotebookEdit,CronCreate,CronDelete,CronList \
//   TRANSFORM_FILE=./src/transforms/default.js LOG_BODIES=1 npm start
//
// `body` is the parsed /v1/messages request. Mutate in place OR return a new
// object. Return nothing to keep the mutated body. Throw to bail (proxy will
// forward the original body and log a warning).
//
// Inspect `logs/*.req.json` to see what's in `body.tools` / `body.system`
// before deciding what to trim.

const DROP_TOOLS = new Set(
  (process.env.DROP_TOOLS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

if (DROP_TOOLS.size > 0) {
  console.log(`[transform] DROP_TOOLS=${[...DROP_TOOLS].join(",")}`);
} else {
  console.log("[transform] DROP_TOOLS=(none)");
}

const STRIP_ANSI = process.env.STRIP_ANSI !== "0"; // default on
const TRIM_BASH_GIT = process.env.TRIM_BASH_GIT === "1"; // opt-in

console.log(`[transform] STRIP_ANSI=${STRIP_ANSI} TRIM_BASH_GIT=${TRIM_BASH_GIT}`);

const TOOL_OVERRIDES = {
  Bash: (t) => {
    if (!TRIM_BASH_GIT || typeof t.description !== "string") return;
    // Drop the long "Committing changes" + "Creating pull requests" + "Other
    // common operations" sections. Keep everything before them.
    const idx = t.description.indexOf("# Committing changes with git");
    if (idx > 0) t.description = t.description.slice(0, idx).trimEnd();
  },
};

const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;

function stripAnsi(s) {
  return typeof s === "string" ? s.replace(ANSI_RE, "") : s;
}

function stripAnsiFromMessages(body) {
  if (!STRIP_ANSI || !Array.isArray(body.messages)) return;
  for (const m of body.messages) {
    const c = m?.content;
    if (typeof c === "string") {
      m.content = stripAnsi(c);
      continue;
    }
    if (!Array.isArray(c)) continue;
    for (const b of c) {
      if (!b || typeof b !== "object") continue;
      if (typeof b.text === "string") b.text = stripAnsi(b.text);
      if (typeof b.content === "string") b.content = stripAnsi(b.content);
      if (Array.isArray(b.content)) {
        for (const rc of b.content) {
          if (rc && typeof rc === "object" && typeof rc.text === "string") {
            rc.text = stripAnsi(rc.text);
          }
        }
      }
    }
  }
}

function trimTools(body) {
  if (!Array.isArray(body.tools)) return;
  if (DROP_TOOLS.size > 0) {
    body.tools = body.tools.filter((t) => !DROP_TOOLS.has(t?.name));
  }
  for (const t of body.tools) {
    const fn = TOOL_OVERRIDES[t?.name];
    if (fn) fn(t);
  }
}

// Matches a <system-reminder>...</system-reminder> block that advertises
// deferred tools — typically contains "deferred tools" or "ToolSearch".
const REMINDER_RE = /<system-reminder>([\s\S]*?)<\/system-reminder>/g;

function stripDroppedToolsFromReminder(text) {
  if (DROP_TOOLS.size === 0 || typeof text !== "string") return text;
  return text.replace(REMINDER_RE, (full, inner) => {
    if (!/deferred tools|ToolSearch/i.test(inner)) return full;
    const cleaned = inner
      .split("\n")
      .filter((line) => !DROP_TOOLS.has(line.trim()))
      .join("\n");
    return `<system-reminder>${cleaned}</system-reminder>`;
  });
}

function trimReminders(body) {
  if (DROP_TOOLS.size === 0 || !Array.isArray(body.messages)) return;
  for (const msg of body.messages) {
    const c = msg?.content;
    if (typeof c === "string") {
      msg.content = stripDroppedToolsFromReminder(c);
    } else if (Array.isArray(c)) {
      for (const block of c) {
        if (block && typeof block === "object" && typeof block.text === "string") {
          block.text = stripDroppedToolsFromReminder(block.text);
        }
      }
    }
  }
}

function trimSystem(body) {
  // Example: strip a specific section from the system prompt.
  // if (Array.isArray(body.system)) {
  //   for (const block of body.system) {
  //     if (typeof block?.text === "string") {
  //       block.text = block.text.replace(/# Committing changes[\s\S]*?(?=\n# )/g, "");
  //     }
  //   }
  // }
}

function restructureV123(body) {
  try {
    if (!Array.isArray(body.messages) || body.messages.length === 0) return;

    const msgs = body.messages;
    const msg0 = msgs[0];
    const msg1 = msgs.length > 1 ? msgs[1] : null;

    const isCoreContext = (t) => {
      // Explicitly reject command outputs and caveats, even if they mention interesting paths
      if (t.includes("<local-command-stdout>") || t.includes("<local-command-caveat>")) {
        return false;
      }
      return (
        t.includes("ToolSearch") ||
        t.includes("claudeMd") ||
        t.includes(".claude/projects") ||
        t.includes(".claude/plans")
      );
    };

    const hasPattern = (msg, pattern) => {
      if (!msg) return false;
      const content = msg.content;
      if (typeof content === "string") return content.includes(pattern);
      if (Array.isArray(content)) {
        return content.some((block) => typeof block.text === "string" && block.text.includes(pattern));
      }
      return false;
    };

    // Normalize msg0 for safe processing
    if (typeof msg0.content === "string") {
      msg0.content = [{ type: "text", text: msg0.content }];
    }

    let processed = false;

    // Case A: Msg 1 is user and contains the main context (claudeMd)
    if (msg1 && msg1.role === "user" && hasPattern(msg1, "claudeMd")) {
      if (typeof msg1.content === "string") {
        msg1.content = [{ type: "text", text: msg1.content }];
      }

      const blocksToMove = [];
      const lastBlock = msg1.content[msg1.content.length - 1];

      for (const block of msg1.content) {
        if (typeof block.text === "string" && isCoreContext(block.text)) {
          if (block !== lastBlock) {
            blocksToMove.push(block);
          }
        }
      }

      if (blocksToMove.length > 0) {
        msg0.content = blocksToMove;
        msg1.content = [lastBlock];
        console.log(`[transform] Case A: Moved ${blocksToMove.length} context blocks from Msg 1 to Msg 0.`);
        processed = true;
      }
    }

    // Case B: Msg 0 already contains the context, but might need cleaning
    if (!processed && hasPattern(msg0, "claudeMd")) {
      const initialCount = msg0.content.length;
      msg0.content = msg0.content.filter(
        (block) => typeof block.text === "string" && isCoreContext(block.text),
      );
      console.log(`[transform] Case B: Msg 0 filtered (${initialCount} -> ${msg0.content.length} blocks).`);
      processed = true;
    }

    // Case C: No context found at all
    if (!processed && !hasPattern(msg0, "claudeMd")) {
      console.warn("[transform] WARNING: No required context (claudeMd) found in Msg 0 or Msg 1!");
    }
  } catch (err) {
    console.error("[transform] *** ERROR IN restructureV123 ***", err);
  }
}

export function transform(body) {
  trimTools(body);
  trimReminders(body);
  trimSystem(body);
  restructureV123(body);
  stripAnsiFromMessages(body);
}
