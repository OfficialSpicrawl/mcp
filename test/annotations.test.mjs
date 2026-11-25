// Tool metadata through a real MCP session: every tool states a human-readable title and
// explicit readOnlyHint / destructiveHint / openWorldHint booleans (the form directories
// such as OpenAI's plugin review require), the opt-in that hides what is not available
// yet, and the wording of what a tool tells the model.

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { after, before, describe, test } from "node:test";
import { hideUnavailableFromEnv } from "../dist/server.js";
import { PARTNER_KEY, SCOPED_KEY, QUOTA_DETAIL, QUOTA_DOC_URL, connectClient, forbiddenIn, startFakeApi, startMcp } from "./helpers/harness.mjs";

// The value of every hint, with the reason. Change a row only with its reason.
//
// readOnly    true: only retrieves or computes. false: creates, changes or ends something, starts
//             or queues work, or can write to a third party.
// destructive false for every read-only tool. true: deletes, cancels or purges, irreversibly.
// openWorld   true: reaches public or open-ended entities (any URL, the public docs site).
//             false: confined to the caller's own Spicrawl account.
//
// [title, readOnly, destructive, openWorld]
const TOOLS = {
  // `method` accepts POST/PUT/PATCH/DELETE and `actions` click, fill and run scripts, so a call can
  // submit a form on a third-party site: not read-only. A plain call is additive: not destructive.
  spicrawl_scrape: ["Scrape a URL", false, false, true],

  // Renders one public page and returns its brand links and values; creates nothing, but bills each call.
  spicrawl_brand: ["Extract a site's brand", true, false, true],

  // Queues work that fetches arbitrary public URLs.
  spicrawl_batch_submit: ["Submit a batch scrape job", false, false, true],
  // Reads of the caller's own jobs and their stored results.
  spicrawl_batch_list: ["List batch jobs", true, false, false],
  spicrawl_batch_status: ["Check a batch job's status", true, false, false],
  spicrawl_batch_results: ["Read a batch job's results", true, false, false],
  spicrawl_batch_task_content: ["Read one batch item's content", true, false, false],
  // Unstarted items never run and cannot be revived: cancellation.
  spicrawl_batch_cancel: ["Cancel a batch job", false, true, false],
  // Re-queues failed items, which fetch their public URLs again. Failed items hold no content.
  spicrawl_batch_retry: ["Retry a batch job's failed items", false, false, true],
  // Appends new, arbitrary URLs to a job.
  spicrawl_batch_add_items: ["Add URLs to an open batch job", false, false, true],
  // A one-way state change, but nothing is lost: the job completes normally.
  spicrawl_batch_close: ["Close an open batch job", false, false, false],

  // Creates a record in the caller's own account.
  spicrawl_session_create: ["Create a browsing session", false, false, false],
  spicrawl_session_list: ["List sessions", true, false, false],
  spicrawl_session_get: ["Get a session", true, false, false],
  // Returns the stored cookies; reads only.
  spicrawl_session_context: ["Dump a session's stored context", true, false, false],
  // Purges the stored cookies and storage for good.
  spicrawl_session_release: ["Release a session", false, true, false],
  spicrawl_session_delete: ["Delete a session", false, true, false],

  spicrawl_usage: ["Usage breakdown", true, false, false],
  spicrawl_usage_summary: ["Usage summary", true, false, false],
  spicrawl_usage_reconciliation: ["Usage reconciliation", true, false, false],
  spicrawl_requests_list: ["List recent requests", true, false, false],
  spicrawl_request_get: ["Get one request", true, false, false],

  // Mints a token and opens a browser that can go anywhere on the web.
  spicrawl_browser_connect_url: ["Browser (CDP) connect URL", false, false, true],
  // Mints a single-use viewer link to that browser.
  spicrawl_browser_live_view: ["Live view link for a remote browser", false, false, true],
  // Reads or flips who drives the session; same call, same state.
  spicrawl_browser_control: ["Who controls a remote browser", false, false, false],

  // Reads the public docs site.
  spicrawl_docs_search: ["Search the Spicrawl docs", true, false, true],
  spicrawl_docs_read: ["Read a Spicrawl docs page", true, false, true],
  spicrawl_docs_index: ["List the Spicrawl docs", true, false, true],
};

