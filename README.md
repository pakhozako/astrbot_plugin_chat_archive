# AstrBot Chat Archive / 聊天档案馆

> **Language:** 中文 | English summary included

> AstrBot 聊天记录归档插件。面向长期留存、检索和导出聊天内容，提供 Pending WAL 可靠队列、SQLite 批量写入、媒体去重、全文搜索、Telegram 风格时间线 WebUI 和多格式导出。

[![Python 3.10+](https://img.shields.io/badge/Python-3.10%2B-blue.svg)](https://www.python.org/)
[![AstrBot](https://img.shields.io/badge/AstrBot-%3E%3D4.16-orange.svg)](https://github.com/AstrBotDevs/AstrBot)
[![SQLite](https://img.shields.io/badge/SQLite-WAL%20%2B%20FTS5-green.svg)](https://www.sqlite.org/)

English: **AstrBot Chat Archive** captures text and media metadata from AstrBot message events, stores them in SQLite/JSONL, and provides a Telegram-like timeline page for browsing, searching, previewing media, tagging, and exporting archives.

---

## 项目命名

我建议使用：

| 场景 | 名称 |
|------|------|
| 插件显示名 | 聊天档案馆 |
| 英文名 | Chat Archive |
| 完整项目名 | AstrBot Chat Archive |
| 插件包名 | `astrbot_plugin_chat_archive` |
| 命令入口 | `/chatlog` |

理由：`Chat Archive` 直观、可搜索、和现有包名一致；中文名“聊天档案馆”比“聊天归档”更像产品名，但不影响技术识别。

---

## 项目结构

```text
main.py                  ← 插件入口、生命周期、消息捕获和 /chatlog 命令
storage.py               ← SQLite 存储、Pending WAL、搜索、导出、媒体 GC
web.py                   ← 插件 Web API 和媒体文件安全路由
metadata.yaml            ← AstrBot 插件元数据和 Page 声明
_conf_schema.json        ← AstrBot WebUI 配置表单
CHANGELOG.md             ← 变更记录
pages/
└── timeline/
    ├── index.html       ← 插件 Page 入口
    ├── app.js           ← Timeline WebUI、Bridge API、交互逻辑
    └── style.css        ← Telegram 风格界面样式
tests/
├── storage_smoke.py
├── test_pending_replay.py
├── test_reliability_stage1.py
├── test_search_export_stage3.py
└── test_experience_stage4.py
```

**设计原则：** 消息一旦进入插件，先写入 `pending.jsonl`，再进入内存批量队列，最后批量提交 SQLite。SQLite 是主要查询源，JSONL/Pending/Fallback 是恢复与审计辅助。

---

## 核心功能

| 功能 | 说明 |
|------|------|
| 消息归档 | 捕获群聊和私聊消息，保存文本、组件、原始事件、发送者、平台和会话信息 |
| Durable Queue | 每条消息入队前写入 `pending.jsonl`，进程强杀后可启动回放 |
| Batch Flush | 默认 20 条或 3 秒批量提交 SQLite，减少每条消息单独事务开销 |
| SQLite WAL | 开启 SQLite WAL 和常用索引，提升读写并发和时间线查询性能 |
| Fallback Recovery | SQLite 写入失败时落 `fallback_failed_batches.jsonl`，启动自动重放 |
| 媒体归档 | 复制本地可访问图片、视频、语音、文件，记录媒体元数据 |
| 媒体去重 | 以 SHA-256 命名实体文件，`media_blobs.ref_count` 管理引用生命周期 |
| 安全路由 | `/media/<media_id>` 只接受数据库数字 ID，并校验路径位于媒体目录内 |
| Telegram 风格 WebUI | 会话列表、消息气泡、日期分组、连续消息合并、虚拟滚动 |
| 搜索与过滤 | 支持 FTS5/LIKE 搜索、高亮、发送者/类型/媒体/时间/标签过滤 |
| 收藏与标签 | 支持收藏消息、标签筛选、搜索历史和会话已读状态 |
| 多格式导出 | 支持 JSON、Markdown、TXT、HTML、ZIP，ZIP 可打包本地媒体 |
| 后台维护 | 支持完整性检查、Media GC、ANALYZE/optimize、按时间和容量 prune |

---

## 快速开始

### 通过插件市场安装

AstrBot WebUI → 插件市场 → 搜索 `astrbot_plugin_chat_archive` → 安装 → 重启 AstrBot。

### 通过 Git 安装

```bash
cd /AstrBot/data/plugins
git clone <your-repo-url> astrbot_plugin_chat_archive
```

重启 AstrBot 后，在插件配置页按需开启归档、媒体复制和保留策略。

---

## 数据位置

插件数据目录由 AstrBot 分配：

```text
StarTools.get_data_dir("astrbot_plugin_chat_archive")
```

主要文件：

```text
chat_archive.sqlite3        SQLite 主库
messages.jsonl              已成功写入消息的追加日志
pending.jsonl               未提交 SQLite 的 Pending WAL
fallback_failed_batches.jsonl
media/                      去重后的媒体实体文件
exports/                    导出文件
```

---

## 配置说明

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `enabled` | `true` | 是否启用聊天归档 |
| `capture_private` | `true` | 是否归档私聊消息 |
| `capture_group` | `true` | 是否归档群聊消息 |
| `capture_media_files` | `true` | 是否复制本地可访问的媒体文件 |
| `max_media_mb` | `200` | 单个媒体文件最大复制大小，单位 MB |
| `max_storage_mb` | `0` | 归档总存储上限，0 表示不限制 |
| `durable_write` | `true` | 消息入队时写入 pending journal 并执行 fsync |
| `retention_days` | `0` | 默认保留天数，0 表示不自动清理 |
| `web_page_size` | `80` | WebUI 每页消息数量 |
| `ignore_command_prefixes` | `["/chatlog"]` | 不归档的命令前缀 |

---

## 命令列表

| 命令 | 说明 |
|------|------|
| `/chatlog status` | 查看消息数、会话数、媒体数、Pending、DB 大小、最近 prune 信息 |
| `/chatlog export [json\|markdown\|txt\|html\|zip]` | 导出归档；ZIP 会包含消息文件，可打包媒体 |
| `/chatlog prune <天数> [最大MB]` | 按时间和可选容量上限清理旧消息 |
| `/chatlog check` | 执行 SQLite 完整性、外键、会话计数和媒体引用检查 |
| `/chatlog gc [dry]` | 修正媒体引用计数，清理孤立媒体；`dry` 只预检查 |
| `/chatlog optimize [vacuum]` | 执行 `ANALYZE`/`PRAGMA optimize`；显式传 `vacuum` 才整理数据库 |
| `/chatlog ping` | 管理员连通性检查 |

---

## WebUI

安装后在 AstrBot 插件详情页打开：

```text
timeline
```

页面通过 AstrBot Plugin Page Bridge 调用后端 API，不需要额外启动服务。

| 区域 | 能力 |
|------|------|
| 会话栏 | 会话列表、多会话切换、未读数、最近消息时间 |
| 时间线 | 日期分组、连续消息合并、Telegram 风格消息气泡、虚拟滚动 |
| 搜索 | 关键词高亮、上一个/下一个结果、发送者/类型/媒体/时间过滤 |
| 媒体 | 图片缩略图、视频/音频播放、文件下载、全屏预览 |
| 操作 | 收藏、标签、复制文本、查看原始 JSON、右键菜单 |
| 设置 | 主题、轮询间隔、自动滚动、紧凑模式、搜索历史 |
| 导出 | 根据当前会话、搜索和过滤条件导出 JSON/Markdown/TXT/HTML/ZIP |

---

## 可靠性与恢复

| 场景 | 行为 |
|------|------|
| 正常写入 | `store_event()` 先写 `pending.jsonl`，再进入 `_batch_queue` |
| 达到批量阈值 | 20 条或 3 秒触发 SQLite 批量事务 |
| SQLite 写入成功 | 只移除已提交条目的 pending 记录 |
| SQLite 写入失败 | 条目写入 fallback 文件，pending 保留或等待重放 |
| 进程被强杀 | 下次启动先回放 `pending.jsonl`，再回放 fallback |
| 重复回放 | `message_uid` 唯一约束防止重复写入 |
| 媒体引用变化 | 删除消息时递减 `media_blobs.ref_count`，降到 0 才删除实体文件 |

启动日志中可观察：

```text
Replay Pending
Replay Finished
Pending Cleared
Chat Archive fallback replay
```

---

## 检索与导出

- 文本搜索优先使用 SQLite FTS5。
- 无法规范化为 FTS 查询时，回退到带 `ESCAPE '\\'` 的安全 LIKE 查询。
- `%`、`_`、中文和混合关键词不会导致 SQL 语法错误。
- 导出开始时取当前消息上界，确保导出过程中新写入的消息不会进入本次快照。
- JSON/Markdown/TXT/HTML/ZIP 均为游标分页写入，避免一次性加载全表。

---

## 性能与安全说明

- SQLite 使用 WAL 和增量索引：`sessions(session_id)`、`messages(session_id, timestamp)`、`messages(platform)`。
- 媒体文件以 `sha256` 文件名保存，相同内容只保存一份实体文件。
- `/media/<media_id>` 不接受任意路径或 hash 字符串，只接受数据库媒体数字 ID。
- `durable_write=true` 会带来每条消息一次 journal append + fsync 的成本；这是为了优先保证“消息进入插件后不丢失”。
- WebUI 使用虚拟滚动，只渲染可见消息，适合大归档浏览。

---

## 维护建议

| 周期 | 建议 |
|------|------|
| 每周 | 查看 `/chatlog status` 中 DB、媒体目录、Pending、最近 prune 信息 |
| 异常后 | 检查是否出现 `fallback_failed_batches.*.jsonl` |
| 大量删除后 | 执行 `/chatlog gc dry`，确认后执行 `/chatlog gc` |
| 性能下降时 | 执行 `/chatlog optimize`；必要时维护窗口内执行 `/chatlog optimize vacuum` |
| 发布前 | 跑语法检查、metadata/schema 校验、离线 smoke test 和隔离 AstrBot WebUI 测试 |

---

## 测试

```bash
python -m py_compile main.py storage.py web.py
node -c pages/timeline/app.js
python -c "import yaml; yaml.safe_load(open('metadata.yaml', encoding='utf-8'))"
python -c "import json; json.load(open('_conf_schema.json', encoding='utf-8'))"
python tests/storage_smoke.py
python tests/test_pending_replay.py
python tests/test_reliability_stage1.py
python tests/test_search_export_stage3.py
python tests/test_experience_stage4.py
```

---

## 致谢

- [AstrBot](https://github.com/AstrBotDevs/AstrBot) — Agentic AI 助手框架
- [astrbot_plugin_nas](https://github.com/pakhozako/astrbot_plugin_nas) — README 结构参考

---

## 许可证

请按你的仓库实际许可证补充。如果准备发布到插件市场，建议在仓库根目录添加 `LICENSE`。
