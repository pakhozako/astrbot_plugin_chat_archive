from __future__ import annotations

import asyncio
import json
import shutil
import tempfile
import time
from pathlib import Path
from types import SimpleNamespace

import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from storage import ArchiveConfig, ChatArchiveStore


class DummyEvent:
    def __init__(
        self,
        message_id: str,
        text: str,
        *,
        created_at: int,
        sender_id: str = "alice",
        sender_name: str = "Alice",
        umo: str = "experience:test:room",
    ):
        self.message_id = message_id
        self.message_str = text
        self.message_type = "group"
        self.unified_msg_origin = umo
        self.platform_meta = SimpleNamespace(name="experience")
        self.message_obj = SimpleNamespace(
            message=[],
            raw_message={"text": text},
            sender=SimpleNamespace(user_id=sender_id, nickname=sender_name),
            timestamp=created_at,
            message_id=message_id,
            session_id=umo,
            message_type="group",
        )
        self._sender_id = sender_id
        self._sender_name = sender_name

    def get_sender_id(self):
        return self._sender_id

    def get_sender_name(self):
        return self._sender_name

    def get_self_id(self):
        return "bot"


async def seed_store(root: Path) -> tuple[ChatArchiveStore, list[str]]:
    store = ChatArchiveStore(
        root / "data",
        ArchiveConfig(batch_size=20, flush_interval_seconds=3600, durable_write=True),
    )
    now = int(time.time())
    await store.store_event(
        DummyEvent(
            "m1",
            "favorite and tag smoke",
            created_at=now - 20,
            sender_id="alice",
            sender_name="Alice",
        )
    )
    await store.store_event(
        DummyEvent(
            "m2",
            "history and unread smoke",
            created_at=now - 10,
            sender_id="bob",
            sender_name="Bob",
        )
    )
    await store.flush_pending()
    items = store.list_messages(limit=10)["items"]
    return store, [item["message_uid"] for item in items]


async def main() -> None:
    root = Path(tempfile.mkdtemp(prefix="experience_"))
    try:
        store, uids = await seed_store(root)
        first_uid = uids[0]

        favorite = store.set_favorite(first_uid, True)
        assert favorite["favorite"] is True, favorite
        messages = store.list_messages(favorite=True, limit=10)["items"]
        assert [item["message_uid"] for item in messages] == [first_uid], messages

        tag = store.upsert_tag("Important", "#d65064")
        assert tag["name"] == "Important", tag
        tagged = store.set_message_tag(first_uid, int(tag["id"]), True)
        assert tagged["tags"][0]["name"] == "Important", tagged
        messages = store.list_messages(tag_id=int(tag["id"]), limit=10)["items"]
        assert [item["message_uid"] for item in messages] == [first_uid], messages

        exported = json.loads(
            store.export_archive(format="json", tag_id=int(tag["id"])).read_text(
                encoding="utf-8"
            )
        )
        assert len(exported) == 1 and exported[0]["favorite"] is True, exported
        assert exported[0]["tags"][0]["name"] == "Important", exported

        history = store.record_search_history(
            "smoke", {"sender": "alice", "tag_id": tag["id"]}, hit_count=1
        )
        assert history["recorded"] is True, history
        listed = store.list_search_history()
        assert listed and listed[0]["query"] == "smoke", listed
        assert store.clear_search_history() == 1
        assert store.list_search_history() == []

        settings = store.update_ui_settings(
            {
                "theme": "dark",
                "poll_interval_seconds": 7,
                "auto_scroll": False,
                "compact_mode": True,
                "show_status_strip": False,
            }
        )
        assert settings["theme"] == "dark", settings
        assert settings["poll_interval_seconds"] == 7, settings
        assert settings["auto_scroll"] is False, settings
        assert store.get_ui_settings()["compact_mode"] is True

        conversations = store.list_conversations()
        assert conversations[0]["unread_count"] == 2, conversations
        seen = store.mark_conversation_seen("experience:test:room", first_uid)
        assert seen["last_seen_message_uid"] == first_uid, seen
        conversations = store.list_conversations()
        assert conversations[0]["unread_count"] == 1, conversations

        store.set_message_tag(first_uid, int(tag["id"]), False)
        assert store.list_messages(tag_id=int(tag["id"]), limit=10)["items"] == []
        assert store.delete_tag(int(tag["id"])) is True
        await store.close()
        print("experience smoke OK")
    finally:
        shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    asyncio.run(main())
