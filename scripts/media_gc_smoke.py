from __future__ import annotations

import asyncio
import shutil
import sqlite3
import tempfile
import time
from pathlib import Path
from types import SimpleNamespace

import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from storage import ArchiveConfig, ChatArchiveStore


class DummyMedia:
    type = "image"

    def __init__(self, path: Path):
        self.data = {"file": str(path), "name": path.name, "mime": "image/png"}

    def toDict(self):
        return {"type": "image", "data": dict(self.data)}


class DummyEvent:
    def __init__(self, message_id: str, text: str, *, media_path: Path):
        created_at = int(time.time())
        self.message_id = message_id
        self.message_str = text
        self.message_type = "private"
        self.unified_msg_origin = "media-gc:test:user"
        self.platform_meta = SimpleNamespace(name="media-gc")
        self.message_obj = SimpleNamespace(
            message=[DummyMedia(media_path)],
            raw_message={"text": text},
            sender=SimpleNamespace(user_id="user", nickname="Media User"),
            timestamp=created_at,
            message_id=message_id,
            session_id="media-gc-session",
            message_type="private",
        )

    def get_sender_id(self):
        return "user"

    def get_sender_name(self):
        return "Media User"

    def get_self_id(self):
        return "bot"


def message_uid(data_dir: Path, message_id: str) -> str:
    with sqlite3.connect(data_dir / "chat_archive.sqlite3") as conn:
        conn.row_factory = sqlite3.Row
        row = conn.execute(
            "SELECT message_uid FROM messages WHERE message_id = ?", (message_id,)
        ).fetchone()
    assert row is not None, message_id
    return str(row["message_uid"])


def blob_row(data_dir: Path) -> sqlite3.Row:
    with sqlite3.connect(data_dir / "chat_archive.sqlite3") as conn:
        conn.row_factory = sqlite3.Row
        row = conn.execute("SELECT * FROM media_blobs").fetchone()
    assert row is not None
    return row


async def main() -> None:
    root = Path(tempfile.mkdtemp(prefix="media_gc_"))
    try:
        source_dir = root / "source"
        source_dir.mkdir(parents=True, exist_ok=True)
        source = source_dir / "shared.png"
        source.write_bytes(b"shared-media")
        data_dir = root / "data"
        store = ChatArchiveStore(
            data_dir,
            ArchiveConfig(
                batch_size=20,
                flush_interval_seconds=3600,
                durable_write=True,
                download_remote_media=False,
            ),
        )

        await store.store_event(
            DummyEvent("media-gc-1", "first reference", media_path=source)
        )
        await store.store_event(
            DummyEvent("media-gc-2", "second reference", media_path=source)
        )
        await store.flush_pending()

        blob = blob_row(data_dir)
        blob_path = Path(str(blob["local_path"]))
        assert int(blob["ref_count"]) == 2, dict(blob)
        assert blob_path.exists(), blob_path

        assert store.delete_message(message_uid(data_dir, "media-gc-1"))
        gc_result = store.media_gc()
        assert gc_result["fixed_ref_counts"] == 0, gc_result
        assert blob_path.exists(), "shared media was removed while still referenced"
        assert int(blob_row(data_dir)["ref_count"]) == 1

        assert store.delete_message(message_uid(data_dir, "media-gc-2"))
        gc_result = store.media_gc()
        assert gc_result["removed_blob_rows"] == 0, gc_result
        assert not blob_path.exists(), "unreferenced media file was not removed"

        orphan = data_dir / "media" / "image" / "orphan.bin"
        orphan.parent.mkdir(parents=True, exist_ok=True)
        orphan.write_bytes(b"orphan")
        gc_result = store.media_gc()
        assert gc_result["orphan_files"] == 1, gc_result
        assert gc_result["removed_files"] == 1, gc_result
        assert not orphan.exists(), orphan

        await store.close()
        print("media gc smoke OK")
    finally:
        shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    asyncio.run(main())
