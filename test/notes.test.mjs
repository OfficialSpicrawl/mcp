// API notes (X-Note header, body `notes`, error `hint`) through a real MCP session in
// process, with global fetch stubbed. Nothing leaves the machine.

import assert from "node:assert/strict";
import { afterEach, before, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ILayerClient } from "../dist/client.js";
import { buildServer } from "../dist/server.js";
import { buildChatgptServer } from "../dist/chatgpt/tools.js";
import { MARKDOWN_PAYLOAD, PNG_1X1 } from "./helpers/harness.mjs";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const stub = (body, { status = 200, headers = {} } = {}) => {
  globalThis.fetch = async () => new Response(body, { status, headers });
};
const MD = { "Content-Type": "text/markdown" };
const JS = { "Content-Type": "application/json" };

async function session(build = buildServer) {
  const c = new ILayerClient({ apiKey: "spicrawl_live_test", baseURL: "http://api.invalid" });
  const server = build === buildServer ? buildServer(c, { hideUnavailable: false }) : build(c, { upstreamChallenge: () => "x", onUpstreamUnauthorized() {} });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}
let client;
before(async () => { client = await session(); });
const scrape = (args = {}) => client.callTool({ name: "spicrawl_scrape", arguments: { url: "https://x.test/", ...args } });
const text = (r) => r.content.map((b) => b.text);

describe("text body", () => {
  test("1. markdown + X-Note: block 0 unchanged, Note block after, renamed, no symbol", async () => {
    stub(MARKDOWN_PAYLOAD, { headers: MD });
    const plain = await scrape();
    stub(MARKDOWN_PAYLOAD, { headers: { ...MD, "X-Note": "Set `js_render` to true for this page." } });
    const r = await scrape();
    assert.deepEqual(r.content[0], plain.content[0]);
    assert.equal(r.content.length, 2);
    assert.equal(r.content[1].text, "Note: Set `render` to true for this page.");
    assert.equal(Object.getOwnPropertySymbols(r.structuredContent).length, 0);
    assert.deepEqual(r.structuredContent, { ...plain.structuredContent, notes: ["Set `render` to true for this page."] });
    assert.equal(r.isError ?? false, false);
  });

  test("2. no note: result deep equal with or without an unrelated header", async () => {
    stub(MARKDOWN_PAYLOAD, { headers: MD });
    const a = await scrape();
    stub(MARKDOWN_PAYLOAD, { headers: { ...MD, "X-Unrelated": "1" } });
    const b = await scrape();
    assert.deepEqual(b, a);
    assert.equal(a.content.length, 1);
    assert.deepEqual(a.structuredContent, { content: MARKDOWN_PAYLOAD });
  });
});

describe("JSON envelope", () => {
  const env = { url: "https://x.test/", status: 200, content: "hi" };
  test("3. body notes win over the header, not duplicated, renamed", async () => {
    stub(JSON.stringify({ ...env, notes: ["use `js_render=true`"] }), { headers: { ...JS, "X-Note": "header note" } });
    const r = await scrape({ format: "json" });
    assert.deepEqual(r.structuredContent.notes, ["use `render=true`"]);
    assert.equal(r.content.length, 1);
    assert.equal(JSON.parse(r.content[0].text).notes.length, 1);
  });
  test("4. no body notes: data.notes from the header", async () => {
    stub(JSON.stringify(env), { headers: { ...JS, "X-Note": "from header" } });
    const r = await scrape({ format: "json" });
    assert.deepEqual(r.structuredContent.notes, ["from header"]);
    assert.equal(r.content.length, 1);
  });
});

test("5. renaming forms", async () => {
  const cases = [
    ["Set `js_render` to true", "Set `render` to true"],
    ["`js_render=true`", "`render=true`"],
    ["`response_format=html`", "`format=html`"],
    ["Try premium_proxy, stealth or proxy.", "Try premium_proxy, stealth or proxy."],
    ["Nothing special here.", "Nothing special here."],
  ];
  for (const [inp, out] of cases) {
    stub(MARKDOWN_PAYLOAD, { headers: { ...MD, "X-Note": inp } });
    assert.equal((await scrape()).content[1].text, `Note: ${out}`, inp);
  }
});

test("6. repeated header (joined with ', ') stays one note", async () => {
  const h = new Headers(MD);
  h.append("X-Note", "First, with a comma.");
  h.append("X-Note", "Second.");
  stub(MARKDOWN_PAYLOAD, { headers: h });
  const r = await scrape();
  assert.equal(r.content.length, 2);
  assert.equal(r.content[1].text, "Note: First, with a comma., Second.");
});

