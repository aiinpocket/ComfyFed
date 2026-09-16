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

describe("refresh", () => {
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

  it("swallows a probe that throws (spec §8: a failed check never breaks hello)", async () => {
    await makeWorker("w-boom");
    vi.spyOn(peerhealth, "probePeerHealth").mockRejectedValue(new Error("boom"));

    expect(await peerhealth.refresh(db(), "w-boom", "http://203.0.113.7:8850")).toBeNull();
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
