import { randomUUID } from "node:crypto";
import { z } from "zod";
import { loose, run, type RegisterTools } from "./common.js";

// Partner tools: a platform that resells Spicrawl to its own users. Each user has a
// workspace, identified by the partner's own id for them (`external_user_id`). The
// partner has one balance of credits and gives credits to users, sets tiers (named
// sets of limits) and reads usage. These tools are offered only to a partner key
// (see src/profile.ts); the API refuses them to any other key.

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

const MICRO = 1_000_000;
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
const userPath = (externalUserId: string, rest = "") => `/v1/partner/workspaces/${encodeURIComponent(externalUserId)}${rest}`;
const tierPath = (tierId: string) => `/v1/partner/tiers/${encodeURIComponent(tierId)}`;

function withQuery(path: string, q: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined) params.set(k, String(v));
  const s = params.toString();
  return s ? `${path}?${s}` : path;
}

/**
 * Whole-credit fields for one usage total or row. The three parts add up to
 * `credits` and none is negative: credits given to the user are spent first in
 * the sum, then the balance (up to what is left), and the rest is free credits.
 * Whole credits are rounded down, so the parts are computed from floored values.
 */
function creditParts(item: Obj) {
  const micro = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  const total = micro(item.credits_micro);
  const given = Math.min(micro(item.credits_own_micro), total);
  const fromBalance = Math.min(micro(item.credits_wallet_micro), total - given);
  const credits = Math.floor(total / MICRO);
  const creditsFromBalance = Math.floor(fromBalance / MICRO);
  const creditsGiven = Math.floor(given / MICRO);
  return {
    credits,
    credits_from_balance: creditsFromBalance,
    credits_given_spent: creditsGiven,
    credits_free: credits - creditsFromBalance - creditsGiven,
  };
}

/** A usage response with the whole-credit fields added to its totals and each row. */
function withCreditParts(data: unknown): unknown {
  if (!isObj(data)) return data;
  const addTo = (item: unknown) => (isObj(item) ? { ...item, ...creditParts(item) } : item);
  const out: Obj = { ...data };
  if (isObj(data.totals)) out.totals = addTo(data.totals);
  if (Array.isArray(data.rows)) out.rows = data.rows.map(addTo);
  return out;
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const externalUserId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/, "letters, digits, '.', '_', ':' and '-' only")
  .describe("Your id for the user, 1 to 128 characters: letters, digits, `.`, `_`, `:` or `-`. Not an email address. Example: `user-42`.");

const tierRef = z
  .string()
  .min(1)
  .max(128)
  .describe("The tier's id or its name, as listed by spicrawl_partner_tiers_list.");

const tierId = z.string().min(1).max(128).describe("The tier's id, as listed by spicrawl_partner_tiers_list.");

const cap = z
  .number()
  .int()
  .min(0)
  .nullable()
  .describe("The cap: the most whole credits per month a user on this tier may take from the balance. null means the tier sets no cap.");

const tierName = z.string().trim().min(1).max(60).describe("The tier's name, 1 to 60 characters. Unique among your tiers.");
const requestsPerMinute = z.number().int().min(1).describe("Requests a user may make per minute, and browser sessions they may start.");
const concurrency = z.number().int().min(1).describe("Requests and browser sessions a user may run at the same time.");
const freeCredits = z.number().int().min(0).describe("Free credits per user per month, in whole credits.");
const defaultTier = z.literal(true).describe("Set to true to make this the tier new users start on. Only true is accepted: another tier becomes the default by setting it.");

const pageLimit = z.number().int().min(1).max(200).describe("Page size, 1 to 200.");
const pageOffset = z.number().int().min(0).describe("Offset to start the page at, for sort `wallet_used` (the `next_offset` from the last page).");
const from = DATE.optional().describe("First day, inclusive (YYYY-MM-DD, UTC). Default: 29 days before today.");
const to = DATE.optional().describe("Day after the last day, exclusive (YYYY-MM-DD, UTC). Default: tomorrow, so today is included.");

// ---------------------------------------------------------------------------
// Output shapes: loose, mostly optional. The API may add fields; a null where
// the API can send one is declared nullish.
// ---------------------------------------------------------------------------

