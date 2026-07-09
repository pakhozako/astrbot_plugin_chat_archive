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
        self.unified_msg_origin = "bench:test:user"
        self.platform_meta = SimpleNamespace(name="bench")
        self.message_obj = SimpleNamespace(
            message=[],
            raw_message={"text": text},
            sender=SimpleNamespace(user_id="user", nickname="Bench User"),
            timestamp=created_at,
            message_id=message_id,
            session_id="bench-session",
            message_type="private",
        )

    def get_sender_id(self):
        return "user"

    def get_sender_name(self):
        return "Bench User"

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


async def run_kill_28() -> dict:
    root = Path(tempfile.mkdtemp(prefix="pending_kill_28_"))
    try:
        store = ChatArchiveStore(
            root,
            ArchiveConfig(
                batch_size=20, flush_interval_seconds=3600, durable_write=True
            ),
        )
        for i in range(1, 29):
            await store.store_event(
                DummyEvent(f"kill-{i}", f"kill scenario message {i}")
            )
        before = {
            "sqlite": count_messages(root),
            "pending": pending_lines(store),
            "queue": store.pending_count(),
        }
        restarted = ChatArchiveStore(
            root,
            ArchiveConfig(
                batch_size=20, flush_interval_seconds=3600, durable_write=True
            ),
        )
        replay = await restarted.replay_pending()
        after = {
            "sqlite": count_messages(root),
            "pending": pending_lines(restarted),
            "queue": restarted.pending_count(),
        }
        await restarted.close()
        return {"before": before, "replay": replay, "after": after}
    finally:
        shutil.rmtree(root, ignore_errors=True)


async def run_perf(
    count: int, *, durable_write: bool, simulate_without_pending_wal: bool = False
) -> float:
    root = Path(tempfile.mkdtemp(prefix="pending_perf_"))
    try:
        store = ChatArchiveStore(
            root,
            ArchiveConfig(
                batch_size=20, flush_interval_seconds=3600, durable_write=durable_write
            ),
        )
        if simulate_without_pending_wal:
            store.append_pending = lambda entry: None
            store.remove_pending = lambda entries: None
        started = time.perf_counter()
        for i in range(count):
            await store.store_event(DummyEvent(f"perf-{i}", f"perf message {i}"))
        await store.flush_pending()
        elapsed = time.perf_counter() - started
        assert count_messages(root) == count
        await store.close()
        return elapsed
    finally:
        shutil.rmtree(root, ignore_errors=True)


async def main() -> None:
    kill_result = await run_kill_28()
    print("kill_28", kill_result)
    for count in (100, 500, 1000):
        before_wal = await run_perf(
            count, durable_write=False, simulate_without_pending_wal=True
        )
        fsync = await run_perf(count, durable_write=True)
        delta = ((fsync - before_wal) / before_wal * 100) if before_wal else 0.0
        print(
            "perf",
            {
                "count": count,
                "before_wal_seconds": round(before_wal, 4),
                "durable_wal_seconds": round(fsync, 4),
                "delta_percent": round(delta, 2),
            },
        )


if __name__ == "__main__":
    asyncio.run(main())
