// The brand, webhook and monitor tools: which key scopes are offered which tools, each tool's
// request against a fake API, the signing-secret wording, and the surfaces that must not change
// (ChatGPT, keyless discovery, the server card). Hints are in annotations.test.mjs.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import {
  MONITORS_KEY,
  SCOPED_KEY,
  TOOLS_LIST_BODY,
  VALID_KEY,
  WEBHOOKS_KEY,
  WEBHOOK_SECRET,
  chatgptPost,
  claims,
  connectClient,
  oat,
  rawPost,
  startFakeApi,
  startFakeIntrospection,
  startMcp,
  INTROSPECT_SECRET,
} from "./helpers/harness.mjs";

const WEBHOOK_TOOLS = [
  "spicrawl_webhooks_list", "spicrawl_webhook_get", "spicrawl_webhook_create", "spicrawl_webhook_update",
  "spicrawl_webhook_delete", "spicrawl_webhook_test", "spicrawl_webhook_rotate_secret", "spicrawl_webhook_deliveries",
];
const MONITOR_TOOLS = [
  "spicrawl_monitors_list", "spicrawl_monitor_get", "spicrawl_monitor_create", "spicrawl_monitor_update",
  "spicrawl_monitor_delete", "spicrawl_monitor_check", "spicrawl_monitor_changes", "spicrawl_monitor_pages",
];

let api;
let intro;
let mcp;
const clients = {};

before(async () => {
  api = await startFakeApi();
  intro = await startFakeIntrospection();
  mcp = await startMcp(api.url, { SPICRAWL_CHATGPT_ENABLED: "1", SPICRAWL_OAUTH_ISSUER: intro.url, SPICRAWL_OAUTH_INTROSPECT_SECRET: INTROSPECT_SECRET });
  for (const [name, key] of Object.entries({ plain: VALID_KEY, webhooks: WEBHOOKS_KEY, monitors: MONITORS_KEY, both: SCOPED_KEY })) {
    ({ client: clients[name] } = await connectClient(mcp.mcpURL, key));
  }
});

after(async () => {
  for (const c of Object.values(clients)) await c?.close().catch(() => {});
  await mcp?.stop();
  await intro?.close?.();
  await api?.close();
});

const names = async (c) => (await c.listTools()).tools.map((t) => t.name).sort();
const last = (method, path) => api.requests.filter((r) => r.method === method && r.path === path).at(-1);

/** Calls a tool on the both-scopes session and returns { res, req } where req is the API call it made. */
async function call(name, args, client = clients.both) {
  const before = api.requests.length;
  const res = await client.callTool({ name, arguments: args });
  return { res, reqs: api.requests.slice(before).filter((r) => r.path !== "/v1/key") };
}

describe("which tools each key scope is offered", () => {
  test("no scopes: brand is present, no webhook or monitor tool", async () => {
    const n = await names(clients.plain);
    assert.ok(n.includes("spicrawl_brand"));
    assert.equal(n.length, 28);
    for (const t of [...WEBHOOK_TOOLS, ...MONITOR_TOOLS]) assert.ok(!n.includes(t), t);
  });

  test("the webhooks scope adds exactly the webhook tools", async () => {
    const n = await names(clients.webhooks);
    assert.deepEqual(n.filter((t) => /webhook|monitor/.test(t)), [...WEBHOOK_TOOLS].sort());
    assert.equal(n.length, 28 + WEBHOOK_TOOLS.length);
  });

  test("the monitors scope adds exactly the monitor tools", async () => {
    const n = await names(clients.monitors);
    assert.deepEqual(n.filter((t) => /webhook|monitor/.test(t)), [...MONITOR_TOOLS].sort());
    assert.equal(n.length, 28 + MONITOR_TOOLS.length);
  });

  test("both scopes add both groups", async () => {
    assert.equal((await names(clients.both)).length, 28 + 16);
  });

  test("a scope-gated tool is refused on a key without the scope, without reaching the API", async () => {
    const before = api.requests.length;
    const res = await clients.plain.callTool({ name: "spicrawl_webhooks_list", arguments: {} }).catch((e) => ({ isError: true, e }));
    assert.equal(res.isError, true);
    assert.equal(api.requests.slice(before).filter((r) => r.path.startsWith("/v1/webhooks")).length, 0);
  });

  test("keyless discovery and the server card list neither group, and agree", async () => {
    const card = await (await fetch(`${mcp.base}/.well-known/mcp/server-card.json`)).json();
    const keyless = JSON.parse((await rawPost(mcp.mcpURL, { body: TOOLS_LIST_BODY })).text).result.tools;
    assert.deepEqual(keyless, card.tools);
    assert.equal(card.tools.length, 28);
    assert.ok(card.tools.some((t) => t.name === "spicrawl_brand"));
    assert.deepEqual(card.tools.filter((t) => /webhook|monitor/.test(t.name)), []);
  });

  test("the ChatGPT surface has no brand, webhook or monitor tool", async () => {
    const tok = oat("scoped");
    intro.tokens.set(tok, claims({ api_key: SCOPED_KEY }));
    const { json } = await chatgptPost(mcp.chatgptURL, { token: tok, body: { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} } });
    const listed = json.result.tools.map((t) => t.name);
    assert.ok(listed.length > 0);
    assert.deepEqual(listed.filter((n) => /brand|webhook|monitor/.test(n)), []);
  });
});

