# ComfyFed one-line installer (Windows / PowerShell 5.1+)
# 中文/EN bilingual output. Idempotent: safe to re-run.
#
# Template placeholders substituted server-side before this script is served:
#   {{PLATFORM_URL}}    -- e.g. https://console.example.com (no trailing slash expected)
#   {{REGISTER_TOKEN}}  -- worker register token, or empty string
#
# Usage (as served): irm '{{PLATFORM_URL}}/install.ps1?token=...' | iex

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Ensure TLS 1.2 is available regardless of the machine-wide default (some
# Windows/.NET defaults still exclude it), and keep Invoke-WebRequest /
# Invoke-RestMethod fast by not rendering a progress bar per chunk.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$ProgressPreference = 'SilentlyContinue'

$PlatformUrl = '{{PLATFORM_URL}}'.TrimEnd('/')
$RegisterToken = '{{REGISTER_TOKEN}}'

$InstallDir = Join-Path $env:LOCALAPPDATA 'ComfyFed'
$VenvDir = Join-Path $InstallDir 'venv'
$ComfyDir = Join-Path $InstallDir 'ComfyUI'
$HelperScript = Join-Path $InstallDir '_installer_helper.py'
$LauncherScript = Join-Path $InstallDir 'launcher.ps1'
$ManagedMarker = Join-Path $InstallDir 'comfyui_managed.json'
$AgentConfigPath = Join-Path $env:USERPROFILE '.comfyfed\agent.json'
$PythonVersionPinned = '3.12.10'
$ComfyVersionPinned = 'v0.35.0'
if ($env:COMFYFED_COMFY_VERSION) { $ComfyVersionPinned = $env:COMFYFED_COMFY_VERSION }

function Write-Bilingual {
    param([string]$Zh, [string]$En)
    Write-Host "$Zh / $En"
}

function Fail-Step {
    param([string]$StepZh, [string]$StepEn, [string]$ManualZh, [string]$ManualEn)
    Write-Host ''
    Write-Host "[失敗/FAILED] $StepZh / $StepEn" -ForegroundColor Red
    Write-Host "手動替代 / Manual alternative: $ManualZh / $ManualEn" -ForegroundColor Yellow
    exit 1
}

function Invoke-Native {
    # Run a native exe with stderr NOT promoted to terminating errors (PS 5.1
    # wraps native stderr as ErrorRecords whenever a redirection is active;
    # under $ErrorActionPreference='Stop' that aborts a step that succeeded).
    # Success is judged by $LASTEXITCODE alone, the way every caller already does.
    param([Parameter(Mandatory)][scriptblock]$Command)
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & $Command } finally { $ErrorActionPreference = $prev }
}

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

# ---------------------------------------------------------------------------
# 1. Python
# ---------------------------------------------------------------------------

function Test-PythonVersion {
    # Returns $true iff `<Exe> <Args> --version` reports Python >= 3.10.
    param([string]$Exe, [string[]]$Args)
    try {
        $verOut = & $Exe @Args '--version' 2>&1
    } catch {
        return $false
    }
    if ($verOut -match '(\d+)\.(\d+)\.(\d+)') {
        $maj = [int]$Matches[1]
        $min = [int]$Matches[2]
        return ($maj -gt 3) -or ($maj -eq 3 -and $min -ge 10)
    }
    return $false
}

function Resolve-Python {
    $candidates = @(
        @{ Exe = 'py'; Args = @('-3.12') },
        @{ Exe = 'py'; Args = @('-3') },
        @{ Exe = 'python'; Args = @() }
    )
    foreach ($c in $candidates) {
        if ($null -eq (Get-Command $c.Exe -ErrorAction SilentlyContinue)) { continue }
        if (Test-PythonVersion -Exe $c.Exe -Args $c.Args) {
            return $c
        }
    }
    return $null
}

Write-Bilingual '尋找 Python (>=3.10)...' 'Looking for Python (>=3.10)...'
$py = Resolve-Python

if ($null -eq $py) {
    Write-Bilingual '未找到合適的 Python，將從 python.org 靜默安裝 3.12' `
        'No suitable Python found; installing 3.12 silently from python.org'
    $pyInstaller = Join-Path $env:TEMP "python-$PythonVersionPinned-amd64.exe"
    try {
        Invoke-WebRequest -Uri "https://www.python.org/ftp/python/$PythonVersionPinned/python-$PythonVersionPinned-amd64.exe" `
            -OutFile $pyInstaller -UseBasicParsing
    } catch {
        Fail-Step '下載 Python 安裝器' 'downloading the Python installer' `
            "請手動至 https://www.python.org/downloads/ 安裝 Python 3.12 後重跑本腳本" `
            "please install Python 3.12 manually from https://www.python.org/downloads/ then re-run this script"
    }

    $proc = Start-Process -FilePath $pyInstaller -ArgumentList `
        '/quiet', 'InstallAllUsers=0', 'PrependPath=1', 'Include_launcher=1' `
        -Wait -PassThru
    if ($proc.ExitCode -ne 0) {
        Fail-Step '安裝 Python' 'installing Python' `
            "請手動至 https://www.python.org/downloads/ 安裝 Python 3.12 後重跑本腳本" `
            "please install Python 3.12 manually then re-run this script"
    }

    # Refresh PATH for this process from the registry (installer updates the
    # registry but this running process's env block is stale), then fall back
    # to the known per-user install location.
    $machinePath = [System.Environment]::GetEnvironmentVariable('Path', 'Machine')
    $userPath = [System.Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = "$machinePath;$userPath"

    $py = Resolve-Python
    if ($null -eq $py) {
        $knownPath = Join-Path $env:LOCALAPPDATA 'Programs\Python\Python312\python.exe'
        if (Test-Path $knownPath) {
            $py = @{ Exe = $knownPath; Args = @() }
        }
    }
    if ($null -eq $py) {
        Fail-Step '安裝後仍找不到 Python' 'Python still not found after install' `
            "請重新開機或手動將 Python 加入 PATH 後重跑本腳本" `
            "please reboot or add Python to PATH manually then re-run this script"
    }
}

