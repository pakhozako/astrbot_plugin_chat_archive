from __future__ import annotations

import asyncio
import logging
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
        self.unified_msg_origin = "pending:test:user"
        self.platform_meta = SimpleNamespace(name="pending-test")
        self.message_obj = SimpleNamespace(
            message=[],
            raw_message={"text": text},
            sender=SimpleNamespace(user_id="user", nickname="Pending User"),
            timestamp=created_at,
            message_id=message_id,
            session_id="pending-session",
            message_type="private",
        )

    def get_sender_id(self):
        return "user"

    def get_sender_name(self):
        return "Pending User"

    def get_self_id(self):
        return "bot"


def count_messages(data_dir: Path) -> int:
    with sqlite3.connect(data_dir / "chat_archive.sqlite3") as conn:
        return int(conn.execute("SELECT count(*) FROM messages").fetchone()[0])


def pending_lines(store: ChatArchiveStore) -> int:
    if not store.pending_path.exists():
        return 0
    return len(
        [
            line
            for line in store.pending_path.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
    )


async def make_store(
    data_dir: Path, *, batch_size: int = 20, interval: float = 3600
) -> ChatArchiveStore:
    return ChatArchiveStore(
        data_dir,
        ArchiveConfig(
            batch_size=batch_size, flush_interval_seconds=interval, durable_write=True
        ),
    )


async def test_append_restart_replay(root: Path) -> None:
    data_dir = root / "append_restart_replay"
    store = await make_store(data_dir)
    await store.store_event(DummyEvent("pending-1", "pending survives restart"))
    await store.store_event(DummyEvent("pending-2", "消息 % 测试 _ durable queue"))
    assert pending_lines(store) == 2
    assert count_messages(data_dir) == 0

    restarted = await make_store(data_dir)
    replay = await restarted.replay_pending()
    assert replay["attempted"] == 2, replay
    assert replay["replayed"] == 2, replay
    assert replay["failed"] == 0, replay
    assert count_messages(data_dir) == 2
    assert pending_lines(restarted) == 0
    assert list(data_dir.glob("pending.*.replayed.jsonl"))
    await restarted.close()


async def test_flush_success_clears_pending(root: Path) -> None:
    data_dir = root / "flush_success_clears_pending"
    store = await make_store(data_dir)
    await store.store_event(DummyEvent("flush-1", "flush clears pending"))
    assert pending_lines(store) == 1
    written = await store.flush_pending()
    assert written == 1, written
    assert count_messages(data_dir) == 1
    assert pending_lines(store) == 0
    await store.close()


async def test_sqlite_failure_keeps_pending_then_recovers(root: Path) -> None:
    data_dir = root / "sqlite_failure_keeps_pending"
    store = await make_store(data_dir)
    await store.store_event(DummyEvent("fail-1", "pending survives sqlite failure"))
    original_write_entries = store._write_entries

    def fail_write(entries):
        raise sqlite3.OperationalError("injected write failure")

    store._write_entries = fail_write
    storage_logger = logging.getLogger("storage")
    storage_logger.disabled = True
    try:
        written = await store.flush_pending()
    finally:
        storage_logger.disabled = False
    assert written == 0
    assert count_messages(data_dir) == 0
    assert pending_lines(store) == 1
    store._write_entries = original_write_entries

    restarted = await make_store(data_dir)
    replay = await restarted.replay_pending()
    assert replay["attempted"] == 1, replay
    assert replay["replayed"] == 1, replay
    assert replay["failed"] == 0, replay
    assert count_messages(data_dir) == 1
    assert pending_lines(restarted) == 0
    await restarted.close()


async def test_duplicate_message_uid_is_idempotent(root: Path) -> None:
    data_dir = root / "duplicate_message_uid"
    store = await make_store(data_dir)
    event = DummyEvent("dup-1", "duplicate message uid")
    await store.store_event(event)
    await store.flush_pending()
    assert count_messages(data_dir) == 1

    await store.store_event(event)
    assert pending_lines(store) == 1
    await store.flush_pending()
    assert count_messages(data_dir) == 1
    assert pending_lines(store) == 0

    await store.store_event(event)
    restarted = await make_store(data_dir)
    replay = await restarted.replay_pending()
    assert replay["attempted"] == 1, replay
    assert replay["replayed"] == 0, replay
    assert replay["failed"] == 0, replay
    assert count_messages(data_dir) == 1
    assert pending_lines(restarted) == 0
    await restarted.close()


async def test_corrupt_pending_line_is_archived(root: Path) -> None:
    data_dir = root / "corrupt_pending_line"
    store = await make_store(data_dir)
    await store.store_event(DummyEvent("corrupt-1", "valid line survives corrupt wal"))
    with store.pending_path.open("a", encoding="utf-8") as f:
        f.write('{"payload":')
    restarted = await make_store(data_dir)
    replay = await restarted.replay_pending()
    assert replay["attempted"] == 1, replay
    assert replay["replayed"] == 1, replay
    assert replay["failed"] == 0, replay
    assert replay["corrupt"] == 1, replay
    assert count_messages(data_dir) == 1
    assert pending_lines(restarted) == 0
    corrupt_files = list(data_dir.glob("pending.*.corrupt.jsonl"))
    assert corrupt_files, "corrupt pending archive missing"
    assert "valid line survives corrupt wal" not in corrupt_files[0].read_text(
        encoding="utf-8"
    )
    await restarted.close()


async def main() -> None:
    root = Path(tempfile.mkdtemp(prefix="pending_replay_tests_"))
    try:
        await test_append_restart_replay(root)
        await test_flush_success_clears_pending(root)
        await test_sqlite_failure_keeps_pending_then_recovers(root)
        await test_duplicate_message_uid_is_idempotent(root)
        await test_corrupt_pending_line_is_archived(root)
        print("pending replay tests OK")
    finally:
        shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    asyncio.run(main())
