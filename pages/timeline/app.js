const PLUGIN = "astrbot_plugin_chat_archive";
const bridge = window.AstrBotPluginPage;
const bridgeAvailable = Boolean(bridge && window.parent !== window);
const MESSAGE_CACHE_DB = "chat-archive-timeline";
const MESSAGE_CACHE_STORE = "session_messages";
const MESSAGE_CACHE_VERSION = 1;
const MESSAGE_CACHE_LIMIT = 150;

const demoTags = [
  { id: 1, name: "重点", color: "#d65064", message_count: 6 },
  { id: 2, name: "待处理", color: "#d17a22", message_count: 4 },
  { id: 3, name: "素材", color: "#45a886", message_count: 3 },
];

const state = {
  conversations: [],
  currentUmo: "",
  messages: [],
  q: "",
  filters: {
    sender: "",
    messageType: "",
    mediaKind: "",
    startTs: null,
    endTs: null,
  },
  filterOptions: {
    senders: [],
    message_types: [],
    media_kinds: [],
    tags: [],
  },
  tags: [],
  searchHistory: [],
  currentTagMessage: null,
  settings: {
    poll_interval_seconds: 15,
    auto_scroll: true,
    compact_mode: false,
    show_status_strip: true,
    theme: "system",
  },
  hasMore: false,
  loading: false,
  booting: true,
  error: "",
  stats: null,
  activeMatchIndex: -1,
  lastKnownCount: 0,
  mediaItems: [],
  mediaIndex: -1,
  profileItem: null,
  inspectorTab: "summary",
  forwardPreview: new Map(),
  timelineItems: [],
  latestPollInFlight: false,
  pollTimer: null,
};

const demoMessages = buildDemoMessages();
const imageDataCache = new Map();
const imageDataInFlight = new Map();
const IMAGE_LOAD_TIMEOUT_MS = 12000;
const IMAGE_DATA_FALLBACK_TIMEOUT_MS = 5000;

const els = {
  statLine: document.getElementById("statLine"),
  refreshBtn: document.getElementById("refreshBtn"),
  searchInput: document.getElementById("searchInput"),
  senderFilter: document.getElementById("senderFilter"),
  typeFilter: document.getElementById("typeFilter"),
  mediaFilter: document.getElementById("mediaFilter"),
  startFilter: document.getElementById("startFilter"),
  endFilter: document.getElementById("endFilter"),
  clearFiltersBtn: document.getElementById("clearFiltersBtn"),
  searchCount: document.getElementById("searchCount"),
  prevSearchBtn: document.getElementById("prevSearchBtn"),
  nextSearchBtn: document.getElementById("nextSearchBtn"),
  conversationList: document.getElementById("conversationList"),
  timeline: document.getElementById("timeline"),
  currentTitle: document.getElementById("currentTitle"),
  currentMeta: document.getElementById("currentMeta"),
  exportBtn: document.getElementById("exportBtn"),
  exportFormat: document.getElementById("exportFormat"),
  includeMediaExport: document.getElementById("includeMediaExport"),
  settingsBtn: document.getElementById("settingsBtn"),
  loadMoreBtn: document.getElementById("loadMoreBtn"),
  jumpLatestBtn: document.getElementById("jumpLatestBtn"),
  detailPane: document.getElementById("detailPane"),
  rawJson: document.getElementById("rawJson"),
  closeDetailBtn: document.getElementById("closeDetailBtn"),
  toastLayer: document.getElementById("toastLayer"),
  contextMenu: document.getElementById("contextMenu"),
  profilePopover: document.getElementById("profilePopover"),
  mediaViewer: document.getElementById("mediaViewer"),
  mediaViewerBody: document.getElementById("mediaViewerBody"),
  mediaViewerCaption: document.getElementById("mediaViewerCaption"),
  closeViewerBtn: document.getElementById("closeViewerBtn"),
  downloadViewerBtn: document.getElementById("downloadViewerBtn"),
  prevMediaBtn: document.getElementById("prevMediaBtn"),
  nextMediaBtn: document.getElementById("nextMediaBtn"),
  statusStrip: document.getElementById("statusStrip"),
  sessionToggleBtn: document.getElementById("sessionToggleBtn"),
  inspectorPane: document.getElementById("inspectorPane"),
  inspectorMeta: document.getElementById("inspectorMeta"),
  inspectorContent: document.getElementById("inspectorContent"),
  forwardViewer: document.getElementById("forwardViewer"),
  forwardViewerTitle: document.getElementById("forwardViewerTitle"),
  forwardViewerBody: document.getElementById("forwardViewerBody"),
  closeForwardBtn: document.getElementById("closeForwardBtn"),
  tagDialog: document.getElementById("tagDialog"),
  tagDialogList: document.getElementById("tagDialogList"),
  newTagName: document.getElementById("newTagName"),
  newTagColor: document.getElementById("newTagColor"),
  createTagBtn: document.getElementById("createTagBtn"),
  settingsDialog: document.getElementById("settingsDialog"),
  themeSelect: document.getElementById("themeSelect"),
  pollIntervalInput: document.getElementById("pollIntervalInput"),
  autoScrollToggle: document.getElementById("autoScrollToggle"),
  compactModeToggle: document.getElementById("compactModeToggle"),
  showStatusToggle: document.getElementById("showStatusToggle"),
  historyList: document.getElementById("historyList"),
  clearHistoryBtn: document.getElementById("clearHistoryBtn"),
  saveSettingsBtn: document.getElementById("saveSettingsBtn"),
};

let loadingOlder = false;
let messageCacheDb = null;
let messageCacheUnavailable = false;

function disableMessageCache() {
  messageCacheUnavailable = true;
  try {
    messageCacheDb?.close?.();
  } catch {
    // Ignore cache close failures; cache is an optional UI acceleration layer.
  }
  messageCacheDb = null;
}

els.timeline.addEventListener("scroll", () => {
  if (els.timeline.scrollTop < 72 && !loadingOlder && state.hasMore && !state.loading) {
    loadingOlder = true;
    loadMessages({ append: true }).finally(() => {
      loadingOlder = false;
    });
  }
  updateJumpButton();
});

function endpoint(path) {
  return String(path || "").replace(/^\/+/, "");
}

function pluginApiUrl(path) {
  const clean = endpoint(path);
  const queryIndex = clean.indexOf("?");
  const pathPart = queryIndex >= 0 ? clean.slice(0, queryIndex) : clean;
  const queryPart = queryIndex >= 0 ? clean.slice(queryIndex) : "";
  const cleanPath = pathPart
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `/api/v1/plugins/extensions/${encodeURIComponent(PLUGIN)}/${cleanPath}${queryPart}`;
}

async function apiGet(path, params = {}) {
  if (!bridgeAvailable || !bridge?.apiGet) return demoApiGet(path, params);
  const response = await bridge.apiGet(endpoint(path), params);
  if (response?.ok === false) throw new Error(response.message || "request failed");
  return response?.data ?? response;
}

async function apiPost(path, body = {}) {
  if (!bridgeAvailable || !bridge?.apiPost) return demoApiPost(path, body);
  const response = await bridge.apiPost(endpoint(path), body);
  if (response?.ok === false) throw new Error(response.message || "request failed");
  return response?.data ?? response;
}

function toast(message) {
  const node = document.createElement("div");
  node.className = "toast";
  node.textContent = message;
  els.toastLayer.appendChild(node);
  setTimeout(() => node.remove(), 2600);
}

function fmtTime(ts) {
  if (!ts) return "";
  return new Date(ts * 1000).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

function fmtFullTime(ts) {
  if (!ts) return "";
  return new Date(ts * 1000).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtDay(ts) {
  const date = new Date(ts * 1000);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  if (day === today) return "今天";
  if (day === today - 86400000) return "昨天";
  return date.toLocaleDateString("zh-CN", { month: "long", day: "2-digit", weekday: "short" });
}

function shortUmo(umo) {
  const text = String(umo || "未知会话");
  return text.length > 34 ? `${text.slice(0, 18)}...${text.slice(-10)}` : text;
}

function mediaUrl(item) {
  return pluginApiUrl(`media/${item.id}`);
}

function mediaDisplayUrl(item) {
  if (item?.inline_url) return String(item.inline_url);
  if (item?.local_path && item?.id) return mediaUrl(item);
  return mediaSourceDisplayUrl(item);
}

function markMediaContainerLoaded(container) {
  if (!container) return;
  container.classList.remove("load-error");
  container.classList.add("loaded");
}

function markMediaContainerError(container) {
  if (!container) return;
  container.classList.remove("loaded");
  container.classList.add("load-error");
}

function protectedImageDataRequest(src) {
  const value = String(src || "");
  if (!value || /^(data:|blob:)/i.test(value)) return null;
  let url;
  try {
    url = new URL(value, window.location.href);
  } catch {
    return null;
  }
  const marker = `/api/v1/plugins/extensions/${encodeURIComponent(PLUGIN)}/`;
  const markerIndex = url.pathname.indexOf(marker);
  if (markerIndex < 0) return null;
  const route = url.pathname
    .slice(markerIndex + marker.length)
    .split("/")
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .join("/");
  if (/^media\/[^/]+$/.test(route)) {
    return { path: `media-data/${route.slice("media/".length)}`, params: {} };
  }
  if (route === "file-proxy") {
    return { path: "file-data", params: { path: url.searchParams.get("path") || "" } };
  }
  if (route === "image-proxy") {
    return { path: "image-data", params: { url: url.searchParams.get("url") || "" } };
  }
  return null;
}

function imageProxyDirectFallback(src) {
  try {
    const url = new URL(String(src || ""), window.location.href);
    if (!url.pathname.includes(`/api/v1/plugins/extensions/${encodeURIComponent(PLUGIN)}/image-proxy`)) return "";
    const raw = url.searchParams.get("url") || "";
    return /^https?:\/\//i.test(raw) ? raw : "";
  } catch {
    return "";
  }
}

async function protectedImageDataUrl(src) {
  const request = protectedImageDataRequest(src);
  if (!request || !bridgeAvailable || !bridge?.apiGet) return "";
  const key = `${request.path}?${JSON.stringify(request.params || {})}`;
  if (imageDataCache.has(key)) return imageDataCache.get(key);
  if (!imageDataInFlight.has(key)) {
    const fetchDataUrl = apiGet(request.path, request.params || {})
      .then((data) => {
        const dataUrl = data?.data_url || "";
        if (dataUrl) imageDataCache.set(key, dataUrl);
        return dataUrl;
      })
      .catch(() => "");
    imageDataInFlight.set(
      key,
      Promise.race([
        fetchDataUrl,
        new Promise((resolve) => {
          setTimeout(() => resolve(""), IMAGE_DATA_FALLBACK_TIMEOUT_MS);
        }),
      ])
        .finally(() => imageDataInFlight.delete(key)),
    );
  }
  return imageDataInFlight.get(key);
}

async function recoverImageSource(image) {
  if (!image || image.dataset.recovering === "1") return false;
  const source = image.dataset.originalSrc || image.getAttribute("src") || image.currentSrc || "";
  image.dataset.recovering = "1";
  try {
    if (image.dataset.dataUrlTried !== "1") {
      image.dataset.dataUrlTried = "1";
      const dataUrl = await protectedImageDataUrl(source);
      if (dataUrl) {
        image.src = dataUrl;
        return true;
      }
    }
    const fallback = imageProxyDirectFallback(source);
    if (fallback && image.dataset.directFallbackTried !== "1") {
      image.dataset.directFallbackTried = "1";
      image.src = fallback;
      return true;
    }
    return false;
  } finally {
    delete image.dataset.recovering;
  }
}

function bindInlineRecoverableImage(image, options = {}) {
  if (!image || image.dataset.inlineRecoverBound === "1") return;
  image.dataset.inlineRecoverBound = "1";
  const removeOnFinalError = options.removeOnFinalError !== false;
  image.dataset.originalSrc = image.dataset.originalSrc || image.getAttribute("src") || image.currentSrc || "";
  image.addEventListener("load", () => {
    image.parentElement?.classList.remove("no-image");
  });
  image.addEventListener("error", async () => {
    if (await recoverImageSource(image)) return;
    image.parentElement?.classList.add("no-image");
    if (removeOnFinalError) image.remove();
  });
}

function fmtNumber(value) {
  return new Intl.NumberFormat().format(Number(value || 0));
}

function fmtBytes(value) {
  const bytes = Number(value || 0);
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}

function updateStatusStrip(stats) {
  if (!els.statusStrip) return;
  const chips = [
    ["待提交 Pending", fmtNumber(stats.pending || 0), Number(stats.pending || 0) ? "warn" : ""],
    ["数据库 DB", fmtBytes(stats.db_bytes)],
    ["媒体 Media", fmtBytes(stats.media_bytes)],
  ];
  if (stats.storage_usage_percent !== null && stats.storage_usage_percent !== undefined) {
    chips.push(["存储 Storage", `${stats.storage_usage_percent}%`, Number(stats.storage_usage_percent) > 90 ? "warn" : ""]);
  }
  if (stats.last_prune_at) {
    chips.push(["上次清理", `${fmtFullTime(stats.last_prune_at)} / ${fmtNumber(stats.last_prune_removed)} 条`]);
  }
  els.statusStrip.replaceChildren(
    ...chips.map(([label, value, tone]) => {
      const chip = document.createElement("span");
      chip.className = `status-chip ${tone || ""}`.trim();
      chip.innerHTML = `<span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong>`;
      return chip;
    }),
  );
}

function renderInspector() {
  if (!els.inspectorContent) return;
  const current = state.conversations.find((item) => item.umo === state.currentUmo);
  const messages = state.messages || [];
  const stats = conversationStats(messages);
  const title = state.currentUmo ? shortUmo(state.currentUmo) : "全部会话";
  els.inspectorMeta.textContent = `${title} / ${fmtNumber(messages.length)} 条已载入`;
  els.inspectorPane?.querySelectorAll("[data-inspector-tab]").forEach((button) => {
    button.classList.toggle("active", button.dataset.inspectorTab === state.inspectorTab);
  });
  if (state.inspectorTab === "media") {
    renderInspectorMedia();
    return;
  }
  if (state.inspectorTab === "people") {
    renderInspectorPeople();
    return;
  }
  if (state.inspectorTab === "files") {
    renderInspectorFiles();
    return;
  }
  const latest = messages[messages.length - 1];
  els.inspectorContent.innerHTML = `
    <section class="inspector-card session-card">
      <div class="session-avatar" style="--avatar-bg:${avatarColor(state.currentUmo || "archive")}">${escapeHtml(initials(current?.sample_sender || state.currentUmo || "归档"))}</div>
      <div>
        <strong>${escapeHtml(title)}</strong>
        <span>${escapeHtml(state.currentUmo || "跨会话总览")}</span>
      </div>
    </section>
    <section class="inspector-card metric-grid">
      ${renderMetric("消息", stats.messages)}
      ${renderMetric("发送者", stats.people)}
      ${renderMetric("媒体", stats.media)}
      ${renderMetric("文件", stats.files)}
    </section>
    <section class="inspector-card">
      <h4>最近消息</h4>
      ${
        latest
          ? `<button class="inspector-message" type="button" data-jump-message="${escapeAttr(messageKey(latest))}">
              <strong>${escapeHtml(senderDisplayName(latest))}</strong>
              <span>${escapeHtml(messagePlainText(latest) || systemTipText(latest) || "[消息]")}</span>
              <small>${escapeHtml(fmtFullTime(latest.created_at))}</small>
            </button>`
          : `<div class="empty-inline">暂无已载入消息。</div>`
      }
    </section>
    <section class="inspector-card">
      <h4>可靠性状态</h4>
      <div class="inspector-kv"><span>Pending</span><strong>${escapeHtml(fmtNumber(state.stats?.pending || 0))}</strong></div>
      <div class="inspector-kv"><span>DB</span><strong>${escapeHtml(fmtBytes(state.stats?.db_bytes || 0))}</strong></div>
      <div class="inspector-kv"><span>媒体目录</span><strong>${escapeHtml(fmtBytes(state.stats?.media_bytes || 0))}</strong></div>
    </section>
  `;
  bindInspectorJumpActions();
}

function renderMetric(label, value) {
  return `<div class="metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(fmtNumber(value))}</strong></div>`;
}

function conversationStats(messages) {
  const people = new Set();
  let media = 0;
  let files = 0;
  for (const message of messages || []) {
    people.add(String(message.sender_id || message.sender_name || "unknown"));
    const items = mediaForMessage(message);
    media += items.filter((item) => ["image", "video", "audio"].includes(normalizeMediaKind(item.kind))).length;
    files += items.filter((item) => normalizeMediaKind(item.kind) === "file").length;
  }
  return { messages: messages.length, people: people.size, media, files };
}

function renderInspectorMedia() {
  const items = allDisplayableMediaItems().filter((item) => ["image", "video", "audio"].includes(normalizeMediaKind(item.kind))).slice(-36).reverse();
  if (!items.length) {
    els.inspectorContent.innerHTML = `<div class="empty-inline">当前载入范围内没有可预览媒体。</div>`;
    return;
  }
  els.inspectorContent.innerHTML = `
    <section class="inspector-card">
      <h4>媒体墙</h4>
      <div class="inspector-media-grid">
        ${items.map(renderInspectorMediaThumbHtml).join("")}
      </div>
    </section>
  `;
  els.inspectorContent.querySelectorAll("[data-open-media-index]").forEach((button) => {
    button.addEventListener("click", () => {
      const item = items[Number(button.dataset.openMediaIndex || 0)];
      if (item) openMediaViewer(item);
    });
  });
  bindRecoverableImages(els.inspectorContent);
}

function renderInspectorMediaThumbHtml(item, index) {
  const kind = normalizeMediaKind(item.kind);
  const url = mediaDisplayUrl(item);
  if (kind === "image") {
    return `<button class="inspector-media-thumb" type="button" data-open-media-index="${index}" title="${escapeAttr(item.name || "图片")}"><img loading="lazy" src="${escapeAttr(url)}" alt="${escapeAttr(item.name || "图片")}" /></button>`;
  }
  return `<button class="inspector-media-thumb ${escapeAttr(kind)}" type="button" data-open-media-index="${index}" title="${escapeAttr(item.name || mediaKindLabel(kind))}"><span>${escapeHtml(fileIcon(kind))}</span><small>${escapeHtml(mediaKindLabel(kind))}</small></button>`;
}

function renderInspectorPeople() {
  const rows = peopleSummary(state.messages).slice(0, 24);
  if (!rows.length) {
    els.inspectorContent.innerHTML = `<div class="empty-inline">当前载入范围内没有发送者。</div>`;
    return;
  }
  els.inspectorContent.innerHTML = `
    <section class="inspector-card">
      <h4>发送者</h4>
      <div class="people-list">
        ${rows.map(renderPersonRowHtml).join("")}
      </div>
    </section>
  `;
  els.inspectorContent.querySelectorAll("[data-filter-person]").forEach((button) => {
    button.addEventListener("click", async () => {
      state.filters.sender = button.dataset.filterPerson || "";
      syncFilterForm();
      await loadMessages({ stickToBottom: true });
    });
  });
}

function peopleSummary(messages) {
  const byKey = new Map();
  for (const message of messages || []) {
    const key = String(message.sender_id || message.sender_name || "unknown");
    const existing = byKey.get(key) || { key, name: senderDisplayName(message), count: 0, last: 0, avatar: qqAvatarUrl(message) };
    existing.count += 1;
    existing.last = Math.max(existing.last, Number(message.created_at || 0));
    if (!existing.avatar) existing.avatar = qqAvatarUrl(message);
    byKey.set(key, existing);
  }
  return [...byKey.values()].sort((a, b) => b.count - a.count || b.last - a.last);
}

function renderPersonRowHtml(person) {
  return `
    <button class="person-row" type="button" data-filter-person="${escapeAttr(person.name || person.key)}">
      <span class="person-avatar" style="--avatar-bg:${avatarColor(person.key)}">${person.avatar ? `<img loading="lazy" src="${escapeAttr(person.avatar)}" alt="${escapeAttr(person.name)}" />` : escapeHtml(initials(person.name))}</span>
      <span><strong>${escapeHtml(person.name)}</strong><small>${escapeHtml(fmtFullTime(person.last))}</small></span>
      <b>${escapeHtml(fmtNumber(person.count))}</b>
    </button>
  `;
}

function renderInspectorFiles() {
  const files = state.messages.flatMap((message) => mediaForMessage(message)).filter((item) => normalizeMediaKind(item.kind) === "file").slice(-30).reverse();
  if (!files.length) {
    els.inspectorContent.innerHTML = `<div class="empty-inline">当前载入范围内没有文件。</div>`;
    return;
  }
  els.inspectorContent.innerHTML = `
    <section class="inspector-card">
      <h4>文件</h4>
      <div class="file-list">
        ${files.map((item, index) => `
          <button class="file-row" type="button" data-download-file="${index}">
            <span class="file-icon">${escapeHtml(fileIcon(item.kind))}</span>
            <span><strong>${escapeHtml(item.name || "文件")}</strong><small>${escapeHtml(item.size ? fmtBytes(item.size) : mediaDisplayUrl(item) || "来源记录")}</small></span>
          </button>
        `).join("")}
      </div>
    </section>
  `;
  els.inspectorContent.querySelectorAll("[data-download-file]").forEach((button) => {
    button.addEventListener("click", () => {
      const item = files[Number(button.dataset.downloadFile || 0)];
      if (item) downloadMedia(item).catch((error) => toast(error.message || "下载失败"));
    });
  });
}

function bindInspectorJumpActions() {
  els.inspectorContent.querySelectorAll("[data-jump-message]").forEach((button) => {
    button.addEventListener("click", () => scrollTimelineToKey(`msg-${button.dataset.jumpMessage}`));
  });
}

async function downloadMedia(item) {
  const url = mediaDisplayUrl(item);
  if (!url) {
    toast("没有可下载的媒体文件");
    return;
  }
  if (!bridgeAvailable || !bridge?.download) {
    window.open(url, "_blank", "noopener");
    return;
  }
  if (item?.local_path && item?.id) {
    await bridge.download(endpoint(`media/${item.id}`), {}, item.name || "媒体文件.bin");
    return;
  }
  window.open(url, "_blank", "noopener");
}

async function loadStats() {
  const stats = await apiGet("/stats");
  const previous = state.lastKnownCount || Number(stats.messages || 0);
  state.stats = stats;
  state.lastKnownCount = Number(stats.messages || 0);
  els.statLine.textContent = `${fmtNumber(stats.messages)} 条消息 / ${fmtNumber(stats.conversations)} 个会话 / ${fmtNumber(stats.media)} 个媒体`;
  updateStatusStrip(stats);
  renderInspector();
  if (state.lastKnownCount > previous && !isNearBottom()) {
    els.jumpLatestBtn.hidden = false;
    els.jumpLatestBtn.textContent = `${fmtNumber(state.lastKnownCount - previous)} 条新消息`;
  }
}

async function loadConversations() {
  state.conversations = await apiGet("/conversations");
  renderConversations();
}

async function loadFilters() {
  state.filterOptions = await apiGet("/filters", { umo: state.currentUmo });
  state.tags = state.filterOptions.tags || state.tags || [];
  renderFilters();
}

async function loadTags() {
  state.tags = await apiGet("/tags");
  state.filterOptions.tags = state.tags;
}

async function loadSearchHistory() {
  state.searchHistory = await apiGet("/search-history", { limit: 20 });
  renderSearchHistory();
}

async function loadSettings() {
  const settings = await apiGet("/settings");
  state.settings = { ...state.settings, ...(settings || {}) };
  applySettingsToDocument();
  syncSettingsForm();
  schedulePolling();
}

async function loadMessages({ append = false, stickToBottom = !append } = {}) {
  if (state.loading) return;
  const requestView = viewSignature();
  const requestUmo = state.currentUmo;
  const requestQuery = state.q;
  const requestFilters = { ...state.filters };
  const requestCacheKey = messageCacheKey();
  state.loading = true;
  state.error = "";
  els.loadMoreBtn.disabled = true;
  const anchorKey = append ? firstVisibleMessageKey() : "";
  if (!append && !state.messages.length) {
    const cached = await getCachedMessagesForCurrentView(requestCacheKey);
    if (cached.length) {
      state.messages = cached;
      renderTimeline({ stickToBottom });
      updateHeader();
    } else {
      renderTimeline();
    }
  }
  try {
    if (viewSignature() !== requestView) return;
    const before =
      append && state.messages.length
        ? Math.min(...state.messages.map((item) => Number(item.created_at || 0)).filter(Boolean))
        : 0;
    const data = await apiGet("/messages", {
      umo: requestUmo,
      q: requestQuery,
      before,
      limit: 100,
      sender: requestFilters.sender,
      message_type: requestFilters.messageType,
      media_kind: requestFilters.mediaKind,
      start_ts: requestFilters.startTs || "",
      end_ts: requestFilters.endTs || "",
    });
    if (viewSignature() !== requestView) return;
    state.hasMore = Boolean(data.has_more);
    state.messages = append ? dedupeMessages([...(data.items || []), ...state.messages]) : data.items || [];
    if (!append) setCachedMessagesForCurrentView(state.messages, requestCacheKey).catch(() => {});
    state.activeMatchIndex = -1;
    renderTimeline({ preserveTop: append, stickToBottom, anchorKey });
    updateHeader();
    if (!append && (state.q || hasActiveFilters())) {
      recordSearchHistory(data.items || []).catch(() => {});
    }
  } catch (error) {
    state.error = error.message || "加载失败";
    renderTimeline();
    throw error;
  } finally {
    state.loading = false;
    if (append) loadingOlder = false;
    els.loadMoreBtn.disabled = !state.hasMore;
  }
}

function dedupeMessages(items) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const key = messageKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result.sort((a, b) => Number(a.created_at || 0) - Number(b.created_at || 0));
}

function canUseMessageCache() {
  return bridgeAvailable && !state.q && !hasActiveFilters();
}

function messageCacheKey() {
  return state.currentUmo || "__all__";
}

function viewSignature() {
  return JSON.stringify({
    umo: state.currentUmo,
    q: state.q,
    sender: state.filters.sender,
    messageType: state.filters.messageType,
    mediaKind: state.filters.mediaKind,
    startTs: state.filters.startTs || "",
    endTs: state.filters.endTs || "",
  });
}

async function openMessageCacheDb() {
  if (messageCacheUnavailable) return null;
  const dbFactory = window.indexedDB;
  if (!dbFactory) {
    disableMessageCache();
    return null;
  }
  if (messageCacheDb) return messageCacheDb;
  return new Promise((resolve) => {
    let request;
    try {
      request = dbFactory.open(MESSAGE_CACHE_DB, MESSAGE_CACHE_VERSION);
    } catch {
      disableMessageCache();
      resolve(null);
      return;
    }
    request.onerror = () => {
      disableMessageCache();
      resolve(null);
    };
    request.onblocked = () => {
      disableMessageCache();
      resolve(null);
    };
    request.onsuccess = () => {
      messageCacheDb = request.result;
      messageCacheDb.onversionchange = () => {
        disableMessageCache();
      };
      resolve(messageCacheDb);
    };
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(MESSAGE_CACHE_STORE)) {
        db.createObjectStore(MESSAGE_CACHE_STORE, { keyPath: "cacheKey" });
      }
    };
  });
}

