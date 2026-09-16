import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { toSqliteTimestamp } from "../src/db/queries";
import * as peerhealth from "../src/core/peerhealth";

// Ports tests/server/test_peer.py's Phase 3.4 peerhealth block -- see
// server/comfyfed_server/peerhealth.py for the parity source.

function db(): D1Database {
  return (env as any).DB as D1Database;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await db().prepare("DELETE FROM workers").run();
});

async function makeWorker(id: string, fields: Record<string, unknown> = {}): Promise<void> {
  await db()
    .prepare("INSERT INTO workers (id, name, pubkey, created_at) VALUES (?, ?, 'pk', ?)")
    .bind(id, id, toSqliteTimestamp(new Date()))
    .run();
  for (const [column, value] of Object.entries(fields)) {
    await db().prepare(`UPDATE workers SET ${column} = ? WHERE id = ?`).bind(value as any, id).run();
  }
}

async function peerRow(id: string): Promise<any> {
  return db()
    .prepare("SELECT peer_reachable, peer_checked_at FROM workers WHERE id = ?")
    .bind(id)
    .first<any>();
}

describe("isPrivatePeerUrl", () => {
  it.each([
    ["http://10.1.2.3:8850", true],
    ["http://172.16.0.9:8850", true],
    ["http://172.32.0.9:8850", false],
    ["http://192.168.1.5:8850", true],
    ["http://169.254.169.254:80", true],
    ["http://127.0.0.1:8850", true],
    // 100.64/10 CGNAT (ruling): mirrors the agent's natmap predicate.
    ["http://100.64.0.1:8850", true],
    ["http://100.127.255.254:8850", true],
    ["http://100.128.0.1:8850", false],
    ["http://100.63.255.255:8850", false],
    ["http://[::1]:8850", true],
    ["http://[fc00::1]:8850", true],
    ["http://[fe80::1]:8850", true],
    ["http://203.0.113.7:8850", false],
    ["http://[2001:db8::1]:8850", false],
    ["http://seeder.example.com:8850", false],
  ])("%s -> %s", (url, expected) => {
    expect(peerhealth.isPrivatePeerUrl(url as string)).toBe(expected);
  });
});

describe("isPrivatePeerUrl: normalized literals (fix round 1)", () => {
  it.each([
    // WHATWG URL normalizes the legacy IPv4 spellings for us, but the
    // predicate has to agree with the Python side, which does it by hand.
    ["http://2130706433:8850", true], // 127.0.0.1
    ["http://0177.0.0.1:8850", true], // octal 127
    ["http://127.1:8850", true], // two-part form
    ["http://3232235781:8850", true], // 192.168.1.5
    ["http://3405803527:8850", false], // 203.0.113.7 -- public, not a false positive
    // IPv4-mapped IPv6, both spellings.
    ["http://[::ffff:10.0.0.1]:8850", true],
    ["http://[::ffff:a00:1]:8850", true],
    ["http://[::ffff:203.0.113.7]:8850", false],
    // `fc::1` is 00fc::1 -- NOT inside fc00::/7 (the old regex said it was).
    ["http://[fc::1]:8850", false],
    ["http://[fd00::1]:8850", true],
    ["http://[fe80::1%25eth0]:8850", true],
    ["http://[febf::1]:8850", true],
    ["http://[fec0::1]:8850", false], // fec0::/10 is outside fe80::/10
  ])("%s -> %s", (url, expected) => {
    expect(peerhealth.isPrivatePeerUrl(url as string)).toBe(expected);
  });
});

describe("isIpLiteralPeerUrl", () => {
  it.each([
    ["http://203.0.113.7:8850", true],
    ["http://2130706433:8850", true],
    ["http://[2001:db8::1]:8850", true],
    ["http://[::ffff:10.0.0.1]:8850", true],
    ["http://seeder.example.com:8850", false],
    ["http://localhost:8850", false],
  ])("%s -> %s", (url, expected) => {
    expect(peerhealth.isIpLiteralPeerUrl(url as string)).toBe(expected);
  });
});

