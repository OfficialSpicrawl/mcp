import { test } from "node:test";
import assert from "node:assert/strict";
import { correctedRequest } from "../dist/tools/common.js";

test("a small fix is echoed whole", () => {
  const fix = { method: "POST", body: { a: 1 } };
  assert.equal(correctedRequest(fix), JSON.stringify(fix));
});

test("a large body is replaced by its size, the rest is kept", () => {
  const out = JSON.parse(correctedRequest({ method: "POST", body: "x".repeat(60000) }));
  assert.deepEqual(out, { method: "POST", body: "<your body, 60000 bytes>" });
});

test("a large fix without a body is left alone", () => {
  const fix = { custom_headers: { h: "y".repeat(3000) } };
  assert.equal(correctedRequest(fix), JSON.stringify(fix));
});
