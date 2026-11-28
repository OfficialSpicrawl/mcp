// Origin allow-list and security headers on the hosted HTTP endpoint.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { originAllowed } from "../dist/httputil.js";
import { rawPost, startFakeApi, startMcp } from "./helpers/harness.mjs";

describe("originAllowed", () => {
  const none = new Set();
  for (const o of [
    "http://localhost:6274",
    "http://127.0.0.1:3000",
    "http://[::1]:8080",
    "https://claude.ai",
    "https://chatgpt.com",
    "https://chat.openai.com",
    "https://spicrawl.com",
    "https://app.spicrawl.com",
  ]) {
    test(`allows ${o}`, () => assert.equal(originAllowed(o, none), true));
  }
  for (const o of [
    "https://evil.example",
    "https://claude.ai.evil.com",
    "https://spicrawl.com.evil.com",
    "http://claude.ai",
    "null",
    "https://claude.ai/path",
    "https://claude.ai/",
    "https://app.spicrawl.com:8443",
  ]) {
    test(`rejects ${o}`, () => assert.equal(originAllowed(o, none), false));
  }
  test("allows an exact configured origin", () => {
    assert.equal(originAllowed("https://tools.example", new Set(["https://tools.example"])), true);
    assert.equal(originAllowed("https://other.example", new Set(["https://tools.example"])), false);
  });
});

const HEADERS = {
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
};
const hasSecurityHeaders = (res) => {
  for (const [k, v] of Object.entries(HEADERS)) assert.equal(res.headers.get(k), v, k);
};

describe("Origin check over HTTP", () => {
  let api, mcp, open;
  before(async () => {
    api = await startFakeApi();
    mcp = await startMcp(api.url);
    open = await startMcp(api.url, { SPICRAWL_MCP_ALLOWED_ORIGINS: "*" });
  });
  after(async () => {
    await mcp?.stop();
    await open?.stop();
    await api?.close();
  });
  const post = (m, origin) => rawPost(m.mcpURL, { headers: origin ? { Origin: origin } : {} });

  test("no Origin is not refused", async () => {
    const { res } = await post(mcp);
    assert.notEqual(res.status, 403);
  });
  test("a disallowed Origin gets 403 and a JSON-RPC error", async () => {
    const { res, text } = await post(mcp, "https://evil.example");
    assert.equal(res.status, 403);
    assert.match(text, /Origin not allowed: https:\/\/evil\.example/);
    assert.equal(JSON.parse(text).jsonrpc, "2.0");
    hasSecurityHeaders(res);
  });
  test("an allowed Origin is not refused", async () => {
    const { res } = await post(mcp, "https://claude.ai");
    assert.notEqual(res.status, 403);
    hasSecurityHeaders(res);
  });
  test("/healthz carries the security headers", async () => {
    hasSecurityHeaders(await fetch(`${mcp.base}/healthz`));
  });
  test('SPICRAWL_MCP_ALLOWED_ORIGINS="*" disables the check', async () => {
    const { res } = await post(open, "https://evil.example");
    assert.notEqual(res.status, 403);
  });
});