describe("refresh", () => {
  it("never probes a hostname peer_url, leaving the verdict NULL (fix round 1)", async () => {
    await makeWorker("w-host");
    const probe = vi.spyOn(peerhealth, "probePeerHealth").mockResolvedValue(true);
    const seen: unknown[] = [];

    const result = await peerhealth.refresh(db(), "w-host", "http://seeder.example.com:8850", (r, u) =>
      seen.push([r, u])
    );

    expect(result).toBeNull();
    expect(probe).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
    const row = await peerRow("w-host");
    expect(row.peer_reachable).toBeNull();
    // Stamped, so the heartbeat cadence does not re-run this every beat.
    expect(row.peer_checked_at).not.toBeNull();
    expect(peerhealth.needsRecheck(row.peer_checked_at, new Date())).toBe(false);
  });

  it("rejects a private peer_url without probing", async () => {
    await makeWorker("w-priv");
    const probe = vi.spyOn(peerhealth, "probePeerHealth").mockResolvedValue(true);

    const result = await peerhealth.refresh(db(), "w-priv", "http://192.168.1.5:8850");

    expect(result).toBe(false);
    expect(probe).not.toHaveBeenCalled();
    const row = await peerRow("w-priv");
    expect(row.peer_reachable).toBe(0);
    expect(row.peer_checked_at).not.toBeNull();
  });

  it("marks a 204 seeder reachable and probes the health path", async () => {
    await makeWorker("w-ok");
    const probe = vi.spyOn(peerhealth, "probePeerHealth").mockResolvedValue(true);

    expect(await peerhealth.refresh(db(), "w-ok", "http://203.0.113.7:8850/")).toBe(true);
    expect(probe).toHaveBeenCalledWith("http://203.0.113.7:8850/peer/health");
    expect((await peerRow("w-ok")).peer_reachable).toBe(1);
  });

  it("marks a timeout unreachable", async () => {
    await makeWorker("w-bad");
    vi.spyOn(peerhealth, "probePeerHealth").mockResolvedValue(false);

    expect(await peerhealth.refresh(db(), "w-bad", "http://203.0.113.7:8850")).toBe(false);
    expect((await peerRow("w-bad")).peer_reachable).toBe(0);
  });

  it("clears the verdict when there is no peer_url", async () => {
    await makeWorker("w-none", { peer_reachable: 1 });
    expect(await peerhealth.refresh(db(), "w-none", null)).toBeNull();
    expect((await peerRow("w-none")).peer_reachable).toBeNull();
  });

  it("notifies after every hello-triggered check, changed verdict or not", async () => {
    await makeWorker("w-notify");
    vi.spyOn(peerhealth, "probePeerHealth").mockResolvedValue(true);
    const seen: Array<[boolean, string]> = [];
    const notify = (reachable: boolean, url: string) => {
      seen.push([reachable, url]);
    };

    await peerhealth.refresh(db(), "w-notify", "http://203.0.113.7:8850", notify);
    await peerhealth.refresh(db(), "w-notify", "http://203.0.113.7:8850", notify);

    expect(seen).toEqual([
      [true, "http://203.0.113.7:8850/peer/health"],
      [true, "http://203.0.113.7:8850/peer/health"],
    ]);
  });

  it("notifies only when the verdict changes on a heartbeat recheck", async () => {
    await makeWorker("w-change");
    const probe = vi.spyOn(peerhealth, "probePeerHealth").mockResolvedValue(true);
    const seen: Array<[boolean, string]> = [];
    const notify = (reachable: boolean, url: string) => {
      seen.push([reachable, url]);
    };
    const recheck = () =>
      peerhealth.refresh(db(), "w-change", "http://203.0.113.7:8850", notify, {
        notifyOnChangeOnly: true,
      });

    // NULL -> true: changed, pushes.
    expect(await recheck()).toBe(true);
    expect(seen.length).toBe(1);
    // true -> true: unchanged, silent.
    expect(await recheck()).toBe(true);
    expect(seen.length).toBe(1);
    // true -> false: changed, pushes.
    probe.mockResolvedValue(false);
    expect(await recheck()).toBe(false);
    expect(seen).toEqual([
      [true, "http://203.0.113.7:8850/peer/health"],
      [false, "http://203.0.113.7:8850/peer/health"],
    ]);
    // false -> false: unchanged, silent.
    expect(await recheck()).toBe(false);
    expect(seen.length).toBe(2);
  });

  it("reads the previous verdict BEFORE probing, so a write that lands mid-probe still counts as a change", async () => {
    // Final review: D1 has no transaction around read-then-write, so reading
    // the old value AFTER a (up to 3s) probe would pick up whatever another
    // heartbeat wrote meanwhile and call a real change "unchanged".
    await makeWorker("w-race", { peer_reachable: 0 });
    const seen: Array<[boolean, string]> = [];
    vi.spyOn(peerhealth, "probePeerHealth").mockImplementation(async () => {
      // Someone else's recheck lands while we are probing.
      await db().prepare("UPDATE workers SET peer_reachable = 1 WHERE id = ?").bind("w-race").run();
      return true;
    });

    const verdict = await peerhealth.refresh(
      db(),
      "w-race",
      "http://203.0.113.7:8850",
      (reachable, url) => {
        seen.push([reachable, url]);
      },
      { notifyOnChangeOnly: true }
    );

    expect(verdict).toBe(true);
    // Previous (read before the probe) was 0 -> this IS a change -> pushes.
    expect(seen).toEqual([[true, "http://203.0.113.7:8850/peer/health"]]);
  });

  it("swallows a probe that throws (spec §8: a failed check never breaks hello)", async () => {
    await makeWorker("w-boom");
    vi.spyOn(peerhealth, "probePeerHealth").mockRejectedValue(new Error("boom"));

    expect(await peerhealth.refresh(db(), "w-boom", "http://203.0.113.7:8850")).toBeNull();
  });
});

