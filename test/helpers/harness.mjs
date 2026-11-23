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

export const LIVE_SESSION = "bs" + "0123456789abcdef01234567";

export const VALID_KEY = `spicrawl_live_${"a".repeat(52)}`;
export const OTHER_VALID_KEY = `spicrawl_live_${"b".repeat(52)}`;
export const UNKNOWN_KEY = `spicrawl_live_${"z".repeat(52)}`;
/** A partner key: the partner scope and read, and no scrape. Its session gets the partner tools. */
export const PARTNER_KEY = `spicrawl_live_${"c".repeat(52)}`;

const VALID_KEYS = new Set([VALID_KEY, OTHER_VALID_KEY, PARTNER_KEY]);

/** What GET /v1/key answers for each kind of key. */
const KEY_INFO = {
  ordinary: { key_id: "01KEYORD", name: "Default", prefix: "spicrawl_live_aaaa", scopes: ["scrape", "batch", "sessions"], environment: "live", organization: { id: "org_1", name: "Acme" }, partner: false, workspace_of_partner: false, created_at: "2026-11-18T09:00:00Z", expires_at: null },
  partner: { key_id: "01KEYPART", name: "Partner", prefix: "spicrawl_live_cccc", scopes: ["partner", "read"], environment: "live", organization: { id: "org_partner", name: "Partner Co" }, partner: true, workspace_of_partner: false, created_at: "2026-11-18T09:00:00Z", expires_at: null },
};

const WORKSPACE_BASE = {
  display_name: null, status: "active", created_at: "2026-11-18T09:00:00Z", free_credits: 250, free_used: 40,
  wallet_cap: 500, wallet_cap_source: "tier", wallet_used: 120, wallet_used_source: "live",
  window_resets_at: "2026-12-18T00:00:00Z", own_credits: 50, tier: { id: "tier_std", name: "Standard" },
  requests_per_minute: 60, concurrency: 2,
};

/** The partner account behind PARTNER_KEY: one balance, two tiers, two users, and the credit assignments made so far. */
export function partnerState() {
  const workspace = (id, extra = {}) => ({ ...WORKSPACE_BASE, workspace_id: `ws_${id.replace(/[^a-z0-9]/gi, "")}`, external_user_id: id, ...extra });
  return {
    balance: {
      funded_credits: 1000, credit_line_credits: 0, spent_credits: 120, balance_credits: 880, available_credits: 880,
      funded_micro: 1000000000, credit_line_micro: 0, spent_micro: 120000000, balance_micro: 880000000, available_micro: 880000000,
    },
    tiers: [
      { id: "tier_std", name: "Standard", requests_per_minute: 60, concurrency: 2, free_credits: 250, wallet_cap: 500, default: true, workspaces: 2, created_at: "2026-11-19T10:00:00Z", updated_at: "2026-11-19T10:00:00Z" },
      { id: "tier_pro", name: "Pro", requests_per_minute: 120, concurrency: 4, free_credits: 500, wallet_cap: null, default: false, workspaces: 0, created_at: "2026-11-19T10:05:00Z", updated_at: "2026-11-19T10:05:00Z" },
    ],
    users: {
      "user-42": workspace("user-42"),
      "acct:7.eu_west": workspace("acct:7.eu_west", { display_name: "EU account", wallet_used: 480 }),
    },
    /** idempotency_key -> the assignment it was used for. */
    assignments: new Map(),
    /** Sample usage: the third total has parts that exceed it, which the whole-credit fields must still add up. */
    usageTotals: { requests: 14, requests_failed: 1, credits_micro: 14000000, credits_wallet_micro: 9000000, credits_own_micro: 3000000 },
    usageRows: [
      { day: "2026-11-01", requests: 5, requests_failed: 0, credits_micro: 5000000, credits_wallet_micro: 0, credits_own_micro: 0 },
      { day: "2026-11-02", requests: 9, requests_failed: 1, credits_micro: 9000000, credits_wallet_micro: 9000000, credits_own_micro: 0 },
    ],
    workspaceRows: [
      { external_user_id: "user-42", workspace_id: "ws_user42", requests: 5, requests_failed: 0, credits_micro: 5000000, credits_wallet_micro: 4000000, credits_own_micro: 3000000 },
      { external_user_id: "acct:7.eu_west", workspace_id: "ws_accountEUwest", requests: 9, requests_failed: 1, credits_micro: 9000000, credits_wallet_micro: 6000000, credits_own_micro: 0 },
    ],
  };
}

