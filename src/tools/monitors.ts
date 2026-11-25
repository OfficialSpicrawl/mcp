import { z } from "zod";
import { loose, run, type RegisterTools } from "./common.js";

// Monitors: watch a page, or every page of a site, for changes. Each check bills like
// the scrape that fetched it. Offered only to a key with the `monitors` scope (see src/server.ts).

type Obj = Record<string, unknown>;

const monitorPath = (id: string, rest = "") => `/v1/monitors/${encodeURIComponent(id)}${rest}`;

const monitorId = z.string().min(1).max(64).describe("The monitor's id, as returned by spicrawl_monitor_create or spicrawl_monitors_list.");
const httpUrl = z
  .string()
  .max(2048)
  .regex(/^https?:\/\//, "must start with http:// or https://")
  .describe("The page to watch, http or https. For a site monitor, the site's start page; the monitor stays on its exact host.");
const name = z.string().max(100).describe("A label, at most 100 characters. Defaults to the host of the URL.");
const selector = z
  .string()
  .max(512)
  .describe("A CSS selector. Every element it matches is watched, by its text. Omit it to watch the page's main content.");
const intervalSeconds = z
  .number()
  .int()
  .min(60)
  .max(2_592_000)
  .describe("Seconds between checks, 60 to 2,592,000 (30 days). Not below your plan's minimum. The interval adapts: it shortens while the page changes and lengthens while it does not.");
const confirmChecks = z
  .number()
  .int()
  .min(1)
  .max(10)
  .describe("A change must be seen on this many checks in a row before it is reported. 1 reports the first change.");
const jsRender = z.boolean().describe("Render the page in a browser before reading it. Costs more credits (3 for a rendered check, not 1).");
const webhookEndpointId = z
  .string()
  .min(1)
  .max(64)
  .describe("The webhook endpoint that receives monitor.changed and monitor.failed, from spicrawl_webhooks_list. Must be one of your endpoints.");
const pathPatterns = z.array(z.string().max(200)).max(20);
const maxPages = z
  .number()
  .int()
  .min(1)
  .describe("Site monitors only: the most pages one run considers. Capped by your plan (free 25, starter 250, pro 2,000, enterprise 10,000).");
const maxCreditsPerRun = z
  .number()
  .int()
  .min(1)
  .describe("Site monitors only: a run stops fetching when the next fetch would go over this many credits.");

const MONITOR_OUT = loose({
  id: z.string().nullish(),
  name: z.string().nullish(),
  url: z.string().nullish(),
  scope: z.string().nullish().describe("page (one URL) or site (every page on the host)."),
  selector: z.string().nullish(),
  js_render: z.boolean().nullish(),
  interval_seconds: z.number().nullish().describe("The interval you asked for."),
  current_interval_seconds: z.number().nullish().describe("The interval in force now."),
  confirm_checks: z.number().nullish(),
  webhook_endpoint_id: z.string().nullish(),
  enabled: z.boolean().nullish().describe("False once disabled by repeated failures, by running out of credits, or by you."),
  disabled_reason: z.string().nullish(),
  last_error: z.string().nullish(),
  last_checked_at: z.string().nullish(),
  last_changed_at: z.string().nullish(),
  next_check_at: z.string().nullish(),
  consecutive_failures: z.number().nullish(),
  max_pages: z.number().nullish().describe("Site monitors only."),
  include_paths: z.array(z.string()).nullish(),
  exclude_paths: z.array(z.string()).nullish(),
  max_credits_per_run: z.number().nullish(),
  pages_tracked: z.number().nullish().describe("Site monitors only: pages tracked now."),
  last_run: loose({
    checked: z.number().nullish(),
    skipped: z.number().nullish(),
    changed: z.number().nullish(),
    added: z.number().nullish(),
    removed: z.number().nullish(),
    credits: z.number().nullish(),
    truncated: z.boolean().nullish(),
  }).nullish().describe("Site monitors only: counts of the latest run."),
  created_at: z.string().nullish(),
  updated_at: z.string().nullish(),
});

const MONITORS_LIST_OUT = loose({
  data: z.array(MONITOR_OUT).nullish().describe("Every monitor of your organization. The captured content is never listed."),
});

const CHANGE_OUT = loose({
  id: z.string().nullish(),
  detected_at: z.string().nullish(),
  previous_hash: z.string().nullish(),
  new_hash: z.string().nullish(),
  diff: z.string().nullish().describe("Unified diff from the old content to the new, up to 65,536 characters. Null for a site change."),
  summary: loose({
    counts: loose({}).nullish(),
    truncated: z.boolean().nullish(),
    changed: z.array(loose({ url: z.string().nullish(), diff: z.string().nullish() })).nullish(),
    added: z.array(z.string()).nullish(),
    removed: z.array(z.string()).nullish(),
  }).nullish().describe("Site changes only: the digest of one run."),
  notified_at: z.string().nullish().describe("When the webhook delivery was queued, or null when no endpoint was subscribed."),
});

const CHANGES_OUT = loose({
  data: z.array(CHANGE_OUT).nullish().describe("Confirmed changes, newest first. The first check's baseline is not listed."),
});

const PAGES_OUT = loose({
  data: z
    .array(
      loose({
        url: z.string().nullish(),
        first_seen_at: z.string().nullish(),
        last_seen_at: z.string().nullish(),
        last_changed_at: z.string().nullish(),
        removed_at: z.string().nullish().describe("Set while the page is gone. Removed pages stay in the list."),
      }),
    )
    .nullish(),
  next_cursor: z.string().nullish().describe("Pass as `cursor` for the next page. Null on the last page."),
});

const CHECK_OUT = loose({
  outcome: z.string().nullish().describe("changed, unchanged, not_modified (the page answered 304, nothing re-read) or failed."),
  event_id: z.string().nullish().describe("The change event, when outcome is changed."),
  credits: z.number().nullish().describe("Credits this check cost."),
  run: loose({}).nullish().describe("Site monitors only: the counts of the run."),
});

const DELETED_OUT = loose({
  deleted: z.boolean().describe("Always true on success."),
  monitor_id: z.string(),
});

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const WRITE_IDEMPOTENT = { ...WRITE, idempotentHint: true };
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };

export const registerMonitorTools: RegisterTools = (server, client) => {
  server.registerTool(
    "spicrawl_monitors_list",
    {
      title: "List monitors",
      description:
        "List every monitor of your organization: what it watches, its interval, when it next checks, whether it is enabled and any " +
        "last error. Not paginated. The captured content is never returned; use spicrawl_monitor_changes for the history. Read-only.",
      inputSchema: {},
      outputSchema: MONITORS_LIST_OUT,
      annotations: READ,
    },
    async () => run(() => client.request("GET", "/v1/monitors")),
  );

  server.registerTool(
    "spicrawl_monitor_get",
    {
      title: "Get a monitor",
      description:
        "Read one monitor and its schedule and health: `current_interval_seconds`, `next_check_at`, `consecutive_failures`, `last_error`, " +
        "and `enabled` with `disabled_reason` when it was switched off. For a site monitor, `pages_tracked` and `last_run`. Read-only.",
      inputSchema: { monitor_id: monitorId },
      outputSchema: MONITOR_OUT,
      annotations: READ,
    },
    async ({ monitor_id }) => run(() => client.request("GET", monitorPath(monitor_id))),
  );

  server.registerTool(
    "spicrawl_monitor_create",
    {
      title: "Create a monitor",
      description:
        "Start watching a page (`scope` `page`, the default) or every page reachable from the URL on its exact host (`scope` `site`, which " +
        "needs `max_pages`). The first successful check records a baseline and reports no change; later changes are reported once " +
        "`confirm_checks` checks agree. Each check costs what the scrape that fetched it costs: 1 credit for a plain fetch, more with " +
        "`js_render`. A site run also costs a scrape per page fetched; a page skipped by its sitemap date costs nothing. Changes go to " +
        "`webhook_endpoint_id` as monitor.changed. Checks bill the key that created the monitor, so that key must stay valid. The number " +
        "of monitors and the shortest interval depend on the plan. Not idempotent: each call makes another monitor. Ask the person " +
        "before creating one that will run often.",
      inputSchema: {
        url: httpUrl,
        name: name.optional(),
        selector: selector.optional(),
        interval_seconds: intervalSeconds.optional(),
        webhook_endpoint_id: webhookEndpointId.optional(),
        confirm_checks: confirmChecks.optional(),
        js_render: jsRender.optional(),
        scope: z.enum(["page", "site"]).optional().describe("page (default) watches one URL. site watches every page on its host and requires `max_pages`."),
        max_pages: maxPages.optional(),
        include_paths: pathPatterns.optional().describe("Site monitors only: path patterns a page must match to be kept. Empty keeps every path."),
        exclude_paths: pathPatterns.optional().describe("Site monitors only: path patterns that drop a page. Applied after include_paths."),
        max_credits_per_run: maxCreditsPerRun.optional(),
      },
      outputSchema: MONITOR_OUT,
      annotations: WRITE,
    },
    async (input) => run(() => client.request("POST", "/v1/monitors", input)),
  );

  server.registerTool(
    "spicrawl_monitor_update",
    {
      title: "Update a monitor",
      description:
        "Change one or more fields of a monitor. Send only the fields to change; at least one is needed. `scope` cannot change. Setting " +
        "`enabled: true` re-enables a monitor that was disabled, clears its error and makes the next check due now; do that only once " +
        "the page or the credits are back. Send `webhook_endpoint_id: null` to clear the endpoint, and `selector: null` to watch the " +
        "whole page again. Site monitors also take `max_pages`, `include_paths`, `exclude_paths` and `max_credits_per_run`.",
      inputSchema: {
        monitor_id: monitorId,
        name: name.optional(),
        selector: selector.nullable().optional(),
        interval_seconds: intervalSeconds.optional(),
        webhook_endpoint_id: webhookEndpointId.nullable().optional(),
        confirm_checks: confirmChecks.optional(),
        js_render: jsRender.optional(),
        enabled: z.boolean().optional().describe("true re-enables the monitor (see the description); false stops its checks."),
        max_pages: maxPages.optional(),
        include_paths: pathPatterns.optional().describe("Site monitors only. Replaces the whole list."),
        exclude_paths: pathPatterns.optional().describe("Site monitors only. Replaces the whole list."),
        max_credits_per_run: maxCreditsPerRun.nullable().optional().describe("Site monitors only. null removes the cap."),
      },
      outputSchema: MONITOR_OUT,
      annotations: WRITE_IDEMPOTENT,
    },
    async ({ monitor_id, ...fields }) =>
      run(() => {
        const body: Obj = {};
        for (const [k, v] of Object.entries(fields)) if (v !== undefined) body[k] = v;
        if (Object.keys(body).length === 0) throw new Error("Nothing to change: give at least one field to update.");
        return client.request("PATCH", monitorPath(monitor_id), body);
      }),
  );

  server.registerTool(
    "spicrawl_monitor_delete",
    {
      title: "Delete a monitor",
      description:
        "Stop a monitor's checks and delete it with its whole change history. This cannot be undone. Confirm with the person first.",
      inputSchema: { monitor_id: monitorId },
      outputSchema: DELETED_OUT,
      annotations: DESTRUCTIVE,
    },
    async ({ monitor_id }) =>
      run(async () => {
        await client.request("DELETE", monitorPath(monitor_id));
        return { deleted: true, monitor_id };
      }),
  );

  server.registerTool(
    "spicrawl_monitor_check",
    {
      title: "Check a monitor now",
      description:
        "Run one check of a monitor now, fetching the page fresh (never from cache), and return when it is done: `outcome` (changed, " +
        "unchanged, not_modified or failed), the change `event_id` if there was one, and the credits it cost. A change queues the usual notification. " +
        "Spends credits every time, at the same price as a scheduled check; for a site monitor that is the whole run. Ask the person before " +
        "running it on a large site.",
      inputSchema: { monitor_id: monitorId },
      outputSchema: CHECK_OUT,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ monitor_id }) => run(() => client.request("POST", monitorPath(monitor_id, "/check"))),
  );

  server.registerTool(
    "spicrawl_monitor_changes",
    {
      title: "Monitor change history",
      description:
        "The confirmed changes of one monitor, newest first, each with the diff from the old content to the new one (for a page). A site " +
        "monitor lists one change per run that found something, with a `summary` digest and no diff. The first check's baseline is not a " +
        "change. Read-only.",
      inputSchema: {
        monitor_id: monitorId,
        limit: z.number().int().min(1).max(100).optional().describe("Changes to return, 1 to 100. Default 20."),
      },
      outputSchema: CHANGES_OUT,
      annotations: READ,
    },
    async ({ monitor_id, limit }) =>
      run(() => client.request("GET", monitorPath(monitor_id, limit === undefined ? "/changes" : `/changes?limit=${limit}`))),
  );

  server.registerTool(
    "spicrawl_monitor_pages",
    {
      title: "Pages of a site monitor",
      description:
        "The pages a site monitor tracks, ordered by URL, with when each was first and last seen and last changed. A page the monitor " +
        "stopped finding stays listed with `removed_at` set. Only site monitors have pages; a page monitor answers with an error. Pages " +
        "come in pages: pass `next_cursor` as `cursor` for the next. Read-only.",
      inputSchema: {
        monitor_id: monitorId,
        limit: z.number().int().min(1).max(500).optional().describe("Pages to return, 1 to 500. Default 100."),
        cursor: z.string().min(1).optional().describe("The `next_cursor` of the previous page. Omit it for the first page."),
      },
      outputSchema: PAGES_OUT,
      annotations: READ,
    },
    async ({ monitor_id, limit, cursor }) => {
      const q = new URLSearchParams();
      if (limit !== undefined) q.set("limit", String(limit));
      if (cursor !== undefined) q.set("cursor", cursor);
      const qs = q.toString();
      return run(() => client.request("GET", monitorPath(monitor_id, qs ? `/pages?${qs}` : "/pages")));
    },
  );
};