describe("7. empty refusal", () => {
  const NOTE = "The site refused this request with status 403. Set `js_render` to true.";
  for (const body of ["", "{}"]) {
    test(`body ${JSON.stringify(body)}`, async () => {
      stub(body, { headers: body ? { ...JS, "X-Note": NOTE } : { "X-Note": NOTE } });
      const r = await scrape();
      const blocks = text(r);
      assert.equal(r.isError ?? false, false);
      assert.deepEqual(r.content, [{ type: "text", text: "Note: The site refused this request with status 403. Set `render` to true." }]);
      assert.deepEqual(r.structuredContent, { notes: ["The site refused this request with status 403. Set `render` to true."] });
    });
  }
});

test("8. note block comes after image blocks; image indexes unchanged", async () => {
  const body = JSON.stringify({ url: "u", status: 200, content: "x", screenshots: [{ format: "png", data: PNG_1X1, encoding: "base64" }], notes: ["n `js_render`"] });
  stub(body, { headers: JS });
  const r = await scrape({ screenshot: true, render: true });
  console.log("# screenshot JSON-body blocks:", r.content.map((b) => b.type));
  // A JSON envelope keeps notes in data, so no note block here.
  assert.deepEqual(r.content.map((b) => b.type), ["text", "image"]);
  assert.match(JSON.parse(r.content[0].text).screenshots[0].attached_as, /content\[1\]/);
  assert.deepEqual(r.structuredContent.notes, ["n `render`"]);
});

test("8b. run() with a text body, image blocks and notes: Note block last, image indexes unchanged", async () => {
  const { run } = await import("../dist/tools/common.js");
  const { TEXT_BODY } = await import("../dist/client.js");
  const { attachScreenshots } = await import("../dist/tools/screenshots.js");
  // Shape a text body that also carries a screenshot (not producible by the API today).
  const body = { content: "doc", notes: ["n `js_render`"], screenshots: [{ format: "png", data: PNG_1X1, encoding: "base64" }], [TEXT_BODY]: true };
  const r = await run(async () => body, attachScreenshots, { js_render: "render" });
  console.log("# 8b blocks:", r.content.map((b) => b.type));
  assert.deepEqual(r.content.map((b) => b.type), ["text", "image", "text"]);
  assert.equal(r.content[2].text, "Note: n `render`");
  assert.match(JSON.parse(r.content[0].text).screenshots[0].attached_as, /content\[1\]/);
  assert.equal(Object.getOwnPropertySymbols(r.structuredContent).length, 0);
});

describe("9. errors", () => {
  const problem = (extra) => ({ type: "about:blank", title: "t", status: 502, code: "ERR::UPSTREAM::CHALLENGE", detail: "Blocked.", retryable: false, ...extra });
  const err = async (p) => { stub(JSON.stringify(p), { status: p.status, headers: { "Content-Type": "application/problem+json" } }); return scrape(); };
  test("hint + notes", async () => {
    const r = await err(problem({ notes: ["n"], diagnostics: { hint: "Set `js_render` to true" } }));
    assert.equal(r.isError, true);
    assert.ok(text(r)[0].endsWith("\nHint: Set `render` to true"), text(r)[0]);
  });
  test("detail already has the hint", async () => {
    const r = await err(problem({ detail: "Blocked. Set `js_render` to true", diagnostics: { hint: "Set `js_render` to true" } }));
    assert.equal(r.isError, true);
    assert.equal(/Hint:/.test(text(r)[0]), false);
  });
  test("notes, no hint", async () => {
    const r = await err(problem({ notes: ["a `js_render`.", "b."] }));
    assert.equal(r.isError, true);
    assert.ok(text(r)[0].endsWith("\nHint: a `render`. b."), text(r)[0]);
  });
  test("neither: text unchanged", async () => {
    const r = await err(problem({}));
    assert.equal(r.isError, true);
    assert.equal(text(r)[0], "ERR::UPSTREAM::CHALLENGE: Blocked.");
  });
});

test("10. tool without an argument map: notes kept, not renamed", async () => {
  const q = { total: 1, notes: ["use `js_render`"] };
  stub(JSON.stringify(q), { headers: JS });
  let r = await client.callTool({ name: "spicrawl_usage_summary", arguments: {} });
  assert.equal(r.isError ?? false, false, text(r)[0]);
  assert.deepEqual(r.structuredContent.notes, ["use `js_render`"]);
  stub(JSON.stringify({ total: 1 }), { headers: { ...JS, "X-Note": "hdr `js_render`" } });
  r = await client.callTool({ name: "spicrawl_usage_summary", arguments: {} });
  assert.equal(r.isError ?? false, false, text(r)[0]);
  assert.deepEqual(r.structuredContent.notes, ["hdr `js_render`"]);
});

