// Docs tools (spicrawl_docs_search / _read / _index) through a real MCP session,
// against a fake Fumadocs site on loopback. The docs are public: no request to
// the docs host may carry the caller's API key.
//
// The suite runs once per way a docs base is configured: the hosted layout (the
// docs at the root of their host, SPICRAWL_DOCS_URL=https://docs.spicrawl.com),
// the self-hosted one (SPICRAWL_DOCS_URL=http://HOST:8080/docs), and the legacy
// origin-only SPICRAWL_DOCS_HOST, which still means <host>/docs.

import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { after, before, describe, test } from "node:test";
import { connectClient, startFakeApi, startMcp } from "./helpers/harness.mjs";

const ANTI_BOT_MD = "# Anti-bot handling\n\n## Challenge pages\n\nText.\n";
const INDEX_MD = "# Spicrawl\n\nThe overview.\n";

// Fumadocs' advanced search output: a page entry followed by its heading/text
// hits, `content` as Markdown with <mark> highlights, URLs including the site's
// base path. Two hits use other forms a consumer must map to the same pages: an
// absolute URL (which must not gain a second base path), and a path in the other
// layout (a root site's legacy /docs link, a self-hosted hit without /docs).
function searchResults(origin, prefix) {
  return [
    { id: "guides/anti-bot", type: "page", content: "<mark>Anti-bot</mark> handling", url: `${prefix}/guides/anti-bot`, breadcrumbs: ["Guides"] },
    { id: "guides/anti-bot-0", type: "heading", content: "Challenge pages", url: `${prefix}/guides/anti-bot#challenge-pages` },
    {
      id: "guides/anti-bot-1",
      type: "text",
      content: "When a target serves a <mark>bot</mark> wall, the scrape fails with `ERR::UPSTREAM::CHALLENGE`.",
      url: `${prefix}/guides/anti-bot#challenge-pages`,
    },
    { id: "guides/proxies-0", type: "text", content: "Residential exits get past most <mark>bot</mark> walls.", url: `${origin}${prefix}/guides/proxies-and-geo#residential` },
    { id: "guides/sessions-0", type: "text", content: "A session keeps a <mark>bot</mark> check passed.", url: `${prefix ? "" : "/docs"}/guides/sessions#reuse` },
  ];
}

