# Changelog

## 2026-07-07

- Added SQLite WAL mode, incremental indexes, LIKE escaping, media hash deduplication, numeric-only media access, storage-cap pruning, and streaming JSON export.
- Added fallback log replay on startup, read-time pending queue merge, media `ref_count` cleanup tests, export snapshot boundaries, and status observability for DB/media size plus latest prune result.
- Added durable `pending.jsonl` write-ahead journal so messages already captured into the batch queue can be replayed after a forced process kill before flush.
- Added reliability maintenance commands for integrity checks, media GC, and SQLite optimize/analyze, with offline tests for Stage 1 reliability closure.
- Improved the timeline WebUI with Chinese copy, conversation switching, stable paged scrolling, Telegram-style grouped bubbles, search highlighting, responsive session drawer, loading/error/empty states, and richer media previews.
- Added Stage 3 retrieval and export features: SQLite FTS5 search with LIKE fallback, sender/type/media/time filters, WebUI filter controls, search highlighting/navigation, and JSON/Markdown/TXT/HTML/ZIP exports with optional media packaging.
- Added Stage 4 experience features: message favorites, tags, search history, unread conversation counters, lightweight polling updates, UI settings, theme controls, compact mode, and performance/status monitoring in the timeline page.
- Added OneBot/QQ media compatibility improvements: `base64://`/`data:` media capture, safer `file://` handling, QQ image allowlist proxy fallback, browser-like remote image headers, and scroll-anchor restoration when loading older timeline messages.
- Added read-only OneBot/QQ timeline rendering improvements: session IndexedDB pre-cache, system tip pills, recall markers, reply previews, QQ face/market-face rendering fallback, reaction chips, and QQ avatar/member badge display.
- Added more read-only message element cards for OneBot/QQ archives: raw-only image preview fallback, voice bars with duration/text, file cards, video summaries, merged-forward cards, and Ark forward summaries.
- Expanded read-only LuckyLilliaBot-inspired archive rendering with stable merged-forward preview keys, nested forward segment rendering, @mention chips, reaction image fallback, and allowlisted `/media-proxy` support for remote video/audio/file previews.
- Added controlled WebUI export downloads through `/export-file`, limited to generated files inside the plugin `exports/` directory and wired to the AstrBot Page Bridge download flow.
