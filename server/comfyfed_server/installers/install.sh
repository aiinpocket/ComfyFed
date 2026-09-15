#!/usr/bin/env bash
# ComfyFed one-line installer (Linux + macOS).
# 中文/EN bilingual output. Idempotent: safe to re-run.
#
# Template placeholders substituted server-side before this script is served:
#   {{PLATFORM_URL}}    -- e.g. https://console.example.com (no trailing slash expected)
#   {{REGISTER_TOKEN}}  -- worker register token, or empty string
#
# Usage (as served): curl -fsSL '{{PLATFORM_URL}}/install.sh?token=...' | bash

set -euo pipefail

main() {

PLATFORM_URL='{{PLATFORM_URL}}'
PLATFORM_URL="${PLATFORM_URL%/}"
REGISTER_TOKEN='{{REGISTER_TOKEN}}'

# 不需要（也不應該）用 root/sudo 執行：所有東西都裝在使用者家目錄，服務用
# systemd --user / launchd 使用者層級，root 執行只會把整套裝進 /root。
# No root/sudo needed (or wanted): everything installs into the user's home
# and autostart uses user-level systemd/launchd; running as root would
# install the whole stack into /root instead.
if [ "$(id -u)" -eq 0 ] && [ -z "${COMFYFED_ALLOW_ROOT:-}" ]; then
    echo "[錯誤/ERROR] 請不要用 sudo/root 執行本安裝：直接以一般使用者執行同一行指令即可。/ Do not run this installer as root: run the same one-liner as your normal user." >&2
    echo "（若你真的要裝給 root 使用者，設 COMFYFED_ALLOW_ROOT=1 再執行。/ To really install for root, set COMFYFED_ALLOW_ROOT=1.）" >&2
    exit 1
fi

COMFY_VERSION_PINNED='v0.35.0'
COMFY_GIT_URL="${COMFYFED_COMFY_GIT_URL:-https://github.com/Comfy-Org/ComfyUI}"
COMFY_GIT_REF="${COMFYFED_COMFY_REF:-$COMFY_VERSION_PINNED}"

APP_DIR="$HOME/.comfyfed/app"
VENV_DIR="$APP_DIR/venv"
COMFY_DIR="$HOME/.comfyfed/ComfyUI"
COMFY_VENV_DIR="$COMFY_DIR/venv"
HELPER_SCRIPT="$APP_DIR/_installer_helper.py"
MANAGED_MARKER="$APP_DIR/comfyui_managed.json"
AGENT_CONFIG_PATH="$HOME/.comfyfed/agent.json"

UNAME="$(uname -s)"
case "$UNAME" in
    Darwin) OS_KIND="darwin" ;;
    Linux) OS_KIND="linux" ;;
    *)
        echo "不支援的作業系統: $UNAME / Unsupported OS: $UNAME" >&2
        exit 1
        ;;
esac

bilingual() {
    echo "$1 / $2"
}

fail_step() {
    # fail_step "<step zh>" "<step en>" "<manual zh>" "<manual en>"
    echo "" >&2
    echo "[失敗/FAILED] $1 / $2" >&2
    echo "手動替代 / Manual alternative: $3 / $4" >&2
    exit 1
}

mkdir -p "$APP_DIR"

# ---------------------------------------------------------------------------
# 1. Python
# ---------------------------------------------------------------------------

python_version_ok() {
    local exe="$1"
    command -v "$exe" >/dev/null 2>&1 || return 1
    local ver
    ver="$("$exe" --version 2>&1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n1)" || return 1
    [ -n "$ver" ] || return 1
    local major minor
    major="$(echo "$ver" | cut -d. -f1)"
    minor="$(echo "$ver" | cut -d. -f2)"
    [ "$major" -gt 3 ] && return 0
    [ "$major" -eq 3 ] && [ "$minor" -ge 10 ] && return 0
    return 1
}

# A relocatable CPython we may have installed ourselves on a previous run
# (see install_standalone_python) wins over whatever the system offers, so
# re-runs are deterministic and never regress to an older system python3.
PY_STANDALONE_DIR="$HOME/.comfyfed/python"

resolve_python() {
    if [ -x "$PY_STANDALONE_DIR/bin/python3" ] && python_version_ok "$PY_STANDALONE_DIR/bin/python3"; then
        echo "$PY_STANDALONE_DIR/bin/python3"
        return 0
    fi
    for exe in python3.12 python3 python; do
        if python_version_ok "$exe"; then
            echo "$exe"
            return 0
        fi
    done
    return 1
}

