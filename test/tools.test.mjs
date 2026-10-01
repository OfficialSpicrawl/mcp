// Tool-level behaviour through a real MCP session: result shaping for non-object
// payloads, and rejection of unknown arguments.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import {
  ARRAY_PAYLOAD,
  BATCH_JOB,
  MARKDOWN_PAYLOAD,
  PDF_BYTES,
  PNG_1X1,
  connectClient,
  startFakeApi,
  startMcp,
} from "./helpers/harness.mjs";

let api;
let mcp;
let client;

before(async () => {
  api = await startFakeApi();
  mcp = await startMcp(api.url);
  ({ client } = await connectClient(mcp.mcpURL));
});

after(async () => {
  await client?.close().catch(() => {});
  await mcp?.stop();
  await api?.close();
});

/** Calls a tool; a JSON-RPC error is returned as { rpcError } instead of thrown. */
async function call(name, args) {
  try {
    return await client.callTool({ name, arguments: args });
  } catch (err) {
    return { rpcError: err };
  }
}

const scrapeRequests = () => api.requests.filter((r) => r.method === "POST" && r.path === "/v1/scrape");

describe("result shaping", () => {
  test("spicrawl_batch_task_content returns a non-JSON (markdown) body in the same {content} shape as spicrawl_scrape", async () => {
    // ILayerClient wraps any non-JSON 2xx body as {content: text} — the shape
    // spicrawl_scrape has always returned — so an object, with structuredContent.
    const res = await call("spicrawl_batch_task_content", { job_id: "job_123", seq: 0 });
    assert.equal(res.rpcError, undefined, `unexpected JSON-RPC error: ${res.rpcError?.message}`);
    assert.equal(res.isError ?? false, false, `tool error: ${res.content?.[0]?.text}`);
    assert.deepEqual(res.structuredContent, { content: MARKDOWN_PAYLOAD });
    assert.deepEqual(JSON.parse(res.content[0].text), { content: MARKDOWN_PAYLOAD });
  });

  test("spicrawl_batch_task_content returns a JSON string payload verbatim, without structuredContent", async () => {
    const res = await call("spicrawl_batch_task_content", { job_id: "job_123", seq: 2 });
    assert.equal(res.rpcError, undefined, `unexpected JSON-RPC error: ${res.rpcError?.message}`);
    assert.equal(res.isError ?? false, false, `tool error: ${res.content?.[0]?.text}`);
    assert.equal(res.content[0].text, MARKDOWN_PAYLOAD, "a string payload should arrive unescaped");
    assert.equal(res.structuredContent, undefined);
  });

  test("spicrawl_batch_task_content returns a JSON array payload as text, without structuredContent", async () => {
    const res = await call("spicrawl_batch_task_content", { job_id: "job_123", seq: 1 });
    assert.equal(res.rpcError, undefined, `unexpected JSON-RPC error: ${res.rpcError?.message}`);
    assert.equal(res.isError ?? false, false, `tool error: ${res.content?.[0]?.text}`);
    assert.deepEqual(JSON.parse(res.content[0].text), ARRAY_PAYLOAD);
    assert.equal(res.structuredContent, undefined);
  });

  test("an object-returning tool gives pretty JSON text and structuredContent equal to the object", async () => {
    const res = await call("spicrawl_batch_status", { job_id: "job_123" });
    assert.equal(res.rpcError, undefined, `unexpected JSON-RPC error: ${res.rpcError?.message}`);
    assert.equal(res.isError ?? false, false, `tool error: ${res.content?.[0]?.text}`);
    assert.equal(res.content[0].text, JSON.stringify(BATCH_JOB, null, 2));
    assert.deepEqual(res.structuredContent, BATCH_JOB);
  });
});

