// Test harness: a fake Spicrawl API on loopback plus the real hosted MCP server
// (dist/http.js) pointed at it. Nothing here reaches a real deployment.

import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const PKG_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const VALID_KEY = `spicrawl_live_${"a".repeat(52)}`;
export const OTHER_VALID_KEY = `spicrawl_live_${"b".repeat(52)}`;
export const UNKNOWN_KEY = `spicrawl_live_${"z".repeat(52)}`;

const VALID_KEYS = new Set([VALID_KEY, OTHER_VALID_KEY]);

export const INVALID_KEY_PROBLEM = {
  type: "about:blank",
  title: "API key not recognised",
  status: 401,
  code: "ERR::AUTH::INVALID_KEY",
  detail: "That API key is not recognised.",
  retryable: false,
};

export const MARKDOWN_PAYLOAD = '# Pricing\n\nThe "Pro" plan:\n\n- 10 000 credits\n- *priority* queue\n';
export const ARRAY_PAYLOAD = [{ title: "one", price: 1 }, { title: "two", price: 2 }];
// A real 1x1 PNG, so a client that decodes the image block gets a valid picture.
export const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
// Over the MCP server's 5 MB per-image cap; the fake API serves it only when asked.
export const OVERSIZED_B64 = PNG_1X1 + "A".repeat(5 * 1024 * 1024);
// Bytes that do not survive a UTF-8 text round trip, so a client reading them as text fails the test.
export const PDF_BYTES = Buffer.concat([Buffer.from("%PDF-1.7\n%"), Buffer.from([0xe2, 0xe3, 0xcf, 0xd3, 0xff, 0x00, 0x80]), Buffer.from("\n%%EOF\n")]);
// Over the 10 MB of base64 the scrape tool returns (8 MiB raw is ~11.2 MB base64).
export const OVERSIZED_PDF = Buffer.concat([PDF_BYTES, Buffer.alloc(8 * 1024 * 1024)]);

// The out-of-credit problem as the API writes it (api/internal/scrape/handler.go quotaRefusal,
// httpx.DocURL): an explanation and a link to the errors page, nothing to buy or upgrade.
export const QUOTA_DETAIL =
  "This organization's monthly credit allowance is used up. It resets at 00:00 UTC on 2026-10-28; an operator can raise the ceiling sooner.";
export const QUOTA_DOC_URL = "https://docs.spicrawl.com/errors#LIMIT_QUOTA_EXCEEDED";

export const BATCH_JOB = {
  id: "job_123",
  status: "running",
  progress: { total: 2, completed: 1, succeeded: 1, failed: 0, remaining: 1 },
  estimated_credits: 2,
};

/** A scrape JSON envelope with every internal field the API may send. */
export const ENVELOPE_PAYLOAD = {
  url: "https://envelope.test/", final_url: "https://envelope.test/", status: 200, content: "<h1>Hi</h1>",
  headers: { "set-cookie": "a=b" }, truncated: false, credits: 3, engine: "chromium", proxy_source: "pool",
  warnings: ["FORMAT_COERCED: extraction returns the JSON envelope"], data: { id: "page-own-id", title: "Hi" },
  diagnostics: { attempts: [{ engine: "fetch", request_id: "01X" }] }, request_id: "01TESTENV00000000000000000",
};

/** A batch job as every /v1/batch endpoint reports it (api/internal/batch jobDTO). */
export const FULL_JOB = {
  id: "job_full", project_id: "prj_0123", name: "", status: "running", status_url: "/v1/batch/job_full",
  results_url: "/v1/batch/job_full/results", params: { response_format: "markdown" }, total_items: 2, concurrency: 8,
  priority: 0, max_attempts: 3, estimated_credits: 2, estimated_credits_micro: 2000000,
  progress: { total: 2, completed: 1, succeeded: 1, failed: 0, cancelled: 0, skipped: 0, remaining: 1, percent_complete: 50,
    credits_charged: 1, credits_charged_micro: 1000000, bytes: 120 },
  submitted_at: "2026-10-01T00:00:00Z", started_at: "2026-10-01T00:00:01Z", results_expire_at: "2026-10-04T00:00:00Z",
};