/**
 * The partner routes, as the API answers them for PARTNER_KEY: { status, body }.
 * `path` is the raw pathname (ids stay percent-encoded until decoded here).
 */
function partnerRoute(s, method, path, query, body) {
  const problem = (status, code, detail) => ({ status, body: { type: "about:blank", title: code, status, code, detail, retryable: status >= 500 } });
  const ok = (data, status = 200) => ({ status, body: data });
  const find = (id) => s.users[id];
  let m;

  if (method === "GET" && path === "/v1/partner/summary") {
    return ok({
      partner: true, org_id: "org_partner", free_credits: 250, workspace_daily_limit: 50, workspace_count: 2,
      limits: { max_requests_per_minute: 600, max_concurrency: 10, max_free_credits: 1000 },
      users: { total: 2, active: 2, suspended: 0 }, caps: { committed: 500, uncapped_users: 0 }, balance: s.balance,
    });
  }
  if (method === "GET" && path === "/v1/partner/wallet") return ok(s.balance);
  if (method === "GET" && path === "/v1/partner/workspaces") return ok({ workspaces: Object.values(s.users) });
  if (method === "GET" && path === "/v1/partner/usage") {
    const byWorkspace = query.get("group_by") === "workspace";
    return ok({
      period: { start: query.get("from") ?? "2026-10-21", end: query.get("to") ?? "2026-11-20", bounds: "[start, end)", days: 30 },
      group_by: byWorkspace ? "workspace" : "day",
      totals: s.usageTotals,
      rows: byWorkspace ? s.workspaceRows : s.usageRows,
      page: byWorkspace ? { next_offset: null } : undefined,
    });
  }
  if (method === "GET" && path === "/v1/partner/tiers") return ok({ tiers: s.tiers });
  if (method === "POST" && path === "/v1/partner/tiers") {
    if (s.tiers.some((t) => t.name === body.name)) return problem(409, "ERR::REQUEST::CONFLICT", `A tier named ${body.name} already exists.`);
    const tier = { id: `tier_${s.tiers.length + 1}`, ...body, default: body.default === true, wallet_cap: body.wallet_cap ?? null, workspaces: 0, created_at: "2026-11-20T00:00:00Z", updated_at: "2026-11-20T00:00:00Z" };
    s.tiers.push(tier);
    return ok(tier, 201);
  }
  if ((m = /^\/v1\/partner\/tiers\/([^/]+)$/.exec(path))) {
    const id = decodeURIComponent(m[1]);
    const tier = s.tiers.find((t) => t.id === id);
    if (!tier) return problem(404, "ERR::REQUEST::NOT_FOUND", "No tier with that id belongs to your account.");
    if (method === "PATCH") {
      Object.assign(tier, body, { updated_at: "2026-11-20T00:00:00Z" });
      return ok(tier);
    }
    if (method === "DELETE") {
      if (tier.workspaces > 0) return problem(409, "ERR::REQUEST::CONFLICT", `${tier.workspaces} workspaces are on this tier. Move them first.`);
      s.tiers.splice(s.tiers.indexOf(tier), 1);
      return { status: 204 };
    }
  }
  if ((m = /^\/v1\/partner\/workspaces\/([^/]+)(?:\/(tier|credits|usage|suspend|reactivate))?$/.exec(path))) {
    const id = decodeURIComponent(m[1]);
    const u = find(id);
    if (!u) return problem(404, "ERR::REQUEST::NOT_FOUND", "No workspace with that external_user_id belongs to your account.");
    const action = m[2];
    if (!action && method === "GET") return ok(u);
    if (!action && method === "PATCH") {
      if (body.display_name !== null && !(typeof body.display_name === "string" && body.display_name.length >= 1 && body.display_name.length <= 100)) {
        return problem(400, "ERR::REQUEST::INVALID_PARAMETER", "display_name must be 1 to 100 characters, or null.");
      }
      u.display_name = body.display_name;
      return ok(u);
    }
    if (action === "suspend" && method === "POST") return ok({ ...u, status: "suspended" });
    if (action === "reactivate" && method === "POST") return ok({ ...u, status: "active" });
    if (action === "tier" && method === "PUT") {
      const tier = s.tiers.find((t) => t.id === body.tier || t.name === body.tier);
      if (!tier) return problem(404, "ERR::REQUEST::NOT_FOUND", "No tier with that id or name belongs to your account.");
      u.tier = { id: tier.id, name: tier.name };
      return ok(u);
    }
    if (action === "credits" && method === "POST") {
      const { credits, idempotency_key: key } = body;
      const prior = s.assignments.get(key);
      if (prior) {
        if (prior.external_user_id === id && prior.credits === credits) {
          return ok({ external_user_id: id, credits, applied: false, user_credits: u.own_credits, balance_available: s.balance.balance_credits });
        }
        return problem(409, "ERR::REQUEST::CONFLICT", "This idempotency_key was already used for a different assignment (another amount or user). Use a new key.");
      }
      if (credits > s.balance.balance_credits) {
        return problem(402, "ERR::LIMIT::QUOTA_EXCEEDED", `You can give at most ${s.balance.balance_credits} credits right now; this assignment is ${credits}.`);
      }
      s.balance.balance_credits -= credits;
      u.own_credits += credits;
      s.assignments.set(key, { external_user_id: id, credits });
      return ok({ external_user_id: id, credits, applied: true, user_credits: u.own_credits, balance_available: s.balance.balance_credits });
    }
    if (action === "usage" && method === "GET") {
      return ok({ external_user_id: id, period: { start: query.get("from"), end: query.get("to") }, totals: s.usageTotals, rows: s.usageRows });
    }
  }
  return problem(404, "ERR::NOT_FOUND", `no fake partner route for ${method} ${path}`);
}

