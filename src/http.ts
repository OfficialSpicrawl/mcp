#!/usr/bin/env node
/**
 * spicrawl-mcp-http — the Spicrawl MCP server over Streamable HTTP, so a user can
 * connect an MCP client to a hosted URL instead of installing anything.
 *
 *   POST/GET/DELETE /mcp   MCP Streamable HTTP endpoint (Bearer auth)
 *   GET /healthz           liveness, no auth
 *
 * Auth is the caller's own Spicrawl API key (`Authorization: Bearer spicrawl_live_...`);
 * every tool call runs upstream under that key. One MCP server per session, and
 * a session is pinned to the key that created it: a request presenting another
 * key with that session id is refused (403), so no caller can run under someone
 * else's key. An initialize is refused (401) unless the API accepts the key,
 * and answered 503 when the API cannot be asked.
 *
 *   SPICRAWL_MCP_ADDR   listen address, default 127.0.0.1:8090
 *   SPICRAWL_BASE_URL   upstream Spicrawl API, default http://127.0.0.1:8080
 *   SPICRAWL_PUBLIC_BASE_URL  the API as remote callers reach it, used for URLs
 *                     handed back (browser connect URL); default SPICRAWL_BASE_URL
 *   SPICRAWL_DOCS_URL   the public docs base URL, read by the docs tools (never
 *                     sent a key), e.g. http://HOST:8080/docs self-hosted; default
 *                     SPICRAWL_DOCS_HOST + /docs (legacy), then a self-hosted
 *                     SPICRAWL_PUBLIC_BASE_URL / SPICRAWL_BASE_URL + /docs, then
 *                     https://docs.spicrawl.com (see docsBaseFromEnv)
 *   SPICRAWL_MCP_SESSION_IDLE_MS  idle session eviction, default 1800000 (30 min)
 */

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { ILayerClient, USER_AGENT } from "./client.js";
import { buildServer } from "./server.js";

const ADDR = process.env.SPICRAWL_MCP_ADDR || "127.0.0.1:8090";
const BASE_URL = process.env.SPICRAWL_BASE_URL || "http://127.0.0.1:8080";
const PUBLIC_BASE_URL = process.env.SPICRAWL_PUBLIC_BASE_URL || BASE_URL;
const IDLE_MS = Number(process.env.SPICRAWL_MCP_SESSION_IDLE_MS) || 30 * 60 * 1000;
const MAX_BODY = 4 * 1024 * 1024;
const KEY_CHECK_TIMEOUT_MS = 5_000;
const KEY_RE = /^spicrawl_(live|test)_[A-Za-z0-9_-]{8,}$/;

interface Session {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  keyHash: Buffer;
  lastSeen: number;
}

const sessions = new Map<string, Session>();

const log = (...a: unknown[]) => console.error(new Date().toISOString(), ...a);
const hashKey = (k: string) => createHash("sha256").update(k).digest();

function rpcError(res: ServerResponse, status: number, code: number, message: string, extra: Record<string, string> = {}) {
  if (res.headersSent) return;
  res.writeHead(status, { "Content-Type": "application/json", ...extra });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}

function bearer(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  if (!h) return null;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(h);
  return m && KEY_RE.test(m[1]) ? m[1] : null;
}

