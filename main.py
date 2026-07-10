from __future__ import annotations

import inspect
import json
import re
import time
from pathlib import Path
from typing import Any

from astrbot.api import AstrBotConfig, logger
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.star import Context, Star, StarTools, register

from .storage import ArchiveConfig, ChatArchiveStore, REMOTE_MEDIA_ALLOWED_HOSTS
from .web import ChatArchiveWeb


PLUGIN_NAME = "astrbot_plugin_chat_archive"
PLUGIN_VERSION = "0.1.0"
MAX_FORWARD_HYDRATE_IDS = 5
ONEBOT_FORWARD_CQ_RE = re.compile(r"\[CQ:forward,[^\]]*?\bid=([^,\]]+)[^\]]*\]")


@register(
    PLUGIN_NAME,
    "Codex",
    "将聊天记录、图片、视频和文件归档为 SQLite/JSON，并提供时间线 WebUI",
    PLUGIN_VERSION,
)
class ChatArchivePlugin(Star):
    def __init__(self, context: Context, config: AstrBotConfig):
        super().__init__(context)
        self.context = context
        self.config = config
        data_dir = Path(StarTools.get_data_dir(PLUGIN_NAME))
        self.store = ChatArchiveStore(
            data_dir,
            ArchiveConfig(
                capture_media_files=bool(config.get("capture_media_files", True)),
                max_media_mb=int(config.get("max_media_mb", 200) or 200),
                download_remote_media=bool(config.get("download_remote_media", True)),
                remote_media_timeout_seconds=float(
                    config.get("remote_media_timeout_seconds", 10) or 10
                ),
                allow_private_remote_media=bool(
                    config.get("allow_private_remote_media", False)
                ),
                proxy_remote_media=bool(config.get("proxy_remote_media", True)),
                remote_media_allowed_hosts=tuple(
                    str(item).strip().lower()
                    for item in (
                        config.get("remote_media_allowed_hosts", None)
                        or sorted(REMOTE_MEDIA_ALLOWED_HOSTS)
                    )
                    if str(item).strip()
                ),
                max_storage_mb=self._optional_number(
                    config.get("max_storage_mb", None)
                ),
                durable_write=bool(config.get("durable_write", True)),
            ),
        )
        self.web = ChatArchiveWeb(
            context, self.store, page_size=int(config.get("web_page_size", 80) or 80)
        )
        self.enabled = bool(config.get("enabled", True))
        self.capture_private = bool(config.get("capture_private", True))
        self.capture_group = bool(config.get("capture_group", True))
        self.ignore_prefixes = [
            str(x) for x in (config.get("ignore_command_prefixes", []) or [])
        ]

    async def initialize(self):
        self.web.register_routes()
        try:
            logger.info("Replay Pending: checking %s", self.store.pending_path)
            pending_replay = await self.store.replay_pending()
            if pending_replay["attempted"]:
                logger.info(
                    "Replay Pending: attempted=%s replayed=%s failed=%s corrupt=%s archive=%s",
                    pending_replay["attempted"],
                    pending_replay["replayed"],
                    pending_replay["failed"],
                    pending_replay.get("corrupt", 0),
                    pending_replay["archive_path"],
                )
                logger.info(
                    "Replay Finished: pending attempted=%s replayed=%s failed=%s",
                    pending_replay["attempted"],
                    pending_replay["replayed"],
                    pending_replay["failed"],
                )
                if pending_replay.get("cleared"):
                    logger.info("Pending Cleared: %s", self.store.pending_path)
                if pending_replay.get("corrupt_archive_path"):
                    logger.warning(
                        "Pending Corrupt Lines Archived: %s",
                        pending_replay["corrupt_archive_path"],
                    )
            replay = await self.store.replay_fallback_log()
            if replay["attempted"]:
                logger.info(
                    "Chat Archive fallback replay attempted=%s replayed=%s failed=%s archive=%s",
                    replay["attempted"],
                    replay["replayed"],
                    replay["failed"],
                    replay["archive_path"],
                )
        except Exception:
            logger.exception("Chat Archive startup recovery failed")
        try:
            retention_days = int(self.config.get("retention_days", 0) or 0)
            if retention_days > 0:
                removed = self.store.prune_older_than(retention_days)
                if removed:
                    logger.info("Chat Archive pruned %s old messages", removed)
        except Exception:
            logger.exception("Chat Archive startup retention prune failed")
        logger.info("Chat Archive initialized: %s", self.store.db_path)

    async def terminate(self):
        await self.store.close()
        return None

    @filter.event_message_type(filter.EventMessageType.ALL)
    async def capture_message(self, event: AstrMessageEvent):
        if not self.enabled:
            return
        message_type = self._event_message_type(event)
        logger.debug(
            "Chat Archive capture event message_type=%s umo=%s",
            message_type or "unknown",
            getattr(event, "unified_msg_origin", ""),
        )
        if message_type == "private" and not self.capture_private:
            return
        if message_type == "group" and not self.capture_group:
            return
        if message_type not in {"group", "private"}:
            logger.warning(
                "Chat Archive skipped unknown message_type=%s raw=%s umo=%s",
                message_type or "",
                self._raw_event_message_type(event),
                getattr(event, "unified_msg_origin", ""),
            )
            return
        text = str(getattr(event, "message_str", "") or "")
        if any(text.startswith(prefix) for prefix in self.ignore_prefixes):
            return
        try:
            await self._hydrate_onebot_forward_event(event)
            await self.store.store_event(event)
        except Exception as exc:
            logger.warning(
                "Chat Archive failed to store message: %s", exc, exc_info=True
            )

    @staticmethod
    def _event_message_type(event: AstrMessageEvent) -> str:
        # AstrBot adapters expose message type through slightly different
        # attributes/enums; normalize the common shapes before filtering.
        for value in ChatArchivePlugin._raw_event_message_type_values(event):
            normalized = value.strip().lower().replace("-", "_")
            compact = normalized.replace("_", "")
            if normalized in {
                "group",
                "group_message",
                "guild",
                "channel",
            } or compact in {
                "groupmessage",
                "messagetype.groupmessage",
            }:
                return "group"
            if normalized in {
                "private",
                "friend",
                "friend_message",
                "direct",
                "dm",
                "private_message",
            } or compact in {
                "friendmessage",
                "privatemessage",
                "messagetype.friendmessage",
            }:
                return "private"
        return ""

    @staticmethod
    def _raw_event_message_type(event: AstrMessageEvent) -> str:
        return ",".join(ChatArchivePlugin._raw_event_message_type_values(event))

    @staticmethod
    def _raw_event_message_type_values(event: AstrMessageEvent) -> list[str]:
        message_obj = getattr(event, "message_obj", None)
        candidates = [
            getattr(event, "message_type", None),
            getattr(message_obj, "message_type", None),
            getattr(message_obj, "type", None),
            getattr(event, "type", None),
        ]
        values: list[str] = []
        for candidate in candidates:
            for raw in [
                getattr(candidate, "value", None),
                getattr(candidate, "name", None),
                candidate,
            ]:
                value = str(raw or "").strip()
                if value and value not in values:
                    values.append(value)
        return values

    async def _hydrate_onebot_forward_event(self, event: AstrMessageEvent) -> None:
        forward_ids = self._event_forward_ids(event)
        if not forward_ids:
            return
        hydrated: dict[str, dict[str, Any]] = {}
        for forward_id in forward_ids[:MAX_FORWARD_HYDRATE_IDS]:
            try:
                result = await self._call_onebot_forward_api(event, forward_id)
            except Exception as exc:
                log_method = (
                    logger.debug
                    if isinstance(exc, RuntimeError) and "not available" in str(exc)
                    else logger.warning
                )
                log_method(
                    "Chat Archive get_forward_msg failed: id=%s error=%s",
                    self._short_forward_id(forward_id),
                    exc,
                    exc_info=True,
                )
                continue
            payload = self._onebot_forward_payload_from_api(forward_id, result)
            if payload:
                hydrated[forward_id] = payload
        if not hydrated:
            return
        self._apply_hydrated_forward_payloads(event, hydrated)
        logger.debug(
            "Chat Archive hydrated %s merged forward message(s)", len(hydrated)
        )

    async def _call_onebot_forward_api(
        self, event: AstrMessageEvent, forward_id: str
    ) -> Any:
        client = getattr(event, "bot", None)
        if client is None:
            message_obj = getattr(event, "message_obj", None)
            client = getattr(message_obj, "bot", None)
        if client is None:
            raise RuntimeError("event.bot is not available")

        # AstrBot 文档示例是 event.bot.api.call_action；aiocqhttp 同时支持
        # bot.call_action 和 bot.get_forward_msg。这里按最常见到最直接的顺序尝试，
        # 失败后保留原始合并转发 ID，不让协议端差异影响普通归档。
        candidates: list[tuple[Any, tuple[Any, ...], dict[str, Any]]] = []
        api = getattr(client, "api", None)
        if api is not None:
            candidates.append(
                (
                    getattr(api, "call_action", None),
                    ("get_forward_msg",),
                    {"id": forward_id},
                )
            )
        candidates.extend(
            [
                (
                    getattr(client, "call_action", None),
                    ("get_forward_msg",),
                    {"id": forward_id},
                ),
                (
                    getattr(client, "call_api", None),
                    ("get_forward_msg",),
                    {"id": forward_id},
                ),
                (getattr(client, "get_forward_msg", None), (), {"id": forward_id}),
            ]
        )

        last_error: Exception | None = None
        for func, args, kwargs in candidates:
            if not callable(func):
                continue
            try:
                result = func(*args, **kwargs)
                if inspect.isawaitable(result):
                    result = await result
                return result
            except Exception as exc:
                last_error = exc
                logger.debug(
                    "Chat Archive forward API candidate failed: id=%s func=%s",
                    self._short_forward_id(forward_id),
                    getattr(func, "__name__", repr(func)),
                    exc_info=True,
                )
        if last_error:
            raise last_error
        raise RuntimeError("get_forward_msg API is not available")

    def _onebot_forward_payload_from_api(
        self, forward_id: str, result: Any
    ) -> dict[str, Any] | None:
        data = self._safe_jsonable(result)
        if isinstance(data, dict) and isinstance(data.get("data"), (dict, list)):
            data = data["data"]

        messages: Any = None
        if isinstance(data, list):
            messages = data
        elif isinstance(data, dict):
            for key in ("messages", "message", "items", "nodes", "content"):
                if isinstance(data.get(key), list):
                    messages = data[key]
                    break
        if not isinstance(messages, list) or not messages:
            return None

        normalized = self.store._normalize_forward_messages(messages)
        count = len(normalized) or len(messages)
        previews = [
            f"{item.get('sender')}: {item.get('text')}"
            for item in normalized
            if item.get("text")
        ][:5]
        return {
            "id": forward_id,
            "title": "合并转发",
            "summary": f"{count} 条消息",
            "preview": previews,
            "messages": messages,
            "source": "get_forward_msg",
        }

    def _apply_hydrated_forward_payloads(
        self, event: AstrMessageEvent, hydrated: dict[str, dict[str, Any]]
    ) -> None:
        message_obj = getattr(event, "message_obj", None)
        if message_obj is None:
            return

        raw = getattr(message_obj, "raw_message", None)
        raw_with_nodes, changed = self._merge_forward_payloads(raw, hydrated)
        if not changed:
            # 有些 AstrBot/OneBot 组合只给 raw_message 字符串，例如
            # [CQ:forward,id=...]。这种情况下包一层 message[]，让 storage 复用
            # 现有 OneBot segment 解析，不额外制造展示层特例。
            raw_with_nodes = {
                "raw_message": self._safe_jsonable(raw),
                "message": [
                    {"type": "forward", "data": payload}
                    for payload in hydrated.values()
                ],
            }
        self._set_attr_safely(message_obj, "raw_message", raw_with_nodes)

        message = getattr(message_obj, "message", None)
        message_with_nodes, message_changed = self._merge_forward_payloads(
            message, hydrated
        )
        if message_changed:
            self._set_attr_safely(message_obj, "message", message_with_nodes)

        self._clear_forward_marker_text(event)

    def _merge_forward_payloads(
        self, value: Any, hydrated: dict[str, dict[str, Any]], depth: int = 0
    ) -> tuple[Any, bool]:
        if depth > 8 or value is None:
            return value, False
        if isinstance(value, list):
            changed = False
            items = []
            for item in value:
                merged, item_changed = self._merge_forward_payloads(
                    item, hydrated, depth + 1
                )
                changed = changed or item_changed
                items.append(merged)
            return (items, True) if changed else (value, False)
        if not isinstance(value, dict):
            return value, False

        forward_id, data = self._onebot_forward_segment(value)
        if forward_id and forward_id in hydrated:
            merged_data = dict(data)
            merged_data.update(hydrated[forward_id])
            merged = dict(value)
            merged["data"] = merged_data
            return merged, True

        changed = False
        merged_dict: dict[str, Any] = {}
        for key, item in value.items():
            merged_item, item_changed = self._merge_forward_payloads(
                item, hydrated, depth + 1
            )
            changed = changed or item_changed
            merged_dict[key] = merged_item
        return (merged_dict, True) if changed else (value, False)

    def _event_forward_ids(self, event: AstrMessageEvent) -> list[str]:
        message_obj = getattr(event, "message_obj", None)
        values = [
            getattr(message_obj, "raw_message", None),
            getattr(message_obj, "message", None),
            getattr(event, "message_str", None),
            getattr(message_obj, "message_str", None),
        ]
        result: list[str] = []
        seen_objects: set[int] = set()
        for value in values:
            self._collect_forward_ids(value, result, seen_objects)
            if len(result) >= MAX_FORWARD_HYDRATE_IDS:
                break
        return result

    def _collect_forward_ids(
        self,
        value: Any,
        result: list[str],
        seen_objects: set[int],
        depth: int = 0,
    ) -> None:
        if depth > 8 or len(result) >= MAX_FORWARD_HYDRATE_IDS or value is None:
            return
        if isinstance(value, str):
            for match in ONEBOT_FORWARD_CQ_RE.findall(value):
                self._append_forward_id(result, match)
            parsed = self._json_loads_maybe(value)
            if parsed is not None:
                self._collect_forward_ids(parsed, result, seen_objects, depth + 1)
            return
        if isinstance(value, (list, tuple, set)):
            for item in value:
                self._collect_forward_ids(item, result, seen_objects, depth + 1)
            return
        if not isinstance(value, dict):
            object_id = id(value)
            if object_id in seen_objects:
                return
            seen_objects.add(object_id)
            converted = self._object_to_jsonable_mapping(value)
            if converted is not None:
                self._collect_forward_ids(converted, result, seen_objects, depth + 1)
            return

        forward_id, _ = self._onebot_forward_segment(value)
        self._append_forward_id(result, forward_id)
        for item in value.values():
            self._collect_forward_ids(item, result, seen_objects, depth + 1)

    @staticmethod
    def _onebot_forward_segment(value: dict[str, Any]) -> tuple[str, dict[str, Any]]:
        segment_type = (
            str(
                value.get("type")
                or value.get("kind")
                or value.get("segment_type")
                or ""
            )
            .strip()
            .lower()
        )
        if segment_type != "forward":
            return "", {}
        data = value.get("data")
        if not isinstance(data, dict):
            data = {}
        forward_id = ""
        for key in ("id", "resid", "res_id", "forward_id"):
            forward_id = str(data.get(key) or "").strip()
            if forward_id:
                break
        return forward_id, data

    @staticmethod
    def _append_forward_id(result: list[str], forward_id: Any) -> None:
        text = str(forward_id or "").strip()
        if text and text not in result:
            result.append(text)

    @staticmethod
    def _short_forward_id(value: Any) -> str:
        text = str(value or "").strip()
        return text if len(text) <= 24 else f"{text[:10]}...{text[-8:]}"

    @staticmethod
    def _json_loads_maybe(value: str) -> Any:
        text = value.strip()
        if not text or text[0] not in "[{":
            return None
        try:
            return json.loads(text)
        except (TypeError, ValueError):
            return None

    @classmethod
    def _safe_jsonable(cls, value: Any) -> Any:
        if value is None or isinstance(value, (str, int, float, bool)):
            return value
        if isinstance(value, bytes):
            return f"<bytes:{len(value)}>"
        if isinstance(value, (list, tuple, set)):
            return [cls._safe_jsonable(item) for item in value]
        if isinstance(value, dict):
            return {str(key): cls._safe_jsonable(item) for key, item in value.items()}
        converted = cls._object_to_jsonable_mapping(value)
        return cls._safe_jsonable(converted) if converted is not None else repr(value)

    @staticmethod
    def _object_to_jsonable_mapping(value: Any) -> dict[str, Any] | None:
        for method_name in ("toDict", "model_dump"):
            method = getattr(value, method_name, None)
            if callable(method):
                try:
                    converted = method()
                except Exception:
                    continue
                if isinstance(converted, dict):
                    return converted
        if hasattr(value, "__dict__"):
            return {
                str(key): item
                for key, item in vars(value).items()
                if not str(key).startswith("_")
            }
        return None

    def _clear_forward_marker_text(self, event: AstrMessageEvent) -> None:
        message_obj = getattr(event, "message_obj", None)
        for owner in (event, message_obj):
            if owner is None:
                continue
            text = str(getattr(owner, "message_str", "") or "").strip()
            if self._is_forward_marker_text(text):
                self._set_attr_safely(owner, "message_str", "")

    @staticmethod
    def _is_forward_marker_text(value: str) -> bool:
        text = str(value or "").strip()
        if not text:
            return False
        if text in {"[聊天记录]", "[合并转发]"}:
            return True
        return bool(re.fullmatch(r"(?:\[CQ:forward,[^\]]+\]\s*)+", text))

    @staticmethod
    def _set_attr_safely(target: Any, name: str, value: Any) -> None:
        try:
            setattr(target, name, value)
        except Exception:
            logger.debug("Chat Archive could not set %s on %r", name, target)

    @staticmethod
    def _optional_number(value):
        if value in (None, "", 0, "0"):
            return None
        try:
            number = float(value)
        except (TypeError, ValueError):
            return None
        if number <= 0:
            return None
        return int(number) if number.is_integer() else number

    @staticmethod
    def _optional_int(value):
        number = ChatArchivePlugin._optional_number(value)
        return int(number) if number is not None else None

    @staticmethod
    def _format_mb(bytes_value: int | float | None) -> str:
        return f"{float(bytes_value or 0) / 1024 / 1024:.2f} MB"

    @staticmethod
    def _format_time(timestamp: int | float | None) -> str:
        if not timestamp:
            return "无"
        return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(int(timestamp)))

    @filter.permission_type(filter.PermissionType.ADMIN)
    @filter.command("chatlog", priority=100)
    async def chatlog(
        self, event: AstrMessageEvent, action: str = "", arg: str = "", arg2: str = ""
    ):
        action_name = action
        try:
            event.stop_event()
            action_name = (action or "status").strip().lower()
            async for result in self._chatlog_command(event, action_name, arg, arg2):
                yield result
        except Exception as exc:
            logger.exception(
                "Chat Archive command failed: action=%s arg=%s arg2=%s",
                action_name,
                arg,
                arg2,
            )
            yield event.plain_result(f"聊天归档命令执行失败: {exc}")

    async def _chatlog_command(
        self, event: AstrMessageEvent, action: str, arg: str = "", arg2: str = ""
    ):
        if action == "status":
            stats = self.store.stats()
            storage_line = f"总占用: {self._format_mb(stats.get('storage_bytes'))}"
            if stats.get("storage_usage_percent") is not None:
                storage_line += f" / 上限 {stats.get('max_storage_mb')} MB ({stats['storage_usage_percent']:.2f}%)"
            yield event.plain_result(
                "\n".join(
                    [
                        "聊天归档状态",
                        f"消息数: {stats['messages']}",
                        f"会话数: {stats['conversations']}",
                        f"媒体数: {stats['media']}",
                        f"收藏数: {stats.get('favorites', 0)}",
                        f"标签数: {stats.get('tags', 0)}",
                        f"搜索历史: {stats.get('search_history', 0)}",
                        f"待提交队列条数: {self.store.pending_count()}",
                        f"Schema: {stats.get('schema_version')} / {stats.get('expected_schema_version')}",
                        f"DB 文件大小: {self._format_mb(stats.get('db_bytes'))}",
                        f"媒体目录大小: {self._format_mb(stats.get('media_bytes'))}",
                        storage_line,
                        f"最近一次清理: {self._format_time(stats.get('last_prune_at'))}",
                        f"最近清理结果: {stats.get('last_prune_removed', 0)} 条 / 释放 {self._format_mb(stats.get('last_prune_freed_bytes'))}",
                        f"数据库: {stats['db_path']}",
                        f"JSONL: {stats['jsonl_path']}",
                        f"Pending journal: {stats['pending_path']}",
                    ]
                )
            )
            return
        if action == "export":
            await self.store.flush_pending()
            export_format = (arg or "json").strip().lower()
            start_arg = arg2
            end_arg = ""
            if export_format.replace(".", "", 1).isdigit():
                start_arg = arg
                export_format = "json"
            path = self.store.export_archive(
                format=export_format,
                start_ts=self._optional_int(start_arg),
                end_ts=self._optional_int(end_arg),
                include_media=export_format == "zip",
            )
            yield event.plain_result(f"已导出: {path}")
            return
        if action == "prune":
            try:
                days = int(arg or "0")
            except ValueError:
                yield event.plain_result("用法: /chatlog prune <天数> [最大MB]")
                return
            max_storage_mb = self._optional_number(arg2)
            if (
                days <= 0
                and not max_storage_mb
                and not self.store.config.max_storage_mb
            ):
                yield event.plain_result("请提供天数或最大存储 MB")
                return
            await self.store.flush_pending()
            removed = self.store.prune_older_than(days, max_storage_mb=max_storage_mb)
            yield event.plain_result(f"已清理: {removed} 条消息")
            return
        if action == "check":
            await self.store.flush_pending()
            result = self.store.integrity_check()
            lines = [
                "聊天归档完整性检查",
                f"结果: {'通过' if result.get('ok') else '发现问题'}",
                f"SQLite: {result.get('sqlite_integrity')}",
                f"问题数: {result.get('issue_count', 0)}",
                f"Pending 行数: {result.get('pending_lines', 0)}",
                f"Fallback 行数: {result.get('fallback_lines', 0)}",
            ]
            for issue in (result.get("issues") or [])[:5]:
                lines.append(f"- {issue.get('type')}: {issue}")
            yield event.plain_result("\n".join(lines))
            return
        if action == "gc":
            await self.store.flush_pending()
            dry_run = (arg or "").strip().lower() in {"dry", "dry-run", "check"}
            result = self.store.media_gc(dry_run=dry_run)
            yield event.plain_result(
                "\n".join(
                    [
                        "聊天归档媒体 GC",
                        f"模式: {'预检查' if dry_run else '执行'}",
                        f"删除文件: {result.get('removed_files', 0)}",
                        f"释放空间: {self._format_mb(result.get('removed_file_bytes'))}",
                        f"删除 blob 记录: {result.get('removed_blob_rows', 0)}",
                        f"修正引用计数: {result.get('fixed_ref_counts', 0)}",
                        f"孤立文件: {result.get('orphan_files', 0)}",
                    ]
                )
            )
            return
        if action == "optimize":
            vacuum = (arg or "").strip().lower() == "vacuum"
            result = self.store.optimize(vacuum=vacuum)
            yield event.plain_result(
                "\n".join(
                    [
                        "聊天归档 SQLite 维护完成",
                        "已执行: ANALYZE / PRAGMA optimize",
                        f"VACUUM: {'是' if vacuum else '否'}",
                        f"维护前 DB: {self._format_mb(result.get('before_bytes'))}",
                        f"维护后 DB: {self._format_mb(result.get('after_bytes'))}",
                    ]
                )
            )
            return
        if action == "ping":
            yield event.plain_result(f"ok {int(time.time())}")
            return
        yield event.plain_result(
            "用法: /chatlog status | export [json|markdown|txt|html|zip] | prune <天数> [最大MB] | check | gc [dry] | optimize [vacuum]"
        )
