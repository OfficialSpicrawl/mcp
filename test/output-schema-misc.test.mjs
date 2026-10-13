// The docs, usage and request-history tools (8 in all) declare an outputSchema, and a
// real call through the MCP server returns structuredContent that validates against
// it, with the text content unchanged. One fake host stands in for both the API
// (usage and requests routes the shared harness lacks) and the public docs site.

import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { after, before, describe, test } from "node:test";
import Ajv from "ajv";
import { connectClient, forbiddenIn, startMcp } from "./helpers/harness.mjs";

const TOOLS = [
  "spicrawl_docs_search",
  "spicrawl_docs_read",
  "spicrawl_docs_index",
  "spicrawl_usage",
  "spicrawl_usage_summary",
  "spicrawl_usage_reconciliation",
  "spicrawl_requests_list",
  "spicrawl_request_get",
];

const ANTI_BOT_MD = "# Anti-bot handling\n\n## Challenge pages\n\nText.\n";
const LLMS_TXT = "# Spicrawl\n\n- [Anti-bot](/guides/anti-bot.md): handling bot walls\n";

const PERIOD = { start: "2026-09-01", end: "2026-09-03", days: 2, bounds: "[start, end)" };
// Engine buckets are the public tiers only; a field this server has never heard of rides along.
const BY_ENGINE = {
  period: PERIOD,
  group_by: "engine",
  groups: [
    { key: "browser", label: "Browser rendering", metrics: { requests: 5, credits: 40000000 } },
    { key: "fetch", label: "Plain fetch", metrics: { requests: 90, credits: 90000000 } },
    { key: "js", label: "JavaScript rendering", metrics: { requests: 20, credits: 40000000 } },
  ],
  totals: { requests: 115, credits: 170000000, a_metric_from_the_future: 1 },
  unattributed: { requests: 0, credits: 0, a_metric_from_the_future: 0 },
  usage_as_of: "2026-09-22T11:55:00Z",
  stale_seconds: 300,
  warnings: ["engine attribution is partial"],
  some_future_field: { nested: true },
};
const BY_DAY_EMPTY = { period: PERIOD, group_by: "day", groups: null, totals: {}, unattributed: {}, usage_as_of: null, stale_seconds: null };
const BY_KEY = {
  period: PERIOD,
  group_by: "key",
  keys: [
    {
      key_id: "01J9Z3K6V1Q2W3E4R5T6Y7U8I9",
      name: "ci-pipeline",
      prefix: "spicrawl_live_a1b2",
      project_id: "01J9Z3K6V1Q2W3E4R5T6Y7U8P0",
      revoked: false,
      days: [{ day: "2026-09-01", metrics: { requests: 120, client_mcp: 120 } }],
      totals: { requests: 120, client_mcp: 120 },
    },
  ],
};
const SUMMARY = {
  period: { start: "2026-09-14", end: "2026-10-14", days: 30, bounds: "[start, end)" },
  period_elapsed_days: 8,
  plan: { code: "free", name: "Free", version: 1, subscription_status: "none", period_source: "allowance_month" },
  credits: {
    included_micro: 1000000000, used_micro: 212000000, remaining_micro: 788000000,
    overage_micro: 0, overage_micro_cents_per_credit: 0, used_basis_points: 2120,
  },
  allowance: {
    limit_micro: 1000000000, limit_credits: 1000, limit_source: "default", unlimited: false,
    used_micro: 260000000, remaining_micro: 740000000,
    window_start: "2026-09-14T00:00:00Z", resets_at: "2026-10-14T00:00:00Z",
  },
  metrics: { requests: 2410, credits: 212000000 },
  unattributed: { requests: 2410, credits: 212000000 },
  usage_as_of: "2026-09-22T11:55:00Z",
  stale_seconds: 300,
};
// Older servers answered credits: null; a deployment with no allowance counter omits allowance.
const SUMMARY_SPARSE = { ...SUMMARY, credits: null, allowance: undefined, warnings: ["allowance counter could not be read"] };
const RECONCILIATION = {
  day: "2026-09-21",
  drift: [{ project_id: "01J9Y0000000000000000PROJ1", metric: "credits", stored_qty: 3100000000, observed_qty: 0, delta: -3100000000, action: "absent_from_request_log" }],
  request_log_rows: 0,
  interpretation: "The request log holds no rows for this day, so every billed row is reported as absent_from_request_log.",
  repairable: false,
};
const RECONCILIATION_CLEAN = { day: "2026-09-20", drift: [], request_log_rows: 14, interpretation: "No drift.", repairable: false };

