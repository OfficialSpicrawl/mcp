// The hosted Streamable HTTP endpoint: key validation at session open, session
// binding, and lifecycle. Raw HTTP where status codes and headers matter.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import {
  OTHER_VALID_KEY,
  UNKNOWN_KEY,
  VALID_KEY,
  rawPost,
  startFakeApi,
  startMcp,
} from "./helpers/harness.mjs";

let api;
let mcp;

before(async () => {
  api = await startFakeApi();
  mcp = await startMcp(api.url);
});

after(async () => {
  await mcp?.stop();
  await api?.close();
});

async function openSession(key = VALID_KEY) {
  const { res, text } = await rawPost(mcp.mcpURL, { key });
  assert.equal(res.status, 200, text);
  const sid = res.headers.get("mcp-session-id");
  assert.ok(sid, "initialize must return an mcp-session-id header");
  return sid;
}

const TOOLS_LIST = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} };

async function sessionCount() {
  return (await mcp.healthz()).body.sessions;
}

// Tests in this file run in order; the key-validation block runs first so it
// can assert that no session was ever opened.
describe("key validation at session open", () => {
  test("an unknown key gets 401 with WWW-Authenticate and opens no session", async () => {
    const { res, text } = await rawPost(mcp.mcpURL, { key: UNKNOWN_KEY });
    assert.equal(res.status, 401, text);
    assert.ok(res.headers.get("www-authenticate"), "401 must carry WWW-Authenticate");
    assert.equal(res.headers.get("mcp-session-id"), null);
    assert.match(text, /ERR::AUTH::INVALID_KEY/);
    assert.equal(await sessionCount(), 0);
  });

  test("an API answering 503 gets 503, not 401", async () => {
    api.mode = "503";
    try {
      const { res, text } = await rawPost(mcp.mcpURL, { key: VALID_KEY });
      assert.equal(res.status, 503, text);
      assert.equal(res.headers.get("mcp-session-id"), null);
    } finally {
      api.mode = "up";
    }
    assert.equal(await sessionCount(), 0);
  });

  test("an unreachable API (connection reset) gets 503", async () => {
    api.mode = "reset";
    try {
      const { res, text } = await rawPost(mcp.mcpURL, { key: VALID_KEY });
      assert.equal(res.status, 503, text);
      assert.equal(res.headers.get("mcp-session-id"), null);
    } finally {
      api.mode = "up";
    }
    assert.equal(await sessionCount(), 0);
  });

  test("the valid key gets 200 and an mcp-session-id", async () => {
    const sid = await openSession();
    assert.ok(sid);
    assert.equal(await sessionCount(), 1);
  });
});

describe("endpoint behaviour", () => {
  test("GET /healthz answers 200 with a session count", async () => {
    const { status, body } = await mcp.healthz();
    assert.equal(status, 200);
    assert.equal(body.status, "ok");
    assert.equal(typeof body.sessions, "number");
  });

  test("no Authorization header gets 401", async () => {
    const { res, text } = await rawPost(mcp.mcpURL, {});
    assert.equal(res.status, 401, text);
    assert.ok(res.headers.get("www-authenticate"));
  });

  test("another valid key reusing a session id gets 403", async () => {
    const sid = await openSession(VALID_KEY);
    const { res, text } = await rawPost(mcp.mcpURL, { key: OTHER_VALID_KEY, sessionId: sid, body: TOOLS_LIST });
    assert.equal(res.status, 403, text);
  });

  test("an unknown session id gets 404", async () => {
    const { res, text } = await rawPost(mcp.mcpURL, {
      key: VALID_KEY,
      sessionId: "00000000-0000-4000-8000-000000000000",
      body: TOOLS_LIST,
    });
    assert.equal(res.status, 404, text);
  });

  test("DELETE closes the session", async () => {
    const sid = await openSession();
    const before = await sessionCount();
    const del = await fetch(mcp.mcpURL, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${VALID_KEY}`,
        "Mcp-Session-Id": sid,
        "Mcp-Protocol-Version": "2025-06-18",
      },
    });
    await del.text();
    assert.ok(del.status >= 200 && del.status < 300, `DELETE answered ${del.status}`);

    // Session teardown is asynchronous; give it a moment.
    const deadline = Date.now() + 2000;
    while ((await sessionCount()) !== before - 1 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(await sessionCount(), before - 1);
    const { res } = await rawPost(mcp.mcpURL, { key: VALID_KEY, sessionId: sid, body: TOOLS_LIST });
    assert.equal(res.status, 404);
  });
});
