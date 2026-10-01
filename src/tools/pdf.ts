import type { Attached } from "./common.js";

// Largest PDF, as base64, returned in the result. A model host caps what one tool
// result may carry, and a result it rejects loses the text beside the file too;
// past this the agent is told to fetch the file from the API directly.
export const MAX_PDF_BASE64 = 10 * 1024 * 1024;

/**
 * Moves the PDF of a `response_format=pdf` scrape (`pdf.data`, base64, as the
 * client read it) into an MCP embedded resource block, leaving its size and a
 * pointer to the block in the JSON. `uri` names the resource (the scraped URL);
 * `offset` is the number of blocks already placed after the text.
 *
 * Any payload without an inline base64 `pdf` is returned untouched.
 */
export function attachPdf(data: unknown, uri: string, offset = 0): Attached {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return { data, blocks: [] };
  const pdf = (data as Record<string, unknown>).pdf;
  if (typeof pdf !== "object" || pdf === null) return { data, blocks: [] };
  const { data: b64, encoding: _encoding, ...rest } = pdf as Record<string, unknown>;
  if (typeof b64 !== "string") return { data, blocks: [] };

  const placeholder: Record<string, unknown> = { ...rest };
  if (b64.length > MAX_PDF_BASE64) {
    placeholder.not_attached =
      `The PDF is ${(b64.length / 1e6).toFixed(1)} MB as base64, over the ${MAX_PDF_BASE64 / (1024 * 1024)} MB ` +
      "this tool returns. Call POST /v1/scrape with response_format=pdf directly for the file.";
    return { data: { ...(data as Record<string, unknown>), pdf: placeholder }, blocks: [] };
  }
  // content[0] is the JSON text, so this block is content[offset + 1].
  placeholder.attached_as = `resource content block ${offset + 1} (content[${offset + 1}], application/pdf)`;
  return {
    data: { ...(data as Record<string, unknown>), pdf: placeholder },
    blocks: [{ type: "resource", resource: { uri, mimeType: "application/pdf", blob: b64 } }],
  };
}
