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


FORWARD_ID = "gbzl4SGAxJwfZRGrlYxD2ATg9rW/7MLItnwdcclK6ww/T2W7VQzgMC+whTi92nzW"
SECOND_FORWARD_ID = "LCYdNHpRxYlnWquG6xK7a/m9WlDG0kTNxCzdFxg7xzlddGSrNYJ45bcyWLZY8x2T"
THIRD_FORWARD_ID = "lAfmPXCj9thJrfr8Ne1vBGfUEV2zdfcrVhFI4myq2gXOFoc4OpHNLo2mEjXIY4cl"


def onebot_forward_raw(
    forward_id: str,
    *,
    message_id: int,
    message_seq: int,
    user_id: int = 3926537572,
    nickname: str = "Claude",
    card: str = "我不是Claude",
) -> dict:
    return {
        "status": "ok",
        "retcode": 0,
        "data": {
            "time": 1783649390,
            "message_type": "group",
            "sub_type": "normal",
            "message_id": message_id,
            "message_seq": message_seq,
            "group_id": 972752812,
            "user_id": user_id,
            "message": [{"type": "forward", "data": {"id": forward_id}}],
            "raw_message": f"[CQ:forward,id={forward_id}]",
            "font": 0,
            "sender": {
                "user_id": user_id,
                "nickname": nickname,
                "card": card,
                "role": "admin",
                "sex": "unknown",
                "age": 0,
            },
            "anonymous": None,
            "real_id": message_id,
        },
    }


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
            or onebot_forward_raw(
                FORWARD_ID, message_id=-1446084226, message_seq=371495
            ),
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
        await store.store_event(
            DummyForwardEvent(
                "forward-msg-1b",
                onebot_forward_raw(
                    SECOND_FORWARD_ID, message_id=1570462735, message_seq=371488
                ),
            )
        )
        await store.store_event(
            DummyForwardEvent(
                "forward-msg-1c",
                onebot_forward_raw(
                    THIRD_FORWARD_ID,
                    message_id=-1349952399,
                    message_seq=371451,
                    user_id=2413474391,
                    nickname="Elaina",
                    card="Elaina",
                ),
            )
        )
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
        assert len(listed) == 4, listed
        first = next(item for item in listed if item["message_id"] == "forward-msg-1")
        previews = first.get("forward_previews") or []
        assert previews and previews[0]["forward_id"] == FORWARD_ID, previews
        assert previews[0]["summary"] == "OneBot 合并转发", previews
        for message_id, forward_id in (
            ("forward-msg-1b", SECOND_FORWARD_ID),
            ("forward-msg-1c", THIRD_FORWARD_ID),
        ):
            item = next(row for row in listed if row["message_id"] == message_id)
            item_previews = item.get("forward_previews") or []
            assert item_previews and item_previews[0]["forward_id"] == forward_id, (
                item_previews
            )

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
