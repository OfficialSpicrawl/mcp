import { z } from "zod";
import { COMING_SOON, availableOnly, run, type RegisterTools } from "./common.js";

const sessionPath = (id: string) => `/v1/sessions/${encodeURIComponent(id)}`;

function withQuery(path: string, q: Record<string, string | number | boolean | undefined>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined) params.set(k, String(v));
  const s = params.toString();
  return s ? `${path}?${s}` : path;
}

const sessionId = z.string().min(1).describe("The session id returned by spicrawl_session_create or spicrawl_session_list.");
const force = z
  .boolean()
  .optional()
  .describe("Break an active lease (a scrape currently using the session). Only set when you know it is safe.");

const engines = ["fetch", "obscura", "chromium", "camoufox"] as const;

// Sessions: /v1/sessions.
export const registerSessionsTools: RegisterTools = (server, client, { hideUnavailable }) => {
  // -------------------------------------------------------------------------
  // spicrawl_session_create — POST /v1/sessions
  // -------------------------------------------------------------------------
  server.registerTool(
    "spicrawl_session_create",
    {
      title: "Create a browsing session",
      description:
        "Create a session: a persistent browser identity (cookie jar, localStorage, pinned engine and, by default, a " +
        "sticky exit IP) that survives across scrapes. Use it for multi-step flows — log in, then fetch pages behind " +
        "the login — by passing the returned `id` as `session_id` to every `spicrawl_scrape` call that should share the " +
        "state. The engine is pinned for the session's lifetime. Without `engine`, the server picks one this deployment " +
        "runs: `obscura`, else `chromium`, else `fetch`. Release the session with `spicrawl_session_release` when done. " +
        "Returns the session object (id, engine, status, sticky_key, proxy, expires_at).",
      inputSchema: availableOnly({
        engine: z
          .enum(engines)
          .optional()
          .describe("Engine pinned for the session's lifetime. Default: `obscura` if deployed, else `chromium`, else `fetch`. `camoufox` is coming soon: do not pin it yet."),
        ttl_seconds: z
          .number()
          .int()
          .min(30)
          .optional()
          .describe("Idle lifetime in seconds (min 30, default 1800; the organization's maximum is enforced, not clamped)."),
        sticky_key: z
          .string()
          .optional()
          .describe(COMING_SOON + "Pin the managed-pool exit IP to this key; sessions sharing a key share an exit. Cannot combine with rotate_ip."),
        rotate_ip: z
          .boolean()
          .optional()
          .describe(COMING_SOON + "Keep the cookie jar stable but rotate the managed-pool exit IP per request. Cannot combine with sticky_key."),
        region_pool: z.string().optional().describe(COMING_SOON + "Managed-pool region to draw the exit from."),
        premium_proxy: z.boolean().optional().describe(COMING_SOON + "Use a residential managed-pool exit, exactly as on spicrawl_scrape."),
        proxy_country: z
          .string()
          .length(2)
          .optional()
          .describe(COMING_SOON + "ISO-3166 alpha-2 exit country; requires premium_proxy."),
        fingerprint: z
          .record(z.unknown())
          .optional()
          .describe(COMING_SOON + "Camoufox fingerprint pin, stored verbatim. Only valid with engine `camoufox`."),
        domain_scores: z
          .record(
            z.object({
              score: z.number(),
              good: z.number().int(),
              bad: z.number().int(),
              last_updated: z.number().int(),
            }).passthrough(),
          )
          .optional()
          .describe("Seed per-domain error scores (usually copied from a spicrawl_session_context dump)."),
        session_context: z
          .record(z.unknown())
          .optional()
          .describe(
            "Seed the session's state (cookies, storage) — e.g. the `session_context` object from spicrawl_session_context, to clone a session.",
          ),
      }, hideUnavailable),
      // Creates a persistent record in the user's own account; nothing outside it is contacted.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input) => {
      const body: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(input)) if (v !== undefined) body[k] = v;
      return run(() => client.request("POST", "/v1/sessions", body));
    },
  );

  // -------------------------------------------------------------------------
  // spicrawl_session_list — GET /v1/sessions
  // -------------------------------------------------------------------------
  server.registerTool(
    "spicrawl_session_list",
    {
      title: "List sessions",
      description:
        "List this API key's project's sessions, newest first. Returns `{ sessions: [...], next_cursor? }`; pass " +
        "`next_cursor` back as `cursor` for the next page. Never includes the stored credentials.",
      inputSchema: {
        status: z.enum(["active", "released", "expired"]).optional().describe("Only sessions in this state."),
        engine: z.enum(engines).optional().describe("Only sessions pinned to this engine."),
        limit: z.number().int().min(1).max(200).optional().describe("Page size (default 50, max 200)."),
        cursor: z.string().optional().describe("`next_cursor` from a previous page, verbatim."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ status, engine, limit, cursor }) =>
      run(() => client.request("GET", withQuery("/v1/sessions", { status, engine, limit, cursor }))),
  );

  // -------------------------------------------------------------------------
  // spicrawl_session_get — GET /v1/sessions/{id}
  // -------------------------------------------------------------------------
  server.registerTool(
    "spicrawl_session_get",
    {
      title: "Get a session",
      description:
        "Return one session's metadata: status, engine, proxy/exit, usage count, expiry, lease holder, and a summary " +
        "of its stored context. Never returns the credentials themselves (use spicrawl_session_context for that).",
      inputSchema: { session_id: sessionId },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ session_id }) => run(() => client.request("GET", sessionPath(session_id))),
  );

  // -------------------------------------------------------------------------
  // spicrawl_session_context — GET /v1/sessions/{id}/context
  // -------------------------------------------------------------------------
  server.registerTool(
    "spicrawl_session_context",
    {
      title: "Dump a session's stored context",
      description:
        "Return the full stored state of a LIVE session — cookies, localStorage and other credentials — plus its " +
        "fingerprint and domain scores. The `session_context` object can be passed to spicrawl_session_create to clone " +
        "the session. The result contains secrets (login cookies): do not echo it to the user or logs unless asked.",
      inputSchema: { session_id: sessionId },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ session_id }) => run(() => client.request("GET", `${sessionPath(session_id)}/context`)),
  );

  // -------------------------------------------------------------------------
  // spicrawl_session_release — POST /v1/sessions/{id}/release
  // -------------------------------------------------------------------------
  server.registerTool(
    "spicrawl_session_release",
    {
      title: "Release a session",
      description:
        "End a session when you are done with it: frees its exit IP and browser state; it can no longer be used with " +
        "spicrawl_scrape. Its stored cookies and storage are purged and cannot be recovered; start a new session and log in again to continue. " +
        "The record stays visible (status `released`) so its history can still be inspected. " +
        "Refused while a scrape holds the session's lease unless `force` is true. Returns the session object.",
      inputSchema: { session_id: sessionId, force },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ session_id, force }) =>
      run(() => client.request("POST", withQuery(`${sessionPath(session_id)}/release`, { force }))),
  );

  // -------------------------------------------------------------------------
  // spicrawl_session_delete — DELETE /v1/sessions/{id}
  // -------------------------------------------------------------------------
  server.registerTool(
    "spicrawl_session_delete",
    {
      title: "Delete a session",
      description:
        "Permanently delete a session and its stored state, including the record itself (prefer spicrawl_session_release " +
        "if you only want to stop using it). Idempotent: deleting an already-deleted session succeeds. Refused while a " +
        "scrape holds the session's lease unless `force` is true.",
      inputSchema: { session_id: sessionId, force },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ session_id, force }) =>
      run(async () => {
        await client.request("DELETE", withQuery(sessionPath(session_id), { force }));
        return { deleted: true, session_id };
      }),
  );
};
