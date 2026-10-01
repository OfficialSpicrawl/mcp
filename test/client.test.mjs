import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ILayerClient, USER_AGENT, docsBaseFromEnv } from "../dist/client.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

// The API classifies the client surface from this header; without it every MCP
// call is counted as `other`.
test("every API call carries User-Agent: spicrawl-mcp/<package version>", async () => {
  assert.equal(USER_AGENT, `spicrawl-mcp/${pkg.version}`);

  const realFetch = globalThis.fetch;
  let seen;
  globalThis.fetch = async (_url, init) => {
    seen = init.headers;
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const client = new ILayerClient({ apiKey: "spicrawl_live_test", baseURL: "http://api.invalid" });
    await client.request("GET", "/v1/requests");
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(seen["User-Agent"], `spicrawl-mcp/${pkg.version}`);
});

// A stdio install configured with only a key must reach the live API and docs.
// The rename once left these on .dev hosts that have no DNS record.
test("with only a key configured, calls go to https://api.spicrawl.com", async () => {
  const realFetch = globalThis.fetch;
  let seen;
  globalThis.fetch = async (url) => {
    seen = String(url);
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const client = new ILayerClient({ apiKey: "spicrawl_live_test" });
    assert.equal(client.baseURL, "https://api.spicrawl.com");
    assert.equal(client.publicBaseURL, "https://api.spicrawl.com");
    await client.request("GET", "/v1/requests");
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(seen, "https://api.spicrawl.com/v1/requests");
});

// The docs are at the root of docs.spicrawl.com; a self-hosted deployment
// serves them at http://HOST:8080/docs.
test("the docs base defaults to the root of https://docs.spicrawl.com", () => {
  assert.equal(docsBaseFromEnv({}), "https://docs.spicrawl.com");
  // Pointing the stdio server at the public API explicitly changes nothing.
  assert.equal(docsBaseFromEnv({ SPICRAWL_BASE_URL: "https://api.spicrawl.com/" }), "https://docs.spicrawl.com");
});

test("SPICRAWL_DOCS_URL is the full base, path included, and wins over everything", () => {
  assert.equal(docsBaseFromEnv({ SPICRAWL_DOCS_URL: "https://docs.example.test" }), "https://docs.example.test");
  assert.equal(docsBaseFromEnv({ SPICRAWL_DOCS_URL: "http://10.0.0.200:8080/docs/" }), "http://10.0.0.200:8080/docs");
  assert.equal(
    docsBaseFromEnv({
      SPICRAWL_DOCS_URL: "https://docs.spicrawl.com",
      SPICRAWL_DOCS_HOST: "https://old.example.test",
      SPICRAWL_BASE_URL: "http://127.0.0.1:8080",
    }),
    "https://docs.spicrawl.com",
  );
  assert.equal(
    new ILayerClient({ apiKey: "spicrawl_live_test", docsBaseURL: "http://h:8080/docs/" }).docsBaseURL,
    "http://h:8080/docs",
  );
});

test("the legacy SPICRAWL_DOCS_HOST keeps its meaning: an origin with the docs at /docs", () => {
  assert.equal(docsBaseFromEnv({ SPICRAWL_DOCS_HOST: "https://docs.spicrawl.com" }), "https://docs.spicrawl.com/docs");
  assert.equal(docsBaseFromEnv({ SPICRAWL_DOCS_HOST: "http://10.0.0.200:8080/", SPICRAWL_BASE_URL: "http://x" }), "http://10.0.0.200:8080/docs");
  assert.equal(docsBaseFromEnv({ SPICRAWL_DOCS_HOST: "https://docs.example.test/docs" }), "https://docs.example.test/docs");
  // An empty SPICRAWL_DOCS_URL (an env file's `SPICRAWL_DOCS_URL=`) is unset.
  assert.equal(docsBaseFromEnv({ SPICRAWL_DOCS_URL: " ", SPICRAWL_DOCS_HOST: "https://h.test" }), "https://h.test/docs");
});

test("without a docs setting a self-hosted API's own /docs is used", () => {
  assert.equal(docsBaseFromEnv({ SPICRAWL_BASE_URL: "http://localhost:8080/" }), "http://localhost:8080/docs");
  assert.equal(
    docsBaseFromEnv({ SPICRAWL_BASE_URL: "http://127.0.0.1:8080", SPICRAWL_PUBLIC_BASE_URL: "https://api.example.test" }),
    "https://api.example.test/docs",
  );
});