/** Two result lines (api/internal/batch ResultRecord). */
export const RESULT_LINES = [
  { seq: 0, url: "https://a.test/", status: "succeeded", attempts: 1, http_status: 200, request_id: "01REQA",
    credits_micro: 1000000, bytes: 60, duration_ms: 412, result_ref: "s3://bucket/key", result: { content: "# A", bytes: 3 },
    result_url: "/v1/batch/job_full/tasks/0/content", finished_at: "2026-10-01T00:00:02Z" },
  { seq: 1, url: "https://b.test/", status: "failed", attempts: 3, request_id: "01REQB", credits_micro: 0, bytes: 0,
    duration_ms: 900, error: { code: "ERR::UPSTREAM::TIMEOUT", retryable: true }, finished_at: "2026-10-01T00:00:03Z" },
];

/**
 * A node:http server that implements only the routes the tests hit.
 * `mode` switches it between "up", "503" (every request answers 503) and
 * "reset" (every connection is destroyed without a response).
 */
export async function startFakeApi() {
  const api = {
    mode: "up",
    /** Every request received: { method, path, auth, body }. */
    requests: [],
    url: "",
    close: null,
  };

  const server = createServer(async (req, res) => {
    if (api.mode === "reset") {
      req.socket.destroy();
      return;
    }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf8");
    let body;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      body = raw;
    }
    const url = new URL(req.url, "http://fake");
    api.requests.push({ method: req.method, path: url.pathname, query: url.search, auth: req.headers.authorization, body });

    const problem = (status, p) => {
      res.writeHead(status, { "Content-Type": "application/problem+json" });
      res.end(JSON.stringify({ type: "about:blank", status, ...p }));
    };
    const json = (status, obj, headers = {}) => {
      res.writeHead(status, { "Content-Type": "application/json", ...headers });
      res.end(JSON.stringify(obj));
    };

    if (api.mode === "503") {
      return problem(503, { title: "Service Unavailable", code: "ERR::INTERNAL::UNAVAILABLE", detail: "down for test", retryable: true });
    }

    const m = /^Bearer (\S+)$/.exec(req.headers.authorization || "");
    if (!m || !VALID_KEYS.has(m[1])) {
      res.writeHead(401, { "Content-Type": "application/problem+json" });
      res.end(JSON.stringify(INVALID_KEY_PROBLEM));
      return;
    }

    const p = url.pathname;
    if (req.method === "GET" && p === "/v1/requests") {
      return json(200, { requests: [], page: { has_more: false, retention_hours: 24 } });
    }
    // The ChatGPT surface's scrape shapes. A markdown body with the status and
    // charge in headers, and a JSON envelope full of fields that must not reach the model.
    if (req.method === "POST" && p === "/v1/scrape" && body?.url === "https://raw.test/") {
      res.writeHead(200, {
        "Content-Type": "text/markdown; charset=utf-8",
        "X-Engine": "fetch", "X-Target-Status": "200", "X-Credits-Charged": "1", "X-Request-Id": "01TESTRAW00000000000000000",
      });
      res.end("# Raw page\n");
      return;
    }
    if (req.method === "POST" && p === "/v1/scrape" && body?.url === "https://envelope.test/") {
      return json(200, ENVELOPE_PAYLOAD, { "X-Engine": "chromium", "X-Request-Id": "01TESTENV00000000000000000" });
    }
    if (req.method === "POST" && p === "/v1/batch") {
      return json(201, { ...FULL_JOB, total_items: body?.urls?.length ?? 0 });
    }
    if (req.method === "GET" && p === "/v1/batch/job_full") {
      return json(200, FULL_JOB);
    }
    if (req.method === "GET" && p === "/v1/batch/job_full/results") {
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.end(RESULT_LINES.map((l) => JSON.stringify(l)).join("\n") + "\n");
      return;
    }
    if (req.method === "POST" && p === "/v1/scrape") {
      // An API refusal that names API parameters, for the renaming test.
      if (body?.url === "https://needs-render.test/") {
        return problem(400, {
          title: "Bad Request", code: "ERR::PARAM::INVALID",
          detail: "`actions` needs a browser: set `js_render=true`. `response_format=pdf` is not allowed here.",
          retryable: false,
        });
      }
      if (body?.url === "https://over-quota.test/") {
        return problem(402, {
          title: "Credit quota exhausted", code: "ERR::LIMIT::QUOTA_EXCEEDED",
          detail: QUOTA_DETAIL, retryable: false, doc_url: QUOTA_DOC_URL,
        });
      }
      // response_format=pdf: the file itself, with the envelope's fields as headers.
      if (body?.response_format === "pdf") {
        const bytes = body.url === "https://huge-pdf.test/" ? OVERSIZED_PDF : PDF_BYTES;
        res.writeHead(200, {
          "Content-Type": "application/pdf",
          "X-Engine": "chromium", "X-Credits-Charged": "8", "X-Target-Status": "200",
          "X-Final-Url": body.url, "X-Request-Id": "01TESTPDF0000000000000000",
        });
        res.end(bytes);
        return;
      }
      // The screenshot envelope, shaped as api/internal/scrape screenshotPayload
      // emits it. `screenshot_selector` picks the variant so tests stay independent.
      if (body?.screenshot) {
        const shot = (data, extra = {}) => ({
          label: "final", encoding: "base64", data, size_bytes: Buffer.from(data, "base64").length, format: "png", ...extra,
        });
        const screenshots =
          body.screenshot_selector === "#huge"
            ? [shot(OVERSIZED_B64), shot(PNG_1X1)]
            : [shot(PNG_1X1, { width: 1, height: 1 })];
        return json(200, { url: body.url, status: 200, content: "<html>Example</html>", engine: "chromium", credits: 8, screenshots }, { "X-Engine": "chromium" });
      }
      return json(200, { content: "# Example Domain\n", meta: { engine: "fetch", status: 200, credits: 1 } }, { "X-Engine": "fetch" });
    }
    if (req.method === "POST" && p === "/v1/browser/token") {
      if (body?.proxy_country === "zz") {
        return problem(400, { title: "Invalid parameter", code: "ERR::REQUEST::INVALID_PARAMETER", detail: "bad country", retryable: false });
      }
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries(body ?? {})) q.set(k, String(v));
      q.set("token", "wbt_" + "t".repeat(43));
      const path = `/v1/browser?${q}`;
      return json(200, { url: `ws://internal${path}`, path, expires_at: "2026-09-24T12:00:00Z", expires_in: 60, single_use: true });
    }
    if (req.method === "GET" && p === "/v1/batch/job_123") {
      return json(200, BATCH_JOB);
    }
    if (req.method === "GET" && p === "/v1/batch/job_123/tasks/0/content") {
      res.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8" });
      res.end(MARKDOWN_PAYLOAD);
      return;
    }
    if (req.method === "GET" && p === "/v1/batch/job_123/tasks/1/content") {
      return json(200, ARRAY_PAYLOAD);
    }
    // A stored payload that is valid JSON but a bare string: the shape that made
    // every call fail at the protocol level before structuredContent was guarded.
    if (req.method === "GET" && p === "/v1/batch/job_123/tasks/2/content") {
      return json(200, MARKDOWN_PAYLOAD);
    }
    return problem(404, { title: "Not Found", code: "ERR::NOT_FOUND", detail: `no fake route for ${req.method} ${p}`, retryable: false });
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  api.url = `http://127.0.0.1:${server.address().port}`;
  api.close = async () => {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(() => r()));
  };
  return api;
}

