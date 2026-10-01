/**
 * OAuth for the ChatGPT surface (`/chatgpt/mcp`): its configuration, the
 * protected-resource metadata it publishes (RFC 9728), the WWW-Authenticate
 * challenges it answers with, and access-token introspection (RFC 7662) against
 * the Spicrawl authorization server.
 *
 * The surface never takes an API key. A caller presents an OAuth access token
 * (`spicrawl_oat_…`); the authorization server says which project it belongs to
 * and hands back the API key to run that project's calls under. Neither the
 * token nor that key is ever logged.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { USER_AGENT } from "../client.js";
import { isTruthy } from "../server.js";
import { KEY_RE } from "../httputil.js";

/** Every scope the surface knows, in the order the challenge lists them. */
export const SCOPES = ["scrape", "batch"] as const;
export type Scope = (typeof SCOPES)[number];

export const DEFAULT_RESOURCE = "https://mcp.spicrawl.com/chatgpt/mcp";
export const DEFAULT_ISSUER = "https://app.spicrawl.com";
export const RESOURCE_DOCUMENTATION = "https://docs.spicrawl.com/agents/mcp";
/** OAuth access tokens the Spicrawl authorization server issues. */
export const ACCESS_TOKEN_RE = /^spicrawl_oat_[A-Za-z0-9_-]{8,}$/;

const INTROSPECT_TIMEOUT_MS = 5_000;
/** A positive introspection is reused for at most this long, and never past the token's `exp`. */
export const CACHE_MAX_MS = 30_000;
const CACHE_MAX_ENTRIES = 10_000;

export interface ChatgptConfig {
  /** SPICRAWL_CHATGPT_ENABLED: the kill switch. Off: every route below answers 404. */
  enabled: boolean;
  /** SPICRAWL_CHATGPT_RESOURCE: the resource identifier tokens must be issued for (`aud`). */
  resource: string;
  /** SPICRAWL_OAUTH_ISSUER: the authorization server, no trailing slash. */
  issuer: string;
  /** SPICRAWL_OAUTH_INTROSPECT_SECRET: this server's credential at the introspection endpoint. */
  introspectSecret: string;
  /** SPICRAWL_CHATGPT_ROOT_PRM: also publish the metadata at the root well-known path. */
  rootPrm: boolean;
  /** SPICRAWL_OPENAI_APPS_CHALLENGE (or `…_FILE`): the domain-verification token, or "" for none. */
  appsChallenge: string;
}

const trimURL = (s: string | undefined) => (s ?? "").trim().replace(/\/+$/, "");

