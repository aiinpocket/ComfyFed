# P2P NAT 穿越（Phase 3.4）設計規格

**日期**：2026-09-16
**狀態**：已定案（使用者 2026-09-16 核准「1＋2 如果不用錢就做」）
**範圍**：第 1 層「平台回報 worker 的公網 IP」、第 2 層「agent 以 NAT-PMP／UPnP 自動開埠」、第 2b 層「平台在派 grant 前確認種子端可連」。第 3 層（平台中繼／R2 模型快取）不在本 spec。
**上游**：Phase 3.1 P2P（`docs/superpowers/plans/2026-09-14-phase3_1-p2p.md`）；`docs/SELF-HOSTING.zh.md` §「成員間 P2P 分塊傳輸」。兩個技術棧（`server/`、`cloud/`）行為逐項對齊；agent 出 0.1.12。

---

## 1. 現況與問題

- 種子端要有一個別人連得到的 HTTP 埠（`peer_listen_port`），`peer_url` 由 agent 自報：`peer_advertise_host` 或自動偵測的**區網 IP**。家用 NAT 後面的 worker 沒有任何穿越手段，所以只有同區網或手動轉埠的人能做種；平台也不驗證 `peer_url` 可不可連，配到一個連不到的種子只會讓拉方多等 30 秒 connect timeout 再落回官方載點。
- 平台其實看得到 worker 的來源 IP（WebSocket 連線），但沒回給 agent；agent 也沒有 STUN。
- eMule／Foxy 的做法：UPnP／NAT-PMP 自動開埠（HighID）、公網 IP 由伺服器回報、穿不出去的節點走中繼（LowID）。本 spec 補前兩項。

## 2. 第 1 層：平台回報公網 IP

握手成功後平台送的 `ready` frame 增加欄位：

```json
{"type": "ready", "remote_ip": "203.0.113.7"}
```

- Python：預設用 `request.client.host`；只有在平台設定 `trust_proxy` 為真（自架且放在反向代理後面時由管理員開啟，預設關閉）才取 `X-Forwarded-For` 第一跳。**（2026-09-16 實作修訂）** 這個值不只用來組通告位址，§4.2／§5 的「同公網 IP ⇒ 區網位址」判定也依賴它，所以不能無條件信任可偽造的標頭。
- Cloud：`CF-Connecting-IP`（Cloudflare 提供，權威）。
- 平台同時把它存到新欄位 `workers.remote_ip`（TEXT NULL，每次 hello 更新）。用途見 §5（同公網 IP ⇒ 很可能同一個 NAT ⇒ 可優先給區網位址）。
- 舊 agent 忽略未知欄位，無相容性問題。

## 3. 第 2 層：agent 自動開埠（`agent/comfyfed_agent/natmap.py`，純 stdlib）

只在 `peer_serve` 啟用（`peer_serve: true` 且 `peer_listen_port` 有值）且新設定 `peer_nat_traversal` 為 `"auto"`（預設）時執行；`"off"` 關閉。`peer_advertise_host` 有設時**不做映射**（使用者已經說了對外位址），直接沿用。

### 3.1 流程（在 `_start_peer_server` 之後、連平台之前，整體上限 8 秒）

1. 找預設閘道：Windows `route print -4 0.0.0.0` 解析 `0.0.0.0` 那列的 Gateway；macOS `route -n get default` 的 `gateway:`；Linux `ip route show default` 的 `via`。找不到 → 放棄映射（記一行 INFO）。
2. **NAT-PMP（RFC 6886）優先**：UDP 到 `<gateway>:5351`。
   - opcode 0 取外部 IP；opcode 2（TCP）請求 `internal port = external port = peer_listen_port`，lifetime 3600 秒。回應的 external port 可能不同於請求值，以回應為準。
   - 重送依 RFC：250 ms 起倍增，最多 3 次（總計 < 2 秒）。
3. NAT-PMP 沒回應 → **UPnP IGD**：
   - SSDP `M-SEARCH`（`239.255.255.250:1900`，ST `urn:schemas-upnp-org:device:InternetGatewayDevice:1`，MX 2，等 2.5 秒收集回應）。
   - 抓 `LOCATION` 的裝置描述 XML，依序找 `urn:schemas-upnp-org:service:WANIPConnection:1`、`WANPPPConnection:1`、`WANIPConnection:2`、`WANPPPConnection:2` 的 `controlURL`（四個 service type，這個優先順序；2026-09-16 實作修訂——原文只列了三項）。
   - SOAP `GetExternalIPAddress`；SOAP `AddPortMapping`（`NewProtocol=TCP`、`NewExternalPort=NewInternalPort=peer_listen_port`、`NewInternalClient=<區網 IP>`、`NewLeaseDuration=3600`、`NewPortMappingDescription=ComfyFed peer`）。若回 `718 ConflictInMappingEntry` 改用外部埠 `peer_listen_port+1`…最多試 5 個。
