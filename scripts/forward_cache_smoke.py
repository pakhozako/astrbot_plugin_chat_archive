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
    def __init__(self, message_id: str, raw_message: dict | None = None):
        self.message_id = message_id
        self.message_str = ""
        self.message_type = "group"
        self.unified_msg_origin = "onebot:test:group"
        self.platform_meta = SimpleNamespace(name="aiocqhttp")
        self.message_obj = SimpleNamespace(
            message=[],
            raw_message=raw_message
            or {
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
            message_id=message_id,
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
        await store.store_event(DummyForwardEvent("forward-msg-1"))
        rich_forward_id = "rich-forward-id"
        await store.store_event(
            DummyForwardEvent(
                "forward-msg-2",
                {
                    "segments": [
                        {
                            "type": "forward",
                            "data": {
                                "forward_id": rich_forward_id,
                                "title": "群聊记录",
                                "preview": ["Alice: 早上好", "Bob: 收到"],
                                "summary": "2 条消息",
                                "messages": [
                                    {
                                        "sender_name": "Alice",
                                        "time": "1783573000",
                                        "segments": [
                                            {
                                                "type": "text",
                                                "data": {"text": "早上好"},
                                            }
                                        ],
                                    },
                                    {
                                        "sender_name": "Bob",
                                        "segments": [
                                            {
                                                "type": "mention_all",
                                                "data": {},
                                            },
                                            {
                                                "type": "image",
                                                "data": {"summary": "截图"},
                                            },
                                        ],
                                    },
                                ],
                            },
                        }
                    ]
                },
            )
        )
        await store.flush_pending()

        listed = store.list_messages(limit=5)["items"]
        assert len(listed) == 2, listed
        first = next(item for item in listed if item["message_id"] == "forward-msg-1")
        previews = first.get("forward_previews") or []
        assert previews and previews[0]["forward_id"] == FORWARD_ID, previews
        assert previews[0]["summary"] == "OneBot 合并转发", previews

        detail = store.get_forward_preview(FORWARD_ID)
        assert detail and detail["forward_id"] == FORWARD_ID, detail
        assert detail["refs"] and detail["refs"][0]["message_id"] == "forward-msg-1", (
            detail
        )

        rich = next(item for item in listed if item["message_id"] == "forward-msg-2")
        rich_previews = rich.get("forward_previews") or []
        assert rich_previews and rich_previews[0]["forward_id"] == rich_forward_id, (
            rich_previews
        )
        assert rich_previews[0]["title"] == "群聊记录", rich_previews
        assert rich_previews[0]["previews"] == ["Alice: 早上好", "Bob: 收到"], (
            rich_previews
        )
        rich_detail = store.get_forward_preview(rich_forward_id)
        assert rich_detail and rich_detail["message_count"] == 2, rich_detail
        assert rich_detail["messages"][1]["text"] == "@全体成员[图片]", rich_detail
        await store.close()
        print("forward cache smoke OK")
    finally:
        shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    asyncio.run(main())
