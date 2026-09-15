import { afterEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import * as stats from "../src/core/stats";
import { toSqliteTimestamp } from "../src/db/queries";

function db(): D1Database {
  return (env as any).DB as D1Database;
}

afterEach(async () => {
  await db().prepare("DELETE FROM worker_job_stats").run();
  await db().prepare("DELETE FROM workers").run();
  await db().prepare("DELETE FROM jobs").run();
  await db().prepare("DELETE FROM receipts").run();
  await db().prepare("DELETE FROM settings").run();
});

function rows(...triples: [string, string, number][]): stats.StatRow[] {
  return triples.map(([workerId, signature, ewmaSeconds]) => ({ workerId, signature, ewmaSeconds, samples: 1 }));
}

describe("median", () => {
  it("is null for an empty list", () => expect(stats.median([])).toBeNull());
  it("takes the middle value for an odd count", () => expect(stats.median([5, 1, 3])).toBe(3));
  it("averages the two middle values for an even count", () => expect(stats.median([1, 2, 3, 4])).toBe(2.5));
});

describe("nextEwma", () => {
  it("is the sample itself on the first observation", () => expect(stats.nextEwma(null, 42)).toBe(42));
  it("blends with alpha 0.3", () => expect(stats.nextEwma(10, 20)).toBeCloseTo(13, 10));
});

describe("fleetReference", () => {
  it("excludes the reporting worker", () => {
    const speed = new Map([["w1", 1], ["w2", 1], ["w3", 1]]);
    expect(stats.fleetReference(rows(["w1", "sig", 10], ["w2", "sig", 20], ["w3", "sig", 30]), speed, "sig", "w1")).toBe(25);
  });

  it("weights each observation by that worker's speed index", () => {
    expect(stats.fleetReference(rows(["w2", "sig", 10]), new Map([["w2", 2]]), "sig", "w1")).toBe(20);
  });

  it("is null when nobody else has data for the signature", () => {
    expect(stats.fleetReference(rows(["w1", "sig", 10]), new Map([["w1", 1]]), "sig", "w1")).toBeNull();
    expect(stats.fleetReference(rows(["w2", "other", 10]), new Map([["w2", 1]]), "sig", "w1")).toBeNull();
  });
});

describe("nextSpeedIndex", () => {
  it("is unchanged without a reference", () => expect(stats.nextSpeedIndex(1, null, 10)).toBe(1));
  it("rises when faster than the fleet", () => expect(stats.nextSpeedIndex(1, 20, 10)).toBeCloseTo(1.3, 10));
  it("falls when slower than the fleet", () => expect(stats.nextSpeedIndex(1, 10, 20)).toBeCloseTo(0.85, 10));
  it("clamps to the bounds", () => {
    expect(stats.nextSpeedIndex(10, 1e9, 1)).toBe(stats.SPEED_MAX);
    expect(stats.nextSpeedIndex(0.1, 1, 1e9)).toBe(stats.SPEED_MIN);
  });
  it("is unchanged when exec is zero", () => expect(stats.nextSpeedIndex(1, 20, 0)).toBe(1));
});

describe("predict (§2.4 basis ladder)", () => {
  it("uses this worker's own row first", () => {
    const r = stats.predict(rows(["w1", "sig", 41.2], ["w2", "sig", 80]), new Map([["w1", 1], ["w2", 1]]), "sig", "w1");
    expect(r).toEqual({ seconds: 41.2, basis: "signature" });
  });

  it("falls back to the fleet reference scaled by speed index", () => {
    const r = stats.predict(rows(["w2", "sig", 40]), new Map([["w1", 2], ["w2", 1]]), "sig", "w1");
    expect(r.basis).toBe("speed_index");
    expect(r.seconds).toBeCloseTo(20, 10);
  });

  it("falls back to the fleet median over every signature", () => {
    const r = stats.predict(rows(["w2", "other-a", 10], ["w2", "other-b", 30]), new Map([["w1", 1], ["w2", 1]]), "sig", "w1");
    expect(r.basis).toBe("fleet_default");
    expect(r.seconds).toBeCloseTo(20, 10);
  });

  it("falls back to 60s with no data at all", () => {
    expect(stats.predict([], new Map(), "sig", "w1")).toEqual({ seconds: stats.DEFAULT_PREDICTED_SECONDS, basis: "none" });
  });

  it("skips the signature rungs when the job has no signature", () => {
    const r = stats.predict(rows(["w2", "other", 30]), new Map([["w1", 1], ["w2", 1]]), null, "w1");
    expect(r.basis).toBe("fleet_default");
    expect(r.seconds).toBeCloseTo(30, 10);
  });
});

async function makeWorker(id: string, speedIndex = 1.0): Promise<void> {
  await db()
    .prepare("INSERT INTO workers (id, name, pubkey, created_at, speed_index) VALUES (?, ?, 'pk', ?, ?)")
    .bind(id, id, toSqliteTimestamp(new Date()), speedIndex)
    .run();
}

describe("recordCompletion", () => {
  it("inserts the first row and leaves speed_index alone", async () => {
    await makeWorker("w1");
    await stats.recordCompletion(db(), "w1", "sig", 30, new Date());
    const row = await db().prepare("SELECT ewma_seconds, samples FROM worker_job_stats WHERE worker_id = 'w1'").first<any>();
    expect(row.ewma_seconds).toBe(30);
    expect(row.samples).toBe(1);
    const worker = await db().prepare("SELECT speed_index FROM workers WHERE id = 'w1'").first<any>();
    expect(worker.speed_index).toBe(1.0);
  });

  it("blends an existing row", async () => {
    await makeWorker("w1");
    await stats.recordCompletion(db(), "w1", "sig", 10, new Date());
    await stats.recordCompletion(db(), "w1", "sig", 20, new Date());
    const row = await db().prepare("SELECT ewma_seconds, samples FROM worker_job_stats WHERE worker_id = 'w1'").first<any>();
    expect(row.ewma_seconds).toBeCloseTo(13, 10);
    expect(row.samples).toBe(2);
  });

  it("updates speed_index against the other workers", async () => {
    await makeWorker("w1");
    await makeWorker("w2");
    await stats.recordCompletion(db(), "w2", "sig", 20, new Date());
    await stats.recordCompletion(db(), "w1", "sig", 10, new Date());
    const w1 = await db().prepare("SELECT speed_index FROM workers WHERE id = 'w1'").first<any>();
    const w2 = await db().prepare("SELECT speed_index FROM workers WHERE id = 'w2'").first<any>();
    expect(w1.speed_index).toBeCloseTo(1.3, 10);
    expect(w2.speed_index).toBe(1.0);
  });

  it("ignores a missing signature or invalid exec seconds", async () => {
    await makeWorker("w1");
    await stats.recordCompletion(db(), "w1", null, 30, new Date());
    await stats.recordCompletion(db(), "w1", "sig", null, new Date());
    await stats.recordCompletion(db(), "w1", "sig", NaN, new Date());
    await stats.recordCompletion(db(), "w1", "sig", -1, new Date());
    const row = await db().prepare("SELECT COUNT(*) AS n FROM worker_job_stats").first<any>();
    expect(row.n).toBe(0);
  });
});

describe("backfillIfNeeded (§2.6)", () => {
  it("replays completed billable receipts oldest-first and sets the flag", async () => {
    await makeWorker("w1");
    const workflow = JSON.stringify({ "1": { class_type: "KSampler", inputs: { steps: 20 } } });
    for (let i = 0; i < 2; i++) {
      await db()
        .prepare("INSERT INTO jobs (id, workflow_json, status, created_at) VALUES (?, ?, 'done', ?)")
        .bind(`j${i}`, workflow, `2026-01-01 00:00:0${i}.000000`)
        .run();
      await db()
        .prepare(
          "INSERT INTO receipts (id, job_id, worker_id, gpu_seconds, platform_sig, created_at, kind, billable, basis) VALUES (?, ?, 'w1', ?, 'sig', ?, 'completed', 1, 'exec')"
        )
        .bind(`r${i}`, `j${i}`, 10 * (i + 1), `2026-01-01 00:00:0${i}.000000`)
        .run();
    }

    expect(await stats.backfillIfNeeded(db())).toBe(true);

    const job = await db().prepare("SELECT signature FROM jobs WHERE id = 'j0'").first<any>();
    expect(job.signature).toMatch(/^[0-9a-f]{16}$/);
    const row = await db().prepare("SELECT ewma_seconds, samples FROM worker_job_stats WHERE worker_id = 'w1'").first<any>();
    expect(row.ewma_seconds).toBeCloseTo(13, 10);
    expect(row.samples).toBe(2);

    expect(await stats.backfillIfNeeded(db())).toBe(false);
  });

  it("skips failed / non-billable receipts", async () => {
    await makeWorker("w1");
    await db().prepare("INSERT INTO jobs (id, workflow_json, status, created_at) VALUES ('j0', '{}', 'failed', '2026-01-01 00:00:00.000000')").run();
    await db()
      .prepare("INSERT INTO receipts (id, job_id, worker_id, gpu_seconds, platform_sig, created_at, kind, billable, basis) VALUES ('r0', 'j0', 'w1', 10, 'sig', '2026-01-01 00:00:00.000000', 'failed', 0, 'wall')")
      .run();
    expect(await stats.backfillIfNeeded(db())).toBe(true);
    const row = await db().prepare("SELECT COUNT(*) AS n FROM worker_job_stats").first<any>();
    expect(row.n).toBe(0);
  });
});
