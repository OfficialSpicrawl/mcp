import { z } from "zod";
import { run, type RegisterTools } from "./common.js";

// Request history: /v1/requests. Per-call records from the request log (Redis),
// retained only for the org's retention window. The key's own project needs any
// valid key; all_projects=true (every project in the org) and another project's
// request by id need the `read` scope.
// Not billing-grade: totals here need not match an invoice (use spicrawl_usage).
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
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ id }) => run(() => client.request("GET", `/v1/requests/${encodeURIComponent(id)}`)),
  );
};