describe("screenshots", () => {
  const ok = (res) => {
    assert.equal(res.rpcError, undefined, `unexpected JSON-RPC error: ${res.rpcError?.message}`);
    assert.equal(res.isError ?? false, false, `tool error: ${res.content?.[0]?.text}`);
  };

  test("an inline screenshot comes back as an image block, with a placeholder in the JSON", async () => {
    const res = await call("spicrawl_scrape", { url: "https://example.com", render: true, screenshot: true });
    ok(res);
    assert.equal(res.content.length, 2);
    assert.equal(res.content[0].type, "text");
    assert.deepEqual(res.content[1], { type: "image", data: PNG_1X1, mimeType: "image/png" });

    const text = res.content[0].text;
    assert.ok(!text.includes(PNG_1X1), "base64 left in the text");
    assert.ok(!JSON.stringify(res.structuredContent).includes(PNG_1X1), "base64 left in structuredContent");
    assert.deepEqual(JSON.parse(text), res.structuredContent);

    const [placeholder] = res.structuredContent.screenshots;
    assert.equal(placeholder.data, undefined);
    assert.equal(placeholder.encoding, undefined);
    assert.equal(placeholder.format, "png");
    assert.equal(placeholder.width, 1);
    assert.equal(placeholder.size_bytes, Buffer.from(PNG_1X1, "base64").length);
    assert.match(placeholder.attached_as, /image content block 1/);
    assert.equal(res.structuredContent.content, "<html>Example</html>");
  });

  test("a scrape without screenshots is returned unchanged, with no image block", async () => {
    const res = await call("spicrawl_scrape", { url: "https://example.com" });
    ok(res);
    const expected = { content: "# Example Domain\n", meta: { engine: "fetch", status: 200, credits: 1 } };
    assert.equal(res.content.length, 1);
    assert.equal(res.content[0].text, JSON.stringify(expected, null, 2));
    assert.deepEqual(res.structuredContent, expected);
  });

  test("an oversized screenshot is not attached, and says why, while the next one still is", async () => {
    const res = await call("spicrawl_scrape", {
      url: "https://example.com", render: true, screenshot: true, screenshot_selector: "#huge",
    });
    ok(res);
    const images = res.content.filter((c) => c.type === "image");
    assert.deepEqual(images, [{ type: "image", data: PNG_1X1, mimeType: "image/png" }]);
    assert.ok(res.content[0].text.length < 5000, `text is ${res.content[0].text.length} chars`);

    const [huge, small] = res.structuredContent.screenshots;
    assert.equal(huge.data, undefined);
    assert.equal(huge.attached_as, undefined);
    assert.match(huge.not_attached, /limit/);
    assert.match(small.attached_as, /image content block 1/);
  });
});

describe("pdf", () => {
  const ok = (res) => {
    assert.equal(res.rpcError, undefined, `unexpected JSON-RPC error: ${res.rpcError?.message}`);
    assert.equal(res.isError ?? false, false, `tool error: ${res.content?.[0]?.text}`);
  };

  test("format pdf asks the API for response_format=pdf and returns the file intact as a resource block", async () => {
    const res = await call("spicrawl_scrape", { url: "https://example.com/", format: "pdf", render: true });
    ok(res);
    assert.equal(scrapeRequests().at(-1).body.response_format, "pdf");
    assert.equal(res.content.length, 2);
    assert.equal(res.content[1].type, "resource");
    assert.equal(res.content[1].resource.mimeType, "application/pdf");
    assert.equal(res.content[1].resource.uri, "https://example.com/");
    // Byte for byte: a client that read the body as text would have mangled the non-UTF-8 bytes.
    assert.ok(Buffer.from(res.content[1].resource.blob, "base64").equals(PDF_BYTES));

    const meta = res.structuredContent;
    assert.equal(meta.engine, "chromium");
    assert.equal(meta.credits, 8);
    assert.equal(meta.status, 200);
    // The API sends X-Request-Id; it is a diagnostic identifier nobody asked for, so it is not passed on.
    assert.equal(meta.request_id, undefined);
    assert.ok(!res.content[0].text.includes("01TESTPDF0000000000000000"), "the request id leaked into the text");
    assert.deepEqual(meta.pdf, {
      content_type: "application/pdf",
      size_bytes: PDF_BYTES.length,
      attached_as: "resource content block 1 (content[1], application/pdf)",
    });
    assert.ok(!res.content[0].text.includes(res.content[1].resource.blob), "base64 left in the text");
  });

  test("a PDF over the size limit is not attached, and says why", async () => {
    const res = await call("spicrawl_scrape", { url: "https://huge-pdf.test/", format: "pdf", render: true });
    ok(res);
    assert.equal(res.content.length, 1);
    assert.equal(res.structuredContent.pdf.attached_as, undefined);
    assert.match(res.structuredContent.pdf.not_attached, /response_format=pdf directly/);
    assert.ok(res.content[0].text.length < 5000, `text is ${res.content[0].text.length} chars`);
  });
});