async function getCachedMessagesForCurrentView(cacheKey = messageCacheKey()) {
  if (!canUseMessageCache()) return [];
  const db = await openMessageCacheDb();
  if (!db) return [];
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(MESSAGE_CACHE_STORE, "readonly");
      const request = tx.objectStore(MESSAGE_CACHE_STORE).get(cacheKey);
      request.onerror = () => resolve([]);
      request.onsuccess = () => {
        const messages = Array.isArray(request.result?.messages) ? request.result.messages : [];
        resolve(dedupeMessages(messages));
      };
    } catch {
      disableMessageCache();
      resolve([]);
    }
  });
}

async function setCachedMessagesForCurrentView(messages, cacheKey = messageCacheKey()) {
  if (!canUseMessageCache()) return;
  const db = await openMessageCacheDb();
  if (!db) return;
  const cached = dedupeMessages(messages || []).slice(-MESSAGE_CACHE_LIMIT);
  await new Promise((resolve) => {
    try {
      const tx = db.transaction(MESSAGE_CACHE_STORE, "readwrite");
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.objectStore(MESSAGE_CACHE_STORE).put({
        cacheKey,
        messages: cached,
        updatedAt: Date.now(),
      });
    } catch {
      disableMessageCache();
      resolve();
    }
  });
}

function renderConversations() {
  const total = state.conversations.reduce((sum, item) => sum + Number(item.message_count || 0), 0);
  const totalMedia = state.conversations.reduce((sum, item) => sum + Number(item.media_count || 0), 0);
  const nodes = [{ umo: "", message_count: total, media_count: totalMedia, latest_at: 0, sample_sender: "归档" }, ...state.conversations];
  els.conversationList.replaceChildren(
    ...nodes.map((item) => {
      const button = document.createElement("button");
      const active = item.umo === state.currentUmo;
      const title = item.umo ? shortUmo(item.umo) : "全部会话";
      const count = Number(item.message_count || 0);
      const mediaCount = Number(item.media_count || 0);
      const unreadCount = Number(item.unread_count || 0);
      const avatarUrl = conversationAvatarUrl(item);
      const avatarText = escapeHtml(initials(item.sample_sender || item.umo || "All"));
      button.className = `conversation ${active ? "active" : ""}`;
      button.type = "button";
      button.setAttribute("aria-pressed", String(active));
      button.title = item.umo || "全部会话";
      button.innerHTML = `
        <div class="conversation-avatar ${avatarUrl ? "image-avatar" : ""}" style="--avatar-bg:${avatarColor(item.umo || "all")}">${avatarUrl ? `<img loading="lazy" src="${escapeAttr(avatarUrl)}" alt="${escapeAttr(title)}" /><span>${avatarText}</span>` : avatarText}</div>
        <div class="conversation-main">
          <div class="conversation-title-row">
            <span class="conversation-title">${escapeHtml(title)}</span>
            ${unreadCount ? `<span class="conversation-badge unread">${escapeHtml(fmtNumber(unreadCount))}</span>` : count ? `<span class="conversation-badge">${escapeHtml(fmtNumber(count))}</span>` : ""}
          </div>
          <div class="conversation-sub">
            <span>${mediaCount ? `${fmtNumber(mediaCount)} 个媒体` : `${fmtNumber(count)} 条消息`}</span>
            <span>${item.latest_at ? fmtFullTime(item.latest_at) : "最新"}</span>
          </div>
        </div>
      `;
      button.addEventListener("click", async () => {
        state.currentUmo = item.umo || "";
        state.messages = [];
        state.hasMore = false;
        document.body.classList.remove("sessions-open");
        renderConversations();
        await loadFilters();
        await loadMessages({ stickToBottom: true });
        await markCurrentConversationSeen();
      });
      bindRecoverableImages(button, { selector: ".conversation-avatar img", removeOnFinalError: true });
      return button;
    }),
  );
}

function renderTimeline(options = {}) {
  els.loadMoreBtn.disabled = !state.hasMore || state.loading;
  if (state.error) {
    els.timeline.replaceChildren(createEmpty("加载失败", state.error, "error"));
    updateSearchUi();
    return;
  }
  if (state.loading && !state.messages.length) {
    els.timeline.replaceChildren(createLoading());
    updateSearchUi();
    return;
  }
  const items = buildTimelineItems(state.messages);
  state.timelineItems = items;
  if (!items.length) {
    const empty = createEmpty();
    els.timeline.replaceChildren(empty);
    return;
  }
  const oldHeight = els.timeline.scrollHeight;
  const oldTop = els.timeline.scrollTop;
  const anchor = options.anchorKey ? els.timeline.querySelector(`[data-key="${CSS.escape(options.anchorKey)}"]`) : null;
  const anchorTop = anchor ? anchor.getBoundingClientRect().top : 0;
  const fragment = document.createDocumentFragment();
  const existing = new Map(Array.from(els.timeline.children).map((node) => [node.dataset?.key || "", node]).filter(([key]) => key));
  for (const item of items) {
    fragment.appendChild(renderTimelineItem(item, existing));
  }
  els.timeline.replaceChildren(fragment);
  if (options.anchorKey && anchor) {
    restoreScrollAnchor(options.anchorKey, anchorTop);
  } else if (options.preserveTop) {
    els.timeline.scrollTop = oldTop + Math.max(0, els.timeline.scrollHeight - oldHeight);
  } else if (options.stickToBottom) {
    scrollTimelineToBottom();
  }
  updateSearchUi();
}

function firstVisibleMessageKey() {
  const timelineTop = els.timeline.getBoundingClientRect().top;
  const nodes = Array.from(els.timeline.querySelectorAll(".message-row[data-key], .system-tip-row[data-key]"));
  for (const node of nodes) {
    if (node.getBoundingClientRect().bottom >= timelineTop + 8) return node.dataset.key || "";
  }
  return nodes[0]?.dataset.key || "";
}

function restoreScrollAnchor(key, previousTop) {
  if (!key) return;
  requestAnimationFrame(() => {
    const target = els.timeline.querySelector(`[data-key="${CSS.escape(key)}"]`);
    if (!target) return;
    const nextTop = target.getBoundingClientRect().top;
    els.timeline.scrollTop += nextTop - previousTop;
  });
}

function buildTimelineItems(messages) {
  const result = [];
  let lastDay = "";
  let previousMessage = null;
  const matches = state.q ? searchMatches() : [];
  const activeKey =
    state.activeMatchIndex >= 0 && matches[state.activeMatchIndex]
      ? messageKey(matches[state.activeMatchIndex].item)
      : "";
  for (let index = 0; index < messages.length; index += 1) {
    const item = messages[index];
    const day = fmtDay(item.created_at);
    if (day !== lastDay) {
      result.push({ type: "day", key: `day-${day}-${item.created_at}`, label: day });
      lastDay = day;
      previousMessage = null;
    }

    const nextMessage = messages[index + 1] || null;
    const group = messageGroup(item, previousMessage, nextMessage);
    const active = activeKey && activeKey === messageKey(item);
    result.push({
      type: "message",
      key: `msg-${messageKey(item)}`,
      message: item,
      group,
      active,
    });
    previousMessage = item;

    if (nextMessage && sameDay(item.created_at, nextMessage.created_at) && Math.abs(Number(nextMessage.created_at || 0) - Number(item.created_at || 0)) > 300) {
      result.push({ type: "gap", key: `gap-${messageKey(item)}`, label: fmtFullTime(nextMessage.created_at) });
      previousMessage = null;
    }
  }
  return result;
}

function renderTimelineItem(item, existing = new Map()) {
  if (item.type === "day") {
    const reused = existing.get(item.key);
    if (reused) return reused;
    const node = document.createElement("div");
    node.className = "day-divider";
    node.dataset.key = item.key;
    node.textContent = item.label;
    return node;
  }
  if (item.type === "gap") {
    const reused = existing.get(item.key);
    if (reused) return reused;
    const node = document.createElement("div");
    node.className = "time-gap";
    node.dataset.key = item.key;
    node.textContent = item.label;
    return node;
  }
  const reused = existing.get(item.key);
  const signature = messageRenderSignature(item.message, item.group, item.active);
  if (reused?.dataset?.renderSignature === signature) return reused;
  const node = renderMessage(item.message, item.group, item.active);
  node.dataset.renderSignature = signature;
  return node;
}

function messageRenderSignature(item, group, active) {
  const mediaSig = (Array.isArray(item.media) ? item.media : [])
    .map((media) => [media.id, media.kind, media.name, media.source, media.local_path, media.relative_path, media.size, media.width, media.height].join(":"))
    .join("|");
  const tagSig = (Array.isArray(item.tags) ? item.tags : [])
    .map((tag) => [tag.id, tag.name, tag.color].join(":"))
    .join("|");
  return JSON.stringify({
    uid: messageKey(item),
    text: item.text || "",
    createdAt: item.created_at || "",
    senderId: item.sender_id || "",
    selfId: item.self_id || "",
    messageType: item.message_type || "",
    components: stableSignatureValue(item.components_json || item.components || null),
    raw: stableSignatureValue(item.raw_json || item.raw || null),
    sender: item.sender_name || item.sender_id || "",
    platform: item.platform || "",
    favorite: Boolean(item.favorite),
    tags: tagSig,
    media: mediaSig,
    q: state.q || "",
    active: Boolean(active),
    group,
  });
}

