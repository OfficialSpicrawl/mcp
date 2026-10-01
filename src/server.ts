import { z } from "zod";
import { McpServer, type RegisteredTool, type ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AnySchema, ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { ILayerClient, PACKAGE_VERSION } from "./client.js";
import type { ToolOptions } from "./tools/common.js";
import { registerScrapeTools } from "./tools/scrape.js";
import { registerBatchTools } from "./tools/batch.js";
import { registerSessionsTools } from "./tools/sessions.js";
import { registerUsageTools } from "./tools/usage.js";
import { registerRequestsTools } from "./tools/requests.js";
import { registerBrowserTools } from "./tools/browser.js";
import { registerDocsTools } from "./tools/docs.js";

export const SERVER_NAME = "spicrawl-mcp-server";
export const SERVER_VERSION = PACKAGE_VERSION;

// ---------------------------------------------------------------------------
// Unknown arguments are refused, never dropped.
//
// zod's default object strips keys it does not know, so `js_render: true` (the
// REST name; the tool calls it `render`) used to become a silent plain fetch —
// the customer believes rendering is on and is billed for something else. The
// Spicrawl API refuses unknown fields for exactly this reason; the MCP layer must
// not bypass that. Every tool's top-level arguments are therefore a strict
// object: an unknown key fails validation with a message naming it (and the
// closest real argument), and tools/list advertises `additionalProperties:
// false`. Free-form maps inside a tool (headers, JSON Schemas, records) stay open.
// ---------------------------------------------------------------------------

/** Names an agent is likely to guess (REST / other-scraper spellings) -> the tool's name. */
const ALIASES: Record<string, string> = {
  js_render: "render",
  javascript: "render",
  response_format: "format",
  formats: "format",
  only_main_content: "main_content_only",
  onlyMainContent: "main_content_only",
  includeTags: "include_tags",
  excludeTags: "exclude_tags",
  waitFor: "wait_for",
  headers: "custom_headers",
  country: "proxy_country",
};

const normalise = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** The valid argument closest to `key`, if one is close enough to be a plausible typo. */
function closestArgument(key: string, valid: string[]): string | undefined {
  const alias = ALIASES[key];
  if (alias && valid.includes(alias)) return alias;
  const nk = normalise(key);
  // Candidates: every valid name, plus every alias whose target is valid (so a
  // typo of a REST name, e.g. `js_rendr`, still lands on `render`).
  const candidates: [spelling: string, target: string][] = valid.map((v) => [v, v]);
  for (const [a, target] of Object.entries(ALIASES)) if (valid.includes(target)) candidates.push([a, target]);
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const [spelling, target] of candidates) {
    const d = levenshtein(nk, normalise(spelling));
    if (d < bestDistance) [best, bestDistance] = [target, d];
  }
  return bestDistance <= Math.max(1, Math.floor(nk.length / 3)) ? best : undefined;
}

