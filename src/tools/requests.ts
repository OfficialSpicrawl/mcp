import { z } from "zod";
import { loose, run, type RegisterTools } from "./common.js";

// Request history: /v1/requests. Per-call records from the request log (Redis),
// retained only for the org's retention window. The key's own project needs any
// valid key; all_projects=true (every project in the org) and another project's
// request by id need the `read` scope.
// Not billing-grade: totals here need not match an invoice (use spicrawl_usage).

// One record of the request log (openapi.yaml: RequestLogEntry). Fields the API
// leaves out when zero or unknown are optional; spans are null when not measured.
const MS = z.number().nullish();
const ENTRY = {
  id: z.string().describe("The request id (X-Request-Id)."),
  created_at: z.string().optional().describe("When the request arrived, RFC 3339 UTC."),
  project_id: z.string().optional(),
  engine: z.string().optional().describe("The rendering tier that served it: fetch, js or browser. Absent when refused before a tier was chosen."),
  status: z.string().optional().describe("Terminal outcome: success, failed, timeout, blocked, rejected or cancelled. Only success is charged."),
  http_status: z.number().optional().describe("The target's HTTP status; absent when no response was received."),
  error_code: z.string().optional().describe("The problem code the caller got, e.g. ERR::UPSTREAM::CHALLENGE. Absent on success."),
  error_detail: z.string().optional(),
  attempts: z.number().optional().describe("Dispatch attempts including retries."),
  url: z.string().optional().describe("The target URL as requested."),
  url_host: z.string().optional(),
  proxy: loose({
    source: z.string().optional().describe("pool, custom or direct."),
    endpoint_id: z.string().optional(),
    provider: z.string().optional(),
    requested_tier: z.string().optional(),
    requested_country: z.string().optional(),
    country: z.string().optional().describe("Where the exit actually served from; compare with requested_country."),
    sticky: z.boolean().optional(),
    reason: z.string().optional(),
    endpoints: z.array(z.string()).nullish().describe("Every exit touched, in attempt order."),
  })
    .optional()
    .describe("What proxy was asked for versus what served. Never an exit IP or credentials."),
  spans: loose({
    admission_ms: MS,
    dispatch_ms: MS,
    worker_ms: MS,
    queue_ms: MS.describe("Wait for a slot; high means capacity shortage, not a slow page."),
    engine_ms: MS,
    upstream_ms: MS,
    extract_ms: MS,
    total_ms: MS,
  })
    .optional()
    .describe("Latency in milliseconds per stage; null means not measured. Stages do not sum to total_ms."),
  blocked: loose({
    vendor: z.string().optional(),
    signal: z.string().optional(),
    rule: z.string().optional(),
  })
    .optional()
    .describe("Present only when a bot challenge was detected."),
  bytes_in: z.number().optional(),
  bytes_out: z.number().optional(),
  proxy_bytes: z.number().optional(),
  credits_micro: z.number().optional().describe("Credits charged in micro-credits (1 credit = 1000000); 0 unless success."),
  features: z.record(z.string(), z.unknown()).optional().describe("Features the request used; free-form."),
};

// `data` and `page` are optional so a gateway or older server that words the
// list differently never fails the call; a real answer always carries both.
const LIST_OUTPUT = loose({
  data: z.array(loose(ENTRY)).optional().describe("Request records, newest first. Can be shorter than limit while page.has_more is true."),
  page: loose({
    retention_hours: z.number().optional().describe("How long records are kept; an empty data means nothing in this window."),
    retained_since: z.string().optional().describe("The oldest instant still readable."),
    has_more: z.boolean().optional().describe("True when more records may exist; continue with next_before and next_before_id."),
    next_before: z.string().optional().describe("Send back as before. Present only when has_more."),
    next_before_id: z.string().optional().describe("Send back as before_id. Present only when has_more."),
  })
    .optional()
    .describe("Paging cursor and the retention window."),
});

export const registerRequestsTools: RegisterTools = (server, client) => {
  server.registerTool(
    "spicrawl_requests_list",
    {
      title: "List recent requests",
      description:
        "Recent API calls in your key's project, newest first, each with project_id, status, engine, http_status, error_code/error_detail, attempts, URL, " +
        "proxy used, latency spans (queue/engine/upstream/total ms), block detection and credits. Use it to find failing calls (only_errors=true) or to spot " +
        "patterns across a target. all_projects=true lists every project in your organization instead (needs a key with the `read` scope; 403 " +
        "ERR::AUTH::INSUFFICIENT_SCOPE otherwise). Records only exist within the retention window reported in page.retention_hours / page.retained_since; " +
        "an empty page means nothing in that window. Paginate by passing page.next_before and page.next_before_id back as before and before_id while " +
        "page.has_more is true, keeping all_projects the same. Not billing-grade: use spicrawl_usage for totals.",
      inputSchema: {
        all_projects: z
          .boolean()
          .optional()
          .describe("Every project in your organization, not just the key's own. Needs the `read` scope. Keep it the same across pages."),
        limit: z.number().int().min(1).max(200).optional().describe("Rows per page, 1-200. Default 50."),
        status: z
          .enum(["success", "failed", "timeout", "blocked", "rejected", "cancelled"])
          .optional()
          .describe("Only requests with this outcome."),
        only_errors: z
          .boolean()
          .optional()
          .describe("Only requests whose status is anything other than 'success'."),
        before: z
          .string()
          .optional()
          .describe("Cursor: RFC 3339 timestamp, exactly as returned in page.next_before. Pass together with before_id."),
        before_id: z
          .string()
          .optional()
          .describe("Cursor: request id, exactly as returned in page.next_before_id."),
      },
      outputSchema: LIST_OUTPUT,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) =>
      run(() => {
        const qs = new URLSearchParams();
        if (args.all_projects) qs.set("all_projects", "true");
        if (args.limit !== undefined) qs.set("limit", String(args.limit));
        if (args.status) qs.set("status", args.status);
        if (args.only_errors) qs.set("only_errors", "true");
        if (args.before) qs.set("before", args.before);
        if (args.before_id) qs.set("before_id", args.before_id);
        const s = qs.toString();
        return client.request("GET", `/v1/requests${s ? `?${s}` : ""}`);
      }),
  );

  server.registerTool(
    "spicrawl_request_get",
    {
      title: "Get one request",
      description:
        "The full log record of one past API call by its request id. Every response carries its id in the X-Request-Id header (and error bodies " +
        "carry it too), so this is the tool for debugging a failed or slow scrape: it shows status, error_code/error_detail, attempts, the engine and " +
        "proxy (tier, country, provider, sticky) actually used, whether and how the target blocked it (vendor/signal/rule), per-stage latency spans " +
        "and credits charged. Returns not_found both for unknown ids and for ones older than your retention window, and for another project's request " +
        "unless your key has the `read` scope.",
      inputSchema: {
        id: z.string().min(1).describe("The request id (a ULID, from X-Request-Id or a spicrawl_requests_list row's `id`)."),
      },
      outputSchema: loose(ENTRY),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ id }) => run(() => client.request("GET", `/v1/requests/${encodeURIComponent(id)}`)),
  );
};