# ---------------------------------------------------------------------------
# Relocatable CPython (no sudo, no Xcode, no package manager), from Astral's
# python-build-standalone -- the same builds `uv` installs. macOS ships no
# usable Python (the Xcode CLT one is 3.9, below our >=3.10 floor) and Linux
# package managers need sudo; a per-user tarball under ~/.comfyfed/python
# needs neither. The default release is pinned WITH its sha256 digests below,
# so the download is verified offline; overriding the release via
# COMFYFED_PYTHON_RELEASE / COMFYFED_PYTHON_VERSION verifies against that
# release's published SHA256SUMS instead (trusting GitHub's release file).
# ---------------------------------------------------------------------------
PY_STANDALONE_TAG="${COMFYFED_PYTHON_RELEASE:-20260901}"
PY_STANDALONE_VER="${COMFYFED_PYTHON_VERSION:-3.12.14}"
PY_STANDALONE_BASE="${COMFYFED_PYTHON_MIRROR:-https://github.com/astral-sh/python-build-standalone/releases/download}"

standalone_target() {
    local arch
    arch="$(uname -m)"
    case "$OS_KIND/$arch" in
        darwin/arm64|darwin/aarch64) echo "aarch64-apple-darwin" ;;
        darwin/x86_64) echo "x86_64-apple-darwin" ;;
        linux/x86_64|linux/amd64) echo "x86_64-unknown-linux-gnu" ;;
        linux/aarch64|linux/arm64) echo "aarch64-unknown-linux-gnu" ;;
        *) return 1 ;;
    esac
}

# sha256 of the pinned default release's install_only tarballs (from that
# release's SHA256SUMS). Anything else -> empty -> verified online instead.
pinned_standalone_sha256() {
    [ "$PY_STANDALONE_TAG" = "20260901" ] && [ "$PY_STANDALONE_VER" = "3.12.14" ] || return 0
    case "$1" in
        aarch64-apple-darwin) echo "3ee3ee547cedfeb7c2b16b2b7156039f7b470bb8f857e226fd3d2eb11db83c76" ;;
        x86_64-apple-darwin) echo "2e31b23f3f1319f707d0e620b48847a0046577541d357276821f9f1b5492e0ba" ;;
        x86_64-unknown-linux-gnu) echo "936c246dfdbbfa7cb22dd01814a21f582a892689fae96b06071a5e433baffa22" ;;
        aarch64-unknown-linux-gnu) echo "b61b856c3e1a4fc65b8f6e6b0495ef975dd0924f90c59f3ea61b38a079173b84" ;;
    esac
}

file_sha256() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | cut -d' ' -f1
    else
        shasum -a 256 "$1" | cut -d' ' -f1
    fi
}

install_standalone_python() {
    local target fname url tmp expected actual
    target="$(standalone_target)" || {
        echo "不支援的 CPU/OS 組合: $OS_KIND/$(uname -m) / Unsupported CPU/OS combination: $OS_KIND/$(uname -m)" >&2
        return 1
    }
    fname="cpython-${PY_STANDALONE_VER}+${PY_STANDALONE_TAG}-${target}-install_only.tar.gz"
    url="${PY_STANDALONE_BASE}/${PY_STANDALONE_TAG}/${fname//+/%2B}"   # GitHub encodes '+' as %2B
    bilingual "下載可搬移的 Python ${PY_STANDALONE_VER}（python-build-standalone，不需要 sudo，約 25–110 MB）..." \
        "Downloading relocatable Python ${PY_STANDALONE_VER} (python-build-standalone, no sudo, ~25-110 MB)..."
    tmp="$(mktemp -d)"
    if ! curl -fsSL "$url" -o "$tmp/$fname"; then
        echo "下載失敗: $url / download failed: $url" >&2
        rm -rf "$tmp"; return 1
    fi
    expected="$(pinned_standalone_sha256 "$target")"
    if [ -z "$expected" ]; then
        expected="$( (curl -fsSL "${PY_STANDALONE_BASE}/${PY_STANDALONE_TAG}/SHA256SUMS" 2>/dev/null || true) | grep -E "  ${fname}\$" | awk '{print $1}' || true)"
    fi
    actual="$(file_sha256 "$tmp/$fname")"
    if [ -z "$expected" ] || [ "$actual" != "$expected" ]; then
        echo "Python 壓縮包 sha256 不符（預期 ${expected:-<無>}，實際 ${actual}），拒絕安裝 / Python tarball sha256 mismatch (expected ${expected:-<none>}, got ${actual}); refusing to install" >&2
        rm -rf "$tmp"; return 1
    fi
    rm -rf "$PY_STANDALONE_DIR"
    mkdir -p "$PY_STANDALONE_DIR"
    # install_only tarballs unpack to a single top-level "python/" directory.
    if ! tar -xzf "$tmp/$fname" -C "$PY_STANDALONE_DIR" --strip-components=1; then
        echo "解壓失敗 / extraction failed" >&2
        rm -rf "$tmp" "$PY_STANDALONE_DIR"; return 1
    fi
    rm -rf "$tmp"
    [ -x "$PY_STANDALONE_DIR/bin/python3" ] || { echo "解壓後找不到 bin/python3 / bin/python3 missing after extraction" >&2; return 1; }
    bilingual "已安裝 Python 到 $PY_STANDALONE_DIR" "Installed Python into $PY_STANDALONE_DIR"
    return 0
}