const BROWSER = "spicrawl_browser_connect_url";

// Offered only to a key with the `webhooks` / `monitors` scope. Same columns as TOOLS.
// Both groups act on the caller's own account, except a ping or a check, which fetches or posts
// to a third-party URL (open world). A delete is irreversible, so destructive. A rotation is
// declared a plain write: the old secret stops verifying, but the endpoint and its history stay.
const WEBHOOK_TOOLS = {
  spicrawl_webhooks_list: ["List webhook endpoints", true, false, false],
  spicrawl_webhook_get: ["Get a webhook endpoint", true, false, false],
  spicrawl_webhook_create: ["Create a webhook endpoint", false, false, false],
  spicrawl_webhook_update: ["Update a webhook endpoint", false, false, false],
  spicrawl_webhook_delete: ["Delete a webhook endpoint", false, true, false],
  spicrawl_webhook_test: ["Send a test ping", false, false, true],
  spicrawl_webhook_rotate_secret: ["Rotate a webhook secret", false, false, false],
  spicrawl_webhook_deliveries: ["Recent webhook deliveries", true, false, false],
};
const MONITOR_TOOLS = {
  spicrawl_monitors_list: ["List monitors", true, false, false],
  spicrawl_monitor_get: ["Get a monitor", true, false, false],
  spicrawl_monitor_create: ["Create a monitor", false, false, false],
  spicrawl_monitor_update: ["Update a monitor", false, false, false],
  spicrawl_monitor_delete: ["Delete a monitor", false, true, false],
  spicrawl_monitor_check: ["Check a monitor now", false, false, true],
  spicrawl_monitor_changes: ["Monitor change history", true, false, false],
  spicrawl_monitor_pages: ["Pages of a site monitor", true, false, false],
};

// The partner profile (a partner key): the partner tools and the three docs tools. Same
// columns as TOOLS. Partner tools are confined to the caller's own account (openWorld false).
const PARTNER_TOOLS = {
  spicrawl_partner_summary: ["Partner account summary", true, false, false],
  spicrawl_partner_balance: ["Partner balance", true, false, false],
  spicrawl_partner_users_list: ["List partner users", true, false, false],
  spicrawl_partner_user_get: ["Get a partner user", true, false, false],
  spicrawl_partner_usage: ["Partner usage", true, false, false],
  spicrawl_partner_user_usage: ["Usage for one partner user", true, false, false],
  spicrawl_partner_tiers_list: ["List partner tiers", true, false, false],
  // Creates or changes a record in the partner's own account; nothing is deleted.
  spicrawl_partner_tier_create: ["Create a partner tier", false, false, false],
  spicrawl_partner_tier_update: ["Update a partner tier", false, false, false],
  spicrawl_partner_user_set_tier: ["Move a partner user to a tier", false, false, false],
  spicrawl_partner_user_update: ["Rename a partner user", false, false, false],
  spicrawl_partner_user_reactivate: ["Reactivate a partner user", false, false, false],
  // Moves credits that cannot be taken back through this server.
  spicrawl_partner_give_credits: ["Give credits to a partner user", false, true, false],
  // Refused while users are on the tier; the tier's limits are gone for good.
  spicrawl_partner_tier_delete: ["Delete a partner tier", false, true, false],
  // Stops a user's key within about a minute; reversible only by reactivating.
  spicrawl_partner_user_suspend: ["Suspend a partner user", false, true, false],
};
for (const name of ["spicrawl_docs_search", "spicrawl_docs_read", "spicrawl_docs_index"]) PARTNER_TOOLS[name] = TOOLS[name];

