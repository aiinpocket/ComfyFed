# Installer Task 1 fix-wave report

**Status:** All 11 findings fixed. Green.

**Commit:** `7725a4c05bdab18f4b31f4924dcb0e48a70f418e` on branch `one-line-installer`
(worktree `D:\WebstormProjects\ComfyFed-installer`)

## Test summary

- `bash -n install.sh` — OK
- PSParser check (`[ref]$errs`, `ReadAllText` + explicit UTF-8 decoder) — `ErrorCount: 0`
- `pytest tests/server/test_installers.py -q` — 55 passed
- `pytest tests -q` (full suite, foreground) — **1118 passed** (baseline 1083 + 35 new), 0 failed

## Findings addressed

1. CRITICAL token injection — fixed. `installer_routes.py` now validates
   `?token=` against `^[A-Za-z0-9_-]{1,128}$` before any substitution; on
   mismatch returns `400 {"error":"invalid_token"}`. Tested with `'`, `"`,
   backtick, `$(`, newline, `%0A`, `%27`, and combined payloads across all
   three script routes; valid `token_urlsafe`-shaped tokens still substitute.
2. HIGH platform_url — fixed. Same regex treatment for both the configured
   `platform_url` setting and the `request.base_url` Host-derived fallback,
   validated before substitution in all three scripts and `/api/platform`.
   Invalid configured setting → `500 invalid_platform_url`; invalid
   Host-derived fallback → `400 invalid_request_origin` without echoing the
   raw value back.
3. HIGH ps1 dead error handling — fixed. Added `if ($LASTEXITCODE -ne 0) {
   throw ... }` after venv creation, wheel `pip install`, `pip install
   py7zr`, `extract7z`, apply-detection (which previously had no try/catch
   at all), and `schtasks`. "安裝完成" is now unreachable after any failed
   native step.
4. HIGH macOS mktemp — fixed. `install.sh` now does `WHEEL_TMPDIR=$(mktemp
   -d)` + fixed `$WHEEL_TMPDIR/agent.whl`, portable across GNU and BSD
   `mktemp`.
5. HIGH vacuous PSParser test — fixed. Test now captures `[ref]$errs`,
   asserts `Count -eq 0`, and reads the file via
   `[System.IO.File]::ReadAllText($path, [System.Text.UTF8Encoding]::new($false))`
   instead of `Get-Content -Raw` (ANSI-decoding on 5.1). Added
   `test_install_cmd_stored_with_crlf`.
6. MEDIUM sh partial-download guard — fixed. Entire script body wrapped in
   `main() { ... }`, closed with `main "$@"` at EOF; verified with `bash -n`.
7. MEDIUM ps1 hygiene — fixed. `[Net.ServicePointManager]::SecurityProtocol
   -bor Tls12` and `$ProgressPreference = 'SilentlyContinue'` set at top.
8. MEDIUM sh systemd steps — fixed. `daemon-reload` / `enable --now` for
   both units now go through `fail_step` with container/WSL/no-user-dbus
   guidance (manual command + `loginctl enable-linger` hint) instead of
   dying bare under `set -e`.
9. MEDIUM source consistency — fixed. `install.sh`'s `COMFYFED_COMFY_GIT_URL`
   default changed from `comfyanonymous/ComfyUI` to `Comfy-Org/ComfyUI`,
   matching `install.ps1`'s portable-asset URL (`v0.35.0` /
   `ComfyUI_windows_portable_amd.7z` confirmed to exist for that tag).
10. MEDIUM ps1 encoding — fixed. `install.ps1` is now stored with a UTF-8
    BOM on disk; `installer_routes._read_template` decodes with
    `utf-8-sig` (BOM-transparent for all three files) so the served body
    is clean BOM-less UTF-8. Verified no BOM/mojibake in the response and
    that the on-disk file starts with `EF BB BF`.
11. LOW, all five sub-items — fixed:
    - (a) Removed `install.sh`'s dead `launcher.sh` generation; units/plists
      already `ExecStart`/`ProgramArguments` directly.
    - (b) `install.ps1` now accesses `$versionInfo.PSObject.Properties['wheel_url'
      /'sha256']` instead of dotted property access, StrictMode-safe.
    - (c) systemd `ExecStart=` paths quoted; launchd plist paths run through
      a new `xml_escape` helper (`&`/`<`/`>`).
    - (d) `Cache-Control: no-store` added to all three script responses
      (and the JSON error responses).
    - (e) `install.ps1` now honors `COMFYFED_COMFY_VERSION` (mirrors sh's
      `COMFYFED_COMFY_REF`), alongside the existing
      `COMFYFED_COMFY_PORTABLE_URL`.

## Unfixed / deferred

None. All 11 findings (including all LOW sub-items) were fixed in this pass.
