import type { z } from "zod";
import { ILayerClient, ILayerError } from "../client.js";
import type { SpicrawlMcpServer } from "../server.js";

/** How the server was asked to present itself; every tools module receives the same value. */
export interface ToolOptions {
  /**
   * Leave out what is announced but not available yet (SPICRAWL_MCP_HIDE_UNAVAILABLE):
   * the browser tool, and every argument marked {@link COMING_SOON}.
   */
  hideUnavailable: boolean;
}

/** Every tools module exports one of these; server.ts calls them all. */
export type RegisterTools = (server: SpicrawlMcpServer, client: ILayerClient, options: ToolOptions) => void;

/**
 * Leads the description of an argument for a feature that is not available yet (the
 * docs' "Coming soon" badge). The schema still accepts it, so nothing breaks the day it
 * ships; the words tell an agent not to send it now.
 */
export const COMING_SOON = "Coming soon: not available yet, do not send. ";

/**
 * A tool's argument shape without the arguments marked {@link COMING_SOON}, when
 * `hide` is set; the shape itself otherwise. The marker is the one source of truth for
 * "not available yet", so a new coming-soon argument is hidden by writing its description
 * the way every other one is.
 *
 * The return type stays the full shape on purpose: handlers read the hidden arguments
 * as optional and see `undefined`, exactly as when a caller leaves them out.
 */
export function availableOnly<T extends z.ZodRawShape>(shape: T, hide: boolean): T {
  if (!hide) return shape;
  return Object.fromEntries(
    Object.entries(shape).filter(([, schema]) => !schema.description?.startsWith(COMING_SOON)),
  ) as T;
}

export type ImageBlock = { type: "image"; data: string; mimeType: string };

/** A file handed to the model host whole, such as a printed PDF (an MCP embedded resource). */
export type ResourceBlock = { type: "resource"; resource: { uri: string; mimeType: string; blob: string } };

/** A payload with some of its parts lifted out into image or resource blocks. */
export type Attached = { data: unknown; blocks: (ImageBlock | ResourceBlock)[] };

/**
 * Wraps a tool body so any ILayerError becomes an actionable MCP error result.
 *
 * `attach` lets a tool lift binary parts (screenshots, a PDF) out of the payload
 * into image or resource blocks placed after the text; the shaping below then
 * applies to what is left, so a tool that passes none behaves exactly as before.
 */
export async function run(
  fn: () => Promise<unknown>,
  attach?: (data: unknown) => Attached,
  argNames?: Record<string, string>,
) {
  const rename = (text: string) => (argNames ? renameArgs(text, argNames) : text);
  try {
    const { data, blocks } = attach ? attach(await fn()) : { data: await fn(), blocks: [] as Attached["blocks"] };
    if (argNames && isPlainObject(data) && Array.isArray(data.warnings)) {
      data.warnings = data.warnings.map((w) => (typeof w === "string" ? rename(w) : w));
    }
    // MCP requires structuredContent to be a JSON object; an array, string or
    // null there makes the client reject the whole result (-32602). Some
    // endpoints (a batch item's stored payload) return exactly those, so only
    // objects get it. No tool declares an outputSchema, so omitting it is legal.
    if (isPlainObject(data)) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }, ...blocks],
        structuredContent: data,
      };
    }
    // A string is usually markdown or HTML: stringifying it would hand the agent
    // one quoted line of escaped newlines instead of the document.
    const text = typeof data === "string" ? data : (JSON.stringify(data, null, 2) ?? "");
    return { content: [{ type: "text" as const, text }, ...blocks] };
  } catch (err) {
    const message =
      err instanceof ILayerError
        ? `${err.code}: ${err.message}${err.retryable ? " (retryable — the same request may succeed on a retry)" : ""}${
            err.docUrl ? `\nSee ${err.docUrl}` : ""
          }`
        : err instanceof Error
          ? err.message
          : String(err);
    return {
      isError: true,
      content: [{ type: "text" as const, text: rename(message) }],
    };
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Rewrite API parameter names to the tool's argument names, as whole
 * identifiers only: `js_render` becomes `render`, but `js_render_budget` or a
 * URL containing the word is left alone.
 */
export function renameArgs(text: string, names: Record<string, string>): string {
  let out = text;
  for (const [api, arg] of Object.entries(names)) {
    out = out.replace(new RegExp(`(?<![A-Za-z0-9_/.-])${api}(?![A-Za-z0-9_])`, "g"), arg);
  }
  return out;
}
