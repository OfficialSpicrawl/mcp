/**
 * Thin client over the Spicrawl REST API.
 *
 * Every MCP tool ultimately calls one of these methods. The client owns three
 * things the tools should not each re-implement: authentication (the caller's
 * API key as a bearer token), the base URL, and turning the platform's RFC 7807
 * problem envelope into an actionable Error the agent can act on rather than a
 * bare HTTP status.
 */

import { createRequire } from "node:module";

/**
 * This package's version, read from package.json so the User-Agent, the MCP
 * server's advertised version and the published package cannot drift. The
 * path is relative to the compiled file (dist/client.js), and package.json
 * ships with every npm package regardless of `files`.
 */
export const PACKAGE_VERSION: string = (
  createRequire(import.meta.url)("../package.json") as { version: string }
).version;

/**
 * Sent on every API call. The API classifies the client surface from it
 * (cli / mcp / sdk / other) and records it on each request-log row, so MCP
 * traffic is countable. The product token must stay `spicrawl-mcp/`.
 */
export const USER_AGENT = `spicrawl-mcp/${PACKAGE_VERSION}`;

/** The public Spicrawl API; set SPICRAWL_BASE_URL for a self-hosted or local stack. */
const DEFAULT_BASE_URL = "https://api.spicrawl.com";
const DEFAULT_TIMEOUT_MS = 120_000;
/**
 * Where the public docs live when nothing in the environment says otherwise:
 * the root of their own host. llms.txt and the API's error doc_url links point
 * here, and spicrawl_docs_read only reads URLs on the docs origin.
 */
const DEFAULT_DOCS_URL = "https://docs.spicrawl.com";

const trimURL = (s: string | undefined) => (s ?? "").trim().replace(/\/+$/, "");
/** An origin that serves the docs under /docs (a self-hosted API, the legacy SPICRAWL_DOCS_HOST). */
const underDocs = (origin: string) => (origin.endsWith("/docs") ? origin : `${origin}/docs`);

/**
 * The docs base URL from the environment, no trailing slash; page paths are
 * appended to it directly (`<base>/errors`, `<base>/llms.txt`):
 *
 *   1. SPICRAWL_DOCS_URL, the full base (`https://docs.spicrawl.com`, or
 *      `http://host:8080/docs` on a self-hosted deployment);
 *   2. SPICRAWL_DOCS_HOST + `/docs`, the legacy origin-only setting, which keeps
 *      its old meaning so an existing env file does not silently change;
 *   3. a self-hosted API (SPICRAWL_PUBLIC_BASE_URL, else SPICRAWL_BASE_URL) +
 *      `/docs`, where every deployment serves its own docs;
 *   4. https://docs.spicrawl.com, also when that API is the public one.
 *
 * Read from the raw environment, not the client's baseURL, so a stdio server
 * with no base URL set points at the public docs rather than localhost.
 */
export function docsBaseFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const url = trimURL(env.SPICRAWL_DOCS_URL);
  if (url) return url;
  const host = trimURL(env.SPICRAWL_DOCS_HOST);
  if (host) return underDocs(host);
  const api = trimURL(env.SPICRAWL_PUBLIC_BASE_URL || env.SPICRAWL_BASE_URL);
  if (api && api.toLowerCase() !== DEFAULT_BASE_URL) return underDocs(api);
  return DEFAULT_DOCS_URL;
}

/** The RFC 7807 problem shape every Spicrawl error uses. */
interface Problem {
  code?: string;
  title?: string;
  detail?: string;
  status?: number;
  retryable?: boolean;
  target_status?: number | null;
  doc_url?: string;
}

/** A failed request, carrying the platform's own error code and guidance. */
export class ILayerError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  readonly docUrl?: string;

  constructor(status: number, problem: Problem, fallback: string) {
    const detail = problem.detail || problem.title || fallback;
    super(detail);
    this.name = "ILayerError";
    this.code = problem.code || `HTTP_${status}`;
    this.status = problem.status ?? status;
    this.retryable = problem.retryable ?? status >= 500;
    this.docUrl = problem.doc_url;
  }
}

export interface ClientConfig {
  baseURL?: string;
  /**
   * The API base URL as the MCP's USERS reach it, for URLs handed back to them
   * (the browser tool's CDP URL). Differs from baseURL when the MCP talks to
   * the API over loopback. Defaults to baseURL.
   */
  publicBaseURL?: string;
  apiKey: string;
  timeoutMs?: number;
  /**
   * The public docs base (`https://docs.spicrawl.com`, `http://host:8080/docs`)
   * the docs tools read from. Defaults to docsBaseFromEnv(). The API key is
   * never sent there.
   */
  docsBaseURL?: string;
}

