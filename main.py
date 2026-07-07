from __future__ import annotations

import time
from pathlib import Path

from astrbot.api import AstrBotConfig, logger
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.star import Context, Star, StarTools, register

from .storage import ArchiveConfig, ChatArchiveStore, REMOTE_MEDIA_ALLOWED_HOSTS
from .web import ChatArchiveWeb


PLUGIN_NAME = "astrbot_plugin_chat_archive"
PLUGIN_VERSION = "0.1.0"


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
                remote_media_timeout_seconds=float(config.get("remote_media_timeout_seconds", 10) or 10),
                allow_private_remote_media=bool(config.get("allow_private_remote_media", False)),
                proxy_remote_media=bool(config.get("proxy_remote_media", True)),
                remote_media_allowed_hosts=tuple(
                    str(item).strip().lower()
                    for item in (config.get("remote_media_allowed_hosts", None) or sorted(REMOTE_MEDIA_ALLOWED_HOSTS))
                    if str(item).strip()
                ),
                max_storage_mb=self._optional_number(config.get("max_storage_mb", None)),
                durable_write=bool(config.get("durable_write", True)),
            ),
        )
        self.web = ChatArchiveWeb(context, self.store, page_size=int(config.get("web_page_size", 80) or 80))
        self.enabled = bool(config.get("enabled", True))
        self.capture_private = bool(config.get("capture_private", True))
        self.capture_group = bool(config.get("capture_group", True))
        self.ignore_prefixes = [str(x) for x in (config.get("ignore_command_prefixes", []) or [])]

    async def initialize(self):
        self.web.register_routes()
        logger.info("Replay Pending: checking %s", self.store.pending_path)
        pending_replay = await self.store.replay_pending()
        if pending_replay["attempted"]:
            logger.info(
                "Replay Pending: attempted=%s replayed=%s failed=%s archive=%s",
                pending_replay["attempted"],
                pending_replay["replayed"],
                pending_replay["failed"],
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
        replay = await self.store.replay_fallback_log()
        if replay["attempted"]:
            logger.info(
                "Chat Archive fallback replay attempted=%s replayed=%s failed=%s archive=%s",
                replay["attempted"],
                replay["replayed"],
                replay["failed"],
                replay["archive_path"],
            )
        retention_days = int(self.config.get("retention_days", 0) or 0)
        if retention_days > 0:
            removed = self.store.prune_older_than(retention_days)
            if removed:
                logger.info("Chat Archive pruned %s old messages", removed)
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
            await self.store.store_event(event)
        except Exception as exc:
            logger.warning("Chat Archive failed to store message: %s", exc, exc_info=True)

    @staticmethod
    def _event_message_type(event: AstrMessageEvent) -> str:
        for value in ChatArchivePlugin._raw_event_message_type_values(event):
            normalized = value.strip().lower().replace("-", "_")
            compact = normalized.replace("_", "")
            if normalized in {"group", "group_message", "guild", "channel"} or compact in {
                "groupmessage",
                "messagetype.groupmessage",
            }:
                return "group"
            if normalized in {"private", "friend", "friend_message", "direct", "dm", "private_message"} or compact in {
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
    async def chatlog(self, event: AstrMessageEvent, action: str = "", arg: str = "", arg2: str = ""):
        event.stop_event()
        action = (action or "status").strip().lower()
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
            if days <= 0 and not max_storage_mb and not self.store.config.max_storage_mb:
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
        yield event.plain_result("用法: /chatlog status | export [json|markdown|txt|html|zip] | prune <天数> [最大MB] | check | gc [dry] | optimize [vacuum]")
