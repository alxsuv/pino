import fs from "node:fs";
import path from "node:path";

export function ts() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

export function fileTs() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export function log(...args) {
  console.log(`[${ts()}]`, ...args);
}

export function sanitizeHeaders(h) {
  const out = { ...h };
  for (const k of Object.keys(out)) {
    if (/authorization|x-api-key/i.test(k)) out[k] = "[redacted]";
  }
  return out;
}

export function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function writeRequestLog(logDir, reqId, meta, bodyBuffer) {
  const reqFile = path.join(logDir, `${reqId}.req.json`);
  try {
    const bodyText = bodyBuffer.toString("utf8");
    fs.writeFileSync(
      reqFile,
      JSON.stringify({ meta, body: safeJson(bodyText) }, null, 2),
    );
  } catch (err) {
    log("WARN req log failed:", err.message);
  }
}

export function createResponseLogStream(logDir, reqId, status, headers) {
  const respFile = path.join(logDir, `${reqId}.resp.log`);
  const stream = fs.createWriteStream(respFile);
  stream.write(`# status=${status}\n# headers=${JSON.stringify(headers)}\n\n`);
  return stream;
}
