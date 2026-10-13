import { z } from "zod";
import type { ILayerClient } from "../client.js";
import { COMING_SOON, availableOnly, loose, run, type RegisterTools } from "./common.js";

export const jobPath = (id: string) => `/v1/batch/${encodeURIComponent(id)}`;

/** Appends a query string built from the defined entries of `q`. */
function withQuery(path: string, q: Record<string, string | number | boolean | undefined>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined) params.set(k, String(v));
  const s = params.toString();
  return s ? `${path}?${s}` : path;
}

/**
 * One page of a batch job's finished items: `{ results: [...], next_cursor? }`.
 * Shared by spicrawl_batch_results and the ChatGPT profile's copy of it.
 */
export async function batchResults(
  client: ILayerClient,
  job_id: string,
  { status, limit, cursor }: { status?: string; limit?: number; cursor?: string },
): Promise<Record<string, unknown>> {
  const raw = await client.request("GET", withQuery(`${jobPath(job_id)}/results`, { status, limit, cursor }));
  // The endpoint streams JSON Lines; the client hands non-JSON bodies back as `{content}`.
  // A single-line page parses as a plain object instead.
  let results: unknown[];
  if (raw && typeof raw === "object" && typeof (raw as { content?: unknown }).content === "string") {
    results = (raw as { content: string }).content
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as unknown);
  } else if (raw && typeof raw === "object" && Object.keys(raw).length > 0) {
    results = [raw];
  } else {
    results = [];
  }
  const out: Record<string, unknown> = { results };
  // The cursor travels in the X-Next-Cursor header, which the client does not expose.
  // It is the hex of the last seq, so it is recomputed here when the page was full.
  const pageSize = limit ?? 500;
  const last = results[results.length - 1] as { seq?: number } | undefined;
  if (results.length === pageSize && last && typeof last.seq === "number") {
    out.next_cursor = Buffer.from(String(last.seq)).toString("hex");
  }
  return out;
}

const jobId = z.string().min(1).describe("The batch job id returned by spicrawl_batch_submit or spicrawl_batch_list.");

// -----------------------------------------------------------------------------
// Output schemas. Permissive on purpose (`loose` keeps unknown keys, fields the API
// may omit are optional/nullish): they document what an agent can rely on, and a new
// API field must never fail a call. Shapes follow docs/openapi.yaml (BatchJob etc.).
// -----------------------------------------------------------------------------

const count = (d: string) => z.number().optional().describe(d);

const batchProgress = loose({
  total: count("Items in the job (grows when items are appended to an open job)."),
  completed: count("Items in any terminal status (succeeded + failed + cancelled + skipped)."),
  succeeded: count("Items that succeeded. Only these are charged."),
  failed: count("Items that failed after all attempts; re-run them with spicrawl_batch_retry."),
  cancelled: count("Items not run because the job was cancelled."),
  skipped: count("Items skipped (for example after failure_threshold or credit_budget stopped the run)."),
  remaining: count("Items not yet finished (total - completed)."),
  percent_complete: count("completed / total x 100."),
  credits_charged: count("Credits actually charged so far (whole credits, rounded down)."),
  credits_charged_micro: count("Same as credits_charged in micro-credits (1 credit = 1,000,000)."),
  bytes: count("Total response bytes of finished items."),
}).describe("Live item counters and the credits charged so far.");