describe("argument validation", () => {
  test("spicrawl_scrape rejects an unknown argument by name and makes no API call", async () => {
    const beforeCount = scrapeRequests().length;
    const res = await call("spicrawl_scrape", { url: "https://example.com", js_render: true });
    const message = res.rpcError ? res.rpcError.message : (res.content ?? []).map((c) => c.text).join("\n");
    if (res.rpcError) {
      assert.equal(res.rpcError.code, -32602, `expected InvalidParams, got ${res.rpcError.code}`);
    } else {
      assert.equal(res.isError, true, `expected an error result; got:\n${message}`);
    }
    assert.match(message, /js_render/);
    assert.equal(scrapeRequests().length, beforeCount, "the fake API must not receive a scrape request");
  });

  test("a valid spicrawl_scrape reaches the API with render mapped to js_render", async () => {
    const beforeCount = scrapeRequests().length;
    const res = await call("spicrawl_scrape", { url: "https://example.com", render: true });
    assert.equal(res.rpcError, undefined, `unexpected JSON-RPC error: ${res.rpcError?.message}`);
    assert.equal(res.isError ?? false, false, `tool error: ${res.content?.[0]?.text}`);
    const sent = scrapeRequests().slice(beforeCount);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].body.url, "https://example.com");
    assert.equal(sent[0].body.js_render, true);
  });

  test("tools/list: every tool's inputSchema forbids additional properties", async () => {
    const { tools } = await client.listTools();
    assert.ok(tools.length >= 22, `expected at least 22 tools, got ${tools.length}`);
    const loose = tools.filter((t) => t.inputSchema?.additionalProperties !== false).map((t) => t.name);
    assert.deepEqual(loose, [], `tools accepting unknown arguments: ${loose.join(", ")}`);
  });
});

describe("browser connect url", () => {
  test("mints a token URL through the header-authenticated API and never returns the key", async () => {
    const res = await call("spicrawl_browser_connect_url", { proxy_country: "de", session_ttl: 120 });
    assert.equal(res.rpcError, undefined, `unexpected JSON-RPC error: ${res.rpcError?.message}`);
    assert.equal(res.isError ?? false, false, `tool error: ${res.content?.[0]?.text}`);
    const minted = api.requests.filter((r) => r.method === "POST" && r.path === "/v1/browser/token").at(-1);
    assert.ok(minted, "no POST /v1/browser/token");
    assert.match(minted.auth, /^Bearer spicrawl_live_/);
    assert.deepEqual(minted.body, { proxy_country: "de", session_ttl: 120 });
    const out = res.structuredContent;
    const u = new URL(out.url);
    assert.equal(u.protocol, "ws:");
    assert.equal(u.host, new URL(api.url).host, "built from the public base, not the API's view of its host");
    assert.equal(u.pathname, "/v1/browser");
    assert.ok(u.searchParams.get("token")?.startsWith("wbt_"));
    assert.equal(u.searchParams.get("proxy_country"), "de");
    assert.equal(out.single_use, true);
    const text = JSON.stringify(res);
    assert.ok(!text.includes("spicrawl_live_"), "a key appeared in the tool result");
    assert.ok(!/api_?key=/.test(text), "a key parameter appeared in the tool result");
  });

  test("keeps a path prefix in SPICRAWL_PUBLIC_BASE_URL", async () => {
    // A gateway that mounts the API under a prefix: resolving the minted
    // absolute path against the base would drop /spicrawl-api.
    const prefixed = await startMcp(api.url, { SPICRAWL_PUBLIC_BASE_URL: "https://gw.example.test/spicrawl-api/" });
    const { client: c } = await connectClient(prefixed.mcpURL);
    try {
      const res = await c.callTool({ name: "spicrawl_browser_connect_url", arguments: {} });
      assert.equal(res.isError ?? false, false, `tool error: ${res.content?.[0]?.text}`);
      const u = new URL(res.structuredContent.url);
      assert.equal(u.protocol, "wss:");
      assert.equal(u.host, "gw.example.test");
      assert.equal(u.pathname, "/spicrawl-api/v1/browser");
      assert.ok(u.searchParams.get("token")?.startsWith("wbt_"));
    } finally {
      await c.close().catch(() => {});
      await prefixed.stop();
    }
  });

  test("an API refusal surfaces as a tool error", async () => {
    const res = await call("spicrawl_browser_connect_url", { proxy_country: "zz" });
    assert.equal(res.isError, true);
  });
});