export const INVALID_KEY_PROBLEM = {
  type: "about:blank",
  title: "API key not recognised",
  status: 401,
  code: "ERR::AUTH::INVALID_KEY",
  detail: "That API key is not recognised.",
  retryable: false,
};

// Words that name our rendering engines or the browser tooling behind them. Customers see the
// public tiers (fetch, js, browser) and never these, so no tools/list output may contain one.
// Substring match, case-insensitive: "Chromium", "headless-browser" and "PlayWright" all count.
export const FORBIDDEN_WORDS = [
  "moli", "chromium", "chrome", "camoufox", "obscura", "browserless", "headful", "headless", "playwright", "puppeteer",
];

/** The forbidden words found in `value` (any JSON-serialisable value), each with a snippet of context. */
export function forbiddenIn(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const found = [];
  for (const word of FORBIDDEN_WORDS) {
    for (const m of text.matchAll(new RegExp(word, "gi"))) {
      found.push(`${word}: ...${text.slice(Math.max(0, m.index - 40), m.index + word.length + 40)}...`);
    }
  }
  return found;
}

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
  headers: { "set-cookie": "a=b" }, truncated: false, credits: 3, engine: "browser", proxy_source: "pool",
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
    /** How GET /v1/key answers: "ok", "404" (an older API), "500", or "hang" (never answers). */
    keyRoute: "ok",
    /** The partner account behind PARTNER_KEY (see partnerState). */
    partner: partnerState(),
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
    if (req.method === "GET" && p === "/v1/key") {
      if (api.keyRoute === "404") return problem(404, { title: "Not Found", code: "ERR::NOT_FOUND", detail: "no such route", retryable: false });
      if (api.keyRoute === "500") return problem(500, { title: "Internal", code: "ERR::INTERNAL::ERROR", detail: "boom", retryable: true });
      if (api.keyRoute === "hang") return; // never answered: the caller's own timeout ends it
      return json(200, m[1] === PARTNER_KEY ? KEY_INFO.partner : KEY_INFO.ordinary, { "Cache-Control": "no-store" });
    }
    if (p.startsWith("/v1/partner/")) {
      if (m[1] !== PARTNER_KEY) {
        return problem(403, { title: "Insufficient scope", code: "ERR::AUTH::INSUFFICIENT_SCOPE", detail: "This key cannot call partner routes.", retryable: false });
      }
      const r = partnerRoute(api.partner, req.method, p, url.searchParams, body);
      if (r.status === 204) {
        res.writeHead(204).end();
        return;
      }
      if (r.status >= 400) return problem(r.status, { title: r.body.title, code: r.body.code, detail: r.body.detail, retryable: r.body.retryable });
      return json(r.status, r.body);
    }
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
      return json(200, ENVELOPE_PAYLOAD, { "X-Engine": "browser", "X-Request-Id": "01TESTENV00000000000000000" });
    }
    if (req.method === "POST" && p === "/v1/batch") {
      return json(201, { ...FULL_JOB, total_items: body?.urls?.length ?? 0 });
    }
    if (req.method === "GET" && p === "/v1/batch/job_full") {
      return json(200, FULL_JOB);
    }
    // A job whose items have all succeeded but which is not terminal yet: the
    // results endpoint lists them without `result`, and each body is served
    // on its own by /tasks/{seq}/content (seq 2 is not readable yet).
    if (req.method === "GET" && p === "/v1/batch/job_finishing/results") {
      const lines = [0, 1, 2].map((seq) => ({
        seq, url: `https://f${seq}.test/`, status: "succeeded", attempts: 1, http_status: 200, credits_micro: 1000000, bytes: 10,
        request_id: `01REQF${seq}`, result_ref: `s3://bucket/f${seq}`,
      }));
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.end(lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
      return;
    }
    if (req.method === "GET" && p === "/v1/batch/job_finishing/tasks/0/content") {
      res.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8" });
      res.end("# Zero\n");
      return;
    }
    if (req.method === "GET" && p === "/v1/batch/job_finishing/tasks/1/content") {
      return json(200, "<p>one</p>");
    }
    if (req.method === "GET" && p === "/v1/batch/job_finishing/tasks/2/content") {
      return problem(409, { title: "Conflict", code: "ERR::REQUEST::NOT_READY", detail: "not finished yet", retryable: true });
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
          "X-Engine": "browser", "X-Credits-Charged": "8", "X-Target-Status": "200",
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
        return json(200, { url: body.url, status: 200, content: "<html>Example</html>", engine: "browser", credits: 8, screenshots }, { "X-Engine": "browser" });
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
      return json(200, { url: `ws://internal${path}`, path, expires_at: "2026-09-24T12:00:00Z", expires_in: 60, single_use: true, session_id: LIVE_SESSION });
    }
    const live = p.match(/^\/v1\/browser\/sessions\/([^/]+)(\/live|\/takeover|\/release)?$/);
    if (live) {
      if (live[1] !== LIVE_SESSION) {
        return problem(404, { title: "Not found", code: "ERR::REQUEST::NOT_FOUND", detail: "No open browser session has that id.", retryable: false });
      }
      if (req.method === "POST" && live[2] === "/live") {
        // The API's own view of its host, as a hosted MCP behind loopback sees it.
        const socket = `ws://internal/v1/browser/sessions/${LIVE_SESSION}/live?token=wbv_${"v".repeat(64)}`;
        return json(200, { session_id: LIVE_SESSION, live_url: socket, live_view_url: `http://internal/v1/browser/live#${encodeURIComponent(socket)}`, expires_in: 60, single_use: true });
      }
      const controller = live[2] === "/takeover" ? "human" : "agent";
      if ((req.method === "GET" && !live[2]) || (req.method === "POST" && live[2] !== "/live")) {
        return json(200, { session_id: LIVE_SESSION, status: "running", controller, expires_at: "2026-09-24T12:03:00Z" });
      }
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

export const TOOLS_LIST_BODY = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} };

/** A tools/call that would hit the API (spicrawl_usage_summary): without a key it must never get that far. */
export const TOOLS_CALL_BODY = {
  jsonrpc: "2.0",
  id: 3,
  method: "tools/call",
  params: { name: "spicrawl_usage_summary", arguments: {} },
};

/** A raw POST /mcp, bypassing the SDK client, for status/header assertions. `headers` are added last (no `key` for a non-Bearer form). */
export async function rawPost(mcpURL, { key, sessionId, body = INITIALIZE_BODY, headers: extra = {} } = {}) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (key) headers.Authorization = `Bearer ${key}`;
  if (sessionId) {
    headers["Mcp-Session-Id"] = sessionId;
    headers["Mcp-Protocol-Version"] = "2025-06-18";
  }
  Object.assign(headers, extra);
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
