from __future__ import annotations

import asyncio
import http.server
import shutil
import socketserver
import threading
import tempfile
import time
from pathlib import Path
from types import SimpleNamespace

import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from storage import ArchiveConfig, ChatArchiveStore

PNG_BYTES = b"\x89PNG\r\n\x1a\n" + b"0" * 16 + b"IDAT" + b"0" * 32


class ImageHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "image/png")
        self.send_header("Content-Length", str(len(PNG_BYTES)))
        self.end_headers()
        self.wfile.write(PNG_BYTES)

    def log_message(self, format, *args):
        return


class DummyEvent:
    def __init__(self, message_id: str, raw_message: dict):
        self.message_id = message_id
        self.message_str = ""
        self.message_type = "group"
        self.unified_msg_origin = "media:test:group"
        self.platform_meta = SimpleNamespace(name="media-test")
        self.message_obj = SimpleNamespace(
            message=[],
            raw_message=raw_message,
            sender=SimpleNamespace(user_id="alice", nickname="Alice"),
            timestamp=int(time.time()),
            message_id=message_id,
            session_id="media-session",
            message_type="group",
        )

    def get_sender_id(self):
        return "alice"

    def get_sender_name(self):
        return "Alice"

    def get_self_id(self):
        return "bot"


async def main() -> None:
    root = Path(tempfile.mkdtemp(prefix="media_elements_"))
    try:
        store = ChatArchiveStore(
            root / "data",
            ArchiveConfig(
                batch_size=20,
                flush_interval_seconds=3600,
                durable_write=True,
                download_remote_media=False,
            ),
        )
        raw = {
            "elements": [
                {
                    "picElement": {
                        "originImageUrl": "/offpic_new/demo-image.png",
                        "picWidth": 320,
                        "picHeight": 180,
                        "summary": "图片",
                    }
                },
                {
                    "videoElement": {
                        "fileName": "clip.mp4",
                        "filePath": "C:/tmp/clip.mp4",
                        "thumbPath": {"1": "C:/tmp/clip.jpg"},
                        "thumbWidth": 300,
                        "thumbHeight": 180,
                        "fileTime": 12,
                    }
                },
                {"pttElement": {"filePath": "C:/tmp/audio.amr", "duration": 4}},
                {
                    "fileElement": {
                        "fileName": "doc.zip",
                        "filePath": "C:/tmp/doc.zip",
                        "fileSize": 1234,
                    }
                },
            ]
        }
        await store.store_event(DummyEvent("media-elements-1", raw))
        await store.flush_pending()
        result = store.list_messages(limit=10)
        media = result["items"][0]["media"]
        kinds = [item["kind"] for item in media]
        assert kinds == ["image", "video", "record", "file"], media
        assert (
            media[0]["source"] == "https://gchat.qpic.cn/offpic_new/demo-image.png"
        ), media[0]
        assert media[1]["name"] == "clip.mp4", media[1]
        assert media[2]["name"].endswith("audio.amr"), media[2]

        onebot_raw = {
            "message": [
                {"type": "text", "data": {"text": "onebot mixed media"}},
                {
                    "type": "image",
                    "data": {
                        "url": "https://gchat.qpic.cn/offpic_new/onebot.png",
                        "file": "onebot.png",
                    },
                },
                {
                    "type": "video",
                    "data": {"file": "C:/tmp/onebot.mp4", "name": "onebot.mp4"},
                },
                {
                    "type": "record",
                    "data": {"file": "C:/tmp/onebot.amr", "duration": 8},
                },
                {
                    "type": "file",
                    "data": {
                        "file": "C:/tmp/onebot.zip",
                        "name": "onebot.zip",
                        "size": 4567,
                    },
                },
            ]
        }
        await store.store_event(DummyEvent("media-elements-2", onebot_raw))
        await store.flush_pending()
        result = store.list_messages(limit=10)
        target = next(
            item for item in result["items"] if item["message_id"] == "media-elements-2"
        )
        onebot_media = target["media"]
        assert [item["kind"] for item in onebot_media] == [
            "image",
            "video",
            "record",
            "file",
        ], onebot_media
        assert (
            onebot_media[0]["source"] == "https://gchat.qpic.cn/offpic_new/onebot.png"
        ), onebot_media[0]
        assert onebot_media[1]["name"] == "onebot.mp4", onebot_media[1]

        rich_raw = {
            "elements": [
                {
                    "marketFaceElement": {
                        "emojiId": "123456",
                        "faceName": "大表情",
                        "supportSize": [{"width": 240, "height": 180}],
                    }
                },
                {
                    "picElement": {
                        "origin_image_url": "http://gchat.qpic.cn/offpic_new/http-image.webp",
                        "pic_width": 200,
                        "pic_height": 120,
                    }
                },
                {
                    "videoElement": {
                        "video_url": "https://multimedia.nt.qq.com.cn/video/demo.mp4",
                        "thumb_url": "https://gchat.qpic.cn/thumb/demo.jpg",
                        "fileName": "snake-video.mp4",
                    }
                },
                {
                    "pttElement": {
                        "audio_url": "https://multimedia.nt.qq.com.cn/audio/demo.amr",
                        "duration": 6,
                    }
                },
            ]
        }
        await store.store_event(DummyEvent("media-elements-3", rich_raw))
        await store.flush_pending()
        result = store.list_messages(limit=20)
        rich = next(
            item for item in result["items"] if item["message_id"] == "media-elements-3"
        )
        rich_media = rich["media"]
        assert [item["kind"] for item in rich_media] == [
            "image",
            "image",
            "video",
            "record",
        ], rich_media
        assert (
            rich_media[0]["source"]
            == "https://gxh.vip.qq.com/club/item/parcel/item/12/123456/raw240.gif"
        ), rich_media[0]
        assert rich_media[0]["name"] == "大表情", rich_media[0]
        assert (
            rich_media[1]["source"]
            == "https://gchat.qpic.cn/offpic_new/http-image.webp"
        ), rich_media[1]
        assert (
            rich_media[2]["source"] == "https://multimedia.nt.qq.com.cn/video/demo.mp4"
        ), rich_media[2]
        assert (
            rich_media[3]["source"] == "https://multimedia.nt.qq.com.cn/audio/demo.amr"
        ), rich_media[3]

        tolerant_raw = {
            "elements": [
                {
                    "picElement": {
                        "OriginImageURL": [
                            "http://c2cpicdw.qpic.cn/offpic_new/case-image.gif"
                        ],
                        "PicWidth": 128,
                        "PicHeight": 96,
                    }
                },
                {
                    "mfaceElement": {
                        "data": {
                            "EmojiURL": "https://gxh.vip.qq.com/club/item/parcel/item/ab/abcdef/raw120.gif",
                        },
                        "faceName": "嵌套表情",
                    }
                },
            ]
        }
        await store.store_event(DummyEvent("media-elements-4", tolerant_raw))
        await store.flush_pending()
        result = store.list_messages(limit=30)
        tolerant = next(
            item for item in result["items"] if item["message_id"] == "media-elements-4"
        )
        tolerant_media = tolerant["media"]
        assert [item["kind"] for item in tolerant_media] == ["image", "image"], (
            tolerant_media
        )
        assert (
            tolerant_media[0]["source"]
            == "https://c2cpicdw.qpic.cn/offpic_new/case-image.gif"
        ), tolerant_media[0]
        assert (
            tolerant_media[1]["source"]
            == "https://gxh.vip.qq.com/club/item/parcel/item/ab/abcdef/raw120.gif"
        ), tolerant_media[1]

        probe = root / "probe"
        probe.mkdir()
        mp4 = probe / "clip.bin"
        mp4.write_bytes(b"\x00\x00\x00\x18ftypmp42" + b"0" * 32)
        mp3 = probe / "audio.bin"
        mp3.write_bytes(b"ID3" + b"0" * 32)
        silk = probe / "voice.bin"
        silk.write_bytes(b"#!SILK_V3" + b"0" * 32)
        amr = probe / "voice.amr"
        amr.write_bytes(b"#!AMR\n" + b"0" * 32)
        gif = probe / "face.bin"
        gif.write_bytes(b"GIF89a" + b"0" * 32)
        webp = probe / "sticker.bin"
        webp.write_bytes(b"RIFF" + (32).to_bytes(4, "little") + b"WEBPVP8 " + b"0" * 24)
        apng = probe / "animated.bin"
        apng.write_bytes(b"\x89PNG\r\n\x1a\n" + b"0" * 16 + b"acTL" + b"0" * 32)
        tiff = probe / "scan.bin"
        tiff.write_bytes(b"II*\x00" + b"0" * 32)
        jxl = probe / "jxl.bin"
        jxl.write_bytes(b"\xff\x0a" + b"0" * 32)
        assert store._detect_remote_media_mime("video", mp4) == "video/mp4"
        assert store._detect_remote_media_mime("record", mp3) == "audio/mpeg"
        assert store._detect_remote_media_mime("record", silk) == "audio/silk"
        assert store._detect_remote_media_mime("record", amr) == "audio/amr"
        assert store._detect_remote_media_mime("image", gif) == "image/gif"
        assert store._detect_remote_media_mime("image", webp) == "image/webp"
        assert store._detect_remote_media_mime("image", apng) == "image/apng"
        assert store._detect_remote_media_mime("image", tiff) == "image/tiff"
        assert store._detect_remote_media_mime("image", jxl) == "image/jxl"
        assert store._normalize_image_mime("image/apng") == "image/apng"
        assert store._normalize_image_mime("image/x-tiff") == "image/tiff"
        assert (
            store._remote_media_suffix(
                "https://example.invalid/raw", "raw", "image/apng"
            )
            == ".png"
        )
        assert store._detect_media_mime("video", mp4) == "video/mp4"
        assert store._detect_media_mime("record", silk) == "audio/silk"
        await store.close()

        remote_store = ChatArchiveStore(
            root / "remote-data",
            ArchiveConfig(
                batch_size=20,
                flush_interval_seconds=3600,
                durable_write=True,
                allow_private_remote_media=True,
                download_remote_media=True,
            ),
        )
        with socketserver.TCPServer(("127.0.0.1", 0), ImageHandler) as server:
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                url = f"http://127.0.0.1:{server.server_address[1]}/image.png"
                await remote_store.store_event(
                    DummyEvent(
                        "remote-image-1",
                        {
                            "message": [
                                {
                                    "type": "image",
                                    "data": {"url": url, "file": "remote.png"},
                                }
                            ]
                        },
                    )
                )
                await remote_store.flush_pending()
            finally:
                server.shutdown()
                thread.join(timeout=5)
        remote_items = remote_store.list_messages(limit=5)["items"]
        remote_media = remote_items[0]["media"][0]
        assert remote_media["hash"], remote_media
        assert remote_media["local_path"], remote_media
        assert Path(remote_media["local_path"]).exists(), remote_media
        await remote_store.close()
        print("media element tests OK")
    finally:
        shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    asyncio.run(main())
