// spicrawl_feedback and the failure text around it: the tool's strict input, the request it
// sends, each result text, the request id and report hint on a failed call, and where the tool
// (and the hint) is and is not offered: standard sessions yes; partner and ChatGPT no.
// A fake API on loopback answers; nothing reaches a real deployment.

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { after, before, describe, test } from "node:test";
import {
  DEFAULT_RESOURCE,
  INTROSPECT_SECRET,
  OTHER_VALID_KEY,
  PARTNER_KEY,
  VALID_KEY,
  chatgptPost,
  claims,
  connectClient,
  oat,
  startFakeIntrospection,
  startMcp,
} from "./helpers/harness.mjs";

const KEY_INFO = {
  key_id: "01KEY", name: "Default", prefix: "spicrawl_live_aaaa", scopes: ["scrape", "batch", "sessions"], environment: "live",
  organization: { id: "org_1", name: "Acme" }, partner: false, workspace_of_partner: false, created_at: "2026-11-18T09:00:00Z", expires_at: null,
};
const PARTNER_INFO = { ...KEY_INFO, scopes: ["partner", "read"], partner: true };

const REPORT_URL = "https://docs.spicrawl.com/feedback";
const FAILING = {
  "https://reportable.test/": { body: { request_id: "req_body", feedback_url: REPORT_URL }, headers: {} },
  "https://header-id.test/": { body: { feedback_url: REPORT_URL }, headers: { "X-Request-Id": "req_header" } },
  "https://body-wins.test/": { body: { request_id: "req_body", feedback_url: REPORT_URL }, headers: { "X-Request-Id": "req_header" } },
  "https://not-reportable.test/": { body: { request_id: "req_plain" }, headers: {} },
  "https://no-id.test/": { body: { feedback_url: REPORT_URL }, headers: {} },
  "https://header-only.test/": { body: {}, headers: { "X-Request-Id": "req_hdr_only" } },
};
const FEEDBACK_REPLIES = {
  req_new: [201, { feedback_id: "fb_1", already_submitted: false, credits_refunded: 3, refund_cap_reached: false }],
  req_free: [201, { feedback_id: "fb_2", already_submitted: false, credits_refunded: 0, refund_cap_reached: false }],
  req_cap: [201, { feedback_id: "fb_3", already_submitted: false, credits_refunded: 0, refund_cap_reached: true }],
  req_dup: [200, { feedback_id: "fb_1", already_submitted: true, credits_refunded: 0, refund_cap_reached: false }],
  req_404: [404, { code: "ERR::REQUEST::NOT_FOUND", title: "Not found", detail: "no such request", request_id: "req_fb404" }],
  req_409: [409, { code: "ERR::REQUEST::CONFLICT", title: "Conflict", detail: "not eligible", request_id: "req_fb409" }],
  req_429: [429, { code: "ERR::LIMIT::RATE", title: "Rate limited", detail: "slow down", retryable: true, request_id: "req_fb429" }],
  req_500: [500, { code: "ERR::INTERNAL::ERROR", title: "Internal", detail: "boom", retryable: true, request_id: "req_fb500", feedback_url: REPORT_URL }],
};

let api;
let apiServer;
let mcp;
let idp;
let std;
let partner;

