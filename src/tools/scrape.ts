import { z } from "zod";
import { COMING_SOON, run, type RegisterTools } from "./common.js";
import { attachScreenshots } from "./screenshots.js";
import { attachPdf } from "./pdf.js";
import { ActionsSchema, toApiActions } from "./actions.js";

export const registerScrapeTools: RegisterTools = (server, client) => {
// ---------------------------------------------------------------------------
// spicrawl_scrape — retrieve, render, and extract one URL
// ---------------------------------------------------------------------------

const ScrapeInput = {
  url: z.string().url().describe("The absolute URL to retrieve."),
  render: z
    .boolean()
    .default(false)
    .describe(
      "Render with a real browser (executes JavaScript). Use for single-page apps or pages whose content is painted client-side. Costs more than the default fetch tier.",
    ),
  format: z
    .enum(["markdown", "text", "html", "json", "pdf"])
    .default("markdown")
    .describe(
      "Output format. 'markdown' (default) is best for feeding to an LLM; 'html' returns the raw document; 'json' returns a structured envelope; " +
        "'pdf' prints the page in a browser and returns the file as a resource content block (needs `render` or `engine: \"chromium\"`).",
    ),
  main_content_only: z
    .boolean()
    .optional()
    .describe(
      "Strip the page to its main article, dropping nav/footer/aside (like Firecrawl's onlyMainContent). Defaults on for markdown.",
    ),
  include_tags: z
    .array(z.string())
    .optional()
    .describe("CSS selectors to KEEP (everything else is dropped)."),
  exclude_tags: z
    .array(z.string())
    .optional()
    .describe("CSS selectors to remove (e.g. ['nav','.ad','#cookie'])."),
  links: z
    .boolean()
    .default(false)
    .describe("Also return the page's discovered links as an absolute, de-duplicated list."),
  extract: z
    .record(z.any())
    .optional()
    .describe(
      'Selector-based extraction: a map of field -> CSS/XPath selector, e.g. {"title":"h1","price":".amount"}. Returns structured `data`. Precise and cheap when you know the page structure.',
    ),
  ai_extract: z
    .object({
      prompt: z.string().optional().describe("Describe the data to pull, in plain language."),
      schema: z.record(z.any()).optional().describe("Optional JSON schema for typed output."),
    })
    .strict() // closed set: an unknown key here is refused, like a top-level one
    .optional()
    .describe(
      COMING_SOON +
        "Model-driven extraction: describe what you want and let a model find it, no selectors. Refused with ERR::INTERNAL::UNAVAILABLE until it launches; use `extract` or `autoparse`.",
    ),
  screenshot: z.boolean().default(false).describe("Capture a screenshot (requires render)."),
  impersonate: z
    .boolean()
    .optional()
    .describe(
      "Fetch tier only: present a real browser's TLS/JA3 + HTTP/2 fingerprint to clear passive bot gates. On by default; set false to send a plain client handshake.",
    ),
  premium_proxy: z
    .boolean()
    .default(false)
    .describe(COMING_SOON + "Use a residential exit from Spicrawl's managed pool instead of datacenter. Until then, pass your own `proxy`."),
  proxy_country: z
    .string()
    .length(2)
    .optional()
    .describe(COMING_SOON + "ISO-3166 alpha-2 country for a managed-pool exit, lowercase (e.g. 'us', 'de')."),
  proxy: z
    .string()
    .optional()
    .describe("Your own proxy URL to egress through. Takes precedence over the pool; no surcharge."),
  cache: z
    .boolean()
    .optional()
    .describe("Serve a recent cached result if fresh (on by default). A hit is billed at the same price as the fetch that stored it: the cache saves time, not credits. Set false only when you need live data."),
  cache_ttl: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Max age in seconds of a cached copy to accept (0 forces a fresh fetch; capped at 48h). Freshness only: a hit is billed like a fetch."),
  wait: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Milliseconds to wait after load before capturing (render only)."),
  // --- The rest of POST /v1/scrape, under the API's own names (passed through).
  engine: z
    .enum(["fetch", "obscura", "chromium", "camoufox"])
    .optional()
    .describe("Pin the execution engine instead of letting the router choose. A pinned engine the deployment does not run is refused (ERR::ENGINE::UNAVAILABLE), never substituted. `camoufox` is coming soon: do not pin it yet."),
  mode: z.enum(["auto"]).optional().describe("Routing mode. `auto` lets the platform escalate fetch -> browser as needed, billing only the rung that worked."),
  stealth: z.boolean().optional().describe(COMING_SOON + "Stealth mode: render in the hardened Camoufox browser. Default false."),
  headless: z.boolean().optional().describe("false runs Chromium on a real display (1920x1080 screen). chromium engine only."),
  method: z.string().optional().describe("HTTP method for the target request (default GET)."),
  custom_headers: z.record(z.string()).optional().describe("Extra request headers sent to the target, e.g. {\"Accept-Language\":\"de\"}."),
  session_id: z
    .string()
    .optional()
    .describe("Run inside a session from spicrawl_session_create: same exit IP and browser state (cookies, localStorage) across calls."),
  sticky_key: z.string().optional().describe(COMING_SOON + "Reuse the same managed-pool exit for every request carrying this key, without a session."),
  proxy_verify: z.boolean().optional().describe("Verify `proxy` is reachable before using it."),
  wait_for: z.string().optional().describe("CSS selector to wait for before capturing (render only)."),
  wait_for_timeout: z.number().int().min(0).optional().describe("Max milliseconds to wait for `wait_for`."),
  block_resources: z
    .array(z.string())
    .optional()
    .describe("Resource types the browser should not load, e.g. [\"fonts\",\"media\",\"images\"] (render only). Faster and cheaper."),
  actions: ActionsSchema.optional(),
  screenshot_fullpage: z.boolean().optional().describe("Capture the whole page, not just the viewport."),
  screenshot_selector: z.string().optional().describe("Capture only the element matching this CSS selector."),
  screenshot_format: z.string().optional().describe("Screenshot image format."),
  screenshot_quality: z.number().int().min(1).max(100).optional().describe("Screenshot quality 1-100 (lossy formats)."),
  autoparse: z
    .boolean()
    .optional()
    .describe("Return the structured data the page publishes about itself (JSON-LD, OpenGraph, Twitter Card, microdata). No selectors; survives redesigns."),
  extract_preset: z.string().optional().describe(COMING_SOON + "A named extraction preset instead of an inline `extract` map; any value fails today. Put the rules in `extract`."),
  network_capture: z
    .object({
      urls: z.array(z.string()).optional().describe("URL patterns of the page's own requests to record."),
      resource_types: z.array(z.string()).optional().describe("Resource types to record, e.g. [\"xhr\",\"fetch\"]."),
      include_bodies: z.boolean().optional().describe("Include response bodies."),
      max_body_bytes: z.number().int().optional().describe("Per-response body cap."),
      max_responses: z.number().int().optional().describe("Cap on recorded responses."),
    })
    .strict() // closed set: an unknown key here is refused, like a top-level one
    .optional()
    .describe("Record the API responses the PAGE fetched while rendering — often cleaner JSON than the DOM. Render only."),
  parse_pdf: z.boolean().optional().describe("Turn a PDF target into text/markdown (default true). false refuses PDFs."),
  max_cost: z.number().int().min(0).optional().describe("Refuse (rather than run) a request that would cost more than this many credits."),
  original_status: z.boolean().optional().describe("Return the target's own HTTP status instead of 200 for a successful scrape."),
  allowed_status_codes: z
    .array(z.number().int())
    .optional()
    .describe("Target statuses to treat as success instead of an error (e.g. [404] to capture a not-found page)."),
};

/**
 * API parameter names this tool exposes under a different argument name. An
 * API message saying "set `js_render=true`" is advice the agent cannot follow
 * with this tool's schema, so errors and warnings are rewritten.
 */
const SCRAPE_ARG_NAMES: Record<string, string> = { js_render: "render", response_format: "format" };

/** Arguments passed to the API unchanged: the tool uses the REST name. */
const PASSTHROUGH = [
  "engine", "mode", "stealth", "headless", "method", "custom_headers", "session_id", "sticky_key",
  "proxy_verify", "wait_for", "wait_for_timeout", "block_resources", "screenshot_fullpage",
  "screenshot_selector", "screenshot_format", "screenshot_quality", "autoparse", "extract_preset",
  "network_capture", "parse_pdf", "max_cost", "original_status", "allowed_status_codes",
] as const;

server.registerTool(
  "spicrawl_scrape",
  {
    title: "Scrape a URL",
    description:
      "Retrieve a web page and return its content as markdown (default), text, HTML, a JSON envelope, or a printed PDF. " +
      "Handles the fetch vs. browser decision, charset decoding, and PDF-to-text for you. " +
      "Optionally extract structured data with CSS selectors (`extract`) or `autoparse` (a natural-language `ai_extract` is coming soon), " +
      "return discovered `links`, take a `screenshot`, or scope the DOM with `include_tags`/`exclude_tags`. " +
      "Results are cached by default, and a cache hit is billed like the fetch that stored it (the cache saves time, not credits); set `cache=false` for time-sensitive pages. " +
      "Returns the content plus a `meta` object (engine, status, credits, cache state). " +
      "Screenshots come back as image content blocks; each `screenshots` entry in the JSON keeps its metadata and says which block holds it. " +
      "A PDF comes back as a resource content block, with its size and the engine and credits in the JSON.",
    inputSchema: ScrapeInput,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async (input) => {
    const params: Record<string, unknown> = { url: input.url, response_format: input.format };
    if (input.render) params.js_render = true;
    if (input.main_content_only !== undefined) params.main_content_only = input.main_content_only;
    if (input.include_tags?.length) params.include_tags = input.include_tags;
    if (input.exclude_tags?.length) params.exclude_tags = input.exclude_tags;
    if (input.links) params.links = true;
    if (input.extract) params.extract = input.extract;
    if (input.ai_extract) params.ai_extract = input.ai_extract;
    if (input.screenshot) params.screenshot = true;
    if (input.impersonate !== undefined) params.impersonate = input.impersonate;
    if (input.premium_proxy) params.premium_proxy = true;
    if (input.proxy_country) params.proxy_country = input.proxy_country;
    if (input.proxy) params.proxy = input.proxy;
    if (input.cache !== undefined) params.cache = input.cache;
    if (input.cache_ttl !== undefined) params.cache_ttl = input.cache_ttl;
    if (input.wait !== undefined) params.wait = input.wait;
    if (input.actions?.length) params.actions = toApiActions(input.actions);
    for (const k of PASSTHROUGH) {
      const v = (input as Record<string, unknown>)[k];
      if (v !== undefined) params[k] = v;
    }
    // Screenshots become image blocks and a PDF a resource block, in that order.
    const attach = (data: unknown) => {
      const shots = attachScreenshots(data);
      const pdf = attachPdf(shots.data, input.url, shots.blocks.length);
      return { data: pdf.data, blocks: [...shots.blocks, ...pdf.blocks] };
    };
    return run(() => client.scrape(params), attach, SCRAPE_ARG_NAMES);
  },
);
};