const BALANCE_OUT = loose({
  funded_credits: z.number().nullish().describe("Credits added to the balance in total."),
  credit_line_credits: z.number().nullish().describe("How far the balance may run below zero. Usually 0."),
  spent_credits: z.number().nullish().describe("Credits users have spent from the balance in total."),
  balance_credits: z.number().nullish().describe("The credits you can give users now."),
  available_credits: z.number().nullish().describe("The balance plus the credit line. The credit line cannot be given out."),
  funded_micro: z.number().nullish().describe("As funded_credits, in millionths of a credit."),
  credit_line_micro: z.number().nullish(),
  spent_micro: z.number().nullish(),
  balance_micro: z.number().nullish(),
  available_micro: z.number().nullish(),
});

const SUMMARY_OUT = loose({
  partner: z.boolean().nullish(),
  org_id: z.string().nullish(),
  free_credits: z.number().nullish().describe("Free credits per user per month, from your account settings."),
  workspace_daily_limit: z.number().nullish().describe("How many new users you may add per day."),
  workspace_count: z.number().nullish(),
  limits: loose({
    max_requests_per_minute: z.number().nullish(),
    max_concurrency: z.number().nullish(),
    max_free_credits: z.number().nullish(),
  }).nullish().describe("The most a tier may set for each limit."),
  users: loose({
    total: z.number().nullish(),
    active: z.number().nullish(),
    suspended: z.number().nullish(),
  }).nullish(),
  caps: loose({
    committed: z.number().nullish().describe("The sum of the caps of active users, in whole credits."),
    uncapped_users: z.number().nullish().describe("Active users with no cap."),
  }).nullish(),
  balance: BALANCE_OUT.nullish(),
});

const TIER_REF_OUT = loose({
  id: z.string().nullish(),
  name: z.string().nullish(),
});

const WORKSPACE_OUT = loose({
  workspace_id: z.string().nullish().describe("Spicrawl's id for the user's workspace."),
  external_user_id: z.string().nullish().describe("Your id for the user."),
  display_name: z.string().nullish().describe("The label you set for the user, or null."),
  status: z.string().nullish().describe("active, suspended, closed or deleted."),
  created_at: z.string().nullish(),
  free_credits: z.number().nullish().describe("Free credits this user gets each month."),
  free_used: z.number().nullish().describe("Free credits this user has used this month."),
  wallet_cap: z.number().nullish().describe("The cap: most whole credits this user may take from the balance per month. null for no cap."),
  wallet_cap_source: z.string().nullish().describe("Where the cap comes from: tier, workspace, account_default or none."),
  wallet_used: z.number().nullish().describe("Whole credits this user has taken from the balance this month."),
  wallet_used_source: z.string().nullish().describe("live, rollup (from usage records, which trail by about a minute) or null."),
  window_resets_at: z.string().nullish().describe("When this user's current month ends."),
  own_credits: z.number().nullish().describe("Credits given to this user that are left. They are spent before the balance."),
  tier: TIER_REF_OUT.nullish(),
  requests_per_minute: z.number().nullish(),
  concurrency: z.number().nullish(),
});

const USERS_LIST_OUT = loose({
  workspaces: z.array(WORKSPACE_OUT).nullish().describe("The users on this page."),
  next_after: z.string().nullish().describe("Pass as `after` for the next page (default sort)."),
  next_offset: z.number().nullish().describe("Pass as `offset` for the next page (sort `wallet_used`)."),
});

const TIER_OUT = loose({
  id: z.string().nullish(),
  name: z.string().nullish(),
  requests_per_minute: z.number().nullish(),
  concurrency: z.number().nullish(),
  free_credits: z.number().nullish(),
  wallet_cap: z.number().nullish().describe("The cap: most whole credits per month a user on this tier may take from the balance. null for none."),
  default: z.boolean().nullish().describe("true on the tier new users start on."),
  workspaces: z.number().nullish().describe("Live users on this tier."),
  created_at: z.string().nullish(),
  updated_at: z.string().nullish(),
});

const TIERS_LIST_OUT = loose({
  tiers: z.array(TIER_OUT).nullish(),
});

