// The partner profile: which tools a partner key is offered, the fallback when GET /v1/key
// cannot answer, each partner tool's request and result, give-credits edge cases, the usage
// arithmetic, strict arguments and the wording rules. Tool hints are in annotations.test.mjs.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, test } from "node:test";
import { toolProfile } from "../dist/profile.js";
import {
  INITIALIZE_BODY,
  PARTNER_KEY,
  TOOLS_LIST_BODY,
  VALID_KEY,
  connectClient,
  forbiddenIn,
  rawPost,
  startFakeApi,
  startMcp,
} from "./helpers/harness.mjs";

const STANDARD = [
  "spicrawl_scrape", "spicrawl_brand", "spicrawl_batch_submit", "spicrawl_batch_list", "spicrawl_batch_status", "spicrawl_batch_results",
  "spicrawl_batch_task_content", "spicrawl_batch_cancel", "spicrawl_batch_retry", "spicrawl_batch_add_items", "spicrawl_batch_close",
  "spicrawl_session_create", "spicrawl_session_list", "spicrawl_session_get", "spicrawl_session_context", "spicrawl_session_release",
  "spicrawl_session_delete", "spicrawl_usage", "spicrawl_usage_summary", "spicrawl_usage_reconciliation", "spicrawl_requests_list",
  "spicrawl_request_get", "spicrawl_browser_connect_url", "spicrawl_browser_live_view", "spicrawl_browser_control",
  "spicrawl_docs_search", "spicrawl_docs_read", "spicrawl_docs_index",
  "spicrawl_feedback",
];
const PARTNER_NAMES = [
  "spicrawl_partner_summary", "spicrawl_partner_balance", "spicrawl_partner_users_list", "spicrawl_partner_user_get",
  "spicrawl_partner_usage", "spicrawl_partner_user_usage", "spicrawl_partner_tiers_list", "spicrawl_partner_tier_create",
  "spicrawl_partner_tier_update", "spicrawl_partner_user_set_tier", "spicrawl_partner_user_update",
  "spicrawl_partner_user_reactivate", "spicrawl_partner_give_credits", "spicrawl_partner_tier_delete", "spicrawl_partner_user_suspend",
];
const DOCS = ["spicrawl_docs_search", "spicrawl_docs_read", "spicrawl_docs_index"];

let api;
let mcp;
let partner;
let ordinary;

before(async () => {
  api = await startFakeApi();
  mcp = await startMcp(api.url);
  ({ client: partner } = await connectClient(mcp.mcpURL, PARTNER_KEY));
  ({ client: ordinary } = await connectClient(mcp.mcpURL, VALID_KEY));
});

after(async () => {
  await partner?.close().catch(() => {});
  await ordinary?.close().catch(() => {});
  await mcp?.stop();
  await api?.close();
});

const names = (list) => list.map((t) => t.name).sort();
const apiCalls = (method, path) => api.requests.filter((r) => r.method === method && r.path === path);
const lastCall = (method, path) => apiCalls(method, path).at(-1);
const textOf = (res) => (res.content ?? []).map((c) => c.text).join("\n");

/** Calls a partner tool; a JSON-RPC error comes back as { rpcError } and the message as text. */
async function call(name, args, client = partner) {
  try {
    return await client.callTool({ name, arguments: args });
  } catch (err) {
    return { rpcError: err, isError: true, content: [{ type: "text", text: err.message }] };
  }
}

/** Every `description` in a JSON Schema, depth first. */
function descriptions(schema, out = []) {
  if (schema && typeof schema === "object") {
    if (typeof schema.description === "string") out.push(schema.description);
    for (const v of Object.values(schema)) descriptions(v, out);
  }
  return out;
}

describe("the profile decision", () => {
  test("only a partner key with the partner scope is the partner profile", () => {
    assert.equal(toolProfile({ partner: true, scopes: ["partner", "read"] }), "partner");
  });

  test("anything else is the standard profile", () => {
    for (const info of [
      null,
      undefined,
      {},
      { partner: true, scopes: ["read"] },
      { partner: false, scopes: ["partner", "read"] },
      { partner: "yes", scopes: ["partner"] },
      { partner: true, scopes: "partner" },
      { partner: true },
      { scopes: ["partner"] },
    ]) {
      assert.equal(toolProfile(info), "standard", JSON.stringify(info));
    }
  });
});

