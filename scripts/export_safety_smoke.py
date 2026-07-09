from __future__ import annotations

import shutil
import tempfile
from pathlib import Path

import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from storage import ArchiveConfig, ChatArchiveStore


def assert_under(path: Path, root: Path) -> None:
    resolved = path.resolve()
    resolved_root = root.resolve()
    assert resolved != resolved_root and resolved_root in resolved.parents, (
        f"{resolved} is outside {resolved_root}"
    )


def assert_rejected(callable_obj, *args, **kwargs) -> None:
    try:
        callable_obj(*args, **kwargs)
    except ValueError:
        return
    raise AssertionError("unsafe export output_name was accepted")


def main() -> None:
    root = Path(tempfile.mkdtemp(prefix="export_safety_"))
    try:
        store = ChatArchiveStore(
            root / "data",
            ArchiveConfig(
                capture_media_files=False,
                download_remote_media=False,
                durable_write=True,
            ),
        )
        export_root = store.export_dir

        archive_path = store.export_archive(format="json", output_name="custom.json")
        assert archive_path.name == "custom.json", archive_path
        assert archive_path.exists(), archive_path
        assert_under(archive_path, export_root)

        json_path = store.export_json(output_name="snapshot.json")
        assert json_path.name == "snapshot.json", json_path
        assert json_path.exists(), json_path
        assert_under(json_path, export_root)

        for name in [
            "../escape.json",
            "..\\escape.json",
            "C:\\escape.json",
            "unsafe:name.json",
            "bad\x00name.json",
            "",
        ]:
            if name:
                assert_rejected(store.export_archive, format="json", output_name=name)
                assert_rejected(store.export_json, output_name=name)

        print("export safety smoke OK")
    finally:
        shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    main()
