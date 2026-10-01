# Changelog

All notable changes to `@spicrawl/mcp` are documented here. This project follows
[Semantic Versioning](https://semver.org/).

## 0.1.2 — 2026-10-01

- Every tool's MCP annotations are now accurate, and a tool without a `title` and explicit `readOnlyHint`, `destructiveHint` and `openWorldHint` no longer compiles. `spicrawl_scrape` is no longer read-only, because `method` and `actions` can submit forms. `spicrawl_session_release` is destructive, because it purges cookies. Tools confined to your own account are no longer open-world. `test/annotations.test.mjs` pins each value.
- `SPICRAWL_MCP_HIDE_UNAVAILABLE` (off by default) leaves out what is announced but not available yet: `spicrawl_browser_connect_url` is not registered and every "Coming soon" argument is dropped from the schemas.
- Tool descriptions no longer name another product. The scrape description states billing and side effects. A printed PDF's JSON no longer carries the request id.
- A ChatGPT endpoint on the HTTP server, off unless `SPICRAWL_CHATGPT_ENABLED` is on: stateless `POST /chatgpt/mcp` that takes OAuth access tokens only (introspected at `<SPICRAWL_OAUTH_ISSUER>/api/oauth/introspect`, positive answers cached at most 30 s), protected-resource metadata at `/.well-known/oauth-protected-resource/chatgpt/mcp` (and at the root with `SPICRAWL_CHATGPT_ROOT_PRM`), the OpenAI domain challenge at `/.well-known/openai-apps-challenge`, and a restricted six-tool profile with OAuth `securitySchemes` and sanitized results. `/mcp` is unchanged.

## 0.1.1 — 2026-10-01

Documentation and package metadata only; the server and its 25 tools are unchanged.

- README rewritten for npmjs.com: hosted endpoint first, one-click install links for Cursor and VS Code, per-client setup for Claude Code, Claude Desktop, Cursor, VS Code, Windsurf, Gemini CLI and Codex, tool tables by group, a "which tool to use" guide, environment variables, self-hosting, FAQ and troubleshooting. Every link is absolute so it works on npm.
- `package.json`: `mcpName` (`io.github.Spicrawl/mcp`) for the official MCP registry, a new `description` and `keywords`, and `homepage` now points at https://docs.spicrawl.com/agents/mcp.

## 0.1.0 — 2026-10-01

First public release of the Spicrawl MCP server, published to npm as `@spicrawl/mcp` from https://github.com/Spicrawl/mcp with an npm provenance attestation.

- `npx -y @spicrawl/mcp` runs the stdio server for any MCP client (Claude Code, Claude Desktop, Cursor, VS Code, Codex, …), keyed by `SPICRAWL_API_KEY`. Installed globally, the command is `spicrawl-mcp` (`spicrawl-mcp-server` is an alias).
- `spicrawl-mcp --http` (or `node dist/http.js`) runs the Streamable HTTP server behind the hosted endpoint at https://mcp.spicrawl.com/mcp: per-caller bearer-token auth validated against the API, sessions pinned to the key that opened them, idle-session eviction and a `/healthz` liveness route.
- 25 tools: `spicrawl_scrape`; batch jobs (`spicrawl_batch_submit`, `_list`, `_status`, `_results`, `_task_content`, `_cancel`, `_retry`, `_add_items`, `_close`); browser sessions (`spicrawl_session_create`, `_list`, `_get`, `_context`, `_release`, `_delete`); usage and request history (`spicrawl_usage`, `_usage_summary`, `_usage_reconciliation`, `spicrawl_requests_list`, `spicrawl_request_get`); `spicrawl_browser_connect_url` (coming soon); and the docs (`spicrawl_docs_search`, `_read`, `_index`).
- Tools refuse unknown arguments instead of dropping them, and surface the platform's error codes and guidance.
- Screenshots come back as MCP image blocks and printed pages (`format: "pdf"`) as PDF resource blocks.
- `--version` and `--help`. The version reported to MCP clients and in the `User-Agent` (`spicrawl-mcp/<version>`) is read from package.json.

Previously developed in Spicrawl's private repository as the unpublished `spicrawl-mcp-server` 0.2.0; this is the same server under its public name.
