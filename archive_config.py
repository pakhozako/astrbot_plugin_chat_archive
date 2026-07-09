from __future__ import annotations

import json
import os
from dataclasses import dataclass
from typing import Any


MEDIA_COMPONENT_TYPES = {"image", "video", "record", "file"}
SCHEMA_VERSION = 1
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


@dataclass
class ArchiveConfig:
    capture_media_files: bool = True
    max_media_mb: int = 200
    download_remote_media: bool = True
    remote_media_timeout_seconds: float = 10.0
    allow_private_remote_media: bool = False
    proxy_remote_media: bool = True
    remote_media_allowed_hosts: tuple[str, ...] = tuple(
        sorted(REMOTE_MEDIA_ALLOWED_HOSTS)
    )
    max_storage_mb: float | None = None
    batch_size: int = DEFAULT_BATCH_SIZE
    flush_interval_seconds: float = DEFAULT_FLUSH_INTERVAL_SECONDS
    durable_write: bool = True


def json_dumps(data: Any) -> str:
    return json.dumps(data, ensure_ascii=False, separators=(",", ":"))


def safe_name(value: str, fallback: str = "file") -> str:
    name = os.path.basename(str(value or "").replace("\\", "/")).strip()
    if not name:
        name = fallback
    for char in '<>:"/\\|?*\x00':
        name = name.replace(char, "_")
    if name in {"", ".", ".."}:
        name = fallback
    return name[:160]