describe("which tools a session is offered", () => {
  test("an ordinary key gets the 29 standard tools and no partner tool", async () => {
    const { tools } = await ordinary.listTools();
    assert.deepEqual(names(tools), [...STANDARD].sort());
    assert.equal(tools.length, 29);
    assert.deepEqual(tools.filter((t) => t.name.startsWith("spicrawl_partner_")), []);
  });

  test("a partner key gets exactly the partner tools and the docs tools", async () => {
    const { tools } = await partner.listTools();
    assert.deepEqual(names(tools), [...PARTNER_NAMES, ...DOCS].sort());
  });

  test("a partner key is offered no scrape, batch, session, usage or browser tool", async () => {
    const { tools } = await partner.listTools();
    const offered = new Set(tools.map((t) => t.name));
    for (const name of STANDARD.filter((n) => !DOCS.includes(n))) assert.ok(!offered.has(name), name);
    const before = api.requests.length;
    const res = await call("spicrawl_scrape", { url: "https://example.com" });
    assert.equal(res.isError, true, "a scrape must not run for a partner session");
    assert.equal(api.requests.length, before, "nothing reached the API");
  });

  test("keyless discovery and the server card still list the 29 standard tools and no partner tool", async () => {
    const card = await (await fetch(`${mcp.base}/.well-known/mcp/server-card.json`)).json();
    assert.equal(card.tools.length, 29);
    assert.deepEqual(card.tools.filter((t) => t.name.startsWith("spicrawl_partner_")), []);
    const keyless = await rawPost(mcp.mcpURL, { body: TOOLS_LIST_BODY });
    const listed = JSON.parse(keyless.text).result.tools;
    assert.deepEqual(listed, card.tools);
    assert.deepEqual(listed.filter((t) => t.name.startsWith("spicrawl_partner_")), []);
    const init = await rawPost(mcp.mcpURL, { body: INITIALIZE_BODY });
    assert.equal(init.res.status, 200);
  });
});

describe("when GET /v1/key cannot answer, the session gets the standard tools and opens", () => {
  for (const [mode, timeout] of [["404", 20_000], ["500", 20_000], ["hang", 30_000]]) {
    test(`GET /v1/key answering ${mode}`, { timeout }, async () => {
      api.keyRoute = mode;
      let client;
      try {
        ({ client } = await connectClient(mcp.mcpURL, PARTNER_KEY));
        const { tools } = await client.listTools();
        assert.deepEqual(names(tools), [...STANDARD].sort());
        assert.deepEqual(tools.filter((t) => t.name.startsWith("spicrawl_partner_")), []);
      } finally {
        await client?.close().catch(() => {});
        api.keyRoute = "ok";
      }
    });
  }
});