bilingual "尋找 Python (>=3.10)..." "Looking for Python (>=3.10)..."
PYTHON_BIN=""
if PYTHON_BIN="$(resolve_python)"; then
    :
else
    bilingual "未找到合適的 Python，自動安裝中..." "No suitable Python found; installing one automatically..."
    # First choice on BOTH macOS and Linux: a per-user relocatable CPython --
    # no sudo, no Xcode, no distro package manager. Only if that download
    # fails does Linux fall back to apt/dnf (which needs sudo).
    if install_standalone_python; then
        :
    elif [ "$OS_KIND" = "linux" ]; then
        if sudo -n true 2>/dev/null; then
            bilingual "以 sudo 安裝 python3-venv python3-pip..." "Installing python3-venv python3-pip via sudo..."
            if command -v apt-get >/dev/null 2>&1; then
                sudo -n apt-get update -y && sudo -n apt-get install -y python3 python3-venv python3-pip \
                    || fail_step "安裝 Python" "installing Python" \
                        "請手動執行: sudo apt-get install -y python3 python3-venv python3-pip" \
                        "please run manually: sudo apt-get install -y python3 python3-venv python3-pip"
            elif command -v dnf >/dev/null 2>&1; then
                sudo -n dnf install -y python3 python3-pip \
                    || fail_step "安裝 Python" "installing Python" \
                        "請手動執行: sudo dnf install -y python3 python3-pip" \
                        "please run manually: sudo dnf install -y python3 python3-pip"
            else
                fail_step "找不到套件管理器" "no supported package manager found" \
                    "請手動安裝 Python 3.10 以上版本" "please install Python 3.10+ manually"
            fi
        else
            if command -v apt-get >/dev/null 2>&1; then
                fail_step "需要 sudo 權限安裝 Python" "installing Python needs sudo" \
                    "請手動執行: sudo apt-get install -y python3 python3-venv python3-pip，再重跑本腳本" \
                    "please run manually: sudo apt-get install -y python3 python3-venv python3-pip, then re-run this script"
            elif command -v dnf >/dev/null 2>&1; then
                fail_step "需要 sudo 權限安裝 Python" "installing Python needs sudo" \
                    "請手動執行: sudo dnf install -y python3 python3-pip，再重跑本腳本" \
                    "please run manually: sudo dnf install -y python3 python3-pip, then re-run this script"
            else
                fail_step "找不到 Python" "Python not found" \
                    "請手動安裝 Python 3.10 以上版本後重跑本腳本" "please install Python 3.10+ manually then re-run this script"
            fi
        fi
    else
        # darwin: the standalone download failed (network / unsupported CPU).
        # The Xcode CLT python3 is 3.9 -- below our floor -- so it is NOT a
        # fix; point at python.org instead.
        fail_step "自動安裝 Python 失敗" "automatic Python install failed" \
            "請確認網路可連到 github.com 後重跑本腳本；或至 https://www.python.org/downloads/macos/ 安裝 Python 3.12 再重跑" \
            "please make sure github.com is reachable and re-run this script; or install Python 3.12 from https://www.python.org/downloads/macos/ and re-run"
    fi

    if ! PYTHON_BIN="$(resolve_python)"; then
        fail_step "安裝後仍找不到 Python" "Python still not found after install" \
            "請重跑本腳本，或手動安裝 Python 3.10 以上版本" "please re-run this script, or install Python 3.10+ manually"
    fi
