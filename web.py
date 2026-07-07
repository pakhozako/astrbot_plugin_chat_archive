from __future__ import annotations

from pathlib import Path
from typing import Any, Awaitable, Callable

from astrbot.api import logger
from astrbot.api.star import Context
from astrbot.api.web import file_response, json_response, request

from .storage import ChatArchiveStore


PLUGIN_NAME = "astrbot_plugin_chat_archive"


class ChatArchiveWeb:
    def __init__(self, context: Context, store: ChatArchiveStore, page_size: int = 80):
        self.context = context
        self.store = store
        self.page_size = page_size

    def register_routes(self) -> None:
        routes: list[tuple[str, Callable[[], Awaitable[Any]], list[str], str]] = [
            ("/stats", self.stats, ["GET"], "Chat archive stats"),
            ("/conversations", self.conversations, ["GET"], "Chat archive conversations"),
            ("/filters", self.filters, ["GET"], "Chat archive search filters"),
            ("/messages", self.messages, ["GET"], "Chat archive messages"),
            ("/favorite", self.favorite, ["POST"], "Toggle chat archive favorite"),
            ("/tags", self.tags, ["GET", "POST", "DELETE"], "Manage chat archive tags"),
            ("/message-tags", self.message_tags, ["POST"], "Manage message tags"),
            ("/search-history", self.search_history, ["GET", "POST", "DELETE"], "Manage chat archive search history"),
            ("/seen", self.seen, ["POST"], "Mark chat archive conversation seen"),
            ("/settings", self.settings, ["GET", "POST"], "Manage chat archive UI settings"),
            ("/media/<media_id>", self.media_file, ["GET"], "Chat archive media file"),
            ("/file-proxy", self.file_proxy, ["GET"], "Chat archive safe local media proxy"),
            ("/image-proxy", self.image_proxy, ["GET"], "Chat archive remote image proxy"),
            ("/export", self.export_archive, ["POST"], "Export chat archive"),
        ]
        for path, handler, methods, desc in routes:
            self.context.register_web_api(f"/{PLUGIN_NAME}{path}", self._wrap(handler), methods, desc)

    def _wrap(self, handler: Callable[[], Awaitable[Any]]) -> Callable[[], Awaitable[Any]]:
        async def wrapped(**_path_params):
            try:
                return await handler()
            except Exception as exc:
                logger.exception("Chat Archive web request failed")
                return json_response({"ok": False, "message": str(exc)}, status_code=500)

        wrapped.__name__ = handler.__name__
        return wrapped

    async def stats(self):
        return json_response({"ok": True, "data": self.store.stats()})

    async def conversations(self):
        return json_response({"ok": True, "data": self.store.list_conversations()})

    async def filters(self):
        umo = str(request.query.get("umo", "") or "")
        return json_response({"ok": True, "data": self.store.search_suggestions(umo=umo)})

    async def messages(self):
        umo = str(request.query.get("umo", "") or "")
        q = str(request.query.get("q", "") or "")
        before = int(request.query.get("before", 0, int) or 0)
        limit = int(request.query.get("limit", self.page_size, int) or self.page_size)
        start_ts = self._optional_int(request.query.get("start_ts", ""))
        end_ts = self._optional_int(request.query.get("end_ts", ""))
        sender = str(request.query.get("sender", "") or "")
        message_type = str(request.query.get("message_type", "") or "")
        media_kind = str(request.query.get("media_kind", "") or "")
        favorite = self._optional_bool(request.query.get("favorite", ""))
        tag_id = self._optional_int(request.query.get("tag_id", ""))
        return json_response(
            {
                "ok": True,
                "data": self.store.list_messages(
                    umo=umo,
                    q=q,
                    before=before,
                    limit=limit,
                    start_ts=start_ts,
                    end_ts=end_ts,
                    sender=sender,
                    message_type=message_type,
                    media_kind=media_kind,
                    favorite=favorite,
                    tag_id=tag_id,
                ),
            }
        )

    async def favorite(self):
        body = await request.json(default={})
        if not isinstance(body, dict):
            body = {}
        try:
            result = self.store.set_favorite(str(body.get("message_uid") or ""), self._optional_bool(body.get("favorite", True)))
        except ValueError as exc:
            status_code = 404 if "not found" in str(exc).lower() else 400
            return json_response({"ok": False, "message": str(exc)}, status_code=status_code)
        return json_response({"ok": True, "data": result})

    async def tags(self):
        method = str(getattr(request, "method", "") or "").upper()
        if method == "GET":
            return json_response({"ok": True, "data": self.store.list_tags()})
        body = await request.json(default={})
        if not isinstance(body, dict):
            body = {}
        if method == "DELETE" or str(body.get("action") or "").lower() == "delete":
            tag_id = self._optional_int(body.get("tag_id") or request.query.get("tag_id", ""))
            if tag_id is None:
                return json_response({"ok": False, "message": "tag_id is required"}, status_code=400)
            return json_response({"ok": True, "data": {"deleted": self.store.delete_tag(tag_id)}})
        result = self.store.upsert_tag(str(body.get("name") or ""), str(body.get("color") or ""))
        return json_response({"ok": True, "data": result})

    async def message_tags(self):
        body = await request.json(default={})
        if not isinstance(body, dict):
            body = {}
        tag_id = self._optional_int(body.get("tag_id"))
        if tag_id is None:
            return json_response({"ok": False, "message": "tag_id is required"}, status_code=400)
        try:
            result = self.store.set_message_tag(
                str(body.get("message_uid") or ""),
                tag_id,
                self._optional_bool(body.get("enabled", True)),
            )
        except ValueError as exc:
            status_code = 404 if "not found" in str(exc).lower() else 400
            return json_response({"ok": False, "message": str(exc)}, status_code=status_code)
        return json_response({"ok": True, "data": result})

    async def search_history(self):
        method = str(getattr(request, "method", "") or "").upper()
        if method == "GET":
            limit = int(request.query.get("limit", 20, int) or 20)
            return json_response({"ok": True, "data": self.store.list_search_history(limit=limit)})
        body = await request.json(default={})
        if not isinstance(body, dict):
            body = {}
        if method == "DELETE" or str(body.get("action") or "").lower() == "clear":
            return json_response({"ok": True, "data": {"removed": self.store.clear_search_history()}})
        result = self.store.record_search_history(
            str(body.get("query") or ""),
            body.get("filters") if isinstance(body.get("filters"), dict) else {},
            hit_count=int(body.get("hit_count") or 0),
        )
        return json_response({"ok": True, "data": result})

    async def seen(self):
        body = await request.json(default={})
        if not isinstance(body, dict):
            body = {}
        result = self.store.mark_conversation_seen(
            str(body.get("umo") or ""),
            str(body.get("message_uid") or ""),
            self._optional_int(body.get("seen_at")),
        )
        return json_response({"ok": True, "data": result})

    async def settings(self):
        method = str(getattr(request, "method", "") or "").upper()
        if method == "GET":
            return json_response({"ok": True, "data": self.store.get_ui_settings()})
        body = await request.json(default={})
        if not isinstance(body, dict):
            body = {}
        return json_response({"ok": True, "data": self.store.update_ui_settings(body)})

    async def media_file(self):
        row = self.store.get_media_file(request.path_params.get("media_id") or "")
        if not row:
            return json_response({"ok": False, "message": "media not found"}, status_code=404)
        path = Path(row["path"])
        if not path.exists() or not path.is_file():
            return json_response({"ok": False, "message": "media file missing"}, status_code=404)
        return file_response(path, filename=row["name"] or path.name, content_type=row["mime"])

    async def file_proxy(self):
        row = self.store.get_safe_media_path(str(request.query.get("path", "") or ""))
        if not row:
            return json_response({"ok": False, "message": "file not found"}, status_code=404)
        path = Path(row["path"])
        return file_response(path, filename=row["name"] or path.name, content_type=row["mime"])

    async def image_proxy(self):
        row = self.store.get_remote_proxy_file(str(request.query.get("url", "") or ""))
        if not row:
            return json_response({"ok": False, "message": "image proxy blocked or unavailable"}, status_code=404)
        path = Path(row["path"])
        return file_response(path, filename=row["name"] or path.name, content_type=row["mime"])

    async def export_archive(self):
        body = await request.json(default={})
        if not isinstance(body, dict):
            body = {}
        start_ts = self._optional_int(body.get("start_ts") or request.query.get("start_ts", ""))
        end_ts = self._optional_int(body.get("end_ts") or request.query.get("end_ts", ""))
        fmt = str(body.get("format") or request.query.get("format", "json") or "json")
        umo = str(body.get("umo") or request.query.get("umo", "") or "")
        q = str(body.get("q") or request.query.get("q", "") or "")
        sender = str(body.get("sender") or request.query.get("sender", "") or "")
        message_type = str(body.get("message_type") or request.query.get("message_type", "") or "")
        media_kind = str(body.get("media_kind") or request.query.get("media_kind", "") or "")
        favorite = self._optional_bool(body.get("favorite", request.query.get("favorite", "")))
        tag_id = self._optional_int(body.get("tag_id") or request.query.get("tag_id", ""))
        include_media = self._optional_bool(body.get("include_media", request.query.get("include_media", "")))
        await self.store.flush_pending()
        path = self.store.export_archive(
            format=fmt,
            start_ts=start_ts,
            end_ts=end_ts,
            umo=umo,
            q=q,
            sender=sender,
            message_type=message_type,
            media_kind=media_kind,
            favorite=favorite,
            tag_id=tag_id,
            include_media=include_media,
        )
        return json_response({"ok": True, "data": {"path": str(path), "format": fmt}})

    @staticmethod
    def _optional_int(value) -> int | None:
        if value in (None, "", 0, "0"):
            return None
        try:
            return int(float(value))
        except (TypeError, ValueError):
            return None

    @staticmethod
    def _optional_bool(value) -> bool:
        if isinstance(value, bool):
            return value
        return str(value or "").strip().lower() in {"1", "true", "yes", "on", "y"}
