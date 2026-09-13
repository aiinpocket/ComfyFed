"""Generate golden Ed25519/formatting test vectors shared between the Python
server/agent and the Cloudflare Workers TypeScript port (cloud/).

Run with the repo venv (PyNaCl available):

    .venv/Scripts/python.exe scripts/golden_vectors.py

Writes cloud/test/fixtures/golden.json. Covers the four signature-byte-parity
canonical strings called out in the plan's Global Constraints:

  1. receipt payload:        f"{job_id}|{worker_id}|{gpu_seconds:.1f}"
                              (comfyfed_server/agentws.py _sign_and_store_receipt)
  2. registration cert:      f"{worker_id}|{pubkey_hex}"
                              (comfyfed_server/workers.py register())
  3. release signature:      f"{version}|{sha256_hex}"
                              (comfyfed_server/main.py _publish_agent)
  4. signed-request canonical string:
        f"{METHOD}\\n{path}[?{query}]\\n{ts}\\n{nonce}\\n" + body (raw bytes,
        NOT hashed -- confirmed against comfyfed_server/workers.py
        _canonical_message and agent/comfyfed_agent/signing.py signed_headers)

Also emits 20 Python `format(x, '.1f')` cases (including round-half-even
ties) so cloud/src/lib/format.ts's python1f() can be checked byte-for-byte.
"""

from __future__ import annotations

import json
import os
import sys

from nacl.signing import SigningKey

FIXTURE_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "cloud", "test", "fixtures", "golden.json"
)

import hashlib


def _fixed_seed_hex(label: str) -> str:
    """Deterministic 32-byte hex seed derived from a label (not random), so
    regenerating the fixture is reproducible and diffs stay clean."""
    return hashlib.sha256(label.encode()).hexdigest()


# Fixed seeds (not random) so regenerating the fixture is reproducible and
# diffs stay clean.
SEED_HEXES = [
    _fixed_seed_hex("comfyfed-golden-seed-1"),
    _fixed_seed_hex("comfyfed-golden-seed-2"),
    _fixed_seed_hex("comfyfed-golden-seed-3"),
]

DOTONEF_CASES = [
    0.0,
    1.0,
    -1.0,
    0.05,
    0.15,
    0.25,
    2.5,
    9.999,
    0.04999,
    1.25,
    1.35,
    0.5,
    1.5,
    2.05,
    3.14159,
    100.0,
    0.001,
    -0.05,
    123456.789,
    0.045,
]


def make_keypair(seed_hex: str) -> dict:
    signing_key = SigningKey(bytes.fromhex(seed_hex))
    verify_key = signing_key.verify_key
    return {
        "seed_hex": seed_hex,
        "pubkey_hex": bytes(verify_key).hex(),
    }


def sign_hex(signing_key: SigningKey, message: bytes) -> str:
    return signing_key.sign(message).signature.hex()


def build_receipt_cases(signing_key: SigningKey) -> list[dict]:
    cases = []
    for i, gpu_seconds in enumerate(DOTONEF_CASES):
        job_id = f"job-{i:02d}"
        worker_id = f"worker-{i:02d}"
        formatted = format(gpu_seconds, ".1f")
        payload = f"{job_id}|{worker_id}|{formatted}"
        cases.append(
            {
                "job_id": job_id,
                "worker_id": worker_id,
                "gpu_seconds": gpu_seconds,
                "gpu_seconds_1f": formatted,
                "payload": payload,
                "signature_hex": sign_hex(signing_key, payload.encode()),
            }
        )
    return cases


def build_registration_sample(signing_key: SigningKey, pubkey_hex: str) -> dict:
    worker_id = "11111111-2222-3333-4444-555555555555"
    payload = f"{worker_id}|{pubkey_hex}"
    return {
        "worker_id": worker_id,
        "pubkey_hex": pubkey_hex,
        "payload": payload,
        "certificate_hex": sign_hex(signing_key, payload.encode()),
    }


