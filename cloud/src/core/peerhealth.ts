/**
 * 平台端的種子可連性驗證（Phase 3.4 §4.2）。Parity source:
 * `server/comfyfed_server/peerhealth.py`，逐項對齊（同樣的私有網段清單、
 * 同樣的 3 秒逾時、同樣只認 204、同樣「失敗 = 不可連，不是錯誤」）。
 *
 * 刻意只做三件事（見 peerhealth.py 的模組 docstring）：私有／loopback／
 * link-local／CGNAT 的 IP 字面值靜態拒絕（不發請求）；主機是 DNS 名稱時
 * **完全不探**（fix round 1 裁示 —— 名稱解到哪不是我們能保證的，
 * `peer_reachable` 留 NULL）；其餘 IP 字面值才真的探，而且只看狀態碼。
 *
 * 模組介面（兩棧同名同義，Python 版是 snake_case）：
 *
 * - `isPrivatePeerUrl(url)` / `is_private_peer_url`
 * - `isIpLiteralPeerUrl(url)` / `is_ip_literal_peer_url`
 * - `peerHostAddress(url)` / `peer_host_address`
 * - `healthUrl(peerUrl)` / `health_url`：探針真正打的位址。
 * - `probePeerHealth(url)`：唯一真的碰網路的地方（測試 spy 掉它；底下走
 *   `cloudflare:sockets` 的 `connect()`，理由見該函式的 docstring）。
 * - `openSocket(hostname, port)`：`connect()` 的薄包裝，探針測試的 spy 縫。
 * - `refresh(db, workerId, peerUrl, notify?, opts?)`
 * - `needsRecheck(checkedAt, now)` / `needs_recheck`
 * - `TIMEOUT_MS`（Python: `TIMEOUT_SECONDS`）、`RECHECK_MS`（Python:
 *   `RECHECK_SECONDS`）、`HEALTH_PATH`。
 *
 * 真正的網路存取關在 `probePeerHealth` 這個薄函式裡，測試以
 * `vi.spyOn(peerhealth, "probePeerHealth")` 攔掉 —— 這是這個測試樹既有的
 * mock 手法（見 dispatch.spec.ts 對 scheduler.match）。`refresh` 因此必須
 * 透過模組 namespace（下面的 `self`）呼叫它：ESM 裡直接呼叫本地繫結的話，
 * spy 換掉的是 namespace 上的匯出，攔不到同檔內的呼叫。
 */
import { connect } from "cloudflare:sockets";
import * as self from "./peerhealth";
import * as queries from "../db/queries";
import { toSqliteTimestamp, sqliteTimestampToEpochMs } from "../db/queries";

/** Global Constraints：可連性檢查 3 秒。 */
export const TIMEOUT_MS = 3000;
/** 心跳時 `peer_checked_at` 超過 10 分鐘就重測。 */
export const RECHECK_MS = 600_000;
/** 必須與 agent 的 `peerserve.HEALTH_PATH` 逐字相同。 */
export const HEALTH_PATH = "/peer/health";

/** 一個 IP 字面值。IPv4-mapped IPv6 在剖析時就折成 `v4`，所以判定只有
 * 兩種形狀要處理。Ports peerhealth.py's `_ip_literal` 的回傳。 */
export type IpLiteral = { v4: number[] } | { v6: number[] };

/** 四段十進位的 IPv4。WHATWG URL 會把 `2130706433`／`0177.0.0.1`／`127.1`
 * 這些寫法正規化成四段（`new URL("http://2130706433").hostname` 就是
 * "127.0.0.1"），所以這裡只需要認四段形 —— Python 端沒有這個保證，才要
 * 自己走 `socket.inet_aton`（見 peerhealth.py 的 `_ip_literal`）。 */
function parseIpv4(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  if (!parts.every((p) => /^\d{1,3}$/.test(p))) return null;
  const octets = parts.map((p) => Number(p));
  return octets.every((n) => n >= 0 && n <= 255) ? octets : null;
}

/** 把 IPv6 字面值展開成 8 個 16-bit group（含 `::` 壓縮與結尾嵌 IPv4 的
 * 寫法）。字面比對的正則不夠用：`fc::1` 是 `00fc::1`，**不在** fc00::/7 裡，
 * 但 `/^f[cd].*:/` 這種寫法會把它誤判成私有（fix round 1 的 minor）。 */