fi

bilingual "使用 Python: $PYTHON_BIN" "Using Python: $PYTHON_BIN"

# ---------------------------------------------------------------------------
# 2. venv + agent wheel
# ---------------------------------------------------------------------------

VENV_PYTHON="$VENV_DIR/bin/python"
VENV_PIP="$VENV_DIR/bin/pip"
VENV_AGENT="$VENV_DIR/bin/comfyfed-agent"

if [ ! -x "$VENV_PYTHON" ]; then
    bilingual "建立虛擬環境..." "Creating virtual environment..."
    "$PYTHON_BIN" -m venv "$VENV_DIR" || fail_step "建立虛擬環境" "creating the virtual environment" \
        "請確認 Python 安裝完整（含 venv 模組）" "please confirm Python is installed completely (including the venv module)"
fi

sha256_of() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | cut -d' ' -f1
    else
        shasum -a 256 "$1" | cut -d' ' -f1
    fi
}

bilingual "查詢最新 agent 版本..." "Fetching the latest agent version..."
VERSION_JSON="$(curl -fsSL "$PLATFORM_URL/api/agent/version")" || fail_step \
    "連線到平台取得 agent 版本" "contacting the platform for the agent version" \
    "請確認網路連線與平台網址 $PLATFORM_URL 正確" "please check your network connection and that $PLATFORM_URL is correct"

WHEEL_URL="$("$VENV_PYTHON" -c "import json,sys; print(json.loads(sys.argv[1]).get('wheel_url') or '')" "$VERSION_JSON")"
WHEEL_SHA256="$("$VENV_PYTHON" -c "import json,sys; print(json.loads(sys.argv[1]).get('sha256') or '')" "$VERSION_JSON")"

if [ -z "$WHEEL_URL" ] || [ -z "$WHEEL_SHA256" ]; then
    fail_step "平台尚未發佈 agent wheel" "the platform has not published an agent wheel yet" \
        "請聯絡平台管理員" "please contact the platform administrator"
fi

case "$WHEEL_URL" in
    http://*|https://*) ;;
    *) WHEEL_URL="$PLATFORM_URL$WHEEL_URL" ;;
esac

# A plain `mktemp -t NAME-XXXXXX.whl` only appends the `.whl` suffix on
# GNU mktemp (Linux); BSD mktemp (macOS) ignores everything after the last
# `X` and creates an extension-less file, and pip refuses to install a
# wheel whose filename doesn't end in `.whl`. Make a temp *directory*
# (portable across GNU/BSD mktemp) and give the wheel a fixed name inside it.
# pip also validates the FILENAME, not just the bytes: anything that is not
# PEP 427 `<dist>-<version>[-<build>]-<py>-<abi>-<plat>.whl` is refused with
# "is not a valid wheel filename" (a fixed `agent.whl` broke every macOS
# install). Use the URL's own basename -- the platform publishes the wheel
# under its real name -- and fall back to the conventional pure-Python name
# for this version when the URL carries no usable one.
LATEST_VERSION="$("$VENV_PYTHON" -c "import json,sys; print(json.loads(sys.argv[1]).get('latest') or '')" "$VERSION_JSON")"
WHEEL_NAME="$(basename "${WHEEL_URL%%\?*}")"
case "$WHEEL_NAME" in
    *-*-*-*.whl) ;;
    *) WHEEL_NAME="comfyfed-${LATEST_VERSION:-0}-py3-none-any.whl" ;;
esac
WHEEL_TMPDIR="$(mktemp -d)"
WHEEL_FILE="$WHEEL_TMPDIR/$WHEEL_NAME"
bilingual "下載 agent wheel..." "Downloading agent wheel..."
curl -fsSL "$WHEEL_URL" -o "$WHEEL_FILE" || fail_step "下載 agent wheel" "downloading the agent wheel" \
    "請確認網路連線後重跑本腳本" "please check your network connection then re-run this script"