async function freePort() {
  const s = createServer();
  s.listen(0, "127.0.0.1");
  await once(s, "listening");
  const { port } = s.address();
  await new Promise((r) => s.close(() => r()));
  return port;
}

/** Spawns `node dist/http.js` against `apiURL` and waits for /healthz. `env` overrides the defaults. */
export async function startMcp(apiURL, env = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, ["dist/http.js"], {
    cwd: PKG_DIR,
    env: {
      ...process.env,
      SPICRAWL_MCP_ADDR: `127.0.0.1:${port}`,
      SPICRAWL_BASE_URL: apiURL,
      SPICRAWL_PUBLIC_BASE_URL: apiURL,
      ...env,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 10_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`dist/http.js exited ${child.exitCode}:\n${stderr}`);
    try {
      const r = await fetch(`${base}/healthz`);
      if (r.ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error(`dist/http.js did not become healthy:\n${stderr}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }

  return {
    base,
    mcpURL: `${base}/mcp`,
    chatgptURL: `${base}/chatgpt/mcp`,
    stderr: () => stderr,
    async healthz() {
      const r = await fetch(`${base}/healthz`);
      return { status: r.status, body: await r.json() };
    },
    async stop() {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
      await once(child, "exit");
      clearTimeout(timer);
    },
  };
}

/** An SDK client connected to the MCP endpoint with `key` as bearer. */
export async function connectClient(mcpURL, key = VALID_KEY) {
  const transport = new StreamableHTTPClientTransport(new URL(mcpURL), {
    requestInit: { headers: { Authorization: `Bearer ${key}` } },
  });
  const client = new Client({ name: "spicrawl-mcp-test", version: "0.0.0" });
  await client.connect(transport);
  return { client, transport };
}

export const INITIALIZE_BODY = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "spicrawl-mcp-test", version: "0.0.0" },
  },
};

/** A raw POST /mcp, bypassing the SDK client, for status/header assertions. */
export async function rawPost(mcpURL, { key, sessionId, body = INITIALIZE_BODY } = {}) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (key) headers.Authorization = `Bearer ${key}`;
  if (sessionId) {
    headers["Mcp-Session-Id"] = sessionId;
    headers["Mcp-Protocol-Version"] = "2025-06-18";
  }
  const res = await fetch(mcpURL, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  return { res, text };
}

export const INTROSPECT_SECRET = "introspect-secret-for-tests";
export const DEFAULT_RESOURCE = "https://mcp.spicrawl.com/chatgpt/mcp";

/** An access token in the shape the authorization server issues. */
export const oat = (name) => `spicrawl_oat_${name}_${"x".repeat(24)}`;

/**
 * A fake authorization server's introspection endpoint (POST /api/oauth/introspect).
 * `tokens` maps an access token to the claims answered for it; anything else is
 * `{active:false}`. A claim set may be a function, called per request.
 */
export async function startFakeIntrospection() {
  const fake = { tokens: new Map(), requests: [], url: "", close: null, mode: "up" };
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
    const token = form.get("token");
    fake.requests.push({ method: req.method, path: req.url, auth: req.headers.authorization, contentType: req.headers["content-type"], token });
    const send = (status, obj) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (fake.mode === "503") return send(503, { error: "down" });
    if (req.method !== "POST" || req.url !== "/api/oauth/introspect") return send(404, { error: "not_found" });
    if (req.headers.authorization !== `Bearer ${INTROSPECT_SECRET}`) return send(401, { error: "invalid_client" });
    const claims = fake.tokens.get(token);
    if (!claims) return send(200, { active: false });
    send(200, typeof claims === "function" ? claims() : claims);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  fake.url = `http://127.0.0.1:${server.address().port}`;
  fake.count = (token) => fake.requests.filter((r) => r.token === token).length;
  fake.close = async () => {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(() => r()));
  };
  return fake;
}

/** Active claims for `api_key` on the default resource, valid for an hour unless overridden. */
export function claims(overrides = {}) {
  return {
    active: true,
    aud: DEFAULT_RESOURCE,
    scope: "scrape batch",
    exp: Math.floor(Date.now() / 1000) + 3600,
    client_id: "chatgpt",
    grant_id: "grt_1",
    org_id: "org_1",
    project_id: "prj_1",
    api_key: VALID_KEY,
    ...overrides,
  };
}

/** A raw JSON-RPC POST to /chatgpt/mcp with `token` as bearer; parses a JSON answer. */
export async function chatgptPost(url, { token, body = INITIALIZE_BODY, headers = {} } = {}) {
  const h = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "Mcp-Protocol-Version": "2025-06-18", ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  const res = await fetch(url, { method: "POST", headers: h, body: JSON.stringify(body) });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { res, text, json };
}
