# Install the Spicrawl MCP server

Instructions for an AI agent (Cline and other MCP clients) setting up Spicrawl for a user.
Spicrawl reads web pages for you: one URL in, Markdown, HTML, text or JSON out, plus batch jobs,
screenshots, PDF output and browser sessions. The server exposes 24 tools, all named `spicrawl_*`.

## Before you start

1. The user needs a Spicrawl API key. Create one at https://app.spicrawl.com/signup. Keys start with
   `spicrawl_live_` or `spicrawl_test_`. The free tier includes 1,000 credits per month, and empty or
   blocked pages are not charged.
2. Ask the user for the key. Do not invent one, and do not write it into a file inside a project
   repository. It belongs in the MCP settings file, which lives in the user's home directory.

## Option A: hosted server (recommended, nothing to install)

Open Cline's MCP settings file (`cline_mcp_settings.json`: MCP Servers icon, **Configure** tab,
**Configure MCP Servers**) and add this under `mcpServers`:

```json
{
  "mcpServers": {
    "spicrawl": {
      "type": "streamableHttp",
      "url": "https://mcp.spicrawl.com/mcp",
      "headers": { "Authorization": "Bearer <SPICRAWL_API_KEY>" },
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

Replace `<SPICRAWL_API_KEY>` with the user's key. `type` must be `streamableHttp`: without it Cline
falls back to the legacy `sse` transport and the connection fails. The key can also be sent in an
`x-api-key` header instead of `Authorization`.

## Option B: local server over stdio (Node.js 20 or newer)

Use this when the client only launches local processes.

```json
{
  "mcpServers": {
    "spicrawl": {
      "command": "npx",
      "args": ["-y", "@spicrawl/mcp"],
      "env": { "SPICRAWL_API_KEY": "<SPICRAWL_API_KEY>" },
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

Both options serve the same tools and run under the same key, limits and credits.

## Check that it works

1. The `spicrawl` server should show as connected and list 24 tools. Listing tools works without a
   key, so a listed server does not prove the key is right.
2. Call `spicrawl_usage_summary` (read-only, no arguments). It answers with the account's usage when
   the key is valid.
3. Then try a page: call `spicrawl_scrape` with `{"url": "https://example.com"}`. The default output
   is Markdown.

## Notes for the agent

- Leave `autoApprove` empty at first. `spicrawl_scrape` is not read-only: its `method` and `actions`
  arguments can submit forms or click on the target site, so set them only when the user asks.
- `spicrawl_batch_cancel`, `spicrawl_session_release` and `spicrawl_session_delete` are destructive.
- Add `"render": true` to `spicrawl_scrape` for pages that need JavaScript. Spicrawl picks the
  rendering for each request; there is nothing to choose.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Server fails to connect | Check `"type": "streamableHttp"` and the URL `https://mcp.spicrawl.com/mcp`. |
| Tools list, but every call returns 401 | The key is missing, malformed or revoked. Create a new one at https://app.spicrawl.com. |
| Tools do not appear (stdio) | Confirm `node --version` is 20 or newer, then restart Cline. |

Full documentation: https://docs.spicrawl.com/agents/mcp. Source: https://github.com/OfficialSpicrawl/mcp