// Usage: the API's micro fields, plus the whole-credit fields this server adds.
const USAGE_FIELDS = {
  requests: z.number().nullish(),
  requests_failed: z.number().nullish(),
  credits_micro: z.number().nullish().describe("Credits in millionths (12000000 is 12 credits)."),
  credits_wallet_micro: z.number().nullish().describe("Part of credits_micro paid from the balance, in millionths."),
  credits_own_micro: z.number().nullish().describe("Part of credits_micro paid from credits given to the user, in millionths."),
  credits: z.number().nullish().describe("Whole credits in total (rounded down). Added by this server."),
  credits_from_balance: z.number().nullish().describe("Whole credits paid from the balance. Added by this server."),
  credits_given_spent: z.number().nullish().describe("Whole credits paid from credits given to users. Added by this server."),
  credits_free: z.number().nullish().describe("Whole credits paid from free monthly credits. Added by this server. The three parts add up to credits."),
};

const USAGE_TOTALS_OUT = loose(USAGE_FIELDS);

const USAGE_ROW_OUT = loose({
  ...USAGE_FIELDS,
  day: z.string().nullish().describe("The day (group_by day)."),
  external_user_id: z.string().nullish().describe("The user (group_by workspace)."),
  workspace_id: z.string().nullish(),
});

const USAGE_OUT = loose({
  period: loose({
    start: z.string().nullish(),
    end: z.string().nullish(),
    bounds: z.string().nullish(),
    days: z.number().nullish(),
  }).nullish(),
  group_by: z.string().nullish(),
  totals: USAGE_TOTALS_OUT.nullish(),
  rows: z.array(USAGE_ROW_OUT).nullish(),
  page: loose({ next_offset: z.number().nullish() }).nullish(),
});

const USER_USAGE_OUT = loose({
  external_user_id: z.string().nullish(),
  period: USAGE_OUT.shape.period,
  totals: USAGE_TOTALS_OUT.nullish(),
  rows: z.array(USAGE_ROW_OUT).nullish(),
});

const GIVE_OUT = loose({
  external_user_id: z.string().nullish(),
  credits: z.number().nullish().describe("Credits requested."),
  applied: z.boolean().nullish().describe("false when this idempotency_key was already applied: nothing moved."),
  user_credits: z.number().nullish().describe("Credits given to this user that are left."),
  balance_available: z.number().nullish().describe("What you can still give, in whole credits."),
  idempotency_key: z.string().describe("The key used. Reuse it to retry this same assignment safely."),
  message: z.string().describe("What happened, in one sentence."),
});

const DELETED_OUT = loose({
  deleted: z.boolean().describe("Always true on success."),
  tier_id: z.string(),
});

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const WRITE_IDEMPOTENT = { ...WRITE, idempotentHint: true };
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };
const DESTRUCTIVE_IDEMPOTENT = { ...DESTRUCTIVE, idempotentHint: true };

