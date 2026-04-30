const SOURCE_ID_PATTERN = /claude-opus-4-7(?:-\d{8})?/g;
const SOURCE_NAME_PATTERN = /Opus 4\.7/g;

const TARGET_FRIENDLY_NAMES = {
  "claude-opus-4-6": "Opus 4.6",
  "claude-opus-4-5": "Opus 4.5",
  "claude-sonnet-4-6": "Sonnet 4.6",
  "claude-sonnet-4-5": "Sonnet 4.5",
  "claude-haiku-4-5": "Haiku 4.5",
};

export function rewriteSystemModelRefs(body, override) {
  if (!body || !override) return 0;

  const base = override.replace(/-\d{8}$/, "");
  const friendly = TARGET_FRIENDLY_NAMES[base] || base;

  const rewrite = (text) =>
    text.replace(SOURCE_ID_PATTERN, override).replace(SOURCE_NAME_PATTERN, friendly);

  let count = 0;
  if (typeof body.system === "string") {
    const next = rewrite(body.system);
    if (next !== body.system) count++;
    body.system = next;
  } else if (Array.isArray(body.system)) {
    for (const blk of body.system) {
      if (blk && typeof blk.text === "string") {
        const next = rewrite(blk.text);
        if (next !== blk.text) count++;
        blk.text = next;
      }
    }
  }
  return count;
}
