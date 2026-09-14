# Phase 3.2 Zero-Holder Auto-Download Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Curated-registry models become auto-downloadable even when no federation worker holds them — no manual-download prompt for anything the platform can verify.

**Architecture:** `ModelSource` gains operator-vouched `sha256`/`size_bytes` (curated 11 only); manifest synthesis signs guide-hash entries when no reporter consensus exists (consensus wins when both exist); the missing-model 400 fires only for models the manifest cannot make fetchable. Cloud mirrors.

**Spec:** `docs/superpowers/specs/2026-09-12-comfyfed-spec.md` § "Phase 3.2 addendum" — binding.

## Global Constraints

- Consensus-over-guide precedence: a learned consensus hash ALWAYS wins over the guide hash for entry synthesis; mismatch logged once (info/warning), no conflict-tripwire involvement.
- Signature format unchanged: `name|directory|sha256|size_bytes`.
- Official-template-harvested guide entries stay hashless — no invented hashes, no behavior change for them.
- Server/cloud parity byte-exact (values identical, error codes identical). zh-TW-first docs. Tests foreground only, never backgrounded, one pytest at a time.
- Commits end `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

### Curated hash table (fixed values — copy VERBATIM; source: live federation consensus, 2026-09-14)

| name | size_bytes | sha256 |
|---|---|---|
| flux1-dev.safetensors | 23802932552 | 4610115bb0c89560703c892c59ac2742fa821e60ef5871b33493ba544683abd7 |
| ae.safetensors | 335304388 | afc8e28272cd15db3919bacdb6918ce9c1ed22e96cb12c4d5ed0fba823529e38 |
| clip_l.safetensors | 246144152 | 660c6f5b1abae9dc498ac2d21e1347d2abdb0cf6c0c0c8576cd796491d9a6cdd |
| t5xxl_fp16.safetensors | 9787841024 | 6e480b09fae049a72d2a8c5fbccb8d3e92febeb233bbe9dfe7256958a9167635 |
| qwen3vl_32b_heretic_minimax_h3_nvfp4.safetensors | 15683129587 | a166c7bbbe66a22065159e478335fee4a633c4a3e3bb34c8e8ac4cc91bf4996f |
| minimax_h3_ref2va_pruned_int8_convrot.safetensors | 20970379616 | 9255f52b6677845ad238f20dfaafa94727053694127ab7f255c048f0f9365779 |
| minimax_h3_video_vae_fp16.safetensors | 5207808496 | 7c1f131492e7eddacaac9069a61b81bdd39de5cc96561e677c5eab1cdce5e522 |
| minimax_h3_audio_vae_fp32.safetensors | 605254808 | 8e505d95dd1561d47abd43d4238fd40d9bb1ae9e147ed0a4cba778d76ae4db48 |
| minimax_h3_ref2v_turbo_8step_v1.0_768p_comfyui_resized_avg_rank_64_bf16.safetensors | 978227408 | 374dfbce47a9f44b19a4d78b44c63bf613ba74110077582603b3d74ad3d47254 |
| qwen3vl_4b_bf16.safetensors | 8875719384 | 36f3ff447ef59201722e8f9ce6020c9819fdcfba6aa2608c4e09b1c0ce114e34 |
| RealESRGAN_x4plus.pth | 67040989 | 4fa0d38905f75ac06eb49a7951b426670021be3018265fd191d2125df9d682f1 |

---

### Task 1: Server — guide hashes, manifest fallback, submission relaxation

**Files:** Modify `server/comfyfed_server/model_guide.py` (ModelSource dataclass + the 11 curated entries), `server/comfyfed_server/model_manifest.py` (entry synthesis: guide-hash entries when no consensus row; consensus precedence + mismatch log), `server/comfyfed_server/assess.py` + `comfyapi.py`/`jobs.py` missing-model check (400 only when manifest cannot produce a fetchable entry). Tests: extend `tests/server/test_model_manifest.py`, `test_comfyapi.py`, `test_assess.py`.
**Key behaviors:** zero-holder curated model → manifest entry signed with guide hash (url+backup_url from guide, peer flag false since no seeder); consensus row appears later → entry switches to consensus hash, mismatch logged once; eligible_after_fetch works unchanged off the manifest (add a test: empty-fleet-inventory worker with auto_fetch becomes eligible_after_fetch for a zero-holder curated model); panel/console submission with a zero-holder curated model queues instead of 400 (fleet-wide-gaps check consults fetchability); a truly unknown model still 400s with guidance.
**Steps:** TDD; run scoped test files foreground (PYTHONPATH="D:\WebstormProjects\ComfyFed-phase3_2\server;D:\WebstormProjects\ComfyFed-phase3_2\agent", D:/WebstormProjects/ComfyFed/.venv/Scripts/python.exe -m pytest <files> -q); commit immediately when green.

### Task 2: Cloud parity

**Files:** Modify `cloud/src/core/model_guide.ts` (same dataclass fields + same 11 value sets VERBATIM), `cloud/src/core/model_manifest.ts`, `cloud/src/core/assess.ts` + the missing-model path in `cloud/src/routes/comfyapi.ts`/`jobs.ts`; extend matching specs.
**Steps:** port Task 1 semantics; `npx vitest run` in cloud/ + `npx tsc --noEmit` foreground; commit.

### Task 3: Docs

**Files:** `docs/SELF-HOSTING.zh.md`/`.en.md` (missing-model / auto-download sections truth-update: curated 模型即使全聯邦沒有也會自動下載；提示只出現在來路不明的模型), spec §9 note if appropriate. zh first, en mirror.
**Steps:** verify claims against code; commit.
