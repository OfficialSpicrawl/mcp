import { z } from "zod";
import { run, type RegisterTools } from "./common.js";

// Usage analytics: /v1/usage, /v1/usage/summary, /v1/usage/reconciliation.
// All three require the API key to carry the `read` scope (not in the default
// key scopes {scrape, batch, sessions}); without it the API answers 403.
const METRICS = [
  "requests",
  "credits",
  "engine_ms",
  "bytes_egress",
  "bytes_ingress",
  "proxy_bytes_dc",
  "proxy_bytes_resi",
  "extractions",
  "ai_extractions",
  "batch_items",
  "requests_failed",
  "requests_timeout",
  "feature_actions",
  "feature_ai_extract",
  "feature_autoparse",
  "feature_extract",
  "feature_extract_preset",
  "feature_js_render",
  "feature_links",
  "feature_network_capture",
  "feature_pdf",
  "feature_proxy_country",
  "feature_proxy_custom",
  "feature_screenshot",
  "feature_session",
  "client_cli",
  "client_mcp",
  "client_sdk",
  "client_other",
] as const;

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");

export const registerUsageTools: RegisterTools = (server, client) => {
  server.registerTool(
    "spicrawl_usage",
    {
      title: "Usage breakdown",
      description:
        "Billing-grade usage for your org over a date window, from the daily rollup (usage_daily), grouped by day, project, engine, feature or key. group_by=key returns per API key (key_id, name, prefix, project_id) counters per metric per day, " +
        "from usage_key_daily; keyless (dashboard) usage is not in it, and a project-scoped key sees only its own project's keys. " +
        "Use it to answer 'how many requests/credits did I use, and where'. The window defaults to the last 30 days including today; `to` is EXCLUSIVE " +
        "(a single day 2026-08-01 is from=2026-08-01, to=2026-08-02) and the window may not exceed 400 days. The response carries stale_seconds " +
        "(age of the newest rollup row; null when the window is empty). Requires the key to have the `read` scope.",
      inputSchema: {
        from: DATE.optional().describe("Inclusive start date, YYYY-MM-DD (UTC). Default: 29 days before today."),
        to: DATE.optional().describe("EXCLUSIVE end date, YYYY-MM-DD (UTC). Default: tomorrow, so today is included."),
        group_by: z
          .enum(["day", "project", "engine", "feature", "key"])
          .optional()
          .describe("How to group the rows. Default 'day'."),
        project_id: z.string().optional().describe("Restrict to one project id (must be a valid Spicrawl identifier)."),
        metrics: z
          .array(z.enum(METRICS))
          .optional()
          .describe("Metrics to return. Omit for all of them."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) =>
      run(() => {
        const qs = new URLSearchParams();
        if (args.from) qs.set("from", args.from);
        if (args.to) qs.set("to", args.to);
        if (args.group_by) qs.set("group_by", args.group_by);
        if (args.project_id) qs.set("project_id", args.project_id);
        if (args.metrics?.length) qs.set("metrics", args.metrics.join(","));
        const s = qs.toString();
        return client.request("GET", `/v1/usage${s ? `?${s}` : ""}`);
      }),
  );

  server.registerTool(
    "spicrawl_usage_summary",
    {
      title: "Usage summary",
      description:
        "A compact current-period summary of your org's usage (totals as of now, from the daily rollup). No parameters. " +
        "Use for a quick 'how much have I used so far'; use spicrawl_usage for a windowed breakdown. Requires the `read` scope.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => run(() => client.request("GET", "/v1/usage/summary")),
  );

  server.registerTool(
    "spicrawl_usage_reconciliation",
    {
      title: "Usage reconciliation",
      description:
        "Drift report for ONE day: re-derives usage from that day's request log and compares it with the billed daily rollup, so you can see whether " +
        "the rollup missed or double-counted anything. Defaults to yesterday (UTC); today is still accumulating and would always show drift. " +
        "Requires the `read` scope.",
      inputSchema: {
        day: DATE.optional().describe("The UTC day to reconcile, YYYY-MM-DD. Default: yesterday."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ day }) =>
      run(() =>
        client.request("GET", `/v1/usage/reconciliation${day ? `?day=${encodeURIComponent(day)}` : ""}`),
      ),
  );
};
