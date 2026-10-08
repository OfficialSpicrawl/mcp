# Spicrawl MCP Server

The Spicrawl MCP server is a Model Context Protocol server that gives AI agents in Claude Code, Claude Desktop, Cursor, VS Code, Windsurf, Gemini CLI and Codex web scraping to Markdown, structured data extraction, screenshots, browser sessions and batch scraping as 25 native tools.

[![npm version](https://img.shields.io/npm/v/@spicrawl/mcp.svg)](https://www.npmjs.com/package/@spicrawl/mcp)
[![npm downloads](https://img.shields.io/npm/dm/@spicrawl/mcp.svg)](https://www.npmjs.com/package/@spicrawl/mcp)
[![license](https://img.shields.io/npm/l/@spicrawl/mcp.svg)](https://github.com/OfficialSpicrawl/mcp/blob/main/LICENSE)
[![CI](https://github.com/OfficialSpicrawl/mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/OfficialSpicrawl/mcp/actions/workflows/ci.yml)

**[Docs](https://docs.spicrawl.com/agents/mcp)** · **[Get an API key](https://app.spicrawl.com/signup)** · **[TypeScript SDK](https://github.com/OfficialSpicrawl/sdk)** · **[CLI](https://github.com/OfficialSpicrawl/cli)** · **[Agent plugins](https://github.com/OfficialSpicrawl/agent-plugins)** · **[Changelog](https://github.com/OfficialSpicrawl/mcp/blob/main/CHANGELOG.md)**

<p>
  <a href="https://cursor.com/en/install-mcp?name=spicrawl&config=eyJ1cmwiOiJodHRwczovL21jcC5zcGljcmF3bC5jb20vbWNwIiwiaGVhZGVycyI6eyJBdXRob3JpemF0aW9uIjoiQmVhcmVyICR7ZW52OlNQSUNSQVdMX0FQSV9LRVl9In19"><img src="https://cursor.com/deeplink/mcp-install-dark.svg" alt="Add Spicrawl MCP server to Cursor" height="32" /></a>
  <a href="https://vscode.dev/redirect/mcp/install?name=spicrawl&inputs=%5B%7B%22type%22%3A%22promptString%22%2C%22id%22%3A%22spicrawl-api-key%22%2C%22description%22%3A%22Spicrawl%20API%20key%22%2C%22password%22%3Atrue%7D%5D&config=%7B%22type%22%3A%22http%22%2C%22url%22%3A%22https%3A%2F%2Fmcp.spicrawl.com%2Fmcp%22%2C%22headers%22%3A%7B%22Authorization%22%3A%22Bearer%20%24%7Binput%3Aspicrawl-api-key%7D%22%7D%7D"><img src="https://img.shields.io/badge/VS_Code-Install_Spicrawl_MCP-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white" alt="Install Spicrawl MCP server in VS Code" height="32" /></a>
</p>

## Quickstart

1. Create an API key at [app.spicrawl.com](https://app.spicrawl.com/signup). Keys start with `spicrawl_live_` or `spicrawl_test_`.
2. Connect the **hosted endpoint**, `https://mcp.spicrawl.com/mcp` (MCP Streamable HTTP, nothing to install):

   ```bash
   export SPICRAWL_API_KEY=spicrawl_live_...
   claude mcp add --transport http spicrawl https://mcp.spicrawl.com/mcp \
     --header "Authorization: Bearer $SPICRAWL_API_KEY"
   ```

   Codex: `codex mcp add spicrawl --url https://mcp.spicrawl.com/mcp --bearer-token-env-var SPICRAWL_API_KEY`

3. Or run it **locally over stdio** (Node.js 20+), for clients that only launch local servers:

   ```bash
   claude mcp add spicrawl --env SPICRAWL_API_KEY=$SPICRAWL_API_KEY -- npx -y @spicrawl/mcp
   ```

4. Ask your agent: *"Use Spicrawl to read https://example.com/pricing as markdown and list each plan with its price."* It calls `spicrawl_scrape` and gets the page back as Markdown.

Both transports serve the same 25 `spicrawl_*` tools, and every call runs under your key with the same scopes, limits and credits as a direct API call.

## What it does

- **Scrape any URL to Markdown**, text, HTML, a JSON envelope or a printed PDF with one tool, `spicrawl_scrape`. Markdown is the default and strips the page to its main content.
- **Render JavaScript** with `render: true` (the `obscura` browser engine, 3 credits) or pin real Chromium with `engine: "chromium"` (8 credits). A plain fetch costs 1 credit, and `mode: "auto"` escalates fetch to browser and bills only the rung that worked ([price table](https://docs.spicrawl.com/credits)).
- **Extract structured data** with a CSS/XPath selector map (`extract`) or from the JSON-LD, OpenGraph, Twitter Card and microdata a page publishes (`autoparse`).
- **Drive the page** before capture with 8 typed browser actions: `click`, `fill`, `wait_for`, `wait_for_navigation`, `scroll` (including infinite scroll), `select`, `evaluate` and `screenshot`.
- **Return screenshots and PDFs the model can see**: screenshots arrive as MCP image blocks (up to 5 MB of base64 each) and printed pages as `application/pdf` resource blocks (up to 10 MB).
- **Batch scrape thousands of URLs** as one async job, up to 10,000 items per call, with 9 tools to submit, poll, page through results, retry, cancel and keep a job open for crawling.
- **Keep a logged-in browser** with persistent sessions: cookies, storage and a pinned engine reused across scrapes.
- **Answer "what did that cost?"** from usage and request-log tools, and **read the Spicrawl docs** from inside the agent.

## Which tool to use

- If you need one page's content or data now, use `spicrawl_scrape`.
- If the page is blank or a skeleton without JavaScript, call `spicrawl_scrape` again with `render: true`.
- If you know the page's structure, use `extract` with CSS selectors; if you don't, try `autoparse`.
- If you have more than about 20 URLs, use `spicrawl_batch_submit`, then `spicrawl_batch_status` and `spicrawl_batch_results`.
- If you discover URLs as you go (crawling), submit with `open: true`, append with `spicrawl_batch_add_items` and finish with `spicrawl_batch_close`.
- If you must log in first, use `spicrawl_session_create` and pass its `id` as `session_id` to `spicrawl_scrape`.
- If a call failed and you need to know why, use `spicrawl_request_get` with the request id, or `spicrawl_requests_list` with `only_errors`.
- If you are unsure of a parameter or an error code, use `spicrawl_docs_search` before guessing.

## Tools

25 tools, grouped by task. Tools reject unknown arguments, so a misspelt field fails with an error naming it instead of being silently dropped. Every tool sets a `title` and explicit `readOnlyHint`, `destructiveHint` and `openWorldHint` annotations, so a client knows which calls to confirm: `spicrawl_scrape` is not read-only (its `method` and `actions` can submit forms), and `spicrawl_batch_cancel`, `spicrawl_session_release` and `spicrawl_session_delete` are destructive. Full argument reference: [docs.spicrawl.com/agents/mcp](https://docs.spicrawl.com/agents/mcp#tools).

### Scrape a website to Markdown

| Tool | What it does | Key parameters |
|---|---|---|
| `spicrawl_scrape` | Retrieve one URL as `markdown` (default), `text`, `html`, `json` or `pdf`, with optional rendering, extraction, links, screenshots and browser actions. | `url`, `format`, `render`, `engine`, `mode`, `main_content_only`, `include_tags`, `exclude_tags`, `extract`, `autoparse`, `links`, `screenshot`, `actions`, `wait_for`, `session_id`, `proxy`, `cache`, `max_cost` |

### Batch scrape many URLs

| Tool | What it does | Key parameters |
|---|---|---|
| `spicrawl_batch_submit` | Queue many URLs as one async job with shared settings; returns the job with `estimated_credits`. | `urls` or `items`, `render`, `format`, `open`, `max_attempts`, `credit_budget`, `max_cost` |
| `spicrawl_batch_list` | List the project's batch jobs, newest first. | `status`, `limit` (max 200), `cursor` |
| `spicrawl_batch_status` | One job's status and progress. | `job_id` |
| `spicrawl_batch_results` | A page of finished items; works while the job runs. | `job_id`, `status`, `limit` (max 5000), `cursor` |
| `spicrawl_batch_task_content` | The full payload of one item. | `job_id`, `seq` |
| `spicrawl_batch_cancel` | Cancel a job; finished items keep their results. | `job_id` |
| `spicrawl_batch_retry` | Re-queue every failed item. | `job_id` |
| `spicrawl_batch_add_items` | Append URLs to a job submitted with `open: true`. | `job_id`, `urls` or `items` |
| `spicrawl_batch_close` | Stop an open job accepting items so it can complete. | `job_id` |

### Browser sessions

| Tool | What it does | Key parameters |
|---|---|---|
| `spicrawl_session_create` | Create a persistent browser identity (cookies, storage, pinned engine). | `engine`, `ttl_seconds`, `session_context` |
| `spicrawl_session_list` | List sessions, newest first. | `status`, `engine`, `limit`, `cursor` |
| `spicrawl_session_get` | One session's status, engine, exit, usage and expiry. | `session_id` |
| `spicrawl_session_context` | Dump a live session's cookies and storage (contains secrets). | `session_id` |
| `spicrawl_session_release` | End a session; its record stays as `released`. | `session_id` |
| `spicrawl_session_delete` | Permanently delete a session and its state. | `session_id` |

### Usage and request history

| Tool | What it does | Key parameters |
|---|---|---|
| `spicrawl_usage` | Billing-grade usage over a date window (`read` scope). | `from`, `to`, `group_by`, `metrics` |
| `spicrawl_usage_summary` | Current-period totals (`read` scope). | none |
| `spicrawl_usage_reconciliation` | One day's drift between the request log and the billed rollup (`read` scope). | `day` |
| `spicrawl_requests_list` | Recent API calls with status, error code, engine, latency and credits. | `only_errors`, `status`, `limit`, `all_projects` |
| `spicrawl_request_get` | The full log record of one call. | `id` |

### Docs

| Tool | What it does | Key parameters |
|---|---|---|
| `spicrawl_docs_search` | Search the Spicrawl docs; an error code also links to its entry. | `query`, `limit` (1-20, default 8) |
| `spicrawl_docs_read` | Read one docs page as Markdown (truncated over 60,000 characters). | `path` |
| `spicrawl_docs_index` | The docs' `llms.txt`: every page with its title and `.md` link. | none |

### Coming soon

`spicrawl_browser_connect_url` will mint a single-use CDP WebSocket URL for driving a Spicrawl-hosted browser from Puppeteer or Playwright; remote browsers are not available yet. The schemas also accept `ai_extract`, `stealth`, `extract_preset`, `premium_proxy`, `proxy_country` and `sticky_key` ahead of launch. Agents should not send them yet. To list only what works today, set `SPICRAWL_MCP_HIDE_UNAVAILABLE=1` (see [Environment variables](https://github.com/OfficialSpicrawl/mcp#environment-variables)).

## Example prompts

- *"Scrape https://example.com/pricing as markdown and summarise the plans."*
- *"Get the product name, price and stock status from this URL."* (`spicrawl_scrape` with `extract` or `autoparse`)
- *"Take a full-page screenshot of https://example.com after the cookie banner is gone."* (`render`, `actions`, `screenshot_fullpage`)
- *"Scrape these 500 URLs and give me each page title."* (`spicrawl_batch_submit`, then `spicrawl_batch_results`)
- *"Why did my last scrape fail?"* (`spicrawl_requests_list` with `only_errors`, then `spicrawl_request_get`)
- *"How many credits have I used this month?"* (`spicrawl_usage_summary`)

## Set up your MCP client

Put your key in `SPICRAWL_API_KEY` and reference it from the config where the client allows, so the key never lands in a committed file.

<details>
<summary><b>Claude Code</b></summary>

Hosted endpoint, stored for you only (add `--scope user` for every project):

```bash
claude mcp add --transport http spicrawl https://mcp.spicrawl.com/mcp \
  --header "Authorization: Bearer $SPICRAWL_API_KEY"
```

To share it with a team, commit `.mcp.json` at the project root. Claude Code expands `${VAR}`, so each teammate's own key is used:

```json
{
  "mcpServers": {
    "spicrawl": {
      "type": "http",
      "url": "https://mcp.spicrawl.com/mcp",
      "headers": { "Authorization": "Bearer ${SPICRAWL_API_KEY}" }
    }
  }
}
```

Or install the plugin, which bundles the MCP server and the Spicrawl agent skill:

```bash
claude plugin marketplace add OfficialSpicrawl/agent-plugins
claude plugin install spicrawl@spicrawl-plugins
```

Check with `claude mcp list`, or `/mcp` in a session. More: [docs.spicrawl.com/agents/claude-code](https://docs.spicrawl.com/agents/claude-code).

</details>

<details>
<summary><b>Claude Desktop</b></summary>

Claude Desktop's `claude_desktop_config.json` starts local (stdio) servers only, and custom connectors cannot send an `Authorization` header, so run the package locally. The file is at `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS and `%APPDATA%\Claude\claude_desktop_config.json` on Windows:

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

Restart Claude Desktop after saving.

</details>

<details>
<summary><b>Cursor</b></summary>

Use the **Add to Cursor** button above, or add this to `.cursor/mcp.json` in the project (or `~/.cursor/mcp.json` for every project). Cursor resolves `${env:NAME}` in `url` and `headers`, so start Cursor from an environment where `SPICRAWL_API_KEY` is set:

```json
{
  "mcpServers": {
    "spicrawl": {
      "url": "https://mcp.spicrawl.com/mcp",
      "headers": { "Authorization": "Bearer ${env:SPICRAWL_API_KEY}" }
    }
  }
}
```

More: [docs.spicrawl.com/agents/cursor](https://docs.spicrawl.com/agents/cursor).

</details>

<details>
<summary><b>VS Code (GitHub Copilot)</b></summary>

Use the **Install in VS Code** button above, or add this to `.vscode/mcp.json`. VS Code uses the `servers` key, and the input variable makes it ask for the key once and store it securely, so the file is safe to commit:

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

VS Code does not expand `${env:...}` inside `headers`, so use the input variable. More: [docs.spicrawl.com/agents/github-copilot](https://docs.spicrawl.com/agents/github-copilot).

</details>

<details>
<summary><b>Windsurf (Devin Desktop)</b></summary>

Windsurf is now named Devin Desktop. For the default **Devin Local** agent, add the server in local scope (saved to the gitignored `.devin/mcp_config.local.json`):

```bash
devin mcp add spicrawl https://mcp.spicrawl.com/mcp -H "Authorization: Bearer $SPICRAWL_API_KEY"
```

For the legacy **Cascade** agent, edit `~/.config/devin/mcp_config.json` (`%APPDATA%\devin\mcp_config.json` on Windows). Cascade reads the URL from `serverUrl` and replaces `${env:...}`:

```json
{
  "mcpServers": {
    "spicrawl": {
      "serverUrl": "https://mcp.spicrawl.com/mcp",
      "headers": { "Authorization": "Bearer ${env:SPICRAWL_API_KEY}" }
    }
  }
}
```

More: [docs.spicrawl.com/agents/windsurf](https://docs.spicrawl.com/agents/windsurf).

</details>

<details>
<summary><b>Gemini CLI</b></summary>

Gemini CLI strips variables whose names contain `KEY`, `TOKEN` or `AUTH` before expanding headers, so export the key under another name:

```bash
export SPICRAWL_MCP_BEARER="$SPICRAWL_API_KEY"
```

Then add to `~/.gemini/settings.json` (or `.gemini/settings.json` for one project). Streamable HTTP uses the `httpUrl` key:

```json
{
  "mcpServers": {
    "spicrawl": {
      "httpUrl": "https://mcp.spicrawl.com/mcp",
      "headers": { "Authorization": "Bearer $SPICRAWL_MCP_BEARER" }
    }
  }
}
```

Or: `gemini mcp add --scope user --transport http --header 'Authorization: Bearer $SPICRAWL_MCP_BEARER' spicrawl https://mcp.spicrawl.com/mcp`. Run `/mcp` to check. More: [docs.spicrawl.com/agents/gemini-cli](https://docs.spicrawl.com/agents/gemini-cli).

</details>

<details>
<summary><b>Codex</b></summary>

Codex reads the key from the environment each time it connects, so the key never lands in a file:

```bash
codex mcp add spicrawl --url https://mcp.spicrawl.com/mcp --bearer-token-env-var SPICRAWL_API_KEY
```

The equivalent `~/.codex/config.toml` (or `.codex/config.toml` in a trusted project):

```toml
[mcp_servers.spicrawl]
url = "https://mcp.spicrawl.com/mcp"
bearer_token_env_var = "SPICRAWL_API_KEY"
```

Local stdio instead:

```toml
[mcp_servers.spicrawl]
command = "npx"
args = ["-y", "@spicrawl/mcp"]
env = { SPICRAWL_API_KEY = "spicrawl_live_..." }
```

More: [docs.spicrawl.com/agents/codex](https://docs.spicrawl.com/agents/codex).

</details>

<details>
<summary><b>Any other MCP client</b></summary>

| Setting | Value |
|---|---|
| Transport | Streamable HTTP |
| URL | `https://mcp.spicrawl.com/mcp` |
| Header | `Authorization: Bearer <your key>` |

A stdio-only client runs `npx -y @spicrawl/mcp` with `SPICRAWL_API_KEY` in its environment. The server accepts API keys only, not OAuth. Setup pages for more clients (OpenCode, Zed, JetBrains, Cline, Goose and others): [docs.spicrawl.com/agents/mcp](https://docs.spicrawl.com/agents/mcp).

</details>

## Environment variables

| Variable | Default | Used by | Purpose |
|---|---|---|---|
| `SPICRAWL_API_KEY` | none (required) | stdio | Your API key. The HTTP server ignores it and uses each caller's bearer token. |
| `SPICRAWL_BASE_URL` | `https://api.spicrawl.com` (stdio), `http://127.0.0.1:8080` (HTTP) | both | The Spicrawl API the tools call. |
| `SPICRAWL_PUBLIC_BASE_URL` | `SPICRAWL_BASE_URL` | both | The API as the end user reaches it, used only in URLs handed back. |
| `SPICRAWL_DOCS_URL` | `https://docs.spicrawl.com` | both | Docs base URL for the docs tools. Your key is never sent there. |
| `SPICRAWL_DOCS_HOST` | none | both | Legacy: an origin whose docs are at `/docs`. Read only when `SPICRAWL_DOCS_URL` is unset. |
| `SPICRAWL_MCP_ADDR` | `127.0.0.1:8090` | HTTP | Listen address, `host:port`. |
| `SPICRAWL_MCP_SESSION_IDLE_MS` | `1800000` (30 min) | HTTP | Idle MCP sessions are dropped after this long. |
| `SPICRAWL_MCP_HIDE_UNAVAILABLE` | off | both | `1`, `true`, `yes` or `on` leaves out what is announced but not available yet: `spicrawl_browser_connect_url` is not registered (24 tools) and every argument marked "Coming soon" is dropped from the schemas (`ai_extract`, `stealth`, `extract_preset`, `premium_proxy`, `proxy_country`, `sticky_key`, and the session `rotate_ip`, `region_pool` and `fingerprint`). The `camoufox` engine value stays in the `engine` enums. Read when the server starts a session, so restart the process after changing it. |
| `SPICRAWL_CHATGPT_ENABLED` | off | HTTP | `1`, `true`, `yes` or `on` turns on the [ChatGPT endpoint](#chatgpt-endpoint-oauth). Off, `/chatgpt/mcp`, its metadata and the OpenAI challenge all answer `404`. |
| `SPICRAWL_CHATGPT_RESOURCE` | `https://mcp.spicrawl.com/chatgpt/mcp` | HTTP | The OAuth resource identifier. Tokens must be issued for exactly this `aud`; the metadata is published at `/.well-known/oauth-protected-resource` + its path. |
| `SPICRAWL_OAUTH_ISSUER` | `https://app.spicrawl.com` | HTTP | The authorization server, listed in the metadata. Tokens are introspected at `<issuer>/api/oauth/introspect`. |
| `SPICRAWL_OAUTH_INTROSPECT_SECRET` | none | HTTP | This server's bearer secret at the introspection endpoint. Unset, every token is answered `503`. |
| `SPICRAWL_CHATGPT_ROOT_PRM` | off | HTTP | Also serve the metadata at the root `/.well-known/oauth-protected-resource`. Off by default because `/mcp` takes API keys and must not advertise OAuth. |
| `SPICRAWL_OPENAI_APPS_CHALLENGE` | none | HTTP | The OpenAI domain-verification token served at `/.well-known/openai-apps-challenge`. |
| `SPICRAWL_OPENAI_APPS_CHALLENGE_FILE` | none | HTTP | A file holding that token (surrounding whitespace and the trailing newline are dropped). Read when `SPICRAWL_OPENAI_APPS_CHALLENGE` is unset. |

With no docs variable set, a server pointed at a self-hosted API reads that API's own docs at `<SPICRAWL_PUBLIC_BASE_URL or SPICRAWL_BASE_URL>/docs`.

## Self-host the MCP server over HTTP

The hosted endpoint runs this package's Streamable HTTP server. To run your own:

```bash
SPICRAWL_MCP_ADDR=127.0.0.1:8090 \
SPICRAWL_BASE_URL=https://api.spicrawl.com \
npx -y @spicrawl/mcp --http
```

- `SPICRAWL_BASE_URL` **defaults to `http://127.0.0.1:8080`** in HTTP mode (a Spicrawl API on the same host), not to the public API. Set it to `https://api.spicrawl.com` to front the public API.
- MCP is served at `POST`/`GET`/`DELETE /mcp`; liveness at `GET /healthz` (no auth).
- Each caller sends their own key as `Authorization: Bearer spicrawl_live_...`. The key is checked against the API before a session opens (`401` if refused, `503` with `Retry-After` if the API cannot be reached), and a session is pinned to the key that opened it.
- The server speaks plain HTTP. Put it behind TLS before sending keys across a network.

### ChatGPT endpoint (OAuth)

The same process can serve a second, restricted MCP endpoint for ChatGPT apps. It is off unless `SPICRAWL_CHATGPT_ENABLED` is on, and `/mcp` is unchanged either way.

| Route | What it does |
|---|---|
| `POST /chatgpt/mcp` | MCP Streamable HTTP, **stateless**: no `Mcp-Session-Id`, a fresh server per request, JSON responses. Other methods answer `405`. |
| `GET /.well-known/oauth-protected-resource/chatgpt/mcp` | Protected-resource metadata (RFC 9728): `resource`, `authorization_servers` (the issuer), `scopes_supported: ["scrape","batch"]`, `resource_documentation`. |
| `GET /.well-known/oauth-protected-resource` | The same document, only with `SPICRAWL_CHATGPT_ROOT_PRM`. |
| `GET /.well-known/openai-apps-challenge` | The verification token as `text/plain`, exact bytes, no trailing newline; `404` when none is configured. |

Authentication takes OAuth access tokens (`spicrawl_oat_…`) only:

- No token: `401` with `WWW-Authenticate: Bearer resource_metadata="https://mcp.spicrawl.com/.well-known/oauth-protected-resource/chatgpt/mcp", scope="scrape batch"`.
- A bad, inactive, expired or wrong-audience token, or an API key (`spicrawl_live_…`/`spicrawl_test_…`, never accepted here): the same `401` plus `error="invalid_token", error_description="…"`.
- A tool call the token's scopes do not cover: `403` with `error="insufficient_scope"`. `spicrawl_scrape` needs `scrape`, the batch tools need `batch`, the docs tools need only a valid token.
- The authorization server unreachable or refusing this server's secret: `503` with `Retry-After`.

Each token is checked with `POST <issuer>/api/oauth/introspect` (`Authorization: Bearer <SPICRAWL_OAUTH_INTROSPECT_SECRET>`, form body `token=…`). Only `active: true` with `aud` equal to the resource is accepted. A positive answer is cached by the token's SHA-256 for at most 30 seconds and never past its `exp`. Tools run upstream under the `api_key` the introspection returns; neither it nor the token is logged. If the API refuses that key mid-call, the tool returns an error whose `_meta["mcp/www_authenticate"]` carries a fresh `invalid_token` challenge, and the token is dropped from the cache.

The endpoint lists six tools, each with explicit `readOnlyHint`/`destructiveHint`/`openWorldHint`, a title, and `securitySchemes: [{type: "oauth2", scopes: [...]}]` (also in `_meta.securitySchemes`):

| Tool | Scopes | Arguments |
|---|---|---|
| `spicrawl_scrape` | `scrape` | `url` (http/https only), `format` (`markdown`/`text`/`html`/`json`), `render`, `main_content_only`, `include_tags`, `exclude_tags`, `links`, `extract` (CSS selectors), `autoparse`, `wait_for`, `cache`, `cache_ttl`, `max_cost` (default 5). Always an HTTP GET. |
| `spicrawl_batch_submit` | `batch` | `urls` (1 to 25), `format`, `render`, `main_content_only`, `max_cost`, `credit_budget` (default 50). |
| `spicrawl_batch_status` | `batch` | `job_id`. |
| `spicrawl_batch_results` | `batch` | `job_id`, `status`, `limit` (default 25, max 100), `cursor`. |
| `spicrawl_docs_search`, `spicrawl_docs_read` | none | As on `/mcp`. |

`spicrawl_scrape` is read-only here, unlike on `/mcp`: this endpoint only sends a GET, with no `method`, body, headers or `actions`. `spicrawl_batch_submit` is not read-only, because it creates a job.

`spicrawl_batch_results` fills in the content of a succeeded item that the results page lists without it, which happens while the job is still finishing, from `GET /v1/batch/{id}/tasks/{seq}/content`. It fetches at most 25 items and 2 MiB per page. An item that can't be read yet comes back `unavailable`, and one past the size cap `omitted`.

Every other argument is refused, not dropped. Results keep the content, the site's status and the credits charged; request ids, timestamps, engine and proxy details, storage references and project ids are left out.

Installed globally (`npm install -g @spicrawl/mcp`), the command is `spicrawl-mcp` (alias `spicrawl-mcp-server`), with `--http`, `--version` and `--help`.

## FAQ

### Is there a hosted Spicrawl MCP server?
Yes: `https://mcp.spicrawl.com/mcp`, MCP Streamable HTTP, authenticated with `Authorization: Bearer <API key>`, so there is nothing to install.

### Is Spicrawl free?
Spicrawl bills credits per successful request, and during the beta every organization gets one plan of 1,000 credits per month. Failed requests cost 0 credits; a cache hit is billed at the same price as the fetch that stored it. See [Credits](https://docs.spicrawl.com/credits).

### Does it render JavaScript?
Yes. Set `render: true` on `spicrawl_scrape` to run the page in a browser, or `mode: "auto"` to let Spicrawl escalate from a plain fetch only when needed.

### Does it work with Claude Code, Cursor and VS Code?
Yes, and with Claude Desktop, Windsurf, Gemini CLI, Codex and any client that speaks MCP Streamable HTTP with custom headers or launches stdio servers.

### Can it crawl a whole website?
There is no single crawl tool. Scrape a page with `links: true` to get its links, then feed them to an open batch job (`open: true` and `spicrawl_batch_add_items`).

### Does it support OAuth?
Not on `/mcp`: it accepts Spicrawl API keys only, so turn OAuth off for it in clients that try it on a `401`. The separate [ChatGPT endpoint](#chatgpt-endpoint-oauth) at `/chatgpt/mcp` takes OAuth access tokens only, when the operator turns it on.

### Should I use the MCP server, the SDK or the CLI?
Use the MCP server when an AI agent should call Spicrawl as tools. Use [`@spicrawl/sdk`](https://github.com/OfficialSpicrawl/sdk) in your own TypeScript or JavaScript code, [`@spicrawl/cli`](https://github.com/OfficialSpicrawl/cli) in a terminal or shell script, and the [REST API](https://docs.spicrawl.com/quickstart) from any other language.

## Troubleshooting

| Symptom | Fix |
|---|---|
| HTTP `401` or "Unauthorized: send your Spicrawl API key" | The header is missing, or the key is unknown, revoked or expired. Check that the variable is set in the environment the client started from. |
| The header contains a literal `${SPICRAWL_API_KEY}` | The client did not expand it. Use `${VAR}` in Claude Code, `${env:VAR}` in Cursor, `${input:id}` in VS Code, `bearer_token_env_var` in Codex. |
| HTTP `503` with `Retry-After` on connect | The server could not reach the API to check your key. Retry; your key is fine. |
| `ERR::AUTH::INSUFFICIENT_SCOPE` from a `spicrawl_usage*` tool | Grant the key the `read` scope in the dashboard. |
| `ERR::LIMIT::QUOTA_EXCEEDED` (HTTP 402) | The monthly credit allowance is used up. Not retryable until it resets. |
| "Unknown argument" on `spicrawl_scrape` | Use the tool's names: `render`, not `js_render`; `format`, not `response_format`. |
| Tools do not appear | Restart the client, and check the config key (`servers` in VS Code, `mcpServers` elsewhere). |
| `npx` not found (stdio) | Install Node.js 20 or later. |

`curl -i https://mcp.spicrawl.com/mcp` without a key answers `401`: the endpoint is reachable.

## Related packages

- [`@spicrawl/sdk`](https://github.com/OfficialSpicrawl/sdk): the official TypeScript SDK for the Spicrawl API.
- [`@spicrawl/cli`](https://github.com/OfficialSpicrawl/cli): the Spicrawl command-line interface.
- [OfficialSpicrawl/agent-plugins](https://github.com/OfficialSpicrawl/agent-plugins): plugins that bundle this server and the Spicrawl skill for Claude Code, Codex, Cursor, Gemini CLI and more.

## Links

- Documentation: [docs.spicrawl.com/agents/mcp](https://docs.spicrawl.com/agents/mcp)
- Docs for LLMs: [docs.spicrawl.com/llms.txt](https://docs.spicrawl.com/llms.txt)
- Dashboard and API keys: [app.spicrawl.com](https://app.spicrawl.com)
- Issues: [github.com/OfficialSpicrawl/mcp/issues](https://github.com/OfficialSpicrawl/mcp/issues)
- Security: [SECURITY.md](https://github.com/OfficialSpicrawl/mcp/blob/main/SECURITY.md). Never commit an API key; revoke a leaked one at [app.spicrawl.com](https://app.spicrawl.com).

## Publishing to the MCP Registry

[`server.json`](./server.json) lists both the npm/stdio package and the hosted
Streamable HTTP endpoint under `io.github.OfficialSpicrawl/mcp`. API keys are
requested from the person installing the server; no key belongs in the manifest.

The existing `release` workflow publishes to the MCP Registry **after** its npm
job succeeds, on pushes to `main` or manual runs from `main`. Registry authentication
uses GitHub OIDC (`id-token: write`), so it needs no new secret, device login or DNS
record. The npm release keeps using the existing `NPM_TOKEN` secret.

For a release, run `npm version --no-git-tag-version X.Y.Z`, update the changelog,
and submit the changes to `main`. The npm version hook synchronizes both versions
in `server.json`. If you edit `package.json` by hand, run `npm run registry:sync`.
CI checks the manifest against its official `$schema` with Ajv and rejects name
or version drift before npm publication. To run that check locally:

```bash
npm ci
npm run registry:validate
# Offline: pass a downloaded copy of the exact server.json $schema URL.
npm run registry:validate -- /path/to/server.schema.json
```

The registry job checks that the published npm package has the matching `mcpName`
before publishing. An existing registry version is skipped; lookup failures stop
the job. To retry a registry failure or list the already-published current npm
version, run the `release` workflow on `main` again. Use a new version for metadata
changes to an existing listing. The publisher binary is pinned and its download
is checked against the release checksums; update its version in `release.yml`
when upgrading the CLI.

Verify publication at
<https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.OfficialSpicrawl/mcp>.
The workflow must be merged into `OfficialSpicrawl/mcp` before OIDC can publish
that namespace. Fork pull requests validate and test, but never run the registry job.

Official references: [publishing quickstart](https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/quickstart.mdx),
[GitHub Actions](https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/github-actions.mdx),
and [remote servers](https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/remote-servers.mdx).

## License

[Apache-2.0](https://github.com/OfficialSpicrawl/mcp/blob/main/LICENSE)
