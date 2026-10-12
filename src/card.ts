/**
 * The static MCP server card, served unauthenticated at
 * GET /.well-known/mcp/server-card.json (src/http.ts). Directories such as
 * Smithery cannot scan /mcp (it answers 401 without a key) and read this instead.
 *
 * The tool list is not written by hand: it is what a real session's tools/list
 * answers, taken from the same buildServer() the endpoint uses, so the card
 * cannot drift from the tools. The one edit is a privacy filter, because the
 * card is public and the execution engines are internal: the `engine` and
 * `headless` arguments are dropped, and any sentence that still names an
 * engine or a browser tool is removed. If a name survives, the card is refused
 * (fail closed) rather than published.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ILayerClient, PACKAGE_VERSION } from "./client.js";
import { buildServer } from "./server.js";

// ponytail: the hosted product's URL; a self-hosted card still names it. Add an env override if anyone self-hosts and registers.
export const HOSTED_MCP_URL = "https://mcp.spicrawl.com/mcp";
const DOCS_URL = "https://docs.spicrawl.com/agents/mcp";

/** Names that must never appear in the public card. */
export const INTERNAL_NAMES = /\b(moli|chromium|chrome|camoufox|obscura|browserless|headful|playwright|puppeteer)\b/i;

/** Arguments that exist only to pick an internal engine or browser mode. */
const HIDDEN_ARGUMENTS = new Set(["engine", "headless"]);

/** Drops the hidden arguments, parentheticals and then sentences naming an internal tool, at any depth. */
function scrub(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(scrub);
  if (typeof node === "string") {
    return node
      .replace(/\s*\([^()]*\)/g, (aside) => (INTERNAL_NAMES.test(aside) ? "" : aside))
      .split(/(?<=[.!?])\s+/)
      .filter((sentence) => !INTERNAL_NAMES.test(sentence))
      .join(" ");
  }
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === "properties" && v && typeof v === "object") {
        out[k] = scrub(Object.fromEntries(Object.entries(v).filter(([name]) => !HIDDEN_ARGUMENTS.has(name))));
      } else if (k === "required" && Array.isArray(v)) {
        out[k] = v.filter((name) => !HIDDEN_ARGUMENTS.has(name));
      } else {
        out[k] = scrub(v);
      }
    }
    return out;
  }
  return node;
}

/** What a session's tools/list says: the real definitions, from an in-memory client. */
async function listTools() {
  // The key and URLs are never used: tools/list calls nothing upstream.
  const server = buildServer(new ILayerClient({ apiKey: "spicrawl_live_card", baseURL: HOSTED_MCP_URL, publicBaseURL: HOSTED_MCP_URL }), {
    hideUnavailable: true, // list what works today, like a customer who set SPICRAWL_MCP_HIDE_UNAVAILABLE
  });
  const client = new Client({ name: "server-card", version: PACKAGE_VERSION });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  try {
    return (await client.listTools()).tools;
  } finally {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
  }
}

export async function buildServerCard() {
  const card = {
    serverInfo: {
      name: "Spicrawl",
      title: "Spicrawl",
      version: PACKAGE_VERSION,
      description: "Web scraping to Markdown and structured data, screenshots, batch jobs and browser sessions for AI agents.",
      websiteUrl: DOCS_URL,
    },
    transport: { type: "streamable-http", endpoint: HOSTED_MCP_URL },
    authentication: { required: true, schemes: ["bearer"] },
    tools: scrub(await listTools()),
  };
  const leak = INTERNAL_NAMES.exec(JSON.stringify(card));
  if (leak) throw new Error(`server card names an internal engine (${leak[0]}); extend scrub() before publishing it`);
  return card;
}
