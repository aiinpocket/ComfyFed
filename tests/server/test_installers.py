"""Tests for the one-line installer endpoints and packaged installer scripts.

See the "一行安裝指令 addendum" section of
`docs/superpowers/specs/2026-09-12-comfyfed-spec.md`.

These tests exercise the FastAPI routes and do STATIC sanity checks on the
installer scripts themselves (placeholders present, `set -euo pipefail` in
the bash script, PowerShell parses cleanly, LF-only line endings). They
deliberately never execute install.ps1/install.sh/install.cmd.
"""

from __future__ import annotations

import os
import shutil
import subprocess

import pytest
from fastapi.testclient import TestClient

from comfyfed_server import app as app_module
from comfyfed_server import bootstrap, installer_routes, security
from comfyfed_server import db


@pytest.fixture()
def client_with_url(tmp_path):
    data_dir = str(tmp_path / "with-url")
    bootstrap.ensure_installed(data_dir, lang="en", url="https://console.example.com", interactive=False)
    app = app_module.create_app(data_dir)
    c = TestClient(app)
    c.data_dir = data_dir
    return c


@pytest.fixture()
def client_no_url(tmp_path):
    data_dir = str(tmp_path / "no-url")
    bootstrap.ensure_installed(data_dir, lang="en", url=None, interactive=False)
    app = app_module.create_app(data_dir)
    c = TestClient(app)
    c.data_dir = data_dir
    return c


# ---------------------------------------------------------------------------
# GET /install.ps1 | /install.sh | /install.cmd
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("path", ["/install.ps1", "/install.sh", "/install.cmd"])
def test_installer_scripts_serve_with_content_type(client_with_url, path):
    r = client_with_url.get(path)
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/plain")


@pytest.mark.parametrize("path", ["/install.ps1", "/install.sh"])
def test_installer_scripts_substitute_platform_url_and_token(client_with_url, path):
    r = client_with_url.get(path, params={"token": "tok_abc123"})
    body = r.text
    assert "{{PLATFORM_URL}}" not in body
    assert "{{REGISTER_TOKEN}}" not in body
    assert "https://console.example.com" in body
    assert "tok_abc123" in body


def test_ps1_defaults_token_to_empty_string(client_with_url):
    body = client_with_url.get("/install.ps1").text
    assert "{{REGISTER_TOKEN}}" not in body
    # The literal placeholder is replaced by an empty string, not dropped
    # entirely -- so the surrounding quoting in the script stays intact.
    assert "$RegisterToken = ''" in body


def test_sh_defaults_token_to_empty_string(client_with_url):
    body = client_with_url.get("/install.sh").text
    assert "{{REGISTER_TOKEN}}" not in body
    assert "REGISTER_TOKEN=''" in body


def test_installer_scripts_fall_back_to_request_base_url_when_unset(client_no_url):
    r = client_no_url.get("/install.ps1")
    body = r.text
    assert "{{PLATFORM_URL}}" not in body
    # TestClient's default base URL.
    assert "http://testserver" in body


def test_install_cmd_omits_query_when_token_absent(client_with_url):
    r = client_with_url.get("/install.cmd")
    assert "{{TOKEN_QUERY}}" not in r.text
    assert "install.ps1' | iex" in r.text
    assert "token=" not in r.text


def test_install_cmd_includes_token_query_when_present(client_with_url):
    r = client_with_url.get("/install.cmd", params={"token": "tok_xyz"})
    assert "{{TOKEN_QUERY}}" not in r.text
    assert "install.ps1?token=tok_xyz' | iex" in r.text


# ---------------------------------------------------------------------------
# GET /api/platform
# ---------------------------------------------------------------------------


def test_api_platform_shape_matches_bundle_pubkey(client_with_url):
    r = client_with_url.get("/api/platform")
    assert r.status_code == 200
    body = r.json()
    assert set(body.keys()) == {"platform_url", "platform_pubkey"}
    assert body["platform_url"] == "https://console.example.com"

    _, verify_key = security.load_platform_keys(client_with_url.data_dir)
    assert body["platform_pubkey"] == bytes(verify_key).hex()