describe("11. output schema", () => {
  const base = { url: "https://x.test/", status: 200, content: "c" };
  for (const [name, extra] of [["array", { notes: ["a"] }], ["null", { notes: null }], ["absent", {}]]) {
    test(name, async () => {
      stub(JSON.stringify({ ...base, ...extra }), { headers: JS });
      const r = await scrape({ format: "json" }); // the SDK client validates structuredContent
      assert.equal(r.isError ?? false, false, text(r)[0]);
    });
  }
});


test("empty body with NO note: same as before the feature ({} text, {} structured)", async () => {
  for (const body of ["", "{}"]) {
    stub(body, { headers: body ? JS : {} });
    const r = await scrape();
    assert.deepEqual(r, { content: [{ type: "text", text: "{}" }], structuredContent: {} });
  }
});

test("JSON body that is exactly {notes:[x]}: treated as empty, note is content[0]", async () => {
  stub(JSON.stringify({ notes: ["x"] }), { headers: JS });
  const r = await scrape();
  console.log("# only-notes body:", JSON.stringify(r));
  assert.deepEqual(r.content, [{ type: "text", text: "Note: x" }]);
  assert.deepEqual(r.structuredContent, { notes: ["x"] });
});

test("text body with empty content and a note: note is content[0], structured {content:'',notes}", async () => {
  const h = { ...MD, "X-Note": "empty `js_render`" };
  stub("", { headers: h });
  // an empty non-JSON body parses as JSON-fail -> {content:""}
  const r = await scrape();
  console.log("# empty text:", JSON.stringify(r));
  assert.deepEqual(r.content, [{ type: "text", text: "Note: empty `render`" }]);
  assert.deepEqual(r.structuredContent, { notes: ["empty `render`"] });
});

test("text body + note validates against the scrape output schema through the real client", async () => {
  stub(MARKDOWN_PAYLOAD, { headers: { ...MD, "X-Note": "n" } });
  const r = await scrape(); // SDK client validates structuredContent on return
  assert.equal(r.isError ?? false, false);
  assert.deepEqual(r.structuredContent, { content: MARKDOWN_PAYLOAD, notes: ["n"] });
});

describe("12. ChatGPT surface keeps notes", () => {
  let gpt;
  before(async () => { gpt = await session(buildChatgptServer); });
  const gscrape = (args = {}) => gpt.callTool({ name: "spicrawl_scrape", arguments: { url: "https://x.test/", ...args } });
  test("text body", async () => {
    stub(MARKDOWN_PAYLOAD, { headers: { ...MD, "X-Note": "Set `js_render` to true" } });
    const r = await gscrape();
    assert.equal(r.content.length, 2);
    assert.equal(r.content[1].text, "Note: Set `render` to true");
    assert.deepEqual(r.structuredContent, { content: MARKDOWN_PAYLOAD, notes: ["Set `render` to true"] });
    assert.equal(Object.getOwnPropertySymbols(r.structuredContent).length, 0);
  });
  test("JSON body", async () => {
    stub(JSON.stringify({ url: "u", status: 200, content: "c", notes: ["n `js_render`"] }), { headers: JS });
    const r = await gscrape({ format: "json" });
    assert.equal(r.content.length, 1);
    assert.deepEqual(r.structuredContent.notes, ["n `render`"]);
  });
  test("empty refusal", async () => {
    stub("", { headers: { "X-Note": "Refused 403. Set `js_render` to true." } });
    const r = await gscrape();
    console.log("# chatgpt empty:", JSON.stringify(r));
    assert.deepEqual(r.content, [{ type: "text", text: "Note: Refused 403. Set `render` to true." }]);
    assert.deepEqual(r.structuredContent, { notes: ["Refused 403. Set `render` to true."] });
  });
  test("error Hint line", async () => {
    stub(JSON.stringify({ title: "t", status: 502, code: "ERR::UPSTREAM::CHALLENGE", detail: "Blocked.", diagnostics: { hint: "Set `js_render` to true" } }), { status: 502, headers: { "Content-Type": "application/problem+json" } });
    const r = await gscrape();
    assert.equal(r.isError, true);
    assert.ok(text(r)[0].endsWith("\nHint: Set `render` to true"), text(r)[0]);
  });
});