/** The job object, identical across submit, list, status, cancel, close (and inside retry / add_items). */
const batchJob = loose({
  id: z.string().describe("Job id. Pass it as `job_id` to the other spicrawl_batch_* tools."),
  project_id: z.string().optional().describe("Project the API key belongs to."),
  name: z.string().nullish().describe("The label given at submission, if any."),
  status: z
    .string()
    .optional()
    .describe(
      "Lifecycle: queued, running, paused, cancelling, completed, failed or cancelled. Keep polling while queued/running/paused/cancelling; stop at completed, failed or cancelled.",
    ),
  open: z.boolean().nullish().describe("True while the job accepts appended items (it will not complete until closed)."),
  status_url: z.string().optional().describe("API path to poll for this job: /v1/batch/{id}."),
  results_url: z.string().optional().describe("API path of the job's results: /v1/batch/{id}/results."),
  params: z.record(z.unknown()).nullish().describe("The job-level scrape settings as stored."),
  total_items: count("Number of items in the job."),
  concurrency: count("Effective per-job concurrency after the server's clamping."),
  priority: count("Effective scheduling priority."),
  max_attempts: count("Effective attempts per item."),
  failure_threshold: z.number().nullish().describe("Failed-item count that aborts the job, when set."),
  estimated_credits: count("Credits reserved at submission (a hold, not a charge; compare with progress.credits_charged)."),
  estimated_credits_micro: count("Same as estimated_credits in micro-credits."),
  progress: batchProgress.optional(),
  submitted_at: z.string().optional().describe("ISO-8601 time the job was accepted."),
  started_at: z.string().nullish().describe("ISO-8601 time the first item started."),
  finished_at: z.string().nullish().describe("ISO-8601 time the job reached a terminal status."),
  cancel_requested_at: z.string().nullish().describe("ISO-8601 time a cancel was accepted."),
  results_expire_at: z.string().nullish().describe("ISO-8601 deadline after which results answer 410 Gone."),
  error_code: z.string().nullish().describe("Machine code of a job-level failure."),
  error_message: z.string().nullish().describe("Human-readable job-level failure reason."),
  warnings: z
    .array(z.string())
    .nullish()
    .describe("Decisions made on the caller's behalf at submission (a clamped concurrency, items not yet queued)."),
});

const batchResultLine = loose({
  seq: z.number().describe("0-based position in submission order; use it with spicrawl_batch_task_content."),
  url: z.string().optional().describe("The target URL as submitted."),
  external_id: z.string().nullish().describe("The external_id supplied for this item, if any."),
  status: z.string().optional().describe("Terminal item status: succeeded, failed, cancelled or skipped."),
  attempts: count("How many times the item was tried."),
  http_status: z.number().nullish().describe("The target site's HTTP status (absent when no response was received)."),
  request_id: z.string().nullish().describe("Id of the underlying request, for request history."),
  credits_micro: count("Micro-credits charged for this item (0 unless succeeded)."),
  bytes: count("Response size recorded for this item."),
  duration_ms: count("Time spent on the item's final attempt, in milliseconds."),
  result: loose({
    content: z.string().nullish().describe("The item's document as raw JSON text (JSON-decode once to get the markdown, text or html). A prefix when truncated."),
    bytes: count("Full size of the stored payload in bytes."),
    truncated: z.boolean().nullish().describe("True when `content` is only a prefix."),
    omitted: z.boolean().nullish().describe("True when no content was included because the page's size budget was spent; use a smaller `limit`."),
    unavailable: z.string().nullish().describe("Why the payload could not be read at all."),
  })
    .nullish()
    .describe("The payload inline. Absent while the job is running or when the item has none."),
  result_url: z.string().nullish().describe("API path to fetch this item's content on its own."),
  error: loose({
    code: z.string().optional().describe("Stable machine error code; switch on this, not on text."),
    retryable: z.boolean().optional().describe("True when running the item again may succeed."),
  })
    .nullish()
    .describe("Why the item failed. Absent on success."),
  finished_at: z.string().nullish().describe("ISO-8601 time the item reached its terminal status."),
});

const batchListOutput = loose({
  batches: z.array(batchJob).describe("Jobs, newest first (empty when there are none)."),
  next_cursor: z.string().nullish().describe("Pass back as `cursor` for the next page; absent on the last page."),
});

const batchResultsOutput = loose({
  results: z.array(batchResultLine).describe("Finished items of the job, in seq order."),
  next_cursor: z.string().nullish().describe("Pass back as `cursor` for the next page; absent on the last page."),
});

const batchTaskContentOutput = loose({
  content: z
    .unknown()
    .optional()
    .describe(
      "The item's document when it is text (markdown, text or html) or any non-object JSON value. " +
        "An item whose payload is a JSON object is returned as that object's own fields instead.",
    ),
});

const batchRetryOutput = loose({
  job: batchJob.optional().describe("The job as it stands after the call."),
  items_reset: z.number().optional().describe("Failed items reset to queued (0 means nothing had failed)."),
  items_dispatched: z.number().optional().describe("Of those, how many reached the dispatch queue now; the rest are recovered automatically."),
});

const batchAddItemsOutput = loose({
  job: batchJob.optional().describe("The job as it stands after the call."),
  items_added: z.number().optional().describe("Items written to the job."),
  items_dispatched: z.number().optional().describe("Of those, how many reached the dispatch queue now; do not re-add the rest."),
});

