import { describe, expect, it } from "vitest";
import { COMFYFED_EXT_JS } from "../src/core/comfyfed_ext";

// See vitest.config.ts: the real Python-side file's content is read at
// Node config time (workerd has no `fs`) and injected as this global.
declare const __COMFYFED_EXT_JS_SOURCE__: string;

// Normalizes CRLF -> LF before comparing: `server/comfyfed_server/panel_ext/
// comfyfed.js` is checked into git with CRLF line endings on this
// (Windows-authored) repo, but the substance of "byte parity" this test
// cares about is the JS content, not an OS/checkout-dependent line-ending
// choice -- comparing raw bytes here would make the test fail purely from
// `core.autocrlf` differences across clones, which is not a real drift.
function normalize(s: string): string {
  return s.replace(/\r\n/g, "\n");
}

describe("COMFYFED_EXT_JS", () => {
  it("is byte-identical (modulo line-ending normalization) to the packaged Python file", () => {
    expect(normalize(COMFYFED_EXT_JS)).toBe(normalize(__COMFYFED_EXT_JS_SOURCE__));
  });
});