async function startApi() {
  const f = { requests: [], url: "" };
  apiServer = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf8");
    const body = raw ? JSON.parse(raw) : undefined;
    const path = new URL(req.url, "http://fake").pathname;
    f.requests.push({ method: req.method, path, body, auth: req.headers.authorization });
    const send = (status, obj, headers = {}) => {
      res.writeHead(status, { "Content-Type": status >= 400 ? "application/problem+json" : "application/json", ...headers });
      res.end(JSON.stringify(obj));
    };
    const key = /^Bearer (\S+)$/.exec(req.headers.authorization || "")?.[1];
    if (req.method === "GET" && path === "/v1/key") return send(200, key === PARTNER_KEY ? PARTNER_INFO : KEY_INFO);
    if (req.method === "POST" && path === "/v1/feedback") {
      const [status, out] = FEEDBACK_REPLIES[body.request_id] ?? [404, { code: "ERR::REQUEST::NOT_FOUND", detail: "unknown" }];
      return send(status, { type: "about:blank", status, ...out });
    }
    if (req.method === "POST" && path === "/v1/scrape" && FAILING[body?.url]) {
      const { body: extra, headers } = FAILING[body.url];
      return send(502, { type: "about:blank", status: 502, code: "ERR::UPSTREAM::FAILED", title: "Bad gateway", detail: "the fetch failed", retryable: false, ...extra }, headers);
    }
    if (req.method === "GET" && path === "/v1/partner/wallet") {
      return send(500, { type: "about:blank", status: 500, code: "ERR::INTERNAL::ERROR", title: "Internal", detail: "boom", retryable: true, request_id: "req_partner", feedback_url: REPORT_URL });
    }
    return send(404, { type: "about:blank", status: 404, code: "ERR::NOT_FOUND", detail: `no fake route ${path}` });
  });
  apiServer.listen(0, "127.0.0.1");
  await once(apiServer, "listening");
  f.url = `http://127.0.0.1:${apiServer.address().port}`;
  return f;
}

before(async () => {
  api = await startApi();
  idp = await startFakeIntrospection();
  idp.tokens.set(oat("good"), () => claims());
  mcp = await startMcp(api.url, {
    SPICRAWL_CHATGPT_ENABLED: "1",
    SPICRAWL_OAUTH_ISSUER: idp.url,
    SPICRAWL_OAUTH_INTROSPECT_SECRET: INTROSPECT_SECRET,
  });
  ({ client: std } = await connectClient(mcp.mcpURL, VALID_KEY));
  ({ client: partner } = await connectClient(mcp.mcpURL, PARTNER_KEY));
});

after(async () => {
  await std?.close().catch(() => {});
  await partner?.close().catch(() => {});
  await mcp?.stop();
  await idp?.close();
  await new Promise((r) => apiServer?.close(() => r()) ?? r());
});

const textOf = (res) => (res.content ?? []).map((c) => c.text).join("\n");
const feedbackCalls = () => api.requests.filter((r) => r.path === "/v1/feedback");

/** Calls a tool; a JSON-RPC error comes back as { rpcError } with the message as text. */
async function call(client, name, args) {
  try {
    return await client.callTool({ name, arguments: args });
  } catch (err) {
    return { rpcError: err, isError: true, content: [{ type: "text", text: err.message }] };
  }
}
const report = (args, client = std) => call(client, "spicrawl_feedback", args);
const scrape = (url, client = std) => call(client, "spicrawl_scrape", { url });

describe("spicrawl_feedback input", () => {
  test("request_id is required and non-empty", async () => {
    const before = feedbackCalls().length;
    assert.equal((await report({})).isError, true);
    assert.equal((await report({ request_id: "" })).isError, true);
    assert.equal(feedbackCalls().length, before);
  });

  test("unknown arguments are refused, not dropped", async () => {
    const before = feedbackCalls().length;
    const res = await report({ request_id: "req_new", severity: "high" });
    assert.equal(res.isError, true);
    assert.match(textOf(res), /severity|unrecognized/i);
    assert.equal(feedbackCalls().length, before);
  });

  test("rating, kind and impact take only their listed values", async () => {
    const before = feedbackCalls().length;
    for (const bad of [{ rating: "sideways" }, { kind: "slow" }, { impact: "huge" }]) {
      assert.equal((await report({ request_id: "req_new", ...bad })).isError, true, JSON.stringify(bad));
    }
    assert.equal(feedbackCalls().length, before);
  });

  test("intent is capped at 300 characters and comment at 4000", async () => {
    const before = feedbackCalls().length;
    assert.equal((await report({ request_id: "req_new", intent: "i".repeat(301) })).isError, true);
    assert.equal((await report({ request_id: "req_new", comment: "c".repeat(4001) })).isError, true);
    assert.equal(feedbackCalls().length, before);
    assert.notEqual((await report({ request_id: "req_new", intent: "i".repeat(300), comment: "c".repeat(4000) })).isError, true);
  });

  test("the schema lists rating with default down", async () => {
    const tool = (await std.listTools()).tools.find((t) => t.name === "spicrawl_feedback");
    assert.deepEqual(tool.inputSchema.required, ["request_id"]);
    assert.equal(tool.inputSchema.properties.rating.default, "down");
  });
});