// Shared scrape settings: a subset of the /v1/scrape request object, applied to
// every item of the job (an item in `items` may override any of them).
const sharedParams = {
  render: z.boolean().optional().describe("Render every URL with a browser (`js_render`)."),
  format: z
    .enum(["markdown", "text", "html", "json"])
    .optional()
    .describe(
      "Output format for every item (`response_format`). spicrawl_batch_submit defaults to 'markdown', the same as spicrawl_scrape; an item's own `response_format` overrides it.",
    ),
  main_content_only: z.boolean().optional().describe("Strip each page to its main article."),
  premium_proxy: z.boolean().optional().describe(COMING_SOON + "Use residential managed-pool exits for every URL."),
  proxy_country: z
    .string()
    .length(2)
    .optional()
    .describe(COMING_SOON + "ISO-3166 alpha-2 exit country; requires premium_proxy."),
  wait: z.number().int().min(0).optional().describe("Milliseconds to wait after load (rendered scrapes)."),
  wait_for: z.string().optional().describe("CSS selector to wait for before capturing (rendered scrapes)."),
  block_resources: z
    .array(z.string())
    .optional()
    .describe("Resource types to block while rendering, e.g. [\"image\",\"font\",\"media\"]."),
  custom_headers: z.record(z.string()).optional().describe("Extra request headers sent with every URL."),
  max_cost: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Ceiling in credits for ONE item (not the whole job — see credit_budget)."),
};

type SharedInput = {
  render?: boolean;
  format?: string;
  main_content_only?: boolean;
  premium_proxy?: boolean;
  proxy_country?: string;
  wait?: number;
  wait_for?: string;
  block_resources?: string[];
  custom_headers?: Record<string, string>;
  max_cost?: number;
};

function sharedBody(input: SharedInput): Record<string, unknown> {
  const b: Record<string, unknown> = {};
  if (input.render !== undefined) b.js_render = input.render;
  if (input.format !== undefined) b.response_format = input.format;
  if (input.main_content_only !== undefined) b.main_content_only = input.main_content_only;
  if (input.premium_proxy !== undefined) b.premium_proxy = input.premium_proxy;
  if (input.proxy_country !== undefined) b.proxy_country = input.proxy_country;
  if (input.wait !== undefined) b.wait = input.wait;
  if (input.wait_for !== undefined) b.wait_for = input.wait_for;
  if (input.block_resources !== undefined) b.block_resources = input.block_resources;
  if (input.custom_headers !== undefined) b.custom_headers = input.custom_headers;
  if (input.max_cost !== undefined) b.max_cost = input.max_cost;
  return b;
}

const itemsInput = {
  urls: z
    .array(z.string().url())
    .optional()
    .describe("Shorthand: URLs scraped with the shared settings and no per-item overrides. Mutually exclusive with `items`."),
  items: z
    .array(
      z
        .object({
          url: z.string().url().describe("The URL of this item."),
          external_id: z
            .string()
            .optional()
            .describe("Your own correlation id, echoed back on this item's result record."),
        })
        .passthrough(),
    )
    .optional()
    .describe(
      "Long form: one /v1/scrape request object per item. Besides `url` and `external_id`, any /v1/scrape " +
        "field (e.g. `js_render`, `wait_for`, `response_format`) overrides the shared setting for that item only. Mutually exclusive with `urls`.",
    ),
};

