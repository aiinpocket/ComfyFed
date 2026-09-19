import { afterEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";

import * as retry from "../src/core/retry";
import { exclusionKey } from "../src/core/assess";
import type { Job } from "../src/db/queries";

/**
 * 2026-09-19 job-retry: `core/retry.ts` 的純函式與 `worker_task_failures`
 * adapter -- ports tests/server/test_retry.py case for case.
 *
 * 上半是完全不碰 D1 的計次／門檻／訊息彙整（和 `retry.py` 逐行對照）；下半是
 * upsert／清除／TTL 查詢。派工排除與 `job_failed` 分流在 assess.spec.ts／
 * dispatch.spec.ts／hub.spec.ts。
 */

function db(): D1Database {
  return (env as any).DB as D1Database;
}

// vitest-pool-workers isolates D1 storage per test FILE, not per `it()`.
afterEach(async () => {
  await db().prepare("DELETE FROM worker_task_failures").run();
});

function now(): Date {
  return new Date();
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function daysAgo(from: Date, days: number): Date {
  return new Date(from.getTime() - days * MS_PER_DAY);
}

/** A `Job`-shaped stub carrying only the three fields `taskKey` reads --
 * the TS twin of the Python test's bare `db.Job(...)` construction. */
function jobStub(overrides: Partial<Pick<Job, "signature" | "kind" | "fetchEntry">>) {
  return { signature: null, kind: "prompt", fetchEntry: null, ...overrides };
}

async function failureRow(workerId: string, key: string) {
  return db()
    .prepare("SELECT * FROM worker_task_failures WHERE worker_id = ? AND task_key = ?")
    .bind(workerId, key)
    .first<any>();
}

// --- 常數 -------------------------------------------------------------------

describe("retry constants", () => {
  it("match the spec", () => {
    expect(retry.MAX_FAILURES_PER_WORKER_PER_JOB).toBe(2);
    expect(retry.MAX_JOB_ATTEMPTS).toBe(6);
    expect(retry.UNSUITABLE_THRESHOLD).toBe(2);
    expect(retry.UNSUITABLE_TTL_DAYS).toBe(7);
  });
});

// --- bumpAttempts / isExcludedForJob / hasFailedJob ------------------------------------

describe("bumpAttempts / isExcludedForJob / hasFailedJob", () => {
  it("bumps an empty map, storing this attempt's error", () => {
    const [json, mine, total] = retry.bumpAttempts("{}", "w1", "boom");
    expect(JSON.parse(json)).toEqual({ w1: { failures: 1, last_error: "boom" } });
    expect([mine, total]).toEqual([1, 1]);
  });

  it("accumulates per worker and totals", () => {
    const [first, mine1, total1] = retry.bumpAttempts("{}", "w1", "one");
    expect([mine1, total1]).toEqual([1, 1]);
    const [second, mine2, total2] = retry.bumpAttempts(first, "w1", "two");
    expect([mine2, total2]).toEqual([2, 2]);
    const [third, mine3, total3] = retry.bumpAttempts(second, "w2", "three");
    expect([mine3, total3]).toEqual([1, 3]);
    expect(retry.attemptsDict(third)).toEqual({ w1: 2, w2: 1 });
    // 每台的「最後錯誤」只跟著自己走，不被別台蓋掉。
    expect(retry.attemptErrors(third)).toEqual({ w1: "two", w2: "three" });
  });

  it("truncates the per-job last error at 200", () => {
    // I2：這個字串最後會進彙整訊息，而彙整訊息會進 `jobs.error`。存的時候就
    // 截在 200 字，一段 CUDA traceback 才不會把 job 列撐肥。
    const [json] = retry.bumpAttempts("{}", "w1", "x".repeat(900));
    expect(retry.attemptErrors(json)).toEqual({ w1: "x".repeat(retry.FINAL_ERROR_CHARS) });
  });

  it("keeps the previous error when no new one is given", () => {
    const [first] = retry.bumpAttempts("{}", "w1", "boom");
    const [second] = retry.bumpAttempts(first, "w1");
    expect(retry.attemptsDict(second)).toEqual({ w1: 2 });
    expect(retry.attemptErrors(second)).toEqual({ w1: "boom" });
  });

  it("tolerates garbage JSON", () => {
    // 一列壞掉的 attempts 不能讓 job_failed 整條路徑炸掉 -- 當成空的重算。
    for (const bad of ["not json", "[1,2]", null, undefined, ""]) {
      const [json, mine, total] = retry.bumpAttempts(bad, "w1", "boom");
      expect(retry.attemptsDict(json)).toEqual({ w1: 1 });
      expect([mine, total]).toEqual([1, 1]);
    }
    // 非數字的值也一樣：那一個 key 當 0 重新起算，其它 key 照舊。
    const [json, mine, total] = retry.bumpAttempts('{"w1": "x", "w2": 3}', "w1", "boom");
    expect([mine, total]).toEqual([1, 4]);
    expect(retry.attemptsDict(json)).toEqual({ w1: 1, w2: 3 });
  });

  it("still reads attempts written before the envelope existed", () => {
    // 舊形狀 `{worker_id: n}`（migration 0012 之後、這個跟進之前寫下的列）
    // 照樣讀得出次數，只是沒有錯誤字串可引。
    expect(retry.attemptsDict('{"w1": 2, "w2": 1}')).toEqual({ w1: 2, w2: 1 });
    expect(retry.attemptErrors('{"w1": 2}')).toEqual({});
    expect(retry.isExcludedForJob('{"w1": 2}', "w1")).toBe(true);
    // 新舊混在同一列也不會爆。
    const mixed = '{"w1": 2, "w2": {"failures": 1, "last_error": "boom"}}';
    expect(retry.attemptsDict(mixed)).toEqual({ w1: 2, w2: 1 });
    expect(retry.attemptErrors(mixed)).toEqual({ w2: "boom" });
  });

  it("excludes only at the threshold", () => {
    expect(retry.isExcludedForJob("{}", "w1")).toBe(false);
    const [once] = retry.bumpAttempts("{}", "w1", "boom");
    expect(retry.isExcludedForJob(once, "w1")).toBe(false);
    const [twice] = retry.bumpAttempts(once, "w1", "boom");
    expect(retry.isExcludedForJob(twice, "w1")).toBe(true);
    // 別台不受影響。
    expect(retry.isExcludedForJob(twice, "w2")).toBe(false);
  });

  it("hasFailedJob is true from the very first failure", () => {
    // I1：`tryReadopt` 拿這個判「這台是不是已經失敗過這張 job」-- 門檻是 1，
    // 不是 `MAX_FAILURES_PER_WORKER_PER_JOB`。
    expect(retry.hasFailedJob("{}", "w1")).toBe(false);
    const [once] = retry.bumpAttempts("{}", "w1", "boom");
    expect(retry.hasFailedJob(once, "w1")).toBe(true);
    expect(retry.hasFailedJob(once, "w2")).toBe(false);
    // 舊形狀也認得。
    expect(retry.hasFailedJob('{"w1": 1}', "w1")).toBe(true);
  });

  it("parses attempts defensively", () => {
    expect(retry.attemptsDict('{"w1": {"failures": 2, "last_error": "e"}}')).toEqual({ w1: 2 });
    expect(retry.attemptsDict("garbage")).toEqual({});
    expect(retry.attemptsDict(null)).toEqual({});
    expect(retry.attemptErrors("garbage")).toEqual({});
    // 壞掉的 envelope（沒有 failures、error 不是字串）不會炸。
    expect(retry.attemptsDict('{"w1": {"last_error": "e"}}')).toEqual({});
    expect(retry.attemptErrors('{"w1": {"failures": 1, "last_error": 5}}')).toEqual({});
    // bool / 浮點數 / 負數的值一律丟掉（Python 端的 isinstance 檢查）。
    expect(retry.attemptsDict('{"a": true, "b": 1.5, "c": -1, "d": 2}')).toEqual({ d: 2 });
  });
});

// --- addJobAttemptExclusions ------------------------------------------------

describe("addJobAttemptExclusions", () => {
  it("only adds workers at or above the per-job threshold", () => {
    const pairs = new Set<string>();
    retry.addJobAttemptExclusions(pairs, "j1", JSON.stringify({ w1: 2, w2: 1, w3: 5 }));
    expect(pairs).toEqual(new Set([exclusionKey("w1", "j1"), exclusionKey("w3", "j1")]));
  });
});

// --- summarizeFinalError ----------------------------------------------------

describe("summarizeFinalError", () => {
  it("is bilingual and truncates at 200", () => {
    const message = retry.summarizeFinalError(
      [
        ["A", "boom"],
        ["B", "x".repeat(300)],
      ],
      6
    );
    expect(message).toContain("已在 2 台 worker 嘗試 6 次");
    expect(message).toContain("failed on 2 workers after 6 attempts");
    expect(message).toContain("A: boom");
    expect(message).toContain("B: " + "x".repeat(200));
    expect(message).not.toContain("x".repeat(201));
    // zh-TW 先、en 後。
    expect(message.indexOf("已在 2 台")).toBeLessThan(message.indexOf("failed on 2 workers"));
  });

  it("joins workers with the full-width semicolon", () => {
    const message = retry.summarizeFinalError(
      [
        ["A", "one"],
        ["B", "two"],
      ],
      3
    );
    expect(message).toContain("A: one；B: two");
  });

  it("handles no attempt errors", () => {
    expect(retry.summarizeFinalError([], 0)).toContain("已在 0 台 worker 嘗試 0 次");
  });

  it("is byte-identical to the Python message shape", () => {
    // retry.py's f-string, spelled out once so a whitespace/punctuation drift
    // between the two stacks fails here rather than in a console screenshot.
    expect(retry.summarizeFinalError([["A", "boom"]], 6)).toBe(
      "已在 1 台 worker 嘗試 6 次全部失敗 / failed on 1 workers after 6 attempts：A: boom"
    );
  });
});

// --- unsuitableReason -------------------------------------------------------

describe("unsuitableReason", () => {
  it("keeps the first 12 characters of the key", () => {
    expect(retry.unsuitableReason("0123456789abcdef")).toBe("unsuitable:0123456789ab");
    expect(retry.unsuitableReason("short")).toBe("unsuitable:short");
    expect(retry.unsuitableReason(null)).toBe("unsuitable:");
  });
});

// --- taskKey ----------------------------------------------------------------

describe("taskKey", () => {
  it("prefers the signature", () => {
    expect(retry.taskKey(jobStub({ signature: "sig-abc" }))).toBe("sig-abc");
  });

  it("uses model_fetch:<name> for a model_fetch job without a signature", () => {
    const job = jobStub({
      kind: "model_fetch",
      fetchEntry: JSON.stringify({ name: "flux1-dev.safetensors", size_bytes: 10 }),
    });
    expect(retry.taskKey(job)).toBe("model_fetch:flux1-dev.safetensors");
  });

  it("is null without a signature or a usable fetch entry", () => {
    expect(retry.taskKey(jobStub({}))).toBeNull();
    expect(retry.taskKey(jobStub({ signature: "" }))).toBeNull();
    // model_fetch 但 entry 壞掉／沒有 name -> 沒有 key，不記錄。
    expect(retry.taskKey(jobStub({ kind: "model_fetch" }))).toBeNull();
    expect(retry.taskKey(jobStub({ kind: "model_fetch", fetchEntry: "not json" }))).toBeNull();
    expect(retry.taskKey(jobStub({ kind: "model_fetch", fetchEntry: "{}" }))).toBeNull();
  });
});

// --- recordFailure / clearFailure / activeUnsuitable ------------------------

describe("worker_task_failures adapter", () => {
  it("upserts and accumulates", async () => {
    const t = now();
    await retry.recordFailure(db(), "w1", "sig-a", "boom", "j1", t);
    await retry.recordFailure(db(), "w1", "sig-a", "boom again", "j2", t);

    const row = await failureRow("w1", "sig-a");
    expect(row.failures).toBe(2);
    expect(row.last_error).toBe("boom again");
    expect(row.last_job_id).toBe("j2");
  });

  it("is a no-op for a null key", async () => {
    await retry.recordFailure(db(), "w1", null, "boom", "j1", now());
    const { results } = await db().prepare("SELECT * FROM worker_task_failures").all<any>();
    expect(results).toHaveLength(0);
  });

  it("truncates last_error at 500", async () => {
    await retry.recordFailure(db(), "w1", "sig-a", "y".repeat(900), "j1", now());
    expect((await failureRow("w1", "sig-a")).last_error.length).toBe(500);
  });

  it("needs the threshold and the TTL to be active", async () => {
    const t = now();
    await retry.recordFailure(db(), "w1", "sig-a", "boom", "j1", t);
    // 一次還不算不適任。
    expect(await retry.activeUnsuitable(db(), t)).toEqual(new Set());

    await retry.recordFailure(db(), "w1", "sig-a", "boom", "j2", t);
    expect(await retry.activeUnsuitable(db(), t)).toEqual(new Set([exclusionKey("w1", "sig-a")]));

    // 把 updated_at 撥到 8 天前 -> 過了 TTL，不再生效（但列還在）。
    await retry.recordFailure(db(), "w1", "sig-a", "boom", "j3", daysAgo(t, 8));
    expect(await retry.activeUnsuitable(db(), t)).toEqual(new Set());
    expect(await failureRow("w1", "sig-a")).not.toBeNull();
  });

  it("clears only that pair", async () => {
    const t = now();
    for (const workerId of ["w1", "w2"]) {
      await retry.recordFailure(db(), workerId, "sig-a", "boom", "j1", t);
      await retry.recordFailure(db(), workerId, "sig-a", "boom", "j1", t);
    }
    expect(await retry.activeUnsuitable(db(), t)).toEqual(
      new Set([exclusionKey("w1", "sig-a"), exclusionKey("w2", "sig-a")])
    );

    await retry.clearFailure(db(), "w1", "sig-a");
    expect(await retry.activeUnsuitable(db(), t)).toEqual(new Set([exclusionKey("w2", "sig-a")]));
    expect(await failureRow("w1", "sig-a")).toBeNull();
  });

  it("clearing a row that isn't there is a no-op", async () => {
    await retry.clearFailure(db(), "nobody", "sig-a");
    await retry.clearFailure(db(), "nobody", null);
    expect(await retry.clearOneFailure(db(), "nobody", "sig-a")).toBe(0);
  });

  it("reports active and inactive rows per worker", async () => {
    const t = now();
    await retry.recordFailure(db(), "w1", "sig-active", "boom", "j1", t);
    await retry.recordFailure(db(), "w1", "sig-active", "boom", "j2", t);
    // 達門檻但過期。
    await retry.recordFailure(db(), "w1", "sig-stale", "old", "j3", daysAgo(t, 9));
    await retry.recordFailure(db(), "w1", "sig-stale", "old", "j4", daysAgo(t, 9));
    // 未達門檻。
    await retry.recordFailure(db(), "w1", "sig-once", "once", "j5", t);
    // 別台的列不該出現。
    await retry.recordFailure(db(), "w2", "sig-other", "nope", "j6", t);

    const rows = await retry.unsuitableRowsForWorker(db(), "w1", t, true);
    const byKey = new Map(rows.map((r) => [r.task_key, r]));
    expect(new Set(byKey.keys())).toEqual(new Set(["sig-active", "sig-stale", "sig-once"]));
    expect(byKey.get("sig-active")!.active).toBe(true);
    expect(byKey.get("sig-active")!.failures).toBe(2);
    expect(byKey.get("sig-active")!.last_error).toBe("boom");
    expect(byKey.get("sig-active")!.last_job_id).toBe("j2");
    expect(byKey.get("sig-active")!.updated_at).toBeTruthy();
    expect(byKey.get("sig-stale")!.active).toBe(false);
    expect(byKey.get("sig-once")!.active).toBe(false);
  });

  it("hides the free-text fields from a non-admin reader", async () => {
    // final review I1 -- ports test_retry.py's
    // `test_unsuitable_rows_hide_the_free_text_fields_from_a_non_admin`.
    const t = now();
    const error = "C:/models/loras/private-style.safetensors not found";
    await retry.recordFailure(db(), "w1", "sig-a", error, "j1", t);
    await retry.recordFailure(db(), "w1", "sig-a", error, "j2", t);

    const publicRows = await retry.unsuitableRowsForWorker(db(), "w1", t, false);
    const privateRows = await retry.unsuitableRowsForWorker(db(), "w1", t, true);

    expect(publicRows).toHaveLength(1);
    expect(privateRows).toHaveLength(1);
    expect(publicRows[0]!.last_error).toBeNull();
    expect(publicRows[0]!.last_job_id).toBeNull();
    expect(privateRows[0]!.last_error).toBe(error);
    expect(privateRows[0]!.last_job_id).toBe("j2");
    // 藏的只有那兩欄。
    expect({ ...publicRows[0]!, last_error: error, last_job_id: "j2" }).toEqual(privateRows[0]!);
  });

  it("clearWorkerFailures returns the number cleared", async () => {
    const t = now();
    await retry.recordFailure(db(), "w1", "sig-a", "boom", "j1", t);
    await retry.recordFailure(db(), "w1", "sig-b", "boom", "j2", t);
    await retry.recordFailure(db(), "w2", "sig-a", "boom", "j3", t);

    expect(await retry.clearWorkerFailures(db(), "w1")).toBe(2);
    expect(await retry.unsuitableRowsForWorker(db(), "w1", t, true)).toEqual([]);
    expect(await retry.unsuitableRowsForWorker(db(), "w2", t, true)).toHaveLength(1);
    expect(await retry.clearWorkerFailures(db(), "w1")).toBe(0);
  });
});
