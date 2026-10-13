// Every spicrawl_batch_* tool declares an outputSchema, and a real call through the
// MCP server returns structuredContent that validates against it, with the text
// content unchanged. The upstream is a fake API defined here (the shared harness
// has no cancel/retry/close/add-items/list routes).

import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { after, before, describe, test } from "node:test";
import Ajv from "ajv";
import {
  ARRAY_PAYLOAD,
  FULL_JOB,
  MARKDOWN_PAYLOAD,
  RESULT_LINES,
  connectClient,
  forbiddenIn,
  startMcp,
} from "./helpers/harness.mjs";

const BATCH_TOOLS = [
  "spicrawl_batch_submit",
  "spicrawl_batch_list",
  "spicrawl_batch_status",
  "spicrawl_batch_results",
  "spicrawl_batch_task_content",
  "spicrawl_batch_cancel",
  "spicrawl_batch_retry",
  "spicrawl_batch_add_items",
  "spicrawl_batch_close",
];

// A job as the API reports it, plus a field this server has never heard of.
const JOB = { ...FULL_JOB, open: true, some_future_field: { nested: true } };

let upstream;
let mcp;
let client;
let tools; // name -> tool definition from tools/list
const ajv = new Ajv({ strict: false, allErrors: true });

before(async () => {
  const server = createServer((req, res) => {
    const { pathname } = new URL(req.url, "http://fake");
    const json = (status, obj) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    const m = req.method;
    if (m === "POST" && pathname === "/v1/batch") return json(201, { ...JOB, warnings: ["concurrency clamped to 50"] });
    if (m === "GET" && pathname === "/v1/batch") return json(200, { batches: [JOB, FULL_JOB], next_cursor: "abc" });
    if (m === "GET" && pathname === "/v1/batch/job_full") return json(200, JOB);
    if (m === "GET" && pathname === "/v1/batch/job_full/results") {
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.end(RESULT_LINES.map((l) => JSON.stringify(l)).join("\n") + "\n");
      return;
    }
    if (m === "GET" && pathname === "/v1/batch/job_full/tasks/0/content") {
      return json(200, { content: "# A", status: 200, data: { title: "A" } }); // an object payload
    }
    if (m === "GET" && pathname === "/v1/batch/job_full/tasks/1/content") {
      res.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8" });
      res.end(MARKDOWN_PAYLOAD);
      return;
    }
    if (m === "GET" && pathname === "/v1/batch/job_full/tasks/2/content") return json(200, ARRAY_PAYLOAD);
    if (m === "GET" && pathname === "/v1/batch/job_full/tasks/3/content") return json(200, MARKDOWN_PAYLOAD); // bare JSON string
    if (m === "POST" && pathname === "/v1/batch/job_full/cancel") return json(200, { ...JOB, status: "cancelling" });
    if (m === "POST" && pathname === "/v1/batch/job_full/retry") return json(200, { job: JOB, items_reset: 1, items_dispatched: 1 });
    if (m === "POST" && pathname === "/v1/batch/job_full/items") return json(201, { job: JOB, items_added: 2, items_dispatched: 2 });
    if (m === "POST" && pathname === "/v1/batch/job_full/close") return json(200, { ...JOB, open: undefined });
    json(404, { status: 404, code: "ERR::NOT_FOUND", detail: `no fake route for ${m} ${pathname}`, retryable: false });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  upstream = { server, url: `http://127.0.0.1:${server.address().port}` };

  mcp = await startMcp(upstream.url);
  ({ client } = await connectClient(mcp.mcpURL));
  tools = new Map((await client.listTools()).tools.map((t) => [t.name, t]));
});

after(async () => {
  await client?.close().catch(() => {});
  await mcp?.stop();
  if (upstream) {
    upstream.server.closeAllConnections?.();
    await new Promise((r) => upstream.server.close(() => r()));
  }
});

/** Calls `name` and asserts it succeeded, returning the result. */
async function ok(name, args) {
  const res = await client.callTool({ name, arguments: args });
  assert.notEqual(res.isError, true, `${name} failed: ${res.content?.[0]?.text}`);
  return res;
}

/** Asserts `value` validates against the tool's advertised outputSchema. */
function assertValid(name, value) {
  const validate = ajv.compile(tools.get(name).outputSchema);
  assert.ok(validate(value), `${name}: structuredContent does not match its outputSchema: ${ajv.errorsText(validate.errors)}`);
}

describe("batch tools advertise an outputSchema", () => {
  test("every spicrawl_batch_* tool is covered and lists one", () => {
    const listed = [...tools.keys()].filter((n) => n.startsWith("spicrawl_batch_")).sort();
    assert.deepEqual(listed, [...BATCH_TOOLS].sort());
    for (const name of BATCH_TOOLS) {
      assert.equal(tools.get(name).outputSchema?.type, "object", `${name} has no object outputSchema`);
    }
  });

  test("schemas keep unknown API fields (additionalProperties is not false)", () => {
    for (const name of BATCH_TOOLS) {
      assert.notEqual(tools.get(name).outputSchema.additionalProperties, false, `${name} rejects extra fields`);
    }
  });

  test("schemas never name an internal engine", () => {
    for (const name of BATCH_TOOLS) assert.deepEqual(forbiddenIn(tools.get(name).outputSchema), [], name);
  });
});

describe("batch tools return structuredContent matching their outputSchema", () => {
  const cases = [
    ["spicrawl_batch_submit", { urls: ["https://example.com"] }],
    ["spicrawl_batch_list", {}],
    ["spicrawl_batch_status", { job_id: "job_full" }],
    ["spicrawl_batch_results", { job_id: "job_full" }],
    ["spicrawl_batch_task_content", { job_id: "job_full", seq: 0 }],
    ["spicrawl_batch_cancel", { job_id: "job_full" }],
    ["spicrawl_batch_retry", { job_id: "job_full" }],
    ["spicrawl_batch_add_items", { job_id: "job_full", urls: ["https://example.com/2"] }],
    ["spicrawl_batch_close", { job_id: "job_full" }],
  ];

  for (const [name, args] of cases) {
    test(name, async () => {
      const res = await ok(name, args);
      assert.ok(res.structuredContent, "no structuredContent");
      assertValid(name, res.structuredContent);
      // The text content is what it always was: the same object, pretty-printed.
      assert.deepEqual(JSON.parse(res.content[0].text), res.structuredContent);
    });
  }

  test("a job keeps fields the schema does not know", async () => {
    const res = await ok("spicrawl_batch_status", { job_id: "job_full" });
    assert.deepEqual(res.structuredContent.some_future_field, { nested: true });
    assert.equal(res.structuredContent.progress.percent_complete, 50);
  });

  test("results: each line carries seq/status, and failures their error", async () => {
    const { structuredContent: out } = await ok("spicrawl_batch_results", { job_id: "job_full" });
    assert.deepEqual(out.results.map((r) => [r.seq, r.status]), [[0, "succeeded"], [1, "failed"]]);
    assert.equal(out.results[1].error.code, "ERR::UPSTREAM::TIMEOUT");
  });

  test("retry and add_items nest the job", async () => {
    const retry = (await ok("spicrawl_batch_retry", { job_id: "job_full" })).structuredContent;
    assert.equal(retry.job.id, "job_full");
    assert.equal(retry.items_reset, 1);
    const add = (await ok("spicrawl_batch_add_items", { job_id: "job_full", urls: ["https://example.com/2"] })).structuredContent;
    assert.equal(add.job.id, "job_full");
    assert.equal(add.items_added, 2);
  });
});

describe("spicrawl_batch_task_content with every payload shape", () => {
  test("an object payload is returned as its own fields", async () => {
    const res = await ok("spicrawl_batch_task_content", { job_id: "job_full", seq: 0 });
    assert.deepEqual(res.structuredContent, { content: "# A", status: 200, data: { title: "A" } });
    assertValid("spicrawl_batch_task_content", res.structuredContent);
  });

  test("a markdown body arrives under `content`; the text is the body's envelope, unchanged", async () => {
    const res = await ok("spicrawl_batch_task_content", { job_id: "job_full", seq: 1 });
    assert.deepEqual(res.structuredContent, { content: MARKDOWN_PAYLOAD });
    assertValid("spicrawl_batch_task_content", res.structuredContent);
    assert.deepEqual(JSON.parse(res.content[0].text), { content: MARKDOWN_PAYLOAD });
  });

  test("an array payload arrives under `content`; the text is the array", async () => {
    const res = await ok("spicrawl_batch_task_content", { job_id: "job_full", seq: 2 });
    assert.deepEqual(res.structuredContent, { content: ARRAY_PAYLOAD });
    assertValid("spicrawl_batch_task_content", res.structuredContent);
    assert.deepEqual(JSON.parse(res.content[0].text), ARRAY_PAYLOAD);
  });

  test("a bare string payload arrives under `content`; the text is the string, unescaped", async () => {
    const res = await ok("spicrawl_batch_task_content", { job_id: "job_full", seq: 3 });
    assert.deepEqual(res.structuredContent, { content: MARKDOWN_PAYLOAD });
    assertValid("spicrawl_batch_task_content", res.structuredContent);
    assert.equal(res.content[0].text, MARKDOWN_PAYLOAD);
  });
});

describe("errors are unaffected by the schemas", () => {
  test("an upstream problem is still an isError result without structuredContent", async () => {
    const res = await client.callTool({ name: "spicrawl_batch_status", arguments: { job_id: "missing" } });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /ERR::NOT_FOUND/);
    assert.equal(res.structuredContent, undefined);
  });
});
