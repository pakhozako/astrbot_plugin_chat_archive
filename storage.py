from __future__ import annotations

import asyncio
import base64
import binascii
import hashlib
import ipaddress
import json
import mimetypes
import os
import shutil
import socket
import sqlite3
import time
import uuid
import zipfile
from contextlib import contextmanager
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.error import HTTPError
from urllib.parse import unquote, urljoin, urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener


MEDIA_COMPONENT_TYPES = {"image", "video", "record", "file"}
DEFAULT_BATCH_SIZE = 20
DEFAULT_FLUSH_INTERVAL_SECONDS = 3.0
REMOTE_MEDIA_ALLOWED_HOSTS = {
    "gchat.qpic.cn",
    "gdynamic.qpic.cn",
    "multimedia.nt.qq.com.cn",
    "multimedia.qfile.qq.com",
    "c2cpicdw.qpic.cn",
    "c2cpicdw.qpic.com",
    "p.qlogo.cn",
    "q1.qlogo.cn",
    "gxh.vip.qq.com",
    "q.qlogo.cn",
    "thirdqq.qlogo.cn",
    "gxh.vip.qq.com.cn",
    "i.gtimg.cn",
    "i.gtimg.com",
    "qqface.gtimg.com",
}


class _NoRedirectHandler(HTTPRedirectHandler):
    def http_error_301(self, req, fp, code, msg, headers):
        raise HTTPError(req.full_url, code, msg, headers, fp)

    http_error_302 = http_error_301
    http_error_303 = http_error_301
    http_error_307 = http_error_301
    http_error_308 = http_error_301


@dataclass
class ArchiveConfig:
    capture_media_files: bool = True
    max_media_mb: int = 200
    download_remote_media: bool = True
    remote_media_timeout_seconds: float = 10.0
    allow_private_remote_media: bool = False
    proxy_remote_media: bool = True
    remote_media_allowed_hosts: tuple[str, ...] = tuple(sorted(REMOTE_MEDIA_ALLOWED_HOSTS))
    max_storage_mb: float | None = None
    batch_size: int = DEFAULT_BATCH_SIZE
    flush_interval_seconds: float = DEFAULT_FLUSH_INTERVAL_SECONDS
    durable_write: bool = True


def _json_dumps(data: Any) -> str:
    return json.dumps(data, ensure_ascii=False, separators=(",", ":"))


def _safe_name(value: str, fallback: str = "file") -> str:
    name = os.path.basename(str(value or "").replace("\\", "/")).strip()
    if not name:
        name = fallback
    for char in '<>:"/\\|?*\x00':
        name = name.replace(char, "_")
    if name in {"", ".", ".."}:
        name = fallback
    return name[:160]