ACTUAL_SHA256="$(sha256_of "$WHEEL_FILE")"
if [ "$ACTUAL_SHA256" != "$WHEEL_SHA256" ]; then
    rm -rf "$WHEEL_TMPDIR"
    fail_step "agent wheel 的 sha256 驗證失敗" "agent wheel sha256 verification failed" \
        "請重跑本腳本；若持續失敗請聯絡平台管理員" "please re-run this script; contact the platform administrator if it keeps failing"
fi

bilingual "安裝 agent..." "Installing agent..."
"$VENV_PIP" install --upgrade "$WHEEL_FILE" || fail_step "安裝 agent wheel" "installing the agent wheel" \
    "請重跑本腳本" "please re-run this script"
rm -rf "$WHEEL_TMPDIR"

# `comfyfed pause`/`resume`/`status`/`stop` on PATH: symlink the venv's
# console-script into ~/.local/bin (the de-facto per-user bin dir on both
# Linux and macOS). Non-fatal -- a missing PATH entry just means the user
# has to invoke the venv binary directly, so warn instead of failing the
# whole install.
# The mkdir is guarded too: the script runs under `set -euo pipefail`, so an
# unwritable $HOME would otherwise abort the whole install on a step the
# comment above calls non-fatal.
if mkdir -p "$HOME/.local/bin" 2>/dev/null && ln -sf "$VENV_DIR/bin/comfyfed" "$HOME/.local/bin/comfyfed"; then
    bilingual "已將 comfyfed 加入 ~/.local/bin" "Linked comfyfed into ~/.local/bin"
    # ~/.local/bin is NOT on the default PATH on macOS (stock /etc/paths) nor
    # on minimal Linux images, so say so instead of letting `comfyfed pause`
    # answer "command not found".
    case ":$PATH:" in
        *":$HOME/.local/bin:"*) ;;
        *)
            echo "[提示/NOTE] ~/.local/bin 不在 PATH 上。請加入（zsh 用 ~/.zshrc，bash 用 ~/.bashrc）： / ~/.local/bin is not on your PATH. Add it (zsh: ~/.zshrc, bash: ~/.bashrc):" >&2
            echo "    echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.zshrc && exec \$SHELL -l" >&2
            ;;
    esac
else
    echo "[警告/WARNING] 無法建立 ~/.local/bin/comfyfed 符號連結 / could not create the ~/.local/bin/comfyfed symlink" >&2
    echo "手動替代 / Manual alternative: 直接執行 $VENV_DIR/bin/comfyfed / run $VENV_DIR/bin/comfyfed directly" >&2
fi

# ---------------------------------------------------------------------------
# Helper python script (ComfyUI detection), dropped to disk instead of
# fragile inline -c one-liners.
# ---------------------------------------------------------------------------

