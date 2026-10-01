import { z } from "zod";
import { run, type RegisterTools } from "./common.js";

// Browser (CDP): GET /v1/browser is a WebSocket; MCP cannot carry it, so this
// module mints a single-use token URL for the caller's own Puppeteer/Playwright.
export const registerBrowserTools: RegisterTools = (server, client) => {
  server.registerTool(
    "spicrawl_browser_connect_url",
    {
      title: "Browser (CDP) connect URL",
      description:
        "Coming soon: remote browsers are not available yet, so minting fails; do not rely on this tool. For scripted page " +
        "interaction today use `actions` on spicrawl_scrape. " +
        "Mints a single-use connect URL for Spicrawl's remote browser (GET /v1/browser, Chrome DevTools Protocol) so YOUR code can drive it with " +
        "puppeteer.connect({ browserWSEndpoint }) or playwright.chromium.connectOverCDP(url). It calls POST /v1/browser/token and returns a " +
        "ws:// or wss:// URL carrying a short-lived token, never the API key: the URL works ONCE, within 60 seconds, and only with the options " +
        "given here (editing them in the URL is refused), so call this right before connecting and again for every new session. " +
        "Prefer sending the key as an Authorization header when the client supports headers on the upgrade " +
        "(playwright connectOverCDP(url, { headers }), puppeteer.connect({ browserWSEndpoint, headers })): then connect to the plain /v1/browser URL " +
        "with 'Authorization: Bearer <key>' and no token is needed. The endpoint exists only when the deployment was installed with --with-cdp, " +
        "and the key must carry the `browser` scope; otherwise minting fails (404 or 403). Parameter errors are reported when minting.",
      inputSchema: {
        engine: z
          .enum(["chromium", "obscura"])
          .optional()
          .describe("Browser engine. Default: the deployment's default (chromium). 'obscura' cannot run headful."),
        proxy_country: z
          .string()
          .regex(/^[a-z]{2}$/)
          .optional()
          .describe("Exit country, ISO-3166 alpha-2 lowercase (e.g. 'de'). Mutually exclusive with proxy_region."),
        proxy_region: z
          .string()
          .optional()
          .describe("Broader exit region/pool name; 'global' means no constraint. Mutually exclusive with proxy_country."),
        sticky_key: z
          .string()
          .regex(/^[A-Za-z0-9-]{2,64}$/)
          .optional()
          .describe("Keep one exit IP for the session under this key (2-64 letters, digits, hyphens). Omit to rotate (the default)."),
        session_ttl: z
          .number()
          .int()
          .min(60)
          .max(900)
          .optional()
          .describe("Session lifetime in seconds, 60-900. Default 180."),
        headless: z
          .boolean()
          .optional()
          .describe("false = headful browser with a display (desktop-sized screen). Omit for the deployment default."),
        proxy: z
          .string()
          .optional()
          .describe("Your own proxy, as http://user:pass@host:port. Replaces our pool, so proxy_country, proxy_region and sticky_key cannot be combined with it. Kept out of the returned URL."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) =>
      run(async () => {
        if (args.proxy_country && args.proxy_region && args.proxy_region.toLowerCase() !== "global") {
          throw new Error("Send either proxy_country or proxy_region, not both: they choose the same thing.");
        }
        if (args.engine === "obscura" && args.headless === false) {
          throw new Error("engine=obscura cannot run headful (headless=false). Use engine=chromium or drop headless.");
        }
        const body: Record<string, unknown> = {};
        if (args.engine) body.engine = args.engine;
        if (args.proxy_country) body.proxy_country = args.proxy_country;
        if (args.proxy_region) body.proxy_region = args.proxy_region;
        if (args.sticky_key) body.sticky_key = args.sticky_key;
        if (args.session_ttl !== undefined) body.session_ttl = args.session_ttl;
        if (args.headless !== undefined) body.headless = args.headless;
        if (args.proxy) body.proxy = args.proxy;
        const minted = (await client.request("POST", "/v1/browser/token", body)) as {
          path?: string;
          expires_at?: string;
        };
        if (!minted?.path || !minted.path.startsWith("/v1/browser?")) {
          throw new Error("The API did not return a browser token path.");
        }
        // The public base, not the upstream one: a hosted MCP reaches the API
        // over loopback, and a ws://127.0.0.1 URL is useless to a remote caller.
        // Concatenated, not resolved: an absolute path would drop a prefix in the base.
        const url = new URL(client.publicBaseURL.replace(/\/+$/, "") + minted.path);
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        const ws = url.toString();
        return {
          url: ws,
          puppeteer: `const browser = await puppeteer.connect({ browserWSEndpoint: ${JSON.stringify(ws)} });`,
          playwright: `const browser = await chromium.connectOverCDP(${JSON.stringify(ws)});`,
          expires_at: minted.expires_at,
          single_use: true,
          notes: [
            "The URL carries a single-use token, not your API key. It expires 60 s after minting and works for one connection; mint a new one per session.",
            "If your client can set headers on the WebSocket upgrade, you can instead connect to /v1/browser with 'Authorization: Bearer <key>'.",
            "Requires a deployment installed with --with-cdp and a key with the `browser` scope.",
            "The session ends after session_ttl seconds (default 180) or when you disconnect.",
          ],
        };
      }),
  );
};