export const registerBatchTools: RegisterTools = (server, client, { hideUnavailable }) => {
  const shared = availableOnly(sharedParams, hideUnavailable);

  // -------------------------------------------------------------------------
  // spicrawl_batch_submit — POST /v1/batch
  // -------------------------------------------------------------------------
  server.registerTool(
    "spicrawl_batch_submit",
    {
      title: "Submit a batch scrape job",
      description:
        "Submit many URLs to be scraped as one asynchronous job, with shared settings applied to every URL. " +
        "Give EITHER `urls` or `items`, not both (at least one URL, unless `open` is true). Returns the job object " +
        "(id, status, estimated_credits, progress). Poll with `spicrawl_batch_status`, read with `spicrawl_batch_results` " +
        "or `spicrawl_batch_task_content`. Use this instead of many `spicrawl_scrape` calls when you have tens or thousands " +
        "of URLs. Set `open: true` to keep the job accepting more URLs via `spicrawl_batch_add_items`; an open job never " +
        "finishes until you call `spicrawl_batch_close`.",
      inputSchema: {
        ...itemsInput,
        ...shared,
        name: z.string().optional().describe("A human label for the job."),
        open: z
          .boolean()
          .optional()
          .describe("Keep the job accepting items after submission (append with spicrawl_batch_add_items, finish with spicrawl_batch_close)."),
        concurrency: z.number().int().min(1).optional().describe("Max items in flight at once for this job (may be capped by the server; see warnings)."),
        priority: z.number().int().optional().describe("Scheduling priority of the job relative to your other jobs."),
        max_attempts: z.number().int().min(1).max(10).optional().describe("Per-item retry attempts on failure."),
        failure_threshold: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Abort the job once this many items have failed."),
        credit_budget: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Ceiling on the WHOLE job, in credits; the run aborts when it would exceed this."),
        webhook_endpoint_id: z
          .string()
          .optional()
          .describe("Id of a registered webhook endpoint notified (with the job object) when the job completes."),
      },
      outputSchema: batchJob,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input) => {
      const body: Record<string, unknown> = sharedBody(input);
      // Same default as spicrawl_scrape. Set here, not in sharedBody, so an
      // append (spicrawl_batch_add_items) inherits the job's format instead.
      if (body.response_format === undefined) body.response_format = "markdown";
      if (input.urls) body.urls = input.urls;
      if (input.items) body.items = input.items;
      if (input.name !== undefined) body.name = input.name;
      if (input.open) body.open = true;
      if (input.concurrency !== undefined) body.concurrency = input.concurrency;
      if (input.priority !== undefined) body.priority = input.priority;
      if (input.max_attempts !== undefined) body.max_attempts = input.max_attempts;
      if (input.failure_threshold !== undefined) body.failure_threshold = input.failure_threshold;
      if (input.credit_budget !== undefined) body.credit_budget = input.credit_budget;
      if (input.webhook_endpoint_id !== undefined) body.webhook_endpoint_id = input.webhook_endpoint_id;
      return run(() => client.request("POST", "/v1/batch", body));
    },
  );

  // -------------------------------------------------------------------------
  // spicrawl_batch_list — GET /v1/batch
  // -------------------------------------------------------------------------
  server.registerTool(
    "spicrawl_batch_list",
    {
      title: "List batch jobs",
      description:
        "List this API key's project's batch jobs, newest first, with status and progress. " +
        "Returns `{ batches: [...], next_cursor? }`; pass `next_cursor` back as `cursor` for the next page.",
      inputSchema: {
        status: z
          .enum(["queued", "running", "paused", "cancelling", "completed", "failed", "cancelled"])
          .optional()
          .describe("Only jobs in this status."),
        limit: z.number().int().min(1).max(200).optional().describe("Page size (default 50, max 200)."),
        cursor: z.string().optional().describe("`next_cursor` from a previous page, verbatim."),
      },
      outputSchema: batchListOutput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ status, limit, cursor }) =>
      run(() => client.request("GET", withQuery("/v1/batch", { status, limit, cursor }))),
  );

  // -------------------------------------------------------------------------
  // spicrawl_batch_status — GET /v1/batch/{id}
  // -------------------------------------------------------------------------
  server.registerTool(
    "spicrawl_batch_status",
    {
      title: "Check a batch job's status",
      description:
        "Return one batch job with its status and progress (total/completed/succeeded/failed/remaining, credits charged). " +
        "Poll this after `spicrawl_batch_submit`; once status is `completed`, `failed` or `cancelled`, read `spicrawl_batch_results`.",
      inputSchema: { job_id: jobId },
      outputSchema: batchJob,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ job_id }) => run(() => client.request("GET", jobPath(job_id))),
  );

  // -------------------------------------------------------------------------
  // spicrawl_batch_results — GET /v1/batch/{id}/results (JSON Lines)
  // -------------------------------------------------------------------------
  server.registerTool(
    "spicrawl_batch_results",
    {
      title: "Read a batch job's results",
      description:
        "Return a page of FINISHED items of a batch job (one record per item: seq, url, external_id, status, error, " +
        "and content, or a `result_url` API path (GET /v1/batch/{id}/tasks/{seq}/content, same key) for large bodies). Unfinished items are not listed yet. Returns " +
        "`{ results: [...], next_cursor? }`; pass `next_cursor` back as `cursor` for the next page. " +
        "Results expire after the job's retention window (410 Gone).",
      inputSchema: {
        job_id: jobId,
        status: z
          .enum(["succeeded", "failed", "cancelled", "skipped"])
          .optional()
          .describe("Only items that finished with this status."),
        limit: z.number().int().min(1).max(5000).optional().describe("Page size (default 500, max 5000)."),
        cursor: z.string().optional().describe("`next_cursor` from a previous page, verbatim."),
      },
      outputSchema: batchResultsOutput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ job_id, status, limit, cursor }) => run(() => batchResults(client, job_id, { status, limit, cursor })),
  );

  // -------------------------------------------------------------------------
  // spicrawl_batch_task_content — GET /v1/batch/{id}/tasks/{seq}/content
  // -------------------------------------------------------------------------
  server.registerTool(
    "spicrawl_batch_task_content",
    {
      title: "Read one batch item's content",
      description:
        "Return the full payload one item of a batch job produced, by its `seq` (items are numbered from 0 in " +
        "submission order). Cheaper than paging results when you need one URL's output. A CONFLICT error means " +
        "either the item has not finished yet (poll `spicrawl_batch_status` and ask again) or it finished as failed " +
        "(it will never produce content; the message says which). NOT_FOUND means no such seq.",
      inputSchema: {
        job_id: jobId,
        seq: z.number().int().min(0).describe("The item's sequence number (0-based, submission order)."),
      },
      outputSchema: batchTaskContentOutput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ job_id, seq }) =>
      run(() => client.request("GET", `${jobPath(job_id)}/tasks/${encodeURIComponent(String(seq))}/content`)),
  );

  // -------------------------------------------------------------------------
  // spicrawl_batch_cancel — POST /v1/batch/{id}/cancel
  // -------------------------------------------------------------------------
  server.registerTool(
    "spicrawl_batch_cancel",
    {
      title: "Cancel a batch job",
      description:
        "Cancel a batch job: items not yet started are cancelled and will never run; items already finished keep " +
        "their results; items already running finish first, so the job comes back `cancelling` and moves to " +
        "`cancelled` when they drain. Cannot be undone — resubmit to run the URLs again. Returns the job object.",
      inputSchema: { job_id: jobId },
      outputSchema: batchJob,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ job_id }) => run(() => client.request("POST", `${jobPath(job_id)}/cancel`)),
  );

  // -------------------------------------------------------------------------
  // spicrawl_batch_retry — POST /v1/batch/{id}/retry
  // -------------------------------------------------------------------------
  server.registerTool(
    "spicrawl_batch_retry",
    {
      title: "Retry a batch job's failed items",
      description:
        "Re-queue every FAILED item of a batch job so it runs again (succeeded items are untouched; a job with no " +
        "failures is returned unchanged). Returns `{ job, items_reset, items_dispatched }`.",
      inputSchema: { job_id: jobId },
      outputSchema: batchRetryOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ job_id }) => run(() => client.request("POST", `${jobPath(job_id)}/retry`)),
  );

  // -------------------------------------------------------------------------
  // spicrawl_batch_add_items — POST /v1/batch/{id}/items
  // -------------------------------------------------------------------------
  server.registerTool(
    "spicrawl_batch_add_items",
    {
      title: "Add URLs to an open batch job",
      description:
        "Append URLs to a batch job that was submitted with `open: true`. Same item vocabulary as " +
        "`spicrawl_batch_submit` (EITHER `urls` or `items`, not both, plus shared settings for these new items). Fails with CONFLICT " +
        "if the job is closed or finished. Not idempotent: calling twice adds the URLs twice. " +
        "Returns `{ job, items_added, items_dispatched }`.",
      inputSchema: { job_id: jobId, ...itemsInput, ...shared },
      outputSchema: batchAddItemsOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input) => {
      const body: Record<string, unknown> = sharedBody(input);
      // Same default as spicrawl_scrape. Set here, not in sharedBody, so an
      // append (spicrawl_batch_add_items) inherits the job's format instead.
      if (body.response_format === undefined) body.response_format = "markdown";
      if (input.urls) body.urls = input.urls;
      if (input.items) body.items = input.items;
      return run(() => client.request("POST", `${jobPath(input.job_id)}/items`, body));
    },
  );

  // -------------------------------------------------------------------------
  // spicrawl_batch_close — POST /v1/batch/{id}/close
  // -------------------------------------------------------------------------
  server.registerTool(
    "spicrawl_batch_close",
    {
      title: "Close an open batch job",
      description:
        "Stop an open batch job accepting items, so it completes once its queued work drains. " +
        "Idempotent (closing a closed job succeeds). Returns the job object.",
      inputSchema: { job_id: jobId },
      outputSchema: batchJob,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ job_id }) => run(() => client.request("POST", `${jobPath(job_id)}/close`)),
  );
};