// Arguments marked "Coming soon" in their description, per tool.
const COMING_SOON_ARGS = {
  spicrawl_scrape: ["ai_extract", "premium_proxy", "proxy_country", "stealth", "sticky_key", "extract_preset"],
  spicrawl_batch_submit: ["premium_proxy", "proxy_country"],
  spicrawl_batch_add_items: ["premium_proxy", "proxy_country"],
  spicrawl_session_create: ["sticky_key", "rotate_ip", "region_pool", "premium_proxy", "proxy_country", "fingerprint"],
};

let api;
let mcp;
let client;
let hiddenMcp;
let hiddenClient;
let tools;
let hiddenTools;
let partnerClient;
let partnerTools;
let scopedTools;

before(async () => {
  api = await startFakeApi();
  mcp = await startMcp(api.url);
  hiddenMcp = await startMcp(api.url, { SPICRAWL_MCP_HIDE_UNAVAILABLE: "1" });
  ({ client } = await connectClient(mcp.mcpURL));
  ({ client: hiddenClient } = await connectClient(hiddenMcp.mcpURL));
  ({ client: partnerClient } = await connectClient(mcp.mcpURL, PARTNER_KEY));
  tools = (await client.listTools()).tools;
  hiddenTools = (await hiddenClient.listTools()).tools;
  partnerTools = (await partnerClient.listTools()).tools;
  const { client: scopedClient } = await connectClient(mcp.mcpURL, SCOPED_KEY);
  scopedTools = (await scopedClient.listTools()).tools;
  await scopedClient.close().catch(() => {});
});

after(async () => {
  await client?.close().catch(() => {});
  await hiddenClient?.close().catch(() => {});
  await partnerClient?.close().catch(() => {});
  await mcp?.stop();
  await hiddenMcp?.stop();
  await api?.close();
});

const byName = (list) => Object.fromEntries(list.map((t) => [t.name, t]));

/** Every `description` in a JSON Schema, depth first. */
function descriptions(schema, out = []) {
  if (schema && typeof schema === "object") {
    if (typeof schema.description === "string") out.push(schema.description);
    for (const v of Object.values(schema)) descriptions(v, out);
  }
  return out;
}

const hints = (t) => [t.title, t.annotations.readOnlyHint, t.annotations.destructiveHint, t.annotations.openWorldHint];

describe("tool annotations and titles", () => {
  test("the table lists exactly the 28 registered tools", () => {
    assert.equal(Object.keys(TOOLS).length, 28);
    assert.deepEqual(tools.map((t) => t.name).sort(), Object.keys(TOOLS).sort());
  });

  test("every tool has a human-readable title and the three hints as explicit booleans", () => {
    for (const t of tools) {
      assert.equal(typeof t.title, "string", `${t.name}: no title`);
      assert.ok(t.title.trim().length >= 3 && t.title !== t.name, `${t.name}: title ${JSON.stringify(t.title)} is not human-readable`);
      for (const hint of ["readOnlyHint", "destructiveHint", "openWorldHint"]) {
        assert.equal(typeof t.annotations?.[hint], "boolean", `${t.name}: ${hint} is not an explicit boolean`);
      }
    }
  });

  test("each tool's title and hints are the ones in the table", () => {
    const wrong = [];
    for (const t of tools) {
      const want = TOOLS[t.name];
      if (JSON.stringify(hints(t)) !== JSON.stringify(want)) {
        wrong.push(`${t.name}: got ${JSON.stringify(hints(t))}, want ${JSON.stringify(want)}`);
      }
    }
    assert.deepEqual(wrong, []);
  });

  test("a read-only tool is never destructive", () => {
    for (const t of tools) {
      assert.ok(!(t.annotations.readOnlyHint && t.annotations.destructiveHint), `${t.name} is both read-only and destructive`);
    }
  });

  test("the destructive tools are the ones that cancel, purge or delete", () => {
    const destructive = tools.filter((t) => t.annotations.destructiveHint).map((t) => t.name).sort();
    assert.deepEqual(destructive, ["spicrawl_batch_cancel", "spicrawl_session_delete", "spicrawl_session_release"]);
  });
});

