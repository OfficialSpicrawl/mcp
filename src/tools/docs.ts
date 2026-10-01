import { z } from "zod";
import { run, type RegisterTools } from "./common.js";

// Documentation: the public Fumadocs site at <docs base> (client.docsBaseURL:
// https://docs.spicrawl.com, or http://host:8080/docs on a self-hosted
// deployment). Three routes, none authenticated:
//   GET <base>/api/search?query=q  Fumadocs search: SortedResult[] in page groups,
//                                  each { id, type: page|heading|text, content, url, breadcrumbs? },
//                                  `content` Markdown with <mark> highlights
//   GET <base>/<slug>.md           one page as Markdown (<base>/index.md for the root page)
//   GET <base>/llms.txt            index of every page
// The docs are public: these calls never carry the caller's API key.

const DOCS_TIMEOUT_MS = 10_000;
const MAX_PAGE_CHARS = 60_000;
const MAX_INDEX_CHARS = 60_000;
const SNIPPET_CHARS = 240;
const MATCHES_PER_PAGE = 3;
const ERROR_CODE_RE = /^ERR::([A-Z0-9_]+)::([A-Z0-9_]+)$/i;
const SLUG_RE = /^[A-Za-z0-9._~-]+(\/[A-Za-z0-9._~-]+)*$/;

interface SearchResult {
  id?: string;
  type?: string;
  content?: string;
  url?: string;
  breadcrumbs?: string[];
}

interface Match {
  heading?: string;
  snippet?: string;
  url: string;
}

interface PageHit {
  title: string;
  breadcrumbs?: string[];
  url: string;
  md_url: string;
  matches: Match[];
}

/** GETs a public docs URL with a timeout; no Authorization header, ever. */
async function docsGet(url: string, accept: string): Promise<Response> {
  try {
    return await fetch(url, { headers: { Accept: accept }, signal: AbortSignal.timeout(DOCS_TIMEOUT_MS) });
  } catch (err) {
    const why =
      err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")
        ? `timed out after ${DOCS_TIMEOUT_MS / 1000} s`
        : err instanceof Error
          ? err.message
          : String(err);
    throw new Error(
      `Could not reach the Spicrawl docs at ${url}: ${why}. The docs host may be down; retry shortly, or check SPICRAWL_DOCS_URL.`,
    );
  }
}

/** Reads a 2xx text body, or throws an error naming the status. */
async function docsText(url: string, accept: string, notFound: string): Promise<string> {
  const res = await docsGet(url, accept);
  const body = await res.text().catch(() => "");
  if (res.status === 404) throw new Error(`${notFound} (HTTP 404 from ${url}).`);
  if (!res.ok) throw new Error(`The Spicrawl docs answered HTTP ${res.status} for ${url}; retry shortly.`);
  return body;
}