async function readJSON(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new Error("body too large");
    chunks.push(c as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : undefined;
}

type KeyCheck = { ok: true } | { ok: false; status: 401 | 503; message: string };

// The key's shape is checked locally, but only the API knows whether it exists.
// Without asking, a revoked key opens a session and fails only on its first tool
// call, which clients surface as a broken tool rather than a bad credential.
// GET /v1/requests needs a valid key and no scope, so any non-401 answer below
// 500 (a 403 on scope included) proves the key authenticated.
async function checkKey(key: string): Promise<KeyCheck> {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/v1/requests?limit=1`, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json", "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(KEY_CHECK_TIMEOUT_MS),
    });
  } catch (err) {
    log("key check: API unreachable:", err instanceof Error ? err.message : String(err));
    return { ok: false, status: 503, message: "Service Unavailable: could not reach the Spicrawl API to verify the key; retry shortly" };
  }
  const text = await res.text().catch(() => "");
  if (res.status === 401) {
    let code = "ERR::AUTH::INVALID_KEY";
    let detail = "the API key is invalid, revoked or expired";
    try {
      const p = JSON.parse(text) as { code?: unknown; detail?: unknown; title?: unknown };
      if (typeof p.code === "string" && p.code) code = p.code;
      if (typeof p.detail === "string" && p.detail) detail = p.detail;
      else if (typeof p.title === "string" && p.title) detail = p.title;
    } catch {
      // Not a platform problem body; keep the generic wording.
    }
    return { ok: false, status: 401, message: `Unauthorized: ${code}: ${detail}` };
  }
  // A 5xx says nothing about the key, so refusing it as bad would send the
  // caller off to rotate a working credential.
  if (res.status >= 500) {
    log(`key check: API answered HTTP ${res.status}`);
    return { ok: false, status: 503, message: `Service Unavailable: the Spicrawl API answered HTTP ${res.status} while verifying the key; retry shortly` };
  }
  return { ok: true };
}

async function closeSession(id: string, why: string) {
  const s = sessions.get(id);
  if (!s) return;
  sessions.delete(id);
  log(`session ${id.slice(0, 8)} closed (${why}); ${sessions.size} open`);
  await s.transport.close().catch(() => {});
  await s.server.close().catch(() => {});
}

async function handleMcp(req: IncomingMessage, res: ServerResponse) {
  const key = bearer(req);
  if (!key) {
    return rpcError(res, 401, -32001,
      "Unauthorized: send your Spicrawl API key as 'Authorization: Bearer spicrawl_live_...'",
      { "WWW-Authenticate": 'Bearer realm="spicrawl-mcp"' });
  }
  const keyHash = hashKey(key);

  let body: unknown;
  if (req.method === "POST") {
    try {
      body = await readJSON(req);
    } catch {
      return rpcError(res, 400, -32700, "Parse error: body must be JSON (max 4 MiB)");
    }
  }

  const sid = req.headers["mcp-session-id"];
  if (typeof sid === "string" && sid) {
    const s = sessions.get(sid);
    if (!s) return rpcError(res, 404, -32001, "Session not found or expired: re-initialize");
    if (!timingSafeEqual(s.keyHash, keyHash)) {
      log(`session ${sid.slice(0, 8)}: request with a different API key refused`);
      return rpcError(res, 403, -32003, "Forbidden: this session belongs to a different API key");
    }
    s.lastSeen = Date.now();
    await s.transport.handleRequest(req, res, body);
    return;
  }

  if (req.method !== "POST" || !isInitializeRequest(body)) {
    return rpcError(res, 400, -32000, "Bad Request: no Mcp-Session-Id; the first request must be initialize");
  }

  // Only a new session is checked: an existing one is already bound to this
  // key's hash, and re-asking the API on every call would double its load.
  const check = await checkKey(key);
  if (!check.ok) {
    return check.status === 401
      ? rpcError(res, 401, -32001, check.message, { "WWW-Authenticate": 'Bearer realm="spicrawl-mcp"' })
      : rpcError(res, 503, -32000, check.message, { "Retry-After": "5" });
  }

  const server = buildServer(new ILayerClient({ apiKey: key, baseURL: BASE_URL, publicBaseURL: PUBLIC_BASE_URL }));
  const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (id) => {
      sessions.set(id, { transport, server, keyHash, lastSeen: Date.now() });
      log(`session ${id.slice(0, 8)} opened; ${sessions.size} open`);
    },
  });
  transport.onclose = () => {
    if (transport.sessionId) void closeSession(transport.sessionId, "closed");
  };
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

const http = createServer((req, res) => {
  const path = (req.url || "/").split("?")[0];
  if (path === "/healthz" && (req.method === "GET" || req.method === "HEAD")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(req.method === "HEAD" ? undefined : JSON.stringify({ status: "ok", sessions: sessions.size }));
    return;
  }
  if (path !== "/mcp") return rpcError(res, 404, -32601, "Not found: the MCP endpoint is /mcp");
  if (!["GET", "POST", "DELETE"].includes(req.method || "")) {
    return rpcError(res, 405, -32000, "Method not allowed", { Allow: "GET, POST, DELETE" });
  }
  handleMcp(req, res).catch((err) => {
    log("request failed:", err instanceof Error ? err.message : String(err));
    rpcError(res, 500, -32603, "Internal error");
  });
});

// Idle eviction keeps memory bounded: a client that vanishes without DELETE
// leaves its session behind otherwise.
setInterval(() => {
  const cutoff = Date.now() - IDLE_MS;
  for (const [id, s] of sessions) if (s.lastSeen < cutoff) void closeSession(id, "idle");
}, 60_000).unref();

const i = ADDR.lastIndexOf(":");
const host = i > 0 ? ADDR.slice(0, i).replace(/^\[|\]$/g, "") : "127.0.0.1";
const port = Number(i >= 0 ? ADDR.slice(i + 1) : ADDR);
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  log(`invalid SPICRAWL_MCP_ADDR '${ADDR}' (want host:port)`);
  process.exit(78);
}

http.listen(port, host, () => log(`spicrawl-mcp-http listening on http://${host}:${port}/mcp -> ${BASE_URL}`));
http.on("error", (err) => {
  log("spicrawl-mcp-http failed:", err.message);
  process.exit(1);
});

const shutdown = () => {
  log("shutting down");
  http.close();
  for (const id of [...sessions.keys()]) void closeSession(id, "shutdown");
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