function parseIpv6(host: string): number[] | null {
  const lower = host.toLowerCase().split("%")[0]!;
  if (!lower.includes(":")) return null;
  const halves = lower.split("::");
  if (halves.length > 2) return null;

  const groupsOf = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    const pieces = part.split(":");
    for (let i = 0; i < pieces.length; i++) {
      const piece = pieces[i]!;
      if (piece.includes(".")) {
        // 只有最後一段可以是嵌入的 IPv4（`::ffff:10.0.0.1`）。
        if (i !== pieces.length - 1) return null;
        const v4 = parseIpv4(piece);
        if (v4 === null) return null;
        out.push((v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(piece)) return null;
      out.push(parseInt(piece, 16));
    }
    return out;
  };

  const head = groupsOf(halves[0]!);
  if (head === null) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const tail = groupsOf(halves[1]!);
  if (tail === null) return null;
  const fill = 8 - head.length - tail.length;
  if (fill < 1) return null; // `::` 至少要吃掉一個 group
  return [...head, ...new Array<number>(fill).fill(0), ...tail];
}

function parseIpLiteral(host: string): IpLiteral | null {
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const v6 = parseIpv6(bare);
  if (v6 !== null) {
    // IPv4-mapped（`::ffff:10.0.0.1` 與等價的 `::ffff:a00:1`）折成 IPv4，
    // 否則它不落在任何一條 IPv6 私有網段裡。Parity: peerhealth.py 用
    // `IPv6Address.ipv4_mapped` 做同一件事。
    if (v6.slice(0, 5).every((g) => g === 0) && v6[5] === 0xffff) {
      return { v4: [v6[6]! >> 8, v6[6]! & 0xff, v6[7]! >> 8, v6[7]! & 0xff] };
    }
    return { v6 };
  }
  const v4 = parseIpv4(bare);
  return v4 === null ? null : { v4 };
}

/** 拒絕清單（parity: peerhealth.py 的 `PRIVATE_NETWORKS`）。spec §4.2 逐字：
 * 10/8、172.16/12、192.168/16、169.254/16、fc00::/7、::1；loopback 127/8 與
 * IPv6 link-local fe80::/10 一併。100.64/10 是 CGNAT（裁示）。
 *
 * fix round 3 再補「根本不是一台主機」的那幾類：未指定位址（0.0.0.0/8 與
 * `::`，含 `http://0` 這種寫法）、多播（224/4、ff00::/8）、保留（240/4，含
 * 255.255.255.255）。 */
function isPrivateAddress(address: IpLiteral): boolean {
  if ("v4" in address) {
    const [a, b] = address.v4 as [number, number, number, number];
    if (a === 0) return true; // 0.0.0.0/8（`http://0` 正規化成 0.0.0.0）
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 127) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true; // 224/4 多播 + 240/4 保留（含 255.255.255.255）
    return false;
  }
  const g = address.v6;
  if (g.every((x) => x === 0)) return true; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
  if ((g[0]! & 0xfe00) === 0xfc00) return true; // fc00::/7
  if ((g[0]! & 0xffc0) === 0xfe80) return true; // fe80::/10
  if ((g[0]! & 0xff00) === 0xff00) return true; // ff00::/8 多播
  return false;
}

/** `url` 主機的正規化位址；主機是 DNS 名稱、或 URL 根本解不開時回 null。
 * Ports peerhealth.py's `peer_host_address`. */
export function peerHostAddress(url: string): IpLiteral | null {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  if (!host) return null;
  return parseIpLiteral(host);
}

/** `url` 的主機是私有／loopback／link-local 位址。名稱型主機回 false ——
 * 這裡不做 DNS 解析（那會變成另一個可被誘導的請求面），而且名稱根本不會
 * 被探（見 `isIpLiteralPeerUrl`）。Ports peerhealth.py's
 * `is_private_peer_url`. */
export function isPrivatePeerUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return true;
  }
  if (!host) return true;
  const address = parseIpLiteral(host);
  if (address === null) return false;
  return isPrivateAddress(address);
}

/** `url` 的主機是 IP 字面值（不是 DNS 名稱）。只有字面值才會被探針驗證
 * （fix round 1 裁示）。Ports peerhealth.py's `is_ip_literal_peer_url`. */
export function isIpLiteralPeerUrl(url: string): boolean {
  return peerHostAddress(url) !== null;
}

/** 探針真正打的位址，也是推給 agent 的 `peer_status.checked_url`。
 * Ports peerhealth.py's `health_url`. */
export function healthUrl(peerUrl: string): string {
  return peerUrl.replace(/\/+$/, "") + HEALTH_PATH;
}

/** 開一條到種子的 raw TCP 連線。獨立成一個薄函式是為了讓測試 spy 掉它
 * （`vi.spyOn(peerhealth, "openSocket")`），跟 `probePeerHealth` 自己被
 * `refresh` 的測試 spy 掉是同一套手法。 */
export function openSocket(hostname: string, port: number): Socket {
  return connect({ hostname, port }, { allowHalfOpen: false });
}