function stableSignatureValue(value) {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(stableSignatureValue);
  return Object.keys(value)
    .sort()
    .reduce((result, key) => {
      result[key] = stableSignatureValue(value[key]);
      return result;
    }, {});
}

function renderSystemTip(item, text, active = false) {
  const node = document.createElement("div");
  const uid = messageKey(item);
  node.className = `system-tip-row ${active ? "active-search" : ""}`;
  node.dataset.uid = uid;
  node.dataset.key = `msg-${uid}`;
  node.setAttribute("role", "note");
  node.innerHTML = `<span class="system-tip">${highlightText(text, state.q)}</span>`;
  node.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    showContextMenu(event.clientX, event.clientY, item, text);
  });
  return node;
}

function renderMessage(item, group, active = false) {
  const systemTip = systemTipText(item);
  if (systemTip) return renderSystemTip(item, systemTip, active);

  const node = document.createElement("article");
  const self = isSelf(item);
  const uid = messageKey(item);
  node.className = [
    "message-row",
    self ? "self" : "other",
    group.first ? "group-first" : "",
    group.last ? "group-last" : "",
    active ? "active-search" : "",
  ]
    .filter(Boolean)
    .join(" ");
  node.setAttribute("role", "article");
  node.dataset.uid = uid;
  node.dataset.key = `msg-${uid}`;

  const text = messagePlainText(item);
  const bodyHtml = messageBodyHtml(item);
  const sender = senderDisplayName(item);
  const media = mediaForGrid(item);
  const platform = item.platform || "";
  const tags = Array.isArray(item.tags) ? item.tags : [];
  const reply = replyInfo(item);
  const replyTargetKey = reply ? replyTargetMessageKey(reply) : "";
  const recalled = isRecalledMessage(item);
  const reactions = reactionList(item);
  const avatar = renderAvatarHtml(item, sender, self, group);
  const name = !self && group.showName ? renderSenderHtml(item, sender) : "";
  node.innerHTML = `
    ${avatar}
    <div class="bubble-shell">
      <div class="bubble ${recalled ? "is-recalled" : ""}">
        ${name}
        ${reply ? renderReplyPreviewHtml(reply, replyTargetKey) : ""}
        ${bodyHtml ? `<div class="message-text">${bodyHtml}</div>` : ""}
        ${recalled ? `<div class="message-recalled">已撤回，归档内容保留</div>` : ""}
        ${tags.length ? `<div class="tag-row">${tags.map(renderTagChipHtml).join("")}</div>` : ""}
        <div class="media-grid"></div>
        ${reactions.length ? renderReactionRowHtml(reactions) : ""}
        <div class="message-foot">
          <button class="message-action favorite-action ${item.favorite ? "active" : ""}" type="button" data-action="favorite" aria-label="${item.favorite ? "取消收藏" : "收藏消息"}">${item.favorite ? "已收藏" : "收藏"}</button>
          <button class="message-action" type="button" data-action="tag" aria-label="编辑标签">标签</button>
          <button class="message-action" type="button" data-action="copy" aria-label="复制消息">复制</button>
          <button class="message-action" type="button" data-action="raw" aria-label="查看 JSON">JSON</button>
          ${platform ? `<span class="message-platform">${escapeHtml(platform)}</span>` : ""}
          <span class="message-time">${escapeHtml(fmtTime(item.created_at))}</span>
        </div>
      </div>
    </div>
  `;

  const grid = node.querySelector(".media-grid");
  if (grid && media.length) {
    grid.replaceChildren(...media.map((mediaItem) => renderMedia(mediaItem)));
  } else if (grid) {
    grid.remove();
  }
  bindRecoverableImages(node, { selector: ".image-avatar img", removeOnFinalError: false });
  node.querySelectorAll("[data-profile]").forEach((trigger) => {
    trigger.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      showProfilePopover(item, event.clientX, event.clientY);
    });
    trigger.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      showProfilePopover(item, event.clientX, event.clientY);
    });
  });
  node.querySelectorAll(".inline-market-face, .inline-face-img, .reaction-chip img").forEach((image) => {
    bindInlineRecoverableImage(image);
  });
  node.querySelectorAll(".inline-image-preview img").forEach((image) => {
    bindImageLoadState(image, image.closest(".inline-image-preview"));
  });
  node.querySelectorAll(".video-element img").forEach((image) => {
    bindImageLoadState(image, image.closest(".video-element"));
  });

  node.addEventListener("click", (event) => {
    const inlineImage = event.target?.closest?.("[data-inline-image]");
    if (inlineImage?.dataset.inlineImage) {
      openInlineMediaViewer({
        kind: "image",
        name: inlineImage.dataset.inlineMediaName || "图片",
        inline_url: inlineImage.dataset.inlineImage,
      });
      return;
    }
    const inlineVideo = event.target?.closest?.("[data-inline-video]");
    if (inlineVideo?.dataset.inlineVideo) {
      openInlineMediaViewer({
        kind: "video",
        name: inlineVideo.dataset.inlineMediaName || "视频",
        inline_url: inlineVideo.dataset.inlineVideo,
      });
      return;
    }
    const replyTarget = event.target?.closest?.("[data-reply-key]");
    if (replyTarget?.dataset.replyKey) {
      scrollTimelineToKey(replyTarget.dataset.replyKey);
      return;
    }
    const forwardTarget = event.target?.closest?.("[data-forward-preview]");
    if (forwardTarget) {
      const forward = getForwardPreview(forwardTarget.dataset.forwardPreview || "");
      if (forward) openForwardViewer(forward);
      return;
    }
    const action = event.target?.closest?.("[data-action]")?.dataset.action;
    if (!action) return;
    if (action === "favorite") toggleFavorite(item);
    if (action === "tag") openTagDialog(item);
    if (action === "copy") copyText(text || JSON.stringify(item.raw || item.components || ""));
    if (action === "raw") showRaw(item);
    if (action === "profile") showProfilePopover(item, event.clientX, event.clientY);
  });
  node.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    showContextMenu(event.clientX, event.clientY, item, text);
  });
  return node;
}

function openInlineMediaViewer(item) {
  const displayable = allDisplayableMediaItems();
  const targetUrl = mediaDisplayUrl(item);
  state.mediaItems = displayable.length ? displayable : [item];
  state.mediaIndex = Math.max(0, state.mediaItems.findIndex((media) => mediaDisplayUrl(media) === targetUrl));
  renderMediaViewer();
  els.mediaViewer.hidden = false;
}

function bindImageLoadState(image, container) {
  if (!image || !container) return;
  if (image.dataset.loadStateBound === "1") return;
  image.dataset.loadStateBound = "1";
  image.dataset.originalSrc = image.dataset.originalSrc || image.getAttribute("src") || image.currentSrc || "";
  if (image.loading === "lazy") image.loading = "eager";
  let finished = false;
  let timeout = null;
  let recoveryAttempts = 0;
  const scheduleTimeout = () => {
    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(() => {
      if (finished) return;
      if (image.complete && image.naturalWidth > 0) {
        markLoaded();
        return;
      }
      markError();
    }, IMAGE_LOAD_TIMEOUT_MS);
  };
  const markLoaded = () => {
    finished = true;
    if (timeout) clearTimeout(timeout);
    markMediaContainerLoaded(container);
  };
  const markError = async () => {
    if (finished) return;
    if (await recoverImageSource(image)) {
      recoveryAttempts += 1;
      if (recoveryAttempts <= 2) scheduleTimeout();
      return;
    }
    finished = true;
    if (timeout) clearTimeout(timeout);
    markMediaContainerError(container);
  };
  image.addEventListener("load", markLoaded);
  image.addEventListener("error", markError);
  const originalSrc = image.dataset.originalSrc;
  if (originalSrc && bridgeAvailable) {
    protectedImageDataUrl(originalSrc)
      .then((dataUrl) => {
        if (!dataUrl || finished || image.src === dataUrl) return;
        image.src = dataUrl;
      })
      .catch(() => {
        // Direct image loading remains the fallback; error/timeout will set UI state.
      });
  }
  scheduleTimeout();
  if (image.complete) {
    if (image.naturalWidth > 0) markLoaded();
    else markError();
  }
}

function bindRecoverableImages(root, options = {}) {
  const removeOnFinalError = Boolean(options.removeOnFinalError);
  const selector = options.selector || "img";
  root?.querySelectorAll?.(selector).forEach((image) => {
    if (image.dataset.recoverableBound === "1") return;
    image.dataset.recoverableBound = "1";
    image.addEventListener("error", async () => {
      if (await recoverImageSource(image)) return;
      if (removeOnFinalError) image.remove();
    });
  });
}

function renderMedia(item) {
  const card = document.createElement("div");
  const displayUrl = mediaDisplayUrl(item);
  const kind = normalizeMediaKind(item.kind);
  card.className = `media-card ${kind}`;
  if (displayUrl && kind === "image") {
    const button = document.createElement("button");
    button.className = "media-thumb";
    button.type = "button";
    button.setAttribute("aria-label", `预览 ${item.name || "图片"}`);
    applyMediaPreviewSize(button, item);
    button.innerHTML = `
      <span class="media-loading">加载中</span>
      <span class="media-error">图片不可用</span>
      <img loading="lazy" src="${escapeAttr(displayUrl)}" alt="${escapeAttr(item.name || "图片")}" />
    `;
    const image = button.querySelector("img");
    if (image) bindImageLoadState(image, button);
    button.addEventListener("click", () => openMediaViewer(item));
    card.appendChild(button);
  } else if (displayUrl && kind === "video") {
    const video = document.createElement("video");
    video.controls = true;
    video.preload = "metadata";
    video.src = displayUrl;
    card.appendChild(video);
  } else if (displayUrl && kind === "audio") {
    if (isBrowserPlayableAudio(item)) {
      const audio = document.createElement("audio");
      audio.controls = true;
      audio.preload = "metadata";
      audio.src = displayUrl;
      card.appendChild(audio);
    } else {
      const note = document.createElement("div");
      note.className = "media-playback-note";
      note.textContent = "该语音格式可能无法在浏览器直接播放，可下载后转换或播放。";
      card.appendChild(note);
    }
  }

  const meta = document.createElement("div");
  meta.className = "media-file";
  if (kind === "image") meta.classList.add("compact");
  meta.innerHTML = `
    <div class="file-icon">${escapeHtml(fileIcon(item.kind))}</div>
    <div class="file-main">
      <div class="media-kind">${escapeHtml(mediaKindLabel(kind))}</div>
      <div class="media-meta">${escapeHtml(item.name || item.source || "未命名媒体")}</div>
    </div>
    ${displayUrl ? `<button class="media-download" type="button" aria-label="下载媒体">下载</button>` : `<span class="media-meta">仅来源</span>`}
  `;
  card.appendChild(meta);
  const downloadBtn = meta.querySelector(".media-download");
  if (downloadBtn) {
    downloadBtn.addEventListener("click", () => downloadMedia(item).catch((error) => toast(error.message || "下载失败")));
  }
  return card;
}

function showContextMenu(x, y, item, text) {
  const media = mediaForMessage(item);
  const displayableMedia = media.filter((mediaItem) => mediaDisplayUrl(mediaItem));
  els.contextMenu.innerHTML = `
    <button type="button" data-action="favorite">${item.favorite ? "取消收藏" : "收藏消息"}</button>
    <button type="button" data-action="profile">查看发送者</button>
    <button type="button" data-action="tag">编辑标签</button>
    <button type="button" data-action="copy">复制文本</button>
    <button type="button" data-action="raw">查看 JSON</button>
    <button type="button" data-action="copy-json">复制 JSON</button>
    ${displayableMedia.length ? `<button type="button" data-action="open-media">打开媒体</button>` : ""}
    ${displayableMedia.length ? `<button type="button" data-action="copy-media-url">复制媒体链接</button>` : ""}
  `;
  els.contextMenu.hidden = false;
  const rect = els.contextMenu.getBoundingClientRect();
  els.contextMenu.style.left = `${Math.min(x, window.innerWidth - rect.width - 12)}px`;
  els.contextMenu.style.top = `${Math.min(y, window.innerHeight - rect.height - 12)}px`;
  els.contextMenu.onclick = (event) => {
    event.stopPropagation();
    const action = event.target?.closest?.("button")?.dataset.action;
    if (action === "favorite") toggleFavorite(item);
    if (action === "profile") showProfilePopover(item, x, y);
    if (action === "tag") openTagDialog(item);
    if (action === "copy") copyText(text || "");
    if (action === "raw") showRaw(item);
    if (action === "copy-json") copyText(JSON.stringify(item, null, 2));
    if (action === "open-media") {
      const first = displayableMedia[0];
      if (first) openMediaViewer(first);
    }
    if (action === "copy-media-url") {
      const first = displayableMedia[0];
      if (first) copyText(mediaDisplayUrl(first));
    }
    hideContextMenu();
  };
}

function hideContextMenu() {
  els.contextMenu.hidden = true;
}

function showProfilePopover(item, x, y) {
  if (!els.profilePopover) return;
  const profile = profileFromMessage(item);
  state.profileItem = item;
  els.profilePopover.innerHTML = `
    <div class="profile-cover" style="--avatar-bg:${avatarColor(profile.name)}">
      <div class="profile-avatar">
        ${profile.avatarUrl ? `<img loading="lazy" src="${escapeAttr(profile.avatarUrl)}" alt="${escapeAttr(profile.name)}" />` : `<span>${escapeHtml(initials(profile.name))}</span>`}
      </div>
      <div class="profile-main">
        <strong>${escapeHtml(profile.name)}</strong>
        <span>${escapeHtml(profile.primaryId || "未知账号")}</span>
      </div>
      <button class="profile-close" type="button" aria-label="关闭资料卡">关闭</button>
    </div>
    <div class="profile-body">
      ${profile.remark ? `<div class="profile-row"><span>备注</span><strong>${escapeHtml(profile.remark)}</strong></div>` : ""}
      ${profile.uid ? `<div class="profile-row"><span>UID</span><strong>${escapeHtml(profile.uid)}</strong></div>` : ""}
      ${profile.uin ? `<div class="profile-row"><span>QQ</span><strong>${escapeHtml(profile.uin)}</strong></div>` : ""}
      ${profile.role ? `<div class="profile-row"><span>群身份</span><strong>${escapeHtml(profile.role)}</strong></div>` : ""}
      ${profile.level ? `<div class="profile-row"><span>等级</span><strong>${escapeHtml(profile.level)}</strong></div>` : ""}
      ${profile.title ? `<div class="profile-row"><span>头衔</span><strong>${escapeHtml(profile.title)}</strong></div>` : ""}
      <div class="profile-row"><span>会话</span><strong>${escapeHtml(shortUmo(item.umo || ""))}</strong></div>
      <div class="profile-row"><span>时间</span><strong>${escapeHtml(fmtFullTime(item.created_at))}</strong></div>
    </div>
    <footer>
      <button type="button" data-action="copy-sender">复制账号</button>
      <button type="button" data-action="filter-sender">筛选此人</button>
    </footer>
  `;
  els.profilePopover.hidden = false;
  const rect = els.profilePopover.getBoundingClientRect();
  els.profilePopover.style.left = `${Math.min(Math.max(12, x), window.innerWidth - rect.width - 12)}px`;
  els.profilePopover.style.top = `${Math.min(Math.max(12, y), window.innerHeight - rect.height - 12)}px`;
  els.profilePopover.querySelector(".profile-close")?.addEventListener("click", hideProfilePopover);
  els.profilePopover.onclick = async (event) => {
    const action = event.target?.closest?.("button")?.dataset.action;
    if (action === "copy-sender") {
      await copyText(profile.primaryId || profile.name);
      hideProfilePopover();
    }
    if (action === "filter-sender") {
      state.filters.sender = profile.name || profile.primaryId || "";
      syncFilterForm();
      hideProfilePopover();
      await loadMessages({ stickToBottom: true });
    }
  };
  bindRecoverableImages(els.profilePopover, { removeOnFinalError: true });
}

function hideProfilePopover() {
  if (els.profilePopover) els.profilePopover.hidden = true;
  state.profileItem = null;
}

function showRaw(item) {
  els.detailPane.hidden = false;
  els.rawJson.textContent = JSON.stringify(item, null, 2);
}

function openMediaViewer(item) {
  state.mediaItems = allDisplayableMediaItems();
  const targetUrl = mediaDisplayUrl(item);
  state.mediaIndex = Math.max(0, state.mediaItems.findIndex((m) => String(m.id || mediaDisplayUrl(m)) === String(item.id || targetUrl)));
  renderMediaViewer();
  els.mediaViewer.hidden = false;
}

function renderMediaViewer() {
  const item = state.mediaItems[state.mediaIndex];
  if (!item) return;
  els.mediaViewerBody.replaceChildren();
  const kind = normalizeMediaKind(item.kind);
  const displayUrl = mediaDisplayUrl(item);
  let node;
  if (kind === "image") {
    node = document.createElement("img");
    node.alt = item.name || "图片";
  } else if (kind === "video") {
    node = document.createElement("video");
    node.controls = true;
    node.autoplay = false;
  } else if (kind === "audio") {
    node = document.createElement("audio");
    node.controls = true;
  } else {
    node = document.createElement("div");
    node.className = "viewer-file";
    node.innerHTML = `<div class="file-icon">${escapeHtml(fileIcon(kind))}</div><strong>${escapeHtml(item.name || "文件")}</strong><span>${escapeHtml(item.mime || item.source || "可下载文件")}</span>`;
  }
  els.mediaViewerBody.appendChild(node);
  if ("src" in node && displayUrl) {
    if (kind === "image") {
      protectedImageDataUrl(displayUrl)
        .then((dataUrl) => {
          node.src = dataUrl || displayUrl;
        })
        .catch(() => {
          node.src = displayUrl;
        });
      bindRecoverableImages(els.mediaViewerBody);
    } else {
      node.src = displayUrl;
    }
  }
  els.mediaViewerCaption.textContent = `${item.name || mediaKindLabel(kind)} / ${state.mediaIndex + 1}/${state.mediaItems.length}`;
  els.prevMediaBtn.disabled = state.mediaIndex <= 0;
  els.nextMediaBtn.disabled = state.mediaIndex >= state.mediaItems.length - 1;
  els.downloadViewerBtn.disabled = !displayUrl;
}