def test_api_platform_falls_back_to_request_base_url(client_no_url):
    r = client_no_url.get("/api/platform")
    body = r.json()
    assert body["platform_url"] == "http://testserver"


# ---------------------------------------------------------------------------
# Security review finding 1 (CRITICAL): ?token= injection into the
# single-quoted shell/PowerShell string literals the scripts substitute it
# into. Every payload below must be rejected with 400 BEFORE substitution --
# never echoed into a served script.
# ---------------------------------------------------------------------------


_TOKEN_INJECTION_PAYLOADS = [
    "'",
    '"',
    "`",
    "$(",
    "tok\nrm -rf /",
]


@pytest.mark.parametrize("path", ["/install.ps1", "/install.sh", "/install.cmd"])
@pytest.mark.parametrize("payload", _TOKEN_INJECTION_PAYLOADS)
def test_invalid_token_payloads_rejected_before_substitution(client_with_url, path, payload):
    r = client_with_url.get(path, params={"token": payload})
    assert r.status_code == 400
    body = r.json()
    assert body["error"] == "invalid_token"
    # The response is the fixed typed error, not the payload echoed back --
    # confirm the payload was never substituted into a script body.
    assert body["message"] == "The token parameter is invalid."


@pytest.mark.parametrize("path", ["/install.ps1", "/install.sh", "/install.cmd"])
def test_invalid_token_percent_encoded_payloads_rejected(client_with_url, path):
    # %0A decodes to a newline, %27 decodes to a single quote -- both would
    # break out of the single-quoted string literal if substituted raw.
    for encoded in ("%0A", "%27", "tok%0Arm+-rf", "tok%27;payload;%27"):
        r = client_with_url.get(f"{path}?token={encoded}")
        assert r.status_code == 400, encoded
        assert r.json()["error"] == "invalid_token"


@pytest.mark.parametrize("path", ["/install.ps1", "/install.sh", "/install.cmd"])
def test_valid_token_still_substitutes(client_with_url, path):
    # token_urlsafe(N) output: letters, digits, '-', '_' only.
    valid_token = "AbC123_-xyz9"
    r = client_with_url.get(path, params={"token": valid_token})
    assert r.status_code == 200
    assert valid_token in r.text


# ---------------------------------------------------------------------------
# Security review finding 2 (HIGH): platform_url gets the same treatment --
# validated before substitution, whether it comes from the configured
# setting or the request's own Host-derived base_url fallback.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("path", ["/install.ps1", "/install.sh", "/install.cmd", "/api/platform"])
def test_invalid_configured_platform_url_yields_typed_500(client_with_url, path):
    with db.get_session() as session:
        row = session.get(db.Setting, "platform_url")
        row.value = "https://evil.example.com/'; rm -rf ~ #"
        session.commit()

    r = client_with_url.get(path)
    assert r.status_code == 500
    assert r.json()["error"] == "invalid_platform_url"


@pytest.mark.parametrize("path", ["/install.ps1", "/install.sh", "/install.cmd", "/api/platform"])
def test_invalid_host_derived_fallback_yields_sanitized_refusal(client_no_url, path):
    from starlette.testclient import TestClient

    bad_client = TestClient(client_no_url.app, base_url="http://evil'host")
    r = bad_client.get(path)
    assert r.status_code == 400
    body = r.json()
    assert body["error"] == "invalid_request_origin"
    # Never echo the raw Host-derived value back to the client.
    assert "evil" not in r.text


# ---------------------------------------------------------------------------
# Finding 11d: no-store on the three script responses.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("path", ["/install.ps1", "/install.sh", "/install.cmd"])
def test_installer_scripts_are_not_cached(client_with_url, path):
    r = client_with_url.get(path)
    assert r.headers.get("cache-control") == "no-store"