describe("what tools say about themselves", () => {
  test("no description or argument description has commerce or competitor wording", () => {
    // "upgrade" alone is not enough: the browser tool's description names the WebSocket upgrade.
    const bad = /\bupgrade\s+(your|now|to|plan|account)\b|\b(checkout|subscribe|subscription|purchase|top[- ]?up|firecrawl|scrapingbee|apify)\b/i;
    for (const t of tools) {
      for (const d of [t.description ?? "", ...descriptions(t.inputSchema)]) {
        assert.doesNotMatch(d, bad, `${t.name}: ${d.slice(0, 120)}`);
      }
    }
  });

  test("tools/list names no internal engine or browser tooling, in either listing", () => {
    // The whole listing (names, titles, descriptions, every schema), not just the descriptions.
    assert.deepEqual(forbiddenIn(tools), [], "default listing");
    assert.deepEqual(forbiddenIn(hiddenTools), [], "SPICRAWL_MCP_HIDE_UNAVAILABLE=1 listing");
  });

  test("the files npm publishes (dist, README, CHANGELOG, package.json, server.json) name none either", () => {
    const root = new URL("../", import.meta.url);
    const files = [
      ...readdirSync(new URL("dist/", root), { recursive: true })
        .filter((f) => f.endsWith(".js"))
        .map((f) => `dist/${f}`),
      "README.md", "CHANGELOG.md", "package.json", "server.json",
    ];
    assert.ok(files.length > 4, "no dist files found: did the build run?");
    for (const f of files) assert.deepEqual(forbiddenIn(readFileSync(new URL(f, root), "utf8")), [], f);
  });

  test("the only engine choices left are the public rendering tiers", () => {
    const listed = byName(tools);
    for (const name of ["spicrawl_scrape", "spicrawl_batch_submit", "spicrawl_batch_add_items"]) {
      const props = listed[name].inputSchema.properties;
      assert.ok(!("engine" in props) && !("headless" in props), `${name} still takes engine or headless`);
    }
    assert.deepEqual(listed.spicrawl_session_create.inputSchema.properties.engine.enum, ["fetch", "js", "browser"]);
    assert.deepEqual(listed.spicrawl_session_list.inputSchema.properties.engine.enum, ["fetch", "js", "browser"]);
    const connect = listed[BROWSER].inputSchema.properties;
    assert.deepEqual(connect.engine.enum, ["browser", "js"]);
    assert.ok(!("headless" in connect), "the browser tool still takes headless");
  });

  test("the scrape description does not claim a `meta` object the API does not return", () => {
    assert.doesNotMatch(byName(tools).spicrawl_scrape.description, /`meta`/);
  });

  test("an out-of-credit error carries the API's explanation and its docs link, and nothing else", async () => {
    const res = await client.callTool({ name: "spicrawl_scrape", arguments: { url: "https://over-quota.test/" } });
    assert.equal(res.isError, true);
    const text = res.content.map((c) => c.text).join("\n");
    assert.equal(text, `ERR::LIMIT::QUOTA_EXCEEDED: ${QUOTA_DETAIL}\nSee ${QUOTA_DOC_URL}`);
    assert.doesNotMatch(text, /upgrade|checkout|subscribe|purchase|top[- ]?up|billing/i);
    assert.match(QUOTA_DOC_URL, /\/errors#LIMIT_QUOTA_EXCEEDED$/, "the link is the errors page entry, not a checkout page");
  });
});

describe("by default, everything is listed", () => {
  test("the browser tool and the coming-soon arguments are present", () => {
    const listed = byName(tools);
    assert.ok(listed[BROWSER], "the browser tool is not registered");
    for (const [name, args] of Object.entries(COMING_SOON_ARGS)) {
      for (const arg of args) {
        const prop = listed[name].inputSchema.properties[arg];
        assert.ok(prop, `${name} has no ${arg}`);
        assert.match(prop.description, /^Coming soon:/, `${name}.${arg} is not marked coming soon`);
      }
    }
  });

  test("only 1, true, yes or on (any case) turn SPICRAWL_MCP_HIDE_UNAVAILABLE on", () => {
    for (const v of [undefined, "", "0", "false", "no", "off", "2", "maybe"]) {
      assert.equal(hideUnavailableFromEnv({ SPICRAWL_MCP_HIDE_UNAVAILABLE: v }), false, JSON.stringify(v));
    }
    for (const v of ["1", "true", "TRUE", "yes", "on", " 1 "]) {
      assert.equal(hideUnavailableFromEnv({ SPICRAWL_MCP_HIDE_UNAVAILABLE: v }), true, JSON.stringify(v));
    }
  });
});

describe("SPICRAWL_MCP_HIDE_UNAVAILABLE=1", () => {
  test("every tool is registered, the browser tools included, with their hints unchanged", () => {
    assert.deepEqual(hiddenTools.map((t) => t.name).sort(), Object.keys(TOOLS).sort());
    for (const t of hiddenTools) assert.deepEqual(hints(t), TOOLS[t.name], t.name);
  });

  test("every argument marked coming soon is gone from the schemas, and the rest are kept", () => {
    const listed = byName(hiddenTools);
    for (const [name, args] of Object.entries(COMING_SOON_ARGS)) {
      for (const arg of args) assert.ok(!(arg in listed[name].inputSchema.properties), `${name} still has ${arg}`);
    }
    for (const t of hiddenTools) {
      for (const [arg, schema] of Object.entries(t.inputSchema.properties ?? {})) {
        assert.doesNotMatch(schema.description ?? "", /^Coming soon:/, `${t.name}.${arg}`);
      }
      assert.equal(t.inputSchema.additionalProperties, false, `${t.name} lost its strict schema`);
    }
    const scrape = listed.spicrawl_scrape.inputSchema.properties;
    for (const arg of ["url", "render", "extract", "autoparse", "proxy", "session_id", "actions"]) {
      assert.ok(arg in scrape, `spicrawl_scrape lost ${arg}`);
    }
    assert.ok("render" in listed.spicrawl_batch_submit.inputSchema.properties);
    assert.ok("session_context" in listed.spicrawl_session_create.inputSchema.properties);
  });

  test("the scrape description no longer mentions ai_extract, which is not in its schema", () => {
    const hidden = byName(hiddenTools).spicrawl_scrape.description;
    assert.doesNotMatch(hidden, /ai_extract/);
    assert.match(hidden, /`autoparse`/);
    assert.match(byName(tools).spicrawl_scrape.description, /ai_extract/, "the default listing still announces it");
  });

  test("sending a hidden argument is refused by name, and no API call is made", async () => {
    const before = api.requests.length;
    const res = await hiddenClient
      .callTool({ name: "spicrawl_scrape", arguments: { url: "https://example.com", ai_extract: { prompt: "the price" } } })
      .catch((rpcError) => ({ rpcError }));
    const message = res.rpcError ? res.rpcError.message : res.content.map((c) => c.text).join("\n");
    assert.ok(res.rpcError || res.isError, `expected a validation error; got ${message}`);
    assert.match(message, /ai_extract/);
    assert.equal(api.requests.length, before, "the fake API must not receive a request");
  });

  test("a call with only available arguments still reaches the API", async () => {
    const scrapes = () => api.requests.filter((r) => r.path === "/v1/scrape");
    const before = scrapes().length;
    const res = await hiddenClient.callTool({ name: "spicrawl_scrape", arguments: { url: "https://example.com", render: true } });
    assert.equal(res.isError ?? false, false, res.content?.[0]?.text);
    const sent = scrapes().slice(before);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].body.js_render, true);
    assert.equal(sent[0].body.ai_extract, undefined);
    assert.equal(sent[0].body.premium_proxy, undefined);
  });
});