describe("each partner tool sends its request and maps the result", () => {
  test("spicrawl_partner_summary reads the summary", async () => {
    const res = await call("spicrawl_partner_summary", {});
    assert.equal(res.isError ?? false, false, textOf(res));
    assert.equal(lastCall("GET", "/v1/partner/summary").auth, `Bearer ${PARTNER_KEY}`);
    assert.equal(res.structuredContent.partner, true);
    assert.equal(res.structuredContent.balance.balance_credits, 880);
  });

  test("spicrawl_partner_balance reads the balance from the balance route", async () => {
    const res = await call("spicrawl_partner_balance", {});
    assert.equal(res.isError ?? false, false, textOf(res));
    assert.ok(apiCalls("GET", "/v1/partner/wallet").length > 0);
    assert.equal(res.structuredContent.balance_credits, 880);
    assert.equal(res.structuredContent.available_micro, 880000000);
  });

  test("spicrawl_partner_users_list sends the query and maps the page", async () => {
    const res = await call("spicrawl_partner_users_list", { limit: 5, q: "user-4", sort: "external_user_id" });
    assert.equal(res.isError ?? false, false, textOf(res));
    const sent = lastCall("GET", "/v1/partner/workspaces");
    const qs = new URLSearchParams(sent.query);
    assert.equal(qs.get("limit"), "5");
    assert.equal(qs.get("q"), "user-4");
    assert.equal(qs.get("sort"), "external_user_id");
    assert.equal(qs.has("after"), false);
    assert.equal(res.structuredContent.workspaces.length, 2);
  });

  test("spicrawl_partner_user_get percent-encodes the id in the path", async () => {
    const res = await call("spicrawl_partner_user_get", { external_user_id: "acct:7.eu_west" });
    assert.equal(res.isError ?? false, false, textOf(res));
    assert.equal(lastCall("GET", "/v1/partner/workspaces/acct%3A7.eu_west").path, "/v1/partner/workspaces/acct%3A7.eu_west");
    assert.equal(res.structuredContent.external_user_id, "acct:7.eu_west");
    assert.equal(res.structuredContent.display_name, "EU account");
  });

  test("spicrawl_partner_usage sends group_by, the window, limit, sort and offset", async () => {
    const res = await call("spicrawl_partner_usage", {
      group_by: "workspace", from: "2026-11-01", to: "2026-11-03", limit: 10, sort: "credits", offset: 0,
    });
    assert.equal(res.isError ?? false, false, textOf(res));
    const qs = new URLSearchParams(lastCall("GET", "/v1/partner/usage").query);
    assert.equal(qs.get("group_by"), "workspace");
    assert.equal(qs.get("from"), "2026-11-01");
    assert.equal(qs.get("to"), "2026-11-03");
    assert.equal(qs.get("limit"), "10");
    assert.equal(qs.get("sort"), "credits");
    assert.equal(qs.get("offset"), "0");
    assert.equal(res.structuredContent.rows.length, 2);
  });

  test("spicrawl_partner_user_usage reads one user's usage with the window", async () => {
    const res = await call("spicrawl_partner_user_usage", { external_user_id: "acct:7.eu_west", from: "2026-11-01", to: "2026-11-03" });
    assert.equal(res.isError ?? false, false, textOf(res));
    const sent = lastCall("GET", "/v1/partner/workspaces/acct%3A7.eu_west/usage");
    assert.equal(new URLSearchParams(sent.query).get("to"), "2026-11-03");
    assert.equal(res.structuredContent.external_user_id, "acct:7.eu_west");
  });

  test("spicrawl_partner_tiers_list reads the tiers", async () => {
    const res = await call("spicrawl_partner_tiers_list", {});
    assert.equal(res.isError ?? false, false, textOf(res));
    assert.equal(res.structuredContent.tiers.length, 2);
    assert.equal(res.structuredContent.tiers[0].default, true);
  });

  test("spicrawl_partner_tier_create sends only the fields given, and maps the new tier", async () => {
    const res = await call("spicrawl_partner_tier_create", {
      name: "Basic", requests_per_minute: 30, concurrency: 1, free_credits: 100, wallet_cap: 200,
    });
    assert.equal(res.isError ?? false, false, textOf(res));
    assert.deepEqual(lastCall("POST", "/v1/partner/tiers").body, {
      name: "Basic", requests_per_minute: 30, concurrency: 1, free_credits: 100, wallet_cap: 200,
    });
    assert.equal(res.structuredContent.name, "Basic");
  });

  test("spicrawl_partner_tier_update sends only the changed fields, and null clears a cap", async () => {
    const res = await call("spicrawl_partner_tier_update", { tier_id: "tier_pro", requests_per_minute: 150, wallet_cap: null });
    assert.equal(res.isError ?? false, false, textOf(res));
    const sent = lastCall("PATCH", "/v1/partner/tiers/tier_pro");
    assert.deepEqual(sent.body, { requests_per_minute: 150, wallet_cap: null });
    assert.equal(res.structuredContent.requests_per_minute, 150);
  });

  test("spicrawl_partner_tier_update with nothing to change is refused, and sends nothing", async () => {
    const before = apiCalls("PATCH", "/v1/partner/tiers/tier_pro").length;
    const res = await call("spicrawl_partner_tier_update", { tier_id: "tier_pro" });
    assert.equal(res.isError, true);
    assert.match(textOf(res), /Nothing to change/);
    assert.equal(apiCalls("PATCH", "/v1/partner/tiers/tier_pro").length, before);
  });

  test("spicrawl_partner_user_set_tier moves the user by the tier's name", async () => {
    const res = await call("spicrawl_partner_user_set_tier", { external_user_id: "user-42", tier: "Pro" });
    assert.equal(res.isError ?? false, false, textOf(res));
    assert.deepEqual(lastCall("PUT", "/v1/partner/workspaces/user-42/tier").body, { tier: "Pro" });
    assert.equal(res.structuredContent.tier.name, "Pro");
  });

  test("spicrawl_partner_user_update sends the label, and null clears it", async () => {
    const set = await call("spicrawl_partner_user_update", { external_user_id: "user-42", display_name: "Team 42" });
    assert.equal(set.isError ?? false, false, textOf(set));
    assert.deepEqual(lastCall("PATCH", "/v1/partner/workspaces/user-42").body, { display_name: "Team 42" });
    assert.equal(set.structuredContent.display_name, "Team 42");
    const cleared = await call("spicrawl_partner_user_update", { external_user_id: "user-42", display_name: null });
    assert.equal(cleared.isError ?? false, false, textOf(cleared));
    assert.deepEqual(lastCall("PATCH", "/v1/partner/workspaces/user-42").body, { display_name: null });
    assert.equal(cleared.structuredContent.display_name, null);
  });

  test("spicrawl_partner_user_suspend and spicrawl_partner_user_reactivate post to their routes", async () => {
    const off = await call("spicrawl_partner_user_suspend", { external_user_id: "user-42" });
    assert.equal(off.isError ?? false, false, textOf(off));
    assert.equal(off.structuredContent.status, "suspended");
    assert.ok(apiCalls("POST", "/v1/partner/workspaces/user-42/suspend").length > 0);
    const on = await call("spicrawl_partner_user_reactivate", { external_user_id: "user-42" });
    assert.equal(on.isError ?? false, false, textOf(on));
    assert.equal(on.structuredContent.status, "active");
    assert.ok(apiCalls("POST", "/v1/partner/workspaces/user-42/reactivate").length > 0);
  });

  test("spicrawl_partner_tier_delete deletes an unused tier, and refuses one that users are on", async () => {
    const made = await call("spicrawl_partner_tier_create", { name: "Temp", requests_per_minute: 5, concurrency: 1, free_credits: 0 });
    assert.equal(made.isError ?? false, false, textOf(made));
    const gone = await call("spicrawl_partner_tier_delete", { tier_id: made.structuredContent.id });
    assert.equal(gone.isError ?? false, false, textOf(gone));
    assert.deepEqual(gone.structuredContent, { deleted: true, tier_id: made.structuredContent.id });
    assert.equal(lastCall("DELETE", `/v1/partner/tiers/${made.structuredContent.id}`).method, "DELETE");

    const refused = await call("spicrawl_partner_tier_delete", { tier_id: "tier_std" });
    assert.equal(refused.isError, true);
    assert.equal(textOf(refused), "ERR::REQUEST::CONFLICT: 2 workspaces are on this tier. Move them first.");
  });
});