def build_release_sample(signing_key: SigningKey) -> dict:
    version = "1.10.0"
    sha256_hex = "deadbeef" * 8
    payload = f"{version}|{sha256_hex}"
    return {
        "version": version,
        "sha256_hex": sha256_hex,
        "payload": payload,
        "signature_hex": sign_hex(signing_key, payload.encode()),
    }


def build_signed_request_sample(signing_key: SigningKey) -> dict:
    method = "POST"
    path = "/api/agent/jobs/job-abc123/artifacts/raw/tok-xyz"
    query = "from=agent&retry=1"
    ts = "1799999999"
    nonce = "a1b2c3d4e5f60718293a4b5c6d7e8f90"
    # A small utf-8 "binary-ish" body standing in for multipart bytes -- the
    # canonical string embeds the RAW body (not a hash of it), confirmed
    # against comfyfed_server/workers.py::_canonical_message and
    # agent/comfyfed_agent/signing.py::signed_headers. Includes bytes >0x7f
    # only via the utf-8 encoding of the wide characters below (Workers'
    # TextEncoder and Python's .encode() must agree byte-for-byte).
    body_text = 'multipart-ish body 中文 \x00\x01\x02 end'
    body_bytes = body_text.encode("utf-8")

    target = f"{path}?{query}"
    message = f"{method}\n{target}\n{ts}\n{nonce}\n".encode() + body_bytes

    return {
        "method": method,
        "path": path,
        "query": query,
        "ts": ts,
        "nonce": nonce,
        "body_utf8_text": body_text,
        "body_hex": body_bytes.hex(),
        "canonical_message_hex": message.hex(),
        "signature_hex": sign_hex(signing_key, message),
    }


def build_signed_request_sample_no_query(signing_key: SigningKey) -> dict:
    method = "GET"
    path = "/api/agent/ping"
    ts = "1800000000"
    nonce = "ffeeddccbbaa99887766554433221100"
    body_bytes = b""
    message = f"{method}\n{path}\n{ts}\n{nonce}\n".encode() + body_bytes
    return {
        "method": method,
        "path": path,
        "query": "",
        "ts": ts,
        "nonce": nonce,
        "body_utf8_text": "",
        "body_hex": body_bytes.hex(),
        "canonical_message_hex": message.hex(),
        "signature_hex": sign_hex(signing_key, message),
    }


def main() -> None:
    keypairs = [make_keypair(seed) for seed in SEED_HEXES]

    per_keypair = []
    for kp in keypairs:
        signing_key = SigningKey(bytes.fromhex(kp["seed_hex"]))
        per_keypair.append(
            {
                "seed_hex": kp["seed_hex"],
                "pubkey_hex": kp["pubkey_hex"],
                "receipt_cases": build_receipt_cases(signing_key),
                "registration_sample": build_registration_sample(signing_key, kp["pubkey_hex"]),
                "release_sample": build_release_sample(signing_key),
                "signed_request_sample": build_signed_request_sample(signing_key),
                "signed_request_sample_no_query": build_signed_request_sample_no_query(signing_key),
            }
        )

    dotonef_cases = [
        {"input": x, "expected": format(x, ".1f")} for x in DOTONEF_CASES
    ]

    fixture = {
        "_generated_by": "scripts/golden_vectors.py",
        "_note": (
            "Signature-byte parity vectors for cloud/ (Cloudflare Workers port). "
            "Regenerate with .venv/Scripts/python.exe scripts/golden_vectors.py "
            "whenever a canonical-string format changes, and re-commit."
        ),
        "keypairs": per_keypair,
        "dotonef_cases": dotonef_cases,
    }

    out_dir = os.path.dirname(FIXTURE_PATH)
    os.makedirs(out_dir, exist_ok=True)
    with open(FIXTURE_PATH, "w", encoding="utf-8") as f:
        json.dump(fixture, f, indent=2, ensure_ascii=False)
        f.write("\n")

    print(f"Wrote {os.path.abspath(FIXTURE_PATH)}", file=sys.stderr)


if __name__ == "__main__":
    main()