const ENTRY = {
  id: "01M0FK1EP2E7FBMWAR7W10SMXW",
  created_at: "2026-09-22T12:41:22.183Z",
  project_id: "01M0FJZ8Q3W4B5T8J2V9K6X1RD",
  engine: "js",
  status: "blocked",
  http_status: 403,
  error_code: "ERR::UPSTREAM::CHALLENGE",
  error_detail: "The target served a challenge page.",
  attempts: 2,
  url: "https://shop.example.com/p/123",
  url_host: "shop.example.com",
  proxy: {
    source: "pool", endpoint_id: "dc-198.51.100.7-6646", requested_tier: "datacenter", requested_country: "de", country: "de",
    endpoints: ["dc-198.51.100.9-6646", "dc-198.51.100.7-6646"],
  },
  spans: { admission_ms: 2, dispatch_ms: 4731, worker_ms: 4718, queue_ms: 0, engine_ms: 4706, upstream_ms: null, extract_ms: null, total_ms: 4735 },
  blocked: { vendor: "akamai", signal: '"Access Denied"', rule: "body_marker" },
  bytes_in: 18231,
  credits_micro: 0,
  features: { js_render: true },
};
const ENTRY_OK = {
  id: "01M0FK1EP2E7FBMWAR7W10SMXX", created_at: "2026-09-22T12:40:00Z", project_id: ENTRY.project_id, engine: "fetch", status: "success",
  http_status: 200, url: "https://example.com/", proxy: { source: "direct" },
  spans: { admission_ms: 1, dispatch_ms: 80, worker_ms: 70, queue_ms: 0, engine_ms: null, upstream_ms: 60, extract_ms: null, total_ms: 85 },
  credits_micro: 1000000,
};
const PAGE = {
  data: [ENTRY, ENTRY_OK],
  page: { retention_hours: 24, retained_since: "2026-09-21T12:45:00Z", has_more: true, next_before: ENTRY_OK.created_at, next_before_id: ENTRY_OK.id },
};
const PAGE_EMPTY = { data: [], page: { retention_hours: 24, retained_since: "2026-09-21T12:45:00Z", has_more: false } };

const SEARCH_RESULTS = [
  { id: "guides/anti-bot", type: "page", content: "<mark>Anti-bot</mark> handling", url: "/guides/anti-bot", breadcrumbs: ["Guides"] },
  { id: "guides/anti-bot-0", type: "heading", content: "Challenge pages", url: "/guides/anti-bot#challenge-pages" },
  { id: "guides/anti-bot-1", type: "text", content: "When a target serves a <mark>bot</mark> wall, the scrape fails.", url: "/guides/anti-bot#challenge-pages" },
];

let upstream;
let mcp;
let client;
let tools; // name -> tool definition from tools/list
const ajv = new Ajv({ strict: false, allErrors: true });

