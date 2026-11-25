/**
 * Which tools a session is offered. A partner key (a platform that resells
 * Spicrawl to its own users) gets the partner tools and the docs tools only:
 * the scrape, batch, session and browser tools would answer 403 for it. Any
 * other key, and any key whose answer cannot be read, gets the standard set.
 */

import type { ILayerClient } from "./client.js";

export type ToolProfile = "standard" | "partner";

/** The fields of GET /v1/key this server reads. */
export interface KeyInfo {
  partner?: unknown;
  scopes?: unknown;
}

/** How long the key check may take before a session falls back to the standard tools. */
export const KEY_INFO_TIMEOUT_MS = 5_000;

/**
 * `partner` only when the API says the key is a partner key and it carries the
 * `partner` scope. Pure, so the rule can be tested without a server.
 */
export function toolProfile(info: KeyInfo | null | undefined): ToolProfile {
  const scopes = info && Array.isArray(info.scopes) ? info.scopes : [];
  return info?.partner === true && scopes.includes("partner") ? "partner" : "standard";
}

/**
 * The scopes the key holds, as GET /v1/key lists them. Empty when the answer is missing.
 * Decides which optional groups (webhooks, monitors) a session is offered.
 */
export function keyScopes(info: KeyInfo | null | undefined): string[] {
  return info && Array.isArray(info.scopes) ? info.scopes.filter((s): s is string => typeof s === "string") : [];
}

/**
 * GET /v1/key for the client's key, or null when it cannot be answered: an older
 * API without the route, an error, or no answer within KEY_INFO_TIMEOUT_MS.
 * Asked once per session; nothing is cached beyond it.
 */
export async function keyInfo(client: ILayerClient): Promise<KeyInfo | null> {
  try {
    const info = await client.request("GET", "/v1/key", undefined, { timeoutMs: KEY_INFO_TIMEOUT_MS });
    return typeof info === "object" && info !== null ? (info as KeyInfo) : null;
  } catch {
    return null;
  }
}