function closeMediaViewer() {
  els.mediaViewer.hidden = true;
}

function createEmpty(title, description, tone = "") {
  const empty = document.createElement("div");
  empty.className = `empty ${tone}`.trim();
  const emptyTitle = title || (state.q ? "没有匹配消息" : "暂无归档消息");
  const emptyDescription = description || (state.q ? "换一个关键词或发送者再试。" : "捕获到消息后，这里会显示时间线。");
  empty.innerHTML = `<strong>${escapeHtml(emptyTitle)}</strong><span>${escapeHtml(emptyDescription)}</span>`;
  return empty;
}

function createLoading() {
  const loading = document.createElement("div");
  loading.className = "loading-state";
  loading.innerHTML = `
    <div class="skeleton bubble-skeleton"></div>
    <div class="skeleton bubble-skeleton short"></div>
    <div class="skeleton bubble-skeleton self"></div>
  `;
  return loading;
}

function renderFilters() {
  fillSelect(els.typeFilter, "全部类型", state.filterOptions.message_types, (value) => messageTypeLabel(value));
  fillSelect(els.mediaFilter, "全部媒体", state.filterOptions.media_kinds, (value) => mediaKindLabel(value));
}

function renderTagChipHtml(tag) {
  const color = tag.color || "#3390ec";
  return `<span class="tag-chip" style="--tag-color:${escapeAttr(color)}">${escapeHtml(tag.name || "标签")}</span>`;
}

async function toggleFavorite(item) {
  const next = !item.favorite;
  const result = await apiPost("/favorite", { message_uid: messageKey(item), favorite: next });
  updateMessageLocal(messageKey(item), { favorite: Boolean(result.favorite) });
  await loadStats().catch(() => {});
  toast(next ? "已收藏" : "已取消收藏");
}

function openTagDialog(item) {
  state.currentTagMessage = item;
  renderTagDialog();
  if (els.tagDialog?.showModal) {
    els.tagDialog.showModal();
  } else {
    els.tagDialog.setAttribute("open", "");
  }
}

function renderTagDialog() {
  const item = state.currentTagMessage;
  if (!item || !els.tagDialogList) return;
  const messageTags = new Set((item.tags || []).map((tag) => Number(tag.id)));
  if (!state.tags.length) {
    els.tagDialogList.innerHTML = `<div class="empty-inline">暂无标签，先创建一个。</div>`;
    return;
  }
  els.tagDialogList.replaceChildren(
    ...state.tags.map((tag) => {
      const label = document.createElement("label");
      label.className = "tag-option";
      label.innerHTML = `
        <input type="checkbox" ${messageTags.has(Number(tag.id)) ? "checked" : ""} />
        <span class="tag-dot" style="--tag-color:${escapeAttr(tag.color || "#3390ec")}"></span>
        <span>${escapeHtml(tag.name)}</span>
        <small>${fmtNumber(tag.message_count || 0)}</small>
      `;
      label.querySelector("input").addEventListener("change", async (event) => {
        const enabled = Boolean(event.target.checked);
        const result = await apiPost("/message-tags", { message_uid: messageKey(item), tag_id: tag.id, enabled });
        updateMessageLocal(messageKey(item), { tags: result.tags || [] });
        await loadTags();
        renderTagDialog();
        toast(enabled ? "已添加标签" : "已移除标签");
      });
      return label;
    }),
  );
}

async function createTagFromDialog() {
  const name = els.newTagName?.value.trim() || "";
  if (!name) {
    toast("请输入标签名称");
    return;
  }
  const tag = await apiPost("/tags", { name, color: els.newTagColor?.value || "" });
  els.newTagName.value = "";
  await loadTags();
  state.tags = dedupeTags([tag, ...state.tags]);
  renderTagDialog();
  toast("标签已创建");
}