/** The configuration from the environment. Throws when a set value is unusable. */
export function chatgptConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ChatgptConfig {
  const resource = trimURL(env.SPICRAWL_CHATGPT_RESOURCE) || DEFAULT_RESOURCE;
  const issuer = trimURL(env.SPICRAWL_OAUTH_ISSUER) || DEFAULT_ISSUER;
  for (const [name, v] of [["SPICRAWL_CHATGPT_RESOURCE", resource], ["SPICRAWL_OAUTH_ISSUER", issuer]]) {
    let u: URL;
    try {
      u = new URL(v);
    } catch {
      throw new Error(`${name} '${v}' is not an absolute URL`);
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error(`${name} '${v}' must be http(s)`);
  }
  let appsChallenge = (env.SPICRAWL_OPENAI_APPS_CHALLENGE ?? "").trim();
  const file = (env.SPICRAWL_OPENAI_APPS_CHALLENGE_FILE ?? "").trim();
  if (!appsChallenge && file) appsChallenge = readFileSync(file, "utf8").trim();
  return {
    enabled: isTruthy(env.SPICRAWL_CHATGPT_ENABLED),
    resource,
    issuer,
    introspectSecret: (env.SPICRAWL_OAUTH_INTROSPECT_SECRET ?? "").trim(),
    rootPrm: isTruthy(env.SPICRAWL_CHATGPT_ROOT_PRM),
    appsChallenge,
  };
}

/** Where the resource's metadata lives: `/.well-known/oauth-protected-resource` + the resource's path (RFC 9728 §3.1). */
export function prmPath(resource: string): string {
  const path = new URL(resource).pathname.replace(/\/+$/, "");
  return `/.well-known/oauth-protected-resource${path === "/" ? "" : path}`;
}

/** The metadata's absolute URL, as the challenge names it. */
export function prmURL(resource: string): string {
  return new URL(resource).origin + prmPath(resource);
}

/** The protected-resource metadata document (RFC 9728). */
export function protectedResourceMetadata(config: ChatgptConfig) {
  return {
    resource: config.resource,
    authorization_servers: [config.issuer],
    scopes_supported: [...SCOPES],
    resource_documentation: RESOURCE_DOCUMENTATION,
  };
}

/** A quoted-string parameter value: no quotes, backslashes or control characters. */
const quotable = (s: string) => s.replace(/["\\\u0000-\u001f\u007f]/g, " ");

/**
 * A `Bearer` challenge (RFC 6750 §3, RFC 9728 §5.1). Without `error` it is the
 * plain "authenticate here" answer to a request that sent no token.
 */
export function bearerChallenge(
  resource: string,
  opts: { scope?: string; error?: "invalid_token" | "insufficient_scope"; description?: string } = {},
): string {
  const parts = [`resource_metadata="${prmURL(resource)}"`, `scope="${quotable(opts.scope ?? SCOPES.join(" "))}"`];
  if (opts.error) parts.push(`error="${opts.error}"`);
  if (opts.error && opts.description) parts.push(`error_description="${quotable(opts.description)}"`);
  return `Bearer ${parts.join(", ")}`;
}

/** What an accepted token grants. */
export interface Grant {
  scopes: Set<string>;
  /** The project's API key the token stands for; the upstream calls run under it. Never logged. */
  apiKey: string;
  clientId?: string;
  /** Milliseconds since the epoch; undefined when the server sent no `exp`. */
  expiresAt?: number;
}

export type Introspection =
  | { ok: true; grant: Grant }
  | { ok: false; status: 401; description: string }
  | { ok: false; status: 503; description: string };

interface CacheEntry {
  grant: Grant;
  until: number;
}

const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

/**
 * Introspects access tokens at `<issuer>/api/oauth/introspect`, caching
 * positive answers by the token's SHA-256 for at most 30 s and never past the
 * token's expiry. A negative answer is never cached, so a token issued a moment
 * later is not refused from memory.
 */
export class Introspector {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly log: (...a: unknown[]) => void;

  constructor(
    private readonly config: Pick<ChatgptConfig, "issuer" | "resource" | "introspectSecret">,
    options: { log?: (...a: unknown[]) => void; now?: () => number } = {},
  ) {
    this.log = options.log ?? (() => {});
    if (options.now) this.now = options.now;
  }

  private now = () => Date.now();

  get endpoint(): string {
    return `${this.config.issuer}/api/oauth/introspect`;
  }

  /** Forgets a token, e.g. once the API refused the key it stood for. */
  forget(token: string): void {
    this.cache.delete(tokenHash(token));
  }

  async introspect(token: string): Promise<Introspection> {
    const key = tokenHash(token);
    const now = this.now();
    const hit = this.cache.get(key);
    if (hit) {
      if (hit.until > now) return { ok: true, grant: hit.grant };
      this.cache.delete(key);
    }

    if (!this.config.introspectSecret) {
      this.log("chatgpt: SPICRAWL_OAUTH_INTROSPECT_SECRET is not set; cannot verify access tokens");
      return { ok: false, status: 503, description: "token verification is not configured on this server" };
    }

    let res: Response;
    try {
      res = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.introspectSecret}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
          "User-Agent": USER_AGENT,
        },
        body: new URLSearchParams({ token }).toString(),
        signal: AbortSignal.timeout(INTROSPECT_TIMEOUT_MS),
      });
    } catch (err) {
      this.log("chatgpt: introspection unreachable:", err instanceof Error ? err.message : String(err));
      return { ok: false, status: 503, description: "could not reach the authorization server to verify the token" };
    }
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      // A refusal of OUR credential (401/403) or a server error says nothing about the caller's token.
      this.log(`chatgpt: introspection answered HTTP ${res.status}`);
      return { ok: false, status: 503, description: "the authorization server could not verify the token" };
    }
    let body: Record<string, unknown>;
    try {
      const parsed = JSON.parse(text) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      body = parsed as Record<string, unknown>;
    } catch {
      this.log("chatgpt: introspection answered a body that is not a JSON object");
      return { ok: false, status: 503, description: "the authorization server could not verify the token" };
    }

    if (body.active !== true) return { ok: false, status: 401, description: "The access token is invalid, expired or revoked" };
    if (body.aud !== this.config.resource) {
      return { ok: false, status: 401, description: "The access token was not issued for this resource" };
    }
    const exp = typeof body.exp === "number" && Number.isFinite(body.exp) ? body.exp * 1000 : undefined;
    if (exp !== undefined && exp <= now) return { ok: false, status: 401, description: "The access token has expired" };
    const apiKey = typeof body.api_key === "string" ? body.api_key : "";
    if (!KEY_RE.test(apiKey)) {
      this.log("chatgpt: an active token came back without a usable API credential");
      return { ok: false, status: 401, description: "The access token is not linked to a Spicrawl project" };
    }

    const grant: Grant = {
      scopes: new Set(typeof body.scope === "string" ? body.scope.split(/\s+/).filter(Boolean) : []),
      apiKey,
      clientId: typeof body.client_id === "string" ? body.client_id : undefined,
      expiresAt: exp,
    };
    const until = Math.min(now + CACHE_MAX_MS, exp ?? Infinity);
    if (this.cache.size >= CACHE_MAX_ENTRIES) this.evict(now);
    this.cache.set(key, { grant, until });
    return { ok: true, grant };
  }

  /** Drops expired entries, then the oldest ones, to stay under the cap. */
  private evict(now: number) {
    for (const [k, e] of this.cache) if (e.until <= now) this.cache.delete(k);
    for (const k of this.cache.keys()) {
      if (this.cache.size < CACHE_MAX_ENTRIES) break;
      this.cache.delete(k);
    }
  }
}