4. 兩者都失敗 → `peer_url` 退回現行行為（區網 IP），並在 log 記一行 WARNING：「無法自動開埠（NAT-PMP/UPnP 都沒有回應）；只有同區網的成員能從這台拉模型。要跨網路分享請在路由器手動轉埠並設定 peer_advertise_host。」（雙語）。
5. 成功 → 外部位址 = NAT-PMP/UPnP 回報的外部 IP；若為空或是私有位址（雙層 NAT，含 `100.64.0.0/10` CGNAT），改用 §2 的 `remote_ip`（第一次連線前還沒有，此時先用區網 IP 連平台，拿到 `ready.remote_ip` 後若與目前通告不同就重新連線一次以送出更新的 hello）。**重連節流是滾動視窗、不是「一個 process 一次」**（2026-09-16 實作修訂——與 §8 對齊，原文這裡誤寫成「最多自動重連一次」）：同一個位址變化 1 小時內最多重連一次，一小時之後同一個 process 還能再重連。多平台情境下 `remote_ip` **釘住第一個回報的公網值**——之後不同平台回報的其他公網 IP 只記 debug、不觸發重連，直到 agent 重啟；這是「簡單、可預測」優先於「永遠反映最新公網 IP」的取捨。
6. **續租**：每 30 分鐘重新請求同一筆映射（NAT-PMP 或 UPnP 同上），外部 IP 變了就重新連線更新 hello（受同一個 1 次／小時節流）；單次續租失敗只記 WARNING、沿用現有映射。**連續兩次續租失敗就降級**（2026-09-16 實作修訂，原文沒有這一段）：`peer_nat` 改回 `"lan"`、通告位址換回區網位址，並重連一次讓平台拿到新 hello；一次成功的續租就把失敗計數歸零。agent 結束時 `DeletePortMapping`／NAT-PMP lifetime 0（`shutdown()` 先取消並等續租工作結束，才做這次收尾）。
7. 所有網路操作都在 `asyncio.to_thread` 中執行，永遠不擋事件迴圈；任何例外只記 log。

### 3.2 hello 欄位

```json
{"type": "hello", ..., "peer_url": "http://203.0.113.7:8850", "peer_lan_url": "http://192.168.1.5:8850",
 "peer_nat": "natpmp" | "upnp" | "manual" | "lan" | "none"}
```

- `peer_url`：對外位址（映射成功／手動指定），或退回區網位址。
- `peer_lan_url`（選填）：區網位址，永遠帶（給同 NAT 的成員用）。
- `peer_nat`：怎麼得到 `peer_url` 的，供 console 顯示。
- 舊平台忽略未知欄位；舊 agent 不帶這些欄位時平台視為 `peer_lan_url = null`、`peer_nat = "lan"`。

### 3.3 `comfyfed status`

多印一行：`P2P 分享：開啟（natpmp，對外 http://203.0.113.7:8850，區網 http://192.168.1.5:8850，可連性：平台驗證通過）/ 關閉`。可連性來自 §4 的結果，經 `ready` 之後的心跳回覆…（見 §4.3）。

## 4. 第 2b 層：平台驗證種子可連（兩棧）

### 4.1 資料

`workers` 新欄位：`peer_lan_url TEXT NULL`、`peer_nat TEXT NOT NULL DEFAULT 'lan'`、`peer_reachable INTEGER NULL`（NULL = 未檢查，1/0）、`peer_checked_at DATETIME NULL`、`remote_ip TEXT NULL`。

### 4.2 檢查

