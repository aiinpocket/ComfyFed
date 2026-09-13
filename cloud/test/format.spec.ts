import { describe, expect, it } from "vitest";
import { python1f } from "../src/lib/format";
import golden from "./fixtures/golden.json";

describe("python1f", () => {
  for (const { input, expected } of golden.dotonef_cases) {
    it(`format(${input}, ".1f") === ${JSON.stringify(expected)}`, () => {
      expect(python1f(input)).toBe(expected);
    });
  }

  it("preserves the sign of negative values that round to zero", () => {
    expect(python1f(-0.04)).toBe("-0.0");
    expect(python1f(-0.0)).toBe("-0.0");
    expect(python1f(0.0)).toBe("0.0");
  });

  it("handles very large magnitudes without losing precision", () => {
    expect(python1f(1e20)).toBe("100000000000000000000.0");
  });
});