export const registerPartnerTools: RegisterTools = (server, client) => {
  // -------------------------------------------------------------------------
  // Read-only
  // -------------------------------------------------------------------------

  server.registerTool(
    "spicrawl_partner_summary",
    {
      title: "Partner account summary",
      description:
        "Your partner account at a glance, in one call: how many users you have and how many are active or suspended, the free " +
        "credits each user gets per month, the most your tiers may set, how much of your balance is already committed to users' " +
        "caps (`caps.committed`), and your balance. Call it first, to orient yourself. Read-only.",
      inputSchema: {},
      outputSchema: SUMMARY_OUT,
      annotations: READ,
    },
    async () => run(() => client.request("GET", "/v1/partner/summary")),
  );

  server.registerTool(
    "spicrawl_partner_balance",
    {
      title: "Partner balance",
      description:
        "Your balance: the credits you can give to users (`balance_credits`), the total you have added (`funded_credits`), what " +
        "users have spent from it (`spent_credits`), and `available_credits`, which also counts a credit line you cannot give out. " +
        "Check it before giving credits. Amounts are whole credits; the `*_micro` fields are millionths of a credit. Read-only.",
      inputSchema: {},
      outputSchema: BALANCE_OUT,
      annotations: READ,
    },
    async () => run(() => client.request("GET", "/v1/partner/wallet")),
  );

  server.registerTool(
    "spicrawl_partner_users_list",
    {
      title: "List partner users",
      description:
        "List your users, one page at a time. Each item is one user's workspace: their id (`external_user_id`), status, tier, free " +
        "credits used this month, their cap and what they have taken from the balance this month. Search with `q`, which matches " +
        "ids that start with the text. `sort` `wallet_used` lists the heaviest users of the balance first (page with `offset`); the " +
        "default lists by id (page with `after`). Use this to find users; use spicrawl_partner_user_get for a user you already know. Read-only.",
      inputSchema: {
        limit: pageLimit.optional(),
        after: z.string().min(1).max(128).optional().describe("The `next_after` from the last page. Only with the default sort."),
        q: z
          .string()
          .min(1)
          .max(128)
          .regex(/^[A-Za-z0-9._:-]+$/, "letters, digits, '.', '_', ':' and '-' only")
          .optional()
          .describe("Only users whose id starts with this text (case-sensitive)."),
        sort: z.enum(["external_user_id", "wallet_used"]).optional().describe("`external_user_id` (default), or `wallet_used`: the largest use of the balance this month first."),
        offset: pageOffset.optional(),
      },
      outputSchema: USERS_LIST_OUT,
      annotations: READ,
    },
    async ({ limit, after, q, sort, offset }) =>
      run(() => client.request("GET", withQuery("/v1/partner/workspaces", { limit, after, q, sort, offset }))),
  );

  server.registerTool(
    "spicrawl_partner_user_get",
    {
      title: "Get a partner user",
      description:
        "Read one user's workspace by their `external_user_id`: status, tier, free credits and how many are used this month, the cap " +
        "(most credits this user may take from the balance per month), `own_credits` (credits you gave them that are left, spent before " +
        "the balance), and the tier's requests per minute and concurrency. Read-only.",
      inputSchema: { external_user_id: externalUserId },
      outputSchema: WORKSPACE_OUT,
      annotations: READ,
    },
    async ({ external_user_id }) => run(() => client.request("GET", userPath(external_user_id))),
  );

  server.registerTool(
    "spicrawl_partner_usage",
    {
      title: "Partner usage",
      description:
        "Usage across all your users over a date window: the totals, then one row per day (`group_by` `day`, the default) or one row per " +
        "user (`group_by` `workspace`, sorted by `sort`: credits, requests, fail_rate or last_active; paged with `offset`). Dates are " +
        "UTC; `to` is exclusive; the default is the last 30 days and the window may be at most 400 days. Credits come in two forms: " +
        "`credits_micro` (millionths of a credit) and whole-credit fields this tool adds, which always add up: `credits` = " +
        "`credits_from_balance` + `credits_given_spent` + `credits_free`. `credits_from_balance` was paid from your balance, " +
        "`credits_given_spent` from credits you gave users, `credits_free` from free monthly credits. Read-only.",
      inputSchema: {
        group_by: z.enum(["day", "workspace"]).optional().describe("day (default): one row per day. workspace: one row per user."),
        from,
        to,
        limit: pageLimit.optional(),
        sort: z.enum(["credits", "requests", "fail_rate", "last_active"]).optional().describe("Order of the rows with group_by workspace. Default credits."),
        offset: pageOffset.optional(),
      },
      outputSchema: USAGE_OUT,
      annotations: READ,
    },
    async ({ group_by, from, to, limit, sort, offset }) =>
      run(async () =>
        withCreditParts(
          await client.request("GET", withQuery("/v1/partner/usage", { group_by, from, to, limit, sort, offset })),
        ),
      ),
  );

  server.registerTool(
    "spicrawl_partner_user_usage",
    {
      title: "Usage for one partner user",
      description:
        "Usage for one user over a date window: the totals and one row per day, with the same credit fields as spicrawl_partner_usage. " +
        "Use it to answer what one user spent. Dates are UTC; `to` is exclusive. Read-only.",
      inputSchema: { external_user_id: externalUserId, from, to },
      outputSchema: USER_USAGE_OUT,
      annotations: READ,
    },
    async ({ external_user_id, from, to }) =>
      run(async () =>
        withCreditParts(await client.request("GET", withQuery(userPath(external_user_id, "/usage"), { from, to }))),
      ),
  );

  server.registerTool(
    "spicrawl_partner_tiers_list",
    {
      title: "List partner tiers",
      description:
        "List your tiers, the default first. A tier is a named set of limits you give to users: requests per minute, requests running at " +
        "once, free credits per user per month, and the cap (most credits per month a user on it may take from the balance; null means " +
        "none set by the tier). `workspaces` counts the users on each tier. Read-only.",
      inputSchema: {},
      outputSchema: TIERS_LIST_OUT,
      annotations: READ,
    },
    async () => run(() => client.request("GET", "/v1/partner/tiers")),
  );

  // -------------------------------------------------------------------------
  // Changes that are not destructive
  // -------------------------------------------------------------------------

  server.registerTool(
    "spicrawl_partner_tier_create",
    {
      title: "Create a partner tier",
      description:
        "Create a tier: a named set of limits that users can be moved to. Requires a name, requests per minute, requests running at once " +
        "and free credits per user per month. `wallet_cap` is the cap: the most whole credits per month a user on it may take from the " +
        "balance (omit it or send null for no cap set by the tier). The first tier you create becomes the default, the tier new users " +
        "start on; send `default: true` to make a later one the default. A limit above your account's maximum is refused and the " +
        "message gives the maximum. Changes reach requests within about a minute. Does not move any user.",
      inputSchema: {
        name: tierName,
        requests_per_minute: requestsPerMinute,
        concurrency,
        free_credits: freeCredits,
        wallet_cap: cap.optional(),
        default: defaultTier.optional(),
      },
      outputSchema: TIER_OUT,
      annotations: WRITE,
    },
    async ({ name, requests_per_minute, concurrency, free_credits, wallet_cap, default: isDefault }) =>
      run(() => {
        const body: Obj = { name, requests_per_minute, concurrency, free_credits };
        if (wallet_cap !== undefined) body.wallet_cap = wallet_cap;
        if (isDefault !== undefined) body.default = isDefault;
        return client.request("POST", "/v1/partner/tiers", body);
      }),
  );

  server.registerTool(
    "spicrawl_partner_tier_update",
    {
      title: "Update a partner tier",
      description:
        "Change one or more fields of a tier. Send only the fields to change; at least one is needed. Send `wallet_cap: null` to remove the " +
        "cap (the cap is the most whole credits per month a user on the tier may take from the balance). `default: true` makes this tier " +
        "the default. Users already on the tier follow the new limits within about a minute. Use spicrawl_partner_tiers_list to find the id.",
      inputSchema: {
        tier_id: tierId,
        name: tierName.optional(),
        requests_per_minute: requestsPerMinute.optional(),
        concurrency: concurrency.optional(),
        free_credits: freeCredits.optional(),
        wallet_cap: cap.optional(),
        default: defaultTier.optional(),
      },
      outputSchema: TIER_OUT,
      annotations: WRITE_IDEMPOTENT,
    },
    async ({ tier_id, ...fields }) =>
      run(() => {
        const body: Obj = {};
        for (const [k, v] of Object.entries(fields)) if (v !== undefined) body[k] = v;
        if (Object.keys(body).length === 0) throw new Error("Nothing to change: give at least one field to update.");
        return client.request("PATCH", tierPath(tier_id), body);
      }),
  );

  server.registerTool(
    "spicrawl_partner_user_set_tier",
    {
      title: "Move a partner user to a tier",
      description:
        "Move one user to another tier, by the tier's id or name. Their requests per minute, concurrency, free credits and cap follow " +
        "the new tier within about a minute. Moving a user does not change their credits. Read the tier list first with " +
        "spicrawl_partner_tiers_list.",
      inputSchema: { external_user_id: externalUserId, tier: tierRef },
      outputSchema: WORKSPACE_OUT,
      annotations: WRITE_IDEMPOTENT,
    },
    async ({ external_user_id, tier }) =>
      run(() => client.request("PUT", userPath(external_user_id, "/tier"), { tier })),
  );

  server.registerTool(
    "spicrawl_partner_user_update",
    {
      title: "Rename a partner user",
      description:
        "Set the label for one user, `display_name`, for your own records (1 to 100 characters). Send null to clear it. Nothing else " +
        "about the user changes.",
      inputSchema: {
        external_user_id: externalUserId,
        display_name: z.string().min(1).max(100).nullable().describe("The label, 1 to 100 characters, or null to clear it."),
      },
      outputSchema: WORKSPACE_OUT,
      annotations: WRITE_IDEMPOTENT,
    },
    async ({ external_user_id, display_name }) =>
      run(() => client.request("PATCH", userPath(external_user_id), { display_name })),
  );

  server.registerTool(
    "spicrawl_partner_user_reactivate",
    {
      title: "Reactivate a partner user",
      description:
        "Reactivate a user you suspended with spicrawl_partner_user_suspend, so their key works again (within about a minute). Only a " +
        "suspension made through this API can be reversed this way; one Spicrawl made is refused, and support must lift it.",
      inputSchema: { external_user_id: externalUserId },
      outputSchema: WORKSPACE_OUT,
      annotations: WRITE_IDEMPOTENT,
    },
    async ({ external_user_id }) => run(() => client.request("POST", userPath(external_user_id, "/reactivate"))),
  );

  // -------------------------------------------------------------------------
  // Destructive: confirm with the person first
  // -------------------------------------------------------------------------

  server.registerTool(
    "spicrawl_partner_give_credits",
    {
      title: "Give credits to a partner user",
      description:
        "Give credits from your balance to one user. This moves the credits now and cannot be undone with this server. The user spends " +
        "them after their free credits and before the balance, and they do not reset each month. Confirm the user and the amount with the " +
        "person first. `idempotency_key` (8 to 100 characters, no spaces) makes a retry safe: the same key with the same user and amount " +
        "moves nothing and reports `applied: false`. When it is left out a new key is generated and returned as `idempotency_key`; keep it " +
        "if the call may need retrying. A key already used for another amount or user is refused. More than your balance is refused, and " +
        "the message gives the exact figure.",
      inputSchema: {
        external_user_id: externalUserId,
        credits: z.number().int().min(1).max(100_000_000).describe("Whole credits to give, 1 to 100000000."),
        idempotency_key: z
          .string()
          .regex(/^\S{8,100}$/, "8 to 100 characters with no spaces")
          .optional()
          .describe("A key for this one assignment, 8 to 100 characters, no spaces. Omit it to have one generated. Reuse the same key only to retry the same assignment."),
      },
      outputSchema: GIVE_OUT,
      annotations: DESTRUCTIVE,
    },
    async ({ external_user_id, credits, idempotency_key }) => {
      const key = idempotency_key ?? randomUUID();
      return run(async () => {
        const data = await client.request("POST", userPath(external_user_id, "/credits"), { credits, idempotency_key: key });
        const r = isObj(data) ? data : {};
        const applied = r.applied !== false;
        const message = applied
          ? `Gave ${credits} credits to ${external_user_id}. Their given credits are now ${r.user_credits ?? "unknown"}; ${r.balance_available ?? "unknown"} credits remain to give.`
          : `Nothing moved: this idempotency_key was already applied to ${external_user_id} for this amount, so the earlier assignment stands.`;
        return { ...r, external_user_id, credits, applied, idempotency_key: key, message };
      });
    },
  );

  server.registerTool(
    "spicrawl_partner_tier_delete",
    {
      title: "Delete a partner tier",
      description:
        "Delete a tier, for good. Refused while users are on it (the message gives how many; move them first with " +
        "spicrawl_partner_user_set_tier), and refused for the default tier while other tiers exist. Make another tier the default first. " +
        "The tier's limits are gone and cannot be restored. Confirm with the person first.",
      inputSchema: { tier_id: tierId },
      outputSchema: DELETED_OUT,
      annotations: DESTRUCTIVE,
    },
    async ({ tier_id }) =>
      run(async () => {
        await client.request("DELETE", tierPath(tier_id));
        return { deleted: true, tier_id };
      }),
  );

  server.registerTool(
    "spicrawl_partner_user_suspend",
    {
      title: "Suspend a partner user",
      description:
        "Suspend one user: their key stops serving requests within about a minute, so their end users lose Spicrawl access through your " +
        "platform. Reverse it with spicrawl_partner_user_reactivate. Confirm with the person first.",
      inputSchema: { external_user_id: externalUserId },
      outputSchema: WORKSPACE_OUT,
      annotations: DESTRUCTIVE_IDEMPOTENT,
    },
    async ({ external_user_id }) => run(() => client.request("POST", userPath(external_user_id, "/suspend"))),
  );
};