describe("spicrawl_feedback request", () => {
  test("a bare report posts rating down and the client name and version as agent", async () => {
    await report({ request_id: "req_new" });
    const sent = feedbackCalls().at(-1);
    assert.equal(sent.method, "POST");
    assert.equal(sent.auth, `Bearer ${VALID_KEY}`);
    assert.deepEqual(sent.body, { request_id: "req_new", rating: "down", agent: "spicrawl-mcp-test/0.0.0" });
  });

  test("every argument is mapped to its API field", async () => {
    await report({ request_id: "req_new", rating: "up", kind: "wrong_result", impact: "worked_around", intent: "the prices", comment: "got the footer" });
    assert.deepEqual(feedbackCalls().at(-1).body, {
      request_id: "req_new", rating: "up", kind: "wrong_result", impact: "worked_around",
      intent: "the prices", comment: "got the footer", agent: "spicrawl-mcp-test/0.0.0",
    });
  });
});

describe("spicrawl_feedback results", () => {
  test("201: Reported, with the feedback id and the refund", async () => {
    const res = await report({ request_id: "req_new" });
    assert.notEqual(res.isError, true);
    assert.equal(textOf(res), "Reported (feedback fb_1). Refunded 3 credits.");
    assert.equal(res.structuredContent.credits_refunded, 3);
  });

  test("201 with nothing to refund says 0 credits", async () => {
    assert.equal(textOf(await report({ request_id: "req_free" })), "Reported (feedback fb_2). Refunded 0 credits.");
  });

  test("201 at the refund cap says so", async () => {
    const text = textOf(await report({ request_id: "req_cap" }));
    assert.match(text, /^Reported \(feedback fb_3\)\. Refunded 0 credits\./);
    assert.match(text, /daily refund cap is reached/);
  });

  test("200: Already reported", async () => {
    const res = await report({ request_id: "req_dup" });
    assert.notEqual(res.isError, true);
    assert.equal(textOf(res), "Already reported.");
  });

  test("404: an error that the request is not theirs", async () => {
    const res = await report({ request_id: "req_404" });
    assert.equal(res.isError, true);
    assert.match(textOf(res), /No such request for this API key/);
    assert.match(textOf(res), /wait a few seconds and try once more/);
  });

  test("409: an error that the request cannot take feedback", async () => {
    const res = await report({ request_id: "req_409" });
    assert.equal(res.isError, true);
    assert.match(textOf(res), /rate- or quota-limited/);
  });

  test("429: an error that says not to retry", async () => {
    const res = await report({ request_id: "req_429" });
    assert.equal(res.isError, true);
    assert.match(textOf(res), /do not retry/);
    assert.doesNotMatch(textOf(res), /may succeed on a retry/);
  });

  test("any other failure renders like every tool's: code, request id and the report hint", async () => {
    const res = await report({ request_id: "req_500" });
    assert.equal(res.isError, true);
    assert.match(textOf(res), /ERR::INTERNAL::ERROR: boom/);
    assert.match(textOf(res), /Request ID: req_fb500/);
    assert.match(textOf(res), /spicrawl_feedback/);
  });
});

