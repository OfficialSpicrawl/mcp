# Changelog

All notable changes to `@spicrawl/mcp` are documented here. This project follows
[Semantic Versioning](https://semver.org/).

## 0.1.8 — 2026-10-15

Listing copy and keywords; no code changes.

- `package.json`, `server.json` and the Cursor plugin manifest: a search-led description and keywords, so npm search, the MCP Registry and cursor.directory match what people look for.
- README: a first paragraph that answers how to let Claude or Cursor scrape websites, a use cases list, an FAQ and install links for each directory.

## 0.1.7 — 2026-10-13

- Every tool now declares an MCP `outputSchema` and returns matching `structuredContent` next to the same text it always returned, so a client can read fields such as `credits`, `status` and `next_cursor` without parsing text. The schemas follow the API's OpenAPI and are deliberately open: every field but an id is optional, fields the API adds later pass through (`additionalProperties` is true), and values such as a job or session `status` and an `engine` are plain strings with the known values in the description, because a client rejects a result that fails its schema. A test fails if a schema ever uses an enum, a format or a closed object. An error is still a tool error with no `structuredContent`.
- **Changed:** a tool whose payload is not a JSON object now also returns `structuredContent`, as `{ "content": <payload> }` (the shape a non-JSON body already had), because MCP requires an object there and a client enforcing an `outputSchema` refuses a result without one. This covers `spicrawl_docs_read`, `spicrawl_docs_index` and `spicrawl_batch_task_content` when an item's stored payload is a bare string or a JSON array. The text content is unchanged: still the document itself, or the array as JSON.
- `spicrawl_docs_read` and `spicrawl_docs_index` also report `url`, `truncated` and (for a page) `title`, `md_url` and `section` in `structuredContent`.
- `/mcp` answers discovery without an API key, so a directory such as Smithery can list the tools while the key is an optional connection parameter: `initialize`, `ping`, the `initialized` notification and `tools/list` (the same list as the server card). No session is opened and nothing is sent to the API. Every other request, a `tools/call` included, is still `401` and names `x-api-key`; so is a request that sends a malformed key (only a blank key header counts as no key) or names a session id. A session-less `GET` is `405`. Keyed requests, the key check at `initialize` and session pinning are unchanged.
- Tool names are unchanged. Smithery's naming check prefers dot notation, but Claude's API and OpenAI's function calling accept only letters, digits, `_` and `-` in a tool name, so renaming would make the tools unusable in those clients.

## 0.1.6 — 2026-10-13

- `/mcp` now accepts the API key in the forms a gateway such as Smithery can send, because Smithery maps a connection parameter to a header but sends the raw value with no `Bearer ` prefix, and clients often cannot name the source `authorization`. In order: `Authorization: Bearer <key>` (unchanged), a raw `Authorization: <key>` when the whole value is a Spicrawl key, `x-api-key: <key>`, then `api-key: <key>`. The first form that holds a well-formed key wins.
- A key is read from headers only, never from a query parameter, because URLs end up in access logs. A malformed value in any form is still `401`.
- The `401` message mentions `x-api-key` as an alternative; its `WWW-Authenticate` challenge is unchanged. The session pinning, the key check at `initialize` and the server card are unchanged.
- `/chatgpt/mcp` is unchanged: it takes OAuth access tokens only and ignores these headers.
- README: Smithery configuration guidance (header `x-api-key`, or `Authorization` with the raw key).

## 0.1.5 — 2026-10-12

- A static MCP server card at `GET /.well-known/mcp/server-card.json` on the HTTP server, so directories such as Smithery can list the server without a key (`/mcp` answers 401). It carries `serverInfo`, the streamable-http transport, bearer auth and the tool list, generated from the real tool definitions. The tool definitions name no execution engine, so the card is not filtered: it is the `tools/list` of `/mcp` with `SPICRAWL_MCP_HIDE_UNAVAILABLE` on, including the session `engine` tiers (`fetch`, `js`, `browser`). A test fails if the card or any published file ever names one. Public and cacheable for an hour. `/mcp` is unchanged.

Internal engine names no longer appear in the tool definitions, the README or the npm package. Customers see the public rendering tiers (`fetch`, `js`, `browser`) and nothing else.

- **Breaking:** `engine` and its display-mode flag are no longer arguments of `spicrawl_scrape`, and `engine` is no longer an argument of `spicrawl_batch_submit` and `spicrawl_batch_add_items`. The API ignored them (it answers with an `ENGINE_IGNORED` warning), because it chooses the rendering itself. A call that still sends one is refused with an "unknown argument" error; drop it.
- **Breaking:** `engine` on `spicrawl_session_create` and `spicrawl_session_list` now takes the public tiers `fetch`, `js` or `browser`. On create it is optional and fixed for the session's life; leave it out and one is chosen for you.
- **Breaking:** `spicrawl_browser_connect_url` takes `engine` of `browser` (default) or `js`, and no longer takes the display-mode flag: the API chooses it. Its result no longer carries ready-made connect snippets for particular client libraries; use the returned `url` as the browser WebSocket endpoint of any CDP client. The tool is still coming soon.
- Descriptions no longer name an internal engine or a browser library. `format: "pdf"` is described as printed in a full browser, routed there for you (it needs no `render` or `engine`).
- README, the `package.json` keywords and the examples follow.
- A new test fails if the whole `tools/list` output (names, titles, descriptions, schemas) of `/mcp`, with and without `SPICRAWL_MCP_HIDE_UNAVAILABLE`, or of `/chatgpt/mcp`, names an internal engine or browser tooling.

## 0.1.4 — 2026-10-05

The repository moved to https://github.com/OfficialSpicrawl/mcp, and `mcpName` is now `io.github.OfficialSpicrawl/mcp`. No code or tool changes.

## 0.1.3 — 2026-10-01

- `spicrawl_scrape` on the ChatGPT endpoint (`/chatgpt/mcp`) is now annotated `readOnlyHint: true`. That surface only ever sends an HTTP GET with no method, body, headers or actions, so it cannot change anything on a site. On `/mcp` it stays not read-only, because `method` and `actions` can submit forms.
- `spicrawl_batch_results` on the ChatGPT endpoint now returns page content even when it is called before the job is `completed`. The API inlines `result.content` only once the whole job is terminal, while each item reports `succeeded` as soon as it finishes, so a model that read results early got metadata only. A succeeded item without content is now filled from `GET /v1/batch/{id}/tasks/{seq}/content` (at most 25 items and 2 MiB per page). An item that can't be read yet is marked `unavailable`, and one past the size cap is marked `omitted`.

## 0.1.2 — 2026-10-01

- Every tool's MCP annotations are now accurate, and a tool without a `title` and explicit `readOnlyHint`, `destructiveHint` and `openWorldHint` no longer compiles. `spicrawl_scrape` is no longer read-only, because `method` and `actions` can submit forms. `spicrawl_session_release` is destructive, because it purges cookies. Tools confined to your own account are no longer open-world. `test/annotations.test.mjs` pins each value.
- `SPICRAWL_MCP_HIDE_UNAVAILABLE` (off by default) leaves out what is announced but not available yet: `spicrawl_browser_connect_url` is not registered and every "Coming soon" argument is dropped from the schemas.
- Tool descriptions no longer name another product. The scrape description states billing and side effects. A printed PDF's JSON no longer carries the request id.
- A ChatGPT endpoint on the HTTP server, off unless `SPICRAWL_CHATGPT_ENABLED` is on: stateless `POST /chatgpt/mcp` that takes OAuth access tokens only (introspected at `<SPICRAWL_OAUTH_ISSUER>/api/oauth/introspect`, positive answers cached at most 30 s), protected-resource metadata at `/.well-known/oauth-protected-resource/chatgpt/mcp` (and at the root with `SPICRAWL_CHATGPT_ROOT_PRM`), the OpenAI domain challenge at `/.well-known/openai-apps-challenge`, and a restricted six-tool profile with OAuth `securitySchemes` and sanitized results. `/mcp` is unchanged.

## 0.1.1 — 2026-10-01

Documentation and package metadata only; the server and its 25 tools are unchanged.

- README rewritten for npmjs.com: hosted endpoint first, one-click install links for Cursor and VS Code, per-client setup for Claude Code, Claude Desktop, Cursor, VS Code, Windsurf, Gemini CLI and Codex, tool tables by group, a "which tool to use" guide, environment variables, self-hosting, FAQ and troubleshooting. Every link is absolute so it works on npm.
- `package.json`: `mcpName` (`io.github.OfficialSpicrawl/mcp`) for the official MCP registry, a new `description` and `keywords`, and `homepage` now points at https://docs.spicrawl.com/agents/mcp.

## 0.1.0 — 2026-10-01

First public release of the Spicrawl MCP server, published to npm as `@spicrawl/mcp` from https://github.com/OfficialSpicrawl/mcp with an npm provenance attestation.

- `npx -y @spicrawl/mcp` runs the stdio server for any MCP client (Claude Code, Claude Desktop, Cursor, VS Code, Codex, …), keyed by `SPICRAWL_API_KEY`. Installed globally, the command is `spicrawl-mcp` (`spicrawl-mcp-server` is an alias).
- `spicrawl-mcp --http` (or `node dist/http.js`) runs the Streamable HTTP server behind the hosted endpoint at https://mcp.spicrawl.com/mcp: per-caller bearer-token auth validated against the API, sessions pinned to the key that opened them, idle-session eviction and a `/healthz` liveness route.
- 25 tools: `spicrawl_scrape`; batch jobs (`spicrawl_batch_submit`, `_list`, `_status`, `_results`, `_task_content`, `_cancel`, `_retry`, `_add_items`, `_close`); browser sessions (`spicrawl_session_create`, `_list`, `_get`, `_context`, `_release`, `_delete`); usage and request history (`spicrawl_usage`, `_usage_summary`, `_usage_reconciliation`, `spicrawl_requests_list`, `spicrawl_request_get`); `spicrawl_browser_connect_url` (coming soon); and the docs (`spicrawl_docs_search`, `_read`, `_index`).
- Tools refuse unknown arguments instead of dropping them, and surface the platform's error codes and guidance.
- Screenshots come back as MCP image blocks and printed pages (`format: "pdf"`) as PDF resource blocks.
- `--version` and `--help`. The version reported to MCP clients and in the `User-Agent` (`spicrawl-mcp/<version>`) is read from package.json.

Previously developed in Spicrawl's private repository as the unpublished `spicrawl-mcp-server` 0.2.0; this is the same server under its public name.
