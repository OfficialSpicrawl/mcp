import type { IncomingMessage, ServerResponse } from "node:http";

/** The largest JSON-RPC body either MCP endpoint reads. */
export const MAX_BODY = 4 * 1024 * 1024;

/** A JSON-RPC error with an HTTP status, unless a response is already under way. */
export function rpcError(res: ServerResponse, status: number, code: number, message: string, extra: Record<string, string> = {}) {
  if (res.headersSent) return;
  res.writeHead(status, { "Content-Type": "application/json", ...extra });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}

/** Reads and parses a JSON body of at most MAX_BODY bytes; an empty body is undefined. */
export async function readJSON(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new Error("body too large");
    chunks.push(c as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : undefined;
}

/** `Authorization: Bearer <token>` -> the token, or null. The token's shape is not checked here. */
export function bearerToken(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  if (!h) return null;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(h);
  return m ? m[1] : null;
}

/** Spicrawl API keys (`spicrawl_live_…`, `spicrawl_test_…`). */
export const KEY_RE = /^spicrawl_(live|test)_[A-Za-z0-9_-]{8,}$/;

/**
 * The API key a caller of /mcp sent, or null. Tried in order, the first that has a
 * key's shape wins: `Authorization: Bearer <key>`, `Authorization: <key>` (the raw
 * value a gateway such as Smithery sends, with no scheme), `x-api-key`, `api-key`.
 * Headers only: a key in a query string would land in access logs.
 */
export function apiKeyFromRequest(req: IncomingMessage): string | null {
  const h = req.headers;
  const candidates = [bearerToken(req), h.authorization?.trim(), h["x-api-key"], h["api-key"]];
  return candidates.find((c): c is string => typeof c === "string" && KEY_RE.test(c)) ?? null;
}