describe("spicrawl_brand", () => {
  test("posts the url and include, and returns the sections", async () => {
    const { res, reqs } = await call("spicrawl_brand", { url: "https://example.com", include: ["logos", "colors"] }, clients.plain);
    assert.deepEqual(reqs.map((r) => [r.method, r.path, r.body]), [["POST", "/v1/brand", { url: "https://example.com", include: ["logos", "colors"] }]]);
    assert.equal(res.structuredContent.identity.name, "Example");
  });

  test("an omitted include is not sent", async () => {
    const { reqs } = await call("spicrawl_brand", { url: "https://example.com" }, clients.plain);
    assert.deepEqual(reqs[0].body, { url: "https://example.com" });
  });

  test("an unknown section is refused before the API is called", async () => {
    const before = api.requests.length;
    const res = await clients.plain.callTool({ name: "spicrawl_brand", arguments: { url: "https://example.com", include: ["nope"] } }).catch((e) => ({ isError: true, e }));
    assert.equal(res.isError, true);
    assert.equal(api.requests.slice(before).filter((r) => r.path === "/v1/brand").length, 0);
  });
});

describe("webhook tools: request shape", () => {
  const cases = [
    ["spicrawl_webhooks_list", {}, "GET", "/v1/webhooks", undefined],
    ["spicrawl_webhook_get", { webhook_id: "wh_1" }, "GET", "/v1/webhooks/wh_1", undefined],
    ["spicrawl_webhook_create", { url: "https://example.com/hook", name: "ops", events: ["monitor.changed"], format: "slack" }, "POST", "/v1/webhooks", { url: "https://example.com/hook", name: "ops", events: ["monitor.changed"], format: "slack" }],
    ["spicrawl_webhook_update", { webhook_id: "wh_1", enabled: false, name: "z" }, "PATCH", "/v1/webhooks/wh_1", { enabled: false, name: "z" }],
    ["spicrawl_webhook_delete", { webhook_id: "wh_1" }, "DELETE", "/v1/webhooks/wh_1", undefined],
    ["spicrawl_webhook_test", { webhook_id: "wh_1" }, "POST", "/v1/webhooks/wh_1/test", undefined],
    ["spicrawl_webhook_rotate_secret", { webhook_id: "wh_1" }, "POST", "/v1/webhooks/wh_1/rotate-secret", undefined],
    ["spicrawl_webhook_deliveries", { webhook_id: "wh_1", limit: 5 }, "GET", "/v1/webhooks/wh_1/deliveries", undefined],
  ];
  for (const [tool, args, method, path, body] of cases) {
    test(`${tool} -> ${method} ${path}`, async () => {
      const { res, reqs } = await call(tool, args);
      assert.ok(!res.isError, JSON.stringify(res.content));
      assert.equal(reqs.length, 1);
      assert.equal(reqs[0].method, method);
      assert.equal(reqs[0].path, path);
      assert.deepEqual(reqs[0].body, body);
    });
  }

  test("deliveries sends limit as a query string", async () => {
    await call("spicrawl_webhook_deliveries", { webhook_id: "wh_1", limit: 5 });
    assert.equal(last("GET", "/v1/webhooks/wh_1/deliveries").query, "?limit=5");
  });

  test("an id with a slash is percent-encoded", async () => {
    await call("spicrawl_webhook_get", { webhook_id: "a/b" });
    assert.ok(api.requests.some((r) => r.path === "/v1/webhooks/a%2Fb"));
  });

  test("update with no field is refused without a request", async () => {
    const { res, reqs } = await call("spicrawl_webhook_update", { webhook_id: "wh_1" });
    assert.equal(res.isError, true);
    assert.equal(reqs.length, 0);
  });

  test("a non-https url is refused", async () => {
    const res = await clients.both.callTool({ name: "spicrawl_webhook_create", arguments: { url: "http://example.com/h" } }).catch((e) => ({ isError: true, e }));
    assert.equal(res.isError, true);
  });

  test("delete reports deleted", async () => {
    const { res } = await call("spicrawl_webhook_delete", { webhook_id: "wh_1" });
    assert.deepEqual(res.structuredContent, { deleted: true, webhook_id: "wh_1" });
  });

  test("create and rotate return the secret, and say it is shown once", async () => {
    const tools = (await clients.both.listTools()).tools;
    for (const [tool, args] of [
      ["spicrawl_webhook_create", { url: "https://example.com/hook" }],
      ["spicrawl_webhook_rotate_secret", { webhook_id: "wh_1" }],
    ]) {
      const { res } = await call(tool, args);
      assert.equal(res.structuredContent.secret, WEBHOOK_SECRET, tool);
      assert.ok(res.content[0].text.includes(WEBHOOK_SECRET), tool);
      const def = tools.find((t) => t.name === tool);
      assert.match(def.description, /shown only in this result/i, tool);
      assert.match(JSON.stringify(def.outputSchema), /Shown only in this result/, tool);
    }
    assert.match(tools.find((t) => t.name === "spicrawl_webhook_create").description, /never again/);
  });

  test("get and list never carry a secret", async () => {
    const { res } = await call("spicrawl_webhook_get", { webhook_id: "wh_1" });
    assert.equal(res.structuredContent.secret, undefined);
  });
});

