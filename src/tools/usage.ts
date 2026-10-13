import { z } from "zod";
import { loose, run, type RegisterTools } from "./common.js";

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

// What the three endpoints answer (openapi.yaml: UsageBreakdown, UsageByKey,
// UsageSummary, UsageReconciliation). Metric names are open-ended ("new metrics
// may appear as map keys"), so a metric map is a record, not a fixed list.
const METRIC_MAP = z
  .record(z.string(), z.number())
  .nullish()
  .describe("Metric name -> quantity. credits are micro-credits (1 credit = 1000000), engine_ms milliseconds, bytes_* bytes, the rest counts.");

const PERIOD = loose({
  start: z.string().optional().describe("First UTC day, inclusive (YYYY-MM-DD)."),
  end: z.string().optional().describe("End UTC day, EXCLUSIVE (YYYY-MM-DD)."),
  days: z.number().optional(),
  bounds: z.string().optional().describe("Always '[start, end)'."),
}).optional().describe("The window, as a half-open range of UTC days.");

const USAGE_AS_OF = z.string().nullish().describe("When the newest rollup row in the window was written; null when the window is empty.");
const STALE_SECONDS = z.number().nullish().describe("Age of usage_as_of in seconds; null when the window is empty. A large value means the rollup is behind.");
const WARNINGS = z.array(z.string()).optional().describe("Caveats the numbers would otherwise hide.");

const USAGE_OUTPUT = loose({
  period: PERIOD,
  group_by: z.string().optional().describe("The dimension used: day, project, engine, feature or key."),
  groups: z
    .array(
      loose({
        key: z.string().describe("The bucket: a YYYY-MM-DD day, a project id, an engine tier (fetch, js or browser) or a feature (extract, ai_extract, proxy_datacenter, proxy_residential, batch)."),
        label: z.string().optional().describe("Human label for an engine tier."),
        metrics: METRIC_MAP,
      }),
    )
    .nullish()
    .describe("The buckets, sorted by key. Empty (or missing for group_by=key) does not mean no usage: read totals."),
  totals: METRIC_MAP.optional().describe("Billed quantities for the whole window. Authoritative; use these, not the sum of groups."),
  unattributed: METRIC_MAP.optional().describe("The part of each total the groups do not explain."),
  keys: z
    .array(
      loose({
        key_id: z.string(),
        name: z.string().optional(),
        prefix: z.string().optional().describe("Display prefix of the API key, never the secret."),
        project_id: z.string().optional(),
        revoked: z.boolean().optional(),
        days: z.array(loose({ day: z.string(), metrics: METRIC_MAP })).nullish(),
        totals: METRIC_MAP.optional(),
      }),
    )
    .nullish()
    .describe("group_by=key only: one entry per API key, with its counters per UTC day."),
  usage_as_of: USAGE_AS_OF,
  stale_seconds: STALE_SECONDS,
  warnings: WARNINGS,
});

const SUMMARY_OUTPUT = loose({
  period: PERIOD,
  period_elapsed_days: z.number().optional().describe("Whole days of the period elapsed; use it to pace consumption."),
  plan: loose({
    code: z.string().optional(),
    name: z.string().optional(),
    version: z.number().optional(),
    subscription_status: z.string().optional().describe("'none' when no subscription covers now (the free plan)."),
    period_source: z.string().optional().describe("'subscription' (billing period) or 'allowance_month'."),
  }).optional(),
  credits: loose({
    included_micro: z.number().optional(),
    used_micro: z.number().optional().describe("Credits spent so far, from the usage rollup; excludes credits held for in-flight work."),
    remaining_micro: z.number().optional(),
    overage_micro: z.number().optional(),
    overage_micro_cents_per_credit: z.number().optional(),
    used_basis_points: z.number().nullish().describe("Used / included in basis points (10000 = 100%); null when nothing is included."),
  })
    .nullish()
    .describe("Metered usage against the plan's included credits. Micro-credits: 1 credit = 1000000."),
  allowance: loose({
    limit_micro: z.number().optional(),
    limit_credits: z.number().optional(),
    limit_source: z.string().optional().describe("'default' or 'override'."),
    unlimited: z.boolean().optional(),
    used_micro: z.number().optional().describe("Spent plus credits held for in-flight work."),
    remaining_micro: z.number().optional().describe("Credits left under the monthly limit: the number to show."),
    window_start: z.string().optional(),
    resets_at: z.string().optional().describe("When the allowance is restored in full."),
  })
    .optional()
    .describe("The monthly allowance the API enforces. Omitted when it cannot be read (warnings says so)."),
  metrics: METRIC_MAP.optional().describe("Every billed metric for the period."),
  unattributed: METRIC_MAP.optional(),
  usage_as_of: USAGE_AS_OF,
  stale_seconds: STALE_SECONDS,
  warnings: WARNINGS,
});

const RECONCILIATION_OUTPUT = loose({
  day: z.string().optional().describe("The UTC day reconciled."),
  drift: z
    .array(
      loose({
        project_id: z.string().optional(),
        metric: z.string().optional(),
        stored_qty: z.number().optional().describe("The billed quantity."),
        observed_qty: z.number().optional().describe("The quantity re-derived from the request log."),
        delta: z.number().optional(),
        action: z.string().optional().describe("The verdict: missing_in_usage_daily, absent_from_request_log, undercounted or overcounted."),
      }),
    )
    .nullish()
    .describe("Disagreements; empty means no drift."),
  request_log_rows: z.number().optional().describe("Rows in the request log for the day; 0 means there was nothing to compare against."),
  interpretation: z.string().optional().describe("What the drift can and cannot prove. Read it before acting on drift."),
  repairable: z.boolean().optional().describe("Always false; nothing is repaired."),
  warnings: WARNINGS,
});

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
      outputSchema: USAGE_OUTPUT,
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
      outputSchema: SUMMARY_OUTPUT,
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
      outputSchema: RECONCILIATION_OUTPUT,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ day }) =>
      run(() =>
        client.request("GET", `/v1/usage/reconciliation${day ? `?day=${encodeURIComponent(day)}` : ""}`),
      ),
  );
};
