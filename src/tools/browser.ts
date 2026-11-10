import { z } from "zod";
import { loose, run, type RegisterTools } from "./common.js";

// Browser (CDP): GET /v1/browser is a WebSocket; MCP cannot carry it, so this
// module mints a single-use token URL for the caller's own CDP client, and
// hands a person the live view of that session when the agent needs help.
const sessionPath = (id: string) => `/v1/browser/sessions/${encodeURIComponent(id)}`;

const browserSessionId = z
  .string()
  .regex(/^bs[0-9a-f]{24}$/)
  .describe("The remote browser session, as `session_id` from spicrawl_browser_connect_url. It exists while that connection is open.");

const controlState = loose({
  session_id: z.string().describe("The remote browser session."),
  status: z.string().optional().describe("`running` while the connection is open."),
  controller: z.string().describe("Who drives the browser: `agent` (your CDP connection) or `human` (a person in the live view)."),
  expires_at: z.string().optional().describe("When the session ends at the latest, RFC 3339 UTC."),
});

export const registerBrowserTools: RegisterTools = (server, client) => {
  server.registerTool(
    "spicrawl_browser_connect_url",
    {
      title: "Browser (CDP) connect URL",
      description:
        "Mints a single-use connect URL for Spicrawl's remote browser (GET /v1/browser, a DevTools Protocol (CDP) WebSocket) so YOUR code can drive it " +
        "with any CDP client, using the URL as the browser WebSocket endpoint. It calls POST /v1/browser/token and returns a " +
        "ws:// or wss:// URL carrying a short-lived token, never the API key: the URL works ONCE, within 60 seconds, and only with the options " +
        "given here (editing them in the URL is refused), so call this right before connecting and again for every new session. " +
        "Prefer sending the key as an Authorization header when the client supports headers on the WebSocket upgrade: " +
        "then connect to the plain /v1/browser URL " +
        "with 'Authorization: Bearer <key>' and no token is needed. The key must carry the `browser` scope. Parameter errors are reported when minting. " +
        "The result's `session_id` names the session once connected: when a page needs a person (a login, a one-time code, a captcha), " +
        "pass it to spicrawl_browser_live_view for a link they can open, and to spicrawl_browser_control to see when they hand control back.",
      inputSchema: {
        engine: z
          .enum(["browser", "js"])
          .optional()
          .describe("Rendering tier of the remote browser: `browser` (full browser, full protocol; the default) or `js` (lighter JavaScript rendering with a smaller protocol surface). A tier your plan does not include is refused."),
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
        proxy: z
          .string()
          .optional()
          .describe("Your own proxy, as http://user:pass@host:port. Replaces our pool, so proxy_country, proxy_region and sticky_key cannot be combined with it. Kept out of the returned URL."),
      },
      outputSchema: loose({
        url: z.string().describe("ws:// or wss:// connect URL carrying a single-use token (never the API key); use it as the CDP browser WebSocket endpoint."),
        expires_at: z.string().optional().describe("When the token expires, RFC 3339 UTC (60 s after minting)."),
        single_use: z.boolean().describe("Always true: the URL works for one connection."),
        session_id: z.string().optional().describe("Names the session once connected; for spicrawl_browser_live_view and spicrawl_browser_control."),
        notes: z.array(z.string()).optional().describe("Usage notes for the connect URL."),
      }),
      // Mints a token (state) and opens a browser that can go anywhere on the web.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) =>
      run(async () => {
        if (args.proxy_country && args.proxy_region && args.proxy_region.toLowerCase() !== "global") {
          throw new Error("Send either proxy_country or proxy_region, not both: they choose the same thing.");
        }
        const body: Record<string, unknown> = {};
        if (args.engine) body.engine = args.engine;
        if (args.proxy_country) body.proxy_country = args.proxy_country;
        if (args.proxy_region) body.proxy_region = args.proxy_region;
        if (args.sticky_key) body.sticky_key = args.sticky_key;
        if (args.session_ttl !== undefined) body.session_ttl = args.session_ttl;
        if (args.proxy) body.proxy = args.proxy;
        const minted = (await client.request("POST", "/v1/browser/token", body)) as {
          path?: string;
          expires_at?: string;
          session_id?: string;
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
          expires_at: minted.expires_at,
          single_use: true,
          session_id: minted.session_id,
          notes: [
            "Use `url` as the browser WebSocket endpoint of any CDP client.",
            "The URL carries a single-use token, not your API key. It expires 60 s after minting and works for one connection; mint a new one per session.",
            "If your client can set headers on the WebSocket upgrade, you can instead connect to /v1/browser with 'Authorization: Bearer <key>'.",
            "Requires a key with the `browser` scope.",
            "When a page needs a person, call spicrawl_browser_live_view with session_id and send them the link.",
            "The session ends after session_ttl seconds (default 180) or when you disconnect.",
          ],
        };
      }),
  );

  server.registerTool(
    "spicrawl_browser_live_view",
    {
      title: "Live view link for a remote browser",
      description:
        "Gets a link a person can open to watch the remote browser your CDP connection is driving, and take control of it: the same tabs, " +
        "cookies and page. Use it when a page needs a human: a login, a one-time code, a captcha. Send them `live_view_url`; they press " +
        "\"Take control\", do the step, and give control back. While they have it, your connection's input and navigation commands fail with " +
        "error -32001 (reading the page still works); poll spicrawl_browser_control (action `status`) until `controller` is `agent`, then carry on. " +
        "The link works once and must be opened within 60 seconds; ask again for a new one. The session must still be connected. " +
        "Watching costs nothing beyond the session itself.",
      inputSchema: { session_id: browserSessionId },
      outputSchema: loose({
        session_id: z.string().describe("The remote browser session."),
        live_view_url: z.string().describe("A page a person opens in their browser to watch and take control. Single use, open within 60 s."),
        live_url: z.string().optional().describe("The bare live-view WebSocket, for building your own viewer."),
        expires_in: z.number().int().optional().describe("Seconds the link stays valid if not opened (60)."),
        single_use: z.boolean().optional().describe("Always true."),
      }),
      // Mints a single-use viewer token (state); hands out access to a page anywhere on the web.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) =>
      run(async () => {
        const live = (await client.request("POST", `${sessionPath(args.session_id)}/live`)) as Record<string, unknown>;
        return publicLinks(live, client.publicBaseURL);
      }),
  );

  server.registerTool(
    "spicrawl_browser_control",
    {
      title: "Who controls a remote browser",
      description:
        "Reads or changes who drives a connected remote browser: `agent` (your CDP connection) or `human` (a person in its live view, see " +
        "spicrawl_browser_live_view). `status` reads it: poll it after sending a live-view link, and continue once `controller` is `agent` again. " +
        "`takeover` hands control to the person before they ask (your input and navigation then fail with error -32001); `release` takes it back. " +
        "The person can also take and give back control from the live view themselves.",
      inputSchema: {
        session_id: browserSessionId,
        action: z.enum(["status", "takeover", "release"]).optional().describe("`status` (default) reads; `takeover` gives control to the person; `release` gives it back to the agent."),
      },
      outputSchema: controlState,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) =>
      run(async () => {
        const action = args.action ?? "status";
        const path = sessionPath(args.session_id);
        return (action === "status"
          ? await client.request("GET", path)
          : await client.request("POST", `${path}/${action}`)) as Record<string, unknown>;
      }),
  );
};

// The API builds live-view links from its own view of its host; a hosted MCP
// reaches it over loopback, so they are rebuilt on the public base, keeping
// the path, query and fragment (the fragment carries the socket URL).
function publicLinks(live: Record<string, unknown>, publicBase: string): Record<string, unknown> {
  const base = new URL(publicBase.replace(/\/+$/, "") + "/");
  const prefix = base.pathname.replace(/\/+$/, "");
  const rebase = (raw: unknown, ws: boolean): unknown => {
    if (typeof raw !== "string") return raw;
    const u = new URL(raw);
    const v1 = u.pathname.indexOf("/v1/");
    if (v1 < 0) return raw;
    const out = new URL(base.toString());
    out.pathname = prefix + u.pathname.slice(v1);
    out.search = u.search;
    if (ws) out.protocol = base.protocol === "https:" ? "wss:" : "ws:";
    return out.toString().replace(/#.*$/, "");
  };
  const socket = rebase(live.live_url, true);
  let page = live.live_view_url;
  if (typeof socket === "string" && typeof page === "string") {
    page = String(rebase(page, false)) + "#" + encodeURIComponent(socket);
  }
  return { ...live, live_url: socket, live_view_url: page };
}