function unknownArgumentsMessage(keys: string[], valid: string[]): string {
  let unresolved = false;
  const parts = keys.map((k) => {
    const s = closestArgument(k, valid);
    if (!s) unresolved = true;
    return s ? `unknown argument \`${k}\`; did you mean \`${s}\`?` : `unknown argument \`${k}\``;
  });
  let msg = parts.join("; ");
  if (unresolved) {
    msg += valid.length
      ? ` (valid arguments: ${valid.map((v) => `\`${v}\``).join(", ")})`
      : " (this tool takes no arguments)";
  }
  return msg;
}

/**
 * Wraps a raw zod shape into a strict object: unknown keys are a validation
 * error naming them (with a did-you-mean), and the JSON Schema carries
 * `additionalProperties: false`. Descriptions and defaults are untouched.
 */
export function strictArgs<T extends z.ZodRawShape>(shape: T) {
  const valid = Object.keys(shape);
  const errorMap: z.ZodErrorMap = (issue, ctx) =>
    issue.code === z.ZodIssueCode.unrecognized_keys
      ? { message: unknownArgumentsMessage(issue.keys, valid) }
      : { message: ctx.defaultError };
  return z.object(shape, { errorMap }).strict();
}

/** Makes a registerTool inputSchema strict: raw shapes and non-strict zod objects. */
function strictInputSchema(schema: ZodRawShapeCompat | AnySchema | undefined): ZodRawShapeCompat | AnySchema | undefined {
  if (schema === undefined) return undefined; // no schema -> SDK passes no args at all
  if (schema instanceof z.ZodObject) {
    return schema._def.unknownKeys === "strip" ? strictArgs(schema.shape) : schema;
  }
  const isSchemaInstance = "_def" in schema || "_zod" in schema;
  return isSchemaInstance ? schema : strictArgs(schema as z.ZodRawShape);
}

/**
 * The annotations every tool must state. MCP leaves all of them optional and a client
 * then assumes the worst for a missing one (not read-only, destructive, open-world),
 * while directories such as OpenAI's plugin review require each to be an explicit
 * boolean. Typing them as required here makes a tool without them a compile error;
 * test/annotations.test.mjs pins each tool's actual values.
 */
export type RequiredToolAnnotations = ToolAnnotations & {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  openWorldHint: boolean;
};

/**
 * McpServer whose registerTool makes every tool's input schema strict, and requires
 * a human-readable title and the explicit annotations. Tools keep declaring plain
 * raw shapes; this one place guarantees none of them (or any tool added later) can
 * silently drop an argument or ship without its hints.
 */
export class SpicrawlMcpServer extends McpServer {
  override registerTool<
    OutputArgs extends ZodRawShapeCompat | AnySchema,
    InputArgs extends undefined | ZodRawShapeCompat | AnySchema = undefined,
  >(
    name: string,
    config: {
      title: string;
      description?: string;
      inputSchema?: InputArgs;
      outputSchema?: OutputArgs;
      annotations: RequiredToolAnnotations;
      _meta?: Record<string, unknown>;
    },
    cb: ToolCallback<InputArgs>,
  ): RegisteredTool {
    // The strict object parses to exactly what the raw shape did, so the
    // callback's argument type is unchanged; only the declared type widens.
    return super.registerTool(
      name,
      { ...config, inputSchema: strictInputSchema(config.inputSchema) as InputArgs },
      cb,
    );
  }
}

/** Environment values read as "on": `1`, `true`, `yes` or `on`, in any case. */
const TRUTHY = /^(1|true|yes|on)$/i;

/**
 * SPICRAWL_MCP_HIDE_UNAVAILABLE: whether to leave out what is announced but not
 * available yet. Off by default, so the tool list does not change unless an operator asks.
 */
export function hideUnavailableFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return TRUTHY.test((env.SPICRAWL_MCP_HIDE_UNAVAILABLE ?? "").trim());
}

export interface ServerOptions {
  /**
   * Leave out `spicrawl_browser_connect_url` (it always fails until remote browsers
   * ship) and every argument whose description starts with the coming-soon marker
   * (`ai_extract`, `stealth`, `premium_proxy`, ...), so the server lists only what works.
   * Default: SPICRAWL_MCP_HIDE_UNAVAILABLE.
   */
  hideUnavailable?: boolean;
}

/**
 * One MCP server bound to one caller's API key. The stdio entry builds one for
 * the process; the HTTP entry builds one per session, from that session's key.
 */
export function buildServer(client: ILayerClient, options: ServerOptions = {}): McpServer {
  const toolOptions: ToolOptions = { hideUnavailable: options.hideUnavailable ?? hideUnavailableFromEnv() };
  const server = new SpicrawlMcpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  for (const register of [
    registerScrapeTools,
    registerBatchTools,
    registerSessionsTools,
    registerUsageTools,
    registerRequestsTools,
    registerBrowserTools,
    registerDocsTools,
  ]) {
    register(server, client, toolOptions);
  }
  return server;
}