/** Search-result Markdown -> plain text: drops <mark> highlights and Markdown escapes. */
function plain(s: string | undefined): string {
  return (s ?? "")
    .replace(/<\/?mark>/g, "")
    .replace(/\\([\\`*_{}[\]()#+\-.!<>|~])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

/** Where the docs lived on docs.spicrawl.com before moving to its root; old links still carry it. */
const LEGACY_PREFIX = "/docs";

/**
 * A docs page slug (no leading slash, no base path, no extension; "" for the
 * root page) from a URL path, which may carry the base's own path
 * (`/docs/guides/x` on a self-hosted base) or not (`/guides/x`). On a base at
 * the root of its host, a legacy `/docs/...` path means the same page.
 */
function slugFromPath(path: string, basePath: string): string {
  let p = `/${path.replace(/^\/+/, "")}`.replace(/\/+$/, "");
  const prefix = basePath || LEGACY_PREFIX;
  if (p === prefix || p.startsWith(`${prefix}/`)) p = p.slice(prefix.length);
  const slug = p.replace(/^\/+/, "").replace(/\.mdx?$/, "");
  return slug === "index" ? "" : slug;
}

/** The base's own path, no trailing slash: "" for https://docs.spicrawl.com, "/docs" self-hosted. */
const basePathOf = (base: URL) => base.pathname.replace(/\/+$/, "");

/**
 * A docs page slug and anchor from a search-result URL, which may be relative
 * (`/guides/x#a`) or absolute; either way it is resolved against the base, so
 * the base path is never added twice.
 */
function slugOf(url: string, base: URL): { slug: string; hash: string } {
  const u = new URL(url, base.origin);
  return { slug: slugFromPath(u.pathname, basePathOf(base)), hash: u.hash };
}

const pageURL = (base: string, slug: string, hash = "") => `${slug ? `${base}/${slug}` : base}${hash}`;
const mdURL = (base: string, slug: string) => `${base}/${slug || "index"}.md`;

/** Groups Fumadocs' flat result list by page, keeping search order. */
function groupResults(results: SearchResult[], docsBase: string, limit: number): PageHit[] {
  const base = new URL(`${docsBase}/`);
  const pages = new Map<string, PageHit>();
  const headings = new Map<string, string>(); // full url -> heading text
  for (const r of results) {
    if (typeof r?.url !== "string") continue;
    let loc: { slug: string; hash: string };
    try {
      loc = slugOf(r.url, base);
    } catch {
      continue;
    }
    let page = pages.get(loc.slug);
    if (!page) {
      if (pages.size >= limit) continue;
      page = {
        title: r.type === "page" ? plain(r.content) : plain(r.breadcrumbs?.at(-1)) || loc.slug || "Overview",
        url: pageURL(docsBase, loc.slug),
        md_url: mdURL(docsBase, loc.slug),
        matches: [],
      };
      if (r.breadcrumbs?.length) page.breadcrumbs = r.breadcrumbs.map(plain);
      pages.set(loc.slug, page);
    }
    if (r.type === "page") {
      page.title = plain(r.content) || page.title;
      continue;
    }
    const url = pageURL(docsBase, loc.slug, loc.hash);
    if (r.type === "heading") {
      headings.set(url, plain(r.content));
      // A text hit under this heading may already be listed; name its section.
      const existing = page.matches.find((m) => m.url === url);
      if (existing) {
        existing.heading ??= plain(r.content);
        continue;
      }
      if (page.matches.length < MATCHES_PER_PAGE) page.matches.push({ heading: plain(r.content), url });
      continue;
    }
    const snippet = clip(plain(r.content), SNIPPET_CHARS);
    const existing = page.matches.find((m) => m.url === url && !m.snippet);
    if (existing) {
      existing.snippet = snippet;
      continue;
    }
    if (page.matches.length < MATCHES_PER_PAGE) {
      const heading = headings.get(url) ?? (loc.hash ? decodeURIComponent(loc.hash.slice(1)) : undefined);
      page.matches.push({ ...(heading ? { heading } : {}), snippet, url });
    }
  }
  return [...pages.values()];
}

async function search(docsBase: string, query: string): Promise<SearchResult[]> {
  const url = `${docsBase}/api/search?query=${encodeURIComponent(query)}`;
  const text = await docsText(url, "application/json", "The docs search endpoint was not found");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`The docs search at ${url} did not return JSON; the docs host may be misconfigured.`);
  }
  if (!Array.isArray(parsed)) throw new Error(`The docs search at ${url} returned an unexpected shape (not an array).`);
  return parsed as SearchResult[];
}

/**
 * The page slug and anchor from what an agent passes: a slug (`guides/anti-bot`),
 * a docs path (`/guides/anti-bot.md`, or with the base path or the legacy
 * `/docs` prefix) or a full docs URL (from search or llms.txt), with or without
 * `#anchor`. Anything outside the docs (another host, `..`) is refused.
 */
export function resolveDocsPath(input: string, docsBase: string): { slug: string; hash: string } {
  const base = new URL(`${docsBase}/`);
  let raw = input.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("//")) {
    let u: URL;
    try {
      u = new URL(raw, base);
    } catch {
      throw new Error(`\`${input}\` is not a valid URL.`);
    }
    if (u.origin !== base.origin) {
      throw new Error(`\`${input}\` is not on the Spicrawl docs (${docsBase}); only docs pages can be read.`);
    }
    raw = u.pathname + u.hash;
  }
  const hashAt = raw.indexOf("#");
  const hash = hashAt >= 0 ? raw.slice(hashAt) : "";
  let path = (hashAt >= 0 ? raw.slice(0, hashAt) : raw).split("?")[0];
  try {
    path = decodeURIComponent(path);
  } catch {
    throw new Error(`\`${input}\` is not a valid docs path.`);
  }
  if (path.split(/[\\/]/).some((seg) => seg === ".." || seg === ".")) {
    throw new Error(`\`${input}\` contains \`..\` or \`.\` segments; pass a docs page path like \`guides/anti-bot\`.`);
  }
  // A bare `docs/...` means the same as `/docs/...`: slugFromPath roots it first.
  const slug = slugFromPath(path, basePathOf(base));
  if (slug && !SLUG_RE.test(slug)) {
    throw new Error(`\`${input}\` is not a valid docs page path; use letters, digits, '-', '_' and '/' (e.g. \`guides/anti-bot\`).`);
  }
  return { slug, hash };
}

function trimmed(text: string, max: number, what: string): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[Truncated: showing the first ${max} of ${text.length} characters of ${what}.]`;
}

export const registerDocsTools: RegisterTools = (server, client) => {
  const docsBase = client.docsBaseURL;

  server.registerTool(
    "spicrawl_docs_search",
    {
      title: "Search the Spicrawl docs",
      description:
        "Full-text search over the Spicrawl documentation (guides, API reference, errors, limits). Use it BEFORE guessing a parameter name, value or " +
        "combination for a spicrawl_* tool, and whenever an error needs explaining: search the error code itself (e.g. `ERR::UPSTREAM::CHALLENGE`) and " +
        "the result also carries a direct link to that code's entry on the errors page. Returns the best-matching pages, each with its title, the " +
        "matching sections (heading, a short snippet, URL) and md_url; then call spicrawl_docs_read with a page's md_url or url to read it in full.",
      inputSchema: {
        query: z.string().trim().min(1).max(200).describe("What to look for: a feature, parameter, error code or question, e.g. 'wait_for selector' or 'ERR::AUTH::INSUFFICIENT_SCOPE'."),
        limit: z.number().int().min(1).max(20).optional().describe("Maximum pages to return, 1-20. Default 8."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ query, limit }) =>
      run(async () => {
        const code = ERROR_CODE_RE.exec(query);
        let results = await search(docsBase, query);
        // A search index may tokenise `ERR::X::Y` poorly; fall back to the name.
        if (!results.length && code) results = await search(docsBase, code[2].replace(/_/g, " "));
        const pages = groupResults(results, docsBase, limit ?? 8);
        return {
          query,
          ...(code
            ? {
                error_code: {
                  code: query.toUpperCase(),
                  url: `${docsBase}/errors#${`${code[1]}_${code[2]}`.toUpperCase()}`,
                  md_url: mdURL(docsBase, "errors"),
                  note: "Every error code is described on the errors page; read it with spicrawl_docs_read and find the code's heading.",
                },
              }
            : {}),
          results: pages,
          ...(pages.length
            ? {}
            : { hint: "No matches. Try fewer or different words, or call spicrawl_docs_index to list every page." }),
        };
      }),
  );

  server.registerTool(
    "spicrawl_docs_read",
    {
      title: "Read a Spicrawl docs page",
      description:
        "Fetches one Spicrawl documentation page as Markdown. `path` may be a page path (`guides/anti-bot`), a docs URL from spicrawl_docs_search " +
        "(url or md_url), or either with a `#anchor` (the whole page is returned; the anchor names the section to look at). Only pages on the " +
        `Spicrawl docs (${docsBase}) can be read. Pages over ${MAX_PAGE_CHARS} characters are truncated, and the text says so. ` +
        "Don't know the path? Use spicrawl_docs_search, or spicrawl_docs_index (llms.txt) for the list of every page.",
      inputSchema: {
        path: z
          .string()
          .trim()
          .min(1)
          .max(500)
          .describe("Page path (`guides/anti-bot`, `errors#AUTH_INVALID_KEY`) or a full docs URL, as returned by spicrawl_docs_search."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ path }) =>
      run(async () => {
        const { slug, hash } = resolveDocsPath(path, docsBase);
        const url = mdURL(docsBase, slug);
        const text = await docsText(
          url,
          "text/markdown, text/plain;q=0.9",
          `No docs page at \`${slug || "/"}\`. Use spicrawl_docs_search or spicrawl_docs_index to find the right path`,
        );
        if (/^\s*<(!doctype html|html)[\s>]/i.test(text)) {
          throw new Error(`${url} returned an HTML page, not Markdown; check the path with spicrawl_docs_search or spicrawl_docs_index.`);
        }
        const header = `Source: ${pageURL(docsBase, slug, hash)}${hash ? ` (look for the section ${hash})` : ""}\n\n`;
        return header + trimmed(text, MAX_PAGE_CHARS, "this page");
      }),
  );

  server.registerTool(
    "spicrawl_docs_index",
    {
      title: "List the Spicrawl docs",
      description:
        "The docs' llms.txt: every Spicrawl documentation page with its title, a one-line description and its Markdown URL. Use it to find the right " +
        "page when a search does not, or to get an overview of what is documented; read a page with spicrawl_docs_read. No parameters.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () =>
      run(async () => {
        const url = `${docsBase}/llms.txt`;
        const text = await docsText(url, "text/plain, text/markdown;q=0.9", "The docs index (llms.txt) was not found");
        return trimmed(text, MAX_INDEX_CHARS, "the index");
      }),
  );
};
