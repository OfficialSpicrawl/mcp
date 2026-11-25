import { z } from "zod";
import { loose, run, type RegisterTools } from "./common.js";

// Webhooks: HTTPS endpoints that receive signed notifications about batch jobs and
// monitors. Offered only to a key with the `webhooks` scope (see src/server.ts).

type Obj = Record<string, unknown>;

const webhookPath = (id: string, rest = "") => `/v1/webhooks/${encodeURIComponent(id)}${rest}`;

const EVENTS = ["batch.completed", "batch.failed", "monitor.changed", "monitor.failed"] as const;
const FORMATS = ["json", "slack", "discord"] as const;

const webhookId = z.string().min(1).max(64).describe("The endpoint's id, as returned by spicrawl_webhook_create or spicrawl_webhooks_list.");
const httpsUrl = z
  .string()
  .max(2048)
  .regex(/^https:\/\//, "must start with https://")
  .describe("The HTTPS URL that receives the deliveries, at most 2,048 characters. It must not point at a private or internal address.");
const endpointName = z.string().max(100).describe("A label for your records, at most 100 characters.");
const events = z
  .array(z.enum(EVENTS))
  .min(1)
  .describe("The events to send: batch.completed, batch.failed, monitor.changed, monitor.failed. A ping is always sent by spicrawl_webhook_test.");
const format = z
  .enum(FORMATS)
  .describe("json (default): the signed JSON document. slack or discord: a one-line summary for a Slack or Discord incoming-webhook URL.");

const WEBHOOK_OUT = loose({
  id: z.string().nullish().describe("The endpoint's id."),
  name: z.string().nullish(),
  url: z.string().nullish(),
  events: z.array(z.string()).nullish(),
  format: z.string().nullish(),
  enabled: z.boolean().nullish().describe("False once the endpoint was disabled, by a failure streak or by you."),
  disabled_reason: z.string().nullish(),
  consecutive_failures: z.number().nullish().describe("Failed deliveries in a row. At 100 the endpoint is disabled."),
  last_success_at: z.string().nullish(),
  last_failure_at: z.string().nullish(),
  secret_version: z.number().nullish().describe("Goes up by one on each rotation. Also the `kid` in signature headers."),
  secret_rotated_at: z.string().nullish(),
  created_at: z.string().nullish(),
  updated_at: z.string().nullish(),
});

const WEBHOOK_WITH_SECRET_OUT = loose({
  ...WEBHOOK_OUT.shape,
  secret: z
    .string()
    .nullish()
    .describe("The signing secret, `whsec_...`. Shown only in this result: store it now, it is never returned again."),
});

const WEBHOOKS_LIST_OUT = loose({
  data: z.array(WEBHOOK_OUT).nullish().describe("Every endpoint of your organization, up to 20."),
});

const DELIVERY_OUT = loose({
  id: z.string().nullish().describe("The delivery id, also sent as X-ILayer-Delivery."),
  event_type: z.string().nullish().describe("batch.completed, batch.failed, monitor.changed, monitor.failed or ping."),
  event_id: z.string().nullish().describe("Id of the batch job or monitor event the delivery is about."),
  status: z.string().nullish().describe("pending, delivering, delivered, failed (will be retried), or dead (given up)."),
  attempt: z.number().nullish().describe("Attempts made so far."),
  max_attempts: z.number().nullish(),
  next_retry_at: z.string().nullish(),
  last_error: z.string().nullish().describe("Why the last attempt failed."),
  created_at: z.string().nullish(),
});

const DELIVERIES_OUT = loose({
  data: z.array(DELIVERY_OUT).nullish().describe("Newest first. One row per event and endpoint."),
});

const TEST_OUT = loose({
  delivery_id: z.string().describe("The ping's delivery id. Read spicrawl_webhook_deliveries to see whether it arrived."),
});

const DELETED_OUT = loose({
  deleted: z.boolean().describe("Always true on success."),
  webhook_id: z.string(),
});

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const WRITE_IDEMPOTENT = { ...WRITE, idempotentHint: true };
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };

