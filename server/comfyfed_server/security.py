"""Password hashing (argon2) and platform Ed25519 key management."""

from __future__ import annotations

import os

from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError
from nacl.signing import SigningKey, VerifyKey

_hasher = PasswordHasher()

_KEY_SUBDIR = "keys"
_KEY_FILENAME = "platform.key"


def hash_password(pw: str) -> str:
    return _hasher.hash(pw)


def verify_password(pw: str, hashed: str) -> bool:
    try:
        return _hasher.verify(hashed, pw)
    except VerifyMismatchError:
        return False


def load_platform_keys(data_dir: str) -> tuple[SigningKey, VerifyKey]:
    """Load the platform's Ed25519 signing key, generating and persisting it on first use.

    Stored as a hex-encoded 32-byte seed at <data_dir>/keys/platform.key.
    """
    key_dir = os.path.join(data_dir, _KEY_SUBDIR)
    os.makedirs(key_dir, exist_ok=True)
    key_path = os.path.join(key_dir, _KEY_FILENAME)

    if os.path.exists(key_path):
        with open(key_path, "r", encoding="utf-8") as f:
            seed_hex = f.read().strip()
        signing_key = SigningKey(bytes.fromhex(seed_hex))
    else:
        signing_key = SigningKey.generate()
        seed_hex = bytes(signing_key).hex()
        with open(key_path, "w", encoding="utf-8") as f:
            f.write(seed_hex)
        try:
            os.chmod(key_path, 0o600)
        except OSError:
            pass

    return signing_key, signing_key.verify_key
