import { z } from "zod";

// ---------------------------------------------------------------------------
// Browser actions for spicrawl_scrape, as an explicit discriminated union.
//
// The API's step shape is an object keyed by its kind — {"click": {...}} — which
// a JSON schema can only describe as "any object". Agents given that schema
// guessed field names (`scroll.pixels`, `evaluate.script`) and got 400s. Here
// each step is `{type, ...fields}` with its fields spelt exactly as the Go
// router (api/internal/router/actions.go) reads them; toApiActions maps it back
// onto the keyed shape. Only kinds the API supports are offered: there is no
// hover or press step to map to.
// ---------------------------------------------------------------------------

const until = z
  .enum(["load", "domcontentloaded", "networkidle"])
  .describe("Load state the new document must reach. Default load.");

/** Keys every step accepts; they sit beside the kind key in the API shape. */
const meta = {
  timeout_ms: z.number().int().min(1).optional().describe("Budget for this step in ms. The step fails (or is skipped) when it runs out."),
  on_error: z.enum(["fail", "skip"]).optional().describe("fail (default) aborts the workflow; skip records the failure and continues."),
  label: z.string().optional().describe("Name echoed in the response's `actions` and `screenshots`."),
};
const META_KEYS = Object.keys(meta);

const step = <K extends string, T extends z.ZodRawShape>(type: K, fields: T, description: string) =>
  z.object({ type: z.literal(type), ...fields, ...meta }).strict().describe(description);

export const ActionSchema = z.discriminatedUnion("type", [
  step("click", {
    selector: z.string().min(1).describe("CSS selector of the element to click."),
    wait_for_navigation: z.boolean().optional().describe("The click navigates: finish the step only once the new page has loaded."),
    until: until.optional(),
  }, "Click an element. On a checkbox or radio this toggles it (there is no 'set checked'); read its state with evaluate if it matters."),
  step("fill", {
    selector: z.string().min(1),
    value: z.string(),
    secret: z.boolean().optional().describe("A credential: redacted from logs and the request log."),
  }, "Type a value into an input."),
  step("wait_for", {
    selector: z.string().min(1).optional().describe("CSS selector to wait for."),
    ms: z.number().int().min(1).optional().describe("Or: sleep this many ms."),
  }, "Wait for a selector to appear, or sleep `ms`."),
  step("wait_for_navigation", { until: until.optional() }, "Wait for a navigation started by the previous step (a click, a form submit, a redirect) to load."),
  step("scroll", {
    y: z.number().int().optional().describe("Pixels to scroll down (negative scrolls up)."),
    to_bottom: z.boolean().optional().describe("Scroll to the bottom repeatedly until the page stops growing (infinite scroll)."),
    selector: z.string().min(1).optional().describe("Scroll this element into view."),
  }, "Scroll the page: give exactly one of y, to_bottom or selector."),
  step("select", {
    selector: z.string().min(1).describe("CSS selector of the <select>."),
    value: z.string().optional(),
    values: z.array(z.string()).optional().describe("Several options, for a multi-select."),
  }, "Choose option(s) in a <select> by value."),
  step("evaluate", {
    expression: z.string().min(1).describe("JavaScript expression evaluated in the page."),
    return_value: z.boolean().optional().describe("Return the value under `actions` in the response (forces format json)."),
    await_promise: z.boolean().optional(),
  }, "Run JavaScript in the page."),
  step("screenshot", {
    full_page: z.boolean().optional(),
    selector: z.string().min(1).optional().describe("Capture only this element."),
    format: z.enum(["png", "jpeg", "webp"]).optional(),
    quality: z.number().int().min(1).max(100).optional(),
  }, "Capture the page at this point. The image is returned as an image block; the response becomes the JSON envelope whatever `format` says."),
]);

export type Action = z.infer<typeof ActionSchema>;

export const ActionsSchema = z
  .array(ActionSchema)
  .superRefine((steps, ctx) => {
    steps.forEach((s, i) => {
      if (s.type === "scroll" && [s.y !== undefined, s.to_bottom === true, s.selector !== undefined].filter(Boolean).length !== 1) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [i], message: "scroll needs exactly one of y, to_bottom or selector" });
      }
      if (s.type === "wait_for" && s.selector === undefined && s.ms === undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [i], message: "wait_for needs selector or ms" });
      }
      if (s.type === "select" && s.value === undefined && !s.values?.length) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [i], message: "select needs value or values" });
      }
      if (s.type === "click" && s.until !== undefined && s.wait_for_navigation !== true) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [i], message: "click.until only applies with wait_for_navigation: true" });
      }
    });
  })
  .describe(
    "Browser steps run in order before capture (render only). Each step is {type, ...fields}. Examples: " +
      '[{"type":"click","selector":"#load-more"},{"type":"wait_for","selector":".item:nth-child(20)","timeout_ms":5000}] · ' +
      'infinite scroll: [{"type":"scroll","to_bottom":true},{"type":"wait_for","ms":1000}] · ' +
      'login: [{"type":"fill","selector":"#user","value":"me"},{"type":"fill","selector":"#pass","value":"…","secret":true},' +
      '{"type":"click","selector":"button[type=submit]","wait_for_navigation":true}]. ' +
      "A screenshot step switches the response to the JSON envelope (a FORMAT_COERCED warning says so).",
  );

/** Map typed steps onto the API's keyed shape: {kind: {fields}, timeout_ms?, on_error?, label?}. */
export function toApiActions(steps: Action[]): Record<string, unknown>[] {
  return steps.map((s) => {
    const { type, ...rest } = s as Record<string, unknown> & { type: string };
    const body: Record<string, unknown> = {};
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rest)) {
      if (v === undefined) continue;
      if (META_KEYS.includes(k)) out[k] = v;
      else body[k] = v;
    }
    return { [type]: body, ...out };
  });
}
