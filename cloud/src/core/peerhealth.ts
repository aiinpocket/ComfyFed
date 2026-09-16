/**
 * 平台端的種子可連性驗證（Phase 3.4 §4.2）。Parity source:
 * `server/comfyfed_server/peerhealth.py`，逐項對齊（同樣的私有網段清單、
 * 同樣的 3 秒逾時、同樣只認 204、同樣「失敗 = 不可連，不是錯誤」）。
 *
 * 模組介面（兩棧同名同義，Python 版是 snake_case）：
 *
 * - `isPrivatePeerUrl(url)` / `is_private_peer_url`
 * - `healthUrl(peerUrl)` / `health_url`：探針真正打的位址。
 * - `probePeerHealth(url)`：唯一真的 `fetch` 的地方（測試 spy 掉它）。
 * - `refresh(db, workerId, peerUrl, notify?, opts?)`
 * - `needsRecheck(checkedAt, now)` / `needs_recheck`
 * - `TIMEOUT_MS`（Python: `TIMEOUT_SECONDS`）、`RECHECK_MS`（Python:
 *   `RECHECK_SECONDS`）、`HEALTH_PATH`。
 *
 * 真正的 `fetch` 關在 `probePeerHealth` 這個薄函式裡，測試以
 * `vi.spyOn(peerhealth, "probePeerHealth")` 攔掉 —— 這是這個測試樹既有的
 * mock 手法（見 dispatch.spec.ts 對 scheduler.match）。`refresh` 因此必須
 * 透過模組 namespace（下面的 `self`）呼叫它：ESM 裡直接呼叫本地繫結的話，
 * spy 換掉的是 namespace 上的匯出，攔不到同檔內的呼叫。
 */
import * as self from "./peerhealth";
import * as queries from "../db/queries";
import { toSqliteTimestamp, sqliteTimestampToEpochMs } from "../db/queries";

/** Global Constraints：可連性檢查 3 秒。 */
export const TIMEOUT_MS = 3000;
/** 心跳時 `peer_checked_at` 超過 10 分鐘就重測。 */
export const RECHECK_MS = 600_000;
/** 必須與 agent 的 `peerserve.HEALTH_PATH` 逐字相同。 */
export const HEALTH_PATH = "/peer/health";

/** spec §4.2 的清單，逐字：10/8、172.16/12、192.168/16、169.254/16、
 * fc00::/7、::1；loopback 127/8 與 IPv6 link-local fe80::/10 一併。
 * 100.64/10 是 CGNAT（裁示補上，對齊 agent natmap 的私有判定）。 */
function isPrivateIpv4(host: string): boolean | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  if (!parts.every((p) => p.length > 0 && /^\d+$/.test(p))) return null;
  const octets = parts.map((p) => Number(p));
  if (octets.some((n) => n < 0 || n > 255)) return null;
  const [a, b] = octets as [number, number, number, number];
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function isPrivateIpv6(host: string): boolean | null {
  const lower = host.toLowerCase();
  if (!lower.includes(":")) return null;
  if (lower === "::1") return true;
  // fc00::/7 = fc.. 或 fd..；fe80::/10 = fe8/fe9/fea/feb..
  if (/^f[cd][0-9a-f]{0,2}:/.test(lower)) return true;
  if (/^fe[89ab][0-9a-f]?:/.test(lower)) return true;
  return false;
}

/** `url` 的主機是私有／loopback／link-local 位址。主機名（不是 IP）回
 * false —— 這裡不做 DNS 解析（那會變成另一個可被誘導的請求面）。
 * Ports peerhealth.py's `is_private_peer_url`. */
export function isPrivatePeerUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return true;
  }
  if (!host) return true;
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const v6 = isPrivateIpv6(bare);
  if (v6 !== null) return v6;
  const v4 = isPrivateIpv4(bare);
  if (v4 !== null) return v4;
  return false;
}

/** 探針真正打的位址，也是推給 agent 的 `peer_status.checked_url`。
 * Ports peerhealth.py's `health_url`. */
export function healthUrl(peerUrl: string): string {
  return peerUrl.replace(/\/+$/, "") + HEALTH_PATH;
}

/** 對 `url` 發一個 3 秒的 GET，只有 204 算通過。任何例外（逾時、DNS、連線
 * 拒絕）都是 false —— 不可連是預期結果，不是錯誤。 */
export async function probePeerHealth(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return response.status === 204;
  } catch {
    return false;
  }
}

/** 驗一台 worker 的 `peer_url` 並落庫。回 true/false/null（沒有 `peer_url`
 * ⇒ 清成未檢查）。
 *
 * `notify` 有給就推一次 `peer_status`（spec §4.3）。什麼時候推由
 * `opts.notifyOnChangeOnly` 決定（裁示）：hello 觸發的檢查每次完成都推；
 * 心跳觸發的重測只有在結論相對於庫裡存的 `peer_reachable` 變了才推。
 *
 * Ports peerhealth.py's `refresh`. */
export async function refresh(
  db: D1Database,
  workerId: string,
  peerUrl: string | null,
  notify?: (reachable: boolean, checkedUrl: string) => void,
  opts: { notifyOnChangeOnly?: boolean } = {}
): Promise<boolean | null> {
  try {
    if (!peerUrl) {
      await queries.updateWorkerPeerReachable(db, workerId, null, null);
      return null;
    }

    const checkedUrl = healthUrl(peerUrl);
    let reachable: boolean;
    if (isPrivatePeerUrl(peerUrl)) {
      console.info(
        `peerhealth: worker ${workerId} advertises a private peer_url (${peerUrl}); marking unreachable without probing`
      );
      reachable = false;
    } else {
      reachable = await self.probePeerHealth(checkedUrl);
    }

    // 「變了沒」比的是**寫入前**庫裡那個值（parity: peerhealth.py 的
    // `_record` 回傳 previous）。
    const previous = await queries.getWorkerPeerReachable(db, workerId);
    await queries.updateWorkerPeerReachable(db, workerId, reachable ? 1 : 0, toSqliteTimestamp(new Date()));
    const unchanged = previous !== null && previous !== undefined && previous === (reachable ? 1 : 0);
    if (notify && !(opts.notifyOnChangeOnly && unchanged)) {
      notify(reachable, checkedUrl);
    }
    return reachable;
  } catch (err) {
    console.error(`peerhealth: reachability check for worker ${workerId} failed`, err);
    return null;
  }
}

/** 心跳時是否該重測。Ports peerhealth.py's `needs_recheck`. */
export function needsRecheck(checkedAt: string | null, now: Date): boolean {
  if (!checkedAt) return true;
  return now.getTime() - sqliteTimestampToEpochMs(checkedAt) >= RECHECK_MS;
}
