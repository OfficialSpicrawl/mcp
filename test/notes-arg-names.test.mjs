// API `notes` returned with a result are rewritten to the tool's argument names,
// like warnings and errors. Real MCP session in process, global fetch stubbed.

import assert from "node:assert/strict";
import { afterEach, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ILayerClient } from "../dist/client.js";
import { buildServer } from "../dist/server.js";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
const JS = { "Content-Type": "application/json" };
const stub = (obj) => { globalThis.fetch = async () => new Response(JSON.stringify(obj), { status: 200, headers: JS }); };

let client;
before(async () => {
  const c = new ILayerClient({ apiKey: "spicrawl_live_test", baseURL: "http://api.invalid" });
  const server = buildServer(c, { hideUnavailable: false });
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
});

const env = { url: "https://x.test/", status: 200, content: "hi" };
const scrape = () => client.callTool({ name: "spicrawl_scrape", arguments: { url: "https://x.test/", format: "json" } });
const everything = (r) => JSON.stringify([r.content, r.structuredContent]);

test("1. notes: js_render -> render everywhere", async () => {
  stub({ ...env, notes: ["Set `js_render` to true to get the page as a browser shows it."] });
  const r = await scrape();
  assert.deepEqual(r.structuredContent.notes, ["Set `render` to true to get the page as a browser shows it."]);
  assert.ok(everything(r).includes("Set `render` to true"));
  assert.ok(!everything(r).includes("js_render"));
});

test("2. notes: response_format -> format", async () => {
  stub({ ...env, notes: ["Pass `response_format` html for the raw document."] });
  const r = await scrape();
  assert.deepEqual(r.structuredContent.notes, ["Pass `format` html for the raw document."]);
  assert.ok(!everything(r).includes("response_format"));
});

test("3. notes without mapped names pass through unchanged", async () => {
  const notes = ["Nothing special here.", "Try premium_proxy or stealth."];
  stub({ ...env, notes });
  assert.deepEqual((await scrape()).structuredContent.notes, notes);
});

test("4. warnings rewrite still works", async () => {
  stub({ ...env, warnings: ["`js_render` was ignored"] });
  const r = await scrape();
  assert.deepEqual(r.structuredContent.warnings, ["`render` was ignored"]);
  assert.ok(!everything(r).includes("js_render"));
});

test("5. batch job: notes renamed", async () => {
  stub({ id: "job_1", status: "queued", notes: ["Set `js_render` to true; see `response_format`."] });
  const r = await client.callTool({ name: "spicrawl_batch_status", arguments: { job_id: "job_1" } });
  assert.equal(r.isError ?? false, false, JSON.stringify(r.content));
  assert.deepEqual(r.structuredContent.notes, ["Set `render` to true; see `format`."]);
  assert.ok(!everything(r).includes("js_render"));
});
