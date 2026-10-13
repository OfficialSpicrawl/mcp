// Output schemas of the session and browser tools: each is listed with an outputSchema, and
// structuredContent built from a mocked upstream response validates against it (the SDK client
// checks every result against the schema it learned from tools/list) while the text block stays
// the pretty-printed payload it always was.

import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { after, before, describe, test } from "node:test";
import { connectClient, forbiddenIn, startMcp } from "./helpers/harness.mjs";

const TOOLS = [
  "spicrawl_session_create",
  "spicrawl_session_list",
  "spicrawl_session_get",
  "spicrawl_session_context",
  "spicrawl_session_release",
  "spicrawl_session_delete",
  "spicrawl_browser_connect_url",
];

const SESSION = {
  id: "01J9ZQ4M7R3T8VX2K5N6P0B1CD", project_id: "01J9Y0000000000000000PROJ1", engine: "js", status: "active",
  sticky_key: "acct-4812", proxy: { tier: "residential", country: "de", region_pool: "eu" },
  created_at: "2026-09-22T10:00:00Z", last_used_at: "2026-09-22T10:05:12Z", expires_at: "2026-09-22T12:05:12Z",
  hard_expires_at: "2026-09-29T10:00:00Z", usage_count: 3, context: { schema_version: 1, cookies: 14, origins: 2, bytes: 5821 },
  domain_scores: { "example.com": { score: 0.5, good: 12, bad: 1, last_updated: 1790000500000, retired: false } },
  lease: { holder: "render-7", expires_at: "2026-09-22T10:06:00Z" }, warnings: ["TTL reduced to the organization maximum"],
  some_future_field: { kept: true },
};
// What the API sends for a fresh or released session: no engine, null last use, no context.
const BARE = {
  id: "01J9ZQ4M7R3T8VX2K5N6P0B2EF", project_id: "p", status: "released", sticky_key: "", proxy: { tier: "datacenter" },
  created_at: "2026-09-22T10:00:00Z", last_used_at: null, expires_at: "2026-09-22T12:00:00Z",
  released_at: "2026-09-22T11:00:00Z", usage_count: 0, context: null,
};
const DUMP = {
  session_id: SESSION.id, schema_version: 1,
  session_context: {
    cookies: [{ name: "sid", value: "9f2c1e7a", domain: ".example.com", path: "/", expires: 1790000000, http_only: true, secure: true, same_site: "Lax" }],
    local_storage: { "https://app.example.com": { token: "t" } }, session_storage: {}, indexed_db: {},
  },
  fingerprint: null, domain_scores: {}, usage_count: 3, created_at: SESSION.created_at, last_used_at: null, expires_at: SESSION.expires_at,
  warning: "This context only exists while the session is live.",
};

let upstream;
let mcp;
let client;
let tools;
let requests;
let override = null; // fields merged over the session /v1/sessions serves

before(async () => {
  requests = [];
  upstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf8");
    const url = new URL(req.url, "http://fake");
    requests.push({ method: req.method, path: url.pathname, query: url.search, body: raw ? JSON.parse(raw) : undefined });
    const json = (status, obj) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    const problem = (status, code, detail) => {
      res.writeHead(status, { "Content-Type": "application/problem+json" });
      res.end(JSON.stringify({ type: "about:blank", status, title: detail, code, detail, retryable: false }));
    };
    const p = url.pathname;
    const m = req.method;
    if (m === "GET" && p === "/v1/requests") return json(200, { requests: [], page: { has_more: false } });
    if (m === "POST" && p === "/v1/sessions") return json(201, override ? { ...SESSION, ...override } : SESSION);
    if (m === "GET" && p === "/v1/sessions") return json(200, { sessions: [SESSION, BARE], next_cursor: "1790000000000000000.01J9ZQ4M7R3T8VX2K5N6P0B1CD" });
    if (m === "GET" && p === `/v1/sessions/${SESSION.id}`) return json(200, SESSION);
    if (m === "GET" && p === `/v1/sessions/${SESSION.id}/context`) return json(200, DUMP);
    if (m === "POST" && p === `/v1/sessions/${SESSION.id}/release`) return json(200, BARE);
    if (m === "DELETE" && p === `/v1/sessions/${SESSION.id}`) {
      res.writeHead(204);
      return res.end();
    }
    if (p.startsWith("/v1/sessions/")) return problem(404, "ERR::SESSION::NOT_FOUND", "no such session");
    if (m === "POST" && p === "/v1/browser/token") {
      if (raw && JSON.parse(raw).proxy_country === "zz") return problem(400, "ERR::REQUEST::INVALID_PARAMETER", "bad country");
      const path = "/v1/browser?token=wbt_" + "t".repeat(43);
      return json(200, { url: `ws://internal${path}`, path, expires_at: "2026-09-24T12:00:00Z", expires_in: 60, single_use: true });
    }
    return problem(404, "ERR::NOT_FOUND", `no fake route for ${m} ${p}`);
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  mcp = await startMcp(`http://127.0.0.1:${upstream.address().port}`);
  ({ client } = await connectClient(mcp.mcpURL));
  // listTools makes the SDK client keep each outputSchema and check every later result against it.
  tools = (await client.listTools()).tools;
});

after(async () => {
  await client?.close().catch(() => {});
  await mcp?.stop();
  upstream?.closeAllConnections?.();
  await new Promise((r) => upstream?.close(() => r()));
});