export class ILayerClient {
  readonly baseURL: string;
  /** Base URL for URLs returned to the caller; never used for upstream calls. */
  readonly publicBaseURL: string;
  /** The caller's key. Read by tools that hand out URLs carrying it (browser). */
  readonly apiKey: string;
  /** Public docs base, e.g. https://docs.spicrawl.com; no trailing slash. */
  readonly docsBaseURL: string;
  private readonly timeoutMs: number;

  constructor(config: ClientConfig) {
    if (!config.apiKey) {
      throw new Error(
        "SPICRAWL_API_KEY is required. Set it to an Spicrawl API key (spicrawl_live_...) in the MCP server's environment.",
      );
    }
    this.baseURL = (config.baseURL || DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.publicBaseURL = (config.publicBaseURL || this.baseURL).replace(/\/+$/, "");
    this.apiKey = config.apiKey;
    this.docsBaseURL = (config.docsBaseURL || docsBaseFromEnv()).replace(/\/+$/, "");
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** POST /v1/scrape — retrieve, render, and extract one URL. */
  async scrape(params: Record<string, unknown>): Promise<unknown> {
    return this.request("POST", "/v1/scrape", params);
  }

  /** Any REST call. Tools for newer endpoints use this directly. */
  async request(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await fetch(`${this.baseURL}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: "application/json",
          "User-Agent": USER_AGENT,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(
          `Request to ${path} timed out after ${this.timeoutMs} ms. A render or batch may need a longer timeout, or the API at ${this.baseURL} is unreachable.`,
        );
      }
      throw new Error(
        `Could not reach the Spicrawl API at ${this.baseURL}${path}: ${
          err instanceof Error ? err.message : String(err)
        }. Check SPICRAWL_BASE_URL and that the server is running.`,
      );
    } finally {
      clearTimeout(timer);
    }

    // A PDF (`response_format=pdf`) is bytes: read as text it would be corrupted.
    if (response.ok && mediaType(response) === "application/pdf") return pdfPayload(response);

    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      // Not JSON: a scrape body (markdown/text/html) — or, on an error, a
      // gateway's page, which the check below still reports as a failure.
      parsed = response.ok || response.headers.get("x-engine") !== null ? { content: text } : { detail: text };
    }

    // A non-2xx status is only an error when the body is a platform problem.
    // With `original_status` the API relays the target's own status (a 404
    // page the caller allowed via `allowed_status_codes`) on a SUCCESSFUL
    // scrape, and that content must reach the agent, not be reported as a
    // failure.
    // A completed scrape always carries X-Engine; a gateway's error page does not.
    const relayedTargetStatus = response.headers.get("x-engine") !== null;
    const isProblem =
      typeof parsed === "object" && parsed !== null && typeof (parsed as Problem).code === "string";
    if (!response.ok && (isProblem || !relayedTargetStatus)) {
      throw new ILayerError(
        response.status,
        parsed as Problem,
        `Request failed with HTTP ${response.status}`,
      );
    }
    return parsed;
  }
}

/** The response's media type, lowercase, without parameters. */
function mediaType(response: Response): string {
  return (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
}

/**
 * A `response_format=pdf` scrape answers with the file itself, and the envelope's
 * fields as headers. The bytes come back base64 under `pdf`, with those fields
 * beside it, for the scrape tool to hand over as a resource block (tools/pdf.ts).
 */
async function pdfPayload(response: Response): Promise<Record<string, unknown>> {
  const bytes = Buffer.from(await response.arrayBuffer());
  const header = (name: string) => response.headers.get(name) ?? undefined;
  const number = (name: string) => {
    const v = header(name);
    return v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined;
  };
  const out: Record<string, unknown> = {
    pdf: { content_type: "application/pdf", size_bytes: bytes.length, encoding: "base64", data: bytes.toString("base64") },
  };
  const fields: Record<string, unknown> = {
    engine: header("x-engine"),
    status: number("x-target-status"),
    credits: number("x-credits-charged"),
    final_url: header("x-final-url"),
    // X-Request-Id is left out on purpose: a diagnostic identifier the caller did not ask for.
  };
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) out[k] = v;
  return out;
}
