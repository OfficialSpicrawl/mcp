/**
 * The ChatGPT surface's HTTP routes, mounted by http.ts when
 * SPICRAWL_CHATGPT_ENABLED is on (all of them answer 404 otherwise):
 *
 *   POST /chatgpt/mcp                                     stateless MCP, OAuth access tokens only
 *   GET  /.well-known/oauth-protected-resource/chatgpt/mcp  protected-resource metadata (RFC 9728)
 *   GET  /.well-known/oauth-protected-resource            the same, only with SPICRAWL_CHATGPT_ROOT_PRM
 *   GET  /.well-known/openai-apps-challenge               OpenAI domain verification token
 *
 * Stateless: every POST is verified on its own and served by a fresh MCP server
 * and transport, so no session can outlive or outrank the token that made it.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ILayerClient } from "../client.js";
import { KEY_RE, bearerToken, readJSON, rpcError } from "../httputil.js";
import {
  ACCESS_TOKEN_RE,
  Introspector,
  SCOPES,
  bearerChallenge,
  prmPath,
  protectedResourceMetadata,
  type ChatgptConfig,
  type Grant,
  type Scope,
} from "./oauth.js";
import { TOOL_SCOPES, buildChatgptServer } from "./tools.js";

export const CHATGPT_MCP_PATH = "/chatgpt/mcp";
const ROOT_PRM_PATH = "/.well-known/oauth-protected-resource";
const CHALLENGE_PATH = "/.well-known/openai-apps-challenge";

export interface ChatgptDeps {
  baseURL: string;
  publicBaseURL: string;
  log: (...a: unknown[]) => void;
}

/** Scopes a JSON-RPC message (or batch of them) needs: those of every tool it calls. */
function requiredScopes(body: unknown): Scope[] {
  const out = new Set<Scope>();
  for (const msg of Array.isArray(body) ? body : [body]) {
    if (!msg || typeof msg !== "object" || (msg as { method?: unknown }).method !== "tools/call") continue;
    const name = (msg as { params?: { name?: unknown } }).params?.name;
    for (const s of (typeof name === "string" && TOOL_SCOPES[name]) || []) out.add(s);
  }
  return SCOPES.filter((s) => out.has(s));
}

/** Returns a router: true when it answered the request, false to let the caller 404 it. */
export function chatgptRoutes(config: ChatgptConfig, deps: ChatgptDeps) {
  const introspector = new Introspector(config, { log: deps.log });
  const prm = prmPath(config.resource);
  const metadata = JSON.stringify(protectedResourceMetadata(config));

  const unauthorized = (res: ServerResponse, description?: string) =>
    rpcError(res, 401, -32001, `Unauthorized: ${description ?? "connect with OAuth to use this endpoint"}`, {
      "WWW-Authenticate": bearerChallenge(config.resource, description ? { error: "invalid_token", description } : {}),
    });

  async function handleMcp(req: IncomingMessage, res: ServerResponse) {
    const token = bearerToken(req);
    if (!token) return unauthorized(res);
    if (KEY_RE.test(token)) {
      return unauthorized(res, "API keys are not accepted on this endpoint; connect the Spicrawl app with OAuth");
    }
    if (!ACCESS_TOKEN_RE.test(token)) return unauthorized(res, "The access token is malformed");

    const check = await introspector.introspect(token);
    if (!check.ok) {
      return check.status === 401
        ? unauthorized(res, check.description)
        : rpcError(res, 503, -32000, `Service Unavailable: ${check.description}; retry shortly`, { "Retry-After": "5" });
    }
    const grant: Grant = check.grant;

    if (req.method !== "POST") {
      return rpcError(res, 405, -32000, "Method not allowed: this endpoint is stateless; POST JSON-RPC requests", { Allow: "POST" });
    }
    let body: unknown;
    try {
      body = await readJSON(req);
    } catch {
      return rpcError(res, 400, -32700, "Parse error: body must be JSON (max 4 MiB)");
    }

    const missing = requiredScopes(body).filter((s) => !grant.scopes.has(s));
    if (missing.length) {
      const description = `This tool needs the ${missing.join(" and ")} permission; reconnect the Spicrawl app to grant it`;
      return rpcError(res, 403, -32003, `Forbidden: ${description}`, {
        "WWW-Authenticate": bearerChallenge(config.resource, {
          scope: SCOPES.filter((s) => grant.scopes.has(s) || missing.includes(s)).join(" "),
          error: "insufficient_scope",
          description,
        }),
      });
    }

    const client = new ILayerClient({ apiKey: grant.apiKey, baseURL: deps.baseURL, publicBaseURL: deps.publicBaseURL });
    const server = buildChatgptServer(client, {
      upstreamChallenge: (scopes) =>
        bearerChallenge(config.resource, {
          scope: (scopes.length ? scopes : SCOPES).join(" "),
          error: "invalid_token",
          description: "The Spicrawl credential behind this access token was refused; reconnect the Spicrawl app",
        }),
      onUpstreamUnauthorized: () => introspector.forget(token),
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close().catch(() => {});
      void server.close().catch(() => {});
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  const sendMetadata = (req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=300",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(req.method === "HEAD" ? undefined : metadata);
  };

  return (req: IncomingMessage, res: ServerResponse, path: string): boolean => {
    if (!config.enabled) return false;
    const read = req.method === "GET" || req.method === "HEAD";

    if (path === CHATGPT_MCP_PATH) {
      handleMcp(req, res).catch((err) => {
        deps.log("chatgpt request failed:", err instanceof Error ? err.message : String(err));
        rpcError(res, 500, -32603, "Internal error");
      });
      return true;
    }
    if (read && (path === prm || (config.rootPrm && path === ROOT_PRM_PATH))) {
      sendMetadata(req, res);
      return true;
    }
    if (read && path === CHALLENGE_PATH && config.appsChallenge) {
      const bytes = Buffer.from(config.appsChallenge, "utf8");
      res.writeHead(200, { "Content-Type": "text/plain", "Content-Length": String(bytes.length) });
      res.end(req.method === "HEAD" ? undefined : bytes);
      return true;
    }
    return false;
  };
}