/** HTTP/1.x 狀態列 → 狀態碼；不是狀態列就 null。 */
export function parseStatusLine(line: string): number | null {
  const m = /^HTTP\/1\.[01] (\d{3})(?: |\r|$)/.exec(line);
  return m ? Number(m[1]) : null;
}

/** 對 `url` 用 raw TCP 送一個最小的 HTTP/1.1 GET，只讀狀態列，只有 204
 * 算通過；整體 3 秒逾時。
 *
 * **為什麼不用 `fetch`**：Workers 的 `fetch()` 子請求「只能打 URL，不能直接
 * 打 IP 位址」（Cloudflare Workers known issues），而這個探針**刻意只探 IP
 * 字面值**（主機名一律不探，見 `isIpLiteralPeerUrl`）—— 用 `fetch` 的結果是
 * 每一台種子都被判成不可連（2026-09-16 實機驗證：UPnP 開埠成功、外部埠檢
 * 服務確認 8850 開著，雲端仍寫 `peer_reachable=0`）。`cloudflare:sockets`
 * 的 `connect()` 沒有這個限制，任意 IP／埠都行（除了 25 與 Cloudflare 自家
 * 網段，兩者本來就不會是種子）。
 *
 * 安全姿態與 fetch 版完全相同：不跟轉址（狀態列不是 204 就是 false，302
 * 連 Location 都不看）；對面是一台我們不信任的機器，所以最多讀 512 bytes
 * 就收線，狀態列一到手立刻取消讀取（parity: peerhealth.py 的
 * `client.stream` + `follow_redirects=False`）。任何例外（逾時、連線拒絕、
 * 非 HTTP 回應）都是 false —— 不可連是預期結果，不是錯誤。 */
export async function probePeerHealth(url: string): Promise<boolean> {
  let socket: Socket | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const target = new URL(url);
    if (target.protocol !== "http:") return false;
    // `new URL("http://[::1]:8850").hostname` 保留中括號；connect() 要的是
    // 不含括號的位址，Host 標頭則要含括號的形式。
    const hostname = target.hostname.replace(/^\[|\]$/g, "");
    const port = target.port ? Number(target.port) : 80;
    const request =
      `GET ${target.pathname}${target.search} HTTP/1.1\r\n` +
      `Host: ${target.hostname}:${port}\r\n` +
      `User-Agent: comfyfed-peerhealth\r\n` +
      `Connection: close\r\n\r\n`;

    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("peerhealth: probe timed out")), TIMEOUT_MS);
    });

    const opened = self.openSocket(hostname, port);
    socket = opened;
    const exchange = (async (): Promise<boolean> => {
      const writer = opened.writable.getWriter();
      await writer.write(new TextEncoder().encode(request));
      writer.releaseLock();

      const reader = opened.readable.getReader();
      const decoder = new TextDecoder();
      let text = "";
      try {
        while (text.length < 512) {
          const { value, done } = await reader.read();
          if (done) break;
          text += decoder.decode(value, { stream: true });
          const newline = text.indexOf("\n");
          if (newline >= 0) {
            return parseStatusLine(text.slice(0, newline).replace(/\r$/, "")) === 204;
          }
        }
        return false;
      } finally {
        reader.cancel().catch(() => {});
      }
    })();

    return await Promise.race([exchange, timeout]);
  } catch {
    return false;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (socket) {
      try {
        socket.close().catch(() => {});
      } catch {
        // 已經關了 / 從沒開成，無所謂。
      }
    }
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
    if (!isPrivatePeerUrl(peerUrl) && !isIpLiteralPeerUrl(peerUrl)) {
      // fix round 1 裁示：名稱型主機不驗。結論留 NULL（⇒ 不是合格種子），
      // 但時間戳照蓋，免得每一拍心跳都白跑一次這段。
      console.debug(`peerhealth: worker ${workerId} advertises a hostname peer_url (${peerUrl}); not probing`);
      await queries.updateWorkerPeerReachable(db, workerId, null, toSqliteTimestamp(new Date()));
      return null;
    }

    // 「變了沒」比的是**這一輪開始探之前**庫裡那個值。Python 那邊
    // `_record` 在同一個 session 裡讀舊值再寫新值，中間不會被別人插進來；
    // D1 沒有那個交易，所以讀取要放在（最長 3 秒的）探針**之前**，否則另
    // 一拍心跳在探的期間寫進來的值會被當成「我自己寫之前的舊值」，害這一
    // 輪把真正的變化當成沒變而不推送。
    const previous = await queries.getWorkerPeerReachable(db, workerId);

    let reachable: boolean;
    if (isPrivatePeerUrl(peerUrl)) {
      console.info(
        `peerhealth: worker ${workerId} advertises a private peer_url (${peerUrl}); marking unreachable without probing`
      );
      reachable = false;
    } else {
      reachable = await self.probePeerHealth(checkedUrl);
    }

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
