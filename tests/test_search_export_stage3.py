from __future__ import annotations

import asyncio
import json
import shutil
import sqlite3
import tempfile
import time
import zipfile
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
    def __init__(
        self,
        message_id: str,
        text: str,
        *,
        created_at: int,
        sender_id: str = "alice",
        sender_name: str = "Alice",
        message_type: str = "private",
        media_path: Path | None = None,
    ):
        self.message_id = message_id
        self.message_str = text
        self.message_type = message_type
        self.unified_msg_origin = "stage3:test:room"
        self.platform_meta = SimpleNamespace(name="stage3")
        self.message_obj = SimpleNamespace(
            message=[DummyMedia(media_path)] if media_path else [],
            raw_message={"text": text},
            sender=SimpleNamespace(user_id=sender_id, nickname=sender_name),
            timestamp=created_at,
            message_id=message_id,
            session_id="stage3-session",
            message_type=message_type,
        )
        self._sender_id = sender_id
        self._sender_name = sender_name

    def get_sender_id(self):
        return self._sender_id

    def get_sender_name(self):
        return self._sender_name

    def get_self_id(self):
        return "bot"


def make_png(path: Path) -> Path:
    path.write_bytes(b"stage3-image")
    return path


async def make_store(data_dir: Path) -> ChatArchiveStore:
    return ChatArchiveStore(
        data_dir,
        ArchiveConfig(batch_size=20, flush_interval_seconds=3600, durable_write=True),
    )


async def seed_store(root: Path) -> ChatArchiveStore:
    data_dir = root / "data"
    src_dir = root / "src"
    src_dir.mkdir(parents=True, exist_ok=True)
    image = make_png(src_dir / "photo.png")
    now = int(time.time())
    store = await make_store(data_dir)
    await store.store_event(
        DummyEvent("s1", "alpha searchable keyword", created_at=now - 300, sender_id="alice", sender_name="Alice")
    )
    await store.store_event(
        DummyEvent("s2", "beta media keyword", created_at=now - 200, sender_id="bob", sender_name="Bob", media_path=image)
    )
    await store.store_event(
        DummyEvent("s3", "gamma group keyword", created_at=now - 100, sender_id="alice", sender_name="Alice", message_type="group")
    )
    await store.flush_pending()
    return store


async def test_fts_and_filters(root: Path) -> None:
    store = await seed_store(root / "fts")
    result = store.list_messages(q="searchable", limit=10)
    assert [item["message_id"] for item in result["items"]] == ["s1"], result

    result = store.list_messages(sender="bob", limit=10)
    assert [item["message_id"] for item in result["items"]] == ["s2"], result

    result = store.list_messages(message_type="group", limit=10)
    assert [item["message_id"] for item in result["items"]] == ["s3"], result

    result = store.list_messages(media_kind="image", limit=10)
    assert [item["message_id"] for item in result["items"]] == ["s2"], result

    now = int(time.time())
    result = store.list_messages(start_ts=now - 250, end_ts=now - 50, limit=10)
    assert [item["message_id"] for item in result["items"]] == ["s2", "s3"], result

    suggestions = store.search_suggestions()
    assert any(row["sender_name"] == "Alice" for row in suggestions["senders"]), suggestions
    assert any(row["value"] == "group" for row in suggestions["message_types"]), suggestions
    assert any(row["value"] == "image" for row in suggestions["media_kinds"]), suggestions
    await store.close()


async def test_export_formats(root: Path) -> None:
    store = await seed_store(root / "exports")
    json_path = store.export_archive(format="json")
    md_path = store.export_archive(format="markdown")
    txt_path = store.export_archive(format="txt")
    html_path = store.export_archive(format="html")
    zip_path = store.export_archive(format="zip", include_media=True)

    exported = json.loads(json_path.read_text(encoding="utf-8"))
    assert len(exported) == 3
    assert "alpha searchable keyword" in md_path.read_text(encoding="utf-8")
    assert "beta media keyword" in txt_path.read_text(encoding="utf-8")
    assert "<article" in html_path.read_text(encoding="utf-8")

    with zipfile.ZipFile(zip_path) as zf:
        names = set(zf.namelist())
        assert "messages.json" in names
        assert "messages.md" in names
        assert any(name.startswith("media/") and name.endswith(".png") for name in names), names
    await store.close()


async def test_export_filters(root: Path) -> None:
    store = await seed_store(root / "filtered_export")
    path = store.export_archive(format="json", sender="bob")
    exported = json.loads(path.read_text(encoding="utf-8"))
    assert [item["message_id"] for item in exported] == ["s2"], exported
    path = store.export_archive(format="json", q="gamma")
    exported = json.loads(path.read_text(encoding="utf-8"))
    assert [item["message_id"] for item in exported] == ["s3"], exported
    await store.close()


async def main() -> None:
    root = Path(tempfile.mkdtemp(prefix="stage3_search_export_"))
    try:
        await test_fts_and_filters(root)
        await test_export_formats(root)
        await test_export_filters(root)
        print("search/export stage3 tests OK")
    finally:
        shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    asyncio.run(main())