describe("spicrawl_partner_give_credits", () => {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const balance = () => api.partner.balance.balance_credits;

  test("generates an idempotency key when none is given, and returns it", async () => {
    const res = await call("spicrawl_partner_give_credits", { external_user_id: "user-42", credits: 50 });
    assert.equal(res.isError ?? false, false, textOf(res));
    const sent = lastCall("POST", "/v1/partner/workspaces/user-42/credits").body;
    assert.match(sent.idempotency_key, UUID);
    assert.equal(sent.credits, 50);
    assert.equal(res.structuredContent.idempotency_key, sent.idempotency_key);
    assert.equal(res.structuredContent.applied, true);
    assert.match(res.structuredContent.message, /^Gave 50 credits to user-42/);
  });

  test("two calls with the same arguments and no key get two different keys", async () => {
    const a = await call("spicrawl_partner_give_credits", { external_user_id: "user-42", credits: 1 });
    const b = await call("spicrawl_partner_give_credits", { external_user_id: "user-42", credits: 1 });
    assert.notEqual(a.structuredContent.idempotency_key, b.structuredContent.idempotency_key);
  });

  test("reuses a key that is given, and a replay reports that nothing moved", async () => {
    const key = "grant-2026-11-20-user42";
    const first = await call("spicrawl_partner_give_credits", { external_user_id: "user-42", credits: 20, idempotency_key: key });
    assert.equal(first.isError ?? false, false, textOf(first));
    assert.equal(lastCall("POST", "/v1/partner/workspaces/user-42/credits").body.idempotency_key, key);
    assert.equal(first.structuredContent.idempotency_key, key);
    assert.equal(first.structuredContent.applied, true);

    const after = balance();
    const replay = await call("spicrawl_partner_give_credits", { external_user_id: "user-42", credits: 20, idempotency_key: key });
    assert.equal(replay.isError ?? false, false, textOf(replay));
    assert.equal(replay.structuredContent.applied, false);
    assert.match(replay.structuredContent.message, /^Nothing moved:/);
    assert.equal(balance(), after, "a replay must not move credits");
  });

  test("a key reused for another amount is refused with the API's detail", async () => {
    const key = "grant-2026-11-20-user42";
    const res = await call("spicrawl_partner_give_credits", { external_user_id: "user-42", credits: 21, idempotency_key: key });
    assert.equal(res.isError, true);
    assert.equal(
      textOf(res),
      "ERR::REQUEST::CONFLICT: This idempotency_key was already used for a different assignment (another amount or user). Use a new key.",
    );
  });

  test("more than the balance is refused with the API's detail, and moves nothing", async () => {
    const after = balance();
    const res = await call("spicrawl_partner_give_credits", { external_user_id: "user-42", credits: 999999 });
    assert.equal(res.isError, true);
    assert.match(textOf(res), /^ERR::LIMIT::QUOTA_EXCEEDED: You can give at most \d+ credits right now; this assignment is 999999\.$/);
    assert.equal(balance(), after);
  });

  test("a key of the wrong shape is refused before any call", async () => {
    const before = apiCalls("POST", "/v1/partner/workspaces/user-42/credits").length;
    const res = await call("spicrawl_partner_give_credits", { external_user_id: "user-42", credits: 5, idempotency_key: "short" });
    assert.ok(res.rpcError || res.isError, "expected a validation error");
    assert.equal(apiCalls("POST", "/v1/partner/workspaces/user-42/credits").length, before);
  });
});