describe("partner profile tool annotations", () => {
  test("a partner key is offered exactly the partner tools and the three docs tools", () => {
    assert.equal(Object.keys(PARTNER_TOOLS).length, 18);
    assert.deepEqual(partnerTools.map((t) => t.name).sort(), Object.keys(PARTNER_TOOLS).sort());
  });

  test("every partner tool has a title and the three hints as explicit booleans", () => {
    for (const t of partnerTools) {
      assert.ok(t.title.trim().length >= 3 && t.title !== t.name, `${t.name}: title ${JSON.stringify(t.title)}`);
      for (const hint of ["readOnlyHint", "destructiveHint", "openWorldHint"]) {
        assert.equal(typeof t.annotations?.[hint], "boolean", `${t.name}: ${hint} is not an explicit boolean`);
      }
    }
  });

  test("each partner tool's title and hints are the ones in the table", () => {
    const wrong = [];
    for (const t of partnerTools) {
      if (JSON.stringify(hints(t)) !== JSON.stringify(PARTNER_TOOLS[t.name])) {
        wrong.push(`${t.name}: got ${JSON.stringify(hints(t))}, want ${JSON.stringify(PARTNER_TOOLS[t.name])}`);
      }
    }
    assert.deepEqual(wrong, []);
  });

  test("the destructive partner tools are the ones that move credits, delete a tier or suspend a user", () => {
    const destructive = partnerTools.filter((t) => t.annotations.destructiveHint).map((t) => t.name).sort();
    assert.deepEqual(destructive, ["spicrawl_partner_give_credits", "spicrawl_partner_tier_delete", "spicrawl_partner_user_suspend"]);
  });

  test("the standard listing keeps exactly its 28 tools, and no partner tool is in it", () => {
    assert.equal(tools.length, 28);
    assert.deepEqual(tools.filter((t) => t.name.startsWith("spicrawl_partner_")), []);
  });
});

