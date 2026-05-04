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
    if (!Array.isArray(body.messages) || body.messages.length < 2) return;

    // Normalize all message contents to arrays for safe processing
    for (const msg of body.messages) {
      if (typeof msg.content === "string") {
        msg.content = [{ type: "text", text: msg.content }];
      }
    }

    const isCoreContext = (t) => {
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

    const isStaleRemovable = (t) => {
      return (
        t.startsWith("<system-reminder>") ||
        t.startsWith("<local-command-stdout>") ||
        t.startsWith("<local-command-caveat>") ||
        t.startsWith("<command-name>")
      );
    };

    const coreBlocks = [];

    // 1. Process ALL messages to extract core context and remove stale scaffolding
    for (let i = 0; i < body.messages.length; i++) {
      const msg = body.messages[i];
      if (!Array.isArray(msg.content)) continue;

      const isTail = i === body.messages.length - 1;
      const newContent = [];

      for (const block of msg.content) {
        if (typeof block.text === "string") {
          if (isCoreContext(block.text)) {
            // Always extract core context to move to Msg 0
            coreBlocks.push(block);
            continue;
          }
          if (!isTail && isStaleRemovable(block.text)) {
            // Drop stale reminders in history (including Msg 0)
            continue;
          }
        }
        // Preserve everything else: tool_results, normal text, tool_use, tail reminders
        newContent.push(block);
      }
      msg.content = newContent;
    }

    // 2. Assemble Msg 0 with the collection of unique core context blocks
    const msg0 = body.messages[0];
    if (coreBlocks.length > 0) {
      const uniqueCore = [];
      const seen = new Set();
      for (const b of coreBlocks) {
        if (!seen.has(b.text)) {
          uniqueCore.push(b);
          seen.add(b.text);
        }
      }
      msg0.content = [...uniqueCore, ...msg0.content];
      msg0.role = "user";
      console.log(`[transform] restructureV123: Assembled Msg 0 with ${uniqueCore.length} unique core blocks.`);
    }

    // Remove any completely empty messages that might have been created
    body.messages = body.messages.filter((m) => m.content && m.content.length > 0);

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
