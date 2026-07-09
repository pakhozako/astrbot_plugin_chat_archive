from __future__ import annotations

import json
import logging
import sqlite3
import time
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

try:
    from . import archive_config as _archive_config
except ImportError:
    import archive_config as _archive_config

SCHEMA_VERSION = _archive_config.SCHEMA_VERSION
_json_dumps = _archive_config.json_dumps

try:
    from astrbot.api import logger
except ModuleNotFoundError:
    logger = logging.getLogger(__name__)


class SchemaMixin:
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
                CREATE TABLE IF NOT EXISTS forward_archives (
                    forward_id TEXT PRIMARY KEY,
                    title TEXT,
                    summary TEXT,
                    preview_json TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    message_count INTEGER NOT NULL DEFAULT 0,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS forward_refs (
                    forward_id TEXT NOT NULL,
                    message_uid TEXT NOT NULL,
                    platform TEXT,
                    umo TEXT,
                    session_id TEXT,
                    message_id TEXT,
                    created_at INTEGER NOT NULL,
                    PRIMARY KEY(forward_id, message_uid),
                    FOREIGN KEY(forward_id) REFERENCES forward_archives(forward_id) ON DELETE CASCADE,
                    FOREIGN KEY(message_uid) REFERENCES messages(message_uid) ON DELETE CASCADE
                );
                CREATE TABLE IF NOT EXISTS meta (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS schema_migrations (
                    version INTEGER PRIMARY KEY,
                    name TEXT NOT NULL,
                    applied_at INTEGER NOT NULL
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
                CREATE INDEX IF NOT EXISTS idx_forward_archives_updated ON forward_archives(updated_at DESC);
                CREATE INDEX IF NOT EXISTS idx_forward_refs_message ON forward_refs(message_uid);
                CREATE INDEX IF NOT EXISTS idx_forward_refs_forward ON forward_refs(forward_id);
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
            self._ensure_column(conn, "forward_archives", "title", "TEXT")
            self._ensure_column(conn, "forward_archives", "summary", "TEXT")
            self._ensure_column(
                conn, "forward_archives", "preview_json", "TEXT NOT NULL DEFAULT '[]'"
            )
            self._ensure_column(
                conn, "forward_archives", "payload_json", "TEXT NOT NULL DEFAULT '{}'"
            )
            self._ensure_column(
                conn, "forward_archives", "message_count", "INTEGER NOT NULL DEFAULT 0"
            )
            self._ensure_column(
                conn, "forward_archives", "created_at", "INTEGER NOT NULL DEFAULT 0"
            )
            self._ensure_column(
                conn, "forward_archives", "updated_at", "INTEGER NOT NULL DEFAULT 0"
            )
            conn.execute(
                "UPDATE messages SET timestamp = created_at WHERE timestamp IS NULL"
            )
            self._run_migrations(conn)

    @staticmethod
    def _ensure_column(
        conn: sqlite3.Connection, table: str, column: str, definition: str
    ) -> None:
        existing = {
            str(row["name"])
            for row in conn.execute(f"PRAGMA table_info({table})").fetchall()
        }
        if column not in existing:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")

    def _run_migrations(self, conn: sqlite3.Connection) -> None:
        current = self._schema_version_locked(conn)
        if current > SCHEMA_VERSION:
            logger.warning(
                "Chat Archive database schema version %s is newer than plugin schema %s",
                current,
                SCHEMA_VERSION,
            )
            return
        self._record_schema_migration_locked(conn, 1, "baseline")
        if current < 1:
            current = 1
        if current < SCHEMA_VERSION:
            for version in range(current + 1, SCHEMA_VERSION + 1):
                self._record_schema_migration_locked(conn, version, f"schema-{version}")
        conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
        self._set_meta_locked(conn, "schema_version", SCHEMA_VERSION)

    @staticmethod
    def _schema_version_locked(conn: sqlite3.Connection) -> int:
        row = conn.execute("PRAGMA user_version").fetchone()
        try:
            user_version = int(row[0] if row else 0)
        except (TypeError, ValueError):
            user_version = 0
        if user_version > 0:
            return user_version
        row = conn.execute(
            "SELECT value FROM meta WHERE key = ?", ("schema_version",)
        ).fetchone()
        if not row:
            return 0
        try:
            return int(json.loads(row["value"]))
        except (TypeError, ValueError, json.JSONDecodeError):
            return 0

    @staticmethod
    def _record_schema_migration_locked(
        conn: sqlite3.Connection, version: int, name: str
    ) -> None:
        conn.execute(
            """
            INSERT OR IGNORE INTO schema_migrations (version, name, applied_at)
            VALUES (?, ?, ?)
            """,
            (version, name, int(time.time())),
        )

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
    def _get_meta_locked(
        conn: sqlite3.Connection, key: str, default: Any = None
    ) -> Any:
        row = conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
        if not row:
            return default
        try:
            return json.loads(row["value"])
        except (TypeError, json.JSONDecodeError):
            return default

    def schema_info(self) -> dict[str, Any]:
        with self._connection() as conn:
            version = self._schema_version_locked(conn)
            migrations = [
                dict(row)
                for row in conn.execute(
                    """
                    SELECT version, name, applied_at
                    FROM schema_migrations
                    ORDER BY version ASC
                    """
                ).fetchall()
            ]
        return {
            "version": version,
            "expected_version": SCHEMA_VERSION,
            "up_to_date": version == SCHEMA_VERSION,
            "migrations": migrations,
        }
