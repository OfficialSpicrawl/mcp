// Output schemas: spicrawl_scrape's schema, and the rules every tool's schema follows.
// Calls go through a real MCP session. The SDK client validates each result's
// structuredContent against the outputSchema it was listed with, so a successful call
// here already proves the result conforms; the assertions add what that cannot.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import {
  ENVELOPE_PAYLOAD,
  PNG_1X1,
  connectClient,
  forbiddenIn,
  startFakeApi,
  startMcp,
} from "./helpers/harness.mjs";

let api;
let mcp;
let client;
let tools;

before(async () => {
  api = await startFakeApi();
  mcp = await startMcp(api.url);
  ({ client } = await connectClient(mcp.mcpURL));
  tools = (await client.listTools()).tools;
});

after(async () => {
  await client?.close().catch(() => {});
  await mcp?.stop();
  await api?.close();
});

async function call(name, args) {
  try {
    return await client.callTool({ name, arguments: args });
  } catch (err) {
    return { rpcError: err };
  }
}

const ok = (res) => {
  assert.equal(res.rpcError, undefined, `JSON-RPC error: ${res.rpcError?.message}`);
  assert.equal(res.isError ?? false, false, `tool error: ${res.content?.[0]?.text}`);
  return res;
};

/** Schema keywords found anywhere in a JSON Schema, walking only schema positions (not property names). */
function keywords(schema, path = "", out = []) {
  if (!schema || typeof schema !== "object") return out;
  for (const [k, v] of Object.entries(schema)) {
    if (k === "properties") {
      for (const [name, sub] of Object.entries(v)) keywords(sub, `${path}/${name}`, out);
    } else if (k === "items" || k === "additionalProperties") {
      if (typeof v === "object") keywords(v, `${path}/${k}`, out);
      else out.push([`${path}/${k}`, k, v]);
    } else if (k === "anyOf" || k === "oneOf" || k === "allOf") {
      v.forEach((sub, i) => keywords(sub, `${path}/${k}${i}`, out));
    } else {
      out.push([path, k, v]);
    }
  }
  return out;
}

describe("every tool declares an outputSchema", () => {
  test("all tools, including the one hidden by SPICRAWL_MCP_HIDE_UNAVAILABLE", () => {
    assert.equal(tools.length, 25);
    const missing = tools.filter((t) => !t.outputSchema).map((t) => t.name);
    assert.deepEqual(missing, []);
    for (const t of tools) {
      assert.equal(t.outputSchema.type, "object", `${t.name}: MCP requires an object output schema`);
      assert.equal(t.outputSchema.additionalProperties, true, `${t.name}: output objects stay open to new API fields`);
    }
  });

  test("no schema closes what the API may extend: no enum, const, format or additionalProperties:false", () => {
    // A client rejects a result that fails its schema, so a value the API adds later
    // would break every call. Allowed values belong in the description text.
    const bad = [];
    for (const t of tools) {
      for (const [path, keyword, value] of keywords(t.outputSchema)) {
        if (["enum", "const", "format", "pattern"].includes(keyword)) bad.push(`${t.name}${path}: ${keyword}`);
        if (keyword === "additionalProperties" && value === false) bad.push(`${t.name}${path}: additionalProperties false`);
      }
    }
    assert.deepEqual(bad, []);
  });

  test("no schema is vacuous: each describes named fields", () => {
    for (const t of tools) assert.ok(Object.keys(t.outputSchema.properties ?? {}).length > 0, `${t.name} describes no fields`);
  });

  test("no schema names an internal engine", () => {
    assert.deepEqual(forbiddenIn(tools.map((t) => t.outputSchema)), []);
  });
});

describe("spicrawl_scrape", () => {
  test("markdown: structuredContent is the {content} object and the text is the same JSON", async () => {
    const res = ok(await call("spicrawl_scrape", { url: "https://raw.test/" }));
    assert.deepEqual(res.structuredContent, { content: "# Raw page\n" });
    assert.deepEqual(JSON.parse(res.content[0].text), res.structuredContent);
  });

  test("the JSON envelope validates, and fields the schema does not know ride along", async () => {
    const res = ok(await call("spicrawl_scrape", { url: "https://envelope.test/", format: "json" }));
    assert.deepEqual(res.structuredContent, ENVELOPE_PAYLOAD);
    assert.equal(res.structuredContent.credits, 3);
    assert.equal(res.structuredContent.request_id, ENVELOPE_PAYLOAD.request_id, "unknown field kept");
  });

  test("a screenshot: the metadata validates and the image is a separate block", async () => {
    const res = ok(await call("spicrawl_scrape", { url: "https://example.com", render: true, screenshot: true }));
    assert.equal(res.content[1].type, "image");
    assert.equal(res.content[1].data, PNG_1X1);
    const [shot] = res.structuredContent.screenshots;
    assert.equal(shot.format, "png");
    assert.match(shot.attached_as, /image content block 1/);
  });

  test("a PDF: the file is a resource block and pdf describes it", async () => {
    const res = ok(await call("spicrawl_scrape", { url: "https://example.com", format: "pdf" }));
    assert.equal(res.content[1].type, "resource");
    assert.equal(res.structuredContent.pdf.content_type, "application/pdf");
    assert.match(res.structuredContent.pdf.attached_as, /resource content block 1/);
    assert.equal(res.structuredContent.credits, 8);
  });

  test("null warnings, headers and links are accepted (the API may send null for an empty list)", async () => {
    const schema = tools.find((t) => t.name === "spicrawl_scrape").outputSchema.properties;
    for (const field of ["warnings", "headers", "links", "data", "screenshots", "network", "diagnostics"]) {
      assert.ok(
        JSON.stringify(schema[field]).includes('"null"'),
        `${field} should allow null`,
      );
    }
  });

  test("a refusal is a tool error with no structuredContent, so the schema never hides an API error", async () => {
    const res = await call("spicrawl_scrape", { url: "https://over-quota.test/" });
    assert.equal(res.isError, true);
    assert.equal(res.structuredContent, undefined);
    assert.match(res.content[0].text, /ERR::LIMIT::QUOTA_EXCEEDED/);
  });
});
