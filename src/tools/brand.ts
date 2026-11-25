import { z } from "zod";
import { loose, run, type RegisterTools } from "./common.js";

// ---------------------------------------------------------------------------
// spicrawl_brand — a site's logos, colors, fonts, images, videos and socials
// ---------------------------------------------------------------------------

const SECTIONS = ["identity", "logos", "icons", "colors", "fonts", "images", "videos", "socials"] as const;

const BRAND_OUT = loose({
  url: z.string().nullish().describe("The URL requested."),
  final_url: z.string().nullish().describe("The URL the page loaded from, after redirects."),
  identity: loose({
    name: z.string().nullish(),
    description: z.string().nullish(),
    language: z.string().nullish(),
    domain: z.string().nullish(),
    theme_color: z.string().nullish().describe("Hex colour of the theme-color meta tag, or null."),
    tagline: z.string().nullish().describe("The hero headline. Empty when there is none."),
    subtitle: z.string().nullish().describe("The line under the hero headline. Empty when there is none."),
    cta: z.array(loose({ text: z.string().nullish(), url: z.string().nullish() })).nullish().describe("Up to two hero calls to action."),
  }).nullish(),
  logos: z.array(loose({ url: z.string().nullish(), svg: z.string().nullish(), format: z.string().nullish(), source: z.string().nullish(), theme: z.string().nullish() })).nullish(),
  icons: z.array(loose({ url: z.string().nullish(), rel: z.string().nullish(), sizes: z.string().nullish(), type: z.string().nullish() })).nullish(),
  colors: z.array(loose({ hex: z.string().nullish(), role: z.string().nullish(), source: z.string().nullish(), confidence: z.number().nullish() })).nullish(),
  fonts: z.array(loose({ family: z.string().nullish(), role: z.string().nullish(), weights: z.array(z.number()).nullish(), source: z.string().nullish(), files: z.array(z.string()).nullish() })).nullish(),
  images: z.array(loose({ url: z.string().nullish(), alt: z.string().nullish(), width: z.number().nullish(), height: z.number().nullish(), role: z.string().nullish() })).nullish(),
  videos: z.array(loose({ provider: z.string().nullish(), id: z.string().nullish(), url: z.string().nullish(), embed_url: z.string().nullish(), poster: z.string().nullish() })).nullish(),
  socials: z.array(loose({ network: z.string().nullish(), url: z.string().nullish() })).nullish(),
  credits: z.number().nullish().describe("Credits this call cost."),
  engine: z.string().nullish().describe("The rendering tier used: fetch, js or browser."),
  warnings: z.array(z.string()).nullish().describe("Sections that failed on the page. They are empty and the request still succeeded."),
});

export const registerBrandTools: RegisterTools = (server, client) => {
  server.registerTool(
    "spicrawl_brand",
    {
      title: "Extract a site's brand",
      description:
        "Read a site's brand from one rendered page load: the name, description, tagline and calls to action (`identity`), logo " +
        "links (`logos`, with a small logo's inline SVG), icons, brand colours with their roles (`colors`), fonts with their " +
        "files (`fonts`), images such as the Open Graph image (`images`), video links with poster images (`videos`, never direct " +
        "video files) and social profile links (`socials`). Use it when you need a company's logo, colours or fonts for a design " +
        "or a summary of how it presents itself. Every value is a link or a plain value; nothing is downloaded. Pass `include` to " +
        "ask for only some sections, since each section is capped. It is charged like a JavaScript-rendered scrape (3 credits " +
        "typically), and a failed call costs 0. A cache hit is billed too. Each call bills again. Read-only.",
      inputSchema: {
        url: z.string().url().describe("The page to read, http or https. Usually the site's home page. Private addresses are refused."),
        include: z
          .array(z.enum(SECTIONS))
          .min(1)
          .max(SECTIONS.length)
          .optional()
          .describe("Sections to return, without repeats. Omit to get all of them. Only these appear in the response."),
      },
      outputSchema: BRAND_OUT,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    // An omitted `include` is left out of the JSON body, so the API returns every section.
    async ({ url, include }) => run(() => client.request("POST", "/v1/brand", { url, include })),
  );
};
