# Spicrawl MCP Server: Web Scraping Tools for AI Agents

The official [Model Context Protocol](https://modelcontextprotocol.io) server for [Spicrawl](https://spicrawl.com), the web scraping API for AI agents and LLMs. Connect it to Claude Code, Claude Desktop, Cursor, VS Code, Codex or any MCP client, and your agent can scrape pages to Markdown, extract structured data, run batch jobs over thousands of URLs, keep browser sessions and read the Spicrawl docs, all as native tools.

[![npm version](https://img.shields.io/npm/v/@spicrawl/mcp.svg)](https://www.npmjs.com/package/@spicrawl/mcp)
[![license](https://img.shields.io/npm/l/@spicrawl/mcp.svg)](https://www.npmjs.com/package/@spicrawl/mcp)
[![CI](https://github.com/Spicrawl/mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Spicrawl/mcp/actions/workflows/ci.yml)
[![docs](https://img.shields.io/badge/docs-docs.spicrawl.com-blue.svg)](https://docs.spicrawl.com/agents/mcp)

**[Docs](https://docs.spicrawl.com/agents/mcp)** · **[Get an API key](https://app.spicrawl.com/signup)** · **[GitHub](https://github.com/Spicrawl/mcp)** · **[SDK](https://github.com/Spicrawl/sdk)** · **[CLI](https://github.com/Spicrawl/cli)** · **[Changelog](https://github.com/Spicrawl/mcp/blob/main/CHANGELOG.md)**

## Two ways to connect

| | Hosted endpoint | Local (stdio) |
|---|---|---|
| What | `https://mcp.spicrawl.com/mcp`, MCP Streamable HTTP | `npx -y @spicrawl/mcp`, a subprocess of your MCP client |
| Install | nothing | Node.js 20 or later |
| Auth | `Authorization: Bearer <API key>` header | `SPICRAWL_API_KEY` environment variable |
| Use when | your client supports remote MCP servers (most do) | your client only launches local servers, or you want to pin a version |

Both serve the same 25 `spicrawl_*` tools. [Create an API key](https://app.spicrawl.com/signup) in the dashboard first; keys start with `spicrawl_live_` or `spicrawl_test_`.

## Hosted endpoint

Each tool call runs under your key, exactly as if you had called the API yourself, and a session is bound to the key that opened it. The key is checked when a session opens: an unknown or revoked key gets `401`, and if the API cannot be reached to check it the endpoint answers `503` with `Retry-After` (retry rather than rotating the key).

**Claude Code:**

```bash
claude mcp add --transport http spicrawl https://mcp.spicrawl.com/mcp \
  --header "Authorization: Bearer spicrawl_live_..."
```

or in a project's `.mcp.json`:

```json
{
  "mcpServers": {
    "spicrawl": {
      "type": "http",
      "url": "https://mcp.spicrawl.com/mcp",
      "headers": { "Authorization": "Bearer spicrawl_live_..." }
    }
  }
}
```

**Cursor** (`.cursor/mcp.json` or `~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "spicrawl": {
      "url": "https://mcp.spicrawl.com/mcp",
      "headers": { "Authorization": "Bearer spicrawl_live_..." }
    }
  }
}
```

**VS Code** (`.vscode/mcp.json`; VS Code uses the `servers` key). The `inputs` entry makes VS Code ask for the key once and store it, so the file is safe to commit:

```json
{
  "inputs": [
    { "type": "promptString", "id": "spicrawl-api-key", "description": "Spicrawl API key", "password": true }
  ],
  "servers": {
    "spicrawl": {
      "type": "http",
      "url": "https://mcp.spicrawl.com/mcp",
      "headers": { "Authorization": "Bearer ${input:spicrawl-api-key}" }
    }
  }
}
```

**Codex** reads the key from the environment each time it connects, so the key never lands in a file:

```bash
export SPICRAWL_API_KEY=spicrawl_live_...
codex mcp add spicrawl --url https://mcp.spicrawl.com/mcp --bearer-token-env-var SPICRAWL_API_KEY
```

The equivalent `~/.codex/config.toml`:

```toml
[mcp_servers.spicrawl]
url = "https://mcp.spicrawl.com/mcp"
bearer_token_env_var = "SPICRAWL_API_KEY"
```

**Claude Desktop** only launches local servers from `claude_desktop_config.json`, and custom connectors cannot send an `Authorization` header, so use the [local server](#local-server-stdio) below.

## Local server (stdio)

`npx -y @spicrawl/mcp` downloads the package and runs the stdio server. The client starts it and passes your key in its environment.

**Claude Code:**

```bash
claude mcp add spicrawl --env SPICRAWL_API_KEY=spicrawl_live_... -- npx -y @spicrawl/mcp
```

**Claude Desktop** (`claude_desktop_config.json`) and **Cursor** (`.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "spicrawl": {
      "command": "npx",
      "args": ["-y", "@spicrawl/mcp"],
      "env": { "SPICRAWL_API_KEY": "spicrawl_live_..." }
    }
  }
}
```

**VS Code** (`.vscode/mcp.json`):

```json
{
  "inputs": [
    { "type": "promptString", "id": "spicrawl-api-key", "description": "Spicrawl API key", "password": true }
  ],
  "servers": {
    "spicrawl": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@spicrawl/mcp"],
      "env": { "SPICRAWL_API_KEY": "${input:spicrawl-api-key}" }
    }
  }
}
```

**Codex** (`~/.codex/config.toml`):

```toml
[mcp_servers.spicrawl]
command = "npx"
args = ["-y", "@spicrawl/mcp"]
env = { SPICRAWL_API_KEY = "spicrawl_live_..." }
```

Restart the client; the `spicrawl_*` tools appear. To install it once instead of fetching it on each start, run `npm install -g @spicrawl/mcp` and use the command `spicrawl-mcp` (`spicrawl-mcp-server` is an alias).

### Environment variables

| Variable | Required | Default | Notes |
|---|---|---|---|
| `SPICRAWL_API_KEY` | yes (stdio) | — | Your Spicrawl API key. The HTTP server ignores it and uses each caller's bearer token instead. |
| `SPICRAWL_BASE_URL` | no | `https://api.spicrawl.com` (stdio), `http://127.0.0.1:8080` (HTTP server) | The Spicrawl API base URL. Set it for a self-hosted or local stack, and always when you run the HTTP server against the public API. |
| `SPICRAWL_PUBLIC_BASE_URL` | no | `SPICRAWL_BASE_URL` | The API as the end user reaches it, used only for URLs handed back (`spicrawl_browser_connect_url`). Set it when the server talks to the API over a private address. |
| `SPICRAWL_DOCS_URL` | no | see below | The docs base URL, no trailing slash. The docs tools read `<base>/api/search`, `<base>/<page>.md` and `<base>/llms.txt`. The docs are public: your API key is never sent there. |
| `SPICRAWL_DOCS_HOST` | no | — | Legacy: an origin whose docs are at `/docs`. Read only when `SPICRAWL_DOCS_URL` is unset. |
| `SPICRAWL_MCP_ADDR` | no | `127.0.0.1:8090` | HTTP server only: the listen address, `host:port`. |
| `SPICRAWL_MCP_SESSION_IDLE_MS` | no | `1800000` (30 min) | HTTP server only: idle sessions are dropped after this long. |

Without `SPICRAWL_DOCS_URL` or `SPICRAWL_DOCS_HOST`, the docs tools read a self-hosted API's own docs (`SPICRAWL_PUBLIC_BASE_URL`, else `SPICRAWL_BASE_URL`, plus `/docs`), and otherwise `https://docs.spicrawl.com`.

## Tools

| Tool | What it does |
|---|---|
| **Scrape** | |
| `spicrawl_scrape` | Retrieve a URL as markdown/text/html/json, or print it to a PDF. Optional browser render, selector or AI extraction, links, screenshot, DOM scoping, proxy control, caching, browser actions, network capture. |
| **Batch** | |
| `spicrawl_batch_submit` | Scrape many URLs as one async job with shared settings. Output is markdown unless `format` says otherwise, the same default as `spicrawl_scrape`. Returns the job object. |
| `spicrawl_batch_list` | List the project's batch jobs, newest first, with status and progress. |
| `spicrawl_batch_status` | Poll one batch job's status and progress. |
| `spicrawl_batch_results` | Read a page of a job's finished items (content, or a `result_url` API content path per item). |
| `spicrawl_batch_task_content` | Read the full payload of one item by its `seq`. |
| `spicrawl_batch_cancel` | Cancel a job: unstarted items never run, finished ones keep their results. |
| `spicrawl_batch_retry` | Re-queue every failed item of a job. |
| `spicrawl_batch_add_items` | Append URLs to a job submitted with `open: true`. |
| `spicrawl_batch_close` | Stop an open job accepting items so it can complete. |
| **Sessions** | |
| `spicrawl_session_create` | Create a persistent browser identity (cookies, storage, pinned engine, sticky exit IP) to reuse across scrapes. |
| `spicrawl_session_list` | List the project's sessions, newest first. |
| `spicrawl_session_get` | One session's metadata (status, engine, exit, usage, expiry). |
| `spicrawl_session_context` | Dump a live session's stored state (cookies, storage). It contains secrets, and can clone a session. |
| `spicrawl_session_release` | End a session; its record stays visible as `released`. |
| `spicrawl_session_delete` | Permanently delete a session and its stored state. |
| **Usage and request history** | |
| `spicrawl_usage` | Billing-grade usage over a date window, grouped by day, project, engine or feature (needs the `read` scope). |
| `spicrawl_usage_summary` | Current-period usage totals (needs the `read` scope). |
| `spicrawl_usage_reconciliation` | One day's drift between the request log and the billed rollup (needs the `read` scope). |
| `spicrawl_requests_list` | Recent API calls in the key's project with status, errors, engine, proxy, latency and credits; `all_projects: true` lists every project in the organization (needs the `read` scope). |
| `spicrawl_request_get` | The full log record of one call by its request id, for debugging a failed or slow scrape. |
| **Browser** | |
| `spicrawl_browser_connect_url` | Coming soon: remote browsers are not available yet. Mints a single-use CDP WebSocket URL for driving Spicrawl's remote browser from your own Puppeteer or Playwright. |
| **Docs** | |
| `spicrawl_docs_search` | Search the Spicrawl docs (`query`, optional `limit` 1-20, default 8). Results are grouped by page, with matching sections, snippets and the `.md` URL to read next. An error code (`ERR::FAMILY::NAME`) also gets a link to its entry on the errors page. |
| `spicrawl_docs_read` | Read one docs page as Markdown by path (`guides/anti-bot`) or docs URL, optionally with `#anchor`. Pages over 60k characters are truncated and say so; other hosts and `..` are refused. |
| `spicrawl_docs_index` | The docs' `llms.txt`: every page with its title, description and `.md` link. |

See the [MCP server docs](https://docs.spicrawl.com/agents/mcp) for each tool's arguments.

## Example prompts

Once connected, an agent can act on requests like:

- *"Scrape https://example.com/pricing as markdown and summarise the plans."*
- *"Get the product name, price and stock status from this URL."* The agent calls `spicrawl_scrape` with `autoparse` or an `extract` map.
- *"Scrape these 50 URLs and give me the titles."* The agent calls `spicrawl_batch_submit`, then `spicrawl_batch_status` and `spicrawl_batch_results`.

## Behaviour worth knowing

- Tools reject unknown arguments rather than ignoring them. A misspelt or unsupported field (e.g. `js_render` on `spicrawl_scrape`, whose argument is `render`) fails the call with an error naming it, so a setting the agent believes it applied is never dropped.
- Errors carry the platform's own code and guidance (e.g. `ERR::UPSTREAM::CHALLENGE` when a site served a bot wall), so the agent can decide whether to retry or change parameters.
- `spicrawl_scrape` screenshots come back as MCP image content blocks the model can see. In the JSON, each `screenshots` entry keeps its metadata but its base64 is replaced by a pointer to its block. An image over 5 MB of base64 is not attached, and its entry says how to get a smaller one.
- `spicrawl_scrape` with `format: "pdf"` (plus `render` or `engine: "chromium"`) returns the printed page as an MCP resource block (`application/pdf`). A PDF over 10 MB of base64 is not attached; `pdf.not_attached` says so.
- Coming soon, and marked so in the tool descriptions: `ai_extract`, stealth mode (`stealth`, engine `camoufox`), `extract_preset`, the managed proxy pool (`premium_proxy`, `proxy_country`, `sticky_key`, session `rotate_ip`/`region_pool`) and `spicrawl_browser_connect_url`. The schemas already accept them so nothing changes the day they ship; until then agents should not send them.

## Self-hosting the HTTP server

The hosted endpoint is this package's Streamable HTTP server. To run your own, for example beside a self-hosted Spicrawl deployment:

```bash
SPICRAWL_MCP_ADDR=127.0.0.1:8090 \
SPICRAWL_BASE_URL=https://api.spicrawl.com \
npx -y @spicrawl/mcp --http
```

or, from an installed copy, `node node_modules/@spicrawl/mcp/dist/http.js` with the same environment.

- It serves MCP at `POST/GET/DELETE /mcp` and liveness at `GET /healthz` (no auth): `curl http://127.0.0.1:8090/healthz`.
- **`SPICRAWL_BASE_URL` defaults to `http://127.0.0.1:8080`** for the HTTP server (a Spicrawl API on the same host), not to the public API. Set it to `https://api.spicrawl.com` to front the public API.
- Each caller authenticates with their own key as `Authorization: Bearer spicrawl_live_...`. The key is validated against the API before a session opens, and a session is pinned to the key that created it.
- The server speaks plain HTTP. Put it behind TLS (a reverse proxy) before sending keys across a network.

## Development

```bash
git clone https://github.com/Spicrawl/mcp.git && cd mcp
npm ci
npm run typecheck
npm test
```

`npm test` builds the package, then runs the `node:test` suite in `test/` against the real `dist/http.js`, pointed at a fake Spicrawl API on loopback. It needs no deployment, no network and no real API key, and finishes in a few seconds.

`npm run build` writes `dist/index.js` (the `spicrawl-mcp` command: stdio, or HTTP with `--http`) and `dist/http.js` (the HTTP server). Run the stdio server from a checkout with `SPICRAWL_API_KEY=... node dist/index.js`.

## Security

See [SECURITY.md](SECURITY.md). Never commit an API key; if one leaks, revoke it at https://app.spicrawl.com.

## License

[Apache-2.0](LICENSE)
