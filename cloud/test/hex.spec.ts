import { describe, expect, it } from "vitest";
import { hexToBytes, bytesToHex } from "../src/lib/hex";

describe("hexToBytes strictness", () => {
  it("accepts an empty string (zero-length output)", () => {
    expect(hexToBytes("")).toEqual(new Uint8Array(0));
  });

  it("decodes valid lowercase and uppercase hex", () => {
    expect(hexToBytes("00ff")).toEqual(new Uint8Array([0x00, 0xff]));
    expect(hexToBytes("00FF")).toEqual(new Uint8Array([0x00, 0xff]));
  });

  it("rejects odd-length strings", () => {
    expect(() => hexToBytes("abc")).toThrow();
    expect(() => hexToBytes("1")).toThrow();
  });

  it("rejects non-hex characters that Number.parseInt would silently truncate on", () => {
    expect(() => hexToBytes("1z")).toThrow();
    expect(() => hexToBytes("zz")).toThrow();
    expect(() => hexToBytes("gg")).toThrow();
  });

  it("rejects embedded/leading whitespace that Number.parseInt would silently skip", () => {
    expect(() => hexToBytes(" 1")).toThrow();
    expect(() => hexToBytes("1 ")).toThrow();
    expect(() => hexToBytes("ab cd")).toThrow();
    expect(() => hexToBytes("\t0")).toThrow();
  });

  it("round-trips through bytesToHex", () => {
    const bytes = new Uint8Array([0x00, 0x01, 0x7f, 0x80, 0xff]);
    expect(hexToBytes(bytesToHex(bytes))).toEqual(bytes);
  });
});