- agent 的 peer server 新增 `GET /peer/health`：不需憑證，回 `204`，無內容、無識別資訊。其他路徑不變（一律憑證）。
- 平台在收到 hello 且 `peer_url` 存在時，非同步對 `peer_url + "/peer/health"` 發 GET（connect+read 3 秒），結果寫入 `peer_reachable`／`peer_checked_at`。Cloud 用 `fetch`（Workers outbound，免費額度）；Python 用 `httpx` 於執行緒。
- 心跳時若 `peer_checked_at` 超過 10 分鐘則重測；worker 離線時 `peer_reachable` 清為 NULL（與 `peer_url` 一起在 `requeue_stale` 清）。
- 平台端先靜態拒絕 `peer_url` 主機為 loopback／link-local／私有網段（`10/8`、`172.16/12`、`192.168/16`、`169.254/16`、`100.64/10` CGNAT、`fc00::/7`、`::1`）的位址（2026-09-16 實作修訂：補上 `100.64/10`，與 agent natmap 的私有判定對齊）：這種 `peer_url` 直接標 `peer_reachable = 0`（不發請求），但仍保存 `peer_lan_url`。這同時關掉現行文件所述的「申報內網位址誘導其他 agent 請求」問題（只剩區網位址，且只給同 NAT 的成員）。**（2026-09-16 實作修訂）只驗 IP 字面值**：`peer_url` 的主機不是字面 IP（是個網域名稱／DDNS）時，兩棧**都不發任何探針**，`peer_reachable` 留在 NULL（＝未檢查，因此不是合格種子——`online_seeders` 只收 `peer_reachable = 1`），但 `peer_checked_at` 照蓋，免得每一拍心跳都重跑一次同樣的判斷。理由：`is_private_peer_url`/`isPrivatePeerUrl` 刻意不做 DNS 解析，而一個名稱今天解到哪、明天解到哪都不是平台能保證的，探過也不代表什麼。操作文件（§10）的建議因此與實作一致：DDNS 場景請用 `peer_advertise_host` 指定 IP，否則該 worker 的 P2P 狀態會一直停在「未檢查」。
- `online_seeders`／`onlineSeeders` 的種子條件增加：`peer_reachable = 1` **或**（拉方與種子 `remote_ip` 相同且 `peer_lan_url` 存在）。

### 4.3 回饋給 agent

平台對每個心跳的回覆現況是不回覆；新增：當 `peer_reachable` 從 NULL 變成 0/1，或每次 hello 後檢查完成，平台推 `{"type": "peer_status", "reachable": true|false, "checked_url": "..."}`。agent 記到記憶體供 `comfyfed status` 顯示，並在 `reachable=false` 且 `peer_nat != "manual"` 時記一行 WARNING（同 §3.1 第 4 點的文字）。舊 agent 收到未知 type 會忽略（現行 `_handle_message` 對未知 type 記 debug）。

## 5. Grant 選種子與位址順序

`POST /api/agent/peer-grant` 回應新增 `seeder_urls: [...]`（現有 `peer_url` 欄位保留＝第一個），順序：

1. 若拉方 `remote_ip` == 種子 `remote_ip` 且種子有 `peer_lan_url` → `[peer_lan_url, peer_url]`。
2. 否則 → `[peer_url]`（此時種子必為 `peer_reachable = 1`）。

fetcher 依序嘗試，每個位址 connect timeout 5 秒（現行 30 秒改為 5，read timeout 不變 120）；全部失敗才落回官方載點鏈。舊 agent 只看 `peer_url`，行為不變。

## 6. Console

Workers 頁 P2P 欄顯示：`peer_nat` 的圖示文字（自動開埠 natpmp/upnp、手動、僅區網、關閉）、對外位址、可連性徽章（已驗證／不可連／未檢查）。i18n zh-TW/en。

## 7. 不做的事

- 不做 UDP 打洞、不做 TURN／中繼（第 3 層另案）。
- 不做 IPv6 映射（NAT-PMP/UPnP 只做 IPv4；`peer_url` 為 IPv6 公網位址時直接做可連性檢查即可）。
- 不改 grant 的簽章內容與憑證模型。
- 不做 PCP（RFC 6887）；NAT-PMP 在絕大多數家用路由器（含 Apple、ASUS、TP-Link）與 UPnP 互補已足夠。

## 8. 錯誤處理

- 映射／續租任何失敗只記 log，peer 服務照常啟動（區網仍可用）。
- 平台可連性檢查失敗（timeout、非 204）= 不可連，不拋錯，不影響 hello 主流程。
- `ready.remote_ip` 缺席（舊平台）→ agent 只用映射回報的外部 IP；兩者皆無 → 區網位址。
- 一個 process 內因位址變化的自動重連最多 1 次／小時。

## 9. 測試

