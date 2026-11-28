import type { IncomingMessage, ServerResponse } from "node:http";

/** The largest JSON-RPC body either MCP endpoint reads. */
export const MAX_BODY = 4 * 1024 * 1024;

/** A JSON-RPC error with an HTTP status, unless a response is already under way. */
export function rpcError(res: ServerResponse, status: number, code: number, message: string, extra: Record<string, string> = {}) {
  if (res.headersSent) return;
  res.writeHead(status, { "Content-Type": "application/json", ...extra });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}

/** Reads and parses a JSON body of at most `max` bytes (default MAX_BODY); an empty body is undefined. */
export async function readJSON(req: IncomingMessage, max = MAX_BODY): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > max) throw new Error("body too large");
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

/** Origins a browser may send to an MCP endpoint without any configuration. */
const DEFAULT_ORIGINS = new Set(["https://claude.ai", "https://chatgpt.com", "https://chat.openai.com", "https://spicrawl.com"]);
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Whether a request's `Origin` header may reach an MCP endpoint (MCP Streamable HTTP
 * requires the check, against DNS rebinding). `extra` holds the exact origins added by
 * configuration. The header must be a canonical origin: a path, a trailing slash or
 * `null` fails, and hosts are compared whole, so `claude.ai.evil.com` never matches.
 */
export function originAllowed(origin: string, extra: ReadonlySet<string>): boolean {
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  if (u.origin !== origin) return false;
  if (DEFAULT_ORIGINS.has(origin) || extra.has(origin)) return true;
  if (u.protocol === "http:" && LOCAL_HOSTS.has(u.hostname)) return true;
  return u.protocol === "https:" && u.port === "" && (u.hostname === "spicrawl.com" || u.hostname.endsWith(".spicrawl.com"));
}

/**
 * Whether the request presented anything as a credential: a non-blank
 * `Authorization`, `x-api-key` or `api-key` header, well-formed or not. A caller
 * who sent a (mistyped) key must hear that it is wrong, not be treated as keyless.
 */
export function presentsCredentials(req: IncomingMessage): boolean {
  const h = req.headers;
  return [h.authorization, h["x-api-key"], h["api-key"]].some((v) => (Array.isArray(v) ? v.join("") : (v ?? "")).trim() !== "");
}