describe("usage whole-credit fields", () => {
  /** The fields must add up to `credits`, and none may be negative. */
  function assertAddsUp(item, label) {
    const parts = [item.credits_from_balance, item.credits_given_spent, item.credits_free];
    for (const p of [item.credits, ...parts]) assert.ok(Number.isInteger(p) && p >= 0, `${label}: ${p} is not a non-negative whole number`);
    assert.equal(parts.reduce((a, b) => a + b, 0), item.credits, `${label}: parts do not add up`);
    assert.equal(item.credits, Math.floor(item.credits_micro / 1_000_000), `${label}: credits is not the rounded-down total`);
  }

  test("the totals and every row of a day usage add up", async () => {
    const res = await call("spicrawl_partner_usage", { group_by: "day" });
    assert.equal(res.isError ?? false, false, textOf(res));
    const { totals, rows } = res.structuredContent;
    assert.deepEqual(
      { credits: totals.credits, from: totals.credits_from_balance, given: totals.credits_given_spent, free: totals.credits_free },
      { credits: 14, from: 9, given: 3, free: 2 },
    );
    assert.equal(totals.credits_micro, 14000000, "the micro fields are kept as the API sent them");
    rows.forEach((r, i) => assertAddsUp(r, `day row ${i}`));
    assertAddsUp(totals, "totals");
  });

  test("a row whose parts exceed its total is clamped so the parts still add up", async () => {
    const res = await call("spicrawl_partner_usage", { group_by: "workspace" });
    assert.equal(res.isError ?? false, false, textOf(res));
    const [userRow, eu] = res.structuredContent.rows;
    assert.deepEqual(
      [userRow.credits, userRow.credits_from_balance, userRow.credits_given_spent, userRow.credits_free],
      [5, 2, 3, 0],
      "5 credits: 3 given first, then 2 from the balance (4 asked, only 2 left), nothing free",
    );
    assertAddsUp(userRow, "user-42");
    assertAddsUp(eu, "acct:7.eu_west");
    assert.equal(eu.credits_free, 3);
  });

  test("a user's usage adds up the same way", async () => {
    const res = await call("spicrawl_partner_user_usage", { external_user_id: "user-42" });
    assert.equal(res.isError ?? false, false, textOf(res));
    assertAddsUp(res.structuredContent.totals, "user totals");
    res.structuredContent.rows.forEach((r, i) => assertAddsUp(r, `user row ${i}`));
  });
});