/** Calls a tool; a JSON-RPC error (including a failed output validation) is returned as { rpcError }. */
async function call(name, args) {
  try {
    return await client.callTool({ name, arguments: args });
  } catch (err) {
    return { rpcError: err };
  }
}

/** A successful result whose text is the payload as pretty JSON and whose structuredContent is the payload. */
function assertStructured(res, payload) {
  assert.equal(res.rpcError, undefined, `JSON-RPC error: ${res.rpcError?.message}`);
  assert.equal(res.isError ?? false, false, `tool error: ${res.content?.[0]?.text}`);
  assert.deepEqual(res.structuredContent, payload);
  assert.equal(res.content[0].text, JSON.stringify(payload, null, 2));
}

describe("tools/list output schemas", () => {
  test("every session and browser tool declares an object outputSchema", () => {
    for (const name of TOOLS) {
      const tool = tools.find((t) => t.name === name);
      assert.ok(tool, `${name} is not listed`);
      assert.equal(tool.outputSchema?.type, "object", `${name} has no object outputSchema`);
      assert.notEqual(tool.outputSchema.additionalProperties, false, `${name} rejects fields the API adds later`);
    }
  });

  test("a session's engine and status are open strings naming the public tiers, and no schema names an internal engine", () => {
    const props = tools.find((t) => t.name === "spicrawl_session_get").outputSchema.properties;
    assert.equal(props.engine.enum, undefined, "an enum would reject a tier the API adds later");
    assert.equal(props.status.enum, undefined);
    assert.match(props.engine.description, /fetch, js or browser/);
    for (const name of TOOLS) {
      assert.deepEqual(forbiddenIn(tools.find((t) => t.name === name).outputSchema), [], `${name} outputSchema`);
    }
  });
});

describe("session tools return structuredContent", () => {
  test("spicrawl_session_create", async () => {
    assertStructured(await call("spicrawl_session_create", { engine: "js", ttl_seconds: 600 }), SESSION);
    const sent = requests.filter((r) => r.method === "POST" && r.path === "/v1/sessions").at(-1);
    assert.deepEqual(sent.body, { engine: "js", ttl_seconds: 600 });
  });

  test("spicrawl_session_list, with a released session that has null context and no engine", async () => {
    assertStructured(await call("spicrawl_session_list", { limit: 2 }), {
      sessions: [SESSION, BARE],
      next_cursor: "1790000000000000000.01J9ZQ4M7R3T8VX2K5N6P0B1CD",
    });
  });

  test("spicrawl_session_get", async () => {
    assertStructured(await call("spicrawl_session_get", { session_id: SESSION.id }), SESSION);
  });

  test("spicrawl_session_context", async () => {
    assertStructured(await call("spicrawl_session_context", { session_id: SESSION.id }), DUMP);
  });

  test("spicrawl_session_release", async () => {
    assertStructured(await call("spicrawl_session_release", { session_id: SESSION.id }), BARE);
  });

  test("spicrawl_session_delete", async () => {
    assertStructured(await call("spicrawl_session_delete", { session_id: SESSION.id }), { deleted: true, session_id: SESSION.id });
  });

  test("an API refusal is a tool error without structuredContent", async () => {
    const res = await call("spicrawl_session_get", { session_id: "nope" });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /ERR::SESSION::NOT_FOUND/);
    assert.equal(res.structuredContent, undefined);
  });

  test("a result that breaks the schema is rejected, so the schema is enforced", async () => {
    override = { id: 7 };
    try {
      const res = await call("spicrawl_session_create", {});
      assert.ok(res.rpcError || res.isError, "a session without a string id should not pass through");
    } finally {
      override = null;
    }
  });

  test("a status or engine the API adds later still validates (plain strings, not enums)", async () => {
    override = { status: "suspended", engine: "future-tier" };
    try {
      const res = await call("spicrawl_session_create", {});
      assert.equal(res.rpcError, undefined, `JSON-RPC error: ${res.rpcError?.message}`);
      assert.equal(res.isError ?? false, false, `tool error: ${res.content?.[0]?.text}`);
      assert.equal(res.structuredContent.status, "suspended");
      assert.equal(res.structuredContent.engine, "future-tier");
    } finally {
      override = null;
    }
  });
});

describe("spicrawl_browser_connect_url", () => {
  test("a minted URL is structuredContent matching the schema; the key never appears", async () => {
    const res = await call("spicrawl_browser_connect_url", { proxy_country: "de" });
    assert.equal(res.rpcError, undefined, `JSON-RPC error: ${res.rpcError?.message}`);
    assert.equal(res.isError ?? false, false, `tool error: ${res.content?.[0]?.text}`);
    const out = res.structuredContent;
    assert.match(out.url, /^ws:\/\/127\.0\.0\.1:\d+\/v1\/browser\?token=wbt_/);
    assert.equal(out.single_use, true);
    assert.equal(out.expires_at, "2026-09-24T12:00:00Z");
    assert.ok(Array.isArray(out.notes) && out.notes.length > 0);
    assert.deepEqual(JSON.parse(res.content[0].text), out);
    assert.ok(!JSON.stringify(res).includes("spicrawl_live_"));
  });

  test("the unavailable path still reports an error and carries no structuredContent", async () => {
    const res = await call("spicrawl_browser_connect_url", { proxy_country: "zz" });
    assert.equal(res.rpcError, undefined, "an error result must not trip the output validation");
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /ERR::REQUEST::INVALID_PARAMETER/);
    assert.equal(res.structuredContent, undefined);
  });
});
