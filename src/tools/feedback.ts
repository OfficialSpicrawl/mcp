import { z } from "zod";
import { ILayerError } from "../client.js";
import { loose, run, structured, type RegisterTools } from "./common.js";

// Feedback on one request: POST /v1/feedback. A thumbs-down on a charged request
// refunds its credits, up to a daily cap per account.

const FEEDBACK_OUT = loose({
  feedback_id: z.string().optional().describe("The id of the recorded feedback."),
  already_submitted: z.boolean().optional().describe("True when this request already had feedback; nothing new was recorded."),
  credits_refunded: z.number().optional().describe("Credits refunded for this report."),
  refund_cap_reached: z.boolean().optional().describe("True when the account's daily refund cap is used up."),
});

// A type alias, not an interface: it is passed to structured(), which needs an index signature.
type FeedbackResult = {
  feedback_id?: string;
  already_submitted?: boolean;
  credits_refunded?: number;
  refund_cap_reached?: boolean;
};

/** Refusals the caller can act on, by status. Anything else goes through the shared error rendering. */
const REFUSED: Record<number, string> = {
  404: "No such request for this API key, or it is older than your log retention. If the request failed just now, wait a few seconds and try once more.",
  409: "This request was rate- or quota-limited, so it cannot take feedback. Feedback was not recorded.",
  429: "Feedback limit reached; do not retry.",
};

function reportedText(r: FeedbackResult): string {
  if (r.already_submitted) return "Already reported.";
  const id = r.feedback_id ? ` (feedback ${r.feedback_id})` : "";
  const cap = r.refund_cap_reached ? " The daily refund cap is reached." : "";
  return `Reported${id}. Refunded ${r.credits_refunded ?? 0} credits.${cap}`;
}

export const registerFeedbackTools: RegisterTools = (server, client) => {
  // This client's failures now name the tool (run() adds the hint). Per client, so per session.
  client.feedbackTools = true;
  server.registerTool(
    "spicrawl_feedback",
    {
      title: "Report a Spicrawl problem",
      description:
        "Report to Spicrawl a request that failed in a way you could not fix, or that returned wrong or missing content. " +
        "Call it once per problem per task, with the request_id of the failed call (from the error text, or the X-Request-Id header) " +
        "and intent: what you were trying to get. Rate it down (the default) for a problem, up if the result was right. " +
        "The report is free. A thumbs-down on a charged request refunds its credits, up to a daily cap per account. " +
        "Never include secrets, API keys or cookies, and keep page content out: a short description is enough.",
      inputSchema: {
        request_id: z.string().min(1).describe("The request id of the call being reported: from the error text, or the X-Request-Id header."),
        rating: z
          .enum(["up", "down"])
          .default("down")
          .describe("down for a problem (the default); up when the result was right."),
        kind: z
          .enum(["broken", "wrong_result", "missing", "confusing", "other"])
          .optional()
          .describe("broken: an error or crash; wrong_result: the content was wrong; missing: content was absent; confusing: unclear output; other."),
        impact: z
          .enum(["blocked", "worked_around", "friction"])
          .optional()
          .describe("blocked: you could not finish the task; worked_around: you found another way; friction: it cost time but did not block."),
        intent: z
          .string()
          .max(300)
          .optional()
          .describe("What you were trying to get, in a few words, e.g. 'the prices on the category page'. No secrets."),
        comment: z
          .string()
          .max(4000)
          .optional()
          .describe("What you saw and what you expected, briefly. No secrets; no page content beyond a short description."),
      },
      outputSchema: FEEDBACK_OUT,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      // The client's name and version, sent once the client has initialized. Omitted when unknown.
      const info = server.server.getClientVersion();
      const agent = info?.name ? [info.name, info.version].filter(Boolean).join("/").slice(0, 200) : undefined;
      try {
        const result = (await client.request("POST", "/v1/feedback", {
          request_id: args.request_id,
          rating: args.rating,
          kind: args.kind,
          impact: args.impact,
          intent: args.intent,
          comment: args.comment,
          agent,
        })) as FeedbackResult;
        return structured(result, reportedText(result));
      } catch (err) {
        const refused = err instanceof ILayerError ? REFUSED[err.status] : undefined;
        if (refused) return { isError: true, content: [{ type: "text" as const, text: refused }] };
        // Any other failure renders as every tool's failure does (request id, hint).
        return run(() => Promise.reject(err));
      }
    },
  );
};
