// Per-item error messages, warnings and notes in spicrawl_batch_results are
// rewritten to the tool's argument names. Real MCP session in process, fetch stubbed.

import assert from "node:assert/strict";
import { afterEach, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ILayerClient } from "../dist/client.js";
import { buildServer } from "../dist/server.js";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
// The results endpoint streams JSON Lines.
const stubLines = (lines) => {
  globalThis.fetch = async () =>
    new Response(lines.map((l) => JSON.stringify(l)).join("\n") + "\n", {
      status: 200,
      headers: { "Content-Type": "application/x-ndjson" },
    });
};

let client;
before(async () => {
  const c = new ILayerClient({ apiKey: "spicrawl_live_test", baseURL: "http://api.invalid" });
  const server = buildServer(c, { hideUnavailable: false });
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
});

const results = () => client.callTool({ name: "spicrawl_batch_results", arguments: { job_id: "job_1" } });
const everything = (r) => JSON.stringify([r.content, r.structuredContent]);

test("1. item error message: js_render -> render in structuredContent and text", async () => {
  stubLines([{ seq: 0, status: "failed", error: { code: "X", message: "Set `js_render` to true to read this page." } }]);
  const r = await results();
  assert.equal(r.isError ?? false, false, JSON.stringify(r.content));
  assert.equal(r.structuredContent.results[0].error.message, "Set `render` to true to read this page.");
  assert.equal(r.structuredContent.results[0].error.code, "X");
  assert.ok(everything(r).includes("Set `render` to true"));
  assert.ok(!everything(r).includes("js_render"));
});

test("2. item warnings and notes are rewritten, response_format -> format", async () => {
  stubLines([{ seq: 0, status: "succeeded", warnings: ["`js_render` was ignored"], notes: ["Pass `response_format` html for raw."] }]);
  const r = await results();
  const item = r.structuredContent.results[0];
  assert.deepEqual(item.warnings, ["`render` was ignored"]);
  assert.deepEqual(item.notes, ["Pass `format` html for raw."]);
  assert.ok(!everything(r).includes("js_render"));
  assert.ok(!everything(r).includes("response_format"));
});

test("3. every item on the page is rewritten, not just the first", async () => {
  stubLines([
    { seq: 0, status: "failed", error: { message: "`js_render` off" } },
    { seq: 1, status: "failed", error: { message: "`response_format` bad" } },
  ]);
  const r = await results();
  assert.deepEqual(r.structuredContent.results.map((i) => i.error.message), ["`render` off", "`format` bad"]);
});

test("4. unmapped item text passes through unchanged", async () => {
  const item = { seq: 0, status: "failed", error: { code: "E", message: "Try premium_proxy or stealth." }, warnings: ["slow"], notes: ["n"] };
  stubLines([item]);
  const r = await results();
  assert.deepEqual(r.structuredContent.results[0], item);
});

const stubJson = (obj) => {
  globalThis.fetch = async () => new Response(JSON.stringify(obj), { status: 200, headers: { "Content-Type": "application/json" } });
};

test("5. batch status: job error_message js_render -> render", async () => {
  stubJson({ id: "job_1", status: "failed", error_message: "Set `js_render` to true to read these pages." });
  const r = await client.callTool({ name: "spicrawl_batch_status", arguments: { job_id: "job_1" } });
  assert.equal(r.isError ?? false, false, JSON.stringify(r.content));
  assert.equal(r.structuredContent.error_message, "Set `render` to true to read these pages.");
  assert.ok(!everything(r).includes("js_render"));
});

test("6. batch list: every job's error_message is renamed", async () => {
  stubJson({
    batches: [
      { id: "job_1", status: "failed", error_message: "`js_render` off" },
      { id: "job_2", status: "failed", error_message: "`response_format` bad" },
    ],
  });
  const r = await client.callTool({ name: "spicrawl_batch_list", arguments: {} });
  assert.equal(r.isError ?? false, false, JSON.stringify(r.content));
  assert.deepEqual(r.structuredContent.batches.map((j) => j.error_message), ["`render` off", "`format` bad"]);
  assert.ok(!everything(r).includes("js_render"));
  assert.ok(!everything(r).includes("response_format"));
});

test("7. job error_message without mapped names is unchanged", async () => {
  stubJson({ id: "job_1", status: "failed", error_message: "Too many failures." });
  const r = await client.callTool({ name: "spicrawl_batch_status", arguments: { job_id: "job_1" } });
  assert.equal(r.structuredContent.error_message, "Too many failures.");
});
