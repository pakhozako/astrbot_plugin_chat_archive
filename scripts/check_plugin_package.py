from __future__ import annotations

import ast
import json
import re
import struct
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
REQUIRED_METADATA = {
    "name",
    "display_name",
    "short_desc",
    "desc",
    "help",
    "version",
    "author",
    "repo",
    "support_platforms",
    "astrbot_version",
}
RUNTIME_PYTHON = {
    "archive_config.py",
    "main.py",
    "schema.py",
    "storage.py",
    "wal.py",
    "web.py",
}
LOCAL_IMPORTS = {
    "archive_config",
    "schema",
    "storage",
    "wal",
    "web",
}
STDLIB_IMPORTS = {
    "__future__",
    "asyncio",
    "base64",
    "binascii",
    "collections",
    "contextlib",
    "dataclasses",
    "hashlib",
    "html",
    "inspect",
    "ipaddress",
    "json",
    "logging",
    "mimetypes",
    "os",
    "pathlib",
    "re",
    "shutil",
    "socket",
    "sqlite3",
    "time",
    "typing",
    "urllib",
    "uuid",
    "zipfile",
}
FORBIDDEN_TRACKED_PATHS = (".github/workflows", "tests")


def main() -> int:
    failures: list[str] = []
    metadata = read_simple_yaml(ROOT / "metadata.yaml")
    requirements = read_requirements(ROOT / "requirements.txt")

    missing = sorted(REQUIRED_METADATA - metadata.keys())
    if missing:
        failures.append(f"metadata.yaml missing required fields: {', '.join(missing)}")

    if metadata.get("name") != "astrbot_plugin_chat_archive":
        failures.append("metadata.yaml name must be astrbot_plugin_chat_archive")
    if not str(metadata.get("display_name") or "").strip():
        failures.append("metadata.yaml display_name must be non-empty")
    if not str(metadata.get("short_desc") or "").strip():
        failures.append("metadata.yaml short_desc must be non-empty")
    if not isinstance(metadata.get("support_platforms"), list):
        failures.append("metadata.yaml support_platforms must be a list")
    elif "aiocqhttp" not in metadata["support_platforms"]:
        failures.append("metadata.yaml support_platforms should include aiocqhttp")
    astrbot_version = str(metadata.get("astrbot_version") or "")
    if not re.fullmatch(r">=\d+(?:\.\d+){1,2},<\d+(?:\.\d+){0,2}", astrbot_version):
        failures.append(
            "metadata.yaml astrbot_version must be a bounded PEP 440 range like >=4.16,<5"
        )
    main_constants = module_string_constants(ROOT / "main.py")
    if main_constants.get("PLUGIN_NAME") != metadata.get("name"):
        failures.append("main.py PLUGIN_NAME must match metadata.yaml name")
    if main_constants.get("PLUGIN_VERSION") != metadata.get("version"):
        failures.append("main.py PLUGIN_VERSION must match metadata.yaml version")
    config_schema = json.loads((ROOT / "_conf_schema.json").read_text(encoding="utf-8"))
    config_schema_keys = {
        key for key, value in config_schema.items() if isinstance(value, dict)
    }
    runtime_config_keys = config_get_keys(ROOT / "main.py")
    missing_config_keys = sorted(runtime_config_keys - config_schema_keys)
    if missing_config_keys:
        failures.append(
            "_conf_schema.json missing runtime config keys: "
            + ", ".join(missing_config_keys)
        )
    unused_config_keys = sorted(config_schema_keys - runtime_config_keys)
    if unused_config_keys:
        failures.append(
            "_conf_schema.json lists config keys not read by runtime: "
            + ", ".join(unused_config_keys)
        )

    logo_path = ROOT / "logo.png"
    if not logo_path.exists():
        failures.append("logo.png is missing")
    else:
        try:
            width, height = png_size(logo_path)
            if (width, height) != (256, 256):
                failures.append(f"logo.png must be 256x256, got {width}x{height}")
        except ValueError as exc:
            failures.append(str(exc))

    imports = runtime_imports()
    if "requests" in imports:
        failures.append("runtime code imports requests; use httpx/aiohttp instead")
    third_party = {
        name
        for name in imports
        if name not in STDLIB_IMPORTS and name not in LOCAL_IMPORTS | {"astrbot"}
    }
    missing_requirements = sorted(
        name for name in third_party if requirement_name(name) not in requirements
    )
    if missing_requirements:
        failures.append(
            "requirements.txt missing runtime dependencies: "
            + ", ".join(missing_requirements)
        )
    unused_requirements = sorted(
        dep
        for dep in requirements
        if dep not in {requirement_name(name) for name in third_party}
    )
    if unused_requirements:
        failures.append(
            "requirements.txt lists dependencies not imported by runtime code: "
            + ", ".join(unused_requirements)
        )

    main_text = (ROOT / "main.py").read_text(encoding="utf-8")
    storage_text = (ROOT / "storage.py").read_text(encoding="utf-8")
    if "StarTools.get_data_dir(PLUGIN_NAME)" not in main_text:
        failures.append("main.py must use StarTools.get_data_dir(PLUGIN_NAME)")
    if 'self.data_dir / "pending.jsonl"' not in storage_text:
        failures.append("storage.py pending WAL must be rooted under self.data_dir")
    if 'self.data_dir / "chat_archive.sqlite3"' not in storage_text:
        failures.append("storage.py sqlite database must be rooted under self.data_dir")
    forbidden_tracked = git_tracked_paths_under(FORBIDDEN_TRACKED_PATHS)
    if forbidden_tracked:
        failures.append(
            "publish repository must not track these local-only paths: "
            + ", ".join(forbidden_tracked)
        )

    if failures:
        for failure in failures:
            print(f"[FAIL] {failure}")
        return 1
    print("plugin package checks OK")
    return 0