describe("monitor tools: request shape", () => {
  const create = { url: "https://example.com/", webhook_endpoint_id: "wh_1", interval_seconds: 3600, scope: "site", max_pages: 50, js_render: true };
  const cases = [
    ["spicrawl_monitors_list", {}, "GET", "/v1/monitors", undefined],
    ["spicrawl_monitor_get", { monitor_id: "mon_1" }, "GET", "/v1/monitors/mon_1", undefined],
    ["spicrawl_monitor_create", create, "POST", "/v1/monitors", create],
    ["spicrawl_monitor_update", { monitor_id: "mon_1", interval_seconds: 600, selector: null }, "PATCH", "/v1/monitors/mon_1", { interval_seconds: 600, selector: null }],
    ["spicrawl_monitor_delete", { monitor_id: "mon_1" }, "DELETE", "/v1/monitors/mon_1", undefined],
    ["spicrawl_monitor_check", { monitor_id: "mon_1" }, "POST", "/v1/monitors/mon_1/check", undefined],
    ["spicrawl_monitor_changes", { monitor_id: "mon_1", limit: 10 }, "GET", "/v1/monitors/mon_1/changes", undefined],
    ["spicrawl_monitor_pages", { monitor_id: "mon_1", limit: 100, cursor: "cur 1" }, "GET", "/v1/monitors/mon_1/pages", undefined],
  ];
  for (const [tool, args, method, path, body] of cases) {
    test(`${tool} -> ${method} ${path}`, async () => {
      const { res, reqs } = await call(tool, args);
      assert.ok(!res.isError, JSON.stringify(res.content));
      assert.equal(reqs.length, 1);
      assert.equal(reqs[0].method, method);
      assert.equal(reqs[0].path, path);
      assert.deepEqual(reqs[0].body, body);
    });
  }

  test("changes and pages send limit and cursor as a query string", async () => {
    await call("spicrawl_monitor_changes", { monitor_id: "mon_1", limit: 10 });
    assert.equal(last("GET", "/v1/monitors/mon_1/changes").query, "?limit=10");
    await call("spicrawl_monitor_pages", { monitor_id: "mon_1", limit: 100, cursor: "cur 1" });
    assert.equal(last("GET", "/v1/monitors/mon_1/pages").query, "?limit=100&cursor=cur+1");
  });

  test("pages returns next_cursor for the next call", async () => {
    const { res } = await call("spicrawl_monitor_pages", { monitor_id: "mon_1" });
    assert.equal(res.structuredContent.next_cursor, "cur2");
  });

  test("update with no field is refused without a request", async () => {
    const { res, reqs } = await call("spicrawl_monitor_update", { monitor_id: "mon_1" });
    assert.equal(res.isError, true);
    assert.equal(reqs.length, 0);
  });

  test("delete reports deleted", async () => {
    const { res } = await call("spicrawl_monitor_delete", { monitor_id: "mon_1" });
    assert.deepEqual(res.structuredContent, { deleted: true, monitor_id: "mon_1" });
  });

  test("check returns the outcome", async () => {
    const { res } = await call("spicrawl_monitor_check", { monitor_id: "mon_1" });
    assert.equal(res.structuredContent.outcome, "unchanged");
  });
});
