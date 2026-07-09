from __future__ import annotations

import asyncio
import shutil
import tempfile
import time
from pathlib import Path
from types import SimpleNamespace

import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from storage import ArchiveConfig, ChatArchiveStore


FORWARD_ID = "2fz1pK0FJwlrHNU9DLEskChlmbh7EjVjfnd38qf//7gjf8Gc30qY/bmY4K5zYsXK"


class DummyForwardEvent:
    def __init__(self):
        self.message_id = "forward-msg-1"
        self.message_str = ""
        self.message_type = "group"
        self.unified_msg_origin = "onebot:test:group"
        self.platform_meta = SimpleNamespace(name="aiocqhttp")
        self.message_obj = SimpleNamespace(
            message=[],
            raw_message={
                "status": "ok",
                "data": {
                    "message": [
                        {
                            "type": "forward",
                            "data": {"id": FORWARD_ID},
                        }
                    ]
                },
            },
            sender=SimpleNamespace(user_id="alice", nickname="Alice"),
            timestamp=int(time.time()),
            message_id="forward-msg-1",
            session_id="group-1",
            group_id="972752812",
            message_type="group",
        )

    def get_sender_id(self):
        return "alice"

    def get_sender_name(self):
        return "Alice"

    def get_self_id(self):
        return "bot"

    def get_group_id(self):
        return "972752812"


async def main() -> None:
    root = Path(tempfile.mkdtemp(prefix="forward_cache_"))
    try:
        store = ChatArchiveStore(
            root / "data",
            ArchiveConfig(
                batch_size=20, flush_interval_seconds=3600, durable_write=True
            ),
        )
        await store.store_event(DummyForwardEvent())
        await store.flush_pending()

        listed = store.list_messages(limit=5)["items"]
        assert len(listed) == 1, listed
        previews = listed[0].get("forward_previews") or []
        assert previews and previews[0]["forward_id"] == FORWARD_ID, previews
        assert previews[0]["summary"] == "OneBot 合并转发", previews

        detail = store.get_forward_preview(FORWARD_ID)
        assert detail and detail["forward_id"] == FORWARD_ID, detail
        assert detail["refs"] and detail["refs"][0]["message_id"] == "forward-msg-1", (
            detail
        )
        await store.close()
        print("forward cache smoke OK")
    finally:
        shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    asyncio.run(main())