export const registerWebhookTools: RegisterTools = (server, client) => {
  server.registerTool(
    "spicrawl_webhooks_list",
    {
      title: "List webhook endpoints",
      description:
        "List every webhook endpoint of your organization, with each one's events, format, whether it is enabled and its failure " +
        "counts. Not paginated (at most 20). The signing secret is never listed. Read-only.",
      inputSchema: {},
      outputSchema: WEBHOOKS_LIST_OUT,
      annotations: READ,
    },
    async () => run(() => client.request("GET", "/v1/webhooks")),
  );

  server.registerTool(
    "spicrawl_webhook_get",
    {
      title: "Get a webhook endpoint",
      description:
        "Read one webhook endpoint and its health: `consecutive_failures`, the last success and failure, and `enabled` with " +
        "`disabled_reason` when it was switched off. The signing secret is not included. Read-only.",
      inputSchema: { webhook_id: webhookId },
      outputSchema: WEBHOOK_OUT,
      annotations: READ,
    },
    async ({ webhook_id }) => run(() => client.request("GET", webhookPath(webhook_id))),
  );

  server.registerTool(
    "spicrawl_webhook_create",
    {
      title: "Create a webhook endpoint",
      description:
        "Register an HTTPS URL that receives signed notifications: batch jobs (`batch.completed`, `batch.failed`) and monitors " +
        "(`monitor.changed`, `monitor.failed`). The notification says what happened and the caller fetches anything else. Defaults to " +
        "the two batch events in `json` format; use `slack` or `discord` to post a one-line summary to an incoming-webhook URL. " +
        "The result includes `secret`, the signing secret. It is shown only in this result and never again, so tell the person to " +
        "store it now; `spicrawl_webhook_rotate_secret` issues a new one if it is lost. At most 20 endpoints per organization. " +
        "Creating an endpoint sends nothing until a job or monitor fires, so use spicrawl_webhook_test to check it. Not idempotent: " +
        "each call makes another endpoint.",
      inputSchema: {
        url: httpsUrl,
        name: endpointName.optional(),
        events: events.optional(),
        format: format.optional(),
      },
      outputSchema: WEBHOOK_WITH_SECRET_OUT,
      annotations: WRITE,
    },
    async ({ url, name, events, format }) => run(() => client.request("POST", "/v1/webhooks", { url, name, events, format })),
  );

  server.registerTool(
    "spicrawl_webhook_update",
    {
      title: "Update a webhook endpoint",
      description:
        "Change one or more fields of an endpoint: `url`, `name`, `events`, `format` or `enabled`. Send only the fields to change; " +
        "at least one is needed. The signing secret does not change here (use spicrawl_webhook_rotate_secret). Setting `enabled: true` " +
        "re-enables an endpoint that was switched off, clears its disabled reason and resets its failure count; do that only once the " +
        "receiver is fixed, since an endpoint is disabled after 100 failed deliveries in a row.",
      inputSchema: {
        webhook_id: webhookId,
        url: httpsUrl.optional(),
        name: endpointName.optional(),
        events: events.optional(),
        format: format.optional(),
        enabled: z.boolean().optional().describe("false stops deliveries; true re-enables the endpoint (see the description)."),
      },
      outputSchema: WEBHOOK_OUT,
      annotations: WRITE_IDEMPOTENT,
    },
    async ({ webhook_id, ...fields }) =>
      run(() => {
        const body: Obj = {};
        for (const [k, v] of Object.entries(fields)) if (v !== undefined) body[k] = v;
        if (Object.keys(body).length === 0) throw new Error("Nothing to change: give at least one field to update.");
        return client.request("PATCH", webhookPath(webhook_id), body);
      }),
  );

  server.registerTool(
    "spicrawl_webhook_delete",
    {
      title: "Delete a webhook endpoint",
      description:
        "Delete an endpoint for good. Deliveries to it stop and its delivery history is removed. Monitors and batch jobs that named " +
        "it are not deleted, but they stop notifying it. Confirm with the person first.",
      inputSchema: { webhook_id: webhookId },
      outputSchema: DELETED_OUT,
      annotations: DESTRUCTIVE,
    },
    async ({ webhook_id }) =>
      run(async () => {
        await client.request("DELETE", webhookPath(webhook_id));
        return { deleted: true, webhook_id };
      }),
  );

  server.registerTool(
    "spicrawl_webhook_test",
    {
      title: "Send a test ping",
      description:
        "Queue a signed `ping` delivery to an endpoint, to check that its URL and signature check work. It returns at once with a " +
        "`delivery_id`; read spicrawl_webhook_deliveries to see whether it arrived. Each call sends another ping.",
      inputSchema: { webhook_id: webhookId },
      outputSchema: TEST_OUT,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ webhook_id }) => run(() => client.request("POST", webhookPath(webhook_id, "/test"))),
  );

  server.registerTool(
    "spicrawl_webhook_rotate_secret",
    {
      title: "Rotate a webhook secret",
      description:
        "Issue a new signing secret for an endpoint. The result includes the new `secret`, shown only in this result. From now on " +
        "deliveries are signed with the new secret alone, and the old one stops verifying, so update the receiver first or as you " +
        "rotate. Confirm with the person first, since a receiver that still has the old secret will reject every delivery.",
      inputSchema: { webhook_id: webhookId },
      outputSchema: WEBHOOK_WITH_SECRET_OUT,
      annotations: WRITE,
    },
    async ({ webhook_id }) => run(() => client.request("POST", webhookPath(webhook_id, "/rotate-secret"))),
  );

  server.registerTool(
    "spicrawl_webhook_deliveries",
    {
      title: "Recent webhook deliveries",
      description:
        "The recent deliveries to one endpoint, newest first, one row per event (not per attempt): its status (`delivered`, " +
        "`failed` with a `next_retry_at`, or `dead` when retries ran out), the attempt count and the last error. Use it to find out " +
        "why a receiver is not getting events. Read-only.",
      inputSchema: {
        webhook_id: webhookId,
        limit: z.number().int().min(1).max(100).optional().describe("Deliveries to return, 1 to 100. Default 20."),
      },
      outputSchema: DELIVERIES_OUT,
      annotations: READ,
    },
    async ({ webhook_id, limit }) =>
      run(() => client.request("GET", webhookPath(webhook_id, limit === undefined ? "/deliveries" : `/deliveries?limit=${limit}`))),
  );
};
