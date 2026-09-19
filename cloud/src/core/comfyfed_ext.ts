/**
 * Byte-for-byte copy of `server/comfyfed_server/panel_ext/comfyfed.js`, the
 * one real `/comfy/api/extensions` entry (see comfyapi.py's `extensions()`/
 * `comfyfed_extension_js()`). Python serves the file straight off disk via
 * `importlib.resources`; a Worker has no filesystem to serve a static asset
 * from at this path (the `ASSETS` binding's directory is reserved for the
 * console frontend bundle, not this file), so the content is embedded here
 * as a string constant instead and served literally by
 * `routes/comfyapi.ts`'s `GET /comfy/api/comfyfed-ext/comfyfed.js`.
 *
 * `test/comfyfed-ext.spec.ts` asserts this constant is byte-identical to the
 * real Python-side file (read at Node time in vitest.config.ts and injected
 * as the `__COMFYFED_EXT_JS_SOURCE__` global, the same pattern
 * `test/apply-migrations.ts` uses for D1 migrations) -- so a future edit to
 * the Python file that isn't mirrored here fails the cloud suite instead of
 * silently drifting.
 */
export const COMFYFED_EXT_JS = `// 中文：這個 ComfyUI 前端擴充模組的唯一用途，是隱藏面板上死掉的 Comfy 雲端「登入」按鈕。
// ComfyFed 是純本地聯邦服務，沒有 Comfy 雲端帳號系統可登入；\`show_signin_button\`
// 這個 feature flag 在前端 1.52.7 其實沒有任何程式碼在讀，\`LoginButton.vue\` 只看
// 前端自己記錄的 \`isLoggedIn\` 狀態，跟伺服器端的 flag 完全無關。因此唯一能關掉這顆
// 按鈕的正規做法，就是透過 \`GET /comfy/api/extensions\` 這個官方擴充機制，注入一段
// CSS 蓋掉它——而不是去改動釘死版本的前端 dist 檔案。
//
// English: The sole purpose of this ComfyUI frontend extension is to hide the
// dead Comfy-cloud "Log in" button in the panel. ComfyFed is a purely local
// federation server with no Comfy-cloud account system to log into; the
// \`show_signin_button\` feature flag is dead code in frontend 1.52.7 -- nothing
// reads it. \`LoginButton.vue\` renders based solely on its own client-side
// \`isLoggedIn\` state, unrelated to any server flag. So the only sanctioned way
// to suppress the button is through the official \`GET /comfy/api/extensions\`
// mechanism, injecting a small stylesheet -- rather than patching the pinned
// frontend dist.

// 中文：選擇器已對照實際打包後的 dist（GraphView-*.js）驗證：登入按鈕在兩個掛載點
// （TopMenuSection、WorkflowTabs）都渲染為 \`data-testid="login-button"\`。
// 加一個前綴比對的備援選擇器，容忍未來版本把 testid 改成 \`login-button-xxx\` 之類的
// 變體；同時連帶蓋掉 hover 時彈出的 \`login-button-popover\`，以防按鈕本身用別的方式
// 隱藏後，浮出視窗仍殘留可觸發的路徑。
//
// English: Selectors verified against the real built dist (GraphView-*.js):
// the login button renders as \`data-testid="login-button"\` at both mount
// points (TopMenuSection, WorkflowTabs). A prefix-match fallback selector is
// included in case a future frontend renames the testid to something like
// \`login-button-xxx\`; the hover popover (\`login-button-popover\`) is hidden too,
// as a belt-and-suspenders measure in case the button is ever hidden by some
// other means that leaves the popover trigger reachable.
const style = document.createElement("style");
style.textContent = \`
  [data-testid="login-button"],
  [data-testid^="login-button-"],
  [data-testid="login-button-popover"] {
    display: none !important;
  }
\`;
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
      "templates need at least one online worker; see the console's \\"Add Worker\\" to install one."
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
// 攔截 \`window.fetch\`（只包一次，用 window 旗標擋掉重複注入造成的雙重包裝），
// 專門盯 \`POST .../prompt\`（佇列端點；同時比對 \`/comfy/api/prompt\` 這種絕對路徑
// 與 \`api/prompt\` 這種相對路徑）。ComfyUI 對「驗證失敗」也是回 200，body 帶
// \`{error, node_errors}\`，所以光看 HTTP 狀態不夠：只有 response.ok 而且 body
// 沒有帶真正的 error／node_errors 時，才視為送出成功並跳出提示；驗證失敗一律讓
// ComfyUI 自己的錯誤 UI 顯示，不搶戲。一律 clone 之後再讀 body，原始 response
// 原封不動交還呼叫端；toast 本身的邏輯全包在 try/catch 裡，絕不能讓它的例外反過來
// 弄壞真正的 fetch 呼叫。
//
// English: Rendering actually runs on a REMOTE worker queued elsewhere in the
// federation, not locally -- after the user clicks Queue/執行 on the panel,
// nothing visibly changes, which easily reads as "did that even go through?"
// This intercepts \`window.fetch\` (wrapped exactly once, guarded by a window
// flag so double injection doesn't double-wrap), watching specifically for
// \`POST .../prompt\` (the queue endpoint; matches both the absolute
// \`/comfy/api/prompt\` path and a relative \`api/prompt\`). ComfyUI also returns
// HTTP 200 on a validation failure, with \`{error, node_errors}\` in the body --
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

// 中文：接管官方前端「缺少模型」卡片上的「下載」鈕。官方 1.52.7 的實作是純瀏覽器端的
// \`<a href download>\` 再 click，把模型檔抓進使用者自己的電腦，從頭到尾不碰伺服器；
// ComfyFed 是聯邦，模型只該落在 worker 的磁碟上，所以這顆鈕的原始行為跟設計相反。
// 這裡用 capture 階段的 click 監聽攔下它——必須趕在官方 handler 建出那個 <a> 之前，
// 所以是 \`preventDefault()\` ＋ \`stopImmediatePropagation()\`——改成 POST
// \`api/comfyfed/model-fetch\` 請平台派一台合適的 worker 去抓，再每 2 秒輪詢進度。
// 模型的 \`{name, url, directory}\` 從 \`window.app.graph\` 遞迴收集（含 subgraph 節點的
// \`properties.models[]\`）；單顆鈕靠它的 aria-label（i18n 是「下載 {model}」／
// 「Download {model}」，model 名是子字串）比對是哪一個模型，比不到就只顯示
// 「無法辨識模型」而不亂送單。「全部下載」＝對卡片上每一顆下載鈕各送一張單。
//
// English: Take over the stock "Download" button on the missing-models card.
// Upstream 1.52.7 implements it as a purely browser-side \`<a href download>\`
// that is clicked to pull the file onto the user's own machine, never touching
// the server -- but in ComfyFed models belong on worker disks, so that stock
// behaviour is backwards here. A capture-phase click listener intercepts it
// (it has to win the race before the stock handler builds that <a>, hence
// \`preventDefault()\` + \`stopImmediatePropagation()\`) and instead POSTs to
// \`api/comfyfed/model-fetch\`, asking the platform to dispatch a suitable
// worker, then polls the job every 2 seconds. Model \`{name, url, directory}\`
// triples are collected recursively from \`window.app.graph\` (including
// \`properties.models[]\` on subgraph nodes); a single button is matched to its
// model by which name its aria-label contains (the i18n strings are
// "下載 {model}" / "Download {model}", with the name as a substring). No match
// means we say so and submit nothing. "Download all" = one job per download
// button on the card.
const FETCH_API = "api/comfyfed/model-fetch";
const FETCH_POLL_MS = 2000;
const FETCH_BANNER_ID = "comfyfed-model-fetch-banner";
const FETCH_MAX_TRANSIENT_RETRIES = 30;

const FETCH_TEXT = {
  starting: "下載中 0% / Fetching 0%",
  pct: (p) => \`下載中 \${p}% / Fetching \${p}%\`,
  ready: "已就緒 / Ready",
  unknown: "無法辨識模型，請重新整理面板後再試 / Could not identify the model; reload the panel and retry",
  done: (n) =>
    \`模型 \${n} 已下載到 worker，請重新整理以載入 / Model \${n} landed on a worker; reload to use it\`,
  failed: (n, e) => \`模型 \${n} 下載失敗：\${e} / Fetch of \${n} failed: \${e}\`,
  unknownError: "未知錯誤 / unknown error",
  gone: "下載任務已不存在，伺服器可能重啟過，請重新整理面板 / The fetch job no longer exists (the server may have restarted); reload the panel",
  lost: "與伺服器連線中斷，無法繼續追蹤下載進度，請重新整理面板 / Lost contact with the server while tracking the fetch; reload the panel",
  reload: "重新整理 / Reload",
  dismiss: "關閉 / Dismiss",
};

// 中文：遞迴走訪圖上每個節點的 \`properties.models[]\`，子圖節點（\`node.subgraph\`）也要
// 進去；同名只留第一筆。圖還沒建好時 \`window.app\` 可能不存在，吞掉例外回空表即可，
// 呼叫端會顯示「無法辨識模型」。
//
// English: Walk every node's \`properties.models[]\` recursively, descending
// into subgraph nodes (\`node.subgraph\`); first entry wins on duplicate names.
// \`window.app\` may not exist yet before the graph is built -- swallow that and
// return an empty map; the caller then reports "could not identify".
function comfyfedCollectGraphModels() {
  const found = new Map();
  const walk = (graph) => {
    if (!graph) return;
    for (const node of graph._nodes || graph.nodes || []) {
      const models = (node && node.properties && node.properties.models) || [];
      for (const m of models) {
        if (m && typeof m.name === "string" && !found.has(m.name)) {
          found.set(m.name, {
            name: m.name,
            url: typeof m.url === "string" ? m.url : "",
            directory: typeof m.directory === "string" ? m.directory : "",
          });
        }
      }
      if (node && node.subgraph) walk(node.subgraph);
    }
  };
  try {
    walk(window.app && window.app.graph);
  } catch (_e) {
    // 圖尚未就緒 / graph not ready yet
  }
  return found;
}

// 中文：沿用零 worker 橫幅的視覺語彙（置頂、固定、同字體），成功用綠底、失敗用同一個
// 紅底。文字一律走 textContent，模型名與伺服器 message 都是外部資料，不能當 HTML 插。
//
// English: Reuses the zero-worker banner's visual language (pinned to the top,
// same font); green for success, the same red for failure. Text always goes in
// via textContent -- model names and server messages are outside data and must
// never be injected as HTML.
function comfyfedFetchBanner(text, options) {
  const opts = options || {};
  let el = document.getElementById(FETCH_BANNER_ID);
  if (!el) {
    el = document.createElement("div");
    el.id = FETCH_BANNER_ID;
    document.body.appendChild(el);
  }
  el.style.cssText =
    "position:fixed;top:0;left:0;right:0;z-index:10002;" +
    "color:#fff;padding:8px 16px;display:flex;gap:12px;align-items:center;" +
    "justify-content:center;font:13px/1.5 system-ui,sans-serif;" +
    (opts.error ? "background:#7c2d2d;" : "background:#1f5c33;");
  el.textContent = text;

  const button = (label, onClick) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.style.cssText =
      "background:rgba(255,255,255,0.15);border:1px solid rgba(255,255,255,0.4);" +
      "color:#fff;border-radius:4px;padding:2px 8px;cursor:pointer;font:inherit;";
    b.addEventListener("click", onClick);
    el.appendChild(b);
  };

  if (opts.reload) button(FETCH_TEXT.reload, () => location.reload());
  button(FETCH_TEXT.dismiss, () => el.remove());
}

function comfyfedRestoreFetchButton(button) {
  delete button.dataset.comfyfedFetching;
  button.disabled = false;
  if (typeof button.dataset.comfyfedLabel === "string") {
    button.textContent = button.dataset.comfyfedLabel;
  }
}

// 中文：每 2 秒問一次單子狀態。\`queued\`／\`assigned\`／\`running\` 都算進行中，只有在
// \`stage === "fetching_models"\` 且有 \`fetch_pct\` 時才更新百分比（其他階段沒有進度可報）。
// 4xx 一律是終局：\`GET .../{job_id}\` 的 404 代表這張單已經不存在（伺服器重啟、單子被清掉），
// 再問一萬次也不會變出來——所以還原按鈕、跳紅字，而不是每 2 秒永遠空轉下去。只有 5xx 與
// 網路錯誤才算暫時性（面板可能只是短暫斷線），而且連續重試上限 30 次，超過就放棄並提示。
//
// English: Poll the job every 2 seconds. \`queued\`/\`assigned\`/\`running\` all
// count as in flight; the percentage is only updated while
// \`stage === "fetching_models"\` with a \`fetch_pct\` (other stages have no
// progress to report). Any 4xx is terminal: a 404 from
// \`GET .../{job_id}\` means the job is simply gone (server restart, job
// reaped), and asking again forever will not bring it back -- so restore the
// button and show the error instead of spinning every 2 s for good. Only 5xx
// and network errors count as transient (the panel may just be briefly
// offline), and even those are capped at 30 consecutive retries.
async function comfyfedPollFetchJob(jobId, button, name) {
  let transient = 0;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, FETCH_POLL_MS));
    let status;
    try {
      const r = await fetch(\`\${FETCH_API}/\${encodeURIComponent(jobId)}\`, {
        credentials: "same-origin",
      });
      if (r.status >= 400 && r.status < 500) {
        let detail = r.status === 404 ? FETCH_TEXT.gone : FETCH_TEXT.unknownError;
        try {
          const errorBody = await r.json();
          if (errorBody && errorBody.message) detail = errorBody.message;
        } catch (_e) {
          // 錯誤 body 不是 JSON 就用預設字串 / non-JSON error body: keep the default
        }
        comfyfedRestoreFetchButton(button);
        comfyfedFetchBanner(FETCH_TEXT.failed(name, detail), { error: true });
        return;
      }
      if (!r.ok) throw new Error("HTTP " + r.status);
      status = await r.json();
    } catch (_e) {
      transient += 1;
      if (transient > FETCH_MAX_TRANSIENT_RETRIES) {
        comfyfedRestoreFetchButton(button);
        comfyfedFetchBanner(FETCH_TEXT.failed(name, FETCH_TEXT.lost), { error: true });
        return;
      }
      continue;
    }
    if (!status) continue;
    transient = 0;
    if (status.status === "done") {
      delete button.dataset.comfyfedFetching;
      button.textContent = FETCH_TEXT.ready;
      comfyfedFetchBanner(FETCH_TEXT.done(name), { reload: true });
      return;
    }
    if (status.status === "failed" || status.status === "cancelled") {
      comfyfedRestoreFetchButton(button);
      comfyfedFetchBanner(FETCH_TEXT.failed(name, status.error || FETCH_TEXT.unknownError), {
        error: true,
      });
      return;
    }
    if (status.stage === "fetching_models" && typeof status.fetch_pct === "number") {
      button.textContent = FETCH_TEXT.pct(Math.floor(status.fetch_pct));
    }
  }
}

// 中文：送出下載單。伺服器回 201（新單）或 200（\`reused: true\`，同一個模型已經有人按過）
// 都照樣輪詢那張單；400 帶 \`{error, message}\`，直接把伺服器的中英雙語 message 顯示出來。
//
// English: Submit the fetch job. The server answers 201 (fresh job) or 200
// (\`reused: true\` -- someone already asked for this model); either way we poll
// that job. A 400 carries \`{error, message}\`, and the server's own bilingual
// message is what gets shown.
async function comfyfedRequestModelFetch(model, button) {
  // 中文：同一顆鈕只准有一張單在飛。沒有這道閘，連按兩次「全部下載」會對每個模型各送第二張
  // 單、並在同一顆鈕上跑起第二個輪詢迴圈——兩個迴圈會搶著寫同一個 label（「已就緒」被蓋回
  // 「下載中 N%」），其中一個收到 failed 還會把另一個仍在輪詢的鈕重新啟用。
  // English: One in-flight job per button. Without this gate, double-clicking
  // "download all" fires a second job per model and starts a second poll loop
  // on the same button -- the two loops fight over the label ("Ready" reverting
  // to "Fetching N%"), and a \`failed\` in one re-enables a button the other is
  // still polling.
  if (button.disabled || button.dataset.comfyfedFetching === "1") return;
  button.dataset.comfyfedFetching = "1";
  if (typeof button.dataset.comfyfedLabel !== "string") {
    button.dataset.comfyfedLabel = button.textContent || "";
  }
  button.disabled = true;
  button.textContent = FETCH_TEXT.starting;

  let ok = false;
  let body = null;
  try {
    const r = await fetch(FETCH_API, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: model.name,
        directory: model.directory || "",
        url: model.url || "",
      }),
    });
    ok = r.ok;
    body = await r.json();
  } catch (e) {
    ok = false;
    body = { message: String(e) };
  }

  if (!ok || !body || !body.job_id) {
    comfyfedRestoreFetchButton(button);
    const detail = (body && body.message) || FETCH_TEXT.unknownError;
    comfyfedFetchBanner(FETCH_TEXT.failed(model.name, detail), { error: true });
    return;
  }
  comfyfedPollFetchJob(body.job_id, button, model.name);
}

// 中文：aria-label 是「下載 {model}」／「Download {model}」，所以是找「label 裡包含哪個
// 模型名」。同時命中多個時取最長的那個名字——短名有可能是長名的子字串。
//
// English: The aria-label reads "下載 {model}" / "Download {model}", so the
// match is "which model name does this label contain". On multiple hits the
// longest name wins, since a short name can be a substring of a longer one.
function comfyfedModelForButton(button, models) {
  const label = button.getAttribute("aria-label") || button.textContent || "";
  let best = null;
  for (const m of models.values()) {
    if (label.includes(m.name) && (!best || m.name.length > best.name.length)) best = m;
  }
  return best;
}

// 中文：對照釘死的 1.52.7 bundle 確認過：\`[data-testid="missing-model-actions"]\` 容器裡
// 只有一顆鈕，就是 \`missing-model-download-all\`。所以這裡直接指名那顆，而不是攔容器裡
// 的每一顆 button——否則未來版本往容器塞一顆「關閉」／「仍要繼續」時，那顆會被吞掉並
// 反過來觸發整張卡片的大量派工。註冊也比照 queue toast 加上 window 旗標，重複注入時
// 不會掛兩份監聽而送出兩張單。
//
// English: Verified against the pinned 1.52.7 bundle: the
// \`[data-testid="missing-model-actions"]\` container holds exactly one button,
// \`missing-model-download-all\`. Target that testid directly rather than every
// button in the container -- otherwise a future Close / "continue anyway"
// control dropped into that container would be swallowed and turned into a
// mass dispatch of the whole card. Registration is guarded by a window flag
// like the queue toast, so a double injection cannot install two listeners and
// submit twice.
(function comfyfedInstallModelFetchInterceptor() {
  if (window.__comfyfedModelFetchInstalled) return;
  window.__comfyfedModelFetchInstalled = true;

  document.addEventListener(
    "click",
    (ev) => {
      const target = ev.target instanceof Element ? ev.target : null;
      if (!target) return;
      const single = target.closest('[data-testid="missing-model-download"]');
      const all = single ? null : target.closest('[data-testid="missing-model-download-all"]');
      if (!single && !all) return;

      ev.preventDefault();
      ev.stopImmediatePropagation();

      if (single) {
        // 中文：已經有單在飛就什麼都不做（但點擊仍然吞掉，官方 handler 不能跑）。
        // English: Already in flight: do nothing -- but still swallow the click
        // so the stock handler never runs.
        if (single.dataset.comfyfedFetching === "1") return;
        const model = comfyfedModelForButton(single, comfyfedCollectGraphModels());
        if (!model) {
          comfyfedFetchBanner(FETCH_TEXT.unknown, { error: true });
          return;
        }
        comfyfedRequestModelFetch(model, single);
        return;
      }

      // 中文：「全部下載」＝卡片上每一列的下載鈕各來一張單；已在進行中的鈕由
      // \`comfyfedRequestModelFetch\` 自己擋掉 / English: "download all" = one job
      // per download button on the card; buttons already in flight are gated
      // inside \`comfyfedRequestModelFetch\`.
      const models = comfyfedCollectGraphModels();
      let matched = 0;
      for (const b of document.querySelectorAll('[data-testid="missing-model-download"]')) {
        const model = comfyfedModelForButton(b, models);
        if (!model) continue;
        matched += 1;
        comfyfedRequestModelFetch(model, b);
      }
      if (matched === 0) comfyfedFetchBanner(FETCH_TEXT.unknown, { error: true });
    },
    true
  );
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
`;
