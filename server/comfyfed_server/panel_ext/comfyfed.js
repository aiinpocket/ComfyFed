// 中文：這個 ComfyUI 前端擴充模組的唯一用途，是隱藏面板上死掉的 Comfy 雲端「登入」按鈕。
// ComfyFed 是純本地聯邦服務，沒有 Comfy 雲端帳號系統可登入；`show_signin_button`
// 這個 feature flag 在前端 1.52.7 其實沒有任何程式碼在讀，`LoginButton.vue` 只看
// 前端自己記錄的 `isLoggedIn` 狀態，跟伺服器端的 flag 完全無關。因此唯一能關掉這顆
// 按鈕的正規做法，就是透過 `GET /comfy/api/extensions` 這個官方擴充機制，注入一段
// CSS 蓋掉它——而不是去改動釘死版本的前端 dist 檔案。
//
// English: The sole purpose of this ComfyUI frontend extension is to hide the
// dead Comfy-cloud "Log in" button in the panel. ComfyFed is a purely local
// federation server with no Comfy-cloud account system to log into; the
// `show_signin_button` feature flag is dead code in frontend 1.52.7 -- nothing
// reads it. `LoginButton.vue` renders based solely on its own client-side
// `isLoggedIn` state, unrelated to any server flag. So the only sanctioned way
// to suppress the button is through the official `GET /comfy/api/extensions`
// mechanism, injecting a small stylesheet -- rather than patching the pinned
// frontend dist.

// 中文：選擇器已對照實際打包後的 dist（GraphView-*.js）驗證：登入按鈕在兩個掛載點
// （TopMenuSection、WorkflowTabs）都渲染為 `data-testid="login-button"`。
// 加一個前綴比對的備援選擇器，容忍未來版本把 testid 改成 `login-button-xxx` 之類的
// 變體；同時連帶蓋掉 hover 時彈出的 `login-button-popover`，以防按鈕本身用別的方式
// 隱藏後，浮出視窗仍殘留可觸發的路徑。
//
// English: Selectors verified against the real built dist (GraphView-*.js):
// the login button renders as `data-testid="login-button"` at both mount
// points (TopMenuSection, WorkflowTabs). A prefix-match fallback selector is
// included in case a future frontend renames the testid to something like
// `login-button-xxx`; the hover popover (`login-button-popover`) is hidden too,
// as a belt-and-suspenders measure in case the button is ever hidden by some
// other means that leaves the popover trigger reachable.
const style = document.createElement("style");
style.textContent = `
  [data-testid="login-button"],
  [data-testid^="login-button-"],
  [data-testid="login-button-popover"] {
    display: none !important;
  }
`;
document.head.appendChild(style);

// 中文：零 worker 在線時的明確提示。object_info 是所有在線 worker 能力的「交集」，
// 沒有任何 worker 在線時它是空物件——此時面板上每個節點都會紅掉、範本載入全部
// 顯示「缺少節點包」、LoadImage 連上傳按鈕都不會渲染，使用者只會看到一片壞掉的
// 畫面而猜不到原因（實際案例：使用者以為雲端「沒有地方放參考圖」）。這裡直接在
// 頁面頂端放一條橫幅講清楚；worker 上線後改提示重新整理（節點定義只在頁面載入
// 時抓一次，不會熱更新）。查詢失敗時一律當作「有 worker」——寧可不提示，也不要
// 在暫時性網路錯誤時誤報。
//
// English: An explicit banner for the zero-online-workers state. object_info
// is the INTERSECTION of every online worker's capabilities; with no worker
// online it is an empty object -- every node renders red, templates all
// report missing node packs, and LoadImage never even shows its upload
// button, leaving the user staring at a broken-looking page with no clue
// (live-caught: a user concluded the cloud had "nowhere to put reference
// images"). Show a top banner saying exactly that; once a worker comes
// online, switch to a refresh hint (node definitions are fetched once at
// page load and never hot-reload). Any fetch failure counts as "workers
// exist" -- better to stay quiet than to nag on a transient error.
const BANNER_ID = "comfyfed-no-workers-banner";

async function comfyfedFleetHasNodes() {
  try {
    const r = await fetch("api/object_info", { credentials: "same-origin" });
    if (!r.ok) return true;
    const info = await r.json();
    return !!info && typeof info === "object" && Object.keys(info).length > 0;
  } catch (_e) {
    return true;
  }
}

function comfyfedShowBanner(html) {
  let el = document.getElementById(BANNER_ID);
  if (!el) {
    el = document.createElement("div");
    el.id = BANNER_ID;
    el.style.cssText =
      "position:fixed;top:0;left:0;right:0;z-index:10000;" +
      "background:#7c2d2d;color:#fff;padding:8px 16px;text-align:center;" +
      "font:13px/1.5 system-ui,sans-serif;";
    document.body.appendChild(el);
  }
  el.innerHTML = html;
}

function comfyfedRemoveBanner() {
  const el = document.getElementById(BANNER_ID);
  if (el) el.remove();
}

async function comfyfedWatchFleet() {
  if (await comfyfedFleetHasNodes()) return; // 正常狀態不打擾 / healthy: stay quiet
  comfyfedShowBanner(
    "目前沒有任何 worker 在線——節點與範本要等至少一台 worker 上線後才能使用；" +
      "安裝 worker 請看主控台的「新增 Worker」。 / No workers are online -- nodes and " +
      "templates need at least one online worker; see the console's \"Add Worker\" to install one."
  );
  const timer = setInterval(async () => {
    if (await comfyfedFleetHasNodes()) {
      clearInterval(timer);
      comfyfedShowBanner(
        "worker 已上線！請重新整理頁面載入節點。 / A worker is online! Refresh the page to load its nodes. " +
          '<a href="#" onclick="location.reload();return false" style="color:#ffd28a">重新整理 / Refresh</a>'
      );
    }
  }, 30000);
}

comfyfedWatchFleet();

// 中文：ComfyUI 的擴充模組是以 ES module 動態 import 的，匯出物件本身內容不重要，
// 但需要是個有效模組；副作用（插入 <style>、零 worker 橫幅）已經在上面完成了。
//
// English: ComfyUI extensions are dynamically imported as ES modules; the
// exported object's contents don't matter, it just needs to be a valid
// module. The side effects (the <style> tag, the zero-worker banner) already
// happened above.
export default {
  name: "comfyfed.hideLoginButton",
};
