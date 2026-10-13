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

// The API key in the forms a gateway such as Smithery can send: it maps a
// parameter to a header but sends the raw value, and cannot always name it Authorization.
describe("API key forms", () => {
  const seen = []; // every key-shaped string sent and every answer body, checked for leaks at the end

  async function attempt(headers, { url = mcp.mcpURL, key, body } = {}) {
    const before = api.requests.length;
    const out = await rawPost(url, { key, headers, body });
    seen.push(out.text);
    return { ...out, upstream: api.requests.slice(before) };
  }

  const FORMS = {
    "Authorization: Bearer <key>": { key: VALID_KEY },
    "authorization: bearer <key> (scheme in any case)": { headers: { Authorization: `bearer ${VALID_KEY}` } },
    "Authorization: <key> (raw)": { headers: { Authorization: VALID_KEY } },
    "x-api-key: <key>": { headers: { "x-api-key": VALID_KEY } },
    "api-key: <key>": { headers: { "api-key": VALID_KEY } },
  };

  for (const [name, { key, headers }] of Object.entries(FORMS)) {
    test(`${name} opens a session, and the API sees it as a Bearer key`, async () => {
      const { res, text, upstream } = await attempt(headers, { key });
      assert.equal(res.status, 200, text);
      assert.ok(res.headers.get("mcp-session-id"));
      assert.deepEqual(upstream.map((r) => r.auth), [`Bearer ${VALID_KEY}`]);
    });
  }

  test("the first form that holds a key wins, and one without a key's shape is skipped", async () => {
    const both = await attempt({ Authorization: `Bearer ${VALID_KEY}`, "x-api-key": OTHER_VALID_KEY });
    assert.equal(both.res.status, 200, both.text);
    assert.deepEqual(both.upstream.map((r) => r.auth), [`Bearer ${VALID_KEY}`]);

    const fallsThrough = await attempt({ Authorization: "Bearer not-a-key", "x-api-key": OTHER_VALID_KEY });
    assert.equal(fallsThrough.res.status, 200, fallsThrough.text);
    assert.deepEqual(fallsThrough.upstream.map((r) => r.auth), [`Bearer ${OTHER_VALID_KEY}`]);
  });

  test("a session opened with x-api-key is pinned to that key, whichever form the next request uses", async () => {
    const open = await attempt({ "x-api-key": VALID_KEY });
    const sid = open.res.headers.get("mcp-session-id");
    const session = { "Mcp-Session-Id": sid, "Mcp-Protocol-Version": "2025-06-18" };
    const same = await attempt({ Authorization: VALID_KEY, ...session }, { body: TOOLS_LIST });
    assert.equal(same.res.status, 200, same.text);
    const other = await attempt({ "api-key": OTHER_VALID_KEY, ...session }, { body: TOOLS_LIST });
    assert.equal(other.res.status, 403, other.text);
  });

  test("a malformed value in any form gets 401 and asks no one", async () => {
    const bad = [
      { Authorization: "spicrawl_live_short" },
      { Authorization: `Basic ${VALID_KEY}` },
      { Authorization: `Bearer ${VALID_KEY}x y` },
      { Authorization: `${VALID_KEY} extra` },
      { "x-api-key": "spicrawl_prod_" + "a".repeat(52) },
      { "x-api-key": `Bearer ${VALID_KEY}` },
      { "api-key": "not-a-key" },
      { "x-api-key": "" },
    ];
    for (const headers of bad) {
      const { res, text, upstream } = await attempt(headers);
      assert.equal(res.status, 401, JSON.stringify(headers));
      assert.ok(res.headers.get("www-authenticate"), JSON.stringify(headers));
      assert.match(text, /x-api-key/);
      assert.deepEqual(upstream, [], JSON.stringify(headers));
    }
  });

  test("a key in the query string is not read", async () => {
    for (const q of ["api_key", "apiKey", "x-api-key", "api-key", "authorization", "key"]) {
      const { res, upstream } = await attempt({}, { url: `${mcp.mcpURL}?${q}=${VALID_KEY}` });
      assert.equal(res.status, 401, q);
      assert.deepEqual(upstream, [], q);
    }
  });

  test("a well-formed key the API refuses gets 401 from the API's answer", async () => {
    const { res, text } = await attempt({ "x-api-key": UNKNOWN_KEY });
    assert.equal(res.status, 401, text);
    assert.match(text, /ERR::AUTH::INVALID_KEY/);
  });

  test("an API outage while checking an x-api-key gets 503", async () => {
    api.mode = "503";
    try {
      const { res, text } = await attempt({ "x-api-key": VALID_KEY });
      assert.equal(res.status, 503, text);
    } finally {
      api.mode = "up";
    }
  });

  test("no key appears in an answer body or in the server's log", () => {
    const log = mcp.stderr();
    for (const secret of [VALID_KEY, OTHER_VALID_KEY, UNKNOWN_KEY, "spicrawl_live_short", "spicrawl_prod_", "not-a-key"]) {
      assert.ok(!log.includes(secret), `log contains ${secret}`);
      for (const body of seen) assert.ok(!body.includes(secret), `a response body contains ${secret}`);
    }
  });
});