describe("arguments are strict", () => {
  test("an unknown argument is refused by name, and no API call is made", async () => {
    const before = api.requests.length;
    const res = await call("spicrawl_partner_give_credits", { external_user_id: "user-42", credits: 5, amount: 9 });
    assert.ok(res.rpcError || res.isError, "expected a refusal");
    assert.match(res.rpcError ? res.rpcError.message : textOf(res), /amount/);
    assert.equal(api.requests.length, before);
  });

  test("a tool that takes no arguments refuses one", async () => {
    const res = await call("spicrawl_partner_summary", { verbose: true });
    assert.ok(res.rpcError || res.isError, "expected a refusal");
    assert.match(res.rpcError ? res.rpcError.message : textOf(res), /verbose/);
  });

  test("every partner tool's input schema forbids additional properties", async () => {
    const { tools } = await partner.listTools();
    for (const t of tools.filter((x) => x.name.startsWith("spicrawl_partner_"))) {
      assert.equal(t.inputSchema.additionalProperties, false, t.name);
    }
  });
});

describe("wording", () => {
  const COMMERCE = /\bupgrade\s+(your|now|to|plan|account)\b|\b(checkout|subscribe|subscription|purchase|top[- ]?up|firecrawl|scrapingbee|apify)\b/i;

  test("no partner tool names an engine or browser tooling, anywhere in the listing", async () => {
    const { tools } = await partner.listTools();
    assert.deepEqual(forbiddenIn(tools.filter((t) => t.name.startsWith("spicrawl_partner_"))), []);
  });

  test("the word wallet appears only inside a backticked field name", async () => {
    const { tools } = await partner.listTools();
    for (const t of tools) {
      if (!t.name.startsWith("spicrawl_partner_")) continue;
      const texts = [t.title, t.description ?? "", ...descriptions(t.inputSchema), ...descriptions(t.outputSchema)];
      for (const text of texts) {
        const prose = text.replace(/`[^`]*`/g, "");
        assert.doesNotMatch(prose, /wallet/i, `${t.name}: ${text.slice(0, 120)}`);
      }
    }
  });

  test("no partner tool offers checkout, upgrade or subscription wording", async () => {
    const { tools } = await partner.listTools();
    for (const t of tools) {
      if (!t.name.startsWith("spicrawl_partner_")) continue;
      for (const d of [t.title, t.description ?? "", ...descriptions(t.inputSchema)]) assert.doesNotMatch(d, COMMERCE, `${t.name}: ${d.slice(0, 120)}`);
    }
  });

  test("the README's partner section names every partner tool", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    for (const name of PARTNER_NAMES) assert.ok(readme.includes(`\`${name}\``), `README does not name ${name}`);
  });
});
