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

// 中文：ComfyUI 的擴充模組是以 ES module 動態 import 的，匯出物件本身內容不重要，
// 但需要是個有效模組；副作用（插入 <style>）已經在上面完成了。
//
// English: ComfyUI extensions are dynamically imported as ES modules; the
// exported object's contents don't matter, it just needs to be a valid
// module. The side effect (inserting the <style> tag) already happened above.
export default {
  name: "comfyfed.hideLoginButton",
};
`;
