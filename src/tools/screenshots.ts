import type { Attached, ImageBlock } from "./common.js";

// Largest base64 string attached as an image. The worker only inlines images up
// to 2 MiB raw (~2.8 MB base64) and the API drops anything larger, so today this
// never trips; it exists so a change upstream cannot put an image into the
// result that the model host then rejects wholesale. 5 MB is the per-image
// ceiling of the Claude API, the strictest common MCP host.
export const MAX_IMAGE_BASE64 = 5 * 1024 * 1024;

const MIME: Record<string, string> = { png: "image/png", jpeg: "image/jpeg", jpg: "image/jpeg", webp: "image/webp" };

// The API leaves `format` out when the worker named none; the base64 of the
// container's magic bytes still identifies the common ones.
function sniff(b64: string): string | undefined {
  if (b64.startsWith("iVBORw0KGgo")) return "image/png";
  if (b64.startsWith("/9j/")) return "image/jpeg";
  if (b64.startsWith("UklGR") && b64.slice(8, 16) === "V0VCUF") return "image/webp";
  return undefined;
}

/**
 * Moves the inline base64 screenshots of a scrape envelope into MCP image
 * blocks, leaving a small placeholder in their place.
 *
 * A model reads an image block as a picture; the same bytes as JSON text are
 * unreadable noise that can run to megabytes of its context. Anything that is
 * not an inline base64 entry (a URL or object ref, an unknown shape) is left
 * untouched, and so is any payload without a `screenshots` array.
 *
 * Batch payloads are deliberately not passed through here: the batch worker
 * writes its own body, not the /v1/scrape envelope, and emits no screenshots.
 */
export function attachScreenshots(data: unknown): Attached {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return { data, blocks: [] };
  const shots = (data as Record<string, unknown>).screenshots;
  if (!Array.isArray(shots)) return { data, blocks: [] };

  const images: ImageBlock[] = [];
  const replaced = shots.map((shot) => {
    if (typeof shot !== "object" || shot === null) return shot;
    const s = shot as Record<string, unknown>;
    if (typeof s.data !== "string" || (s.encoding !== undefined && s.encoding !== "base64")) return shot;

    const { data: b64, encoding: _encoding, ...rest } = s;
    const format = typeof s.format === "string" ? s.format.toLowerCase() : undefined;
    const mimeType = (format && MIME[format]) || sniff(b64);
    const placeholder: Record<string, unknown> = { ...rest };

    if (!mimeType) {
      placeholder.not_attached =
        "The image format is unknown, so it cannot be attached as an image. Re-request with screenshot_format=png.";
    } else if (b64.length > MAX_IMAGE_BASE64) {
      placeholder.not_attached =
        `The image is ${(b64.length / 1e6).toFixed(1)} MB as base64, over the ${MAX_IMAGE_BASE64 / (1024 * 1024)} MB ` +
        "per-image limit model hosts accept. Re-request a smaller one (screenshot_format=jpeg with a lower " +
        "screenshot_quality, no screenshot_fullpage, or a screenshot_selector), or call POST /v1/scrape directly for the bytes.";
    } else {
      images.push({ type: "image", data: b64, mimeType });
      // content[0] is the JSON text, so image n is content[n].
      placeholder.attached_as = `image content block ${images.length} (content[${images.length}], ${mimeType})`;
    }
    return placeholder;
  });

  if (replaced.every((r, i) => r === shots[i])) return { data, blocks: [] };
  return { data: { ...(data as Record<string, unknown>), screenshots: replaced }, blocks: images };
}