cat > "$HELPER_SCRIPT" <<'PYEOF'
"""ComfyFed installer helper: ComfyUI detection.

Invoked by install.sh / install.ps1 as `python _installer_helper.py <cmd> ...`
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


if __name__ == "__main__":
    command = sys.argv[1]
    if command == "check":
        cmd_check()
    elif command == "apply":
        cmd_apply(sys.argv[2])
    else:
        print(f"unknown command: {command}", file=sys.stderr)
        sys.exit(2)
PYEOF

# ---------------------------------------------------------------------------
# 3. Registration
# ---------------------------------------------------------------------------

# Idempotent re-run: a register token is single-use, so a second run (e.g.
# after a later step failed) must not die on a consumed token -- if
# agent.json already pins this platform, skip registration.
ALREADY_REGISTERED=0
if [ -f "$HOME/.comfyfed/agent.json" ] && grep -qF "$PLATFORM_URL" "$HOME/.comfyfed/agent.json" 2>/dev/null; then
    ALREADY_REGISTERED=1
fi

# Self-heal a dead registration: if this platform is already pinned AND a
# fresh token was supplied, probe whether the platform still accepts us.
# A definitive 4401 (check-registration exit 10) means the worker was removed
# server-side, so we fall through to re-register -- register now REPLACES the
# dead entry rather than stacking a second. Exit 0 (live), 3 (undetermined:
# network/timeout) or 1 (none) keep the skip: never burn the single-use token
# on a transient outage. Exit 10 is deliberately NOT 2 -- argparse exits 2 on
# an unknown subcommand, so an OLDER wheel lacking check-registration (served
# the new installer mid-rollout) exits 2 and must NOT be read as dead.
if [ "$ALREADY_REGISTERED" -eq 1 ] && [ -n "$REGISTER_TOKEN" ]; then
    CHECK_RC=0
    "$VENV_AGENT" check-registration || CHECK_RC=$?
    if [ "$CHECK_RC" -eq 10 ]; then
        bilingual "偵測到註冊已失效（4401），將重新註冊" "Detected a dead registration (4401); re-registering"
        ALREADY_REGISTERED=0
    fi
fi

if [ "$ALREADY_REGISTERED" -eq 1 ]; then
    bilingual "此機器已註冊過本平台，跳過註冊步驟" "Already registered with this platform; skipping registration"
elif [ -n "$REGISTER_TOKEN" ]; then
    bilingual "註冊 worker..." "Registering worker..."
    PLATFORM_JSON="$(curl -fsSL "$PLATFORM_URL/api/platform")" || fail_step \
        "取得平台資訊" "fetching platform info" \
        "請確認網路連線後重跑本腳本" "please check your network connection then re-run this script"

    BUNDLE_PATH="$APP_DIR/bundle.json"
    "$VENV_PYTHON" -c "
import json, sys
platform = json.loads(sys.argv[1])
bundle = {
    'platform_url': platform.get('platform_url', ''),
    'platform_pubkey': platform.get('platform_pubkey', ''),
    'register_token': sys.argv[2],
}
with open(sys.argv[3], 'w', encoding='utf-8') as f:
    json.dump(bundle, f)
" "$PLATFORM_JSON" "$REGISTER_TOKEN" "$BUNDLE_PATH"

    "$VENV_AGENT" register "$BUNDLE_PATH" || fail_step \
        "執行 comfyfed-agent register" "running comfyfed-agent register" \
        "請確認 token 未過期或未被使用過，並重跑本腳本" \
        "please confirm the token has not expired or been used, then re-run this script"
    rm -f "$BUNDLE_PATH"
    bilingual "註冊完成" "Registration complete"
else
    bilingual "未提供 register token，跳過註冊" "No register token provided, skipping registration"
    bilingual "請到主控台發 bundle 後執行" "Please issue a bundle from the console, then run"
    echo "  \"$VENV_AGENT\" register bundle.json"
fi

# ---------------------------------------------------------------------------
# 4. ComfyUI check + optional install
# ---------------------------------------------------------------------------

COMFY_MANAGED=0

if [ -f "$MANAGED_MARKER" ]; then
    COMFY_MANAGED=1
    bilingual "已由本安裝器管理的 ComfyUI，略過重新安裝" \
        "ComfyUI already managed by this installer, skipping reinstall"
else
    bilingual "偵測本機 ComfyUI..." "Detecting local ComfyUI..."
    if "$VENV_PYTHON" "$HELPER_SCRIPT" check >/dev/null; then
        bilingual "找到本機 ComfyUI" "Found a local ComfyUI"
    else
        bilingual "找不到 ComfyUI，將安裝 $COMFY_VERSION_PINNED 版本" \
            "No ComfyUI found; installing version $COMFY_VERSION_PINNED"

        command -v git >/dev/null 2>&1 || fail_step "找不到 git" "git not found" \
            "請先安裝 git 後重跑本腳本" "please install git first then re-run this script"

        git clone --depth 1 --branch "$COMFY_GIT_REF" "$COMFY_GIT_URL" "$COMFY_DIR" || fail_step \
            "clone ComfyUI" "cloning ComfyUI" \
            "請手動執行: git clone --branch $COMFY_GIT_REF $COMFY_GIT_URL $COMFY_DIR" \
            "please run manually: git clone --branch $COMFY_GIT_REF $COMFY_GIT_URL $COMFY_DIR"

        "$PYTHON_BIN" -m venv "$COMFY_VENV_DIR" || fail_step "建立 ComfyUI 虛擬環境" \
            "creating the ComfyUI virtual environment" "請重跑本腳本" "please re-run this script"

        COMFY_VENV_PIP="$COMFY_VENV_DIR/bin/pip"
        COMFY_VENV_PYTHON="$COMFY_VENV_DIR/bin/python"

        if [ "$OS_KIND" = "darwin" ]; then
            bilingual "安裝 torch (macOS/MPS)..." "Installing torch (macOS/MPS)..."
            "$COMFY_VENV_PIP" install torch torchvision torchaudio ||
                fail_step "torch 安裝失敗（可手動執行同一指令後重跑本安裝器）" "torch install failed (run the same command manually, then re-run this installer)"
        elif command -v nvidia-smi >/dev/null 2>&1; then
            bilingual "偵測到 NVIDIA GPU，安裝 CUDA 版 torch..." "NVIDIA GPU detected, installing CUDA torch..."
            "$COMFY_VENV_PIP" install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu126 ||
                fail_step "CUDA torch 安裝失敗（可手動執行同一指令後重跑本安裝器）" "CUDA torch install failed (run the same command manually, then re-run this installer)"
        else
            bilingual "未偵測到 NVIDIA GPU，安裝 CPU 版 torch..." "No NVIDIA GPU detected, installing CPU torch..."
            "$COMFY_VENV_PIP" install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cpu ||
                fail_step "CPU torch 安裝失敗（可手動執行同一指令後重跑本安裝器）" "CPU torch install failed (run the same command manually, then re-run this installer)"
        fi

        bilingual "安裝 ComfyUI 相依套件..." "Installing ComfyUI dependencies..."
        "$COMFY_VENV_PIP" install -r "$COMFY_DIR/requirements.txt" || fail_step \
            "安裝 ComfyUI 相依套件" "installing ComfyUI dependencies" \
            "請重跑本腳本" "please re-run this script"

        bilingual "啟動 ComfyUI 並等待就緒..." "Starting ComfyUI and waiting for it to become ready..."
        nohup "$COMFY_VENV_PYTHON" "$COMFY_DIR/main.py" >"$COMFY_DIR/comfyui.log" 2>&1 &

        READY=0
        for _ in $(seq 1 60); do
            if curl -fsS "http://127.0.0.1:8188/system_stats" >/dev/null 2>&1; then
                READY=1
                break
            fi
            sleep 3
        done
        if [ "$READY" -ne 1 ]; then
            fail_step "ComfyUI 未在時限內就緒" "ComfyUI did not become ready in time" \
                "請手動執行: $COMFY_VENV_PYTHON $COMFY_DIR/main.py 並檢查 $COMFY_DIR/comfyui.log" \
                "please manually run: $COMFY_VENV_PYTHON $COMFY_DIR/main.py and check $COMFY_DIR/comfyui.log"
        fi
        bilingual "ComfyUI 已就緒" "ComfyUI is ready"

        "$VENV_PYTHON" -c "
import json, sys
managed = {'start_exe': sys.argv[1], 'args': [sys.argv[2]]}
with open(sys.argv[3], 'w', encoding='utf-8') as f:
    json.dump(managed, f)
" "$COMFY_VENV_PYTHON" "$COMFY_DIR/main.py" "$MANAGED_MARKER"
        COMFY_MANAGED=1

        bilingual "重新偵測並套用設定..." "Re-running detection and saving config..."
        "$VENV_PYTHON" "$HELPER_SCRIPT" apply "$AGENT_CONFIG_PATH" ||
            fail_step "ComfyUI 偵測/設定寫入失敗" "ComfyUI detection/config write failed"
    fi
fi

# ---------------------------------------------------------------------------
# 5. Autostart
# ---------------------------------------------------------------------------
# Units/plists below exec the ComfyUI venv python and the agent binary
# directly (ExecStart / ProgramArguments) -- there used to be a
# launcher.sh generated here for them to go through, but nothing ever
# referenced it, so it was dead code. Removed.

xml_escape() {
    # Escape a value for use as XML character data / attribute content in
    # the launchd plists below (paths are derived from $HOME, which is not
    # fully trusted input).
    printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

bilingual "設定開機自動啟動..." "Configuring auto-start on login..."

if [ "$OS_KIND" = "linux" ]; then
    SYSTEMD_USER_DIR="$HOME/.config/systemd/user"
    mkdir -p "$SYSTEMD_USER_DIR"

    if [ "$COMFY_MANAGED" -eq 1 ]; then
        cat > "$SYSTEMD_USER_DIR/comfyfed-comfyui.service" <<UNITEOF
[Unit]
Description=ComfyFed managed ComfyUI

[Service]
Type=simple
ExecStart="$COMFY_VENV_DIR/bin/python" "$COMFY_DIR/main.py"
Restart=on-failure

[Install]
WantedBy=default.target
UNITEOF
        AFTER_LINE="After=comfyfed-comfyui.service"
    else
        AFTER_LINE=""
    fi

    cat > "$SYSTEMD_USER_DIR/comfyfed-agent.service" <<UNITEOF
[Unit]
Description=ComfyFed agent
$AFTER_LINE

[Service]
Type=simple
ExecStart="$VENV_AGENT" run
Restart=on-failure

[Install]
WantedBy=default.target
UNITEOF

    # `systemctl --user` needs a user D-Bus/systemd session; that's absent
    # in plenty of the environments this installer runs in (containers,
    # WSL without systemd enabled, minimal chroots). Under `set -euo
    # pipefail` a bare failed systemctl call would kill the whole
    # installer *after* everything else has already succeeded, which is
    # worse than just telling the user how to finish the last step by
    # hand -- so route it through fail_step with that guidance instead.
    systemctl --user daemon-reload || fail_step \
        "systemctl --user daemon-reload 失敗" "systemctl --user daemon-reload failed" \
        "容器/WSL 環境可能沒有 user D-Bus session；請先執行 'loginctl enable-linger $USER'（如適用）後手動執行: systemctl --user daemon-reload" \
        "containers/WSL may lack a user D-Bus session; try 'loginctl enable-linger $USER' (if applicable) then run manually: systemctl --user daemon-reload"
    if [ "$COMFY_MANAGED" -eq 1 ]; then
        systemctl --user enable --now comfyfed-comfyui.service || fail_step \
            "啟用 comfyfed-comfyui.service 失敗" "enabling comfyfed-comfyui.service failed" \
            "請手動執行: systemctl --user enable --now comfyfed-comfyui.service" \
            "please run manually: systemctl --user enable --now comfyfed-comfyui.service"
    fi
    systemctl --user enable --now comfyfed-agent.service || fail_step \
        "啟用 comfyfed-agent.service 失敗" "enabling comfyfed-agent.service failed" \
        "請手動執行: systemctl --user enable --now comfyfed-agent.service" \
        "please run manually: systemctl --user enable --now comfyfed-agent.service"

    bilingual "提示: 若要讓服務在登出後仍持續執行，請執行 'loginctl enable-linger $USER'" \
        "Tip: to keep the service running after logout, run 'loginctl enable-linger $USER'"
elif [ "$OS_KIND" = "darwin" ]; then
    LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
    mkdir -p "$LAUNCH_AGENTS_DIR"

    if [ "$COMFY_MANAGED" -eq 1 ]; then
        COMFY_VENV_PYTHON_XML="$(xml_escape "$COMFY_VENV_DIR/bin/python")"
        COMFY_MAIN_XML="$(xml_escape "$COMFY_DIR/main.py")"
        cat > "$LAUNCH_AGENTS_DIR/com.comfyfed.comfyui.plist" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>com.comfyfed.comfyui</string>
    <key>ProgramArguments</key>
    <array>
        <string>$COMFY_VENV_PYTHON_XML</string>
        <string>$COMFY_MAIN_XML</string>
    </array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
</dict>
</plist>
PLISTEOF
        launchctl load -w "$LAUNCH_AGENTS_DIR/com.comfyfed.comfyui.plist" 2>/dev/null || true
    fi

    VENV_AGENT_XML="$(xml_escape "$VENV_AGENT")"
    # An upgrade rewrites the plist, but `launchctl load -w` on an
    # already-loaded job is a no-op: the running job would keep the OLD
    # KeepAlive=true definition (and resurrect the agent after every
    # `comfyfed stop`) until the user logged out. Unload first.
    launchctl unload -w "$LAUNCH_AGENTS_DIR/com.comfyfed.agent.plist" 2>/dev/null || true
    cat > "$LAUNCH_AGENTS_DIR/com.comfyfed.agent.plist" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>com.comfyfed.agent</string>
    <key>ProgramArguments</key>
    <array>
        <string>$VENV_AGENT_XML</string>
        <string>run</string>
    </array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key><false/>
    </dict>
</dict>
</plist>
PLISTEOF
    launchctl load -w "$LAUNCH_AGENTS_DIR/com.comfyfed.agent.plist" 2>/dev/null || true
fi

echo ""
bilingual "安裝完成！ComfyFed agent 已在背景執行，並會於每次登入時自動啟動。" \
    "Install complete! The ComfyFed agent is now running in the background and will auto-start on every login."
}

main "$@"