Write-Bilingual "使用 Python: $($py.Exe) $($py.Args -join ' ')" "Using Python: $($py.Exe) $($py.Args -join ' ')"

# ---------------------------------------------------------------------------
# 2. venv + agent wheel
# ---------------------------------------------------------------------------

$venvPython = Join-Path $VenvDir 'Scripts\python.exe'
$venvPip = Join-Path $VenvDir 'Scripts\pip.exe'
$venvAgent = Join-Path $VenvDir 'Scripts\comfyfed-agent.exe'

if (-not (Test-Path $venvPython)) {
    Write-Bilingual '建立虛擬環境...' 'Creating virtual environment...'
    try {
        Invoke-Native { & $py.Exe @($py.Args) -m venv $VenvDir }
        if ($LASTEXITCODE -ne 0) { throw "venv creation exited $LASTEXITCODE" }
    } catch {
        Fail-Step '建立虛擬環境' 'creating the virtual environment' `
            "請確認 Python 安裝完整（含 venv 模組）" "please confirm Python is installed completely (including the venv module)"
    }
}

Write-Bilingual '查詢最新 agent 版本...' 'Fetching the latest agent version...'
try {
    $versionInfo = Invoke-RestMethod -Uri "$PlatformUrl/api/agent/version" -UseBasicParsing
} catch {
    Fail-Step '連線到平台取得 agent 版本' 'contacting the platform for the agent version' `
        "請確認網路連線與平台網址 $PlatformUrl 正確" "please check your network connection and that $PlatformUrl is correct"
}

$wheelUrlProp = $versionInfo.PSObject.Properties['wheel_url']
$sha256Prop = $versionInfo.PSObject.Properties['sha256']
if ($null -eq $wheelUrlProp -or -not $wheelUrlProp.Value -or $null -eq $sha256Prop -or -not $sha256Prop.Value) {
    Fail-Step '平台尚未發佈 agent wheel' 'the platform has not published an agent wheel yet' `
        "請聯絡平台管理員" "please contact the platform administrator"
}

$wheelUrl = $wheelUrlProp.Value
if ($wheelUrl -notmatch '^https?://') {
    $wheelUrl = "$PlatformUrl$wheelUrl"
}
# pip validates the wheel FILENAME (PEP 427), not just the bytes, so keep the
# platform's real name and fall back to the conventional pure-Python name
# when the URL carries no usable one (parity with install.sh).
$wheelName = [System.IO.Path]::GetFileName(([Uri]$wheelUrl).AbsolutePath)
if ($wheelName -notmatch '^[^-]+-[^-]+(-[^-]+)?-[^-]+-[^-]+-[^-]+\.whl$') {
    $latestProp = $versionInfo.PSObject.Properties['latest']
    $latestVersion = if ($null -ne $latestProp -and $latestProp.Value) { $latestProp.Value } else { '0' }
    $wheelName = "comfyfed-$latestVersion-py3-none-any.whl"
}
$wheelFile = Join-Path $env:TEMP $wheelName

Write-Bilingual '下載 agent wheel...' 'Downloading agent wheel...'
try {
    Invoke-WebRequest -Uri $wheelUrl -OutFile $wheelFile -UseBasicParsing
} catch {
    Fail-Step '下載 agent wheel' 'downloading the agent wheel' `
        "請確認網路連線後重跑本腳本" "please check your network connection then re-run this script"
}

$actualHash = (Get-FileHash -Path $wheelFile -Algorithm SHA256).Hash.ToLower()
$expectedHash = $sha256Prop.Value.ToLower()
if ($actualHash -ne $expectedHash) {
    Remove-Item -Force $wheelFile -ErrorAction SilentlyContinue
    Fail-Step 'agent wheel 的 sha256 驗證失敗' 'agent wheel sha256 verification failed' `
        "請重跑本腳本；若持續失敗請聯絡平台管理員" "please re-run this script; contact the platform administrator if it keeps failing"
}

Write-Bilingual '安裝 agent...' 'Installing agent...'
try {
    Invoke-Native { & $venvPip install --upgrade $wheelFile }
    if ($LASTEXITCODE -ne 0) { throw "pip install exited $LASTEXITCODE" }
} catch {
    Fail-Step '安裝 agent wheel' 'installing the agent wheel' `
        "請重跑本腳本" "please re-run this script"
}
Remove-Item -Force $wheelFile -ErrorAction SilentlyContinue

# `comfyfed` on PATH: Windows venvs don't get a symlinked console script the
# way *nix venvs do, so drop a tiny .cmd shim in a per-app bin dir and add
# that dir to the user PATH. Both steps are best-effort -- a machine where
# PATH can't be changed (locked-down policy, etc.) must not fail the install.
# EVERY statement here is inside a try: with $ErrorActionPreference='Stop'
# and StrictMode, a locked bin directory or an empty $env:LOCALAPPDATA would
# otherwise kill the installer after the wheel went in but before autostart
# was registered, leaving a half-configured machine.
try {
    $binDir = Join-Path $InstallDir 'bin'
    New-Item -ItemType Directory -Force -Path $binDir | Out-Null
    $venvRelative = $VenvDir.Substring($env:LOCALAPPDATA.TrimEnd('\').Length).TrimStart('\')
    $shimContent = "@`"%LOCALAPPDATA%\$venvRelative\Scripts\comfyfed.exe`" %*"
    Set-Content -Path (Join-Path $binDir 'comfyfed.cmd') -Value $shimContent -Encoding ASCII
    Write-Bilingual '已建立 comfyfed 指令' 'Created the comfyfed command'
} catch {
    Write-Host "[警告/WARNING] 無法建立 comfyfed.cmd / could not create comfyfed.cmd" -ForegroundColor Yellow
}

try {
    $binDir = Join-Path $InstallDir 'bin'
    # The raw registry value, NOT [Environment]::GetEnvironmentVariable:
    # that one returns the EXPANDED Path and SetEnvironmentVariable writes it
    # back as REG_SZ, which permanently freezes legitimate %JAVA_HOME%\bin /
    # %USERPROFILE%\bin entries this installer does not own. Read without
    # expanding, write back with the kind the value already had.
    $envKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
    try {
        $currentUserPath = $envKey.GetValue('Path', '', 'DoNotExpandEnvironmentNames')
        if ($null -eq $currentUserPath) { $currentUserPath = '' }
        try {
            $pathKind = $envKey.GetValueKind('Path')
        } catch {
            # No user Path yet: create it expandable, like Windows does.
            $pathKind = [Microsoft.Win32.RegistryValueKind]::ExpandString
        }
        $alreadyOnPath = $currentUserPath.ToLower().Contains($binDir.ToLower())
        if (-not $alreadyOnPath) {
            $newUserPath = $binDir
            if ($currentUserPath.Length -gt 0) { $newUserPath = "$currentUserPath;$binDir" }
            $envKey.SetValue('Path', $newUserPath, $pathKind)
            Write-Bilingual '已將 comfyfed 加入使用者 PATH（需重開終端機才會生效）' 'Added comfyfed to the user PATH (restart your terminal for it to take effect)'
        }
    } finally {
        if ($null -ne $envKey) { $envKey.Close() }
    }
} catch {
    Write-Host "[警告/WARNING] 無法更新使用者 PATH / could not update the user PATH" -ForegroundColor Yellow
}

# ---------------------------------------------------------------------------
# Helper python script (detection + extraction), dropped to disk instead of
# fragile inline -c one-liners.
# ---------------------------------------------------------------------------

$helperSource = @'
"""ComfyFed installer helper: ComfyUI detection + 7z extraction.

Invoked by install.ps1 / install.sh as `python _installer_helper.py <cmd> ...`
rather than inline -c one-liners, which get unwieldy for anything beyond a
single expression.
"""
import sys


def cmd_check():
    import httpx
    from comfyfed_agent import detect

    with httpx.Client() as client:
        url = detect.find_comfy_url(client)
    print(url or "")
    sys.exit(0 if url else 1)


def cmd_apply(config_path):
    import httpx
    from comfyfed_agent import detect
    from comfyfed_agent.config import AgentConfig

    cfg = AgentConfig.load(config_path)
    with httpx.Client() as client:
        notes = detect.apply_detection(cfg, client, AgentConfig.comfy_url)
    if notes:
        cfg.save(config_path)
    for note in notes:
        print(note)


def cmd_extract7z(archive_path, dest_dir):
    import py7zr

    with py7zr.SevenZipFile(archive_path, mode="r") as archive:
        archive.extractall(path=dest_dir)


def cmd_p2p_enable(config_path, port):
    """spec §11：路由器探測成功後，把模型分享打開 —— 但只在使用者從未表態
    的情況下。規則刻意極簡：`peer_serve` 目前為 false **且** `peer_listen_port`
    為 null（從未設定過）才寫入；曾經手動設過埠或手動關掉分享的一律尊重，
    安裝腳本不會把它改回來。設定檔不存在時視同全新（空）設定，比照
    AgentConfig.load 的行為 -- 只有「檔案存在但解析失敗」才算尊重、不動。"""
    import json
    import os

    try:
        with open(config_path, "r", encoding="utf-8-sig") as f:
            config = json.load(f)
    except FileNotFoundError:
        config = {}
    except (OSError, ValueError):
        print("respected")
        return

    if config.get("peer_serve") or config.get("peer_listen_port") is not None:
        print("respected")
        return

    config["peer_serve"] = True
    config["peer_listen_port"] = int(port)
    parent_dir = os.path.dirname(config_path)
    if parent_dir:
        os.makedirs(parent_dir, exist_ok=True)
    tmp_path = config_path + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(config, f, ensure_ascii=False, indent=2)
    os.replace(tmp_path, config_path)
    print("enabled")


if __name__ == "__main__":
    command = sys.argv[1]
    if command == "check":
        cmd_check()
    elif command == "apply":
        cmd_apply(sys.argv[2])
    elif command == "extract7z":
        cmd_extract7z(sys.argv[2], sys.argv[3])
    elif command == "p2p_enable":
        cmd_p2p_enable(sys.argv[2], sys.argv[3])
    else:
        print(f"unknown command: {command}", file=sys.stderr)
        sys.exit(2)
'@
Set-Content -Path $HelperScript -Value $helperSource -Encoding UTF8

# ---------------------------------------------------------------------------
# 3. Registration
# ---------------------------------------------------------------------------

# Idempotent re-run: a register token is single-use, so a second run of this
# script (e.g. after a failed autostart step) must NOT try to register again
# -- if agent.json already pins this platform, skip straight to the later
# steps instead of dying on a consumed token (live-caught: the first real
# install aborted at autostart, and re-running was the natural fix).
$alreadyRegistered = $false
if ((Test-Path $AgentConfigPath)) {
    try {
        $existingConfig = [System.IO.File]::ReadAllText($AgentConfigPath)
        if ($existingConfig.Contains($PlatformUrl)) { $alreadyRegistered = $true }
    } catch {}
}

# Self-heal a dead registration: if this platform is already pinned AND a
# fresh token was supplied, probe whether the platform still accepts us. A
# definitive 4401 (check-registration exit 2) means the worker was removed
# server-side, so we fall through to re-register -- register now REPLACES the
# dead entry rather than stacking a second. Exit 0 (live), 3 (undetermined:
# network/timeout) or 1 (none) keep the skip: never burn the single-use token
# on a transient outage. Exit 10 is deliberately NOT 2 -- argparse exits 2
# on an unknown subcommand, so an OLDER wheel lacking check-registration
# (served the new installer mid-rollout) exits 2 and must NOT read as dead.
# PS 5.1: read $LASTEXITCODE after the native call.
if ($alreadyRegistered -and $RegisterToken -ne '') {
    Invoke-Native { & $venvAgent check-registration }
    $checkRc = $LASTEXITCODE
    if ($checkRc -eq 10) {
        Write-Bilingual '偵測到註冊已失效（4401），將重新註冊' 'Detected a dead registration (4401); re-registering'
        $alreadyRegistered = $false
    }
}

if ($alreadyRegistered) {
    Write-Bilingual '此機器已註冊過本平台，跳過註冊步驟' 'Already registered with this platform; skipping registration'
} elseif ($RegisterToken -ne '') {
    Write-Bilingual '註冊 worker...' 'Registering worker...'
    try {
        $platformInfo = Invoke-RestMethod -Uri "$PlatformUrl/api/platform" -UseBasicParsing
    } catch {
        Fail-Step '取得平台資訊' 'fetching platform info' `
            "請確認網路連線後重跑本腳本" "please check your network connection then re-run this script"
    }

    $bundlePath = Join-Path $InstallDir 'bundle.json'
    $bundle = @{
        platform_url = $platformInfo.platform_url
        platform_pubkey = $platformInfo.platform_pubkey
        register_token = $RegisterToken
    }
    # PS 5.1's `Set-Content -Encoding UTF8` writes a BOM, which strict
    # utf-8 JSON readers reject (live-caught: the agent's register crashed
    # on "Unexpected UTF-8 BOM") -- write the file BOM-less explicitly.
    [System.IO.File]::WriteAllText($bundlePath, ($bundle | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($false)))

    try {
        Invoke-Native { & $venvAgent register $bundlePath }
        if ($LASTEXITCODE -ne 0) { throw "comfyfed-agent register exited $LASTEXITCODE" }
    } catch {
        Fail-Step '執行 comfyfed-agent register' 'running comfyfed-agent register' `
            "請確認 token 未過期或未被使用過，並重跑本腳本" `
            "please confirm the token has not expired or been used, then re-run this script"
    }
    Remove-Item -Force $bundlePath -ErrorAction SilentlyContinue
    Write-Bilingual '註冊完成' 'Registration complete'
} else {
    Write-Bilingual '未提供 register token，跳過註冊' 'No register token provided, skipping registration'
    Write-Bilingual '請到主控台發 bundle 後執行' 'Please issue a bundle from the console, then run'
    Write-Host "  `"$venvAgent`" register bundle.json"
}

# ---------------------------------------------------------------------------
# 4. ComfyUI check + optional install
# ---------------------------------------------------------------------------

function Split-WindowsCommandLine {
    # Best-effort argv split of a Win32 command line. `command_line` is kept
    # verbatim in the marker and is what the launcher actually runs, so this
    # only has to be good enough for humans reading `args` (and for the
    # main.py sniff that infers the working directory below).
    param([string]$Line)
    $tokens = @()
    if (-not $Line) { return ,$tokens }
    foreach ($m in [regex]::Matches($Line, '"([^"]*)"|(\S+)')) {
        if ($m.Groups[1].Success) { $tokens += $m.Groups[1].Value }
        else { $tokens += $m.Groups[2].Value }
    }
    return ,$tokens
}

function Save-DetectedComfyMarker {
    # A ComfyUI we did NOT install (Comfy Desktop, a hand-rolled checkout)
    # still has to come back after a reboot, or the agent autostarts, finds
    # nothing on comfy_url and the worker sits offline until someone opens
    # ComfyUI by hand (live-caught). Record how the RUNNING one was started,
    # into the same marker the launcher already reads. Returns $true iff the
    # marker was written; on any failure it writes NOTHING and returns $false
    # so the caller can tell the operator to start ComfyUI themselves.
    param([string]$ComfyUrl, [string]$MarkerPath)
    $port = 0
    try { $port = ([uri]$ComfyUrl).Port } catch { return $false }
    if ($port -le 0) { return $false }

    $owningPid = 0
    try {
        $conn = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction Stop |
            Select-Object -First 1
        if ($null -ne $conn) { $owningPid = [int]$conn.OwningProcess }
    } catch { return $false }
    if ($owningPid -le 0) { return $false }

    try {
        $proc = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $owningPid" -ErrorAction Stop
    } catch { return $false }
    if ($null -eq $proc) { return $false }
    $procProps = $proc.PSObject.Properties.Name
    $exe = ''
    if ($procProps -contains 'ExecutablePath') { $exe = [string]$proc.ExecutablePath }
    $commandLine = ''
    if ($procProps -contains 'CommandLine') { $commandLine = [string]$proc.CommandLine }
    if (-not $exe) { return $false }

    $tokens = Split-WindowsCommandLine -Line $commandLine
    $procArgs = @()
    if ($tokens.Count -gt 1) { $procArgs = $tokens[1..($tokens.Count - 1)] }

    # ExecutablePath resolves a venv python to its BASE interpreter -- live
    # on POKAI-HOME, Comfy Desktop's
    # `...\ComfyUI\.venv\Scripts\python.exe` reports as
    # `...\standalone-env\python.exe`, which loses both the venv and the
    # folder layout the working directory is inferred from. Prefer the
    # command line's own argv[0] whenever it still exists on disk.
    $startExe = $exe
    if (($tokens.Count -gt 0) -and $tokens[0] -and (Test-Path -LiteralPath $tokens[0] -PathType Leaf)) {
        $startExe = $tokens[0]
    }

    # Win32_Process does not expose the working directory, so infer it:
    # Comfy Desktop runs `<root>\.venv\Scripts\python.exe main.py --port ...`
    # FROM <root>, so a `main.py` argument plus a venv-shaped exe path pins
    # the ComfyUI root (confirmed by main.py actually being there). Anything
    # else falls back to the exe's own folder.
    $cwd = Split-Path -Parent $startExe
    $hasMainPy = $false
    foreach ($a in $procArgs) { if ($a -match '(^|[\\/])main\.py$') { $hasMainPy = $true } }
    if ($hasMainPy) {
        $exeDir = Split-Path -Parent $startExe
        $exeDirLeaf = Split-Path -Leaf $exeDir
        $venvDir = Split-Path -Parent $exeDir
        if ($venvDir -and ($exeDirLeaf -eq 'Scripts' -or $exeDirLeaf -eq 'bin')) {
            $venvLeaf = Split-Path -Leaf $venvDir
            if ($venvLeaf -match '^\.?venv$') {
                $comfyRoot = Split-Path -Parent $venvDir
                if ($comfyRoot -and (Test-Path -LiteralPath (Join-Path $comfyRoot 'main.py'))) {
                    $cwd = $comfyRoot
                }
            }
        }
    }

    $marker = [ordered]@{
        start_exe = $startExe
        args = @($procArgs)
        command_line = $commandLine
        cwd = $cwd
        comfy_url = $ComfyUrl
        detected = $true
        autostart = $true
    }
    try {
        [System.IO.File]::WriteAllText($MarkerPath, ($marker | ConvertTo-Json),
            (New-Object System.Text.UTF8Encoding($false)))
    } catch { return $false }
    return $true
}

# A marker for a ComfyUI this installer INSTALLED means "managed, do not
# reinstall". A marker for a DETECTED ComfyUI is only a recording of how that
# ComfyUI starts -- it can go stale (Comfy Desktop upgraded, moved, or picked
# another port), so a re-run must re-capture instead of skipping.
$comfyManaged = $false
$markerIsDetected = $false
if (Test-Path $ManagedMarker) {
    try {
        $existingMarker = Get-Content $ManagedMarker -Raw | ConvertFrom-Json
        $existingProps = $existingMarker.PSObject.Properties.Name
        if (($existingProps -contains 'detected') -and $existingMarker.detected) {
            $markerIsDetected = $true
        }
    } catch {}
}

if ((Test-Path $ManagedMarker) -and (-not $markerIsDetected)) {
    $comfyManaged = $true
    Write-Bilingual '已由本安裝器管理的 ComfyUI，略過重新安裝' `
        'ComfyUI already managed by this installer, skipping reinstall'
} else {
    Write-Bilingual '偵測本機 ComfyUI...' 'Detecting local ComfyUI...'
    $comfyUrl = (Invoke-Native { & $venvPython $HelperScript check } | Select-Object -Last 1)
    $found = ($LASTEXITCODE -eq 0)

    if ($found) {
        Write-Bilingual '找到本機 ComfyUI' 'Found a local ComfyUI'
        if (Save-DetectedComfyMarker -ComfyUrl ([string]$comfyUrl).Trim() -MarkerPath $ManagedMarker) {
            $comfyManaged = $true
            Write-Bilingual '已記錄現有 ComfyUI 的啟動方式，登入時會一併帶起' `
                'Recorded how your existing ComfyUI is started; it will be started at logon too'
        } else {
            # Nothing written: an unreadable listener is not worth guessing at.
            $comfyManaged = $markerIsDetected
            Write-Bilingual '無法取得現有 ComfyUI 的啟動方式，重開機後請自行啟動 ComfyUI' `
                'Could not capture how your existing ComfyUI is started; please start ComfyUI yourself after a reboot'
        }
    } else {
        Write-Bilingual "找不到 ComfyUI，將安裝 $ComfyVersionPinned 版本" `
            "No ComfyUI found; installing version $ComfyVersionPinned"

        $useCpu = $false
        $gpuVendor = 'nvidia'
        $hasNvidiaSmi = Get-Command 'nvidia-smi' -ErrorAction SilentlyContinue
        if ($hasNvidiaSmi) {
            $gpuVendor = 'nvidia'
        } else {
            try {
                $gpuNames = (Get-CimInstance -ClassName Win32_VideoController -ErrorAction Stop).Name
            } catch {
                $gpuNames = @()
            }
            if ($gpuNames -match 'NVIDIA') {
                $gpuVendor = 'nvidia'
            } elseif ($gpuNames -match 'AMD|Radeon') {
                $gpuVendor = 'amd'
                $useCpu = $false
            } elseif ($gpuNames -match 'Intel\(R\) Arc|Intel.*Graphics') {
                # Comfy-Org publishes a dedicated Intel portable build.
                $gpuVendor = 'intel'
                $useCpu = $false
            } else {
                $gpuVendor = 'nvidia'
                $useCpu = $true
            }
        }

        $assetName = "ComfyUI_windows_portable_$gpuVendor.7z"
        $defaultUrl = "https://github.com/Comfy-Org/ComfyUI/releases/download/$ComfyVersionPinned/$assetName"
        $portableUrl = $env:COMFYFED_COMFY_PORTABLE_URL
        if (-not $portableUrl) { $portableUrl = $defaultUrl }

        $archivePath = Join-Path $env:TEMP $assetName
        Write-Bilingual '下載 ComfyUI portable...' 'Downloading ComfyUI portable...'
        try {
            Invoke-WebRequest -Uri $portableUrl -OutFile $archivePath -UseBasicParsing
        } catch {
            Fail-Step '下載 ComfyUI portable' 'downloading the ComfyUI portable archive' `
                "請手動至 https://github.com/Comfy-Org/ComfyUI/releases/tag/$ComfyVersionPinned 下載並解壓到 $ComfyDir" `
                "please manually download from https://github.com/Comfy-Org/ComfyUI/releases/tag/$ComfyVersionPinned and extract to $ComfyDir"
        }

        Write-Bilingual '安裝解壓工具 py7zr...' 'Installing py7zr for extraction...'
        try {
            Invoke-Native { & $venvPip install py7zr }
            if ($LASTEXITCODE -ne 0) { throw "pip install py7zr exited $LASTEXITCODE" }
        } catch {
            Fail-Step '安裝 py7zr' 'installing py7zr' "請重跑本腳本" "please re-run this script"
        }

        $extractTemp = Join-Path $env:TEMP "comfyfed-comfy-extract-$([guid]::NewGuid().ToString('N'))"
        New-Item -ItemType Directory -Force -Path $extractTemp | Out-Null
        Write-Bilingual '解壓 ComfyUI...' 'Extracting ComfyUI...'
        try {
            Invoke-Native { & $venvPython $HelperScript extract7z $archivePath $extractTemp }
            if ($LASTEXITCODE -ne 0) { throw "extract7z exited $LASTEXITCODE" }
        } catch {
            Fail-Step '解壓 ComfyUI' 'extracting ComfyUI' `
                "請手動解壓 $archivePath 到 $ComfyDir" "please manually extract $archivePath to $ComfyDir"
        }
        Remove-Item -Force $archivePath -ErrorAction SilentlyContinue

        $portableRoot = Join-Path $extractTemp 'ComfyUI_windows_portable'
        if (-not (Test-Path $portableRoot)) {
            # Some archives extract flat without the wrapper dir; fall back to
            # the extract root itself.
            $portableRoot = $extractTemp
        }
        New-Item -ItemType Directory -Force -Path $ComfyDir | Out-Null
        Get-ChildItem -Path $portableRoot | ForEach-Object {
            Move-Item -Path $_.FullName -Destination $ComfyDir -Force
        }
        Remove-Item -Recurse -Force $extractTemp -ErrorAction SilentlyContinue

        $comfyPythonExe = Join-Path $ComfyDir 'python_embeded\python.exe'
        $comfyMain = Join-Path $ComfyDir 'ComfyUI\main.py'
        $startArgs = @('-s', $comfyMain, '--windows-standalone-build')
        if ($useCpu) { $startArgs += '--cpu' }

        Write-Bilingual '啟動 ComfyUI 並等待就緒...' 'Starting ComfyUI and waiting for it to become ready...'
        Start-Process -FilePath $comfyPythonExe -ArgumentList $startArgs -WindowStyle Hidden

        $deadline = (Get-Date).AddSeconds(180)
        $ready = $false
        while ((Get-Date) -lt $deadline) {
            try {
                $resp = Invoke-WebRequest -Uri 'http://127.0.0.1:8188/system_stats' -UseBasicParsing -TimeoutSec 3
                if ($resp.StatusCode -eq 200) { $ready = $true; break }
            } catch {}
            Start-Sleep -Seconds 3
        }
        if (-not $ready) {
            Fail-Step 'ComfyUI 未在時限內就緒' 'ComfyUI did not become ready in time' `
                "請手動執行 $comfyPythonExe $($startArgs -join ' ') 並檢查錯誤訊息" `
                "please manually run $comfyPythonExe $($startArgs -join ' ') and check the error output"
        }
        Write-Bilingual 'ComfyUI 已就緒' 'ComfyUI is ready'

        $managed = @{
            start_exe = $comfyPythonExe
            args = $startArgs
        }
        ($managed | ConvertTo-Json) | Set-Content -Path $ManagedMarker -Encoding UTF8
        $comfyManaged = $true

        Write-Bilingual '重新偵測並套用設定...' 'Re-running detection and saving config...'
        try {
            Invoke-Native { & $venvPython $HelperScript apply $AgentConfigPath }
            if ($LASTEXITCODE -ne 0) { throw "apply detection exited $LASTEXITCODE" }
        } catch {
            Fail-Step '套用偵測設定' 'applying detection settings' `
                "請重跑本腳本" "please re-run this script"
        }
    }
}

# ---------------------------------------------------------------------------
# 4c. P2P probe (spec §11)
# ---------------------------------------------------------------------------
# 探一下路由器肯不肯自動開埠；肯就順手把模型分享打開（只在使用者從未表態
# 時）。探測本身最多 8 秒、不留映射，失敗完全不影響安裝流程。
Write-Bilingual '偵測 P2P 分享能力（詢問路由器是否支援自動開埠）...' `
    'Checking whether this network can share models over P2P...'
$p2pOutput = Invoke-Native { & $venvAgent p2p-probe --port 8850 --json }
if ($LASTEXITCODE -eq 0) {
    $p2pMethod = 'unknown'
    try {
        $p2pMethod = (($p2pOutput | Select-Object -Last 1) | ConvertFrom-Json).method
    } catch {
        $p2pMethod = 'unknown'
    }
    Invoke-Native { & $venvPython $HelperScript p2p_enable $AgentConfigPath 8850 } | Out-Null
    Write-Bilingual "路由器支援自動開埠（$p2pMethod），已開啟模型分享（連接埠 8850）" `
        "Your router supports automatic port mapping ($p2pMethod); model sharing is on (port 8850)"
} else {
    Write-Bilingual '路由器沒有回應 UPnP／NAT-PMP，未開啟模型分享；到路由器開啟 UPnP 後重跑安裝指令即可自動開啟，或手動設定 peer_advertise_host 與轉埠' `
        'Your router did not answer UPnP/NAT-PMP, so model sharing stays off; enable UPnP on the router and re-run this installer, or set peer_advertise_host and forward the port by hand'
}

# ---------------------------------------------------------------------------
# 5. Launcher + autostart
# ---------------------------------------------------------------------------

$launcherSource = @"
`$ErrorActionPreference = 'Stop'
`$InstallDir = '$InstallDir'
`$ManagedMarker = Join-Path `$InstallDir 'comfyui_managed.json'

if (Test-Path `$ManagedMarker) {
    try {
        `$managed = Get-Content `$ManagedMarker -Raw | ConvertFrom-Json
        `$managedProps = `$managed.PSObject.Properties.Name
        `$comfyUrl = 'http://127.0.0.1:8188'
        if ((`$managedProps -contains 'comfy_url') -and `$managed.comfy_url) {
            `$comfyUrl = ([string]`$managed.comfy_url).TrimEnd('/')
        }
        `$startComfy = `$true
        if ((`$managedProps -contains 'autostart') -and (-not `$managed.autostart)) {
            `$startComfy = `$false
        }
        # Probe BEFORE starting: a ComfyUI that is already answering (Comfy
        # Desktop opened by hand, or an earlier launcher run) must never be
        # started a second time on the same port.
        try {
            `$resp = Invoke-WebRequest -Uri "`$comfyUrl/system_stats" -UseBasicParsing -TimeoutSec 3
            if (`$resp.StatusCode -eq 200) { `$startComfy = `$false }
        } catch {}
        if (`$startComfy) {
            `$comfyCwd = `$InstallDir
            if ((`$managedProps -contains 'cwd') -and `$managed.cwd -and (Test-Path `$managed.cwd)) {
                `$comfyCwd = `$managed.cwd
            }
            if ((`$managedProps -contains 'command_line') -and `$managed.command_line) {
                # A detected ComfyUI is replayed through its verbatim command
                # line, so quoting we did not author is never re-quoted.
                `$comfyArgs = '/c ' + `$managed.command_line
                Start-Process -FilePath 'cmd.exe' -ArgumentList `$comfyArgs -WorkingDirectory `$comfyCwd -WindowStyle Hidden
            } else {
                Start-Process -FilePath `$managed.start_exe -ArgumentList `$managed.args -WorkingDirectory `$comfyCwd -WindowStyle Hidden
            }
            `$deadline = (Get-Date).AddSeconds(180)
            while ((Get-Date) -lt `$deadline) {
                try {
                    `$resp = Invoke-WebRequest -Uri "`$comfyUrl/system_stats" -UseBasicParsing -TimeoutSec 3
                    if (`$resp.StatusCode -eq 200) { break }
                } catch {}
                Start-Sleep -Seconds 3
            }
        }
    } catch {}
}

`$agentExe = Join-Path `$InstallDir 'venv\Scripts\comfyfed-agent.exe'
`$logFile = Join-Path `$InstallDir 'agent.log'
# The generated line must NOT nest double quotes inside a double-quoted
# PowerShell string (that is exactly what broke every launch: the string
# ended at the first inner quote and Start-Process saw a stray positional
# parameter -- so autostart AND the installer's own "start now" silently
# never started the agent). Quotes live inside a single-quoted format
# string instead; the doubled outer quotes are cmd /c's rule when the
# command both starts with a quote and contains more quotes.
`$cmdArgs = '/c ""{0}" run >> "{1}" 2>&1"' -f `$agentExe, `$logFile
# Supervisor loop: the agent exits 75 right after installing a self-update
# (see comfyfed_agent.update.RESTART_EXIT_CODE) and expects to be started
# again on the new build -- exactly what systemd/launchd do on the other
# platforms. Any other exit (0 = graceful 'comfyfed stop', or a crash) ends
# the loop, so a stop stays final and a crash never spins.
`$restartCode = 75
do {
    `$agentProc = Start-Process -FilePath 'cmd.exe' -ArgumentList `$cmdArgs -WindowStyle Hidden -PassThru -Wait
    `$agentCode = `$agentProc.ExitCode
    if (`$agentCode -eq `$restartCode) { Start-Sleep -Seconds 2 }
} while (`$agentCode -eq `$restartCode)
"@
Set-Content -Path $LauncherScript -Value $launcherSource -Encoding UTF8

Write-Bilingual '設定開機自動啟動...' 'Configuring auto-start on logon...'
$taskCmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$LauncherScript`""
# `schtasks /SC ONLOGON` requires elevation. A plain (non-admin) terminal is
# the NORMAL way people run this one-liner (live-caught: the first real
# install died right here and never reached the start step below), so:
# try the scheduled task first, fall back to the per-user HKCU Run key --
# which needs no elevation and autostarts at logon just the same -- and if
# even that fails, WARN and keep going: a missing autostart must never
# abort an otherwise working install.
$autostartOk = $false
try {
    Invoke-Native { schtasks /Create /F /TN ComfyFedAgent /SC ONLOGON /TR $taskCmd 2>$null } | Out-Null
    if ($LASTEXITCODE -eq 0) { $autostartOk = $true }
} catch {}
if ($autostartOk) {
    # Live-caught 2026-09-16 (POKAI-HOME): an earlier non-admin run had left a
    # HKCU Run key behind, and a later elevated run added the scheduled task
    # on top -- so the agent launched TWICE at logon. Exactly one autostart
    # mechanism must survive this section, so the other is always removed.
    Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' `
        -Name 'ComfyFedAgent' -ErrorAction SilentlyContinue
    Write-Bilingual '已建立排程工作 ComfyFedAgent' 'Created scheduled task ComfyFedAgent'
} else {
    try {
        # Same rule in the other direction: a scheduled task from a previous
        # elevated run would double up with this Run key.
        Invoke-Native { schtasks /Delete /F /TN ComfyFedAgent 2>$null } | Out-Null
        $deleteRc = $LASTEXITCODE
        $taskStillExists = $false
        if ($deleteRc -ne 0) {
            # Live-caught 2026-09-16: a non-elevated re-run on a machine whose
            # scheduled task was created by an earlier ELEVATED run cannot
            # delete that task ("Access is denied"). Deletion failing is not
            # the same as no task existing -- check before assuming the Run
            # key path is needed, or a perfectly working scheduled task gets
            # reported as "autostart could not be configured".
            Invoke-Native { schtasks /Query /TN ComfyFedAgent 2>$null } | Out-Null
            if ($LASTEXITCODE -eq 0) { $taskStillExists = $true }
        }
        if ($taskStillExists) {
            $autostartOk = $true
            Write-Bilingual '已存在排程工作 ComfyFedAgent，沿用' 'Existing scheduled task ComfyFedAgent kept'
        } else {
            New-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' `
                -Name 'ComfyFedAgent' -Value $taskCmd -PropertyType String -Force | Out-Null
            $autostartOk = $true
            Write-Bilingual '未以系統管理員執行，已改用使用者層級自動啟動（登錄檔 Run 鍵）' `
                'Not elevated; using per-user autostart (registry Run key) instead'
        }
    } catch {
        Write-Host "[警告/WARNING] 無法設定開機自動啟動 / could not configure auto-start" -ForegroundColor Yellow
        Write-Host "手動替代 / Manual alternative: 以系統管理員執行 / run as administrator: schtasks /Create /F /TN ComfyFedAgent /SC ONLOGON /TR `"$taskCmd`"" -ForegroundColor Yellow
    }
}

# Live-caught 2026-09-16: re-running this installer on a machine whose agent
# was already autostarted at logon unconditionally launched a SECOND
# launcher + agent, which briefly fought the first one over the platform
# WebSocket (same worker id). The agent republishes agent_state.json every
# 5s (see comfyfed_agent.control.write_state / STATE_FILE); treat it as
# "live" only when its pid still exists, that pid's command line is actually
# the agent (not some unrelated process that reused the pid), AND the
# heartbeat is fresh (>60s stale means the agent likely died without
# cleaning up -- start a new one rather than trusting a corpse).
$AgentStatePath = Join-Path (Split-Path -Parent $AgentConfigPath) 'agent_state.json'

function Test-AgentAlreadyRunning {
    param([string]$StatePath)
    if (-not (Test-Path $StatePath)) { return $false }
    try {
        $state = Get-Content $StatePath -Raw | ConvertFrom-Json
    } catch { return $false }
    $stateProps = $state.PSObject.Properties.Name
    if (-not ($stateProps -contains 'pid') -or -not ($stateProps -contains 'updated_at')) { return $false }
    $statePid = 0
    if (-not [int]::TryParse([string]$state.pid, [ref]$statePid) -or $statePid -le 0) { return $false }
    try {
        $updatedAt = [DateTimeOffset]::Parse([string]$state.updated_at)
    } catch { return $false }
    if (([DateTimeOffset]::UtcNow - $updatedAt).TotalSeconds -gt 60) { return $false }
    try {
        $proc = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=$statePid" -ErrorAction Stop
    } catch { return $false }
    if ($null -eq $proc) { return $false }
    $procProps = $proc.PSObject.Properties.Name
    if (-not ($procProps -contains 'CommandLine')) { return $false }
    if ([string]$proc.CommandLine -notmatch 'comfyfed-agent') { return $false }
    return $statePid
}

$existingAgentPid = Test-AgentAlreadyRunning -StatePath $AgentStatePath
if ($existingAgentPid) {
    Write-Bilingual "agent 已在執行（pid $existingAgentPid），不再重複啟動" "Agent already running (pid $existingAgentPid); not starting a second one"
    Write-Bilingual '新版會在下次重啟時生效' 'the new build takes effect on the next agent restart'
} else {
    Write-Bilingual '立即啟動...' 'Starting now...'
    Start-Process -FilePath 'powershell.exe' -ArgumentList `
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", "`"$LauncherScript`"" `
        -WindowStyle Hidden
}

Write-Host ''
if ($autostartOk) {
    Write-Bilingual '安裝完成！ComfyFed agent 已在背景執行，並會於每次登入時自動啟動。' `
        'Install complete! The ComfyFed agent is now running in the background and will auto-start on every logon.'
} else {
    Write-Bilingual '安裝完成！ComfyFed agent 已在背景執行（但自動啟動設定失敗，重開機後請手動啟動，或參考上方警告）。' `
        'Install complete! The ComfyFed agent is running in the background (but autostart could not be configured -- start it manually after a reboot, or see the warning above).'
}