# ---------------------------------------------------------------------------
# Package-data resolution (installed-layout accessor)
# ---------------------------------------------------------------------------


def test_installers_dir_resolves_and_contains_all_three_scripts():
    d = installer_routes.installers_dir()
    assert os.path.isdir(d)
    for name in ("install.ps1", "install.sh", "install.cmd"):
        assert os.path.isfile(os.path.join(d, name)), name


# ---------------------------------------------------------------------------
# Static sanity checks on the script sources themselves
# ---------------------------------------------------------------------------


def _source_path(filename: str) -> str:
    return os.path.join(installer_routes.installers_dir(), filename)


def test_ps1_source_has_placeholders():
    text = open(_source_path("install.ps1"), encoding="utf-8").read()
    assert "{{PLATFORM_URL}}" in text
    assert "{{REGISTER_TOKEN}}" in text


def test_sh_source_has_placeholders_and_strict_mode():
    text = open(_source_path("install.sh"), encoding="utf-8").read()
    assert "{{PLATFORM_URL}}" in text
    assert "{{REGISTER_TOKEN}}" in text
    assert "set -euo pipefail" in text


def test_cmd_source_has_placeholders():
    text = open(_source_path("install.cmd"), encoding="utf-8").read()
    assert "{{PLATFORM_URL}}" in text
    assert "{{TOKEN_QUERY}}" in text


def test_sh_stored_with_lf_only_no_crlf():
    raw = open(_source_path("install.sh"), "rb").read()
    assert b"\r\n" not in raw


def test_ps1_stored_with_lf_only_no_crlf():
    raw = open(_source_path("install.ps1"), "rb").read()
    assert b"\r\n" not in raw


