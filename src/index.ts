#!/usr/bin/env node
/**
 * spicrawl-mcp — the Spicrawl web-data platform as native agent tools.
 *
 * A thin MCP wrapper over the Spicrawl REST API. Each tool maps to one endpoint;
 * the caller's API key and the API base URL come from the environment, so the
 * same server works against a local dev stack or a production deployment.
 *
 *   spicrawl-mcp           stdio server (the default; what `npx -y @spicrawl/mcp` runs)
 *   spicrawl-mcp --http    Streamable HTTP server (dist/http.js; see there for its env)
 *
 * Every bin in package.json points at this file. `npx -y @spicrawl/mcp` can only
 * pick a bin on its own when the package has a bin named `mcp` (too generic to
 * install globally) or when every bin is the same file, so the HTTP server is a
 * flag here rather than a second bin. `node dist/http.js` still runs it directly.
 *
 *   SPICRAWL_API_KEY   required — a Spicrawl key (spicrawl_live_...)
 *   SPICRAWL_BASE_URL  optional — default https://api.spicrawl.com
 *   SPICRAWL_PUBLIC_BASE_URL  optional — base for URLs handed back to the caller
 *                    (browser connect URL); default SPICRAWL_BASE_URL
 *   SPICRAWL_DOCS_URL optional — the public docs base URL (docs tools), e.g.
 *                    http://HOST:8080/docs self-hosted; default SPICRAWL_DOCS_HOST
 *                    + /docs (legacy), then a self-hosted SPICRAWL_PUBLIC_BASE_URL /
 *                    SPICRAWL_BASE_URL + /docs, then https://docs.spicrawl.com
 *   SPICRAWL_MCP_HIDE_UNAVAILABLE  optional — 1/true/yes/on lists only what works today:
 *                    no spicrawl_browser_connect_url, no argument marked "Coming soon"
 *
 * Transport is stdio: this runs as a subprocess of an MCP client (Claude Code,
 * Claude Desktop, Cursor, …), which is the local-integration case the MCP spec
 * recommends stdio for.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ILayerClient, PACKAGE_VERSION } from "./client.js";
import { buildServer } from "./server.js";

const USAGE = `spicrawl-mcp ${PACKAGE_VERSION} — the Spicrawl MCP server

Usage:
  spicrawl-mcp            run over stdio (for an MCP client; needs SPICRAWL_API_KEY)
  spicrawl-mcp --http     run the Streamable HTTP server (SPICRAWL_MCP_ADDR, default 127.0.0.1:8090)
  spicrawl-mcp --version  print the version
  spicrawl-mcp --help     print this help

Docs: https://docs.spicrawl.com/agents/mcp
`;

async function stdio() {
  const server = buildServer(
    new ILayerClient({
      apiKey: process.env.SPICRAWL_API_KEY ?? "",
      baseURL: process.env.SPICRAWL_BASE_URL,
      publicBaseURL: process.env.SPICRAWL_PUBLIC_BASE_URL,
    }),
  );
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is the transport; logs go to stderr.
  console.error(`spicrawl-mcp ${PACKAGE_VERSION} ready (stdio)`);
}

async function main(args: string[]) {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(USAGE);
    return;
  }
  if (args.includes("--version") || args.includes("-v")) {
    process.stdout.write(`${PACKAGE_VERSION}\n`);
    return;
  }
  const unknown = args.filter((a) => a !== "--http");
  if (unknown.length > 0) {
    console.error(`spicrawl-mcp: unknown argument ${unknown[0]}\n\n${USAGE}`);
    process.exit(2);
  }
  if (args.includes("--http")) {
    // dist/http.js starts listening when it is loaded.
    await import("./http.js");
    return;
  }
  await stdio();
}

main(process.argv.slice(2)).catch((err) => {
  console.error("spicrawl-mcp failed to start:", err);
  process.exit(1);
});
