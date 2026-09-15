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

// 中文：算圖實際上是丟給聯邦裡的「遠端」worker 排隊執行，不是本機跑；使用者按下
// 面板的 Queue／執行後，畫面上完全沒有變化，很容易懷疑是不是根本沒送出去。這裡
// 攔截 `window.fetch`（只包一次，用 window 旗標擋掉重複注入造成的雙重包裝），
// 專門盯 `POST .../prompt`（佇列端點；同時比對 `/comfy/api/prompt` 這種絕對路徑
// 與 `api/prompt` 這種相對路徑）。ComfyUI 對「驗證失敗」也是回 200，body 帶
// `{error, node_errors}`，所以光看 HTTP 狀態不夠：只有 response.ok 而且 body
// 沒有帶真正的 error／node_errors 時，才視為送出成功並跳出提示；驗證失敗一律讓
// ComfyUI 自己的錯誤 UI 顯示，不搶戲。一律 clone 之後再讀 body，原始 response
// 原封不動交還呼叫端；toast 本身的邏輯全包在 try/catch 裡，絕不能讓它的例外反過來
// 弄壞真正的 fetch 呼叫。
//
// English: Rendering actually runs on a REMOTE worker queued elsewhere in the
// federation, not locally -- after the user clicks Queue/執行 on the panel,
// nothing visibly changes, which easily reads as "did that even go through?"
// This intercepts `window.fetch` (wrapped exactly once, guarded by a window
// flag so double injection doesn't double-wrap), watching specifically for
// `POST .../prompt` (the queue endpoint; matches both the absolute
// `/comfy/api/prompt` path and a relative `api/prompt`). ComfyUI also returns
// HTTP 200 on a validation failure, with `{error, node_errors}` in the body --
// so the HTTP status alone isn't enough: only when the response is ok AND the
// body carries no real error/node_errors is this treated as a successful
// submission and the toast shown; a validation failure is left entirely to
// ComfyUI's own error UI. The body is always read from a clone so the caller
// still gets the original response untouched; the toast logic itself is
// wrapped in try/catch so it can never throw back into the fetch caller.
const QUEUED_TOAST_ID = "comfyfed-queued-toast";

function comfyfedShowQueuedToast() {
  const existing = document.getElementById(QUEUED_TOAST_ID);
  if (existing) existing.remove();

  const reduceMotion =
    window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const el = document.createElement("div");
  el.id = QUEUED_TOAST_ID;
  el.style.cssText =
    "position:fixed;top:16px;right:16px;z-index:10001;max-width:360px;" +
    "background:#1f5c33;color:#fff;padding:12px 36px 12px 16px;border-radius:8px;" +
    "box-shadow:0 4px 16px rgba(0,0,0,0.3);font:13px/1.5 system-ui,sans-serif;" +
    (reduceMotion
      ? ""
      : "transition:opacity .3s ease,transform .3s ease;transform:translateY(-8px);opacity:0;");

  el.innerHTML =
    '<div style="font-weight:600;margin-bottom:4px;">已加入算圖佇列 / Job queued</div>' +
    '<div>工作已排入等待佇列，交由聯邦中的 worker 處理。可回主控台查看進度，' +
    "或直接進行下一個作業。 / Your job is queued and will be picked up by a worker " +
    "in the federation. Check progress in the console, or just start your next one.</div>" +
    '<button type="button" aria-label="Close" style="position:absolute;top:6px;right:8px;' +
    "background:none;border:none;color:#fff;font-size:16px;line-height:1;cursor:pointer;" +
    'padding:2px;">×</button>';

  document.body.appendChild(el);

  const dismiss = () => {
    if (el.isConnected) el.remove();
  };
  const closeBtn = el.querySelector("button");
  if (closeBtn) closeBtn.addEventListener("click", dismiss);

  if (!reduceMotion) {
    requestAnimationFrame(() => {
      el.style.transform = "translateY(0)";
      el.style.opacity = "1";
    });
  }

  setTimeout(dismiss, 6000);
}

(function comfyfedInstallQueueToast() {
  if (window.__comfyfedQueueToastInstalled) return;
  window.__comfyfedQueueToastInstalled = true;

  const originalFetch = window.fetch.bind(window);

  function comfyfedRequestInfo(input, init) {
    let method = "GET";
    let url = "";
    if (init && init.method) {
      method = init.method;
    } else if (typeof Request !== "undefined" && input instanceof Request) {
      method = input.method;
    }
    if (typeof input === "string") {
      url = input;
    } else if (typeof URL !== "undefined" && input instanceof URL) {
      url = input.href;
    } else if (typeof Request !== "undefined" && input instanceof Request) {
      url = input.url;
    }
    return { method: (method || "GET").toUpperCase(), url };
  }

  function comfyfedIsPromptUrl(url) {
    try {
      return new URL(url, location.href).pathname.endsWith("/prompt");
    } catch (_e) {
      return false;
    }
  }

  window.fetch = async function comfyfedPatchedFetch(input, init) {
    const response = await originalFetch(input, init);
    try {
      const { method, url } = comfyfedRequestInfo(input, init);
      if (method === "POST" && response.ok && comfyfedIsPromptUrl(url)) {
        response
          .clone()
          .json()
          .then((body) => {
            const hasError = !!(
              body &&
              (body.error || (body.node_errors && Object.keys(body.node_errors).length > 0))
            );
            if (!hasError) comfyfedShowQueuedToast();
          })
          .catch(() => {});
      }
    } catch (_e) {
      // toast 邏輯絕不能影響真正的 fetch 呼叫 / never let toast logic break the real fetch
    }
    return response;
  };
})();

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