def test_sh_syntax_check_via_bash_n():
    """`bash -n install.sh` -- syntax check only, never executes the script."""
    bash = shutil.which("bash")
    if bash is None:
        pytest.skip("bash not available in this environment")
    result = subprocess.run(
        [bash, "-n", _source_path("install.sh")],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr


def test_generated_launcher_ps1_renders_and_parses():
    """The installer WRITES a second PowerShell script (launcher.ps1) from a
    here-string, and autostart + the installer's own "start now" both run
    THAT file -- so it needs its own parse gate. Live-caught: the generated
    Start-Process line nested double quotes inside a double-quoted string,
    which parses fine as a here-string in install.ps1 but is broken as the
    generated code; every launch silently failed and the agent never
    started. Render the here-string exactly as install.ps1 does (evaluate it
    with a dummy $InstallDir), then PSParser-tokenize the RESULT and assert
    zero errors -- plus the specific shape that avoids the nested-quote trap.
    """
    powershell = shutil.which("powershell") or shutil.which("pwsh")
    if powershell is None:
        pytest.skip("powershell not available in this environment")
    text = open(_source_path("install.ps1"), encoding="utf-8-sig").read()
    start = text.index('$launcherSource = @"')
    end = text.index('\n"@', start) + len('\n"@')
    block = text[start:end]
    # Render exactly as the installer does, then tokenize the rendered file.
    ps_command = (
        "$InstallDir = 'C:\\Dummy\\ComfyFed'; "
        + block.replace("\n", "`n").replace('"', '"')  # placeholder, replaced below
    )
    # Build the render script as a file to avoid quoting the here-string
    # through -Command; PowerShell reads it with the same BOM-less UTF-8.
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        render_ps1 = os.path.join(td, "render.ps1")
        out_launcher = os.path.join(td, "launcher.ps1")
        with open(render_ps1, "w", encoding="utf-8") as f:
            f.write("$InstallDir = 'C:\\Dummy\\ComfyFed'\n")
            f.write(block + "\n")
            f.write("[System.IO.File]::WriteAllText('" + out_launcher.replace("'", "''") + "', $launcherSource)\n")
        r = subprocess.run(
            [powershell, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", render_ps1],
            capture_output=True, text=True, timeout=60,
        )
        assert r.returncode == 0, r.stderr
        rendered = open(out_launcher, encoding="utf-8").read()
        # Shape: quotes live in a single-quoted -f format string; the
        # Start-Process argument is a plain variable, never a double-quoted
        # string with embedded double quotes.
        assert "-ArgumentList $cmdArgs -WindowStyle Hidden" in rendered
        assert '-ArgumentList "/c "' not in rendered
        tokenize = (
            "$errs = $null; "
            "$content = [System.IO.File]::ReadAllText('" + out_launcher.replace("'", "''") + "'); "
            "$null = [System.Management.Automation.PSParser]::Tokenize($content, [ref]$errs); "
            "Write-Output ($errs.Count)"
        )
        r2 = subprocess.run(
            [powershell, "-NoProfile", "-Command", tokenize],
            capture_output=True, text=True, timeout=60,
        )
        assert r2.returncode == 0, r2.stderr
        assert r2.stdout.strip() == "0", f"generated launcher has parse errors: {r2.stdout} {r2.stderr}"
    del ps_command


def test_ps1_parses_via_powershell_tokenizer():
    """PowerShell parse check -- tokenizes the script, never executes it.

    Reads the file via `[System.IO.File]::ReadAllText` with an explicit
    (no-BOM-emitting) UTF-8 decoder rather than `Get-Content -Raw`: on
    PowerShell 5.1, `Get-Content -Raw` decodes using the system's ANSI
    codepage unless the file starts with a BOM, which would mangle the
    bilingual 中文 string literals and make this check worthless as a
    parse gate for them. Explicitly capturing PSParser's `[ref]$errs` and
    asserting it is empty (rather than only checking the process exit
    code) also guards against PSParser silently swallowing tokenizer
    errors into that out-parameter without a non-zero exit -- a vacuous
    pass the previous version of this test could not have caught.
    """
    powershell = shutil.which("powershell") or shutil.which("pwsh")
    if powershell is None:
        pytest.skip("powershell not available in this environment")
    script_path = _source_path("install.ps1")
    ps_command = (
        "$ErrorActionPreference='Stop'; "
        "$content = [System.IO.File]::ReadAllText("
        f"'{script_path}', [System.Text.UTF8Encoding]::new($false)); "
        "$errs = $null; "
        "$null = [System.Management.Automation.PSParser]::Tokenize($content, [ref]$errs); "
        "if ($errs.Count -ne 0) { $errs | ForEach-Object { Write-Error $_.Message }; exit 1 }"
    )
    result = subprocess.run(
        [powershell, "-NoProfile", "-Command", ps_command],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr


def test_agent_plist_keeps_alive_only_on_failure():
    """Final review M3/L8: the agent's launchd job must NOT be resurrected
    after a clean `comfyfed stop` -- so its KeepAlive is the SuccessfulExit
    dict, while ComfyUI's job keeps the plain always-on KeepAlive."""
    text = open(_source_path("install.sh"), encoding="utf-8").read()

    def _heredoc(plist_name: str) -> str:
        marker = f'cat > "$LAUNCH_AGENTS_DIR/{plist_name}" <<PLISTEOF'
        return text.split(marker, 1)[1].split("PLISTEOF", 1)[0]

    agent_block = _heredoc("com.comfyfed.agent.plist")
    assert "<key>KeepAlive</key>" in agent_block
    assert "<key>SuccessfulExit</key><false/>" in agent_block

    comfyui_block = _heredoc("com.comfyfed.comfyui.plist")
    assert "<key>KeepAlive</key><true/>" in comfyui_block
    assert "SuccessfulExit" not in comfyui_block


def test_agent_plist_is_unloaded_before_it_is_rewritten():
    """`launchctl load -w` on an already-loaded job is a no-op, so an upgrade
    would keep the old KeepAlive definition without this."""
    text = open(_source_path("install.sh"), encoding="utf-8").read()
    unload = 'launchctl unload -w "$LAUNCH_AGENTS_DIR/com.comfyfed.agent.plist" 2>/dev/null || true'
    assert unload in text
    assert text.index(unload) < text.index('cat > "$LAUNCH_AGENTS_DIR/com.comfyfed.agent.plist"')


def test_sh_guards_the_local_bin_link_and_hints_about_path():
    text = open(_source_path("install.sh"), encoding="utf-8").read()
    # Guarded: `set -euo pipefail` must not abort the install on a step the
    # script itself calls non-fatal.
    assert 'if mkdir -p "$HOME/.local/bin" 2>/dev/null && ln -sf' in text
    assert '*":$HOME/.local/bin:"*' in text
    assert "不在 PATH 上" in text
    assert "is not on your PATH" in text


def test_ps1_writes_the_cmd_shim_and_registry_path_inside_try():
    """Final review M1/M2/L8: the shim + PATH block is genuinely best-effort
    (everything inside `try`, under $ErrorActionPreference='Stop'), and the
    user PATH is written through the registry with its existing value kind
    so REG_EXPAND_SZ entries survive."""
    text = open(_source_path("install.ps1"), encoding="utf-8").read()
    shim_start = text.index("$shimContent = ")
    bin_dir_start = text.index("$binDir = Join-Path $InstallDir 'bin'")
    try_start = text.rindex("try {", 0, bin_dir_start)
    # Nothing between the opening `try {` and the shim write escapes it.
    assert try_start < bin_dir_start < shim_start
    assert "Set-Content -Path (Join-Path $binDir 'comfyfed.cmd')" in text

    assert "[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)" in text
    assert "$envKey.GetValue('Path', '', 'DoNotExpandEnvironmentNames')" in text
    assert "$envKey.GetValueKind('Path')" in text
    assert "$envKey.SetValue('Path', $newUserPath, $pathKind)" in text
    assert "[Microsoft.Win32.RegistryValueKind]::ExpandString" in text
    # The destructive .NET convenience API must be gone.
    assert "[Environment]::SetEnvironmentVariable('Path'" not in text
    # PS 5.1: no pipeline chain operators, no ternary.
    registry_block = text[text.index("$envKey = "):text.index("$envKey.SetValue")]
    assert "&&" not in registry_block


def test_install_cmd_stored_with_crlf():
    """`install.cmd` is a Windows batch file -- pin it to CRLF line endings."""
    raw = open(_source_path("install.cmd"), "rb").read()
    assert raw.endswith(b"\r\n")
    assert raw.count(b"\n") == raw.count(b"\r\n")


def test_ps1_stored_with_utf8_bom():
    """PowerShell 5.1's `-File` path needs the BOM to decode 中文 correctly
    on non-UTF-8 system locales; the `iex` path is unaffected either way."""
    raw = open(_source_path("install.ps1"), "rb").read()
    assert raw.startswith(b"\xef\xbb\xbf")


def test_ps1_served_response_has_no_bom_or_mojibake(client_with_url):
    r = client_with_url.get("/install.ps1")
    assert not r.text.startswith("﻿")
    assert "﻿" not in r.text
    assert "中文/EN bilingual" in r.text  # exact CJK marker from line 2: mojibake would break it


def test_ps1_writes_the_register_bundle_without_a_bom():
    """PS 5.1's `Set-Content -Encoding UTF8` prepends a BOM, which the
    agent's strict-JSON reader rejected during a real install. The bundle
    must be written via WriteAllText with an explicit BOM-less encoding,
    and no Set-Content may touch bundle.json again."""
    text = open(_source_path("install.ps1"), encoding="utf-8").read()
    assert "[System.IO.File]::WriteAllText($bundlePath" in text
    assert "New-Object System.Text.UTF8Encoding($false)" in text
    assert "Set-Content -Path $bundlePath" not in text


def test_ps1_autostart_never_aborts_and_falls_back_to_hkcu_run():
    """Live-caught: `schtasks /SC ONLOGON` needs elevation, and the old
    Fail-Step there killed the script BEFORE the immediate-start step, so a
    plain-terminal install registered the worker but never started the
    agent. Autostart must now (a) fall back to the per-user HKCU Run key,
    (b) warn-and-continue when even that fails -- no Fail-Step in the
    autostart section."""
    text = open(_source_path("install.ps1"), encoding="utf-8").read()
    assert "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" in text
    autostart = text[text.index("Configuring auto-start on logon") : text.index("Starting now")]
    assert "Fail-Step" not in autostart
    assert "exit 1" not in autostart
    # The completion message reflects whether autostart actually stuck.
    assert "$autostartOk" in text


def test_installers_skip_registration_when_already_registered():
    """A register token is single-use; re-running the script (the natural
    recovery after any later step fails) must skip registration instead of
    dying on the consumed token -- both platforms."""
    ps1 = open(_source_path("install.ps1"), encoding="utf-8").read()
    assert "$alreadyRegistered" in ps1
    assert "Already registered with this platform; skipping registration" in ps1
    sh = open(_source_path("install.sh"), encoding="utf-8").read()
    assert 'grep -qF "$PLATFORM_URL" "$HOME/.comfyfed/agent.json"' in sh
    assert "Already registered with this platform; skipping registration" in sh


def test_installers_recheck_and_reregister_a_dead_registration_on_rerun():
    """Task 4: when a platform is already pinned AND a token was supplied, the
    installer probes it with `check-registration` and, on a definitive dead
    (exit 10), falls through to re-register instead of blindly skipping."""
    ps1 = open(_source_path("install.ps1"), encoding="utf-8").read()
    assert "check-registration" in ps1
    # The gate: only re-check when already pinned AND a token is present.
    assert "$alreadyRegistered -and $RegisterToken -ne ''" in ps1
    # PS 5.1: exit code read from $LASTEXITCODE, dead (2) -> re-register.
    assert "$checkRc = $LASTEXITCODE" in ps1
    assert "$checkRc -eq 10" in ps1
    assert "$alreadyRegistered = $false" in ps1

    sh = open(_source_path("install.sh"), encoding="utf-8").read()
    assert "check-registration" in sh
    assert '"$CHECK_RC" -eq 10' in sh
    assert "ALREADY_REGISTERED=0" in sh


def test_sh_refuses_to_run_as_root():
    """sudo would install the whole stack into /root and set up user-level
    services for the wrong account; the script must refuse root unless
    COMFYFED_ALLOW_ROOT=1 is set."""
    sh = open(_source_path("install.sh"), encoding="utf-8").read()
    assert '[ "$(id -u)" -eq 0 ]' in sh
    assert "COMFYFED_ALLOW_ROOT" in sh
    assert "Do not run this installer as root" in sh


def test_generated_launcher_supervises_the_agent_restart_code():
    """The agent exits 75 right after installing a self-update and expects
    to be started again on the new build (comfyfed_agent.update.
    RESTART_EXIT_CODE). systemd/launchd restart any non-zero exit; Windows
    has no supervisor, so the generated launcher.ps1 must loop on exactly
    that code -- and ONLY that code, so a graceful stop (0) stays final and
    a crash never spins."""
    text = open(_source_path("install.ps1"), encoding="utf-8-sig").read()
    start = text.index('$launcherSource = @"')
    end = text.index('\n"@', start)
    block = text[start:end]
    assert "`$restartCode = 75" in block
    assert "-PassThru -Wait" in block
    assert "} while (`$agentCode -eq `$restartCode)" in block
    # Loop only on the restart code: no unconditional restart, no 'while ($true)'.
    assert "while ($true)" not in block and "while (`$true)" not in block
