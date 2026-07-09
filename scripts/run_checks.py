from __future__ import annotations

import subprocess
import sys


CHECKS = [
    [sys.executable, "scripts/check_plugin_package.py"],
    [sys.executable, "-m", "ruff", "check", "."],
    [sys.executable, "-m", "ruff", "format", "--check", "."],
    [
        sys.executable,
        "-m",
        "py_compile",
        "archive_config.py",
        "main.py",
        "storage.py",
        "wal.py",
        "web.py",
        "tests/storage_smoke.py",
        "tests/test_pending_replay.py",
        "tests/test_reliability_stage1.py",
        "tests/test_media_elements.py",
        "tests/test_search_export_stage3.py",
        "tests/test_experience_stage4.py",
        "tests/test_frontend_fix_verification.py",
        "tests/test_frontend_logic.py",
        "scripts/forward_cache_smoke.py",
    ],
    [sys.executable, "tests/storage_smoke.py"],
    [sys.executable, "tests/test_pending_replay.py"],
    [sys.executable, "tests/test_reliability_stage1.py"],
    [sys.executable, "tests/test_media_elements.py"],
    [sys.executable, "tests/test_search_export_stage3.py"],
    [sys.executable, "tests/test_experience_stage4.py"],
    [sys.executable, "tests/test_frontend_fix_verification.py"],
    [sys.executable, "tests/test_frontend_logic.py"],
    ["node", "scripts/onebot_render_smoke.js"],
    [sys.executable, "scripts/forward_cache_smoke.py"],
]


def main() -> int:
    for command in CHECKS:
        print(f"\n$ {' '.join(command)}", flush=True)
        subprocess.run(command, check=True)
    print("\nAll checks passed.", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