describe("webhook and monitor tool annotations (key with both scopes)", () => {
  const SCOPED = { ...WEBHOOK_TOOLS, ...MONITOR_TOOLS };
  const scoped = () => scopedTools.filter((t) => t.name in SCOPED);

  test("a key with both scopes is offered the 28 standard tools plus every webhook and monitor tool", () => {
    assert.equal(scopedTools.length, 28 + Object.keys(SCOPED).length);
    assert.deepEqual(scoped().map((t) => t.name).sort(), Object.keys(SCOPED).sort());
  });

  test("each title and the three hints are the ones in the table", () => {
    const wrong = [];
    for (const t of scoped()) {
      if (JSON.stringify(hints(t)) !== JSON.stringify(SCOPED[t.name])) wrong.push(`${t.name}: got ${JSON.stringify(hints(t))}, want ${JSON.stringify(SCOPED[t.name])}`);
    }
    assert.deepEqual(wrong, []);
  });

  test("idempotentHint: reads and updates are idempotent; creates, tests, checks and rotations are not", () => {
    const idem = Object.fromEntries(scoped().map((t) => [t.name, t.annotations.idempotentHint]));
    const yes = ["spicrawl_webhooks_list", "spicrawl_webhook_get", "spicrawl_webhook_update", "spicrawl_webhook_deliveries", "spicrawl_monitors_list", "spicrawl_monitor_get", "spicrawl_monitor_update", "spicrawl_monitor_changes", "spicrawl_monitor_pages"];
    for (const name of Object.keys(SCOPED)) assert.equal(idem[name], yes.includes(name), name);
  });

  test("the destructive scoped tools are the two deletes", () => {
    assert.deepEqual(scoped().filter((t) => t.annotations.destructiveHint).map((t) => t.name).sort(), ["spicrawl_monitor_delete", "spicrawl_webhook_delete"]);
  });

  test("every scoped tool has an outputSchema and no description names internal tooling", () => {
    for (const t of scoped()) {
      assert.ok(t.outputSchema, `${t.name}: no outputSchema`);
      assert.deepEqual(forbiddenIn([t.description, t.inputSchema]), [], t.name);
    }
  });
});
