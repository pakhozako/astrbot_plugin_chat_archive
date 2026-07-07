from __future__ import annotations

import asyncio
import json
import time

import websockets


async def main() -> None:
    async with websockets.connect("ws://127.0.0.1:8765") as ws:
        now = int(time.time())
        for i in range(1, 29):
            text = f"real13 message #{i}"
            if i > 20:
                text += " [pending before kill]"
            payload = {
                "type": "platform_message",
                "platform": "webchat",
                "message_id": f"real13-{int(time.time() * 1000)}-{i}",
                "sender_id": "real13-user",
                "sender_name": "Real13Tester",
                "group_id": "real13_group",
                "timestamp": now + i,
                "message_str": text,
                "parts": [{"type": "plain", "data": {"text": text}}],
            }
            await ws.send(json.dumps(payload, ensure_ascii=False))
        await ws.close()


if __name__ == "__main__":
    asyncio.run(main())
