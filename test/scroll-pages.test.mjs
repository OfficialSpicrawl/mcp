// `scroll_pages` on spicrawl_scrape: passed through unchanged, omitted when unset,
// range-checked by the tool's input schema. Fetch is stubbed; nothing leaves the machine.

import assert from "node:assert/strict";
import { afterEach, before, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ILayerClient } from "../dist/client.js";
import { buildServer } from "../dist/server.js";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

let sent;
const stub = () => {
  sent = [];
  globalThis.fetch = async (_url, init) => {
    sent.push(init?.body ? JSON.parse(init.body) : undefined);
    return new Response("# hi", { headers: { "Content-Type": "text/markdown" } });
  };
};

let client;
before(async () => {
  const c = new ILayerClient({ apiKey: "spicrawl_live_test", baseURL: "http://api.invalid" });
  const server = buildServer(c, { hideUnavailable: false });
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
});

const scrape = (args = {}) => client.callTool({ name: "spicrawl_scrape", arguments: { url: "https://x.test/", ...args } });

describe("scroll_pages", () => {
  test("1. scroll_pages: 5 reaches the API body unchanged", async () => {
    stub();
    const r = await scrape({ scroll_pages: 5 });
    assert.equal(r.isError ?? false, false);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].scroll_pages, 5);
  });

  test("2. omitted: no scroll_pages key is sent", async () => {
    stub();
    await scrape();
    assert.equal(sent.length, 1);
    assert.equal("scroll_pages" in sent[0], false);
  });

  for (const bad of [21, -1, 2.5]) {
    test(`3. scroll_pages: ${bad} is rejected before any API call`, async () => {
      stub();
      let r;
      try { r = await scrape({ scroll_pages: bad }); } catch { r = { isError: true }; }
      assert.equal(r.isError, true);
      assert.equal(sent.length, 0);
    });
  }

  test("4. listed input schema has scroll_pages, minimum 0, maximum 20", async () => {
    const { tools } = await client.listTools();
    const p = tools.find((t) => t.name === "spicrawl_scrape").inputSchema.properties.scroll_pages;
    assert.ok(p, "scroll_pages missing from the input schema");
    assert.equal(p.minimum, 0);
    assert.equal(p.maximum, 20);
  });
});
