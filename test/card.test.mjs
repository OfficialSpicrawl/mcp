// The static server card at /.well-known/mcp/server-card.json: public, cacheable,
// built from the real tool definitions, and free of internal engine names.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, test } from "node:test";
import { connectClient, startFakeApi, startMcp } from "./helpers/harness.mjs";

const PKG = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
// Written out here, not imported, so the test does not trust the code it checks.
const INTERNAL = /moli|chromium|chrome|camoufox|obscura|browserless|headful|playwright|puppeteer/i;
const HIDDEN_ARGUMENTS = ["engine", "headless"];

let api;
let mcp;
let cardURL;

before(async () => {
  api = await startFakeApi();
  // The card lists what works today, so compare it with a session that does too.
  mcp = await startMcp(api.url, { SPICRAWL_MCP_HIDE_UNAVAILABLE: "1" });
  cardURL = `${mcp.base}/.well-known/mcp/server-card.json`;
});

after(async () => {
  await mcp?.stop();
  await api?.close();
});

describe("server card", () => {
  test("is public JSON, cacheable, and calls nothing upstream", async () => {
    const before = api.requests.length;
    const res = await fetch(cardURL); // no Authorization header
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /^application\/json/);
    assert.match(res.headers.get("cache-control"), /public, max-age=\d+/);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    await res.json();
    assert.equal(api.requests.length, before);
  });

  test("HEAD answers without a body; other methods get 405", async () => {
    const head = await fetch(cardURL, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
    const post = await fetch(cardURL, { method: "POST", body: "{}" });
    assert.equal(post.status, 405);
    assert.equal(post.headers.get("allow"), "GET, HEAD");
  });

  test("states the server, transport and auth", async () => {
    const card = await (await fetch(cardURL)).json();
    assert.equal(card.serverInfo.name, "Spicrawl");
    assert.equal(card.serverInfo.version, PKG.version);
    assert.ok(card.serverInfo.description);
    assert.match(card.serverInfo.websiteUrl, /^https:\/\//);
    assert.deepEqual(card.transport, { type: "streamable-http", endpoint: "https://mcp.spicrawl.com/mcp" });
    assert.deepEqual(card.authentication, { required: true, schemes: ["bearer"] });
  });

  test("lists exactly the tools a live session lists, with the same schemas", async () => {
    const card = await (await fetch(cardURL)).json();
    const { client } = await connectClient(mcp.mcpURL);
    const live = (await client.listTools()).tools;
    await client.close();

    assert.ok(live.length > 0);
    assert.deepEqual(card.tools.map((t) => t.name), live.map((t) => t.name));
    for (const [i, tool] of card.tools.entries()) {
      assert.equal(tool.title, live[i].title);
      assert.deepEqual(tool.annotations, live[i].annotations, tool.name);
      assert.equal(tool.inputSchema.additionalProperties, live[i].inputSchema.additionalProperties, tool.name);
      const liveArgs = Object.keys(live[i].inputSchema.properties ?? {}).filter((a) => !HIDDEN_ARGUMENTS.includes(a));
      assert.deepEqual(Object.keys(tool.inputSchema.properties ?? {}), liveArgs, tool.name);
      for (const r of tool.inputSchema.required ?? []) assert.ok(liveArgs.includes(r), `${tool.name}: required ${r}`);
      assert.ok(tool.description?.trim(), `${tool.name} keeps a description`);
      for (const [arg, schema] of Object.entries(tool.inputSchema.properties ?? {})) {
        if (live[i].inputSchema.properties[arg].description) assert.ok(schema.description?.trim(), `${tool.name}.${arg} keeps a description`);
      }
    }
  });

  test("never names an internal engine and hides the arguments that pick one", async () => {
    const text = await (await fetch(cardURL)).text();
    assert.doesNotMatch(text, INTERNAL);
    for (const tool of JSON.parse(text).tools) {
      for (const a of HIDDEN_ARGUMENTS) assert.ok(!(a in (tool.inputSchema.properties ?? {})), `${tool.name} still has ${a}`);
    }
  });

  test("/mcp still needs a key", async () => {
    const res = await fetch(mcp.mcpURL, { method: "POST", body: "{}" });
    assert.equal(res.status, 401);
  });
});