function dedupeTags(tags) {
  const seen = new Set();
  return (tags || []).filter((tag) => {
    const id = Number(tag.id || 0);
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function updateMessageLocal(uid, patch) {
  state.messages = state.messages.map((message) => (messageKey(message) === uid ? { ...message, ...patch } : message));
  renderTimeline({ preserveTop: true });
  renderInspector();
}

function hasActiveFilters() {
  return Boolean(
    state.filters.sender ||
      state.filters.messageType ||
      state.filters.mediaKind ||
      state.filters.startTs ||
      state.filters.endTs,
  );
}

async function recordSearchHistory(items) {
  if (!state.q && !hasActiveFilters()) return;
  await apiPost("/search-history", {
    query: state.q,
    filters: {
      umo: state.currentUmo,
      sender: state.filters.sender,
      message_type: state.filters.messageType,
      media_kind: state.filters.mediaKind,
      start_ts: state.filters.startTs,
      end_ts: state.filters.endTs,
    },
    hit_count: Array.isArray(items) ? items.length : 0,
  });
}

function renderSearchHistory() {
  if (!els.historyList) return;
  if (!state.searchHistory.length) {
    els.historyList.innerHTML = `<div class="empty-inline">暂无搜索历史。</div>`;
    return;
  }
  els.historyList.replaceChildren(
    ...state.searchHistory.map((item) => {
      const button = document.createElement("button");
      button.className = "history-item";
      button.type = "button";
      const filters = item.filters || {};
      const filterCount = Object.keys(filters).length;
      button.innerHTML = `
        <span>${escapeHtml(item.query || "过滤条件")}</span>
        <small>${fmtNumber(item.hit_count)} 个结果 / ${filterCount ? `${filterCount} 个过滤` : "无过滤"}</small>
      `;
      button.addEventListener("click", async () => {
        state.q = item.query || "";
        els.searchInput.value = state.q;
        state.filters.sender = filters.sender || "";
        state.filters.messageType = filters.message_type || "";
        state.filters.mediaKind = filters.media_kind || "";
        state.filters.startTs = filters.start_ts || null;
        state.filters.endTs = filters.end_ts || null;
        syncFilterForm();
        if (filters.umo !== undefined) {
          state.currentUmo = filters.umo || "";
          renderConversations();
        }
        els.settingsDialog.close();
        await loadMessages({ stickToBottom: true });
      });
      return button;
    }),
  );
}

function fillSelect(select, emptyLabel, rows, labeler) {
  if (!select) return;
  const current = select.value;
  select.replaceChildren(new Option(emptyLabel, ""));
  for (const row of rows || []) {
    const value = String(row.value || "");
    if (!value) continue;
    select.appendChild(new Option(`${labeler(value)} (${fmtNumber(row.count)})`, value));
  }
  select.value = current;
}

function updateHeader() {
  const current = state.conversations.find((item) => item.umo === state.currentUmo);
  els.currentTitle.textContent = state.currentUmo ? shortUmo(state.currentUmo) : "全部会话";
  els.currentMeta.textContent = state.currentUmo
    ? `${fmtNumber(current?.message_count || state.messages.length)} 条消息 / ${current?.latest_at ? fmtFullTime(current.latest_at) : "暂无最新时间"}`
    : `已载入 ${fmtNumber(state.messages.length)} 条 / ${state.hasMore ? "还有更早消息" : "已到最早消息"}`;
  updateSearchUi();
  renderInspector();
}

function updateSearchUi() {
  const matches = searchMatches();
  if (!state.q) {
    els.searchCount.textContent = "";
  } else if (!matches.length) {
    els.searchCount.textContent = "0 个结果";
  } else {
    const active = state.activeMatchIndex >= 0 ? state.activeMatchIndex + 1 : 1;
    els.searchCount.textContent = `${active}/${matches.length}`;
  }
  els.prevSearchBtn.disabled = !matches.length;
  els.nextSearchBtn.disabled = !matches.length;
}

function searchMatches() {
  if (!state.q) return [];
  const needle = state.q.toLocaleLowerCase();
  return state.messages
    .map((item, index) => ({ item, index, text: `${messagePlainText(item)} ${systemTipText(item)} ${item.sender_name || ""}`.toLocaleLowerCase() }))
    .filter((entry) => entry.text.includes(needle));
}

function jumpSearch(direction) {
  const matches = searchMatches();
  if (!matches.length) return;
  const start = state.activeMatchIndex >= 0 ? state.activeMatchIndex : direction > 0 ? -1 : 0;
  state.activeMatchIndex = (start + direction + matches.length) % matches.length;
  renderTimeline({ preserveTop: true });
  requestAnimationFrame(() => {
    scrollTimelineToKey(`msg-${messageKey(matches[state.activeMatchIndex].item)}`);
    updateSearchUi();
  });
}

function scrollTimelineToKey(key) {
  const target = els.timeline.querySelector(`[data-key="${CSS.escape(key)}"]`);
  if (!target) return;
  target.scrollIntoView({ block: "center", behavior: "smooth" });
}

function updateJumpButton() {
  els.jumpLatestBtn.hidden = isNearBottom();
  if (!els.jumpLatestBtn.hidden && !els.jumpLatestBtn.textContent) {
    els.jumpLatestBtn.textContent = "跳到最新";
  }
  if (isNearBottom()) {
    markCurrentConversationSeen().catch(() => {});
  }
}

function isNearBottom() {
  return els.timeline.scrollHeight - els.timeline.scrollTop - els.timeline.clientHeight < 120;
}

function scrollTimelineToBottom() {
  els.timeline.scrollTop = Math.max(0, els.timeline.scrollHeight - els.timeline.clientHeight);
}

function textFromComponents(components) {
  if (!Array.isArray(components)) return "";
  return components
    .flatMap((item) => normalizedElementsFromComponent(item))
    .map((item) => componentText(item.raw || item))
    .filter(Boolean)
    .join("");
}

function messagePlainText(item) {
  const text = String(item?.text || "");
  const componentTextValue = textFromComponents(item?.components);
  const rawText = textFromRawElements(item?.raw);
  return text || componentTextValue || rawText;
}

function messageBodyHtml(item) {
  const skipInlineMedia = Array.isArray(item?.media) && item.media.length > 0;
  const rendered = messageElementObjects(item)
    .map((component) => renderComponentInlineHtml(component, { skipMedia: skipInlineMedia }))
    .filter(Boolean)
    .join("");
  if (rendered) return rendered;
  const plain = messagePlainText(item);
  if (skipInlineMedia && isMediaPlaceholderText(plain)) return "";
  return plain ? highlightText(plain, state.q) : "";
}

function messageElementObjects(item) {
  const elements = [];
  for (const component of Array.isArray(item?.components) ? item.components : []) {
    elements.push(...normalizedElementsFromComponent(component));
  }
  for (const element of rawElements(item?.raw)) {
    elements.push(normalizeMessageElement(element, "raw"));
  }
  return dedupeNormalizedElements(elements);
}

function mediaForMessage(item) {
  return mediaForGrid(item);
}

function mediaForGrid(item) {
  const dbMedia = Array.isArray(item?.media) ? item.media : [];
  const inlineMedia = inlineMediaItemsFromMessage(item);
  if (!dbMedia.length) return dedupeMediaItems(inlineMedia);
  return dedupeMediaItems(dbMedia);
}

function dedupeMediaItems(items) {
  const result = [];
  const seen = new Set();
  for (const item of items || []) {
    if (!item || typeof item !== "object") continue;
    const key = `${normalizeMediaKind(item.kind)}:${canonicalMediaSource(item) || item.id || item.name || result.length}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function canonicalMediaSource(item) {
  const source = firstMediaSource(item, ["inline_url", "source", "url", "path", "relative_path", "relativePath", "filePath", "localPath"]);
  return normalizeQpicSource(source);
}

function componentText(component) {
  if (!component || typeof component !== "object") return "";
  const raw = unwrapMessageElement(component.raw || component.data || component);
  if (!raw || typeof raw !== "object") return "";
  return String(
      raw.text ??
      raw.content ??
      raw.message ??
      raw.data?.text ??
      raw.data?.content ??
      raw.textElement?.content ??
      raw.textElement?.text ??
      raw.faceText ??
      raw.fileElement?.fileName ??
      raw.pttElement?.text ??
      raw.videoElement?.fileName ??
      raw.picElement?.summary ??
      raw.fileName ??
      raw.name ??
      "",
  );
}

function renderComponentInlineHtml(component, options = {}) {
  if (!component || typeof component !== "object") return "";
  const raw = unwrapMessageElement(component.raw || component.data || component);
  const kind = inferElementKind(raw, component.kind);
  const typeHint = Number(raw.type ?? component.type);
  const elementTypeHint = Number(raw.elementType ?? component.elementType);
  if (options.skipMedia && isMediaElement(raw, kind, typeHint, elementTypeHint)) return "";
  if (raw.picElement || raw.imageElement) return renderPicElementHtml(raw.picElement || raw.imageElement, raw);
  if (raw.mfaceElement) return renderMarketFaceHtml(raw.mfaceElement);
  if (raw.faceElement) return renderFaceHtml(raw.faceElement);
  if (raw.marketFaceElement || raw.market_face) return renderMarketFaceHtml(raw.marketFaceElement || raw.market_face);
  if (raw.fileElement) return renderFileElementHtml(raw.fileElement);
  if (raw.pttElement || raw.voiceElement || raw.recordElement || raw.audioElement) return renderPttElementHtml(raw.pttElement || raw.voiceElement || raw.recordElement || raw.audioElement, raw);
  if (raw.videoElement) return renderVideoElementHtml(raw.videoElement, raw);
  if (raw.multiForwardMsgElement) return renderForwardElementHtml(raw.multiForwardMsgElement);
  if (raw.arkElement) return renderArkElementHtml(raw.arkElement);
  if (raw.atElement || raw.mentionElement) return renderMentionHtml(raw.atElement || raw.mentionElement);
  if (raw.replyElement || raw.grayTipElement) return "";
  if (raw.textElement?.content) return highlightText(raw.textElement.content, state.q);
  if (raw.textElement?.text) return highlightText(raw.textElement.text, state.q);
  if (raw.text) return highlightText(raw.text, state.q);
  if (raw.data?.text) return highlightText(raw.data.text, state.q);
  if (raw.content) return highlightText(raw.content, state.q);
  if (typeHint === 2 || elementTypeHint === 2) return renderPicElementHtml(raw, raw);
  if (typeHint === 3 || elementTypeHint === 6) return renderFaceHtml(raw);
  if (typeHint === 6 || elementTypeHint === 3) return renderFileElementHtml(raw);
  if (elementTypeHint === 4) return renderPttElementHtml(raw, raw);
  if (elementTypeHint === 5) return renderVideoElementHtml(raw, raw);
  if (elementTypeHint === 16) return renderForwardElementHtml(raw);
  if (elementTypeHint === 10) return renderArkElementHtml(raw);
  if (kind === "image") return renderPicElementHtml(raw, raw);
  if (kind === "face") return renderFaceHtml(raw);
  if (kind === "file") return renderFileElementHtml(raw);
  if (kind === "audio") return renderPttElementHtml(raw, raw);
  if (kind === "video") return renderVideoElementHtml(raw, raw);
  if (kind === "mention" || kind === "at") return renderMentionHtml(raw);
  if (kind === "text") return highlightText(componentText(component), state.q);
  return "";
}

function isMediaElement(raw, kind = "", typeHint = NaN, elementTypeHint = NaN) {
  if (!raw || typeof raw !== "object") return false;
  return Boolean(
    raw.picElement ||
      raw.imageElement ||
      raw.mfaceElement ||
      raw.marketFaceElement ||
      raw.market_face ||
      raw.fileElement ||
      raw.pttElement ||
      raw.voiceElement ||
      raw.recordElement ||
      raw.audioElement ||
      raw.videoElement ||
      typeHint === 2 ||
      typeHint === 3 ||
      typeHint === 6 ||
      elementTypeHint === 2 ||
      elementTypeHint === 3 ||
      elementTypeHint === 4 ||
      elementTypeHint === 5 ||
      elementTypeHint === 6 ||
      ["image", "face", "file", "audio", "video"].includes(String(kind || ""))
  );
}

function isMediaPlaceholderText(value) {
  const text = String(value || "").replace(/\s+/g, "").trim();
  if (!text) return true;
  const stripped = text.replace(/(\[?图片\]?|\[?表情包?\]?|\[?视频\]?|\[?语音\]?|\[?文件\]?|图|图片不可用)/g, "");
  return stripped.length === 0;
}


function renderMentionHtml(mention) {
  const name = mention?.name || mention?.nick || mention?.uin || mention?.uid || mention?.target || mention?.text || "成员";
  return `<span class="inline-mention">@${escapeHtml(name)}</span>`;
}

function renderFaceHtml(face) {
  const id = face?.faceIndex ?? face?.faceId ?? face?.id ?? "";
  const label = face?.faceText || face?.name || (id !== "" ? `[表情${id}]` : "[表情]");
  const source = firstMediaSource(face, ["url", "faceUrl", "face_url", "imageUrl", "image_url", "fileUrl", "file_url", "filePath", "file_path", "path"]);
  const displayUrl = source ? mediaSourceDisplayUrl({ kind: "image", source }) : "";
  if (!displayUrl) return `<span class="inline-face" title="${escapeAttr(label)}">${escapeHtml(label)}</span>`;
  return `<span class="inline-face-shell"><img class="inline-face-img" loading="lazy" src="${escapeAttr(displayUrl)}" alt="${escapeAttr(label)}" title="${escapeAttr(label)}" /><em>${escapeHtml(label)}</em></span>`;
}

function renderMarketFaceHtml(face) {
  const emojiId = String(face?.emojiId || face?.emoji_id || face?.id || "").trim();
  const faceName = face?.faceName || face?.face_name || face?.summary || face?.name || "表情包";
  const directSource = firstMediaSource(face, ["url", "faceUrl", "face_url", "imageUrl", "image_url", "emojiWebUrl", "emojiUrl", "emoji_url", "fileUrl", "file_url", "path", "filePath", "file_path"]);
  const sizes = Array.isArray(face?.supportSize) ? face.supportSize : [];
  const size = sizes[0] || {};
  const width = Math.min(Number(size.width || 120), 180);
  const height = Math.min(Number(size.height || 120), 180);
  if (directSource) {
    const displayUrl = mediaSourceDisplayUrl({ kind: "image", source: directSource });
    if (displayUrl) {
      return `<span class="market-face-shell"><img class="inline-market-face" loading="lazy" src="${escapeAttr(displayUrl)}" alt="${escapeAttr(faceName)}" title="${escapeAttr(faceName)}" style="max-width:${width}px;max-height:${height}px" /><em>${escapeHtml(`[${faceName}]`)}</em></span>`;
    }
  }
  if (!emojiId) return `<span class="inline-face market">${escapeHtml(`[${faceName}]`)}</span>`;
  const rawUrl = marketFaceSource(face);
  const proxyUrl = pluginApiUrl(`image-proxy?url=${encodeURIComponent(rawUrl)}`);
  return `<span class="market-face-shell"><img class="inline-market-face" loading="lazy" src="${escapeAttr(proxyUrl)}" alt="${escapeAttr(faceName)}" title="${escapeAttr(faceName)}" style="max-width:${width}px;max-height:${height}px" /><em>${escapeHtml(`[${faceName}]`)}</em></span>`;
}

function renderPicElementHtml(pic, wrapper = {}) {
  const source = normalizeQpicSource(firstMediaSource(pic, [
    "originImageUrl",
    "origin_image_url",
    "picUrl",
    "pic_url",
    "thumbUrl",
    "thumb_url",
    "previewUrl",
    "preview_url",
    "fileUrl",
    "file_url",
    "imageUrl",
    "image_url",
    "url",
    "source",
    "file",
    "file_id",
    "fileId",
    "path",
    "filePath",
    "file_path",
    "localPath",
    "sourcePath",
    "source_path",
    "thumbPath",
    "thumb_path",
    "md5HexStr",
  ]));
  const displayUrl = mediaSourceDisplayUrl({ kind: "image", source });
  const label = pic?.summary || pic?.fileName || pic?.file || pic?.name || wrapper?.summary || "图片";
  if (!displayUrl) return `<span class="inline-face">${escapeHtml(`[${label}]`)}</span>`;
  const size = previewSize(pic?.picWidth || pic?.width || pic?.originWidth || pic?.thumbWidth, pic?.picHeight || pic?.height || pic?.originHeight || pic?.thumbHeight, 260, 220, 120, 92);
  return `
    <button class="inline-image-preview" type="button" data-inline-media-kind="image" data-inline-media-name="${escapeAttr(label)}" data-inline-image="${escapeAttr(displayUrl)}" aria-label="预览图片" style="width:${size.width}px;height:${size.height}px">
      <span class="media-loading">图片加载中</span>
      <span class="media-error">图片不可用</span>
      <img loading="lazy" src="${escapeAttr(displayUrl)}" alt="${escapeAttr(label)}" />
    </button>
  `;
}

function renderFileElementHtml(file) {
  const name = file?.fileName || file?.name || file?.file_name || file?.file || firstMediaSource(file, ["filePath", "path", "url"]) || "文件";
  const size = file?.fileSize ?? file?.size ?? file?.file_size;
  const source = firstMediaSource(file, mediaSourceKeys("file"));
  const displayUrl = mediaSourceDisplayUrl({ kind: "file", source });
  return `
    <span class="inline-rich-card file-element">
      <span class="rich-card-icon">文</span>
      <span class="rich-card-main">
        <strong>${escapeHtml(name)}</strong>
        <small>${size ? escapeHtml(fmtBytes(size)) : "文件消息"}</small>
      </span>
      ${displayUrl ? `<a class="inline-card-action" href="${escapeAttr(displayUrl)}" target="_blank" rel="noopener" download>下载</a>` : ""}
    </span>
  `;
}

function renderPttElementHtml(ptt, wrapper = {}) {
  const duration = Number(ptt?.duration || ptt?.fileTime || ptt?.time || wrapper?.duration || 0);
  const width = Math.min(220, Math.max(96, 96 + duration * 4));
  const text = ptt?.text || ptt?.transcribedText || "";
  const source = firstMediaSource(ptt, mediaSourceKeys("audio"));
  const mediaItem = { kind: "audio", source, mime: ptt?.mime || ptt?.contentType || ptt?.content_type, name: ptt?.fileName || ptt?.name || source };
  const displayUrl = mediaSourceDisplayUrl(mediaItem);
  const playable = displayUrl && isBrowserPlayableAudio(mediaItem);
  return `
    <span class="voice-element">
      <span class="voice-bar" style="width:${width}px">
        <span class="voice-play">▶</span>
        <span class="voice-wave" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>
        <span class="voice-duration">${escapeHtml(formatDuration(duration))}</span>
      </span>
      ${playable ? `<audio class="voice-audio" controls preload="metadata" src="${escapeAttr(displayUrl)}"></audio>` : ""}
      ${displayUrl && !playable ? `<a class="voice-download" href="${escapeAttr(displayUrl)}" target="_blank" rel="noopener" download>下载语音</a>` : ""}
      ${!displayUrl ? `<span class="voice-unavailable">语音源不可用</span>` : ""}
      ${text ? `<span class="voice-text">${highlightText(text, state.q)}</span>` : ""}
    </span>
  `;
}

function renderVideoElementHtml(video, wrapper = {}) {
  const thumb = firstMediaSource(video, ["thumbPath", "thumb_path", "thumbUrl", "thumb_url", "thumb", "coverUrl", "cover_url", "cover", "previewUrl", "preview_url", "originImageUrl", "origin_image_url"]);
  const source = firstMediaSource(video, mediaSourceKeys("video"));
  const duration = Number(video?.fileTime || video?.duration || 0);
  const name = video?.fileName || video?.name || "视频";
  const thumbUrl = thumb ? mediaSourceDisplayUrl({ kind: "image", source: thumb }) : "";
  const displayUrl = mediaSourceDisplayUrl({ kind: "video", source });
  const size = previewSize(video?.thumbWidth || video?.width || wrapper?.width, video?.thumbHeight || video?.height || wrapper?.height, 300, 220, 220, 150);
  return `
    <button class="video-element" type="button" data-inline-media-kind="video" data-inline-media-name="${escapeAttr(name)}" ${displayUrl ? `data-inline-video="${escapeAttr(displayUrl)}"` : ""} aria-label="预览视频" style="width:${size.width}px;height:${size.height}px">
      <span class="video-cover">
        ${thumbUrl ? `<span class="media-loading">缩略图加载中</span><span class="media-error">缩略图不可用</span>` : ""}
        ${thumbUrl ? `<img loading="lazy" src="${escapeAttr(thumbUrl)}" alt="${escapeAttr(name)}" />` : `<span>视频</span>`}
        <b>▶</b>
      </span>
      <span class="video-caption">
        <strong>${escapeHtml(name)}</strong>
        <small>${escapeHtml(duration ? formatDuration(duration) : (displayUrl ? "点击播放" : "视频消息"))}</small>
      </span>
    </button>
  `;
}

function renderForwardElementHtml(forward) {
  const parsed = parseForwardData(forward);
  const title = parsed.title || forward?.title || "[聊天记录]";
  const previews = parsed.previews.slice(0, 3);
  const summary = parsed.summary || forward?.summary || "合并转发";
  return renderForwardCardHtml(title, previews, summary, parsed);
}

function renderArkElementHtml(ark) {
  let data = ark?.data || ark?.arkData || null;
  if (!data && ark?.bytesData) {
    try {
      data = JSON.parse(ark.bytesData);
    } catch {
      data = null;
    }
  }
  if (data?.app === "com.tencent.multimsg" && data?.meta?.detail) {
    const detail = data.meta.detail;
    return renderForwardCardHtml(
      detail.source || "[聊天记录]",
      (detail.news || []).map((item) => item.text || "").filter(Boolean).slice(0, 3),
      detail.summary || "合并转发",
      parseArkForwardData(data),
    );
  }
  const prompt = data?.prompt || ark?.prompt || "[卡片消息]";
  return `<span class="inline-rich-card ark-element"><span class="rich-card-icon">卡</span><span class="rich-card-main"><strong>${escapeHtml(prompt)}</strong><small>Ark 卡片</small></span></span>`;
}

function renderForwardCardHtml(title, previews, summary, parsed = null) {
  const previewKey = registerForwardPreview(parsed || { title, previews, summary, messages: [] });
  return `
    <button class="forward-card" type="button" data-forward-preview="${escapeAttr(previewKey)}" aria-label="预览合并转发">
      <strong>${escapeHtml(title || "[聊天记录]")}</strong>
      ${previews.map((preview) => `<span>${escapeHtml(preview)}</span>`).join("")}
      <small>${escapeHtml(summary || "合并转发")}</small>
    </button>
  `;
}

function registerForwardPreview(parsed) {
  if (!(state.forwardPreview instanceof Map)) state.forwardPreview = new Map();
  const key = stableForwardPreviewKey(parsed);
  state.forwardPreview.set(key, parsed);
  return key;
}

function getForwardPreview(key) {
  if (!(state.forwardPreview instanceof Map)) return null;
  return state.forwardPreview.get(String(key || "")) || null;
}

function stableForwardPreviewKey(parsed) {
  const raw = JSON.stringify({
    title: parsed?.title || "",
    summary: parsed?.summary || "",
    resId: parsed?.resId || "",
    previews: parsed?.previews || [],
    messages: (parsed?.messages || []).map((item) => ({
      id: item.id || "",
      sender: item.sender || "",
      time: item.time || "",
      text: item.text || "",
    })),
  });
  let hash = 2166136261;
  for (let index = 0; index < raw.length; index += 1) {
    hash ^= raw.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fw-${(hash >>> 0).toString(36)}`;
}

function forwardPreviewsFromMessage(item) {
  const result = [];
  for (const element of messageElementObjects(item)) {
    const raw = unwrapMessageElement(element.raw || element);
    if (raw?.multiForwardMsgElement) result.push(parseForwardData(raw.multiForwardMsgElement));
    if (raw?.arkElement) {
      const parsed = parseArkForwardFromElement(raw.arkElement);
      if (parsed) result.push(parsed);
    }
  }
  return result;
}

function parseForwardData(forward) {
  const parsed = parseForwardXml(forward?.xmlContent || forward?.xml || "");
  const messages = normalizeForwardMessages(
    forward?.messages ||
      forward?.items ||
      forward?.previewList ||
      forward?.data?.messages ||
      forward?.data?.items ||
      [],
  );
  return {
    title: parsed.title || forward?.title || "[聊天记录]",
    previews: parsed.previews.length ? parsed.previews : messages.map((item) => `${item.sender}: ${item.text}`).slice(0, 5),
    summary: parsed.summary || forward?.summary || (messages.length ? `${messages.length} 条消息` : "合并转发"),
    messages,
  };
}

function parseArkForwardFromElement(ark) {
  let data = ark?.data || ark?.arkData || null;
  if (!data && ark?.bytesData) {
    try {
      data = JSON.parse(ark.bytesData);
    } catch {
      data = null;
    }
  }
  return parseArkForwardData(data);
}

function parseArkForwardData(data) {
  const detail = data?.meta?.detail;
  if (!detail) return null;
  return {
    title: detail.source || "[聊天记录]",
    previews: (detail.news || []).map((item) => item.text || "").filter(Boolean).slice(0, 5),
    summary: detail.summary || "合并转发",
    messages: normalizeForwardMessages(detail.news || []),
    resId: detail.resid || "",
  };
}

function normalizeForwardMessages(items) {
  if (!Array.isArray(items)) return [];
  return items
    .map((item, index) => {
      if (typeof item === "string") return { id: `line-${index}`, sender: "消息", text: item, time: "", segments: [{ type: "text", data: { text: item } }] };
      if (!item || typeof item !== "object") return null;
      const segments = normalizeForwardSegments(item);
      const text = item.text || item.summary || item.content || segments.map((segment) => forwardSegmentText(segment)).join("");
      return {
        id: item.msgId || item.msgSeq || item.id || `line-${index}`,
        sender: item.sender || item.senderName || item.nickname || item.userName || item.nick || "未知用户",
        text: text || "[消息]",
        time: item.time || item.timestamp || item.msgTime || "",
        segments,
      };
    })
    .filter(Boolean);
}

function normalizeForwardSegments(item) {
  const rawSegments = Array.isArray(item?.segments)
    ? item.segments
    : Array.isArray(item?.elements)
      ? item.elements
      : Array.isArray(item?.message)
        ? item.message
        : [];
  if (!rawSegments.length && (item?.text || item?.content || item?.summary)) {
    return [{ type: "text", data: { text: item.text || item.content || item.summary } }];
  }
  return rawSegments
    .map((segment) => {
      const data = unwrapMessageElement(segment?.data || segment);
      return { type: inferElementKind(data, segment?.type || segment?.kind), data };
    })
    .filter((segment) => segment.data && typeof segment.data === "object");
}

function forwardSegmentText(segment) {
  if (!segment) return "";
  const data = segment.data || segment;
  const type = String(segment.type || inferElementKind(data)).toLowerCase();
  if (type === "text") return data.text || data.content || "";
  if (type === "image") return "[图片]";
  if (type === "face") return data.faceText || "[表情]";
  if (type === "audio") return "[语音]";
  if (type === "video") return "[视频]";
  if (type === "file") return `[文件${data.fileName ? `: ${data.fileName}` : ""}]`;
  if (type === "forward") return "[聊天记录]";
  return rawElementText(data);
}

function renderForwardSegmentHtml(segment) {
  if (!segment) return "";
  const data = segment.data || segment;
  const type = String(segment.type || inferElementKind(data)).toLowerCase();
  if (type === "text") return highlightText(data.text || data.content || data.textElement?.content || "", state.q);
  if (type === "image") return renderPicElementHtml(data.picElement || data.imageElement || data, data);
  if (type === "face") return renderFaceHtml(data.faceElement || data);
  if (type === "mention" || type === "at") return renderMentionHtml(data.atElement || data.mentionElement || data);
  if (type === "audio") return renderPttElementHtml(data.pttElement || data.voiceElement || data.recordElement || data.audioElement || data, data);
  if (type === "video") return renderVideoElementHtml(data.videoElement || data, data);
  if (type === "file") return renderFileElementHtml(data.fileElement || data);
  if (type === "forward") return renderForwardElementHtml(data.multiForwardMsgElement || data);
  if (type === "ark") return renderArkElementHtml(data.arkElement || data);
  return highlightText(forwardSegmentText(segment), state.q);
}

function openForwardViewer(parsed) {
  if (!els.forwardViewer || !els.forwardViewerBody) return;
  els.forwardViewerTitle.textContent = parsed.title || "合并转发";
  const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
  els.forwardViewerBody.innerHTML = messages.length
    ? messages
        .map((item) => `
          <article class="forward-message">
            <header><strong>${escapeHtml(item.sender || "未知用户")}</strong>${item.time ? `<span>${escapeHtml(formatForwardTime(item.time))}</span>` : ""}</header>
            <div class="forward-segments">
              ${
                Array.isArray(item.segments) && item.segments.length
                  ? item.segments.map(renderForwardSegmentHtml).filter(Boolean).join("")
                  : highlightText(item.text || "[消息]", state.q)
              }
            </div>
          </article>
        `)
        .join("")
    : `
      <div class="forward-preview-list">
        ${(parsed.previews || []).map((preview) => `<p>${escapeHtml(preview)}</p>`).join("") || `<p>${escapeHtml(parsed.summary || "该合并转发只有摘要，原始消息正文未随归档保存。")}</p>`}
      </div>
    `;
  bindForwardViewerInteractions();
  els.forwardViewer.hidden = false;
}

function bindForwardViewerInteractions() {
  if (!els.forwardViewerBody) return;
  els.forwardViewerBody.querySelectorAll(".inline-image-preview img").forEach((image) => {
    bindImageLoadState(image, image.closest(".inline-image-preview"));
  });
  els.forwardViewerBody.querySelectorAll(".video-element img").forEach((image) => {
    bindImageLoadState(image, image.closest(".video-element"));
  });
  els.forwardViewerBody.querySelectorAll(".inline-market-face, .inline-face-img").forEach((image) => {
    image.addEventListener("error", async () => {
      if (await recoverImageSource(image)) return;
      image.parentElement?.classList.add("no-image");
      image.remove();
    });
  });
  els.forwardViewerBody.onclick = handleForwardViewerClick;
}

function handleForwardViewerClick(event) {
  const inlineImage = event.target?.closest?.("[data-inline-image]");
  if (inlineImage?.dataset.inlineImage) {
    openInlineMediaViewer({
      kind: "image",
      name: inlineImage.dataset.inlineMediaName || "图片",
      inline_url: inlineImage.dataset.inlineImage,
    });
    return;
  }
  const inlineVideo = event.target?.closest?.("[data-inline-video]");
  if (inlineVideo?.dataset.inlineVideo) {
    openInlineMediaViewer({
      kind: "video",
      name: inlineVideo.dataset.inlineMediaName || "视频",
      inline_url: inlineVideo.dataset.inlineVideo,
    });
    return;
  }
  const forwardTarget = event.target?.closest?.("[data-forward-preview]");
  if (forwardTarget?.dataset.forwardPreview) {
    const forward = getForwardPreview(forwardTarget.dataset.forwardPreview);
    if (forward) openForwardViewer(forward);
  }
}

function closeForwardViewer() {
  if (els.forwardViewer) els.forwardViewer.hidden = true;
}

function formatForwardTime(value) {
  const ts = Number(value || 0);
  if (ts > 100000000000) return new Date(ts).toLocaleString("zh-CN");
  if (ts > 1000000000) return fmtFullTime(ts);
  return String(value || "");
}

function parseForwardXml(xml) {
  const text = String(xml || "");
  if (!text) return { title: "", previews: [], summary: "" };
  const title = stripHtml(matchFirst(text, /<title[^>]*color=["']#000000["'][^>]*>(.*?)<\/title>/i) || matchFirst(text, /brief=["']([^"']+)["']/i) || "[聊天记录]");
  const previews = [...text.matchAll(/<title[^>]*color=["']#777777["'][^>]*>(.*?)<\/title>/gi)].map((match) => stripHtml(match[1])).filter(Boolean);
  const summary = stripHtml(matchFirst(text, /<summary[^>]*>(.*?)<\/summary>/i) || "");
  return { title, previews, summary };
}

function normalizedElementsFromComponent(component) {
  if (!component || typeof component !== "object") return [];
  const candidates = [];
  const data = component.data && typeof component.data === "object" ? component.data : {};
  candidates.push(data.data && typeof data.data === "object" ? data.data : data);
  candidates.push(component);
  const result = [];
  for (const candidate of candidates) {
    for (const element of expandMessageElements(candidate)) {
      result.push(normalizeMessageElement(element, component.kind || "component"));
    }
  }
  return result;
}

function normalizeMessageElement(value, fallbackKind = "") {
  const raw = unwrapMessageElement(value);
  const kind = inferElementKind(raw, fallbackKind);
  return { kind, raw, data: raw };
}

function unwrapMessageElement(value) {
  if (!value || typeof value !== "object") return value;
  let current = value;
  for (let guard = 0; guard < 5; guard += 1) {
    if (!current || typeof current !== "object") return current;
    if (current.raw && typeof current.raw === "object") {
      current = current.raw;
      continue;
    }
    if (current.data && typeof current.data === "object" && !hasKnownMessageShape(current)) {
      current = current.data;
      continue;
    }
    if (current.message && typeof current.message === "object" && !Array.isArray(current.message) && !hasKnownMessageShape(current)) {
      current = current.message;
      continue;
    }
    if (current.element && typeof current.element === "object" && !hasKnownMessageShape(current)) {
      current = current.element;
      continue;
    }
    return current;
  }
  return current;
}

function hasKnownMessageShape(value) {
  if (!value || typeof value !== "object") return false;
  return Boolean(
    value.textElement ||
    value.picElement ||
    value.imageElement ||
    value.faceElement ||
    value.marketFaceElement ||
    value.fileElement ||
    value.pttElement ||
    value.voiceElement ||
    value.recordElement ||
    value.audioElement ||
    value.videoElement ||
    value.grayTipElement ||
    value.replyElement ||
    value.arkElement ||
    value.multiForwardMsgElement ||
    value.elementType !== undefined ||
    value.type !== undefined ||
    value.kind !== undefined,
  );
}

function expandMessageElements(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap((item) => expandMessageElements(item));
  if (typeof value !== "object") return [];
  const raw = unwrapMessageElement(value);
  if (!raw || typeof raw !== "object") return [];
  const arrays = [
    raw.elements,
    raw.msgElements,
    raw.message,
    raw.messageChain,
    raw.message_chain,
    raw.segments,
    raw.payload?.elements,
    raw.data?.elements,
    raw.data?.message,
    raw.message_obj?.message,
  ].filter(Array.isArray);
  if (arrays.length) return arrays.flatMap((items) => items.flatMap((item) => expandMessageElements(item)));
  return [raw];
}

function dedupeNormalizedElements(elements) {
  const result = [];
  const seen = new Set();
  for (const element of elements) {
    const raw = unwrapMessageElement(element.raw || element);
    if (!raw || typeof raw !== "object") continue;
    const signature = JSON.stringify({
      kind: inferElementKind(raw, element.kind),
      id: raw.elementId || raw.msgId || raw.fileUuid || raw.fileName || "",
      text: raw.text || raw.content || raw.textElement?.content || "",
      image: raw.picElement?.originImageUrl || raw.imageElement?.url || raw.originImageUrl || raw.url || "",
    });
    if (seen.has(signature)) continue;
    seen.add(signature);
    result.push({ kind: inferElementKind(raw, element.kind), raw, data: raw });
  }
  return result;
}

function inferElementKind(raw, fallbackKind = "") {
  if (!raw || typeof raw !== "object") return String(fallbackKind || "").toLowerCase();
  const rawKind = String(raw.kind || raw.segment_type || raw.typeName || raw.type || "").toLowerCase();
  const fallback = String(fallbackKind || "").toLowerCase();
  const kind = rawKind || (["raw", "component", "data", "message", "segment"].includes(fallback) ? "" : fallback);
  const typeHint = Number(raw.type);
  const elementTypeHint = Number(raw.elementType);
  if (raw.picElement || raw.imageElement || typeHint === 2 || elementTypeHint === 2 || kind.includes("image") || kind.includes("pic")) return "image";
  if (raw.videoElement || elementTypeHint === 5 || kind.includes("video")) return "video";
  if (raw.pttElement || raw.voiceElement || raw.recordElement || raw.audioElement || elementTypeHint === 4 || kind.includes("record") || kind.includes("audio") || kind.includes("ptt") || kind.includes("voice")) return "audio";
  if (raw.fileElement || typeHint === 6 || elementTypeHint === 3 || kind.includes("file")) return "file";
  if (raw.faceElement || raw.marketFaceElement || typeHint === 3 || elementTypeHint === 6 || kind.includes("face") || kind.includes("emoji")) return "face";
  if (raw.multiForwardMsgElement || elementTypeHint === 16) return "forward";
  if (raw.arkElement || elementTypeHint === 10) return "ark";
  if (raw.atElement || raw.mentionElement || kind === "at" || kind.includes("mention")) return "mention";
  if (raw.textElement || raw.text || raw.content || raw.data?.text || kind === "plain" || kind === "text") return "text";
  return kind || fallback;
}

function allDisplayableMediaItems() {
  return state.messages
    .flatMap((msg) => mediaForGrid(msg))
    .filter((item) => mediaDisplayUrl(item));
}

function inlineMediaItemsFromMessage(item) {
  return messageElementObjects(item)
    .map((element, index) => mediaItemFromElement(element.raw || element, index))
    .filter(Boolean);
}

function mediaItemFromElement(raw, index = 0) {
  const element = unwrapMessageElement(raw);
  if (!element || typeof element !== "object") return null;
  if (element.picElement || element.imageElement || element.mfaceElement || element.marketFaceElement || element.market_face || inferElementKind(element) === "image") {
    const pic = element.picElement || element.imageElement || element.mfaceElement || element.marketFaceElement || element.market_face || element;
    const source = normalizeQpicSource(firstMediaSource(pic, mediaSourceKeys("image")));
    if (!source && !(pic.emojiId || pic.emoji_id)) return null;
    const derivedSource = source || marketFaceSource(pic);
    return {
      id: `inline-image-${index}-${derivedSource}`,
      kind: "image",
      name: pic.fileName || pic.file || pic.name || pic.faceName || pic.face_name || pic.summary || "图片",
      source: derivedSource,
      width: pic.picWidth || pic.width || pic.originWidth || pic.thumbWidth,
      height: pic.picHeight || pic.height || pic.originHeight || pic.thumbHeight,
    };
  }
  if (element.videoElement || inferElementKind(element) === "video") {
    const video = element.videoElement || element;
    const source = normalizeQpicSource(firstMediaSource(video, mediaSourceKeys("video")) || firstMediaSource(video, ["thumbPath", "thumbUrl", "coverUrl"]));
    if (!source && !video.fileName && !video.name) return null;
    return {
      id: `inline-video-${index}-${source || video.fileName || video.name}`,
      kind: "video",
      name: video.fileName || video.name || "视频",
      source,
      width: video.thumbWidth || video.width,
      height: video.thumbHeight || video.height,
    };
  }
  if (element.pttElement || element.voiceElement || element.recordElement || element.audioElement || inferElementKind(element) === "audio") {
    const audio = element.pttElement || element.voiceElement || element.recordElement || element.audioElement || element;
    const source = normalizeQpicSource(firstMediaSource(audio, mediaSourceKeys("audio")));
    if (!source && !audio.fileUuid && !audio.fileName && !audio.text) return null;
    return {
      id: `inline-audio-${index}-${source || audio.fileUuid || audio.fileName || audio.text}`,
      kind: "audio",
      name: audio.fileName || audio.name || "语音",
      source,
      size: audio.fileSize || audio.size,
    };
  }
  return null;
}

function matchFirst(value, pattern) {
  return String(value || "").match(pattern)?.[1] || "";
}

function firstMapValue(value) {
  if (!value) return "";
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstMapValue(item);
      if (found) return found;
    }
    return "";
  }
  if (typeof value === "object") {
    const directKeys = [
      "url",
      "src",
      "source",
      "path",
      "filePath",
      "file_path",
      "localPath",
      "originImageUrl",
      "picUrl",
      "thumbUrl",
      "previewUrl",
      "fileUrl",
      "downloadUrl",
      "imageUrl",
      "videoUrl",
      "audioUrl",
      "recordUrl",
      "pttUrl",
    ];
    for (const key of directKeys) {
      const found = firstMapValue(value[key]);
      if (found) return found;
    }
  }
  return "";
}

function formatDuration(seconds) {
  const value = Math.max(0, Number(seconds || 0));
  if (!value) return '0"';
  const minutes = Math.floor(value / 60);
  const rest = Math.floor(value % 60);
  return minutes ? `${minutes}:${String(rest).padStart(2, "0")}` : `${rest}"`;
}

function mediaSourceDisplayUrl(item) {
  const source = normalizeQpicSource(firstMediaSource(item, ["inline_url", "source", "url", "relative_path", "relativePath", "localPath", "filePath", "path"]));
  if (!source) return "";
  if (/^(data:|blob:)/i.test(source)) return source;
  if (source.startsWith("media/")) return pluginApiUrl(`file-proxy?path=${encodeURIComponent(source)}`);
  if (/^https?:\/\//i.test(source) && normalizeMediaKind(item.kind) === "image") return pluginApiUrl(`image-proxy?url=${encodeURIComponent(source)}`);
  if (/^https?:\/\//i.test(source) && ["video", "audio", "file"].includes(normalizeMediaKind(item.kind))) {
    return pluginApiUrl(`media-proxy?kind=${encodeURIComponent(normalizeMediaKind(item.kind))}&url=${encodeURIComponent(source)}`);
  }
  if (/^file:\/\//i.test(source) || /^[a-z]:[\\/]/i.test(source) || source.startsWith("/")) return pluginApiUrl(`file-proxy?path=${encodeURIComponent(source)}`);
  return "";
}

function isBrowserPlayableAudio(item) {
  const mime = String(item?.mime || item?.content_type || item?.contentType || "").split(";", 1)[0].trim().toLowerCase();
  const source = String(firstMediaSource(item, ["source", "url", "relative_path", "relativePath", "localPath", "filePath", "path", "name"]) || "");
  const ext = source.split(/[?#]/, 1)[0].toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || "";
  if (mime) {
    if (["audio/silk", "audio/amr", "audio/x-amr"].includes(mime)) return false;
    if (mime.startsWith("audio/")) return true;
  }
  if (["silk", "amr"].includes(ext)) return false;
  if (["mp3", "m4a", "aac", "ogg", "oga", "opus", "wav", "weba", "flac"].includes(ext)) return true;
  return false;
}

function mediaSourceKeys(kind) {
  const normalized = normalizeMediaKind(kind);
  const tail = ["source", "path", "filePath", "file_path", "localPath", "file", "file_id", "fileId", "file_", "md5HexStr", "md5"];
  if (normalized === "image") {
    return ["originImageUrl", "origin_image_url", "picUrl", "pic_url", "thumbUrl", "thumb_url", "previewUrl", "preview_url", "url", "fileUrl", "file_url", "imageUrl", "image_url", "faceUrl", "face_url", "emojiWebUrl", "emojiUrl", "emoji_url", "sourcePath", "source_path", "thumbPath", "thumb_path", ...tail];
  }
  if (normalized === "video") {
    return ["videoUrl", "video_url", "url", "fileUrl", "file_url", "thumbPath", "thumb_path", "thumbUrl", "thumb_url", "previewUrl", "preview_url", "coverUrl", "cover_url", ...tail];
  }
  if (normalized === "audio") {
    return ["audioUrl", "audio_url", "recordUrl", "record_url", "pttUrl", "ptt_url", "url", "fileUrl", "file_url", ...tail];
  }
  return ["url", "fileUrl", "file_url", "downloadUrl", "download_url", ...tail];
}

function applyMediaPreviewSize(node, item) {
  const size = previewSize(item?.width || item?.picWidth, item?.height || item?.picHeight, 320, 340, 160, 96);
  node.style.width = `${size.width}px`;
  node.style.height = `${size.height}px`;
}

function previewSize(width, height, maxWidth, maxHeight, fallbackWidth, fallbackHeight) {
  let displayWidth = Number(width || 0);
  let displayHeight = Number(height || 0);
  if (!displayWidth || !displayHeight) {
    displayWidth = fallbackWidth;
    displayHeight = fallbackHeight;
  }
  const scale = Math.min(maxWidth / displayWidth, maxHeight / displayHeight, 1);
  displayWidth = Math.max(64, Math.round(displayWidth * scale));
  displayHeight = Math.max(48, Math.round(displayHeight * scale));
  return { width: displayWidth, height: displayHeight };
}

function normalizeQpicSource(source) {
  const value = String(source || "").trim();
  if (!value) return "";
  if (value.startsWith("//")) return `https:${value}`;
  if (/^http:\/\/([a-z0-9.-]+\.)?(qpic\.cn|qq\.com)\//i.test(value)) return `https://${value.slice("http://".length)}`;
  if (value.startsWith("/") && !value.startsWith("//")) return `https://gchat.qpic.cn${value}`;
  return value;
}

function marketFaceSource(face) {
  const emojiId = String(face?.emojiId || face?.emoji_id || face?.id || "").trim();
  if (!emojiId) return "";
  const sizes = Array.isArray(face?.supportSize) ? face.supportSize : [];
  const size = sizes[0] || {};
  const width = Math.min(Number(size.width || 120), 300);
  return `https://gxh.vip.qq.com/club/item/parcel/item/${emojiId.slice(0, 2)}/${emojiId}/raw${width}.gif`;
}

function firstMediaSource(value, keys = []) {
  if (!value) return "";
  if (typeof value === "string") return firstMapValue(value);
  if (Array.isArray(value)) return firstMapValue(value);
  if (typeof value !== "object") return "";
  for (const key of keys) {
    const found = firstMapValue(value[key]);
    if (found) return found;
  }
  for (const key of keys) {
    const lowerKey = String(key).toLowerCase();
    const matchedKey = Object.keys(value).find((candidate) => candidate.toLowerCase() === lowerKey);
    if (matchedKey && matchedKey !== key) {
      const found = firstMapValue(value[matchedKey]);
      if (found) return found;
    }
  }
  const nested = [
    value.data,
    value.meta,
    value.media,
    value.extra,
    value.picElement,
    value.imageElement,
    value.videoElement,
    value.pttElement,
    value.voiceElement,
    value.recordElement,
    value.audioElement,
    value.fileElement,
    value.marketFaceElement,
    value.mfaceElement,
    value.market_face,
  ];
  for (const item of nested) {
    if (item && typeof item === "object" && item !== value) {
      const found = firstMediaSource(item, keys);
      if (found) return found;
    }
  }
  const looseKey = Object.keys(value).find((key) => /(url|path|file|source|thumb|preview|cover|origin|md5)/i.test(key));
  if (looseKey) {
    const found = firstMapValue(value[looseKey]);
    if (found) return found;
  }
  return "";
}

function textFromRawElements(raw) {
  return rawElements(raw).map((element) => rawElementText(unwrapMessageElement(element))).filter(Boolean).join("");
}

function rawElementText(element) {
  if (!element || typeof element !== "object") return "";
  if (element.textElement?.content) return String(element.textElement.content);
  if (element.textElement?.text) return String(element.textElement.text);
  if (element.data?.text) return String(element.data.text);
  if (element.text) return String(element.text);
  if (element.picElement || element.imageElement) return (element.picElement || element.imageElement).summary || "[图片]";
  if (element.faceElement) return element.faceElement.faceText || `[表情${element.faceElement.faceIndex || ""}]`;
  if (element.marketFaceElement) return `[${element.marketFaceElement.faceName || "表情包"}]`;
  if (element.fileElement?.fileName) return `[文件: ${element.fileElement.fileName}]`;
  if (element.pttElement || element.voiceElement) return (element.pttElement || element.voiceElement).text || "[语音]";
  if (element.videoElement) return "[视频]";
  if (element.multiForwardMsgElement) return parseForwardXml(element.multiForwardMsgElement.xmlContent).title || "[聊天记录]";
  if (element.arkElement) return "[卡片消息]";
  const typeHint = Number(element.type);
  const elementTypeHint = Number(element.elementType);
  const kind = inferElementKind(element);
  if (kind === "image" || typeHint === 2 || elementTypeHint === 2) return "[图片]";
  if (kind === "face" || typeHint === 3 || elementTypeHint === 6) return "[表情]";
  if (kind === "file" || typeHint === 6 || elementTypeHint === 3) return "[文件]";
  if (kind === "audio" || elementTypeHint === 4) return "[语音]";
  if (kind === "video" || elementTypeHint === 5) return "[视频]";
  if (elementTypeHint === 16) return "[聊天记录]";
  if (elementTypeHint === 10) return "[卡片消息]";
  return "";
}

function rawElements(raw) {
  return expandMessageElements(raw);
}

function systemTipText(item) {
  const elements = [...rawElements(item?.raw), ...componentRawObjects(item?.components)].map(unwrapMessageElement);
  const tips = elements.map((element) => grayTipText(element?.grayTipElement || element)).filter(Boolean);
  if (!tips.length) return "";
  const hasNonTip = elements.some((element) => !element?.grayTipElement && !element?.replyElement && !grayTipText(element));
  return hasNonTip ? "" : tips.join(" ");
}

function grayTipText(grayTip) {
  if (!grayTip || typeof grayTip !== "object") return "";
  const jsonStr = grayTip.jsonGrayTipElement?.jsonStr || grayTip.jsonStr;
  if (jsonStr) {
    try {
      const parsed = JSON.parse(jsonStr);
      const text = Array.isArray(parsed.items) ? parsed.items.map(grayTipItemText).join("") : "";
      if (text) return stripHtml(text);
    } catch {
      return "";
    }
  }
  const xml = grayTip.xmlElement?.content || grayTip.content || grayTip.text || grayTip.recentAbstract;
  if (xml) return stripHtml(String(xml));
  return "";
}

function grayTipItemText(item) {
  if (!item || typeof item !== "object") return "";
  if (item.txt || item.text || item.content) return String(item.txt || item.text || item.content);
  if (item.name || item.nick || item.nickname) return String(item.name || item.nick || item.nickname);
  if (item.uid || item.uin) return String(item.uid || item.uin);
  return "";
}

function stripHtml(value) {
  return String(value || "").replace(/<[^>]+>/g, "").trim();
}

function componentRawObjects(components) {
  if (!Array.isArray(components)) return [];
  return components.flatMap((component) => normalizedElementsFromComponent(component).map((element) => element.raw)).filter((item) => item && typeof item === "object");
}

function isRecalledMessage(item) {
  const raw = item?.raw || {};
  if (raw.recallTime && String(raw.recallTime) !== "0") return true;
  if (raw.msgStatus === "recalled" || raw.status === "recalled") return true;
  return [...rawElements(raw), ...componentRawObjects(item?.components)].some((element) => Boolean(element?.grayTipElement?.revokeElement || element?.revokeElement));
}

function replyInfo(item) {
  const all = [...rawElements(item?.raw), ...componentRawObjects(item?.components)].map(unwrapMessageElement);
  const reply = all.find((element) => element?.replyElement)?.replyElement || item?.raw?.replyElement;
  if (!reply || typeof reply !== "object") return null;
  return {
    msgId: reply.replayMsgId || reply.replyMsgId || reply.msgId || "",
    msgSeq: reply.replayMsgSeq || reply.replyMsgSeq || reply.msgSeq || "",
    sender: reply.senderNick || reply.senderName || reply.sourceMsgSender || "",
    text: reply.sourceMsgText || reply.text || reply.summary || "[消息]",
  };
}

function replyTargetMessageKey(reply) {
  if (!reply) return "";
  const target = state.messages.find((message) => {
    const raw = message.raw || {};
    return (
      (reply.msgId && String(raw.msgId || raw.message_id || message.message_id || "") === String(reply.msgId)) ||
      (reply.msgSeq && String(raw.msgSeq || raw.message_seq || "") === String(reply.msgSeq))
    );
  });
  return target ? `msg-${messageKey(target)}` : "";
}

function renderReplyPreviewHtml(reply, targetKey) {
  const attrs = targetKey ? ` data-reply-key="${escapeAttr(targetKey)}" title="跳转到引用消息"` : "";
  const sender = reply.sender ? `<strong>${escapeHtml(reply.sender)}</strong>` : "<strong>回复</strong>";
  return `<button class="reply-preview" type="button"${attrs}>${sender}<span>${highlightText(reply.text || "[消息]", state.q)}</span></button>`;
}

function reactionList(item) {
  const raw = item?.raw || {};
  const values = [
    ...(Array.isArray(raw.emojiLikesList) ? raw.emojiLikesList : []),
    ...(Array.isArray(raw.reactions) ? raw.reactions : []),
    ...(Array.isArray(raw.emoji_reactions) ? raw.emoji_reactions : []),
    ...(Array.isArray(item?.reactions) ? item.reactions : []),
  ];
  return values
    .map((reaction) => ({
      id: String(reaction.emojiId || reaction.id || reaction.emoji || ""),
      type: String(reaction.emojiType || reaction.type || ""),
      count: Number(reaction.likesCnt || reaction.count || reaction.total || 0),
      clicked: Boolean(reaction.isClicked || reaction.self),
    }))
    .filter((reaction) => reaction.id || reaction.count);
}

function renderReactionRowHtml(reactions) {
  return `<div class="reaction-row">${reactions.map(renderReactionChipHtml).join("")}</div>`;
}

function renderReactionChipHtml(reaction) {
  const label = reactionLabel(reaction);
  const count = reaction.count ? fmtNumber(reaction.count) : "";
  const imageUrl = reactionImageUrl(reaction);
  return `<span class="reaction-chip ${reaction.clicked ? "active" : ""}" title="表情回应">${
    imageUrl
      ? `<img loading="lazy" src="${escapeAttr(imageUrl)}" alt="${escapeAttr(label)}" /><em>${escapeHtml(label)}</em>`
      : escapeHtml(label)
  }${count ? `<b>${escapeHtml(count)}</b>` : ""}</span>`;
}

function reactionLabel(reaction) {
  if (reaction.type === "2" && /^\d+$/.test(reaction.id)) {
    try {
      return String.fromCodePoint(Number(reaction.id));
    } catch {
      return "表情";
    }
  }
  return reaction.id ? `[${reaction.id}]` : "表情";
}

function reactionImageUrl(reaction) {
  if (!reaction?.id || !/^\d+$/.test(String(reaction.id))) return "";
  if (String(reaction.type) === "2") {
    try {
      const hex = Number(reaction.id).toString(16);
      return pluginApiUrl(`image-proxy?url=${encodeURIComponent(`https://gxh.vip.qq.com/club/item/parcel/item/emoji/${hex}/100x100.png`)}`);
    } catch {
      return "";
    }
  }
  const rawUrl = `https://gxh.vip.qq.com/club/item/parcel/item/${String(reaction.id).slice(0, 2)}/${reaction.id}/100x100.png`;
  return pluginApiUrl(`image-proxy?url=${encodeURIComponent(rawUrl)}`);
}

function messageGroup(item, previous, next) {
  return {
    first: !canGroup(item, previous),
    last: !canGroup(item, next),
    showName: !canGroup(item, previous),
    showAvatar: !canGroup(item, next),
  };
}

function canGroup(a, b) {
  if (!a || !b) return false;
  if (!sameDay(a.created_at, b.created_at)) return false;
  if (String(a.sender_id || a.sender_name || "") !== String(b.sender_id || b.sender_name || "")) return false;
  return Math.abs(Number(a.created_at || 0) - Number(b.created_at || 0)) <= 300;
}

function sameDay(a, b) {
  const da = new Date(Number(a || 0) * 1000);
  const db = new Date(Number(b || 0) * 1000);
  return da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth() && da.getDate() === db.getDate();
}

function messageKey(item) {
  return String(item.message_uid || item.id || `${item.created_at}-${item.sender_id}-${item.message_id}`);
}

function isSelf(item) {
  return Boolean(item.self_id && String(item.sender_id || "") === String(item.self_id || ""));
}

function senderDisplayName(item) {
  const raw = item?.raw || {};
  return item?.sender_name || raw.sendMemberName || raw.sendNickName || raw.senderNick || item?.sender_id || raw.senderUin || "未知用户";
}

function renderSenderHtml(item, sender) {
  const badges = senderBadges(item).map((badge) => `<span class="sender-badge ${escapeAttr(badge.tone)}">${escapeHtml(badge.label)}</span>`).join("");
  return `<div class="sender"><span>${escapeHtml(sender)}</span>${badges}</div>`;
}

function profileFromMessage(item) {
  const raw = item?.raw || {};
  const sender = senderDisplayName(item);
  const uin = String(raw.senderUin || raw.sender_uin || raw.uin || raw.qq || raw.user_id || "").trim();
  const uid = String(raw.senderUid || raw.sender_uid || raw.uid || item?.sender_id || "").trim();
  const honor = groupHonor(raw);
  const role = memberRoleLabel(raw.memberRole || raw.role || raw.groupRole);
  const avatarUrl = qqAvatarUrl(item);
  return {
    name: sender,
    remark: raw.remark || raw.friendRemark || raw.cardName || "",
    uid,
    uin,
    primaryId: uin || uid || item?.sender_id || sender,
    role,
    level: honor.level ? `Lv.${honor.level}` : raw.memberLevel ? `Lv.${raw.memberLevel}` : "",
    title: honor.uniqueTitle || raw.memberTitle || raw.specialTitle || raw.groupTitle || "",
    avatarUrl,
  };
}

function groupHonor(raw) {
  const attrs = raw?.msgAttrs || raw?.msg_attrs || {};
  return attrs?.["2"]?.groupHonor || attrs?.[2]?.groupHonor || raw?.groupHonor || {};
}

function memberRoleLabel(value) {
  const role = String(value || "").toLowerCase();
  if (role === "owner" || role === "4") return "群主";
  if (role === "admin" || role === "administrator" || role === "3") return "管理员";
  if (role === "member" || role === "2") return "成员";
  return "";
}

function renderAvatarHtml(item, sender, self, group) {
  if (self || !group.showAvatar) return `<div class="avatar-spacer"></div>`;
  const avatarUrl = qqAvatarUrl(item);
  if (avatarUrl) {
    return `<button class="avatar image-avatar" type="button" data-profile aria-label="查看 ${escapeAttr(sender)} 的资料" style="--avatar-bg:${avatarColor(sender)}"><img loading="lazy" src="${escapeAttr(avatarUrl)}" alt="${escapeAttr(sender)}" /><span>${escapeHtml(initials(sender))}</span></button>`;
  }
  return `<button class="avatar" type="button" data-profile aria-label="查看 ${escapeAttr(sender)} 的资料" style="--avatar-bg:${avatarColor(sender)}">${escapeHtml(initials(sender))}</button>`;
}

function qqAvatarUrl(item) {
  const raw = item?.raw || {};
  const uin = String(raw.senderUin || raw.sender_uin || raw.senderUIN || raw.uin || raw.senderUinStr || raw.senderUinString || "").trim();
  if (!uin || !/^\d{5,}$/.test(uin)) return "";
  const rawUrl = `https://q1.qlogo.cn/g?b=qq&nk=${encodeURIComponent(uin)}&s=100`;
  return pluginApiUrl(`image-proxy?url=${encodeURIComponent(rawUrl)}`);
}

function conversationAvatarUrl(item) {
  if (!item?.umo) return "";
  const value = String(item.umo || "");
  const groupMatch = value.match(/(?:group|guild|channel)[!:/:|]+(\d{5,})/i);
  if (!groupMatch) return "";
  const groupCode = groupMatch[1];
  const rawUrl = `https://p.qlogo.cn/gh/${encodeURIComponent(groupCode)}/${encodeURIComponent(groupCode)}/100/`;
  return pluginApiUrl(`image-proxy?url=${encodeURIComponent(rawUrl)}`);
}

function qqGroupAvatarUrl(item) {
  const raw = item?.raw || {};
  const groupCode = String(raw.peerUin || raw.groupCode || raw.group_code || raw.group_id || item?.group_id || "").trim();
  if (!groupCode || !/^\d{5,}$/.test(groupCode)) return "";
  const rawUrl = `https://p.qlogo.cn/gh/${encodeURIComponent(groupCode)}/${encodeURIComponent(groupCode)}/100/`;
  return pluginApiUrl(`image-proxy?url=${encodeURIComponent(rawUrl)}`);
}

function senderBadges(item) {
  const raw = item?.raw || {};
  const badges = [];
  const honor = groupHonor(raw);
  if (honor.level) badges.push({ label: `Lv.${honor.level}`, tone: "level" });
  const title = honor.uniqueTitle || raw.memberTitle || raw.specialTitle;
  if (title) badges.push({ label: title, tone: "title" });
  const role = memberRoleLabel(raw.memberRole || raw.role || raw.groupRole);
  if (role === "群主") badges.push({ label: role, tone: "owner" });
  if (role === "管理员") badges.push({ label: role, tone: "admin" });
  return badges.slice(0, 3);
}

function initials(value) {
  const text = String(value || "?").trim();
  if (!text) return "?";
  const chars = Array.from(text.replace(/^webchat[:!]/, ""));
  return chars.slice(0, 2).join("").toUpperCase();
}

function avatarColor(value) {
  const colors = ["#3390ec", "#45a886", "#d17a22", "#8e6bd8", "#d65064", "#5271c4"];
  let hash = 0;
  for (const char of String(value || "")) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return colors[hash % colors.length];
}

function fileIcon(kind) {
  const normalized = normalizeMediaKind(kind);
  if (normalized === "image") return "图";
  if (normalized === "video") return "影";
  if (normalized === "audio") return "音";
  return "文";
}

function messageTypeLabel(value) {
  if (value === "private") return "私聊";
  if (value === "group") return "群聊";
  return value || "未知";
}

function normalizeMediaKind(kind) {
  const value = String(kind || "file").toLowerCase();
  if (value === "record" || value === "audio" || value === "voice") return "audio";
  if (value === "image" || value === "img") return "image";
  if (value === "video") return "video";
  return "file";
}

function mediaKindLabel(kind) {
  const normalized = normalizeMediaKind(kind);
  if (normalized === "image") return "图片";
  if (normalized === "video") return "视频";
  if (normalized === "audio") return "音频";
  return "文件";
}

function highlightText(value, query) {
  const q = String(query || "").trim();
  if (!q) return escapeHtml(value);
  const raw = String(value ?? "");
  const needle = q.toLocaleLowerCase();
  let index = 0;
  let html = "";
  while (index < raw.length) {
    const found = raw.toLocaleLowerCase().indexOf(needle, index);
    if (found < 0) {
      html += escapeHtml(raw.slice(index));
      break;
    }
    html += escapeHtml(raw.slice(index, found));
    html += `<mark>${escapeHtml(raw.slice(found, found + q.length))}</mark>`;
    index = found + q.length;
  }
  return html;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char];
  });
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, "&#096;");
}

async function copyText(value) {
  const text = String(value || "");
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
  } else {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
  toast("已复制");
}

async function pollForUpdates() {
  if (state.latestPollInFlight) return;
  state.latestPollInFlight = true;
  try {
    const previous = state.lastKnownCount;
    await loadStats();
    if (state.lastKnownCount > previous) {
      await loadConversations();
      if (isNearBottom() && state.settings.auto_scroll !== false) {
        await loadMessages({ stickToBottom: true });
        await markCurrentConversationSeen();
      }
    }
  } finally {
    state.latestPollInFlight = false;
  }
}

function schedulePolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  const seconds = Number(state.settings.poll_interval_seconds || 15);
  state.pollTimer = setInterval(() => {
    pollForUpdates().catch(() => {});
  }, Math.max(5, seconds) * 1000);
}

async function markCurrentConversationSeen() {
  if (!state.currentUmo) return;
  const last = state.messages[state.messages.length - 1];
  await apiPost("/seen", {
    umo: state.currentUmo,
    message_uid: last ? messageKey(last) : "",
    seen_at: last?.created_at || Math.floor(Date.now() / 1000),
  });
  state.conversations = state.conversations.map((item) => (item.umo === state.currentUmo ? { ...item, unread_count: 0 } : item));
  renderConversations();
}

function syncFilterForm() {
  if (els.senderFilter) els.senderFilter.value = state.filters.sender || "";
  if (els.typeFilter) els.typeFilter.value = state.filters.messageType || "";
  if (els.mediaFilter) els.mediaFilter.value = state.filters.mediaKind || "";
  if (els.startFilter) els.startFilter.value = tsToDatetimeLocal(state.filters.startTs);
  if (els.endFilter) els.endFilter.value = tsToDatetimeLocal(state.filters.endTs);
}

function syncSettingsForm() {
  if (els.themeSelect) els.themeSelect.value = state.settings.theme || "system";
  if (els.pollIntervalInput) els.pollIntervalInput.value = String(state.settings.poll_interval_seconds || 15);
  if (els.autoScrollToggle) els.autoScrollToggle.checked = state.settings.auto_scroll !== false;
  if (els.compactModeToggle) els.compactModeToggle.checked = Boolean(state.settings.compact_mode);
  if (els.showStatusToggle) els.showStatusToggle.checked = state.settings.show_status_strip !== false;
}

function applySettingsToDocument() {
  document.documentElement.dataset.theme = state.settings.theme || "system";
  document.body.classList.toggle("compact-mode", Boolean(state.settings.compact_mode));
  document.body.classList.toggle("hide-status", state.settings.show_status_strip === false);
}

async function saveSettings() {
  const settings = await apiPost("/settings", {
    theme: els.themeSelect?.value || "system",
    poll_interval_seconds: Number(els.pollIntervalInput?.value || 15),
    auto_scroll: Boolean(els.autoScrollToggle?.checked),
    compact_mode: Boolean(els.compactModeToggle?.checked),
    show_status_strip: Boolean(els.showStatusToggle?.checked),
  });
  state.settings = { ...state.settings, ...(settings || {}) };
  applySettingsToDocument();
  syncSettingsForm();
  schedulePolling();
  toast("设置已保存");
}

function tsToDatetimeLocal(value) {
  if (!value) return "";
  const date = new Date(Number(value) * 1000);
  if (!Number.isFinite(date.getTime())) return "";
  const pad = (num) => String(num).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function bindEvents() {
  els.refreshBtn.addEventListener("click", () => init({ keepConversation: true }));
  els.loadMoreBtn.addEventListener("click", () => loadMessages({ append: true }));
  els.jumpLatestBtn.addEventListener("click", async () => {
    els.jumpLatestBtn.hidden = true;
    els.jumpLatestBtn.textContent = "跳到最新";
    await loadMessages({ stickToBottom: true });
  });
  els.closeDetailBtn.addEventListener("click", () => {
    els.detailPane.hidden = true;
  });
  els.exportBtn.addEventListener("click", async () => {
    const format = els.exportFormat?.value || "json";
    const data = await apiPost("/export", {
      format,
      umo: state.currentUmo,
      q: state.q,
      sender: state.filters.sender,
      message_type: state.filters.messageType,
      media_kind: state.filters.mediaKind,
      start_ts: state.filters.startTs || "",
      end_ts: state.filters.endTs || "",
      include_media: Boolean(els.includeMediaExport?.checked || format === "zip"),
    });
    toast(`已导出：${data.path}`);
  });
  els.settingsBtn?.addEventListener("click", async () => {
    await loadSearchHistory();
    syncSettingsForm();
    if (els.settingsDialog?.showModal) {
      els.settingsDialog.showModal();
    } else {
      els.settingsDialog.setAttribute("open", "");
    }
  });
  els.saveSettingsBtn?.addEventListener("click", () => saveSettings().catch((error) => toast(error.message || "保存失败")));
  els.clearHistoryBtn?.addEventListener("click", async () => {
    await apiPost("/search-history", { action: "clear" });
    await loadSearchHistory();
    toast("搜索历史已清空");
  });
  els.createTagBtn?.addEventListener("click", () => createTagFromDialog().catch((error) => toast(error.message || "创建失败")));
  els.prevSearchBtn.addEventListener("click", () => jumpSearch(-1));
  els.nextSearchBtn.addEventListener("click", () => jumpSearch(1));
  els.sessionToggleBtn?.addEventListener("click", () => {
    document.body.classList.toggle("sessions-open");
  });
  els.inspectorPane?.querySelectorAll("[data-inspector-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      state.inspectorTab = button.dataset.inspectorTab || "summary";
      renderInspector();
    });
  });
  els.closeForwardBtn?.addEventListener("click", closeForwardViewer);
  els.forwardViewer?.addEventListener("click", (event) => {
    if (event.target === els.forwardViewer) closeForwardViewer();
  });
  els.closeViewerBtn.addEventListener("click", closeMediaViewer);
  els.downloadViewerBtn.addEventListener("click", () => {
    const item = state.mediaItems[state.mediaIndex];
    if (item) downloadMedia(item).catch((error) => toast(error.message || "下载失败"));
  });
  els.prevMediaBtn.addEventListener("click", () => {
    state.mediaIndex = Math.max(0, state.mediaIndex - 1);
    renderMediaViewer();
  });
  els.nextMediaBtn.addEventListener("click", () => {
    state.mediaIndex = Math.min(state.mediaItems.length - 1, state.mediaIndex + 1);
    renderMediaViewer();
  });
  document.addEventListener("click", (event) => {
    if (!els.contextMenu.contains(event.target)) hideContextMenu();
    if (
      els.profilePopover &&
      !els.profilePopover.contains(event.target) &&
      !els.contextMenu.contains(event.target) &&
      !event.target?.closest?.("[data-profile]")
    ) {
      hideProfilePopover();
    }
  });
  document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
      event.preventDefault();
      els.searchInput.focus();
      els.searchInput.select();
    }
    if (event.key === "Escape") {
      hideContextMenu();
      hideProfilePopover();
      closeForwardViewer();
      closeMediaViewer();
      els.detailPane.hidden = true;
    }
    if (!els.mediaViewer.hidden && event.key === "ArrowLeft") {
      state.mediaIndex = Math.max(0, state.mediaIndex - 1);
      renderMediaViewer();
    }
    if (!els.mediaViewer.hidden && event.key === "ArrowRight") {
      state.mediaIndex = Math.min(state.mediaItems.length - 1, state.mediaIndex + 1);
      renderMediaViewer();
    }
    if (event.key === "Enter" && document.activeElement === els.searchInput) {
      jumpSearch(event.shiftKey ? -1 : 1);
    }
  });
  let timer = null;
  let filterTimer = null;
  els.searchInput.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      state.q = els.searchInput.value.trim();
      await loadMessages({ stickToBottom: true });
    }, 180);
  });
  els.senderFilter?.addEventListener("input", () => {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(() => applyFilters(), 220);
  });
  els.typeFilter?.addEventListener("change", applyFilters);
  els.mediaFilter?.addEventListener("change", applyFilters);
  els.startFilter?.addEventListener("change", applyFilters);
  els.endFilter?.addEventListener("change", applyFilters);
  els.clearFiltersBtn?.addEventListener("click", async () => {
    els.senderFilter.value = "";
    els.typeFilter.value = "";
    els.mediaFilter.value = "";
    els.startFilter.value = "";
    els.endFilter.value = "";
    await applyFilters();
  });
}

async function applyFilters() {
  state.filters.sender = els.senderFilter?.value.trim() || "";
  state.filters.messageType = els.typeFilter?.value || "";
  state.filters.mediaKind = els.mediaFilter?.value || "";
  state.filters.startTs = datetimeLocalToTs(els.startFilter?.value || "");
  state.filters.endTs = datetimeLocalToTs(els.endFilter?.value || "");
  await loadMessages({ stickToBottom: true });
}

function datetimeLocalToTs(value) {
  if (!value) return null;
  const ts = new Date(value).getTime();
  if (!Number.isFinite(ts)) return null;
  return Math.floor(ts / 1000);
}

async function init({ keepConversation = false } = {}) {
  state.booting = true;
  state.error = "";
  try {
    if (!keepConversation) state.currentUmo = "";
    await loadSettings();
    await loadStats();
    await loadConversations();
    await loadFilters();
    await loadTags();
    await loadSearchHistory();
    syncFilterForm();
    await loadMessages({ stickToBottom: true });
    await markCurrentConversationSeen();
    if (!bridgeAvailable || !bridge?.apiGet) toast("演示模式");
  } catch (error) {
    state.error = error.message || "加载失败";
    renderTimeline();
    toast(state.error);
  } finally {
    state.booting = false;
  }
}

async function startApp() {
  bindEvents();
  if (bridgeAvailable && typeof bridge.ready === "function") {
    await bridge.ready();
  }
  await init();
}

startApp().catch((error) => {
  console.error(error);
  state.error = error.message || "加载失败";
  renderTimeline();
  toast(state.error);
});

async function demoApiGet(path, params = {}) {
  await new Promise((resolve) => setTimeout(resolve, 80));
  const clean = endpoint(path);
  if (clean === "stats") {
    return { messages: demoMessages.length, conversations: 3, media: 3, pending: 0, db_bytes: 81920, media_bytes: 2048 };
  }
  if (clean === "conversations") {
    return ["ops", "media", "archive"].map((name) => {
      const items = demoMessages.filter((item) => item.umo.endsWith(name));
      return {
        umo: `demo:${name}`,
        message_count: items.length,
        unread_count: name === "ops" ? 3 : 0,
        latest_at: Math.max(...items.map((item) => item.created_at)),
        sample_sender: items[0]?.sender_name || name,
      };
    });
  }
  if (clean === "filters") {
    return {
      senders: [
        { sender_id: "elaina", sender_name: "Elaina", count: 18 },
        { sender_id: "claude", sender_name: "Claude", count: 16 },
      ],
      message_types: [
        { value: "private", count: 42 },
        { value: "group", count: 22 },
      ],
      media_kinds: [
        { value: "image", count: 2 },
        { value: "video", count: 1 },
      ],
      tags: demoTags,
    };
  }
  if (clean === "tags") return demoTags;
  if (clean === "search-history") {
    return [
      { id: 1, query: "pending", hit_count: 8, filters: { umo: "demo:ops" }, updated_at: Math.floor(Date.now() / 1000) },
      { id: 2, query: "媒体", hit_count: 3, filters: { media_kind: "image" }, updated_at: Math.floor(Date.now() / 1000) - 300 },
    ];
  }
  if (clean === "settings") {
    return state.settings;
  }
  if (clean === "messages") {
    let items = params.umo ? demoMessages.filter((item) => item.umo === params.umo) : demoMessages;
    if (params.q) {
      const q = String(params.q).toLocaleLowerCase();
      items = items.filter((item) => `${messagePlainText(item)} ${systemTipText(item)} ${item.sender_name}`.toLocaleLowerCase().includes(q));
    }
    if (params.before) items = items.filter((item) => Number(item.created_at) < Number(params.before));
    if (params.sender) {
      const sender = String(params.sender).toLocaleLowerCase();
      items = items.filter((item) => `${item.sender_id} ${item.sender_name}`.toLocaleLowerCase().includes(sender));
    }
    if (params.message_type) items = items.filter((item) => item.message_type === params.message_type);
    if (params.media_kind) items = items.filter((item) => (item.media || []).some((media) => media.kind === params.media_kind));
    if (params.start_ts) items = items.filter((item) => Number(item.created_at) >= Number(params.start_ts));
    if (params.end_ts) items = items.filter((item) => Number(item.created_at) <= Number(params.end_ts));
    return { items: items.slice(-Number(params.limit || 100)), has_more: false };
  }
  return {};
}

async function demoApiPost(path, body = {}) {
  const clean = endpoint(path);
  if (clean === "favorite") return { message_uid: body.message_uid, favorite: body.favorite };
  if (clean === "tags") {
    const tag = { id: demoTags.length + 1, name: body.name || "新标签", color: body.color || "#3390ec", message_count: 0 };
    demoTags.push(tag);
    return tag;
  }
  if (clean === "message-tags") {
    const tag = demoTags.find((item) => Number(item.id) === Number(body.tag_id));
    return { message_uid: body.message_uid, tags: body.enabled && tag ? [tag] : [] };
  }
  if (clean === "settings") return body;
  if (clean === "search-history") return { recorded: true };
  if (clean === "seen") return { ok: true };
  return { path: "demo-export.json" };
}

function buildDemoMessages() {
  const now = Math.floor(Date.now() / 1000);
  const senders = ["Elaina", "Claude", "Ops", "MediaBot"];
  const texts = [
    "批量提交已接入 pending journal，强杀进程后可以回放未 flush 的消息。",
    "搜索内容包含百分号 % 和下划线 _，这里应该能正确高亮。",
    "这是一条连续消息，应该和上一条按发送者合并头像。",
    "媒体缩略图会内联显示，点击图片进入预览器。",
    "右键消息可以复制文本、打开媒体或查看 JSON。",
  ];
  return Array.from({ length: 64 }, (_, index) => {
      const sender = senders[index % senders.length];
      const hasMedia = index === 18 || index === 33;
      const demoImage =
        "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIzMjAiIGhlaWdodD0iMjAwIiB2aWV3Qm94PSIwIDAgMzIwIDIwMCI+PHJlY3Qgd2lkdGg9IjMyMCIgaGVpZ2h0PSIyMDAiIGZpbGw9IiMzMzkwZWMiLz48Y2lyY2xlIGN4PSIyNDgiIGN5PSI2MCIgcj0iMzQiIGZpbGw9IiNmZmYiIG9wYWNpdHk9Ii4zIi8+PHBhdGggZD0iTTAgMTUybDgwLTY0IDY0IDQ4IDQ4LTM2IDEyOCA5NnY0SDB6IiBmaWxsPSIjZmZmIiBvcGFjaXR5PSIuNzUiLz48dGV4dCB4PSIyNCIgeT0iMzYiIGZvbnQtZmFtaWx5PSJBcmlhbCIgZm9udC1zaXplPSIyMCIgZmlsbD0iI2ZmZiI+QXJjaGl2ZSBNZWRpYTwvdGV4dD48L3N2Zz4=";
      const message = {
        id: index + 1,
        message_uid: `demo-${index + 1}`,
        umo: `demo:${["ops", "media", "archive"][index % 3]}`,
      sender_id: sender.toLowerCase(),
      sender_name: sender,
      self_id: sender === "Claude" ? "claude" : "bot",
      text: `${texts[index % texts.length]} #${index + 1}`,
      created_at: now - (64 - index) * 76 - (index > 42 ? 86400 : 0),
      media: hasMedia
        ? [
            {
              id: index + 1,
              kind: "image",
              name: "preview.png",
              source: demoImage,
              width: 320,
              height: 200,
            },
          ]
        : [],
      favorite: index === 4,
      tags: index % 9 === 0 ? [demoTags[0]] : index % 13 === 0 ? [demoTags[1]] : [],
        raw: { demo: true, index },
        components: [],
      };
      if (index === 7) {
        message.text = "";
        message.raw = {
          demo: true,
          index,
          elements: [
            {
              grayTipElement: {
                jsonGrayTipElement: {
                  jsonStr: JSON.stringify({ items: [{ txt: "Elaina 邀请 Ops 加入归档测试群" }] }),
                },
              },
            },
          ],
        };
      }
      if (index === 12) {
        message.raw = {
          demo: true,
          index,
          msgId: `demo-${index + 1}`,
          senderUin: "100010001",
          msgAttrs: { 2: { groupHonor: { level: 7, uniqueTitle: "档案员" } } },
          elements: [{ textElement: { content: message.text } }],
          emojiLikesList: [
            { emojiId: "128077", emojiType: "2", likesCnt: "3", isClicked: true },
            { emojiId: "66", emojiType: "1", likesCnt: "2" },
          ],
        };
      }
      if (index === 21) {
        message.components = [
          {
            index: 0,
            kind: "reply",
            data: {
              replyElement: {
                replayMsgId: "demo-13",
                sourceMsgSender: "Elaina",
                sourceMsgText: "带有表情回应的消息",
              },
            },
          },
          { index: 1, kind: "plain", data: { text: "这里引用上一条归档消息，并附带 QQ 表情 " } },
          { index: 2, kind: "face", data: { faceIndex: 14, faceText: "[微笑]" } },
          { index: 3, kind: "mention", data: { name: "Ops" } },
        ];
      }
      if (index === 27) {
        message.raw = {
          demo: true,
          index,
          recallTime: String(now - 100),
          elements: [{ textElement: { content: message.text } }],
        };
      }
      if (index === 36) {
        message.text = "";
        message.raw = {
          demo: true,
          index,
          elements: [
            { pttElement: { duration: 12, text: "语音转文字归档示例" } },
            { fileElement: { fileName: "archive-report.zip", fileSize: 246810 } },
          ],
        };
      }
      if (index === 39) {
        message.text = "";
        message.raw = {
          demo: true,
          index,
          elements: [
            {
              picElement: {
                originImageUrl:
                  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIzMjAiIGhlaWdodD0iMjAwIiB2aWV3Qm94PSIwIDAgMzIwIDIwMCI+PHJlY3Qgd2lkdGg9IjMyMCIgaGVpZ2h0PSIyMDAiIGZpbGw9IiMzMzkwZWMiLz48Y2lyY2xlIGN4PSIyNDgiIGN5PSI2MCIgcj0iMzQiIGZpbGw9IiNmZmYiIG9wYWNpdHk9Ii4zIi8+PHBhdGggZD0iTTAgMTUybDgwLTY0IDY0IDQ4IDQ4LTM2IDEyOCA5NnY0SDB6IiBmaWxsPSIjZmZmIiBvcGFjaXR5PSIuNzUiLz48dGV4dCB4PSIyNCIgeT0iMzYiIGZvbnQtZmFtaWx5PSJBcmlhbCIgZm9udC1zaXplPSIyMCIgZmlsbD0iI2ZmZiI+UGljIEVsZW1lbnQ8L3RleHQ+PC9zdmc+",
                picWidth: 320,
                picHeight: 200,
                summary: "图片",
              },
            },
            {
              marketFaceElement: {
                emojiId: "66",
                faceName: "小表情",
                supportSize: [{ width: 96, height: 96 }],
              },
            },
          ],
        };
      }
      if (index === 40) {
        message.text = "";
        message.raw = {
          demo: true,
          index,
          elements: [
            {
              faceElement: {
                faceIndex: 14,
                faceText: "[微笑]",
                url:
                  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0OCIgaGVpZ2h0PSI0OCIgdmlld0JveD0iMCAwIDQ4IDQ4Ij48Y2lyY2xlIGN4PSIyNCIgY3k9IjI0IiByPSIyMiIgZmlsbD0iI2ZmY2M0ZCIvPjxjaXJjbGUgY3g9IjE3IiBjeT0iMjAiIHI9IjMiIGZpbGw9IiM2MzQyMDAiLz48Y2lyY2xlIGN4PSIzMSIgY3k9IjIwIiByPSIzIiBmaWxsPSIjNjM0MjAwIi8+PHBhdGggZD0iTTE1IDMwYzQgNiAxNCA2IDE4IDAiIGZpbGw9Im5vbmUiIHN0cm9rZT0iIzYzNDIwMCIgc3Ryb2tlLXdpZHRoPSIzIiBzdHJva2UtbGluZWNhcD0icm91bmQiLz48L3N2Zz4=",
              },
            },
          ],
        };
      }
      if (index === 41) {
        message.text = "";
        message.raw = {
          demo: true,
          index,
          elements: [
            {
              videoElement: {
                fileName: "demo-video.mp4",
                fileTime: 18,
                thumbWidth: 300,
                thumbHeight: 180,
                thumbPath: {
                  "1":
                    "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIzMDAiIGhlaWdodD0iMTgwIiB2aWV3Qm94PSIwIDAgMzAwIDE4MCI+PHJlY3Qgd2lkdGg9IjMwMCIgaGVpZ2h0PSIxODAiIGZpbGw9IiMxMTE4MjciLz48Y2lyY2xlIGN4PSIxNTAiIGN5PSI5MCIgcj0iMzQiIGZpbGw9IiMzMzkwZWMiLz48cGF0aCBkPSJNMTQxIDcydjM2bDMwLTE4eiIgZmlsbD0iI2ZmZiIvPjx0ZXh0IHg9IjE4IiB5PSIzMCIgZm9udC1mYW1pbHk9IkFyaWFsIiBmb250LXNpemU9IjE4IiBmaWxsPSIjZmZmIj5WaWRlbyBFbGVtZW50PC90ZXh0Pjwvc3ZnPg==",
                },
              },
            },
          ],
        };
      }
      if (index === 45) {
        message.text = "";
        message.raw = {
          demo: true,
          index,
          elements: [
            {
              multiForwardMsgElement: {
                xmlContent:
                  '<msg><item><title color="#000000">群聊记录</title><title color="#777777">Alice: 第一条摘要</title><title color="#777777">Bob: 第二条摘要</title><summary>查看 12 条转发消息</summary></item></msg>',
              },
            },
          ],
        };
      }
      if (index === 50) {
        message.text = "";
        message.raw = {
          demo: true,
          index,
          elements: [
            {
              arkElement: {
                bytesData: JSON.stringify({
                  app: "com.tencent.multimsg",
                  meta: { detail: { source: "收藏转发", news: [{ text: "素材 A" }, { text: "素材 B" }], summary: "2 条消息", resid: "demo" } },
                }),
              },
            },
          ],
        };
      }
      return message;
    });
}
