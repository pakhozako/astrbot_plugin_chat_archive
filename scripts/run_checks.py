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
        "schema.py",
        "storage.py",
        "wal.py",
        "web.py",
        "scripts/export_safety_smoke.py",
        "scripts/experience_smoke.py",
        "scripts/forward_cache_smoke.py",
        "scripts/media_gc_smoke.py",
        "scripts/search_export_smoke.py",
        "scripts/wal_reliability_smoke.py",
    ],
    ["node", "scripts/onebot_render_smoke.js"],
    [sys.executable, "scripts/export_safety_smoke.py"],
    [sys.executable, "scripts/experience_smoke.py"],
    [sys.executable, "scripts/forward_cache_smoke.py"],
    [sys.executable, "scripts/media_gc_smoke.py"],
    [sys.executable, "scripts/search_export_smoke.py"],
    [sys.executable, "scripts/wal_reliability_smoke.py"],
]


def main() -> int:
    for command in CHECKS:
        print(f"\n$ {' '.join(command)}", flush=True)
        subprocess.run(command, check=True)
    print("\nAll checks passed.", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
