from __future__ import annotations

import json
import logging
import os
import time
import uuid
from pathlib import Path
from typing import Any

try:
    from . import archive_config as _archive_config
except ImportError:
    import archive_config as _archive_config

_json_dumps = _archive_config.json_dumps

try:
    from astrbot.api import logger
except ModuleNotFoundError:
    logger = logging.getLogger(__name__)


class PendingWalMixin:
    async def replay_fallback_log(self) -> dict[str, Any]:
        if not self.fallback_path.exists() or self.fallback_path.stat().st_size <= 0:
            return {"attempted": 0, "replayed": 0, "failed": 0, "archive_path": None}

        entries = self._read_fallback_entries(self.fallback_path)
        attempted = len(entries)
        replayed = 0
        failed_entries: list[dict[str, Any]] = []

        for entry in entries:
            try:
                await self._prepare_media_for_write([entry])
                replayed += self._write_entries([entry])
            except Exception as exc:
                failed = dict(entry)
                failed["replay_error"] = str(exc)
                failed_entries.append(failed)

        archive_path = self._archive_fallback_file()
        if failed_entries:
            self._append_fallback(
                failed_entries, RuntimeError("fallback replay failed")
            )
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
            return {
                "attempted": 0,
                "replayed": 0,
                "failed": 0,
                "archive_path": None,
                "cleared": True,
                "corrupt": 0,
            }

        async with self._batch_lock:
            entries, corrupt_entries = self._read_pending_entries(self.pending_path)
            attempted = len(entries)
            replayed = 0
            failed_entries: list[dict[str, Any]] = []

            try:
                await self._prepare_media_for_write(entries)
                replayed = self._write_entries(entries)
            except Exception:
                logger.exception(
                    "Chat Archive pending replay batch failed; retrying per entry"
                )
                replayed = 0
                failed_entries = []
                # Keep the normal path batched. Only fall back to per-entry replay
                # after a batch failure so one bad record cannot block recovery.
                for entry in entries:
                    try:
                        await self._prepare_media_for_write([entry])
                        replayed += self._write_entries([entry])
                    except Exception as exc:
                        logger.exception(
                            "Chat Archive pending replay entry failed: seq=%s message_uid=%s",
                            entry.get("seq", entry.get("sequence")),
                            (entry.get("payload") or {}).get("message_uid"),
                        )
                        failed = dict(entry)
                        failed["replay_error"] = str(exc)
                        failed_entries.append(failed)

            if failed_entries:
                self._append_fallback(
                    failed_entries, RuntimeError("pending replay failed")
                )
            corrupt_archive_path = self._archive_corrupt_pending_entries(
                corrupt_entries
            )
            archive_path = self._archive_pending_file()
            self._pending_sequence = self._load_pending_sequence()
            return {
                "attempted": attempted,
                "replayed": replayed,
                "failed": len(failed_entries),
                "archive_path": str(archive_path) if archive_path else None,
                "cleared": not self.pending_path.exists(),
                "corrupt": len(corrupt_entries),
                "corrupt_archive_path": str(corrupt_archive_path)
                if corrupt_archive_path
                else None,
            }

    def _read_pending_entries(
        self, path: Path
    ) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        entries: list[dict[str, Any]] = []
        corrupt_entries: list[dict[str, Any]] = []
        with path.open("r", encoding="utf-8") as f:
            for line_number, raw_line in enumerate(f, start=1):
                line = raw_line.strip()
                if not line:
                    continue
                try:
                    record = json.loads(line)
                except json.JSONDecodeError as exc:
                    corrupt_entries.append(
                        {
                            "line": line_number,
                            "error": str(exc),
                            "raw": line,
                        }
                    )
                    continue
                if not isinstance(record, dict):
                    corrupt_entries.append(
                        {
                            "line": line_number,
                            "error": "pending record is not an object",
                            "raw": line,
                        }
                    )
                    continue
                payload = record.get("payload")
                media = record.get("media") or []
                if not isinstance(payload, dict) or not isinstance(media, list):
                    corrupt_entries.append(
                        {
                            "line": line_number,
                            "error": "pending record missing payload/media",
                            "raw": line,
                        }
                    )
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
        if corrupt_entries:
            logger.warning(
                "Chat Archive found %s corrupt pending WAL lines in %s",
                len(corrupt_entries),
                path,
            )
        return entries, corrupt_entries

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
                        entries.append(
                            {
                                "payload": payload,
                                "media": media,
                                "fallback_logged": False,
                            }
                        )
        return entries

    def _archive_fallback_file(self) -> Path | None:
        if not self.fallback_path.exists():
            return None
        archive_path = self.fallback_path.with_name(
            f"{self.fallback_path.stem}.{self._archive_suffix()}.replayed.jsonl"
        )
        self.fallback_path.replace(archive_path)
        return archive_path

    def _archive_pending_file(self) -> Path | None:
        if not self.pending_path.exists():
            return None
        archive_path = self.pending_path.with_name(
            f"{self.pending_path.stem}.{self._archive_suffix()}.replayed.jsonl"
        )
        self.pending_path.replace(archive_path)
        return archive_path

    def _archive_corrupt_pending_entries(
        self, corrupt_entries: list[dict[str, Any]]
    ) -> Path | None:
        if not corrupt_entries:
            return None
        archive_path = self.pending_path.with_name(
            f"{self.pending_path.stem}.{self._archive_suffix()}.corrupt.jsonl"
        )
        with archive_path.open("w", encoding="utf-8") as f:
            for item in corrupt_entries:
                f.write(_json_dumps(item) + "\n")
            f.flush()
            if self.config.durable_write:
                os.fsync(f.fileno())
        logger.warning(
            "Chat Archive archived corrupt pending WAL lines: %s", archive_path
        )
        return archive_path

    @staticmethod
    def _archive_suffix() -> str:
        return f"{int(time.time())}-{uuid.uuid4().hex[:8]}"

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
                        max_sequence = max(
                            max_sequence,
                            int(record.get("seq", record.get("sequence")) or 0),
                        )
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
        self._write_jsonl_record(
            self.pending_path, record, durable=self.config.durable_write
        )

    def remove_pending(self, entries: list[dict[str, Any]]) -> None:
        # Rewriting the WAL preserves unknown/corrupt lines instead of deleting
        # them, so successful flushes never erase data we did not understand.
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
        self._write_jsonl_record(
            self.fallback_path, record, durable=self.config.durable_write
        )
        for entry in failed:
            entry["fallback_logged"] = True

    @staticmethod
    def _write_jsonl_record(
        path: Path, record: dict[str, Any], *, durable: bool
    ) -> None:
        with path.open("a", encoding="utf-8") as f:
            f.write(_json_dumps(record) + "\n")
            f.flush()
            if durable:
                os.fsync(f.fileno())