describe("spicrawl_scrape actions", () => {
  const ok = (res) => {
    assert.equal(res.rpcError, undefined, `unexpected JSON-RPC error: ${res.rpcError?.message}`);
    assert.equal(res.isError ?? false, false, `tool error: ${res.content?.[0]?.text}`);
  };
  const lastScrape = () => scrapeRequests().at(-1).body;

  test("typed actions are mapped onto the API's keyed step objects", async () => {
    const res = await call("spicrawl_scrape", {
      url: "https://example.com",
      render: true,
      actions: [
        { type: "fill", selector: "#user", value: "me", secret: true },
        { type: "click", selector: "button[type=submit]", wait_for_navigation: true, until: "networkidle", timeout_ms: 8000 },
        { type: "wait_for_navigation", until: "domcontentloaded" },
        { type: "wait_for", selector: ".results", timeout_ms: 4000, on_error: "skip" },
        { type: "wait_for", ms: 500 },
        { type: "scroll", to_bottom: true },
        { type: "scroll", y: 1200 },
        { type: "select", selector: "#size", value: "L" },
        { type: "evaluate", expression: "document.title", return_value: true },
        { type: "screenshot", full_page: true, label: "after" },
      ],
    });
    ok(res);
    assert.deepEqual(lastScrape().actions, [
      { fill: { selector: "#user", value: "me", secret: true } },
      { click: { selector: "button[type=submit]", wait_for_navigation: true, until: "networkidle" }, timeout_ms: 8000 },
      { wait_for_navigation: { until: "domcontentloaded" } },
      { wait_for: { selector: ".results" }, timeout_ms: 4000, on_error: "skip" },
      { wait_for: { ms: 500 } },
      { scroll: { to_bottom: true } },
      { scroll: { y: 1200 } },
      { select: { selector: "#size", value: "L" } },
      { evaluate: { expression: "document.title", return_value: true } },
      { screenshot: { full_page: true }, label: "after" },
    ]);
  });

  test("an unknown action type is refused before any API call", async () => {
    const beforeCount = scrapeRequests().length;
    const res = await call("spicrawl_scrape", { url: "https://example.com", render: true, actions: [{ type: "teleport" }] });
    assert.ok(res.rpcError || res.isError, "expected a validation error");
    assert.equal(scrapeRequests().length, beforeCount);
  });

  test("a scroll needs y, to_bottom or selector", async () => {
    const beforeCount = scrapeRequests().length;
    const res = await call("spicrawl_scrape", { url: "https://example.com", render: true, actions: [{ type: "scroll" }] });
    assert.ok(res.rpcError || res.isError, "expected a validation error");
    assert.equal(scrapeRequests().length, beforeCount);
  });

  test("the tool description carries a working scroll example", async () => {
    const { tools } = await client.listTools();
    const scrape = tools.find((t) => t.name === "spicrawl_scrape");
    const desc = scrape.inputSchema.properties.actions.description;
    const example = desc.match(/infinite scroll: (\[.*?\])/)?.[1];
    assert.ok(example, `no scroll example in: ${desc}`);
    // The example must itself validate: send it and check it reaches the API.
    const res = await call("spicrawl_scrape", { url: "https://example.com", render: true, actions: JSON.parse(example) });
    assert.equal(res.isError ?? false, false, res.content?.[0]?.text);
    assert.deepEqual(scrapeRequests().at(-1).body.actions[0], { scroll: { to_bottom: true } });
  });

  test("API errors name the tool's arguments, not the API's", async () => {
    const res = await call("spicrawl_scrape", { url: "https://needs-render.test/" });
    assert.equal(res.isError, true);
    const text = res.content[0].text;
    assert.match(text, /`render=true`/);
    assert.match(text, /`format=pdf`/);
    assert.doesNotMatch(text, /js_render|response_format/);
  });
});

describe("spicrawl_batch_submit output format", () => {
  const submits = () => api.requests.filter((r) => r.method === "POST" && r.path === "/v1/batch");

  test("defaults to markdown, the same as spicrawl_scrape", async () => {
    const before = submits().length;
    await call("spicrawl_batch_submit", { urls: ["https://example.com"] });
    const sent = submits().slice(before);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].body.response_format, "markdown");
  });

  test("an explicit format is sent as given", async () => {
    const before = submits().length;
    await call("spicrawl_batch_submit", { urls: ["https://example.com"], format: "html" });
    assert.equal(submits().slice(before)[0].body.response_format, "html");
  });

  test("credit_budget reaches the API as credit_budget, in credits", async () => {
    const before = submits().length;
    await call("spicrawl_batch_submit", { urls: ["https://example.com"], credit_budget: 20 });
    assert.equal(submits().slice(before)[0].body.credit_budget, 20);
  });
});

describe("spicrawl_requests_list all_projects", () => {
  const lists = () => api.requests.filter((r) => r.method === "GET" && r.path === "/v1/requests");

  test("all_projects=true reaches the API as all_projects=true", async () => {
    const before = lists().length;
    const res = await call("spicrawl_requests_list", { all_projects: true, limit: 5 });
    assert.equal(res.rpcError, undefined, `unexpected JSON-RPC error: ${res.rpcError?.message}`);
    const sent = lists().slice(before);
    assert.equal(sent.length, 1);
    assert.equal(new URLSearchParams(sent[0].query).get("all_projects"), "true");
  });

  test("omitted or false sends no all_projects, so the key's project is listed", async () => {
    for (const args of [{}, { all_projects: false }]) {
      const before = lists().length;
      await call("spicrawl_requests_list", args);
      const sent = lists().slice(before);
      assert.equal(sent.length, 1);
      assert.equal(new URLSearchParams(sent[0].query).has("all_projects"), false);
    }
  });
});
