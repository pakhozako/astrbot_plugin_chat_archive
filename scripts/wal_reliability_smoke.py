from __future__ import annotations

import asyncio
import json
import logging
import shutil
import tempfile
import time
from pathlib import Path

import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from storage import ArchiveConfig, ChatArchiveStore


def make_entry(message_uid: str, seq: int, created_at: int) -> dict:
    return {
        "seq": seq,
        "queued_at": created_at,
        "payload": {
            "message_uid": message_uid,
            "platform": "aiocqhttp",
            "message_type": "group",
            "umo": "aiocqhttp:test:group",
            "session_id": "group-1",
            "group_id": "10001",
            "sender_id": "alice",
            "sender_name": "Alice",
            "self_id": "bot",
            "message_id": message_uid,
            "text": f"message {message_uid}",
            "raw": {"message_id": message_uid},
            "components": [{"kind": "text", "index": 0, "text": message_uid}],
            "media_count": 0,
            "created_at": created_at,
            "stored_at": created_at,
        },
        "media": [],
        "fallback_logged": False,
    }


def assert_under(path: Path, root: Path) -> None:
    resolved = path.resolve()
    resolved_root = root.resolve()
    assert resolved == resolved_root or resolved_root in resolved.parents, (
        f"{resolved} is outside {resolved_root}"
    )


def read_pending_lines(path: Path) -> list[str]:
    return [
        line.strip()
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]


async def main() -> None:
    logging.disable(logging.CRITICAL)
    root = Path(tempfile.mkdtemp(prefix="wal_reliability_"))
    try:
        data_dir = root / "data"
        store = ChatArchiveStore(
            data_dir,
            ArchiveConfig(
                batch_size=50,
                flush_interval_seconds=3600,
                durable_write=True,
                capture_media_files=False,
                download_remote_media=False,
            ),
        )

        for path in [
            store.db_path,
            store.jsonl_path,
            store.pending_path,
            store.fallback_path,
            store.media_dir,
            store.export_dir,
            store.proxy_cache_dir,
        ]:
            assert_under(path, data_dir)

        now = int(time.time())
        replay_entries = [
            make_entry("wal-replay-1", 1, now),
            make_entry("wal-replay-2", 2, now + 1),
        ]
        for entry in replay_entries:
            store.append_pending(entry)
        with store.pending_path.open("a", encoding="utf-8") as f:
            f.write("{not-json\n")
            f.write(json.dumps(["not", "an", "object"]) + "\n")

        replay = await store.replay_pending()
        assert replay["attempted"] == 2, replay
        assert replay["replayed"] == 2, replay
        assert replay["failed"] == 0, replay
        assert replay["corrupt"] == 2, replay
        assert replay["cleared"] is True, replay
        assert not store.pending_path.exists(), store.pending_path
        assert list(data_dir.glob("pending.*.replayed.jsonl")), replay
        corrupt_archives = list(data_dir.glob("pending.*.corrupt.jsonl"))
        assert corrupt_archives, replay
        corrupt_lines = read_pending_lines(corrupt_archives[0])
        assert len(corrupt_lines) == 2, corrupt_lines

        messages = store.list_messages(limit=10)["items"]
        message_uids = {item["message_uid"] for item in messages}
        assert {"wal-replay-1", "wal-replay-2"} <= message_uids, message_uids

        keep_entry = make_entry("wal-keep", 10, now + 10)
        remove_entry = make_entry("wal-remove", 11, now + 11)
        store.append_pending(keep_entry)
        store.append_pending(remove_entry)
        with store.pending_path.open("a", encoding="utf-8") as f:
            f.write("{still-corrupt\n")
            f.write(json.dumps({"unknown": True}) + "\n")

        store.remove_pending([remove_entry])
        pending_lines = read_pending_lines(store.pending_path)
        pending_text = "\n".join(pending_lines)
        assert "wal-keep" in pending_text, pending_text
        assert "wal-remove" not in pending_text, pending_text
        assert "{still-corrupt" in pending_text, pending_text
        assert '"unknown": true' in pending_text.lower(), pending_text

        fallback_entry = make_entry("wal-fallback", 20, now + 20)
        store._append_fallback([fallback_entry], RuntimeError("simulated write fail"))
        fallback_replay = await store.replay_fallback_log()
        assert fallback_replay["attempted"] == 1, fallback_replay
        assert fallback_replay["replayed"] == 1, fallback_replay
        assert fallback_replay["failed"] == 0, fallback_replay
        assert not store.fallback_path.exists(), store.fallback_path
        assert list(data_dir.glob("fallback_failed_batches.*.replayed.jsonl")), (
            fallback_replay
        )

        await store.close()
        print("wal reliability smoke OK")
    finally:
        shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    asyncio.run(main())
