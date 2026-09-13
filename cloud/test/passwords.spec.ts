import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../src/lib/passwords";

describe("passwords", () => {
  it("hashes in the pbkdf2$iter$salt$hash format with 600000 iterations", async () => {
    const hashed = await hashPassword("correct horse battery staple");
    const parts = hashed.split("$");
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe("pbkdf2");
    expect(parts[1]).toBe("600000");
    expect(parts[2]!.length).toBeGreaterThan(0);
    expect(parts[3]!.length).toBeGreaterThan(0);
  });

  it("verifies a correct password", async () => {
    const hashed = await hashPassword("hunter2");
    expect(await verifyPassword("hunter2", hashed)).toBe(true);
  });

  it("rejects a wrong password", async () => {
    const hashed = await hashPassword("hunter2");
    expect(await verifyPassword("hunter3", hashed)).toBe(false);
  });

  it("produces different salts (and thus different hashes) for the same password", async () => {
    const a = await hashPassword("same-password");
    const b = await hashPassword("same-password");
    expect(a).not.toBe(b);
    expect(await verifyPassword("same-password", a)).toBe(true);
    expect(await verifyPassword("same-password", b)).toBe(true);
  });

  it("rejects malformed hash strings without throwing", async () => {
    const malformed = [
      "",
      "not-a-hash",
      "pbkdf2$600000$onlythree",
      "argon2$600000$c2FsdA==$aGFzaA==",
      "pbkdf2$notanumber$c2FsdA==$aGFzaA==",
      "pbkdf2$600000$not-base64!!!$aGFzaA==",
      "pbkdf2$600000$$",
      "pbkdf2$600000$c2FsdA==$",
    ];
    for (const m of malformed) {
      await expect(verifyPassword("anything", m)).resolves.toBe(false);
    }
  });
});