/** A fake docs site whose routes all live under `prefix` ("" = the root of the host). */
async function startFakeDocs(prefix) {
  const docs = { requests: [], url: "", mode: "up", llmsTxt: "" };
  const server = createServer((req, res) => {
    if (docs.mode === "reset") return req.socket.destroy();
    const u = new URL(req.url, "http://fake");
    docs.requests.push({ path: u.pathname, query: u.searchParams.get("query"), auth: req.headers.authorization });
    const send = (type, body) => {
      res.writeHead(200, { "Content-Type": type });
      res.end(body);
    };
    switch (u.pathname) {
      case `${prefix}/api/search`: {
        const q = u.searchParams.get("query") ?? "";
        const all = searchResults(docs.url, prefix);
        const body = q.startsWith("ERR::") ? [] : q === "AUTH INVALID KEY" || q === "INVALID KEY" ? all.slice(0, 1) : all;
        return send("application/json", JSON.stringify(body));
      }
      case `${prefix}/guides/anti-bot.md`:
        return send("text/markdown", ANTI_BOT_MD);
      case `${prefix}/index.md`:
        return send("text/markdown", INDEX_MD);
      case `${prefix}/huge.md`:
        return send("text/markdown", "x".repeat(70_000));
      case `${prefix}/llms.txt`:
        return send("text/plain", docs.llmsTxt);
    }
    res.writeHead(404, { "Content-Type": "text/html" });
    res.end("<!DOCTYPE html><html>not found</html>");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  docs.url = `http://127.0.0.1:${server.address().port}`;
  docs.base = `${docs.url}${prefix}`;
  docs.llmsTxt = `# Spicrawl\n\n- [Anti-bot](${docs.base}/guides/anti-bot.md): handling bot walls\n`;
  docs.close = async () => {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(() => r()));
  };
  return docs;
}

const LAYOUTS = [
  { name: "SPICRAWL_DOCS_URL at the root of the docs host", prefix: "", env: (d) => ({ SPICRAWL_DOCS_URL: d.url, SPICRAWL_DOCS_HOST: "" }) },
  { name: "SPICRAWL_DOCS_URL with a /docs path (self-hosted)", prefix: "/docs", env: (d) => ({ SPICRAWL_DOCS_URL: `${d.url}/docs/`, SPICRAWL_DOCS_HOST: "" }) },
  { name: "legacy SPICRAWL_DOCS_HOST (origin, docs at /docs)", prefix: "/docs", env: (d) => ({ SPICRAWL_DOCS_URL: "", SPICRAWL_DOCS_HOST: d.url }) },
];

const ok = (res) => {
  assert.equal(res.rpcError, undefined, `unexpected JSON-RPC error: ${res.rpcError?.message}`);
  assert.equal(res.isError ?? false, false, `tool error: ${res.content?.[0]?.text}`);
};
const text = (res) => (res.content ?? []).map((c) => c.text).join("\n");

let api;
before(async () => {
  api = await startFakeApi();
});
after(async () => {
  await api?.close();
});

for (const layout of LAYOUTS) {
  describe(layout.name, () => {
    let docs;
    let mcp;
    let client;

    before(async () => {
      docs = await startFakeDocs(layout.prefix);
      mcp = await startMcp(api.url, layout.env(docs));
      ({ client } = await connectClient(mcp.mcpURL));
    });

    after(async () => {
      await client?.close().catch(() => {});
      await mcp?.stop();
      await docs?.close();
    });

    async function call(name, args) {
      try {
        return await client.callTool({ name, arguments: args });
      } catch (err) {
        return { rpcError: err };
      }
    }

    describe("spicrawl_docs_search", () => {
      test("groups results by page with title, section, snippet and md_url; relative, absolute and other-layout URLs alike", async () => {
        const res = await call("spicrawl_docs_search", { query: "bot wall" });
        ok(res);
        const { results, error_code } = res.structuredContent;
        assert.equal(error_code, undefined);
        assert.deepEqual(
          results.map((p) => p.md_url),
          [`${docs.base}/guides/anti-bot.md`, `${docs.base}/guides/proxies-and-geo.md`, `${docs.base}/guides/sessions.md`],
        );
        const [antiBot, proxies, sessions] = results;
        assert.equal(antiBot.title, "Anti-bot handling");
        assert.equal(antiBot.url, `${docs.base}/guides/anti-bot`);
        assert.deepEqual(antiBot.matches, [
          {
            heading: "Challenge pages",
            snippet: "When a target serves a bot wall, the scrape fails with `ERR::UPSTREAM::CHALLENGE`.",
            url: `${docs.base}/guides/anti-bot#challenge-pages`,
          },
        ]);
        assert.equal(proxies.matches[0].url, `${docs.base}/guides/proxies-and-geo#residential`);
        assert.equal(sessions.matches[0].url, `${docs.base}/guides/sessions#reuse`);
        assert.equal(docs.requests.at(-1).path, `${layout.prefix}/api/search`);
        assert.equal(docs.requests.at(-1).query, "bot wall");
      });

      test("limit caps the number of pages", async () => {
        const res = await call("spicrawl_docs_search", { query: "bot", limit: 1 });
        ok(res);
        assert.equal(res.structuredContent.results.length, 1);
      });

      test("an error code gets the errors-page anchor and falls back to the name when the code matches nothing", async () => {
        const res = await call("spicrawl_docs_search", { query: "ERR::AUTH::INVALID_KEY" });
        ok(res);
        const { code, url, md_url } = res.structuredContent.error_code;
        assert.deepEqual(
          { code, url, md_url },
          { code: "ERR::AUTH::INVALID_KEY", url: `${docs.base}/errors#AUTH_INVALID_KEY`, md_url: `${docs.base}/errors.md` },
        );
        assert.equal(res.structuredContent.results.length, 1);
        assert.deepEqual(docs.requests.slice(-2).map((r) => r.query), ["ERR::AUTH::INVALID_KEY", "INVALID KEY"]);
      });

      test("limit over 20 is refused", async () => {
        const res = await call("spicrawl_docs_search", { query: "x", limit: 21 });
        assert.ok(res.rpcError || res.isError);
      });
    });

    describe("spicrawl_docs_read", () => {
      const reads = () => [
        "guides/anti-bot",
        `${layout.prefix}/guides/anti-bot`,
        "/docs/guides/anti-bot",
        "docs/guides/anti-bot.md",
        "guides/anti-bot#challenge-pages",
        `${docs.base}/guides/anti-bot.md`,
        // An old link to the docs under /docs on the same host.
        `${docs.url}/docs/guides/anti-bot.md`,
      ];
      for (let i = 0; i < 7; i++) {
        test(`reads the page from path form ${i} without doubling the base path`, async () => {
          const path = reads()[i];
          const res = await call("spicrawl_docs_read", { path });
          ok(res);
          assert.ok(text(res).includes(ANTI_BOT_MD), `${path}: ${text(res)}`);
          assert.equal(docs.requests.at(-1).path, `${layout.prefix}/guides/anti-bot.md`, path);
          assert.ok(text(res).startsWith(`Source: ${docs.base}/guides/anti-bot`), text(res));
        });
      }

      test("reads a full docs URL with an anchor and names the section", async () => {
        const res = await call("spicrawl_docs_read", { path: `${docs.base}/guides/anti-bot.md#challenge-pages` });
        ok(res);
        assert.match(text(res), /#challenge-pages/);
        assert.ok(text(res).includes(ANTI_BOT_MD));
      });

      test("reads a link taken from llms.txt", async () => {
        const link = /\((http[^)]+)\)/.exec(docs.llmsTxt)[1];
        const res = await call("spicrawl_docs_read", { path: link });
        ok(res);
        assert.equal(docs.requests.at(-1).path, `${layout.prefix}/guides/anti-bot.md`);
      });

      for (const path of ["/", "index", "index.md"]) {
        test(`reads the root page from ${path} as index.md`, async () => {
          const res = await call("spicrawl_docs_read", { path });
          ok(res);
          assert.ok(text(res).includes(INDEX_MD), text(res));
          assert.equal(docs.requests.at(-1).path, `${layout.prefix}/index.md`);
        });
      }

      test("truncates a long page and says so", async () => {
        const res = await call("spicrawl_docs_read", { path: "huge" });
        ok(res);
        assert.match(text(res), /Truncated: showing the first 60000 of 70000 characters/);
        assert.ok(text(res).length < 60_500);
      });

      for (const path of ["../secrets", "guides/../../etc/passwd", "guides/%2e%2e/x", "https://evil.example/docs/guides/anti-bot", "//evil.example/x"]) {
        test(`refuses ${path} without fetching it`, async () => {
          const before = docs.requests.length;
          const res = await call("spicrawl_docs_read", { path });
          assert.equal(res.isError, true, text(res));
          assert.equal(docs.requests.length, before);
        });
      }

      test("a missing page is a clear tool error", async () => {
        const res = await call("spicrawl_docs_read", { path: "guides/nope" });
        assert.equal(res.isError, true);
        assert.match(text(res), /No docs page at `guides\/nope`.*spicrawl_docs_search/);
      });
    });

    describe("spicrawl_docs_index", () => {
      test("returns llms.txt verbatim", async () => {
        const res = await call("spicrawl_docs_index", {});
        ok(res);
        assert.equal(text(res), docs.llmsTxt);
        assert.equal(docs.requests.at(-1).path, `${layout.prefix}/llms.txt`);
      });
    });

    describe("docs host", () => {
      test("never receives the API key", () => {
        assert.ok(docs.requests.length > 0);
        assert.deepEqual(docs.requests.filter((r) => r.auth !== undefined), []);
      });

      test("an unreachable docs host is a clear tool error", async () => {
        docs.mode = "reset";
        try {
          const res = await call("spicrawl_docs_search", { query: "bot" });
          assert.equal(res.isError, true);
          assert.match(text(res), /Could not reach the Spicrawl docs at .*check SPICRAWL_DOCS_URL/);
        } finally {
          docs.mode = "up";
        }
      });
    });
  });
}
