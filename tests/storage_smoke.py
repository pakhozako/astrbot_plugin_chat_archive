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


class DummyEvent:
    def __init__(self, message_id: str, text: str, created_at: int | None = None):
        created_at = created_at or int(time.time())
        self.message_id = message_id
        self.message_str = text
        self.message_type = "private"
        self.unified_msg_origin = "smoke:private:user"
        self.platform_meta = SimpleNamespace(name="smoke")
        self.message_obj = SimpleNamespace(
            message=[],
            raw_message={"text": text},
            sender=SimpleNamespace(user_id="user", nickname="Smoke User"),
            timestamp=created_at,
            message_id=message_id,
            session_id="smoke-session",
            message_type="private",
        )

    def get_sender_id(self):
        return "user"

    def get_sender_name(self):
        return "Smoke User"

    def get_self_id(self):
        return "bot"


def count_messages(data_dir: Path) -> int:
    with sqlite3.connect(data_dir / "chat_archive.sqlite3") as conn:
        return int(conn.execute("SELECT count(*) FROM messages").fetchone()[0])


async def test_pending_replay(data_dir: Path) -> None:
    store = ChatArchiveStore(
        data_dir,
        ArchiveConfig(batch_size=20, flush_interval_seconds=60, durable_write=True),
    )
    await store.store_event(DummyEvent("pending-1", "pending survives forced kill"))
    await store.store_event(DummyEvent("pending-2", "消息 % 测试 _ pending replay"))
    assert store.pending_path.exists(), "pending journal was not written"
    assert count_messages(data_dir) == 0, "messages flushed before replay test"

    restarted = ChatArchiveStore(
        data_dir,
        ArchiveConfig(batch_size=20, flush_interval_seconds=60, durable_write=True),
    )
    replay = await restarted.replay_pending_log()
    assert replay["attempted"] == 2, replay
    assert replay["replayed"] == 2, replay
    assert replay["failed"] == 0, replay
    assert count_messages(data_dir) == 2, "pending replay did not write messages"
    assert not restarted.pending_path.exists(), "pending journal was not archived"
    assert list(data_dir.glob("pending.*.replayed.jsonl")), "pending replay archive missing"
    await restarted.close()


async def test_flush_clears_pending(data_dir: Path) -> None:
    store = ChatArchiveStore(
        data_dir,
        ArchiveConfig(batch_size=20, flush_interval_seconds=60, durable_write=True),
    )
    await store.store_event(DummyEvent("flush-1", "flush clears pending"))
    assert store.pending_path.exists(), "pending journal was not written before flush"
    written = await store.flush_pending()
    assert written == 1, written
    assert count_messages(data_dir) == 1, "flush did not write message"
    assert not store.pending_path.exists(), "pending journal was not cleared after flush"
    await store.close()


async def main() -> None:
    root = Path(tempfile.mkdtemp(prefix="chat_archive_smoke_"))
    try:
        await test_pending_replay(root / "pending_replay")
        await test_flush_clears_pending(root / "flush_clear")
        print("storage smoke OK")
    finally:
        shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    asyncio.run(main())
