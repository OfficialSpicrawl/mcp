import { z } from "zod";
import { COMING_SOON, availableOnly, loose, run, type RegisterTools } from "./common.js";

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

// The rendering tiers a session can be bound to (the API's public names).
const engines = ["fetch", "js", "browser"] as const;

// Output shapes (structuredContent). Loose and mostly optional: the API may add fields, and a
// session in another state omits some (a released one has `context: null`, no `lease`).
const ts = (what: string) => z.string().optional().describe(`${what}, RFC 3339 UTC.`);

const domainScores = z
  .record(
    loose({
      score: z.number().optional().describe("Error score; rises on failures, decays on successes. Blocked at 3."),
      good: z.number().int().optional().describe("Successful requests counted."),
      bad: z.number().int().optional().describe("Failed requests counted."),
      last_updated: z.number().optional().describe("Last update, Unix milliseconds."),
      retired: z.boolean().optional().describe("Hard block for this domain; use a new session for it."),
    }),
  )
  .optional()
  .describe("Per-domain standing, keyed by domain. Omitted when empty.");

const sessionOut = loose({
  id: z.string().describe("Session id; pass it as `session_id` to spicrawl_scrape."),
  project_id: z.string().optional().describe("Project the session belongs to."),
  // Plain strings, not enums: a client rejects a result that fails its outputSchema, so a value the API adds later must not break the call.
  engine: z.string().optional().describe("Rendering tier the session is bound to: fetch, js or browser."),
  status: z.string().optional().describe("active, released or expired; derived from the clock, and only `active` sessions can be used."),
  sticky_key: z.string().optional().describe("Exit pin in use (empty when rotate_ip was set)."),
  proxy: loose({
    tier: z.string().optional().describe("Exit tier: datacenter or residential."),
    country: z.string().optional().describe("Lowercase alpha-2 exit country, when one was requested."),
    region_pool: z.string().optional().describe("Regional pool requested at creation."),
  })
    .optional()
    .describe("The session's exit intent (never an IP or endpoint)."),
  created_at: ts("Creation time"),
  last_used_at: z.string().nullish().describe("Last successful scrape, RFC 3339 UTC; null if never used."),
  expires_at: ts("Current expiry (slides on use)"),
  hard_expires_at: ts("Fixed ceiling the expiry never passes"),
  released_at: ts("Release time, on released sessions"),
  usage_count: z.number().int().optional().describe("Successful scrapes that used the session."),
  context: loose({
    schema_version: z.number().int().optional(),
    cookies: z.number().int().optional().describe("Cookies stored."),
    origins: z.number().int().optional().describe("Distinct origins with stored web storage."),
    bytes: z.number().int().optional().describe("Serialised size of the stored context."),
  })
    .nullish()
    .describe("Size summary of the stored context (counts only, no secrets); null once the session is not active."),
  retired: z.string().optional().describe("Why the session was taken out of service (expired, usage_exhausted, explicit); absent while usable."),
  domain_scores: domainScores,
  fingerprint: z.record(z.unknown()).optional().describe("Browser fingerprint, as stored."),
  lease: loose({
    holder: z.string().optional(),
    expires_at: ts("When the lease lapses at the latest"),
  })
    .optional()
    .describe("Present only while a scrape holds the session; release and delete are refused until it lapses unless `force`."),
  warnings: z.array(z.string()).optional().describe("Decisions made on your behalf at creation, e.g. a TTL reduced to the organization maximum."),
});

const sessionListOut = loose({
  sessions: z.array(sessionOut).describe("Sessions on this page, newest first; may be short or empty under a `status` filter."),
  next_cursor: z.string().optional().describe("Pass back as `cursor` for the next page; absent on the last page."),
});

const sessionContextOut = loose({
  session_id: z.string().describe("The session id."),
  schema_version: z.number().int().optional(),
  session_context: loose({
    cookies: z.array(loose({ name: z.string().optional(), value: z.string().optional(), domain: z.string().optional() })).optional(),
    local_storage: z.record(z.unknown()).optional().describe("Origin to key/value map."),
    session_storage: z.record(z.unknown()).optional().describe("Origin to key/value map."),
    indexed_db: z.record(z.unknown()).optional().describe("Origin to databases; opaque."),
  })
    .optional()
    .describe("Cookies and storage: secrets. Pass it as `session_context` to spicrawl_session_create to clone the session."),
  fingerprint: z.record(z.unknown()).nullish().describe("Stored browser fingerprint; null when none."),
  domain_scores: domainScores,
  retired: z.string().optional().describe("Why the session was retired; absent while usable."),
  usage_count: z.number().int().optional(),
  created_at: ts("Creation time"),
  last_used_at: z.string().nullish().describe("Last use, RFC 3339 UTC; null if never used."),
  expires_at: ts("Current expiry"),
  warning: z.string().optional().describe("The API's reminder that this state dies with the session."),
});

const sessionDeletedOut = loose({
  deleted: z.boolean().describe("Always true on success (deleting an already-deleted session succeeds)."),
  session_id: z.string().describe("The id that was deleted."),
});

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
        "Create a session: a persistent browser identity (cookie jar, localStorage, a fixed rendering tier and, by default, a " +
        "sticky exit IP) that survives across scrapes. Use it for multi-step flows — log in, then fetch pages behind " +
        "the login — by passing the returned `id` as `session_id` to every `spicrawl_scrape` call that should share the " +
        "state. The rendering tier is fixed for the session's lifetime and every scrape on the session runs on it. Leave " +
        "`engine` out and one is chosen for you. Release the session with `spicrawl_session_release` when done. " +
        "Returns the session object (id, engine, status, sticky_key, proxy, expires_at).",
      inputSchema: availableOnly({
        engine: z
          .enum(engines)
          .optional()
          .describe("Rendering tier fixed for the session's lifetime. Optional: leave it out and one is chosen for you. `fetch` is plain HTTP; `js` is JavaScript rendering and refuses `actions`, `block_resources`, screenshots and PDFs; `browser` is a full browser."),
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
          .describe(COMING_SOON + "Browser fingerprint pin, stored verbatim. Needs a full-browser session (`engine: \"browser\"`)."),
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
      outputSchema: sessionOut,
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
        engine: z.enum(engines).optional().describe("Only sessions on this rendering tier."),
        limit: z.number().int().min(1).max(200).optional().describe("Page size (default 50, max 200)."),
        cursor: z.string().optional().describe("`next_cursor` from a previous page, verbatim."),
      },
      outputSchema: sessionListOut,
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
        "Return one session's metadata: status, `engine` (its rendering tier), proxy/exit, usage count, expiry, lease holder, and a summary " +
        "of its stored context. Never returns the credentials themselves (use spicrawl_session_context for that).",
      inputSchema: { session_id: sessionId },
      outputSchema: sessionOut,
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
      outputSchema: sessionContextOut,
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
      outputSchema: sessionOut,
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
      outputSchema: sessionDeletedOut,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ session_id, force }) =>
      run(async () => {
        await client.request("DELETE", withQuery(sessionPath(session_id), { force }));
        return { deleted: true, session_id };
      }),
  );
};