def read_simple_yaml(path: Path) -> dict[str, object]:
    result: dict[str, object] = {}
    current_key = ""
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.rstrip()
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if not line.startswith(" ") and ":" in line:
            key, raw_value = line.split(":", 1)
            current_key = key.strip()
            value = raw_value.strip()
            if value:
                result[current_key] = value.strip('"')
            else:
                result[current_key] = []
            continue
        if current_key and line.strip().startswith("- "):
            value = line.strip()[2:].strip().strip('"')
            items = result.setdefault(current_key, [])
            if isinstance(items, list):
                items.append(value)
    return result


def read_requirements(path: Path) -> set[str]:
    requirements: set[str] = set()
    for line in path.read_text(encoding="utf-8").splitlines():
        value = line.split("#", 1)[0].strip()
        if not value:
            continue
        requirements.add(re.split(r"[<>=!~\[]", value, maxsplit=1)[0].lower())
    return requirements


def runtime_imports() -> set[str]:
    names: set[str] = set()
    for filename in RUNTIME_PYTHON:
        tree = ast.parse((ROOT / filename).read_text(encoding="utf-8"), filename)
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    names.add(alias.name.split(".", 1)[0])
            elif isinstance(node, ast.ImportFrom) and node.module:
                names.add(node.module.split(".", 1)[0])
    return names


def module_string_constants(path: Path) -> dict[str, str]:
    constants: dict[str, str] = {}
    tree = ast.parse(path.read_text(encoding="utf-8"), path)
    for node in tree.body:
        if not isinstance(node, ast.Assign) or len(node.targets) != 1:
            continue
        target = node.targets[0]
        if not isinstance(target, ast.Name):
            continue
        value = node.value
        if isinstance(value, ast.Constant) and isinstance(value.value, str):
            constants[target.id] = value.value
    return constants


def config_get_keys(path: Path) -> set[str]:
    keys: set[str] = set()
    tree = ast.parse(path.read_text(encoding="utf-8"), path)
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if not isinstance(func, ast.Attribute) or func.attr != "get":
            continue
        if not node.args:
            continue
        owner = func.value
        is_config = isinstance(owner, ast.Name) and owner.id == "config"
        is_self_config = (
            isinstance(owner, ast.Attribute)
            and owner.attr == "config"
            and isinstance(owner.value, ast.Name)
            and owner.value.id == "self"
        )
        key_node = node.args[0]
        if (is_config or is_self_config) and isinstance(key_node, ast.Constant):
            if isinstance(key_node.value, str):
                keys.add(key_node.value)
    return keys


def git_tracked_paths_under(prefixes: tuple[str, ...]) -> list[str]:
    try:
        result = subprocess.run(
            ["git", "-C", str(ROOT), "ls-files", "--", *prefixes],
            check=True,
            capture_output=True,
            text=True,
        )
    except (OSError, subprocess.CalledProcessError):
        return []
    return sorted(line.strip() for line in result.stdout.splitlines() if line.strip())


def requirement_name(import_name: str) -> str:
    return import_name.lower().replace("_", "-")


def png_size(path: Path) -> tuple[int, int]:
    data = path.read_bytes()
    if len(data) < 24 or data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("logo.png is not a valid PNG")
    return struct.unpack(">II", data[16:24])


if __name__ == "__main__":
    raise SystemExit(main())
