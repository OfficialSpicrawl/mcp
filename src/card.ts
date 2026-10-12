/**
 * The static MCP server card, served unauthenticated at
 * GET /.well-known/mcp/server-card.json (src/http.ts). Directories such as
 * Smithery cannot scan /mcp (it answers 401 without a key) and read this instead.
 *
 * The tool list is not written by hand: it is what a real session's tools/list
 * answers, taken from the same buildServer() the endpoint uses, so the card
 * cannot drift from the tools. Tool definitions name no internal engine, so
 * nothing is filtered here; test/annotations.test.mjs and test/card.test.mjs
 * fail the build if one ever does.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ILayerClient, PACKAGE_VERSION } from "./client.js";
import { buildServer } from "./server.js";

// ponytail: the hosted product's URL; a self-hosted card still names it. Add an env override if anyone self-hosts and registers.
export const HOSTED_MCP_URL = "https://mcp.spicrawl.com/mcp";
const DOCS_URL = "https://docs.spicrawl.com/agents/mcp";

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
  return {
    serverInfo: {
      name: "Spicrawl",
      title: "Spicrawl",
      version: PACKAGE_VERSION,
      description: "Web scraping to Markdown and structured data, screenshots, batch jobs and browser sessions for AI agents.",
      websiteUrl: DOCS_URL,
    },
    transport: { type: "streamable-http", endpoint: HOSTED_MCP_URL },
    authentication: { required: true, schemes: ["bearer"] },
    tools: await listTools(),
  };
}
