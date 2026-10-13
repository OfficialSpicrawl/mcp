// Keyless discovery on /mcp: `initialize`, `ping` and `tools/list` answer without an API
// key (so a directory such as Smithery can list the tools while the key is an optional
// connection parameter), and nothing else does. Every tool call still needs a valid key,
// no session is opened for a keyless caller, and a session stays pinned to its key.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  INITIALIZE_BODY,
  OTHER_VALID_KEY,
  TOOLS_CALL_BODY,
  TOOLS_LIST_BODY,
  VALID_KEY,
  connectClient,
  rawPost,
  startFakeApi,
  startMcp,
} from "./helpers/harness.mjs";

let api;
let mcp;
let cardURL;

before(async () => {
  api = await startFakeApi();
  mcp = await startMcp(api.url);
  cardURL = `${mcp.base}/.well-known/mcp/server-card.json`;
});

after(async () => {
  await mcp?.stop();
  await api?.close();
});

/** A keyless POST; `upstream` is what reached the fake API meanwhile (must stay empty). */
async function keyless(body, headers = {}) {
  const before = api.requests.length;
  const out = await rawPost(mcp.mcpURL, { body, headers });
  let json;
  try {
    json = JSON.parse(out.text);
  } catch {
    // 202 has no body
  }
  return { ...out, json, upstream: api.requests.slice(before) };
}

const sessions = async () => (await mcp.healthz()).body.sessions;

describe("keyless initialize", () => {
  test("answers 200 with the server's identity, opens no session and asks no one", async () => {
    const open = await sessions();
    const { res, json, upstream } = await keyless(INITIALIZE_BODY);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /^application\/json/);
    assert.equal(res.headers.get("mcp-session-id"), null, "a keyless caller gets no session to pin or hijack");
    assert.equal(json.id, INITIALIZE_BODY.id);
    assert.equal(json.result.protocolVersion, "2025-06-18");
    assert.equal(json.result.serverInfo.name, "spicrawl-mcp-server");
    assert.ok(json.result.capabilities.tools);
    assert.match(json.result.instructions, /No API key was sent/);
    assert.deepEqual(upstream, []);
    assert.equal(await sessions(), open);
  });

  test("an unsupported protocol version is answered with the latest supported one", async () => {
    const body = { ...INITIALIZE_BODY, params: { ...INITIALIZE_BODY.params, protocolVersion: "1999-01-01" } };
    const { json } = await keyless(body);
    assert.notEqual(json.result.protocolVersion, "1999-01-01");
    assert.match(json.result.protocolVersion, /^\d{4}-\d{2}-\d{2}$/);
  });

  test("an empty key header counts as no key (a gateway may send one for an unset parameter)", async () => {
    for (const headers of [{ "x-api-key": "" }, { "api-key": "  " }]) {
      const { res } = await keyless(INITIALIZE_BODY, headers);
      assert.equal(res.status, 200, JSON.stringify(headers));
    }
  });

  test("a key that was sent but is malformed is still refused, not treated as keyless", async () => {
    for (const headers of [{ "x-api-key": "not-a-key" }, { Authorization: "Bearer nope" }, { "api-key": "spicrawl_live_short" }]) {
      const { res, upstream } = await keyless(INITIALIZE_BODY, headers);
      assert.equal(res.status, 401, JSON.stringify(headers));
      assert.deepEqual(upstream, []);
    }
  });
});

