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
        self.data = {
            "file": str(path),
            "name": path.name,
            "mime": "image/png",
        }

    def toDict(self):
        return {"type": "image", "data": dict(self.data)}


class DummyEvent:
    def __init__(
        self,
        message_id: str,
        text: str,
        *,
        created_at: int | None = None,
        media_path: Path | None = None,
    ):
        created_at = created_at or int(time.time())
        self.message_id = message_id
        self.message_str = text
        self.message_type = "private"
        self.unified_msg_origin = "reliability:test:user"
        self.platform_meta = SimpleNamespace(name="reliability")
        self.message_obj = SimpleNamespace(
            message=[DummyMedia(media_path)] if media_path else [],
            raw_message={"text": text},
            sender=SimpleNamespace(user_id="user", nickname="Reliability User"),
            timestamp=created_at,
            message_id=message_id,
            session_id="reliability-session",
            message_type="private",
        )

    def get_sender_id(self):
        return "user"

    def get_sender_name(self):
        return "Reliability User"

    def get_self_id(self):
        return "bot"


def count_messages(data_dir: Path) -> int:
    with sqlite3.connect(data_dir / "chat_archive.sqlite3") as conn:
        return int(conn.execute("SELECT count(*) FROM messages").fetchone()[0])


def make_png(path: Path, content: bytes = b"same-image") -> Path:
    path.write_bytes(content)
    return path


async def make_store(data_dir: Path) -> ChatArchiveStore:
    return ChatArchiveStore(
        data_dir,
        ArchiveConfig(batch_size=20, flush_interval_seconds=3600, durable_write=True),
    )


async def test_integrity_check_and_optimize(root: Path) -> None:
    data_dir = root / "integrity"
    store = await make_store(data_dir)
    await store.store_event(DummyEvent("ok-1", "integrity message"))
    await store.flush_pending()

    schema = store.schema_info()
    assert schema["version"] == schema["expected_version"] == 1, schema
    assert schema["up_to_date"] is True, schema
    assert [item["version"] for item in schema["migrations"]] == [1], schema
    with sqlite3.connect(data_dir / "chat_archive.sqlite3") as conn:
        assert int(conn.execute("PRAGMA user_version").fetchone()[0]) == 1

    result = store.integrity_check()
    assert result["ok"], result
    assert result["sqlite_integrity"].lower() == "ok", result
    assert result["pending_lines"] == 0, result
    assert result["schema_version"] == result["expected_schema_version"] == 1, result
    stats = store.stats()
    assert stats["schema_version"] == stats["expected_schema_version"] == 1, stats

    optimized = store.optimize()
    assert optimized["analyze"] is True, optimized
    assert optimized["optimize"] is True, optimized
    await store.close()


async def test_media_gc_ref_count_and_orphan_file(root: Path) -> None:
    data_dir = root / "media_gc"
    source_dir = root / "sources"
    source_dir.mkdir(parents=True, exist_ok=True)
    image = make_png(source_dir / "shared.png")
    store = await make_store(data_dir)

    await store.store_event(DummyEvent("media-1", "first media", media_path=image))
    await store.store_event(DummyEvent("media-2", "second media", media_path=image))
    await store.flush_pending()

    with sqlite3.connect(data_dir / "chat_archive.sqlite3") as conn:
        conn.row_factory = sqlite3.Row
        blob = conn.execute("SELECT * FROM media_blobs").fetchone()
        assert blob is not None
        assert int(blob["ref_count"]) == 2
        blob_path = Path(blob["local_path"])
        assert blob_path.exists()
        uid = conn.execute(
            "SELECT message_uid FROM messages WHERE message_id = ?", ("media-1",)
        ).fetchone()["message_uid"]

    assert store.delete_message(uid)
    gc_result = store.media_gc()
    assert gc_result["fixed_ref_counts"] == 0, gc_result
    assert blob_path.exists(), "shared media was deleted while still referenced"

    with sqlite3.connect(data_dir / "chat_archive.sqlite3") as conn:
        conn.row_factory = sqlite3.Row
        blob = conn.execute("SELECT * FROM media_blobs").fetchone()
        assert int(blob["ref_count"]) == 1
        uid = conn.execute(
            "SELECT message_uid FROM messages WHERE message_id = ?", ("media-2",)
        ).fetchone()["message_uid"]

    assert store.delete_message(uid)
    gc_result = store.media_gc()
    assert not blob_path.exists(), "unreferenced media file was not deleted"
    assert gc_result["removed_blob_rows"] == 0, gc_result

    orphan = data_dir / "media" / "image" / "orphan.bin"
    orphan.parent.mkdir(parents=True, exist_ok=True)
    orphan.write_bytes(b"orphan")
    gc_result = store.media_gc()
    assert gc_result["orphan_files"] == 1, gc_result
    assert gc_result["removed_files"] == 1, gc_result
    assert not orphan.exists()
    await store.close()


async def test_export_snapshot_excludes_concurrent_insert(root: Path) -> None:
    data_dir = root / "export_snapshot"
    store = await make_store(data_dir)
    await store.store_event(DummyEvent("export-1", "before export"))
    await store.flush_pending()

    def write_after_snapshot():
        with sqlite3.connect(data_dir / "chat_archive.sqlite3") as conn:
            now = int(time.time())
            conn.execute(
                """
                INSERT INTO messages (
                    message_uid, platform, message_type, umo, session_id, group_id,
                    sender_id, sender_name, self_id, message_id, text, raw_json,
                    components_json, media_count, created_at, timestamp, stored_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    "manual-after-snapshot",
                    "reliability",
                    "private",
                    "reliability:test:user",
                    "reliability-session",
                    "",
                    "user",
                    "Reliability User",
                    "bot",
                    "export-2",
                    "after export snapshot",
                    "{}",
                    "[]",
                    0,
                    now,
                    now,
                    now,
                ),
            )
            conn.commit()

    output = store.export_json(after_snapshot=write_after_snapshot)
    text = output.read_text(encoding="utf-8")
    assert "before export" in text
    assert "after export snapshot" not in text
    assert count_messages(data_dir) == 2
    await store.close()


async def main() -> None:
    root = Path(tempfile.mkdtemp(prefix="reliability_stage1_"))
    try:
        await test_integrity_check_and_optimize(root)
        await test_media_gc_ref_count_and_orphan_file(root)
        await test_export_snapshot_excludes_concurrent_insert(root)
        print("reliability stage1 tests OK")
    finally:
        shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    asyncio.run(main())