class ChatArchiveStore:
    def __init__(self, data_dir: Path, config: ArchiveConfig):
        self.data_dir = Path(data_dir)
        self.config = config
        self.media_dir = self.data_dir / "media"
        self.export_dir = self.data_dir / "exports"
        self.proxy_cache_dir = self.data_dir / "proxy_cache"
        self.db_path = self.data_dir / "chat_archive.sqlite3"
        self.jsonl_path = self.data_dir / "messages.jsonl"
        self.fallback_path = self.data_dir / "fallback_failed_batches.jsonl"
        self.pending_path = self.data_dir / "pending.jsonl"
        self._batch_queue: list[dict[str, Any]] = []
        self._batch_lock = asyncio.Lock()
        self._flush_task: asyncio.Task | None = None
        self._pending_sequence = 0
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.media_dir.mkdir(parents=True, exist_ok=True)
        self.export_dir.mkdir(parents=True, exist_ok=True)
        self.proxy_cache_dir.mkdir(parents=True, exist_ok=True)
        self._init_db()
        self._pending_sequence = self._load_pending_sequence()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, timeout=15)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.execute("PRAGMA foreign_keys=ON")
        return conn

    @contextmanager
    def _connection(self) -> Iterator[sqlite3.Connection]:
        conn = self._connect()
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def _init_db(self) -> None:
        with self._connection() as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS messages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    message_uid TEXT NOT NULL UNIQUE,
                    platform TEXT,
                    message_type TEXT,
                    umo TEXT NOT NULL,
                    session_id TEXT,
                    group_id TEXT,
                    sender_id TEXT,
                    sender_name TEXT,
                    self_id TEXT,
                    message_id TEXT,
                    text TEXT,
                    raw_json TEXT NOT NULL,
                    components_json TEXT NOT NULL,
                    media_count INTEGER NOT NULL DEFAULT 0,
                    created_at INTEGER NOT NULL,
                    timestamp INTEGER,
                    stored_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS sessions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL UNIQUE,
                    umo TEXT,
                    platform TEXT,
                    message_count INTEGER NOT NULL DEFAULT 0,
                    latest_at INTEGER,
                    updated_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at DESC);
                CREATE INDEX IF NOT EXISTS idx_messages_umo_created ON messages(umo, created_at DESC);
                CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id);
                CREATE INDEX IF NOT EXISTS idx_messages_session_timestamp ON messages(session_id, timestamp);
                CREATE INDEX IF NOT EXISTS idx_messages_platform ON messages(platform);
                CREATE INDEX IF NOT EXISTS idx_sessions_session_id ON sessions(session_id);
                CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
                    text,
                    sender_name,
                    content='messages',
                    content_rowid='id'
                );
                CREATE TABLE IF NOT EXISTS media (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    message_uid TEXT NOT NULL,
                    component_index INTEGER NOT NULL,
                    kind TEXT NOT NULL,
                    name TEXT,
                    source TEXT,
                    hash TEXT,
                    local_path TEXT,
                    relative_path TEXT,
                    mime TEXT,
                    size INTEGER,
                    width INTEGER,
                    height INTEGER,
                    meta_json TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    FOREIGN KEY(message_uid) REFERENCES messages(message_uid) ON DELETE CASCADE
                );
                CREATE TABLE IF NOT EXISTS media_blobs (
                    hash TEXT PRIMARY KEY,
                    kind TEXT NOT NULL,
                    local_path TEXT NOT NULL,
                    relative_path TEXT NOT NULL,
                    size INTEGER,
                    ref_count INTEGER NOT NULL DEFAULT 1,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS meta (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS favorite_messages (
                    message_uid TEXT PRIMARY KEY,
                    created_at INTEGER NOT NULL,
                    FOREIGN KEY(message_uid) REFERENCES messages(message_uid) ON DELETE CASCADE
                );
                CREATE TABLE IF NOT EXISTS tags (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL UNIQUE,
                    color TEXT,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS message_tags (
                    message_uid TEXT NOT NULL,
                    tag_id INTEGER NOT NULL,
                    created_at INTEGER NOT NULL,
                    PRIMARY KEY(message_uid, tag_id),
                    FOREIGN KEY(message_uid) REFERENCES messages(message_uid) ON DELETE CASCADE,
                    FOREIGN KEY(tag_id) REFERENCES tags(id) ON DELETE CASCADE
                );
                CREATE TABLE IF NOT EXISTS search_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    query TEXT NOT NULL,
                    filters_json TEXT NOT NULL,
                    hit_count INTEGER NOT NULL DEFAULT 0,
                    used_count INTEGER NOT NULL DEFAULT 1,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    UNIQUE(query, filters_json)
                );
                CREATE TABLE IF NOT EXISTS conversation_state (
                    umo TEXT PRIMARY KEY,
                    last_seen_at INTEGER NOT NULL DEFAULT 0,
                    last_seen_message_uid TEXT,
                    updated_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_media_message ON media(message_uid);
                CREATE INDEX IF NOT EXISTS idx_media_kind ON media(kind);
                CREATE INDEX IF NOT EXISTS idx_media_hash ON media(hash);
                CREATE INDEX IF NOT EXISTS idx_message_tags_tag ON message_tags(tag_id);
                CREATE INDEX IF NOT EXISTS idx_search_history_updated ON search_history(updated_at DESC);
                CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
                    INSERT INTO messages_fts(rowid, text, sender_name)
                    VALUES (new.id, coalesce(new.text, ''), coalesce(new.sender_name, ''));
                END;
                CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
                    INSERT INTO messages_fts(messages_fts, rowid, text, sender_name)
                    VALUES('delete', old.id, coalesce(old.text, ''), coalesce(old.sender_name, ''));
                END;
                CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
                    INSERT INTO messages_fts(messages_fts, rowid, text, sender_name)
                    VALUES('delete', old.id, coalesce(old.text, ''), coalesce(old.sender_name, ''));
                    INSERT INTO messages_fts(rowid, text, sender_name)
                    VALUES (new.id, coalesce(new.text, ''), coalesce(new.sender_name, ''));
                END;
                """
            )
            self._ensure_column(conn, "messages", "timestamp", "INTEGER")
            self._ensure_column(conn, "media", "hash", "TEXT")
            conn.execute("UPDATE messages SET timestamp = created_at WHERE timestamp IS NULL")

    @staticmethod
    def _ensure_column(conn: sqlite3.Connection, table: str, column: str, definition: str) -> None:
        existing = {str(row["name"]) for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}
        if column not in existing:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")

    @staticmethod
    def _set_meta_locked(conn: sqlite3.Connection, key: str, value: Any) -> None:
        conn.execute(
            """
            INSERT INTO meta (key, value, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET
                value = excluded.value,
                updated_at = excluded.updated_at
            """,
            (key, _json_dumps(value), int(time.time())),
        )

    @staticmethod
    def _get_meta_locked(conn: sqlite3.Connection, key: str, default: Any = None) -> Any:
        row = conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
        if not row:
            return default
        try:
            return json.loads(row["value"])
        except (TypeError, json.JSONDecodeError):
            return default

    async def store_event(self, event: Any) -> str:
        payload = await self._event_payload(event)
        message_uid = payload["message_uid"]
        media_rows = await self._extract_media(payload["components"], payload.get("raw"), message_uid, payload["created_at"], capture_files=False)
        payload["media_count"] = len(media_rows)

        entry = {
            "payload": payload,
            "media": media_rows,
            "fallback_logged": False,
        }
        async with self._batch_lock:
            entry["seq"] = self._next_pending_sequence()
            entry["queued_at"] = int(time.time())
            self.append_pending(entry)
            self._batch_queue.append(entry)
            if len(self._batch_queue) >= max(1, int(self.config.batch_size)):
                self._cancel_scheduled_flush()
                await self._flush_locked()
            else:
                self._schedule_flush_locked()
        return message_uid

    async def flush_pending(self) -> int:
        async with self._batch_lock:
            return await self._flush_locked()

    async def close(self) -> None:
        self._cancel_scheduled_flush()
        await self.flush_pending()

    def pending_count(self) -> int:
        return len(self._batch_queue)

    def _pending_messages(self) -> list[dict[str, Any]]:
        messages: list[dict[str, Any]] = []
        for entry in list(self._batch_queue):
            payload = dict(entry.get("payload") or {})
            if not payload:
                continue
            item = {
                "message_uid": payload["message_uid"],
                "platform": payload["platform"],
                "message_type": payload["message_type"],
                "umo": payload["umo"],
                "session_id": payload["session_id"],
                "group_id": payload["group_id"],
                "sender_id": payload["sender_id"],
                "sender_name": payload["sender_name"],
                "self_id": payload["self_id"],
                "message_id": payload["message_id"],
                "text": payload["text"],
                "media_count": payload["media_count"],
                "created_at": payload["created_at"],
                "timestamp": payload["created_at"],
                "stored_at": payload["stored_at"],
                "raw": payload["raw"],
                "components": payload["components"],
                "media": [dict(row) for row in entry.get("media") or []],
                "favorite": False,
                "tags": [],
            }
            messages.append(item)
        return messages

    @staticmethod
    def _dedupe_sort_messages(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
        by_uid: dict[str, dict[str, Any]] = {}
        for item in messages:
            uid = str(item.get("message_uid") or "")
            if not uid:
                continue
            by_uid[uid] = item
        return sorted(by_uid.values(), key=lambda item: (int(item.get("created_at") or 0), int(item.get("id") or 0)))

    async def replay_fallback_log(self) -> dict[str, Any]:
        if not self.fallback_path.exists() or self.fallback_path.stat().st_size <= 0:
            return {"attempted": 0, "replayed": 0, "failed": 0, "archive_path": None}

        entries = self._read_fallback_entries(self.fallback_path)
        attempted = len(entries)
        replayed = 0
        failed_entries: list[dict[str, Any]] = []

        for entry in entries:
            try:
                replayed += self._write_entries([entry])
            except Exception as exc:
                failed = dict(entry)
                failed["replay_error"] = str(exc)
                failed_entries.append(failed)

        archive_path = self._archive_fallback_file()
        if failed_entries:
            self._append_fallback(failed_entries, RuntimeError("fallback replay failed"))
        return {
            "attempted": attempted,
            "replayed": replayed,
            "failed": len(failed_entries),
            "archive_path": str(archive_path) if archive_path else None,
        }

    async def replay_pending_log(self) -> dict[str, Any]:
        return await self.replay_pending()

    async def replay_pending(self) -> dict[str, Any]:
        if not self.pending_path.exists() or self.pending_path.stat().st_size <= 0:
            return {"attempted": 0, "replayed": 0, "failed": 0, "archive_path": None, "cleared": True}

        async with self._batch_lock:
            entries = self._read_pending_entries(self.pending_path)
            attempted = len(entries)
            replayed = 0
            failed_entries: list[dict[str, Any]] = []

            try:
                replayed = self._write_entries(entries)
            except Exception:
                replayed = 0
                failed_entries = []
                # Keep the normal path batched. Only fall back to per-entry replay
                # after a batch failure so one bad record cannot block recovery.
                for entry in entries:
                    try:
                        replayed += self._write_entries([entry])
                    except Exception as exc:
                        failed = dict(entry)
                        failed["replay_error"] = str(exc)
                        failed_entries.append(failed)

            if failed_entries:
                self._append_fallback(failed_entries, RuntimeError("pending replay failed"))
            archive_path = self._archive_pending_file()
            self._pending_sequence = self._load_pending_sequence()
            return {
                "attempted": attempted,
                "replayed": replayed,
                "failed": len(failed_entries),
                "archive_path": str(archive_path) if archive_path else None,
                "cleared": not self.pending_path.exists(),
            }

    def _read_pending_entries(self, path: Path) -> list[dict[str, Any]]:
        entries: list[dict[str, Any]] = []
        with path.open("r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    continue
                payload = record.get("payload")
                media = record.get("media") or []
                if not isinstance(payload, dict) or not isinstance(media, list):
                    continue
                entry = {
                    "payload": payload,
                    "media": media,
                    "fallback_logged": False,
                }
                if "seq" in record or "sequence" in record:
                    entry["seq"] = record.get("seq", record.get("sequence"))
                if "queued_at" in record:
                    entry["queued_at"] = record.get("queued_at")
                entries.append(entry)
        return entries

    def _read_fallback_entries(self, path: Path) -> list[dict[str, Any]]:
        entries: list[dict[str, Any]] = []
        with path.open("r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    continue
                for item in record.get("items") or []:
                    payload = item.get("payload")
                    media = item.get("media") or []
                    if isinstance(payload, dict) and isinstance(media, list):
                        entries.append({"payload": payload, "media": media, "fallback_logged": False})
        return entries

    def _archive_fallback_file(self) -> Path | None:
        if not self.fallback_path.exists():
            return None
        archive_path = self.fallback_path.with_name(f"{self.fallback_path.stem}.{int(time.time())}.replayed.jsonl")
        self.fallback_path.replace(archive_path)
        return archive_path

    def _archive_pending_file(self) -> Path | None:
        if not self.pending_path.exists():
            return None
        archive_path = self.pending_path.with_name(f"{self.pending_path.stem}.{int(time.time())}.replayed.jsonl")
        self.pending_path.replace(archive_path)
        return archive_path

    def _schedule_flush_locked(self) -> None:
        if self._flush_task and not self._flush_task.done():
            return
        self._flush_task = asyncio.create_task(self._flush_after_delay())

    def _cancel_scheduled_flush(self) -> None:
        if self._flush_task and not self._flush_task.done():
            self._flush_task.cancel()
        self._flush_task = None

    async def _flush_after_delay(self) -> None:
        try:
            await asyncio.sleep(max(0.1, float(self.config.flush_interval_seconds)))
            await self.flush_pending()
        except asyncio.CancelledError:
            return

    async def _flush_locked(self) -> int:
        if not self._batch_queue:
            return 0
        entries = list(self._batch_queue)
        try:
            written = self._write_entries(entries)
        except Exception as exc:
            self._append_fallback(entries, exc)
            return 0
        del self._batch_queue[: len(entries)]
        self.remove_pending(entries)
        return written

    def _next_pending_sequence(self) -> int:
        self._pending_sequence += 1
        return self._pending_sequence

    def _load_pending_sequence(self) -> int:
        max_sequence = 0
        if not self.pending_path.exists():
            return max_sequence
        try:
            with self.pending_path.open("r", encoding="utf-8") as f:
                for line in f:
                    try:
                        record = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    try:
                        max_sequence = max(max_sequence, int(record.get("seq", record.get("sequence")) or 0))
                    except (TypeError, ValueError):
                        continue
        except OSError:
            return max_sequence
        return max_sequence

    def append_pending(self, entry: dict[str, Any]) -> None:
        record = {
            "seq": entry.get("seq", entry.get("sequence")),
            "queued_at": entry.get("queued_at"),
            "payload": entry["payload"],
            "media": entry["media"],
        }
        self._write_jsonl_record(self.pending_path, record, durable=self.config.durable_write)

    def remove_pending(self, entries: list[dict[str, Any]]) -> None:
        seqs = {
            int(entry.get("seq", entry.get("sequence")))
            for entry in entries
            if entry.get("seq", entry.get("sequence")) is not None
        }
        if not seqs or not self.pending_path.exists():
            return

        remaining: list[str] = []
        try:
            with self.pending_path.open("r", encoding="utf-8") as f:
                for line in f:
                    stripped = line.strip()
                    if not stripped:
                        continue
                    try:
                        record = json.loads(stripped)
                        seq = int(record.get("seq", record.get("sequence")) or 0)
                    except (json.JSONDecodeError, TypeError, ValueError):
                        remaining.append(line if line.endswith("\n") else line + "\n")
                        continue
                    if seq not in seqs:
                        remaining.append(line if line.endswith("\n") else line + "\n")
        except OSError:
            return

        if remaining:
            temp_path = self.pending_path.with_suffix(self.pending_path.suffix + ".tmp")
            with temp_path.open("w", encoding="utf-8") as f:
                f.writelines(remaining)
                f.flush()
                if self.config.durable_write:
                    os.fsync(f.fileno())
            temp_path.replace(self.pending_path)
            return
        try:
            self.pending_path.unlink()
        except FileNotFoundError:
            pass

    def _write_entries(self, entries: list[dict[str, Any]]) -> int:
        self._prepare_media_for_write(entries)
        records_to_append: list[dict[str, Any]] = []
        inserted = False
        with self._connection() as conn:
            for entry in entries:
                payload = entry["payload"]
                media_rows = entry["media"]
                cursor = conn.execute(
                    """
                    INSERT OR IGNORE INTO messages (
                        message_uid, platform, message_type, umo, session_id, group_id,
                        sender_id, sender_name, self_id, message_id, text, raw_json,
                        components_json, media_count, created_at, timestamp, stored_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        payload["message_uid"],
                        payload["platform"],
                        payload["message_type"],
                        payload["umo"],
                        payload["session_id"],
                        payload["group_id"],
                        payload["sender_id"],
                        payload["sender_name"],
                        payload["self_id"],
                        payload["message_id"],
                        payload["text"],
                        _json_dumps(payload["raw"]),
                        _json_dumps(payload["components"]),
                        payload["media_count"],
                        payload["created_at"],
                        payload["created_at"],
                        payload["stored_at"],
                    ),
                )
                inserted = cursor.rowcount > 0
                if not inserted:
                    continue
                conn.execute(
                    """
                    INSERT INTO sessions (session_id, umo, platform, message_count, latest_at, updated_at)
                    VALUES (?, ?, ?, 1, ?, ?)
                    ON CONFLICT(session_id) DO UPDATE SET
                        umo = excluded.umo,
                        platform = excluded.platform,
                        message_count = sessions.message_count + 1,
                        latest_at = max(coalesce(sessions.latest_at, 0), excluded.latest_at),
                        updated_at = excluded.updated_at
                    """,
                    (
                        payload["session_id"],
                        payload["umo"],
                        payload["platform"],
                        payload["created_at"],
                        payload["stored_at"],
                    ),
                )
                for row in media_rows:
                    conn.execute(
                        """
                        INSERT INTO media (
                            message_uid, component_index, kind, name, source,
                            hash, local_path, relative_path, mime, size, width, height,
                            meta_json, created_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            payload["message_uid"],
                            row["component_index"],
                            row["kind"],
                            row.get("name"),
                            row.get("source"),
                            row.get("hash"),
                            row.get("local_path"),
                            row.get("relative_path"),
                            row.get("mime"),
                            row.get("size"),
                            row.get("width"),
                            row.get("height"),
                            _json_dumps(row.get("meta") or {}),
                            payload["created_at"],
                        ),
                    )
                    if row.get("hash") and row.get("local_path") and row.get("relative_path"):
                        conn.execute(
                            """
                            INSERT INTO media_blobs (
                                hash, kind, local_path, relative_path, size,
                                ref_count, created_at, updated_at
                            ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
                            ON CONFLICT(hash) DO UPDATE SET
                                ref_count = media_blobs.ref_count + 1,
                                updated_at = excluded.updated_at
                            """,
                            (
                                row.get("hash"),
                                row["kind"],
                                row.get("local_path"),
                                row.get("relative_path"),
                                row.get("size"),
                                payload["created_at"],
                                payload["stored_at"],
                            ),
                        )
                record = dict(payload)
                record["media"] = media_rows
                records_to_append.append(record)
        if records_to_append:
            with self.jsonl_path.open("a", encoding="utf-8") as f:
                for record in records_to_append:
                    f.write(_json_dumps(record) + "\n")
        return len(records_to_append)

    def _append_fallback(self, entries: list[dict[str, Any]], exc: Exception) -> None:
        failed = [entry for entry in entries if not entry.get("fallback_logged")]
        if not failed:
            return
        record = {
            "failed_at": int(time.time()),
            "error": str(exc),
            "items": [
                {
                    "payload": entry["payload"],
                    "media": entry["media"],
                }
                for entry in failed
            ],
        }
        self._write_jsonl_record(self.fallback_path, record, durable=self.config.durable_write)
        for entry in failed:
            entry["fallback_logged"] = True

    @staticmethod
    def _write_jsonl_record(path: Path, record: dict[str, Any], *, durable: bool) -> None:
        with path.open("a", encoding="utf-8") as f:
            f.write(_json_dumps(record) + "\n")
            f.flush()
            if durable:
                os.fsync(f.fileno())

    async def _event_payload(self, event: Any) -> dict[str, Any]:
        message_obj = getattr(event, "message_obj", None)
        components = []
        for index, component in enumerate(getattr(message_obj, "message", []) or []):
            components.append(await self._component_payload(component, index))

        raw = self._safe_jsonable(getattr(message_obj, "raw_message", None))
        sender = getattr(message_obj, "sender", None)
        created_at = int(getattr(message_obj, "timestamp", 0) or time.time())
        message_id = str(getattr(message_obj, "message_id", "") or getattr(event, "message_id", "") or "")
        if not message_id:
            message_id = self._stable_adapter_message_id(raw)
        umo = str(getattr(event, "unified_msg_origin", "") or "")
        sender_id = self._safe_event_call(event, "get_sender_id") or getattr(sender, "user_id", "") or getattr(sender, "id", "") or ""
        sender_name = (
            self._safe_event_call(event, "get_sender_name")
            or getattr(sender, "nickname", "")
            or getattr(sender, "name", "")
            or getattr(sender, "display_name", "")
            or ""
        )
        platform_meta = getattr(event, "platform_meta", None)
        message_type = self._normalize_message_type(
            getattr(event, "message_type", None)
            or getattr(message_obj, "message_type", None)
            or getattr(message_obj, "type", "")
            or getattr(event, "type", "")
        )

        return {
            "message_uid": self._message_uid(umo, message_id, created_at, sender_id),
            "platform": str(getattr(platform_meta, "name", "") or getattr(platform_meta, "platform_name", "") or ""),
            "message_type": message_type,
            "umo": umo,
            "session_id": str(getattr(message_obj, "session_id", "") or ""),
            "group_id": str(self._safe_event_call(event, "get_group_id") or getattr(message_obj, "group_id", "") or ""),
            "sender_id": str(sender_id),
            "sender_name": str(sender_name),
            "self_id": str(self._safe_event_call(event, "get_self_id") or getattr(message_obj, "self_id", "") or ""),
            "message_id": message_id,
            "text": str(getattr(event, "message_str", "") or getattr(message_obj, "message_str", "") or ""),
            "components": components,
            "raw": raw,
            "created_at": created_at,
            "stored_at": int(time.time()),
        }

    @staticmethod
    def _safe_event_call(event: Any, method: str) -> Any:
        func = getattr(event, method, None)
        if not callable(func):
            return None
        try:
            return func()
        except Exception:
            return None

    @staticmethod
    def _normalize_message_type(value: Any) -> str:
        values = [
            getattr(value, "value", None),
            getattr(value, "name", None),
            value,
        ]
        for raw in values:
            text = str(raw or "").strip()
            if not text:
                continue
            normalized = text.lower().replace("-", "_")
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
        return str(getattr(value, "value", value) or "")

    @staticmethod
    def _message_uid(umo: str, message_id: str, created_at: int, sender_id: str) -> str:
        base = "|".join([umo, message_id, str(created_at), sender_id])
        if message_id:
            return base
        return base + "|" + uuid.uuid4().hex

    @staticmethod
    def _stable_adapter_message_id(raw: Any) -> str:
        if not isinstance(raw, dict):
            return ""
        for key in ("message_id", "msgId", "msg_id", "id"):
            text = str(raw.get(key) or "").strip()
            if text:
                return text
        parts = []
        for key in ("chatType", "peerUid", "peerUin", "group_id", "user_id", "sender_id", "msgSeq", "message_seq", "seq", "msgRandom", "msgTime", "time"):
            text = str(raw.get(key) or "").strip()
            if text:
                parts.append(f"{key}={text}")
        if len(parts) >= 3:
            return "stable:" + hashlib.sha256("|".join(parts).encode("utf-8")).hexdigest()
        return ""

    async def _component_payload(self, component: Any, index: int) -> dict[str, Any]:
        type_value = getattr(component, "type", "")
        kind = str(getattr(type_value, "value", type_value) or component.__class__.__name__).lower()
        data = self._safe_jsonable(component)
        if hasattr(component, "toDict"):
            try:
                data = component.toDict()
            except Exception:
                pass
        return {"index": index, "kind": kind, "data": data}

    def _safe_jsonable(self, value: Any) -> Any:
        if value is None or isinstance(value, (str, int, float, bool)):
            return value
        if isinstance(value, bytes):
            return f"<bytes:{len(value)}>"
        if isinstance(value, (list, tuple, set)):
            return [self._safe_jsonable(v) for v in value]
        if isinstance(value, dict):
            return {str(k): self._safe_jsonable(v) for k, v in value.items()}
        if hasattr(value, "model_dump"):
            try:
                return self._safe_jsonable(value.model_dump())
            except Exception:
                pass
        if hasattr(value, "__dict__"):
            return {
                str(k): self._safe_jsonable(v)
                for k, v in vars(value).items()
                if not k.startswith("_")
            }
        return repr(value)

    async def _extract_media(
        self,
        components: list[dict[str, Any]],
        raw_message: Any,
        message_uid: str,
        created_at: int,
        *,
        capture_files: bool = True,
    ) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        seen: set[tuple[str, str, str]] = set()
        for index, kind, raw_data in self._iter_media_candidates(components, raw_message):
            source = self._first_media_value(
                raw_data,
                self._media_source_keys(kind),
            )
            source = self._normalize_qpic_source(source)
            if not source and kind == "image":
                source = self._market_face_source(raw_data)
            name = (
                raw_data.get("name")
                or raw_data.get("fileName")
                or raw_data.get("file_name")
                or raw_data.get("faceName")
                or raw_data.get("face_name")
                or raw_data.get("file")
                or raw_data.get("summary")
                or _safe_name(str(source or kind), fallback=kind)
            )
            key = (kind, str(source or ""), str(name or ""))
            if key in seen:
                continue
            seen.add(key)
            local_path = relative_path = sha256 = detected_mime = None
            size = raw_data.get("size") or raw_data.get("fileSize") or raw_data.get("file_size")
            if capture_files:
                local_path, relative_path, size, sha256, detected_mime = self._copy_media_file(
                    kind,
                    str(source or ""),
                    str(name or kind),
                    created_at,
                )
            rows.append(
                {
                    "component_index": int(index or 0),
                    "kind": kind,
                    "name": str(name or kind),
                    "source": str(source or ""),
                    "hash": sha256,
                    "local_path": local_path,
                    "relative_path": relative_path,
                    "mime": detected_mime or raw_data.get("mime") or raw_data.get("content_type") or raw_data.get("contentType"),
                    "size": size,
                    "width": raw_data.get("width") or raw_data.get("picWidth") or raw_data.get("pic_width") or raw_data.get("thumbWidth") or raw_data.get("thumb_width"),
                    "height": raw_data.get("height") or raw_data.get("picHeight") or raw_data.get("pic_height") or raw_data.get("thumbHeight") or raw_data.get("thumb_height"),
                    "meta": raw_data,
                }
            )
        return rows

    def _iter_media_candidates(self, components: list[dict[str, Any]], raw_message: Any) -> Iterator[tuple[int, str, dict[str, Any]]]:
        for component in components or []:
            index = int(component.get("index") or 0)
            kind = str(component.get("kind") or "").lower()
            data = component.get("data") or {}
            raw_data = data.get("data") if isinstance(data, dict) and isinstance(data.get("data"), dict) else data
            if not isinstance(raw_data, dict):
                raw_data = {}
            nested_kind, nested_data = self._media_kind_and_data(raw_data, fallback_kind=kind)
            if nested_kind:
                yield index, nested_kind, nested_data
        for index, element in enumerate(self._raw_message_elements(raw_message)):
            kind, data = self._media_kind_and_data(element)
            if kind:
                yield index, kind, data

    def _raw_message_elements(self, raw: Any) -> list[dict[str, Any]]:
        if isinstance(raw, list):
            elements: list[dict[str, Any]] = []
            for item in raw:
                nested = self._raw_message_elements(item)
                if nested:
                    elements.extend(nested)
                elif isinstance(item, dict):
                    elements.append(item)
            return elements
        if not isinstance(raw, dict):
            return []
        if self._has_known_message_shape(raw):
            return [raw]
        for key in ("elements", "msgElements", "message", "messageChain", "message_chain", "segments"):
            value = raw.get(key)
            if isinstance(value, list):
                return self._raw_message_elements(value)
        for key in ("payload", "data", "message_obj", "raw_message"):
            value = raw.get(key)
            nested = self._raw_message_elements(value)
            if nested:
                return nested
        return []

    @staticmethod
    def _has_known_message_shape(value: dict[str, Any]) -> bool:
        known_keys = {
            "picElement",
            "imageElement",
            "mfaceElement",
            "videoElement",
            "pttElement",
            "voiceElement",
            "recordElement",
            "audioElement",
            "fileElement",
            "faceElement",
            "marketFaceElement",
            "market_face",
            "grayTipElement",
            "replyElement",
            "arkElement",
            "multiForwardMsgElement",
            "elementType",
            "type",
            "kind",
            "segment_type",
            "typeName",
        }
        return any(key in value for key in known_keys)

    def _media_kind_and_data(self, data: dict[str, Any], fallback_kind: str = "") -> tuple[str, dict[str, Any]]:
        if not isinstance(data, dict):
            return "", {}
        if isinstance(data.get("picElement"), dict):
            return "image", data["picElement"]
        if isinstance(data.get("imageElement"), dict):
            return "image", data["imageElement"]
        if isinstance(data.get("mfaceElement"), dict):
            return "image", data["mfaceElement"]
        if isinstance(data.get("marketFaceElement"), dict):
            return "image", data["marketFaceElement"]
        if isinstance(data.get("market_face"), dict):
            return "image", data["market_face"]
        if isinstance(data.get("videoElement"), dict):
            return "video", data["videoElement"]
        for key in ("pttElement", "voiceElement", "recordElement", "audioElement"):
            if isinstance(data.get(key), dict):
                return "record", data[key]
        if isinstance(data.get("fileElement"), dict):
            return "file", data["fileElement"]
        kind = self._normalize_media_kind(fallback_kind or data.get("type") or data.get("kind") or "")
        if kind:
            raw_data = data.get("data") if isinstance(data.get("data"), dict) else data
            return kind, raw_data
        element_type = str(data.get("elementType") or "")
        if element_type == "2":
            return "image", data
        if element_type == "3":
            return "file", data
        if element_type == "4":
            return "record", data
        if element_type == "5":
            return "video", data
        return "", {}

    @staticmethod
    def _media_source_keys(kind: str) -> tuple[str, ...]:
        normalized = ChatArchiveStore._normalize_media_kind(kind)
        common_tail = (
            "source",
            "path",
            "filePath",
            "file_path",
            "localPath",
            "file",
            "file_id",
            "fileId",
            "file_",
            "fileUuid",
            "fileUUID",
            "fileSubId",
            "md5HexStr",
            "md5",
        )
        if normalized == "image":
            return (
                "originImageUrl",
                "origin_image_url",
                "picUrl",
                "pic_url",
                "thumbUrl",
                "thumb_url",
                "previewUrl",
                "preview_url",
                "url",
                "fileUrl",
                "file_url",
                "imageUrl",
                "image_url",
                "faceUrl",
                "face_url",
                "emojiWebUrl",
                "emojiUrl",
                "emoji_url",
                "rawUrl",
                "downloadUrl",
                "download_url",
                "sourcePath",
                "thumbPath",
                "thumb_path",
                *common_tail,
            )
        if normalized == "video":
            return ("videoUrl", "video_url", "url", "fileUrl", "file_url", "downloadUrl", "download_url", "thumbPath", "thumb_path", "thumbUrl", "thumb_url", "coverUrl", "cover_url", "previewUrl", "preview_url", *common_tail)
        if normalized == "record":
            return ("audioUrl", "audio_url", "recordUrl", "record_url", "pttUrl", "ptt_url", "url", "fileUrl", "file_url", "downloadUrl", "download_url", "audioPath", "audio_path", "filePath", *common_tail)
        return ("url", "fileUrl", "file_url", "downloadUrl", "download_url", *common_tail)

    @staticmethod
    def _normalize_media_kind(kind: Any) -> str:
        value = str(kind or "").strip().lower()
        if value in {"image", "img", "pic", "picture"} or "image" in value or "pic" in value:
            return "image"
        if value in {"video"} or "video" in value:
            return "video"
        if value in {"record", "audio", "voice", "ptt"} or any(token in value for token in ("record", "audio", "voice", "ptt")):
            return "record"
        if value in {"file"} or "file" in value:
            return "file"
        return ""

    def _first_media_value(self, data: Any, keys: tuple[str, ...]) -> str:
        if isinstance(data, str):
            return data
        if isinstance(data, list):
            return str(data[0] or "") if data else ""
        if not isinstance(data, dict):
            return ""
        for key in keys:
            value = data.get(key)
            if isinstance(value, str) and value:
                return value
            if isinstance(value, list) and value:
                return str(value[0] or "")
            if isinstance(value, dict) and value:
                first = next((str(item) for item in value.values() if item), "")
                if first:
                    return first
        for key in ("data", "meta", "extra"):
            nested = data.get(key)
            if isinstance(nested, dict):
                found = self._first_media_value(nested, keys)
                if found:
                    return found
        return ""

    @staticmethod
    def _normalize_qpic_source(source: Any) -> str:
        value = str(source or "").strip()
        if value.startswith("//"):
            return "https:" + value
        if value.startswith("http://gchat.qpic.cn/"):
            return "https://" + value[len("http://") :]
        if value.startswith("/"):
            return "https://gchat.qpic.cn" + value
        return value

    @staticmethod
    def _market_face_source(data: dict[str, Any]) -> str:
        emoji_id = str(data.get("emojiId") or data.get("emoji_id") or data.get("id") or "").strip()
        if not emoji_id:
            return ""
        sizes = data.get("supportSize")
        size = sizes[0] if isinstance(sizes, list) and sizes and isinstance(sizes[0], dict) else {}
        width = min(int(size.get("width") or 120), 300)
        return f"https://gxh.vip.qq.com/club/item/parcel/item/{emoji_id[:2]}/{emoji_id}/raw{width}.gif"

    def _prepare_media_for_write(self, entries: list[dict[str, Any]]) -> None:
        for entry in entries:
            payload = entry.get("payload") or {}
            created_at = int(payload.get("created_at") or time.time())
            media_rows = entry.get("media") or []
            if not isinstance(media_rows, list):
                continue
            for row in media_rows:
                if not isinstance(row, dict):
                    continue
                if row.get("local_path") and row.get("hash"):
                    continue
                source = str(row.get("source") or "")
                if not source:
                    continue
                local_path, relative_path, size, sha256, detected_mime = self._copy_media_file(
                    str(row.get("kind") or ""),
                    source,
                    str(row.get("name") or row.get("kind") or "media"),
                    created_at,
                )
                if local_path:
                    row["local_path"] = local_path
                if relative_path:
                    row["relative_path"] = relative_path
                if size is not None:
                    row["size"] = size
                if sha256:
                    row["hash"] = sha256
                if detected_mime and not row.get("mime"):
                    row["mime"] = detected_mime

    def _copy_media_file(self, kind: str, source: str, name: str, created_at: int) -> tuple[str | None, str | None, int | None, str | None, str | None]:
        if not self.config.capture_media_files or not source:
            return None, None, None, None, None
        if source.startswith(("http://", "https://")):
            return self._download_remote_media(kind, source, name, created_at)
        if source.startswith(("base64://", "data:")):
            return self._copy_embedded_media(kind, source, name, created_at)
        source_path = source
        if source_path.startswith("file:///"):
            try:
                parsed = urlparse(source_path)
                source_path = unquote(parsed.path)
                if os.name == "nt" and source_path.startswith("/"):
                    source_path = source_path[1:]
            except Exception:
                return None, None, None, None, None
        try:
            src = Path(source_path)
            if not src.exists() or not src.is_file():
                return None, None, None, None, None
            size = src.stat().st_size
            if size > max(1, int(self.config.max_media_mb)) * 1024 * 1024:
                return None, None, size, None, None
            sha256 = self._file_sha256(src)
            suffix = src.suffix or Path(_safe_name(name)).suffix
            target = self._media_target_path(kind, created_at, sha256, suffix)
            if not target.exists():
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, target)
            detected_mime = self._detect_media_mime(kind, target) or mimetypes.guess_type(target.name)[0]
            return str(target), str(target.relative_to(self.data_dir)).replace("\\", "/"), size, sha256, detected_mime
        except Exception:
            return None, None, None, None, None

    def _copy_embedded_media(self, kind: str, source: str, name: str, created_at: int) -> tuple[str | None, str | None, int | None, str | None, str | None]:
        max_bytes = max(1, int(self.config.max_media_mb)) * 1024 * 1024
        try:
            mime = None
            if source.startswith("base64://"):
                payload = source[len("base64://") :]
            else:
                header, payload = source.split(",", 1)
                if ";base64" not in header.lower():
                    return None, None, None, None, None
                mime = header[5:].split(";", 1)[0].strip().lower() or None
            data = base64.b64decode(payload, validate=True)
            size = len(data)
            if size <= 0 or size > max_bytes:
                return None, None, size, None, mime
            sha256 = hashlib.sha256(data).hexdigest()
            suffix = Path(_safe_name(name)).suffix or mimetypes.guess_extension(mime or "") or ".bin"
            target = self._media_target_path(kind, created_at, sha256, suffix[:16])
            if not target.exists():
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
            detected_mime = self._detect_media_mime(kind, target) or self._normalize_image_mime(mime) or mime or mimetypes.guess_type(target.name)[0]
            return str(target), str(target.relative_to(self.data_dir)).replace("\\", "/"), size, sha256, detected_mime
        except (ValueError, OSError, binascii.Error):
            return None, None, None, None, None

    def _download_remote_media(self, kind: str, source: str, name: str, created_at: int) -> tuple[str | None, str | None, int | None, str | None, str | None]:
        if kind != "image" or not self.config.download_remote_media:
            return None, None, None, None, None
        max_bytes = max(1, int(self.config.max_media_mb)) * 1024 * 1024
        try:
            final_url, response = self._open_remote_media(source, image_only=True)
            with response:
                raw_content_type = response.headers.get("Content-Type")
                content_type = self._normalize_image_mime(raw_content_type)
                if raw_content_type and not content_type and not self._content_type_allows_sniffing(raw_content_type):
                    return None, None, None, None, None
                content_length = response.headers.get("Content-Length")
                if content_length is not None and int(content_length) > max_bytes:
                    return None, None, int(content_length), None, content_type or None

                temp_dir = self.media_dir / ".tmp"
                temp_dir.mkdir(parents=True, exist_ok=True)
                temp_path = temp_dir / f"remote-{uuid.uuid4().hex}.tmp"
                digest = hashlib.sha256()
                size = 0
                try:
                    with temp_path.open("wb") as f:
                        while True:
                            chunk = response.read(1024 * 256)
                            if not chunk:
                                break
                            size += len(chunk)
                            if size > max_bytes:
                                return None, None, size, None, content_type or None
                            digest.update(chunk)
                            f.write(chunk)
                    if size <= 0:
                        return None, None, 0, None, content_type or None
                    detected_type = self._detect_image_mime(temp_path)
                    if not detected_type:
                        if not content_type:
                            return None, None, size, None, None
                        detected_type = content_type
                    content_type = detected_type
                    sha256 = digest.hexdigest()
                    suffix = self._remote_media_suffix(final_url, name, content_type)
                    target = self._media_target_path(kind, created_at, sha256, suffix)
                    if not target.exists():
                        target.parent.mkdir(parents=True, exist_ok=True)
                        temp_path.replace(target)
                        temp_path = None
                    return str(target), str(target.relative_to(self.data_dir)).replace("\\", "/"), size, sha256, content_type or mimetypes.guess_type(target.name)[0]
                finally:
                    if temp_path is not None:
                        try:
                            temp_path.unlink()
                        except FileNotFoundError:
                            pass
        except (OSError, HTTPError, TimeoutError, ValueError):
            return None, None, None, None, None

    def _open_remote_media(self, source: str, *, image_only: bool = True, enforce_allowlist: bool = False):
        current_url = source
        opener = build_opener(_NoRedirectHandler)
        timeout = max(1.0, float(self.config.remote_media_timeout_seconds or 10.0))
        referer_retry = False
        for _ in range(4):
            parsed = urlparse(current_url)
            if parsed.scheme not in {"http", "https"} or not parsed.hostname:
                raise ValueError("unsupported remote media url")
            self._validate_remote_media_host(parsed.hostname)
            if enforce_allowlist:
                self._validate_remote_media_allowed_host(parsed.hostname)
            request = Request(
                current_url,
                headers={
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                    "Accept": "image/webp,image/apng,image/*,*/*;q=0.8" if image_only else "*/*",
                    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
                    **({"Referer": current_url} if referer_retry else {}),
                },
            )
            try:
                response = opener.open(request, timeout=timeout)
            except HTTPError as exc:
                if exc.code in {301, 302, 303, 307, 308}:
                    location = exc.headers.get("Location")
                    if not location:
                        raise
                    current_url = urljoin(current_url, location)
                    referer_retry = False
                    continue
                if exc.code == 403 and not referer_retry:
                    referer_retry = True
                    continue
                raise
            return current_url, response
        raise ValueError("too many remote media redirects")

    def _validate_remote_media_host(self, hostname: str) -> None:
        if self.config.allow_private_remote_media:
            return
        infos = socket.getaddrinfo(hostname, None, type=socket.SOCK_STREAM)
        for info in infos:
            address = info[4][0]
            ip = ipaddress.ip_address(address)
            if not ip.is_global:
                raise ValueError("blocked private remote media address")

    def _validate_remote_media_allowed_host(self, hostname: str) -> None:
        allowed = tuple(str(host or "").strip().lower() for host in (self.config.remote_media_allowed_hosts or ()) if str(host or "").strip())
        if not allowed:
            return
        clean = hostname.lower().rstrip(".")
        for host in allowed:
            if clean == host or clean.endswith("." + host):
                return
        raise ValueError("remote media host is not allowed")

    @staticmethod
    def _normalize_image_mime(value: Any) -> str | None:
        content_type = str(value or "").split(";", 1)[0].strip().lower()
        if not content_type:
            return None
        aliases = {
            "application/jpg": "image/jpeg",
            "application/jpeg": "image/jpeg",
            "application/x-jpg": "image/jpeg",
            "application/x-jpeg": "image/jpeg",
            "application/png": "image/png",
            "application/x-png": "image/png",
            "image/jpg": "image/jpeg",
            "image/pjpeg": "image/jpeg",
            "image/x-jpg": "image/jpeg",
            "image/x-jpeg": "image/jpeg",
            "image/x-png": "image/png",
            "image/apng": "image/apng",
            "image/x-gif": "image/gif",
            "image/x-webp": "image/webp",
            "image/x-bmp": "image/bmp",
            "image/x-ms-bmp": "image/bmp",
            "image/svg": "image/svg+xml",
            "image/x-svg": "image/svg+xml",
            "image/ico": "image/vnd.microsoft.icon",
            "image/icon": "image/vnd.microsoft.icon",
            "image/x-icon": "image/vnd.microsoft.icon",
        }
        content_type = aliases.get(content_type, content_type)
        if content_type in {
            "image/png",
            "image/apng",
            "image/jpeg",
            "image/gif",
            "image/webp",
            "image/bmp",
            "image/avif",
            "image/heic",
            "image/heif",
            "image/svg+xml",
            "image/vnd.microsoft.icon",
        }:
            return content_type
        return None

    @staticmethod
    def _detect_image_mime(path: Path) -> str | None:
        try:
            with path.open("rb") as f:
                header = f.read(512)
        except OSError:
            return None
        if header.startswith(b"\x89PNG\r\n\x1a\n"):
            if b"acTL" in header:
                return "image/apng"
            return "image/png"
        if header.startswith(b"\xff\xd8\xff"):
            return "image/jpeg"
        if header.startswith((b"GIF87a", b"GIF89a")):
            return "image/gif"
        if header.startswith(b"BM"):
            return "image/bmp"
        if header.startswith(b"RIFF") and header[8:12] == b"WEBP":
            return "image/webp"
        if len(header) >= 12 and header[4:8] == b"ftyp":
            brand = header[8:12]
            if brand in {b"avif", b"avis"}:
                return "image/avif"
            if brand in {b"heic", b"heix", b"hevc", b"hevx", b"mif1", b"msf1"}:
                return "image/heic"
        if header.startswith(b"\x00\x00\x01\x00"):
            return "image/vnd.microsoft.icon"
        compact = header.lstrip().lower()
        if compact.startswith((b"<svg", b"<?xml")) and b"<svg" in compact:
            return "image/svg+xml"
        return None

    def detect_image_mime(self, path: Path) -> str | None:
        return self._detect_image_mime(path)

    def _detect_media_mime(self, kind: Any, path: Path) -> str | None:
        media_kind = self._normalize_media_kind(kind) or "file"
        if media_kind == "image":
            return self._detect_image_mime(path) or mimetypes.guess_type(path.name)[0]
        if media_kind == "video":
            return self._detect_video_mime(path) or mimetypes.guess_type(path.name)[0]
        if media_kind == "record":
            return self._detect_audio_mime(path) or mimetypes.guess_type(path.name)[0]
        return (
            self._detect_image_mime(path)
            or self._detect_video_mime(path)
            or self._detect_audio_mime(path)
            or mimetypes.guess_type(path.name)[0]
        )

    @staticmethod
    def _content_type_allows_sniffing(value: Any) -> bool:
        content_type = str(value or "").split(";", 1)[0].strip().lower()
        return content_type in {
            "application/octet-stream",
            "binary/octet-stream",
            "application/x-octet-stream",
            "application/download",
            "application/force-download",
        }

    def _remote_media_suffix(self, url: str, name: str, content_type: str) -> str:
        suffix = Path(_safe_name(name)).suffix or Path(urlparse(url).path).suffix
        if suffix:
            return suffix[:16]
        if content_type == "image/apng":
            return ".png"
        if content_type == "audio/silk":
            return ".silk"
        if content_type == "audio/amr":
            return ".amr"
        guessed = mimetypes.guess_extension(content_type or "")
        return guessed or ".bin"

    def _media_target_path(self, kind: str, created_at: int, sha256: str, suffix: str) -> Path:
        date_part = time.strftime("%Y/%m/%d", time.localtime(created_at))
        return self.media_dir / kind / date_part / f"{sha256}{suffix}"

    @staticmethod
    def _file_sha256(path: Path) -> str:
        digest = hashlib.sha256()
        with path.open("rb") as f:
            for chunk in iter(lambda: f.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest()

    def list_conversations(self) -> list[dict[str, Any]]:
        with self._connection() as conn:
            rows = conn.execute(
                """
                SELECT umo, max(created_at) AS latest_at, count(*) AS message_count,
                       sum(media_count) AS media_count,
                       max(sender_name) AS sample_sender
                FROM messages
                GROUP BY umo
                ORDER BY latest_at DESC
                """
            ).fetchall()
            seen_rows = {
                str(row["umo"]): dict(row)
                for row in conn.execute("SELECT * FROM conversation_state").fetchall()
            }
        conversations: dict[str, dict[str, Any]] = {str(row["umo"]): dict(row) for row in rows}
        for message in self._pending_messages():
            umo = str(message.get("umo") or "")
            if not umo:
                continue
            current = conversations.setdefault(
                umo,
                {
                    "umo": umo,
                    "latest_at": 0,
                    "message_count": 0,
                    "media_count": 0,
                    "sample_sender": "",
                },
            )
            current["latest_at"] = max(int(current.get("latest_at") or 0), int(message.get("created_at") or 0))
            current["message_count"] = int(current.get("message_count") or 0) + 1
            current["media_count"] = int(current.get("media_count") or 0) + int(message.get("media_count") or 0)
            current["sample_sender"] = current.get("sample_sender") or message.get("sender_name")
        with self._connection() as conn:
            for item in conversations.values():
                umo = str(item.get("umo") or "")
                state = seen_rows.get(umo, {})
                last_seen_at = int(state.get("last_seen_at") or 0)
                item["last_seen_at"] = last_seen_at
                item["unread_count"] = int(
                    conn.execute(
                        "SELECT count(*) FROM messages WHERE umo = ? AND created_at > ?",
                        (umo, last_seen_at),
                    ).fetchone()[0]
                    or 0
                )
                item["unread_count"] += sum(
                    1
                    for message in self._pending_messages()
                    if str(message.get("umo") or "") == umo and int(message.get("created_at") or 0) > last_seen_at
                )
        return sorted(conversations.values(), key=lambda item: int(item.get("latest_at") or 0), reverse=True)

    def list_messages(
        self,
        *,
        umo: str = "",
        q: str = "",
        before: int = 0,
        limit: int = 80,
        start_ts: int | None = None,
        end_ts: int | None = None,
        sender: str = "",
        message_type: str = "",
        media_kind: str = "",
        favorite: bool = False,
        tag_id: int | None = None,
    ) -> dict[str, Any]:
        limit = max(1, min(int(limit or 80), 300))
        params: list[Any] = []
        where: list[str] = []
        use_fts = bool(q and self._normalize_search_query(q))
        if umo:
            where.append("m.umo = ?")
            params.append(umo)
        if before:
            where.append("m.created_at < ?")
            params.append(before)
        if start_ts is not None:
            where.append("m.created_at >= ?")
            params.append(int(start_ts))
        if end_ts is not None:
            where.append("m.created_at <= ?")
            params.append(int(end_ts))
        if sender:
            like = f"%{self._escape_like(sender.strip())}%"
            where.append("(m.sender_id LIKE ? ESCAPE '\\' OR m.sender_name LIKE ? ESCAPE '\\')")
            params.extend([like, like])
        if message_type:
            where.append("m.message_type = ?")
            params.append(message_type)
        if media_kind:
            where.append(
                """
                EXISTS (
                    SELECT 1 FROM media mf
                    WHERE mf.message_uid = m.message_uid AND mf.kind = ?
                )
                """
            )
            params.append(media_kind)
        if favorite:
            where.append("EXISTS (SELECT 1 FROM favorite_messages fav WHERE fav.message_uid = m.message_uid)")
        if tag_id is not None:
            where.append("EXISTS (SELECT 1 FROM message_tags mt WHERE mt.message_uid = m.message_uid AND mt.tag_id = ?)")
            params.append(int(tag_id))
        if q and not use_fts:
            like = f"%{self._escape_like(q.strip())}%"
            where.append("(m.text LIKE ? ESCAPE '\\' OR m.sender_name LIKE ? ESCAPE '\\' OR m.raw_json LIKE ? ESCAPE '\\')")
            params.extend([like, like, like])
        clause = ("WHERE " + " AND ".join(where)) if where else ""
        if use_fts:
            fts_query = self._normalize_search_query(q)
            sql = f"""
                SELECT m.* FROM messages m
                JOIN messages_fts fts ON fts.rowid = m.id
                {clause + " AND" if clause else "WHERE"} messages_fts MATCH ?
                ORDER BY m.created_at DESC, m.id DESC
                LIMIT ?
            """
            params.append(fts_query)
        else:
            sql = f"""
                SELECT m.* FROM messages m
                {clause}
                ORDER BY m.created_at DESC, m.id DESC
                LIMIT ?
            """
        params.append(limit)
        with self._connection() as conn:
            messages = [self._message_row_to_dict(row) for row in conn.execute(sql, params).fetchall()]
            uids = [m["message_uid"] for m in messages]
            media_by_uid: dict[str, list[dict[str, Any]]] = {uid: [] for uid in uids}
            if uids:
                placeholders = ",".join("?" for _ in uids)
                for row in conn.execute(f"SELECT * FROM media WHERE message_uid IN ({placeholders}) ORDER BY component_index", uids):
                    item = dict(row)
                    item["meta"] = json.loads(item.pop("meta_json") or "{}")
                    media_by_uid.setdefault(item["message_uid"], []).append(item)
                self._decorate_messages_locked(conn, messages)
        for message in messages:
            message["media"] = media_by_uid.get(message["message_uid"], [])
        pending = [
            item
            for item in self._pending_messages()
            if self._message_matches_filters(
                item,
                umo=umo,
                q=q,
                before=before,
                start_ts=start_ts,
                end_ts=end_ts,
                sender=sender,
                message_type=message_type,
                media_kind=media_kind,
                favorite=favorite,
                tag_id=tag_id,
            )
        ]
        merged = self._dedupe_sort_messages(list(reversed(messages)) + pending)
        return {"items": merged[-limit:], "has_more": len(messages) == limit}

    def _decorate_messages_locked(self, conn: sqlite3.Connection, messages: list[dict[str, Any]]) -> None:
        uids = [str(item.get("message_uid") or "") for item in messages if item.get("message_uid")]
        if not uids:
            return
        placeholders = ",".join("?" for _ in uids)
        favorites = {
            str(row["message_uid"])
            for row in conn.execute(
                f"SELECT message_uid FROM favorite_messages WHERE message_uid IN ({placeholders})",
                uids,
            ).fetchall()
        }
        tags_by_uid: dict[str, list[dict[str, Any]]] = {uid: [] for uid in uids}
        tag_rows = conn.execute(
            f"""
            SELECT mt.message_uid, t.id, t.name, t.color
            FROM message_tags mt
            JOIN tags t ON t.id = mt.tag_id
            WHERE mt.message_uid IN ({placeholders})
            ORDER BY t.name ASC
            """,
            uids,
        ).fetchall()
        for row in tag_rows:
            tags_by_uid.setdefault(str(row["message_uid"]), []).append(
                {"id": int(row["id"]), "name": row["name"], "color": row["color"]}
            )
        for item in messages:
            uid = str(item.get("message_uid") or "")
            item["favorite"] = uid in favorites
            item["tags"] = tags_by_uid.get(uid, [])

    def _message_matches_filters(
        self,
        item: dict[str, Any],
        *,
        umo: str,
        q: str,
        before: int,
        start_ts: int | None = None,
        end_ts: int | None = None,
        sender: str = "",
        message_type: str = "",
        media_kind: str = "",
        favorite: bool = False,
        tag_id: int | None = None,
    ) -> bool:
        if umo and item.get("umo") != umo:
            return False
        created_at = int(item.get("created_at") or 0)
        if before and created_at >= before:
            return False
        if start_ts is not None and created_at < int(start_ts):
            return False
        if end_ts is not None and created_at > int(end_ts):
            return False
        if sender:
            needle = sender.strip().lower()
            sender_text = f"{item.get('sender_id') or ''} {item.get('sender_name') or ''}".lower()
            if needle not in sender_text:
                return False
        if message_type and item.get("message_type") != message_type:
            return False
        if media_kind:
            if not any(str(media.get("kind") or "") == media_kind for media in item.get("media") or []):
                return False
        if favorite and not item.get("favorite"):
            return False
        if tag_id is not None:
            if not any(int(tag.get("id") or 0) == int(tag_id) for tag in item.get("tags") or []):
                return False
        if q:
            needle = q.strip().lower()
            haystack = "\n".join(
                [
                    str(item.get("text") or ""),
                    str(item.get("sender_name") or ""),
                    _json_dumps(item.get("raw") or {}),
                ]
            ).lower()
            if needle not in haystack:
                return False
        return True

    def search_suggestions(self, *, umo: str = "") -> dict[str, Any]:
        where = "WHERE umo = ?" if umo else ""
        params: list[Any] = [umo] if umo else []
        with self._connection() as conn:
            senders = [
                dict(row)
                for row in conn.execute(
                    f"""
                    SELECT sender_id, sender_name, count(*) AS count
                    FROM messages
                    {where}
                    GROUP BY sender_id, sender_name
                    ORDER BY count DESC, sender_name ASC
                    LIMIT 80
                    """,
                    params,
                ).fetchall()
            ]
            message_types = [
                dict(row)
                for row in conn.execute(
                    f"""
                    SELECT message_type AS value, count(*) AS count
                    FROM messages
                    {where}
                    GROUP BY message_type
                    ORDER BY count DESC
                    """,
                    params,
                ).fetchall()
            ]
            media_kinds = [
                dict(row)
                for row in conn.execute(
                    """
                    SELECT media.kind AS value, count(*) AS count
                    FROM media
                    JOIN messages ON messages.message_uid = media.message_uid
                    """ + ("WHERE messages.umo = ?" if umo else "") + """
                    GROUP BY media.kind
                    ORDER BY count DESC
                    """,
                    params,
                ).fetchall()
            ]
            tags = [
                {
                    **dict(row),
                    "message_count": int(row["message_count"] or 0),
                }
                for row in conn.execute(
                    """
                    SELECT t.id, t.name, t.color, count(mt.message_uid) AS message_count
                    FROM tags t
                    LEFT JOIN message_tags mt ON mt.tag_id = t.id
                    GROUP BY t.id
                    ORDER BY t.name ASC
                    """
                ).fetchall()
            ]
        return {"senders": senders, "message_types": message_types, "media_kinds": media_kinds, "tags": tags}

    def set_favorite(self, message_uid: str, favorite: bool) -> dict[str, Any]:
        uid = str(message_uid or "").strip()
        if not uid:
            raise ValueError("message_uid is required")
        with self._connection() as conn:
            row = conn.execute("SELECT message_uid FROM messages WHERE message_uid = ?", (uid,)).fetchone()
            if not row:
                raise ValueError("message not found")
            if favorite:
                conn.execute(
                    "INSERT OR IGNORE INTO favorite_messages (message_uid, created_at) VALUES (?, ?)",
                    (uid, int(time.time())),
                )
            else:
                conn.execute("DELETE FROM favorite_messages WHERE message_uid = ?", (uid,))
            return {"message_uid": uid, "favorite": bool(favorite)}

    def list_tags(self) -> list[dict[str, Any]]:
        with self._connection() as conn:
            rows = conn.execute(
                """
                SELECT t.id, t.name, t.color, t.created_at, t.updated_at, count(mt.message_uid) AS message_count
                FROM tags t
                LEFT JOIN message_tags mt ON mt.tag_id = t.id
                GROUP BY t.id
                ORDER BY t.name ASC
                """
            ).fetchall()
        return [{**dict(row), "message_count": int(row["message_count"] or 0)} for row in rows]

    def upsert_tag(self, name: str, color: str = "") -> dict[str, Any]:
        clean_name = self._clean_tag_name(name)
        clean_color = self._clean_tag_color(color)
        now = int(time.time())
        with self._connection() as conn:
            conn.execute(
                """
                INSERT INTO tags (name, color, created_at, updated_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(name) DO UPDATE SET
                    color = CASE WHEN excluded.color != '' THEN excluded.color ELSE tags.color END,
                    updated_at = excluded.updated_at
                """,
                (clean_name, clean_color, now, now),
            )
            row = conn.execute("SELECT * FROM tags WHERE name = ?", (clean_name,)).fetchone()
        return dict(row)

    def delete_tag(self, tag_id: int) -> bool:
        with self._connection() as conn:
            row = conn.execute("SELECT id FROM tags WHERE id = ?", (int(tag_id),)).fetchone()
            if not row:
                return False
            conn.execute("DELETE FROM tags WHERE id = ?", (int(tag_id),))
            return True

    def set_message_tag(self, message_uid: str, tag_id: int, enabled: bool) -> dict[str, Any]:
        uid = str(message_uid or "").strip()
        if not uid:
            raise ValueError("message_uid is required")
        now = int(time.time())
        with self._connection() as conn:
            if not conn.execute("SELECT 1 FROM messages WHERE message_uid = ?", (uid,)).fetchone():
                raise ValueError("message not found")
            if not conn.execute("SELECT 1 FROM tags WHERE id = ?", (int(tag_id),)).fetchone():
                raise ValueError("tag not found")
            if enabled:
                conn.execute(
                    "INSERT OR IGNORE INTO message_tags (message_uid, tag_id, created_at) VALUES (?, ?, ?)",
                    (uid, int(tag_id), now),
                )
            else:
                conn.execute(
                    "DELETE FROM message_tags WHERE message_uid = ? AND tag_id = ?",
                    (uid, int(tag_id)),
                )
            messages = [{"message_uid": uid}]
            self._decorate_messages_locked(conn, messages)
            return {"message_uid": uid, "tags": messages[0]["tags"]}

    def record_search_history(self, query: str, filters: dict[str, Any] | None = None, *, hit_count: int = 0) -> dict[str, Any]:
        clean_query = str(query or "").strip()
        clean_filters = self._clean_search_filters(filters or {})
        if not clean_query and not clean_filters:
            return {"recorded": False}
        filters_json = _json_dumps(clean_filters)
        now = int(time.time())
        with self._connection() as conn:
            conn.execute(
                """
                INSERT INTO search_history (query, filters_json, hit_count, used_count, created_at, updated_at)
                VALUES (?, ?, ?, 1, ?, ?)
                ON CONFLICT(query, filters_json) DO UPDATE SET
                    hit_count = excluded.hit_count,
                    used_count = search_history.used_count + 1,
                    updated_at = excluded.updated_at
                """,
                (clean_query, filters_json, int(hit_count or 0), now, now),
            )
            row = conn.execute(
                "SELECT * FROM search_history WHERE query = ? AND filters_json = ?",
                (clean_query, filters_json),
            ).fetchone()
        item = dict(row)
        item["filters"] = json.loads(item.pop("filters_json") or "{}")
        item["recorded"] = True
        return item

    def list_search_history(self, limit: int = 20) -> list[dict[str, Any]]:
        limit = max(1, min(int(limit or 20), 100))
        with self._connection() as conn:
            rows = conn.execute(
                """
                SELECT * FROM search_history
                ORDER BY updated_at DESC, id DESC
                LIMIT ?
                """,
                (limit,),
            ).fetchall()
        items = []
        for row in rows:
            item = dict(row)
            item["filters"] = json.loads(item.pop("filters_json") or "{}")
            items.append(item)
        return items

    def clear_search_history(self) -> int:
        with self._connection() as conn:
            count = int(conn.execute("SELECT count(*) FROM search_history").fetchone()[0] or 0)
            conn.execute("DELETE FROM search_history")
            return count

    def mark_conversation_seen(self, umo: str, message_uid: str = "", seen_at: int | None = None) -> dict[str, Any]:
        clean_umo = str(umo or "").strip()
        if not clean_umo:
            clean_umo = "__all__"
        now = int(time.time())
        if seen_at is None:
            seen_at = now
            if message_uid:
                with self._connection() as conn:
                    row = conn.execute("SELECT created_at FROM messages WHERE message_uid = ?", (message_uid,)).fetchone()
                    if row:
                        seen_at = int(row["created_at"] or seen_at)
        with self._connection() as conn:
            conn.execute(
                """
                INSERT INTO conversation_state (umo, last_seen_at, last_seen_message_uid, updated_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(umo) DO UPDATE SET
                    last_seen_at = excluded.last_seen_at,
                    last_seen_message_uid = excluded.last_seen_message_uid,
                    updated_at = excluded.updated_at
                """,
                (clean_umo, int(seen_at or now), str(message_uid or ""), now),
            )
            return dict(conn.execute("SELECT * FROM conversation_state WHERE umo = ?", (clean_umo,)).fetchone())

    def get_ui_settings(self) -> dict[str, Any]:
        with self._connection() as conn:
            settings = self._get_meta_locked(conn, "ui_settings", {})
        defaults = {
            "poll_interval_seconds": 15,
            "auto_scroll": True,
            "compact_mode": False,
            "show_status_strip": True,
            "theme": "system",
        }
        if isinstance(settings, dict):
            defaults.update({key: settings[key] for key in defaults.keys() & settings.keys()})
        defaults["poll_interval_seconds"] = max(5, min(int(defaults.get("poll_interval_seconds") or 15), 120))
        defaults["theme"] = defaults["theme"] if defaults.get("theme") in {"system", "light", "dark"} else "system"
        return defaults

    def update_ui_settings(self, settings: dict[str, Any]) -> dict[str, Any]:
        current = self.get_ui_settings()
        incoming = settings or {}
        for key in ["auto_scroll", "compact_mode", "show_status_strip"]:
            if key in incoming:
                current[key] = bool(incoming[key])
        if "poll_interval_seconds" in incoming:
            current["poll_interval_seconds"] = max(5, min(int(incoming.get("poll_interval_seconds") or 15), 120))
        if incoming.get("theme") in {"system", "light", "dark"}:
            current["theme"] = incoming["theme"]
        with self._connection() as conn:
            self._set_meta_locked(conn, "ui_settings", current)
        return current

    def _iter_message_rows(
        self,
        conn: sqlite3.Connection,
        *,
        start_ts: int | None = None,
        end_ts: int | None = None,
        umo: str = "",
        sender: str = "",
        message_type: str = "",
        media_kind: str = "",
        q: str = "",
        favorite: bool = False,
        tag_id: int | None = None,
        snapshot_max_id: int | None = None,
        page_size: int = 500,
    ):
        page_size = max(1, min(int(page_size or 500), 2000))
        last_id = 0
        while True:
            where = ["m.id > ?"]
            params: list[Any] = [last_id]
            if snapshot_max_id is not None:
                where.append("m.id <= ?")
                params.append(int(snapshot_max_id))
            if start_ts is not None:
                where.append("m.created_at >= ?")
                params.append(int(start_ts))
            if end_ts is not None:
                where.append("m.created_at <= ?")
                params.append(int(end_ts))
            if umo:
                where.append("m.umo = ?")
                params.append(umo)
            if sender:
                like = f"%{self._escape_like(sender.strip())}%"
                where.append("(m.sender_id LIKE ? ESCAPE '\\' OR m.sender_name LIKE ? ESCAPE '\\')")
                params.extend([like, like])
            if message_type:
                where.append("m.message_type = ?")
                params.append(message_type)
            if media_kind:
                where.append(
                    """
                    EXISTS (
                        SELECT 1 FROM media mf
                        WHERE mf.message_uid = m.message_uid AND mf.kind = ?
                    )
                    """
                )
                params.append(media_kind)
            if favorite:
                where.append("EXISTS (SELECT 1 FROM favorite_messages fav WHERE fav.message_uid = m.message_uid)")
            if tag_id is not None:
                where.append("EXISTS (SELECT 1 FROM message_tags mt WHERE mt.message_uid = m.message_uid AND mt.tag_id = ?)")
                params.append(int(tag_id))
            if q:
                like = f"%{self._escape_like(q.strip())}%"
                where.append("(m.text LIKE ? ESCAPE '\\' OR m.sender_name LIKE ? ESCAPE '\\' OR m.raw_json LIKE ? ESCAPE '\\')")
                params.extend([like, like, like])
            sql = f"""
                SELECT m.* FROM messages m
                WHERE {" AND ".join(where)}
                ORDER BY m.id ASC
                LIMIT ?
            """
            params.append(page_size)
            rows = conn.execute(sql, params).fetchall()
            if not rows:
                break
            page_messages: list[dict[str, Any]] = []
            for row in rows:
                last_id = int(row["id"])
                message = self._message_row_to_dict(row)
                message["media"] = self._media_for_message_locked(conn, message["message_uid"])
                page_messages.append(message)
            self._decorate_messages_locked(conn, page_messages)
            for message in page_messages:
                yield message

    @staticmethod
    def _media_for_message_locked(conn: sqlite3.Connection, message_uid: str) -> list[dict[str, Any]]:
        media = []
        for row in conn.execute("SELECT * FROM media WHERE message_uid = ? ORDER BY component_index", (message_uid,)).fetchall():
            item = dict(row)
            item["meta"] = json.loads(item.pop("meta_json") or "{}")
            media.append(item)
        return media

    def _export_filters(
        self,
        *,
        start_ts: int | None = None,
        end_ts: int | None = None,
        umo: str = "",
        sender: str = "",
        message_type: str = "",
        media_kind: str = "",
        q: str = "",
        favorite: bool = False,
        tag_id: int | None = None,
    ) -> dict[str, Any]:
        return {
            "start_ts": start_ts,
            "end_ts": end_ts,
            "umo": umo,
            "sender": sender,
            "message_type": message_type,
            "media_kind": media_kind,
            "q": q,
            "favorite": favorite,
            "tag_id": tag_id,
        }

    def export_archive(
        self,
        *,
        format: str = "json",
        output_name: str | None = None,
        start_ts: int | None = None,
        end_ts: int | None = None,
        umo: str = "",
        sender: str = "",
        message_type: str = "",
        media_kind: str = "",
        q: str = "",
        favorite: bool = False,
        tag_id: int | None = None,
        include_media: bool = False,
        page_size: int = 500,
    ) -> Path:
        fmt = str(format or "json").lower().strip()
        if fmt not in {"json", "markdown", "md", "txt", "html", "zip"}:
            raise ValueError(f"unsupported export format: {format}")
        if fmt == "md":
            fmt = "markdown"
        suffix = {"json": ".json", "markdown": ".md", "txt": ".txt", "html": ".html", "zip": ".zip"}[fmt]
        output = self.export_dir / (output_name or f"chat_archive_{int(time.time())}{suffix}")
        with self._connection() as conn:
            snapshot_max_id = int(conn.execute("SELECT coalesce(max(id), 0) FROM messages").fetchone()[0] or 0)
            filters = self._export_filters(
                start_ts=start_ts,
                end_ts=end_ts,
                umo=umo,
                sender=sender,
                message_type=message_type,
                media_kind=media_kind,
                q=q,
                favorite=favorite,
                tag_id=tag_id,
            )
            if fmt == "json":
                self._write_export_json(conn, output, snapshot_max_id=snapshot_max_id, page_size=page_size, **filters)
            elif fmt == "markdown":
                self._write_export_markdown(conn, output, snapshot_max_id=snapshot_max_id, page_size=page_size, **filters)
            elif fmt == "txt":
                self._write_export_txt(conn, output, snapshot_max_id=snapshot_max_id, page_size=page_size, **filters)
            elif fmt == "html":
                self._write_export_html(conn, output, snapshot_max_id=snapshot_max_id, page_size=page_size, **filters)
            elif fmt == "zip":
                self._write_export_zip(
                    conn,
                    output,
                    snapshot_max_id=snapshot_max_id,
                    include_media=include_media,
                    page_size=page_size,
                    **filters,
                )
        return output

    def _write_export_json(self, conn: sqlite3.Connection, output: Path, *, snapshot_max_id: int, page_size: int, **filters) -> None:
        first = True
        with output.open("w", encoding="utf-8") as f:
            f.write("[\n")
            for message in self._iter_message_rows(conn, snapshot_max_id=snapshot_max_id, page_size=page_size, **filters):
                if not first:
                    f.write(",\n")
                f.write(json.dumps(message, ensure_ascii=False, indent=2))
                first = False
            f.write("\n]\n")

    def _write_export_markdown(self, conn: sqlite3.Connection, output: Path, *, snapshot_max_id: int, page_size: int, **filters) -> None:
        with output.open("w", encoding="utf-8") as f:
            f.write("# 聊天归档导出\n\n")
            for message in self._iter_message_rows(conn, snapshot_max_id=snapshot_max_id, page_size=page_size, **filters):
                f.write(f"## {self._format_export_time(message.get('created_at'))} - {message.get('sender_name') or message.get('sender_id') or '未知用户'}\n\n")
                if message.get("text"):
                    f.write(str(message["text"]).strip() + "\n\n")
                for media in message.get("media") or []:
                    f.write(f"- 媒体: {media.get('kind') or 'file'} / {media.get('name') or media.get('source') or media.get('id')}\n")
                f.write("\n")

    def _write_export_txt(self, conn: sqlite3.Connection, output: Path, *, snapshot_max_id: int, page_size: int, **filters) -> None:
        with output.open("w", encoding="utf-8") as f:
            for message in self._iter_message_rows(conn, snapshot_max_id=snapshot_max_id, page_size=page_size, **filters):
                sender = message.get("sender_name") or message.get("sender_id") or "未知用户"
                f.write(f"[{self._format_export_time(message.get('created_at'))}] {sender}: {message.get('text') or ''}\n")
                for media in message.get("media") or []:
                    f.write(f"  [媒体] {media.get('kind') or 'file'} {media.get('name') or media.get('source') or media.get('id')}\n")

    def _write_export_html(self, conn: sqlite3.Connection, output: Path, *, snapshot_max_id: int, page_size: int, **filters) -> None:
        with output.open("w", encoding="utf-8") as f:
            f.write("""<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>聊天归档导出</title><style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif;background:#eef3f8;color:#17212b;margin:0;padding:24px}.msg{max-width:860px;margin:0 auto 10px;padding:12px 14px;background:#fff;border:1px solid rgba(23,33,43,.1);border-radius:10px}.meta{color:#8492a0;font-size:12px;margin-bottom:6px}.text{white-space:pre-wrap;line-height:1.5}.media{margin-top:8px;color:#52616f;font-size:13px}</style></head><body><main><h1>聊天归档导出</h1>""")
            for message in self._iter_message_rows(conn, snapshot_max_id=snapshot_max_id, page_size=page_size, **filters):
                sender = self._html_escape(message.get("sender_name") or message.get("sender_id") or "未知用户")
                text = self._html_escape(message.get("text") or "")
                f.write(f"<article class=\"msg\"><div class=\"meta\">{self._format_export_time(message.get('created_at'))} · {sender}</div><div class=\"text\">{text}</div>")
                for media in message.get("media") or []:
                    label = self._html_escape(f"{media.get('kind') or 'file'} / {media.get('name') or media.get('source') or media.get('id')}")
                    f.write(f"<div class=\"media\">媒体: {label}</div>")
                f.write("</article>")
            f.write("</main></body></html>")

    def _write_export_zip(
        self,
        conn: sqlite3.Connection,
        output: Path,
        *,
        snapshot_max_id: int,
        include_media: bool,
        page_size: int,
        **filters,
    ) -> None:
        manifest: list[dict[str, Any]] = []
        media_paths: list[tuple[Path, str]] = []
        for message in self._iter_message_rows(conn, snapshot_max_id=snapshot_max_id, page_size=page_size, **filters):
            manifest.append(message)
            if include_media:
                for media in message.get("media") or []:
                    path = Path(str(media.get("local_path") or ""))
                    rel = str(media.get("relative_path") or path.name)
                    try:
                        resolved = path.resolve()
                        media_root = self.media_dir.resolve()
                        if resolved.exists() and resolved.is_file() and resolved != media_root and media_root in resolved.parents:
                            safe_rel = rel.replace("\\", "/").lstrip("/")
                            media_paths.append((resolved, f"media/{safe_rel}"))
                    except Exception:
                        continue
        with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            zf.writestr("messages.json", json.dumps(manifest, ensure_ascii=False, indent=2))
            zf.writestr("messages.md", self._messages_to_markdown(manifest))
            seen: set[str] = set()
            for path, arcname in media_paths:
                if arcname in seen:
                    continue
                seen.add(arcname)
                zf.write(path, arcname)

    def _messages_to_markdown(self, messages: list[dict[str, Any]]) -> str:
        lines = ["# 聊天归档导出", ""]
        for message in messages:
            sender = message.get("sender_name") or message.get("sender_id") or "未知用户"
            lines.extend([f"## {self._format_export_time(message.get('created_at'))} - {sender}", ""])
            if message.get("text"):
                lines.extend([str(message["text"]).strip(), ""])
            for media in message.get("media") or []:
                lines.append(f"- 媒体: {media.get('kind') or 'file'} / {media.get('name') or media.get('source') or media.get('id')}")
            lines.append("")
        return "\n".join(lines)

    @staticmethod
    def _format_export_time(timestamp: Any) -> str:
        if not timestamp:
            return ""
        return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(int(timestamp)))

    @staticmethod
    def _html_escape(value: Any) -> str:
        return (
            str(value or "")
            .replace("&", "&amp;")
            .replace("<", "&lt;")
            .replace(">", "&gt;")
            .replace('"', "&quot;")
            .replace("'", "&#039;")
        )

    def get_media_file(self, media_id: str | int) -> dict[str, Any] | None:
        text_id = str(media_id).strip()
        if not text_id.isdigit():
            return None
        numeric_id = int(text_id)
        if numeric_id <= 0:
            return None
        with self._connection() as conn:
            row = conn.execute("SELECT * FROM media WHERE id = ?", (numeric_id,)).fetchone()
        if not row or not row["local_path"]:
            return None
        item = dict(row)
        path = Path(str(item["local_path"]))
        try:
            resolved_path = path.resolve()
            media_root = self.media_dir.resolve()
            if resolved_path != media_root and media_root not in resolved_path.parents:
                return None
        except Exception:
            return None
        detected_mime = self._detect_media_mime(item.get("kind"), resolved_path)
        if detected_mime:
            item["mime"] = detected_mime
        item["path"] = resolved_path
        return item

    def get_safe_media_path(self, value: str) -> dict[str, Any] | None:
        text = str(value or "").strip()
        if not text:
            return None
        candidates = []
        if text.startswith("media/"):
            candidates.append(self.data_dir / text)
        candidates.append(Path(text))
        media_root = self.media_dir.resolve()
        for path in candidates:
            try:
                resolved = path.resolve()
            except Exception:
                continue
            if resolved != media_root and media_root not in resolved.parents:
                continue
            if not resolved.exists() or not resolved.is_file():
                continue
            mime = self._detect_media_mime("", resolved) or "application/octet-stream"
            return {"path": resolved, "name": resolved.name, "mime": mime}
        return None

    def get_remote_proxy_file(self, source: str, *, kind: str = "image") -> dict[str, Any] | None:
        if not self.config.proxy_remote_media:
            return None
        url = str(source or "").strip()
        parsed = urlparse(url)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            return None
        media_kind = self._normalize_media_kind(kind) or "image"
        cache_key = hashlib.sha256(f"{media_kind}:{url}".encode("utf-8")).hexdigest()
        meta_path = self.proxy_cache_dir / f"{cache_key}.json"
        cached = self._read_proxy_cache(meta_path)
        if cached:
            try:
                cached_path = (self.proxy_cache_dir / str(cached.get("file") or "")).resolve()
                proxy_root = self.proxy_cache_dir.resolve()
            except Exception:
                cached_path = None
                proxy_root = None
            if cached_path and proxy_root and (cached_path == proxy_root or proxy_root in cached_path.parents) and cached_path.exists() and cached_path.is_file():
                cached_mime = self._detect_remote_media_mime(media_kind, cached_path) or str(cached.get("mime") or mimetypes.guess_type(cached_path.name)[0] or "application/octet-stream")
                return {
                    "path": cached_path,
                    "name": str(cached.get("name") or cached_path.name),
                    "mime": cached_mime,
                }
        max_bytes = max(1, int(self.config.max_media_mb)) * 1024 * 1024
        try:
            final_url, response = self._open_remote_media(url, image_only=media_kind == "image", enforce_allowlist=True)
            with response:
                raw_content_type = response.headers.get("Content-Type")
                content_type = self._normalize_remote_media_mime(media_kind, raw_content_type)
                if raw_content_type and not content_type and not self._content_type_allows_sniffing(raw_content_type):
                    return None
                content_length = response.headers.get("Content-Length")
                if content_length is not None and int(content_length) > max_bytes:
                    return None
                temp_path = self.proxy_cache_dir / f"{cache_key}.tmp"
                size = 0
                try:
                    with temp_path.open("wb") as f:
                        while True:
                            chunk = response.read(1024 * 256)
                            if not chunk:
                                break
                            size += len(chunk)
                            if size > max_bytes:
                                return None
                            f.write(chunk)
                    detected = self._detect_remote_media_mime(media_kind, temp_path) or content_type
                    if not detected:
                        detected = mimetypes.guess_type(Path(urlparse(final_url).path).name)[0]
                    if not self._remote_media_mime_allowed(media_kind, detected):
                        return None
                    suffix = self._remote_media_suffix(final_url, Path(urlparse(final_url).path).name or f"remote-{media_kind}", detected or "application/octet-stream")
                    file_name = f"{cache_key}{suffix}"
                    target = self.proxy_cache_dir / file_name
                    if not target.exists():
                        temp_path.replace(target)
                        temp_path = None
                    meta = {
                        "file": file_name,
                        "name": _safe_name(Path(urlparse(final_url).path).name or file_name, file_name),
                        "mime": detected or "application/octet-stream",
                        "source": url,
                        "kind": media_kind,
                        "fetched_at": int(time.time()),
                        "size": target.stat().st_size,
                    }
                    meta_path.write_text(_json_dumps(meta), encoding="utf-8")
                    return {"path": target, "name": meta["name"], "mime": meta["mime"]}
                finally:
                    if temp_path is not None:
                        try:
                            temp_path.unlink()
                        except FileNotFoundError:
                            pass
        except (OSError, HTTPError, TimeoutError, ValueError):
            return None

    def _detect_remote_media_mime(self, kind: str, path: Path) -> str | None:
        media_kind = self._normalize_media_kind(kind) or "file"
        if media_kind == "image":
            return self._detect_image_mime(path)
        if media_kind == "video":
            return self._detect_video_mime(path)
        if media_kind == "record":
            return self._detect_audio_mime(path)
        guessed = mimetypes.guess_type(path.name)[0]
        if self._remote_media_mime_allowed(media_kind, guessed):
            return guessed
        return None

    @staticmethod
    def _detect_video_mime(path: Path) -> str | None:
        try:
            with path.open("rb") as f:
                header = f.read(64)
        except OSError:
            return None
        if len(header) >= 12 and header[4:8] == b"ftyp":
            brand = header[8:12]
            if brand in {b"isom", b"iso2", b"mp41", b"mp42", b"avc1", b"dash", b"M4V "}:
                return "video/mp4"
        if header.startswith(b"\x1a\x45\xdf\xa3"):
            return "video/webm"
        if header.startswith(b"RIFF") and header[8:12] == b"AVI ":
            return "video/x-msvideo"
        return None

    @staticmethod
    def _detect_audio_mime(path: Path) -> str | None:
        try:
            with path.open("rb") as f:
                header = f.read(64)
        except OSError:
            return None
        if header.startswith(b"ID3") or header.startswith(b"\xff\xfb") or header.startswith(b"\xff\xf3") or header.startswith(b"\xff\xf2"):
            return "audio/mpeg"
        if header.startswith(b"OggS"):
            return "audio/ogg"
        if header.startswith(b"RIFF") and header[8:12] == b"WAVE":
            return "audio/wav"
        if len(header) >= 12 and header[4:8] == b"ftyp":
            return "audio/mp4"
        if header.startswith(b"#!SILK"):
            return "audio/silk"
        if header.startswith(b"#!AMR"):
            return "audio/amr"
        return None

    @staticmethod
    def _normalize_remote_media_mime(kind: str, value: Any) -> str | None:
        content_type = str(value or "").split(";", 1)[0].strip().lower()
        if not content_type:
            return None
        media_kind = ChatArchiveStore._normalize_media_kind(kind) or "file"
        if media_kind == "image":
            return ChatArchiveStore._normalize_image_mime(content_type)
        if ChatArchiveStore._remote_media_mime_allowed(media_kind, content_type):
            return content_type
        return None

    @staticmethod
    def _remote_media_mime_allowed(kind: str, mime: Any) -> bool:
        content_type = str(mime or "").split(";", 1)[0].strip().lower()
        if not content_type:
            return False
        media_kind = ChatArchiveStore._normalize_media_kind(kind) or "file"
        if media_kind == "image":
            return ChatArchiveStore._normalize_image_mime(content_type) is not None
        if media_kind == "video":
            return content_type.startswith("video/") or content_type in {"application/octet-stream", "binary/octet-stream", "application/octet-stream; charset=binary"}
        if media_kind == "record":
            return content_type.startswith("audio/") or content_type in {"application/octet-stream", "binary/octet-stream", "audio/silk", "audio/amr"}
        return (
            content_type.startswith("application/")
            or content_type.startswith("text/")
            or content_type.startswith("image/")
            or content_type.startswith("video/")
            or content_type.startswith("audio/")
        )

    @staticmethod
    def _read_proxy_cache(path: Path) -> dict[str, Any] | None:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        return data if isinstance(data, dict) else None

    @staticmethod
    def _escape_like(value: str) -> str:
        return str(value or "").replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")

    @staticmethod
    def _normalize_search_query(query: str) -> str:
        words = []
        for raw in str(query or "").replace('"', " ").split():
            word = raw.strip()
            if not word:
                continue
            cleaned = "".join(char for char in word if char.isalnum() or char in "_-")
            if cleaned:
                words.append(f'"{cleaned}"')
        return " ".join(words[:12])

    @staticmethod
    def _clean_tag_name(name: str) -> str:
        cleaned = " ".join(str(name or "").strip().split())
        if not cleaned:
            raise ValueError("tag name is required")
        if len(cleaned) > 40:
            cleaned = cleaned[:40]
        return cleaned

    @staticmethod
    def _clean_tag_color(color: str) -> str:
        value = str(color or "").strip()
        if not value:
            return ""
        if len(value) == 7 and value.startswith("#") and all(char in "0123456789abcdefABCDEF" for char in value[1:]):
            return value
        return ""

    @staticmethod
    def _clean_search_filters(filters: dict[str, Any]) -> dict[str, Any]:
        allowed = {
            "umo",
            "sender",
            "message_type",
            "media_kind",
            "start_ts",
            "end_ts",
            "favorite",
            "tag_id",
        }
        cleaned: dict[str, Any] = {}
        for key in allowed:
            value = filters.get(key)
            if value in (None, "", False):
                continue
            if key in {"start_ts", "end_ts", "tag_id"}:
                try:
                    cleaned[key] = int(value)
                except (TypeError, ValueError):
                    continue
            elif key == "favorite":
                cleaned[key] = bool(value)
            else:
                cleaned[key] = str(value)[:160]
        return cleaned

    def _message_row_to_dict(self, row: sqlite3.Row) -> dict[str, Any]:
        item = dict(row)
        item["raw"] = json.loads(item.pop("raw_json") or "{}")
        item["components"] = json.loads(item.pop("components_json") or "[]")
        return item

    def stats(self) -> dict[str, Any]:
        with self._connection() as conn:
            msg = conn.execute("SELECT count(*) AS c, min(created_at) AS first_at, max(created_at) AS last_at, sum(media_count) AS media FROM messages").fetchone()
            db_umos = {str(row["umo"]) for row in conn.execute("SELECT DISTINCT umo FROM messages").fetchall()}
            media = conn.execute("SELECT kind, count(*) AS c FROM media GROUP BY kind ORDER BY c DESC").fetchall()
            favorite_count = int(conn.execute("SELECT count(*) FROM favorite_messages").fetchone()[0] or 0)
            tag_count = int(conn.execute("SELECT count(*) FROM tags").fetchone()[0] or 0)
            search_history_count = int(conn.execute("SELECT count(*) FROM search_history").fetchone()[0] or 0)
            prune_meta = self._get_meta_locked(conn, "last_prune", {})
            maintenance_meta = self._get_meta_locked(conn, "last_maintenance", {})
            ui_settings = self._get_meta_locked(conn, "ui_settings", {})
        pending = self._pending_messages()
        first_values = [int(item.get("created_at") or 0) for item in pending if item.get("created_at")]
        if msg["first_at"]:
            first_values.append(int(msg["first_at"]))
        last_values = [int(item.get("created_at") or 0) for item in pending if item.get("created_at")]
        if msg["last_at"]:
            last_values.append(int(msg["last_at"]))
        db_bytes = self.db_bytes()
        media_bytes = self.media_bytes()
        storage_bytes = self.storage_bytes()
        max_storage_mb = self.config.max_storage_mb
        usage_percent = None
        if max_storage_mb and float(max_storage_mb) > 0:
            usage_percent = round(storage_bytes / (float(max_storage_mb) * 1024 * 1024) * 100, 2)
        return {
            "messages": int(msg["c"] or 0) + len(pending),
            "conversations": len(db_umos | {str(item.get("umo") or "") for item in pending if item.get("umo")}),
            "media": int(msg["media"] or 0) + sum(int(item.get("media_count") or 0) for item in pending),
            "favorites": favorite_count,
            "tags": tag_count,
            "search_history": search_history_count,
            "first_at": min(first_values) if first_values else None,
            "last_at": max(last_values) if last_values else None,
            "media_by_kind": [dict(row) for row in media],
            "db_path": str(self.db_path),
            "jsonl_path": str(self.jsonl_path),
            "pending_path": str(self.pending_path),
            "media_dir": str(self.media_dir),
            "db_bytes": db_bytes,
            "media_bytes": media_bytes,
            "storage_bytes": storage_bytes,
            "max_storage_mb": max_storage_mb,
            "storage_usage_percent": usage_percent,
            "last_prune_at": prune_meta.get("at") if isinstance(prune_meta, dict) else None,
            "last_prune_removed": int(prune_meta.get("removed") or 0) if isinstance(prune_meta, dict) else 0,
            "last_prune_freed_bytes": int(prune_meta.get("freed_bytes") or 0) if isinstance(prune_meta, dict) else 0,
            "last_maintenance": maintenance_meta if isinstance(maintenance_meta, dict) else {},
            "ui_settings": ui_settings if isinstance(ui_settings, dict) else {},
            "pending": self.pending_count(),
        }

    def integrity_check(self) -> dict[str, Any]:
        issues: list[dict[str, Any]] = []
        with self._connection() as conn:
            integrity_row = conn.execute("PRAGMA integrity_check").fetchone()
            integrity = str(integrity_row[0] if integrity_row else "")
            if integrity.lower() != "ok":
                issues.append({"type": "sqlite_integrity", "detail": integrity})

            foreign_rows = conn.execute("PRAGMA foreign_key_check").fetchall()
            for row in foreign_rows:
                issues.append({"type": "foreign_key", "detail": list(row)})

            stale_sessions = conn.execute(
                """
                SELECT s.session_id, s.message_count, count(m.id) AS actual_count
                FROM sessions s
                LEFT JOIN messages m ON m.session_id = s.session_id
                GROUP BY s.session_id
                HAVING s.message_count != actual_count
                """
            ).fetchall()
            for row in stale_sessions:
                issues.append(
                    {
                        "type": "session_count_mismatch",
                        "session_id": row["session_id"],
                        "expected": int(row["message_count"] or 0),
                        "actual": int(row["actual_count"] or 0),
                    }
                )

            media_missing_messages = conn.execute(
                """
                SELECT media.id, media.message_uid
                FROM media
                LEFT JOIN messages ON messages.message_uid = media.message_uid
                WHERE messages.message_uid IS NULL
                """
            ).fetchall()
            for row in media_missing_messages:
                issues.append({"type": "orphan_media_row", "media_id": int(row["id"]), "message_uid": row["message_uid"]})

            blob_ref_rows = conn.execute(
                """
                SELECT b.hash, b.ref_count, count(m.id) AS actual_count
                FROM media_blobs b
                LEFT JOIN media m ON m.hash = b.hash
                GROUP BY b.hash
                HAVING b.ref_count != actual_count
                """
            ).fetchall()
            for row in blob_ref_rows:
                issues.append(
                    {
                        "type": "media_ref_count_mismatch",
                        "hash": row["hash"],
                        "expected": int(row["ref_count"] or 0),
                        "actual": int(row["actual_count"] or 0),
                    }
                )

            missing_files = conn.execute(
                """
                SELECT hash, local_path
                FROM media_blobs
                WHERE local_path IS NOT NULL AND local_path != ''
                """
            ).fetchall()
            for row in missing_files:
                if not Path(str(row["local_path"])).exists():
                    issues.append({"type": "missing_media_file", "hash": row["hash"]})

            pending_lines = 0
            fallback_lines = 0
            if self.pending_path.exists():
                pending_lines = len([line for line in self.pending_path.read_text(encoding="utf-8", errors="replace").splitlines() if line.strip()])
            if self.fallback_path.exists():
                fallback_lines = len([line for line in self.fallback_path.read_text(encoding="utf-8", errors="replace").splitlines() if line.strip()])

            result = {
                "ok": not issues,
                "checked_at": int(time.time()),
                "sqlite_integrity": integrity,
                "issues": issues,
                "issue_count": len(issues),
                "pending_lines": pending_lines,
                "fallback_lines": fallback_lines,
            }
            self._set_meta_locked(conn, "last_integrity_check", result)
            return result

    def media_gc(self, *, dry_run: bool = False) -> dict[str, Any]:
        removed_files = 0
        removed_file_bytes = 0
        removed_blob_rows = 0
        fixed_ref_counts = 0
        orphan_files: list[str] = []
        with self._connection() as conn:
            actual_counts = {
                str(row["hash"]): int(row["actual_count"] or 0)
                for row in conn.execute(
                    """
                    SELECT hash, count(*) AS actual_count
                    FROM media
                    WHERE hash IS NOT NULL AND hash != ''
                    GROUP BY hash
                    """
                ).fetchall()
            }
            blob_rows = conn.execute("SELECT hash, local_path, ref_count FROM media_blobs").fetchall()
            known_paths = {str(row["local_path"]) for row in blob_rows if row["local_path"]}

            for row in blob_rows:
                media_hash = str(row["hash"] or "")
                actual_count = actual_counts.get(media_hash, 0)
                if actual_count != int(row["ref_count"] or 0):
                    fixed_ref_counts += 1
                    if not dry_run:
                        conn.execute(
                            "UPDATE media_blobs SET ref_count = ?, updated_at = ? WHERE hash = ?",
                            (actual_count, int(time.time()), media_hash),
                        )
                if actual_count > 0:
                    continue
                path = Path(str(row["local_path"] or ""))
                file_bytes = self._safe_media_unlink(path, dry_run=dry_run)
                if file_bytes is not None:
                    removed_files += 1
                    removed_file_bytes += file_bytes
                removed_blob_rows += 1
                if not dry_run:
                    conn.execute("DELETE FROM media_blobs WHERE hash = ?", (media_hash,))

            try:
                for path in self.media_dir.rglob("*"):
                    if not path.is_file():
                        continue
                    path_text = str(path)
                    if path_text in known_paths:
                        continue
                    resolved_path = path.resolve()
                    media_root = self.media_dir.resolve()
                    if resolved_path == media_root or media_root not in resolved_path.parents:
                        continue
                    orphan_files.append(path_text)
                    file_bytes = self._safe_media_unlink(path, dry_run=dry_run)
                    if file_bytes is not None:
                        removed_files += 1
                        removed_file_bytes += file_bytes
            except OSError:
                pass

            result = {
                "at": int(time.time()),
                "dry_run": dry_run,
                "removed_files": removed_files,
                "removed_file_bytes": removed_file_bytes,
                "removed_blob_rows": removed_blob_rows,
                "fixed_ref_counts": fixed_ref_counts,
                "orphan_files": len(orphan_files),
            }
            if not dry_run:
                self._set_meta_locked(conn, "last_media_gc", result)
            return result

    def optimize(self, *, vacuum: bool = False) -> dict[str, Any]:
        before_bytes = self.db_bytes()
        with self._connection() as conn:
            conn.execute("ANALYZE")
            conn.execute("PRAGMA optimize")
            self._set_meta_locked(
                conn,
                "last_maintenance",
                {
                    "at": int(time.time()),
                    "analyze": True,
                    "optimize": True,
                    "vacuum": bool(vacuum),
                },
            )
        if vacuum:
            with self._connection() as conn:
                conn.execute("VACUUM")
        return {
            "at": int(time.time()),
            "analyze": True,
            "optimize": True,
            "vacuum": bool(vacuum),
            "before_bytes": before_bytes,
            "after_bytes": self.db_bytes(),
        }

    def export_json(
        self,
        *,
        output_name: str | None = None,
        start_ts: int | None = None,
        end_ts: int | None = None,
        page_size: int = 500,
        after_snapshot=None,
    ) -> Path:
        output = self.export_dir / (output_name or f"chat_archive_{int(time.time())}.json")
        with self._connection() as conn:
            snapshot_max_id = int(conn.execute("SELECT coalesce(max(id), 0) FROM messages").fetchone()[0] or 0)
            if after_snapshot:
                after_snapshot()
            self._write_export_json(
                conn,
                output,
                snapshot_max_id=snapshot_max_id,
                page_size=page_size,
                start_ts=start_ts,
                end_ts=end_ts,
                umo="",
                sender="",
                message_type="",
                media_kind="",
            )
        return output

    def prune_older_than(self, days: int = 0, *, max_storage_mb: float | None = None) -> int:
        removed = 0
        before_bytes = self.storage_bytes()
        with self._connection() as conn:
            if days and days > 0:
                cutoff = int(time.time()) - max(1, int(days)) * 86400
                rows = conn.execute("SELECT message_uid FROM messages WHERE created_at < ?", (cutoff,)).fetchall()
                removed += len(rows)
                for row in rows:
                    self._delete_message_locked(conn, row["message_uid"])
            limit_mb = max_storage_mb if max_storage_mb is not None else self.config.max_storage_mb
            if limit_mb and float(limit_mb) > 0:
                limit_bytes = int(float(limit_mb) * 1024 * 1024)
                while self.storage_bytes() > limit_bytes:
                    row = conn.execute("SELECT message_uid FROM messages ORDER BY created_at ASC, id ASC LIMIT 1").fetchone()
                    if not row:
                        break
                    self._delete_message_locked(conn, row["message_uid"])
                    removed += 1
            after_bytes = self.storage_bytes()
            self._set_meta_locked(
                conn,
                "last_prune",
                {
                    "at": int(time.time()),
                    "removed": removed,
                    "freed_bytes": max(0, before_bytes - after_bytes),
                    "before_bytes": before_bytes,
                    "after_bytes": after_bytes,
                    "days": int(days or 0),
                    "max_storage_mb": limit_mb,
                },
            )
        return removed

    def delete_message(self, message_uid: str) -> bool:
        with self._connection() as conn:
            exists = conn.execute("SELECT 1 FROM messages WHERE message_uid = ?", (message_uid,)).fetchone()
            if not exists:
                return False
            self._delete_message_locked(conn, message_uid)
            return True

    def _delete_message_locked(self, conn: sqlite3.Connection, message_uid: str) -> None:
        media_rows = conn.execute("SELECT hash FROM media WHERE message_uid = ?", (message_uid,)).fetchall()
        conn.execute("DELETE FROM messages WHERE message_uid = ?", (message_uid,))
        for media_row in media_rows:
            media_hash = media_row["hash"]
            if not media_hash:
                continue
            conn.execute(
                """
                UPDATE media_blobs
                SET ref_count = max(ref_count - 1, 0), updated_at = ?
                WHERE hash = ?
                """,
                (int(time.time()), media_hash),
            )
            blob = conn.execute("SELECT * FROM media_blobs WHERE hash = ?", (media_hash,)).fetchone()
            if blob and int(blob["ref_count"] or 0) <= 0:
                path = Path(blob["local_path"])
                try:
                    resolved_path = path.resolve()
                    media_root = self.media_dir.resolve()
                    if (resolved_path == media_root or media_root in resolved_path.parents) and resolved_path.exists():
                        resolved_path.unlink()
                except Exception:
                    pass
                conn.execute("DELETE FROM media_blobs WHERE hash = ?", (media_hash,))

    def _safe_media_unlink(self, path: Path, *, dry_run: bool = False) -> int | None:
        try:
            resolved_path = path.resolve()
            media_root = self.media_dir.resolve()
            if resolved_path == media_root or media_root not in resolved_path.parents:
                return None
            if not resolved_path.exists() or not resolved_path.is_file():
                return 0
            file_bytes = resolved_path.stat().st_size
            if not dry_run:
                resolved_path.unlink()
            return file_bytes
        except Exception:
            return None

    def storage_bytes(self) -> int:
        return (
            self.db_bytes()
            + self._file_bytes(self.jsonl_path)
            + self._file_bytes(self.fallback_path)
            + self._file_bytes(self.pending_path)
            + self.media_bytes()
            + self._tree_bytes(self.export_dir)
        )

    def db_bytes(self) -> int:
        return sum(
            self._file_bytes(path)
            for path in [
                self.db_path,
                self.db_path.with_name(f"{self.db_path.name}-wal"),
                self.db_path.with_name(f"{self.db_path.name}-shm"),
            ]
        )

    def media_bytes(self) -> int:
        return self._tree_bytes(self.media_dir)

    @staticmethod
    def _file_bytes(path: Path) -> int:
        try:
            if path.exists() and path.is_file():
                return path.stat().st_size
        except OSError:
            return 0
        return 0

    @staticmethod
    def _tree_bytes(root: Path) -> int:
        total = 0
        try:
            for path in root.rglob("*"):
                if path.is_file():
                    total += path.stat().st_size
        except OSError:
            return total
        return total