describe("isPrivatePeerUrl: non-host addresses (fix round 3)", () => {
  it.each([
    ["http://0", true], // unspecified, shortest spelling
    ["http://0.0.0.0:8850", true],
    ["http://224.0.0.1", true], // multicast
    ["http://239.1.2.3:8850", true],
    ["http://240.0.0.1", true], // reserved
    ["http://255.255.255.255", true], // broadcast
    ["http://[ff02::1]", true], // IPv6 multicast
    ["http://[::]:8850", true], // IPv6 unspecified
    ["http://203.0.113.7:8850", false],
  ])("%s -> %s", (url, expected) => {
    expect(peerhealth.isPrivatePeerUrl(url as string)).toBe(expected);
  });

  it.each(["http://0.0.0.0:8850", "http://224.0.0.1:8850", "http://[ff02::1]:8850"])(
    "refresh never probes %s and stores 0",
    async (url) => {
      await makeWorker("w-reject");
      const probe = vi.spyOn(peerhealth, "probePeerHealth").mockResolvedValue(true);

      expect(await peerhealth.refresh(db(), "w-reject", url)).toBe(false);

      expect(probe).not.toHaveBeenCalled();
      expect((await peerRow("w-reject")).peer_reachable).toBe(0);
    }
  );
});

describe("probePeerHealth", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("accepts only a 204, and asks fetch not to follow redirects", async () => {
    const calls: Array<[string, RequestInit]> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push([url, init]);
        return new Response(null, { status: 204 });
      })
    );

    expect(await peerhealth.probePeerHealth("http://203.0.113.7:8850/peer/health")).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toBe("http://203.0.113.7:8850/peer/health");
    expect(calls[0]![1].redirect).toBe("manual");
    expect(calls[0]![1].signal).toBeDefined();
  });

  it("treats a 302 as unreachable and never follows it", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return new Response(null, {
          status: 302,
          headers: { Location: "http://198.51.100.9:8850/peer/health" },
        });
      })
    );

    expect(await peerhealth.probePeerHealth("http://203.0.113.7:8850/peer/health")).toBe(false);
    expect(calls).toEqual(["http://203.0.113.7:8850/peer/health"]);
  });

  it("treats a thrown fetch (timeout, refused, DNS) as unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connection refused");
      })
    );

    expect(await peerhealth.probePeerHealth("http://203.0.113.7:8850/peer/health")).toBe(false);
  });
});

describe("needsRecheck", () => {
  it("is true when never checked and after 10 minutes", () => {
    const now = new Date("2026-09-16T12:00:00Z");
    expect(peerhealth.needsRecheck(null, now)).toBe(true);
    expect(peerhealth.needsRecheck(toSqliteTimestamp(new Date("2026-09-16T11:49:00Z")), now)).toBe(true);
    expect(peerhealth.needsRecheck(toSqliteTimestamp(new Date("2026-09-16T11:55:00Z")), now)).toBe(false);
  });
});