- `tests/agent/test_natmap.py`：NAT-PMP 封包編碼／解碼（含 external port 與請求不同、錯誤碼）、SSDP 回應解析、IGD XML 找 controlURL（WANIP／WANPPP／v2）、SOAP 請求組裝與回應解析（含 718 衝突改埠）、閘道解析三平台字串、私有位址判定、重試時序（fake clock）、整體 8 秒上限；用 fake UDP/HTTP 伺服器，不碰真路由器。
- `tests/agent/test_peerserve.py`：`/peer/health` 204 無憑證；其他路徑仍 403。
- `tests/agent/test_runner.py`：hello 帶 `peer_url/peer_lan_url/peer_nat`；`ready.remote_ip` 不同於通告時重連一次且只一次；`peer_status` 訊息更新狀態。
- 兩棧：`ready` 帶 `remote_ip`（Python `X-Forwarded-For` 優先；cloud `CF-Connecting-IP`）；hello 欄位落庫；私有公網位址靜態拒絕；可連性檢查 mock（204→1、timeout→0）；10 分鐘重測；離線清除；`online_seeders` 新條件（含同 `remote_ip` 走區網）；grant 回應 `seeder_urls` 順序；`peer_status` 推送一次。
- 手動：在 POKAI-HOME（ASUS/家用路由器）實跑 `peer_serve: true`，`comfyfed status` 顯示 natpmp 或 upnp 與對外位址，平台 Workers 頁顯示「已驗證」；從 jessie 的 Mac 送一個缺模型且 POKAI-HOME 有的工作，觀察 grant 走 P2P 並產生 `p2p_upload` 收據。

## 10. 文件（2026-09-16 完成，見 Task 8）

`docs/SELF-HOSTING.zh.md`／`.en.md` P2P 一節改寫「開啟方式」：安裝時自動探測、什麼情況要手動、`peer_nat_traversal: "off"`、可連性徽章的意義、`comfyfed status` 的 P2P 那一行、`p2p-probe` 在 agent 執行中會直接拒絕（`agent_running`）；把「通告位址由 worker 自行申報，平台不代驗」那段改為「平台驗證過才會派出去」的新行為，並補上：可連性探針只認 IP 位址（網域名稱／DDNS 的 `peer_url` 永遠停在「未檢查」）、私有網段清單含 `100.64/10` CGNAT、`peer_url`/`peer_lan_url` 一律是 agent 組出的 `scheme://host:port` 形式。README 出算力一節加一句「模型分享會自動請路由器開埠」。兩份文件逐節對齊（zh/en）。

## 11. 安裝腳本自動決定要不要做種（2026-09-16 使用者定案）

「安裝腳本探一下，探得到就開 P2P 提供者，探不到就不開。」

- agent 0.1.12 新增 CLI 子命令 `comfyfed-agent p2p-probe [--port 8850] [--json]`：執行 §3.1 的映射流程（NAT-PMP → UPnP，整體 8 秒上限），成功時印出一行 JSON `{"ok": true, "method": "natpmp"|"upnp", "external_ip": "...", "external_port": 8850, "lan_ip": "..."}` 並 exit 0，隨即釋放測試用的映射（不留映射；正式映射由 `run` 時建立）；失敗 exit 1 並印 `{"ok": false, "reason": "no_gateway"|"no_response"|"error", ...}`。
- `install.sh` / `install.ps1` 在註冊完成、偵測 ComfyUI 之後、設定自動啟動之前，新增步驟「偵測 P2P 分享能力」：呼叫 `p2p-probe --json`。
  - 成功 → 寫入 `agent.json`：`peer_serve: true`、`peer_listen_port: 8850`（若使用者已自行設定 `peer_serve` 或 `peer_listen_port` 則不覆蓋），印「路由器支援自動開埠（natpmp/upnp），已開啟模型分享」。
  - 失敗 → 不改設定（`peer_serve` 維持 `false`），印「路由器沒有回應 UPnP／NAT-PMP，未開啟模型分享；到路由器開啟 UPnP 後重跑安裝指令即可自動開啟，或手動設定 peer_advertise_host 與轉埠」。
  - 規則簡化為：**只有在 `peer_serve` 目前為 `false` 且 `peer_listen_port` 為 `null`（從未設定過）時才自動開啟**；曾經手動設過埠或手動關閉的（`peer_listen_port` 有值但 `peer_serve` 為 `false`）一律尊重。
- `run` 時的行為（§3）不變：`peer_serve` 為真才做映射與做種；探測失敗只影響安裝時的預設，不會在執行期把已開啟的 `peer_serve` 關掉。
- **`p2p-probe` 在 agent 已經在跑時直接拒絕**（2026-09-16 實作修訂，原文沒有這一段）：判準與 `comfyfed status` 相同（state 檔存在且時間戳未過期），拒絕時印 `{"ok": false, "reason": "agent_running"}`、exit 1，**連 `detect_gateway` 都不呼叫**——探測本身會建立再刪除一筆映射，如果 agent 已經在跑，那筆映射就是 agent 的正式映射，刪掉會當場關閉做種。安裝腳本設計上就是在啟動 agent 之前跑這個指令。
- 文件（§10）加入這段：安裝時自動探測；如何事後開啟（開 UPnP 重跑安裝指令，或手動設定）。