describe("a failed call on the standard surface", () => {
  test("reportable with a body request id: the id line and the report sentence", async () => {
    const text = textOf(await scrape("https://reportable.test/"));
    assert.match(text, /ERR::UPSTREAM::FAILED: the fetch failed/);
    assert.match(text, /\nRequest ID: req_body/);
    assert.match(text, /call spicrawl_feedback with request_id "req_body"/);
  });

  test("the request id may come only from the X-Request-Id header", async () => {
    const text = textOf(await scrape("https://header-id.test/"));
    assert.match(text, /Request ID: req_header/);
    assert.match(text, /call spicrawl_feedback with request_id "req_header"/);
  });

  test("the body's request id wins over the header", async () => {
    const text = textOf(await scrape("https://body-wins.test/"));
    assert.match(text, /Request ID: req_body/);
    assert.doesNotMatch(text, /req_header/);
  });

  test("without feedback_url there is a Request ID line and no report sentence", async () => {
    const text = textOf(await scrape("https://not-reportable.test/"));
    assert.match(text, /Request ID: req_plain/);
    assert.doesNotMatch(text, /spicrawl_feedback/);
  });

  test("a header-only id with no feedback_url still prints the id, no sentence", async () => {
    const text = textOf(await scrape("https://header-only.test/"));
    assert.match(text, /Request ID: req_hdr_only/);
    assert.doesNotMatch(text, /spicrawl_feedback/);
  });

  test("feedback_url without any request id gets no sentence (the report needs the id)", async () => {
    const text = textOf(await scrape("https://no-id.test/"));
    assert.doesNotMatch(text, /spicrawl_feedback|Request ID/);
  });
});

describe("where the tool is offered", () => {
  const names = async (c) => (await c.listTools()).tools.map((t) => t.name);

  test("the standard server lists spicrawl_feedback", async () => {
    assert.ok((await names(std)).includes("spicrawl_feedback"));
  });

  test("the partner server does not", async () => {
    const list = await names(partner);
    assert.ok(list.some((n) => n.startsWith("spicrawl_partner_")));
    assert.ok(!list.includes("spicrawl_feedback"));
    assert.equal((await call(partner, "spicrawl_feedback", { request_id: "req_new" })).isError, true);
  });

  test("the ChatGPT server does not", async () => {
    const { res, json } = await chatgptPost(mcp.chatgptURL, { token: oat("good"), body: { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} } });
    assert.equal(res.status, 200);
    const list = json.result.tools.map((t) => t.name);
    assert.ok(list.includes("spicrawl_scrape"));
    assert.ok(!list.includes("spicrawl_feedback"));
  });

  test("a partner error has no report hint", async () => {
    const text = textOf(await call(partner, "spicrawl_partner_balance", {}));
    assert.match(text, /ERR::INTERNAL::ERROR/);
    assert.doesNotMatch(text, /spicrawl_feedback/);
  });

  test("a ChatGPT error has no report hint", async () => {
    const body = { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "spicrawl_scrape", arguments: { url: "https://reportable.test/" } } };
    const { res, json, text } = await chatgptPost(mcp.chatgptURL, { token: oat("good"), body });
    assert.equal(res.status, 200, text);
    const out = json.result.content.map((c) => c.text).join("\n");
    assert.equal(json.result.isError, true, out);
    assert.match(out, /ERR::UPSTREAM::FAILED/);
    assert.doesNotMatch(out, /spicrawl_feedback|Request ID/);
  });

  test("concurrent sessions do not leak the flag: a standard and a partner error side by side", async () => {
    const { client: other } = await connectClient(mcp.mcpURL, OTHER_VALID_KEY);
    try {
      const rounds = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          i % 2 === 0 ? scrape("https://reportable.test/", i % 4 === 0 ? std : other) : call(partner, "spicrawl_partner_balance", {}),
        ),
      );
      rounds.forEach((r, i) => {
        if (i % 2 === 0) assert.match(textOf(r), /call spicrawl_feedback with request_id/);
        else assert.doesNotMatch(textOf(r), /spicrawl_feedback/);
      });
    } finally {
      await other.close().catch(() => {});
    }
  });
});

describe("initialize instructions", () => {
  test("the standard server tells an agent when to report", () => {
    const text = std.getInstructions();
    assert.match(text, /spicrawl_feedback/);
    assert.match(text, /request_id/);
    assert.match(text, /secrets/i);
  });

  test("a partner server does not point an agent at a tool it lacks", () => {
    assert.equal(partner.getInstructions(), undefined);
    assert.doesNotMatch(partner.getInstructions() ?? "", /spicrawl_feedback/);
  });

  test("the ChatGPT server does not either", async () => {
    const { json } = await chatgptPost(mcp.chatgptURL, { token: oat("good") });
    assert.doesNotMatch(json.result.instructions ?? "", /spicrawl_feedback/);
  });
});
