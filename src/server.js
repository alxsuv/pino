import http from "node:http";
import https from "node:https";
import fs from "node:fs";

import { loadConfig, loadTransform, UPSTREAM_HOST } from "./config.js";
import {
  ensureBetaHeader,
  injectBreakpointIfAbsent,
  normalizeTailBreakpoints,
  rewriteCacheControl,
} from "./cache.js";
import {
  createResponseLogStream,
  fileTs,
  log,
  sanitizeHeaders,
  writeRequestLog,
} from "./logger.js";

function isJsonRequest(req) {
  const ct = req.headers["content-type"] || "";
  return ct.includes("application/json");
}

function isMessagesPath(pathname) {
  return (
    pathname === "/v1/messages" ||
    pathname.startsWith("/v1/messages?") ||
    pathname === "/v1/messages/count_tokens" ||
    pathname.startsWith("/v1/messages/count_tokens?")
  );
}

export function createServer({ config, transformFn }) {
  const { AUTO_CACHE, LOG_BODIES, LOG_DIR, TAIL_TTL } = config;

  return http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const rawBody = Buffer.concat(chunks);
      let outBody = rawBody;
      const notes = [];
      const reqId = fileTs() + "-" + Math.random().toString(36).slice(2, 8);

      const mutate =
        req.method === "POST" &&
        isMessagesPath(req.url || "") &&
        isJsonRequest(req) &&
        rawBody.length > 0 &&
        (AUTO_CACHE || transformFn);

      let parsed = null;
      if (mutate) {
        try {
          parsed = JSON.parse(rawBody.toString("utf8"));
        } catch (err) {
          log("WARN parse failed, forwarding original body:", err.message);
        }
      }

      if (parsed && transformFn) {
        try {
          const result = transformFn(parsed);
          if (result && typeof result === "object") parsed = result;
          notes.push("transform=ok");
        } catch (err) {
          log("WARN transform threw, skipping:", err.message);
          notes.push("transform=err");
        }
      }

      if (parsed && AUTO_CACHE) {
        const { tag, tailBlocks } = injectBreakpointIfAbsent(parsed, { tailTtl: TAIL_TTL });
        const clientTail = normalizeTailBreakpoints(parsed, TAIL_TTL);
        const skip = new Set([...tailBlocks, ...clientTail]);
        const counter = { rewritten: 0, alreadySet: 0, skipped: 0 };
        rewriteCacheControl(parsed, counter, skip);
        notes.push(
          `cache=rewrote:${counter.rewritten},already:${counter.alreadySet},skipped:${counter.skipped},inject:${tag},tail-ttl:${TAIL_TTL}`,
        );
      }

      if (parsed) {
        outBody = Buffer.from(JSON.stringify(parsed), "utf8");
      }

      const headers = { ...req.headers };
      headers.host = UPSTREAM_HOST;
      headers["content-length"] = String(outBody.length);
      const betaStatus = AUTO_CACHE && parsed ? ensureBetaHeader(headers) : "skipped";
      notes.push(`beta=${betaStatus}`);

      if (LOG_BODIES) {
        writeRequestLog(
          LOG_DIR,
          reqId,
          {
            method: req.method,
            url: req.url,
            headers: sanitizeHeaders(headers),
            mutated: Boolean(parsed),
          },
          outBody,
        );
      }

      const upReq = https.request(
        {
          hostname: UPSTREAM_HOST,
          port: 443,
          path: req.url,
          method: req.method,
          headers,
        },
        (upRes) => {
          res.writeHead(upRes.statusCode || 502, upRes.headers);

          if (LOG_BODIES) {
            const stream = createResponseLogStream(
              LOG_DIR,
              reqId,
              upRes.statusCode,
              upRes.headers,
            );
            upRes.on("data", (chunk) => {
              stream.write(chunk);
              res.write(chunk);
            });
            upRes.on("end", () => {
              stream.end();
              res.end();
            });
            upRes.on("error", (err) => {
              stream.end();
              res.destroy(err);
            });
          } else {
            upRes.pipe(res);
          }

          log(
            `${req.method} ${req.url} -> ${upRes.statusCode}`,
            `[id=${reqId} ${notes.join(" ") || "pass-through"}]`,
          );
        },
      );

      upReq.on("error", (err) => {
        log("ERR upstream:", err.message);
        if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
        res.end(`proxy upstream error: ${err.message}`);
      });

      upReq.end(outBody);
    });

    req.on("error", (err) => log("ERR client:", err.message));
  });
}

export async function startServer() {
  const config = loadConfig();
  const transformFn = await loadTransform(config.TRANSFORM_FILE);

  if (config.LOG_BODIES) fs.mkdirSync(config.LOG_DIR, { recursive: true });

  const server = createServer({ config, transformFn });

  server.listen(config.PORT, "127.0.0.1", () => {
    log(`pino-proxy listening on http://127.0.0.1:${config.PORT}`);
    log(
      `settings: AUTO_CACHE=${config.AUTO_CACHE} TAIL_TTL=${config.TAIL_TTL} TRANSFORM_FILE=${config.TRANSFORM_FILE || "(none)"} LOG_BODIES=${config.LOG_BODIES} LOG_DIR=${config.LOG_DIR}`,
    );
    log(`export ANTHROPIC_BASE_URL=http://127.0.0.1:${config.PORT}`);
  });

  return server;
}