describe("keyless tools/list", () => {
  test("is exactly the server card's tool list, and every tool has an outputSchema", async () => {
    const card = await (await fetch(cardURL)).json();
    const { res, json, upstream } = await keyless(TOOLS_LIST_BODY);
    assert.equal(res.status, 200);
    assert.deepEqual(json.result.tools, card.tools);
    assert.ok(json.result.tools.length > 0);
    for (const t of json.result.tools) assert.equal(t.outputSchema?.type, "object", `${t.name} outputSchema`);
    assert.deepEqual(upstream, []);
  });

  test("notifications get 202 and no body; ping gets an empty result", async () => {
    const note = await keyless({ jsonrpc: "2.0", method: "notifications/initialized" });
    assert.equal(note.res.status, 202);
    assert.equal(note.text, "");
    const ping = await keyless({ jsonrpc: "2.0", id: 9, method: "ping" });
    assert.deepEqual(ping.json, { jsonrpc: "2.0", id: 9, result: {} });
  });

  test("a batch of discovery messages is answered as a batch", async () => {
    const { json } = await keyless([INITIALIZE_BODY, { jsonrpc: "2.0", method: "notifications/initialized" }, TOOLS_LIST_BODY]);
    assert.ok(Array.isArray(json));
    assert.deepEqual(json.map((r) => r.id), [INITIALIZE_BODY.id, TOOLS_LIST_BODY.id]);
  });

  test("a real SDK client with no key connects and lists the tools", async () => {
    const before = api.requests.length;
    const client = new Client({ name: "keyless-test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(mcp.mcpURL)));
    try {
      const { tools } = await client.listTools();
      const card = await (await fetch(cardURL)).json();
      assert.deepEqual(tools.map((t) => t.name), card.tools.map((t) => t.name));
      assert.match(client.getInstructions() ?? "", /No API key/);
      await assert.rejects(() => client.callTool({ name: "spicrawl_usage_summary", arguments: {} }), /401|Unauthorized/);
    } finally {
      await client.close().catch(() => {});
    }
    assert.equal(api.requests.length, before, "nothing keyless reaches the API");
  });
});

describe("everything else still needs a key", () => {
  const refused = async (body, headers) => {
    const { res, text, upstream } = await keyless(body, headers);
    assert.equal(res.status, 401, text);
    assert.ok(res.headers.get("www-authenticate"));
    assert.match(text, /API key/);
    assert.match(text, /x-api-key/, "the refusal names where to send the key");
    assert.equal(res.headers.get("mcp-session-id"), null);
    assert.deepEqual(upstream, [], "the API must not be reached");
  };

  test("tools/call gets 401 and never reaches the API", async () => {
    await refused(TOOLS_CALL_BODY);
    await refused({ ...TOOLS_CALL_BODY, params: { name: "spicrawl_scrape", arguments: { url: "https://example.com" } } });
  });

  test("a batch with one non-discovery message is refused whole", async () => {
    await refused([INITIALIZE_BODY, TOOLS_CALL_BODY]);
    await refused([TOOLS_LIST_BODY, { jsonrpc: "2.0", id: 5, method: "resources/read", params: { uri: "x" } }]);
  });

  test("other methods, malformed bodies and an empty batch get 401", async () => {
    for (const method of ["resources/list", "prompts/list", "resources/read", "logging/setLevel", "completion/complete", "tasks/list"]) {
      await refused({ jsonrpc: "2.0", id: 1, method, params: {} });
    }
    await refused({ jsonrpc: "2.0", id: 1 });
    await refused({ jsonrpc: "2.0", id: 1, method: 7 });
    await refused([]);
    await refused("tools/list");
    await refused(null);
  });

  test("an oversized keyless body is refused rather than read to the 4 MiB limit", async () => {
    await refused({ ...TOOLS_LIST_BODY, params: { pad: "x".repeat(70 * 1024) } });
  });

  test("DELETE and a session-less GET: 401 for DELETE, 405 for GET (discovery keeps no stream)", async () => {
    const del = await fetch(mcp.mcpURL, { method: "DELETE" });
    assert.equal(del.status, 401);
    const get = await fetch(mcp.mcpURL, { headers: { Accept: "text/event-stream" } });
    assert.equal(get.status, 405);
    assert.equal(get.headers.get("allow"), "POST");
  });

  test("a keyless request naming a session is refused, whether or not the session exists", async () => {
    const { client, transport } = await connectClient(mcp.mcpURL);
    try {
      const sid = transport.sessionId;
      assert.ok(sid);
      for (const id of [sid, "00000000-0000-4000-8000-000000000000"]) {
        const headers = { "Mcp-Session-Id": id, "Mcp-Protocol-Version": "2025-06-18" };
        await refused(TOOLS_LIST_BODY, headers);
        await refused(INITIALIZE_BODY, headers);
        const get = await fetch(mcp.mcpURL, { headers: { Accept: "text/event-stream", ...headers } });
        assert.equal(get.status, 401);
      }
      // The session still works for its own key and is still pinned to it.
      assert.ok((await client.listTools()).tools.length > 0);
      const other = await rawPost(mcp.mcpURL, {
        key: OTHER_VALID_KEY,
        sessionId: sid,
        body: TOOLS_LIST_BODY,
      });
      assert.equal(other.res.status, 403);
    } finally {
      await client.close().catch(() => {});
    }
  });
});

describe("a keyed caller is unaffected", () => {
  test("initialize with a key still opens a pinned session and calls the API under that key", async () => {
    const before = api.requests.length;
    const { client, transport } = await connectClient(mcp.mcpURL, VALID_KEY);
    try {
      assert.ok(transport.sessionId, "a keyed initialize issues a session id");
      const res = await client.callTool({ name: "spicrawl_batch_status", arguments: { job_id: "job_123" } });
      assert.equal(res.isError ?? false, false);
      const seen = api.requests.slice(before).filter((r) => r.path === "/v1/batch/job_123");
      assert.deepEqual(seen.map((r) => r.auth), [`Bearer ${VALID_KEY}`]);
    } finally {
      await client.close().catch(() => {});
    }
  });
});