before(async () => {
  const server = createServer((req, res) => {
    const u = new URL(req.url, "http://fake");
    const send = (status, type, body) => {
      res.writeHead(status, { "Content-Type": type });
      res.end(body);
    };
    const json = (status, obj) => send(status, "application/json", JSON.stringify(obj));
    const q = u.searchParams;
    switch (`${req.method} ${u.pathname}`) {
      case "GET /api/search":
        return json(200, q.get("query") === "nothing-matches" ? [] : SEARCH_RESULTS);
      case "GET /guides/anti-bot.md":
        return send(200, "text/markdown", ANTI_BOT_MD);
      case "GET /huge.md":
        return send(200, "text/markdown", "x".repeat(70_000));
      case "GET /llms.txt":
        return send(200, "text/plain", LLMS_TXT);
      case "GET /v1/usage": {
        const by = q.get("group_by");
        if (by === "key") return json(200, BY_KEY);
        if (by === "engine") return json(200, BY_ENGINE);
        return json(200, BY_DAY_EMPTY);
      }
      case "GET /v1/usage/summary":
        return json(200, q.has("sparse") ? SUMMARY_SPARSE : SUMMARY);
      case "GET /v1/usage/reconciliation":
        return json(200, q.get("day") === "2026-09-20" ? RECONCILIATION_CLEAN : RECONCILIATION);
      case "GET /v1/requests":
        return json(200, q.get("status") === "cancelled" ? PAGE_EMPTY : PAGE);
      case `GET /v1/requests/${ENTRY.id}`:
        return json(200, { ...ENTRY, some_future_field: [1, 2] });
      case `GET /v1/requests/${ENTRY_OK.id}`:
        return json(200, ENTRY_OK);
      case "GET /v1/requests/01GONE":
        return send(404, "application/problem+json", JSON.stringify({ status: 404, code: "ERR::REQUEST::NOT_FOUND", detail: "no such request", retryable: false }));
    }
    send(404, "text/html", "<!DOCTYPE html><html>not found</html>");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  upstream = { server, url: `http://127.0.0.1:${server.address().port}` };

  mcp = await startMcp(upstream.url, { SPICRAWL_DOCS_URL: upstream.url, SPICRAWL_DOCS_HOST: "" });
  ({ client } = await connectClient(mcp.mcpURL));
  tools = new Map((await client.listTools()).tools.map((t) => [t.name, t]));
});

after(async () => {
  await client?.close().catch(() => {});
  await mcp?.stop();
  if (upstream) {
    upstream.server.closeAllConnections?.();
    await new Promise((r) => upstream.server.close(() => r()));
  }
});

/** Calls `name`, asserts it succeeded and that its structuredContent validates, and returns the result. */
async function ok(name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  assert.notEqual(res.isError, true, `${name} failed: ${res.content?.[0]?.text}`);
  assertValid(name, res.structuredContent);
  return res;
}

/** Asserts `value` validates against the tool's advertised outputSchema. */
function assertValid(name, value) {
  const validate = ajv.compile(tools.get(name).outputSchema);
  assert.ok(validate(value), `${name}: structuredContent does not match its outputSchema: ${ajv.errorsText(validate.errors)}`);
}

const text = (res) => res.content.map((c) => c.text).join("\n");

describe("docs, usage and request tools advertise an outputSchema", () => {
  test("every one of the eight is listed with an object outputSchema", () => {
    for (const name of TOOLS) {
      assert.equal(tools.get(name)?.outputSchema?.type, "object", `${name} has no object outputSchema`);
    }
  });

  test("schemas keep unknown API fields (additionalProperties is not false)", () => {
    for (const name of TOOLS) {
      assert.notEqual(tools.get(name).outputSchema.additionalProperties, false, `${name} rejects extra fields`);
    }
  });

  test("schemas never name an internal engine", () => {
    for (const name of TOOLS) assert.deepEqual(forbiddenIn(tools.get(name).outputSchema), [], name);
  });

  test("a schema is not vacuous: a wrongly typed field fails it, while only our own docs fields are required", () => {
    assert.equal(ajv.validate(tools.get("spicrawl_docs_read").outputSchema, { url: "u" }), false);
    assert.equal(ajv.validate(tools.get("spicrawl_usage").outputSchema, { ...BY_ENGINE, stale_seconds: "soon" }), false);
    assert.equal(ajv.validate(tools.get("spicrawl_request_get").outputSchema, { id: 7 }), false);
    assert.equal(ajv.validate(tools.get("spicrawl_requests_list").outputSchema, { data: [{ url: "u" }] }), false);
  });

  test("API-sourced fields beyond the id are optional, so a thinner or newer answer still validates", () => {
    assert.equal(ajv.validate(tools.get("spicrawl_usage").outputSchema, { totals: {}, brand_new_field: [1] }), true);
    assert.equal(ajv.validate(tools.get("spicrawl_usage_summary").outputSchema, {}), true);
    assert.equal(ajv.validate(tools.get("spicrawl_usage_reconciliation").outputSchema, { drift: null }), true);
    assert.equal(ajv.validate(tools.get("spicrawl_request_get").outputSchema, { id: "01X", status: "future_status" }), true);
  });
});

describe("docs tools return structuredContent matching their outputSchema", () => {
  test("spicrawl_docs_search: grouped pages, text is the same JSON", async () => {
    const res = await ok("spicrawl_docs_search", { query: "bot wall" });
    const { query, results } = res.structuredContent;
    assert.equal(query, "bot wall");
    assert.equal(results.length, 1);
    assert.equal(results[0].title, "Anti-bot handling");
    assert.equal(results[0].md_url, `${upstream.url}/guides/anti-bot.md`);
    assert.deepEqual(JSON.parse(text(res)), res.structuredContent);
  });

  test("spicrawl_docs_search: an error code carries error_code; no matches carries a hint", async () => {
    const withCode = await ok("spicrawl_docs_search", { query: "ERR::AUTH::INVALID_KEY" });
    assert.equal(withCode.structuredContent.error_code.code, "ERR::AUTH::INVALID_KEY");
    const none = await ok("spicrawl_docs_search", { query: "nothing-matches" });
    assert.deepEqual(none.structuredContent.results, []);
    assert.match(none.structuredContent.hint, /spicrawl_docs_index/);
  });

  test("spicrawl_docs_read: the page in structuredContent, the text unchanged", async () => {
    const res = await ok("spicrawl_docs_read", { path: "guides/anti-bot#challenge-pages" });
    assert.deepEqual(res.structuredContent, {
      url: `${upstream.url}/guides/anti-bot`,
      md_url: `${upstream.url}/guides/anti-bot.md`,
      title: "Anti-bot handling",
      section: "challenge-pages",
      truncated: false,
      content: ANTI_BOT_MD,
    });
    assert.equal(text(res), `Source: ${upstream.url}/guides/anti-bot#challenge-pages (look for the section #challenge-pages)\n\n${ANTI_BOT_MD}`);
  });

  test("spicrawl_docs_read: a long page is flagged truncated", async () => {
    const res = await ok("spicrawl_docs_read", { path: "huge" });
    assert.equal(res.structuredContent.truncated, true);
    assert.match(res.structuredContent.content, /Truncated: showing the first 60000 of 70000 characters/);
    assert.equal(res.structuredContent.title, undefined);
  });

  test("spicrawl_docs_read: a missing page is still a plain tool error", async () => {
    const res = await client.callTool({ name: "spicrawl_docs_read", arguments: { path: "guides/nope" } });
    assert.equal(res.isError, true);
    assert.match(text(res), /No docs page at `guides\/nope`/);
  });

  test("spicrawl_docs_index: llms.txt verbatim as the text, and as content", async () => {
    const res = await ok("spicrawl_docs_index");
    assert.equal(text(res), LLMS_TXT);
    assert.deepEqual(res.structuredContent, { url: `${upstream.url}/llms.txt`, truncated: false, content: LLMS_TXT });
  });
});

describe("usage tools return structuredContent matching their outputSchema", () => {
  test("spicrawl_usage group_by=engine: only the public tiers, unknown fields kept", async () => {
    const res = await ok("spicrawl_usage", { group_by: "engine" });
    assert.deepEqual(res.structuredContent.groups.map((g) => g.key), ["browser", "fetch", "js"]);
    assert.deepEqual(forbiddenIn(res.structuredContent), []);
    assert.deepEqual(res.structuredContent.some_future_field, { nested: true });
    assert.deepEqual(JSON.parse(text(res)), res.structuredContent);
  });

  test("spicrawl_usage group_by=key: the per-key body validates", async () => {
    const res = await ok("spicrawl_usage", { group_by: "key" });
    assert.equal(res.structuredContent.keys[0].name, "ci-pipeline");
  });

  test("spicrawl_usage: an empty window (null groups, null freshness) validates", async () => {
    const res = await ok("spicrawl_usage", { from: "2026-09-01", to: "2026-09-03" });
    assert.equal(res.structuredContent.stale_seconds, null);
  });

  test("spicrawl_usage_summary: the free-plan summary validates", async () => {
    const res = await ok("spicrawl_usage_summary");
    assert.equal(res.structuredContent.allowance.remaining_micro, 740000000);
    assert.deepEqual(JSON.parse(text(res)), res.structuredContent);
  });

  test("spicrawl_usage_summary: null credits and no allowance validate", async () => {
    assertValid("spicrawl_usage_summary", JSON.parse(JSON.stringify(SUMMARY_SPARSE)));
  });

  test("spicrawl_usage_reconciliation: a drift report and a clean day validate", async () => {
    const drift = await ok("spicrawl_usage_reconciliation");
    assert.equal(drift.structuredContent.drift[0].action, "absent_from_request_log");
    const clean = await ok("spicrawl_usage_reconciliation", { day: "2026-09-20" });
    assert.deepEqual(clean.structuredContent.drift, []);
    assert.deepEqual(JSON.parse(text(clean)), clean.structuredContent);
  });
});

describe("request tools return structuredContent matching their outputSchema", () => {
  test("spicrawl_requests_list: a page with a cursor validates", async () => {
    const res = await ok("spicrawl_requests_list", { only_errors: true });
    assert.equal(res.structuredContent.data.length, 2);
    assert.equal(res.structuredContent.page.has_more, true);
    assert.equal(res.structuredContent.page.next_before_id, ENTRY_OK.id);
    assert.deepEqual(JSON.parse(text(res)), res.structuredContent);
  });

  test("spicrawl_requests_list: an empty page validates", async () => {
    const res = await ok("spicrawl_requests_list", { status: "cancelled" });
    assert.deepEqual(res.structuredContent.data, []);
  });

  test("spicrawl_request_get: a blocked record, nulls in spans and unknown fields kept", async () => {
    const res = await ok("spicrawl_request_get", { id: ENTRY.id });
    assert.equal(res.structuredContent.blocked.vendor, "akamai");
    assert.equal(res.structuredContent.spans.upstream_ms, null);
    assert.deepEqual(res.structuredContent.some_future_field, [1, 2]);
    assert.deepEqual(JSON.parse(text(res)), res.structuredContent);
  });

  test("spicrawl_request_get: a successful record without optional parts validates", async () => {
    const res = await ok("spicrawl_request_get", { id: ENTRY_OK.id });
    assert.equal(res.structuredContent.status, "success");
  });

  test("spicrawl_request_get: not_found is still a tool error", async () => {
    const res = await client.callTool({ name: "spicrawl_request_get", arguments: { id: "01GONE" } });
    assert.equal(res.isError, true);
    assert.match(text(res), /ERR::REQUEST::NOT_FOUND/);
  });
});
