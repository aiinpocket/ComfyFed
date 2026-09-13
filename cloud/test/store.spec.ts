import { describe, expect, it } from "vitest";
import { sanitizePathComponent, sanitizePathComponentOrThrow, InvalidPathComponent } from "../src/lib/store";

// Direct unit coverage for the rejection/acceptance rules `routes/jobs.ts`
// relies on for every client-supplied filename (asset upload, artifact
// upload, presign) -- see store.ts's docstring for the "stricter superset
// of storage.py" contract this is verifying.
describe("sanitizePathComponent", () => {
  it("rejects an empty string", () => {
    expect(() => sanitizePathComponent("")).toThrow();
  });

  it("rejects '.'", () => {
    expect(() => sanitizePathComponent(".")).toThrow();
  });

  it("rejects '..'", () => {
    expect(() => sanitizePathComponent("..")).toThrow();
  });

  it("rejects a forward-slash traversal ('a/../b')", () => {
    expect(() => sanitizePathComponent("a/../b")).toThrow();
  });

  it("rejects a disguised forward-slash traversal ('../../etc/passwd')", () => {
    expect(() => sanitizePathComponent("../../etc/passwd")).toThrow();
  });

  it("rejects a backslash traversal ('..\\..\\windows\\system32')", () => {
    expect(() => sanitizePathComponent("..\\..\\windows\\system32")).toThrow();
  });

  it("rejects a bare backslash-separated path ('a\\b')", () => {
    expect(() => sanitizePathComponent("a\\b")).toThrow();
  });

  it("rejects a trailing dot ('report.png.')", () => {
    expect(() => sanitizePathComponent("report.png.")).toThrow();
  });

  it("rejects a trailing space ('report.png ')", () => {
    expect(() => sanitizePathComponent("report.png ")).toThrow();
  });

  it("rejects a Windows device name ('CON')", () => {
    expect(() => sanitizePathComponent("CON")).toThrow();
  });

  it("rejects a Windows device name with an extension ('con.png'), case-insensitively", () => {
    expect(() => sanitizePathComponent("con.png")).toThrow();
    expect(() => sanitizePathComponent("CON.PNG")).toThrow();
  });

  it("rejects every reserved COM/LPT device name", () => {
    expect(() => sanitizePathComponent("COM1")).toThrow();
    expect(() => sanitizePathComponent("lpt9.txt")).toThrow();
  });

  it("accepts a unicode filename unchanged", () => {
    expect(sanitizePathComponent("画像.png")).toBe("画像.png");
  });

  it("accepts an ordinary filename unchanged", () => {
    expect(sanitizePathComponent("out.png")).toBe("out.png");
  });

  it("is idempotent on an already-sanitized value", () => {
    const once = sanitizePathComponent("photo.png");
    expect(sanitizePathComponent(once)).toBe(once);
  });
});

describe("sanitizePathComponentOrThrow", () => {
  it("wraps a rejection in InvalidPathComponent", () => {
    expect(() => sanitizePathComponentOrThrow("..", "asset filename")).toThrow(InvalidPathComponent);
  });

  it("passes an accepted value through unchanged", () => {
    expect(sanitizePathComponentOrThrow("out.png", "artifact filename")).toBe("out.png");
  });
});
