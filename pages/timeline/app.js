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
  timelineItems: [],
  latestPollInFlight: false,
  pollTimer: null,
};

const demoMessages = buildDemoMessages();

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
  mediaViewer: document.getElementById("mediaViewer"),
  mediaViewerBody: document.getElementById("mediaViewerBody"),
  mediaViewerCaption: document.getElementById("mediaViewerCaption"),
  closeViewerBtn: document.getElementById("closeViewerBtn"),
  downloadViewerBtn: document.getElementById("downloadViewerBtn"),
  prevMediaBtn: document.getElementById("prevMediaBtn"),
  nextMediaBtn: document.getElementById("nextMediaBtn"),
  statusStrip: document.getElementById("statusStrip"),
  sessionToggleBtn: document.getElementById("sessionToggleBtn"),
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
  const source = String(item?.source || item?.url || item?.path || "").trim();
  if (!source) return "";
  if (source.startsWith("media/")) return pluginApiUrl(`file-proxy?path=${encodeURIComponent(source)}`);
  if (/^https?:\/\//i.test(source) && normalizeMediaKind(item.kind) === "image") {
    return pluginApiUrl(`image-proxy?url=${encodeURIComponent(source)}`);
  }
  return "";
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
  return !state.q && !hasActiveFilters();
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
  const dbFactory = window.indexedDB;
  if (!dbFactory) return null;
  if (messageCacheDb) return messageCacheDb;
  return new Promise((resolve) => {
    const request = dbFactory.open(MESSAGE_CACHE_DB, MESSAGE_CACHE_VERSION);
    request.onerror = () => resolve(null);
    request.onsuccess = () => {
      messageCacheDb = request.result;
      messageCacheDb.onversionchange = () => {
        messageCacheDb?.close?.();
        messageCacheDb = null;
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
    const tx = db.transaction(MESSAGE_CACHE_STORE, "readonly");
    const request = tx.objectStore(MESSAGE_CACHE_STORE).get(cacheKey);
    request.onerror = () => resolve([]);
    request.onsuccess = () => {
      const messages = Array.isArray(request.result?.messages) ? request.result.messages : [];
      resolve(dedupeMessages(messages));
    };
  });
}

async function setCachedMessagesForCurrentView(messages, cacheKey = messageCacheKey()) {
  if (!canUseMessageCache()) return;
  const db = await openMessageCacheDb();
  if (!db) return;
  const cached = dedupeMessages(messages || []).slice(-MESSAGE_CACHE_LIMIT);
  await new Promise((resolve) => {
    const tx = db.transaction(MESSAGE_CACHE_STORE, "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.objectStore(MESSAGE_CACHE_STORE).put({
      cacheKey,
      messages: cached,
      updatedAt: Date.now(),
    });
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
      button.className = `conversation ${active ? "active" : ""}`;
      button.type = "button";
      button.setAttribute("aria-pressed", String(active));
      button.title = item.umo || "全部会话";
      button.innerHTML = `
        <div class="conversation-avatar" style="--avatar-bg:${avatarColor(item.umo || "all")}">${escapeHtml(initials(item.sample_sender || item.umo || "All"))}</div>
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
  for (const item of items) {
    fragment.appendChild(renderTimelineItem(item));
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

function renderTimelineItem(item) {
  if (item.type === "day") {
    const node = document.createElement("div");
    node.className = "day-divider";
    node.textContent = item.label;
    return node;
  }
  if (item.type === "gap") {
    const node = document.createElement("div");
    node.className = "time-gap";
    node.textContent = item.label;
    return node;
  }
  return renderMessage(item.message, item.group, item.active);
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
  const media = Array.isArray(item.media) ? item.media : [];
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
  node.querySelectorAll(".image-avatar img").forEach((image) => {
    image.addEventListener("error", () => image.remove(), { once: true });
  });
  node.querySelectorAll(".inline-market-face").forEach((image) => {
    image.addEventListener("error", () => {
      image.parentElement?.classList.add("no-image");
      image.remove();
    }, { once: true });
  });

  node.addEventListener("click", (event) => {
    const inlineImage = event.target?.closest?.("[data-inline-image]");
    if (inlineImage?.dataset.inlineImage) {
      openInlineImageViewer(inlineImage.dataset.inlineImage);
      return;
    }
    const replyTarget = event.target?.closest?.("[data-reply-key]");
    if (replyTarget?.dataset.replyKey) {
      scrollTimelineToKey(replyTarget.dataset.replyKey);
      return;
    }
    const action = event.target?.closest?.("[data-action]")?.dataset.action;
    if (!action) return;
    if (action === "favorite") toggleFavorite(item);
    if (action === "tag") openTagDialog(item);
    if (action === "copy") copyText(text || JSON.stringify(item.raw || item.components || ""));
    if (action === "raw") showRaw(item);
  });
  node.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    showContextMenu(event.clientX, event.clientY, item, text);
  });
  return node;
}

function openInlineImageViewer(url) {
  const item = { kind: "image", name: "图片", source: url, inline_url: url };
  state.mediaItems = [item];
  state.mediaIndex = 0;
  renderMediaViewer();
  els.mediaViewer.hidden = false;
}

function renderMedia(item) {
  const card = document.createElement("div");
  const hasLocal = Boolean(item.local_path);
  const displayUrl = mediaDisplayUrl(item);
  const kind = normalizeMediaKind(item.kind);
  card.className = `media-card ${kind}`;
  if (displayUrl && kind === "image") {
    const button = document.createElement("button");
    button.className = "media-thumb";
    button.type = "button";
    button.setAttribute("aria-label", `预览 ${item.name || "图片"}`);
    button.innerHTML = `<img loading="lazy" src="${escapeAttr(displayUrl)}" alt="${escapeAttr(item.name || "图片")}" />`;
    button.addEventListener("click", () => openMediaViewer(item));
    card.appendChild(button);
  } else if (displayUrl && kind === "video") {
    const video = document.createElement("video");
    video.controls = true;
    video.preload = "metadata";
    video.src = displayUrl;
    card.appendChild(video);
  } else if (displayUrl && kind === "audio") {
    const audio = document.createElement("audio");
    audio.controls = true;
    audio.preload = "metadata";
    audio.src = displayUrl;
    card.appendChild(audio);
  }

  const meta = document.createElement("div");
  meta.className = "media-file";
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
  const media = Array.isArray(item.media) ? item.media : [];
  const displayableMedia = media.filter((mediaItem) => mediaDisplayUrl(mediaItem));
  els.contextMenu.innerHTML = `
    <button type="button" data-action="favorite">${item.favorite ? "取消收藏" : "收藏消息"}</button>
    <button type="button" data-action="tag">编辑标签</button>
    <button type="button" data-action="copy">复制文本</button>
    <button type="button" data-action="raw">查看 JSON</button>
    <button type="button" data-action="copy-json">复制 JSON</button>
    ${displayableMedia.length ? `<button type="button" data-action="open-media">打开媒体</button>` : ""}
  `;
  els.contextMenu.hidden = false;
  const rect = els.contextMenu.getBoundingClientRect();
  els.contextMenu.style.left = `${Math.min(x, window.innerWidth - rect.width - 12)}px`;
  els.contextMenu.style.top = `${Math.min(y, window.innerHeight - rect.height - 12)}px`;
  els.contextMenu.onclick = (event) => {
    const action = event.target?.closest?.("button")?.dataset.action;
    if (action === "favorite") toggleFavorite(item);
    if (action === "tag") openTagDialog(item);
    if (action === "copy") copyText(text || "");
    if (action === "raw") showRaw(item);
    if (action === "copy-json") copyText(JSON.stringify(item, null, 2));
    if (action === "open-media") {
      const first = displayableMedia[0];
      if (first) openMediaViewer(first);
    }
    hideContextMenu();
  };
}

function hideContextMenu() {
  els.contextMenu.hidden = true;
}

function showRaw(item) {
  els.detailPane.hidden = false;
  els.rawJson.textContent = JSON.stringify(item, null, 2);
}

function openMediaViewer(item) {
  state.mediaItems = state.messages.flatMap((msg) => (Array.isArray(msg.media) ? msg.media : [])).filter((m) => mediaDisplayUrl(m));
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
  if ("src" in node && displayUrl) {
    node.src = displayUrl;
  }
  els.mediaViewerBody.appendChild(node);
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
    .map((item) => componentText(item))
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
  const rendered = messageElementObjects(item).map((component) => renderComponentInlineHtml(component)).filter(Boolean).join("");
  if (rendered) return rendered;
  return highlightText(messagePlainText(item), state.q);
}

function messageElementObjects(item) {
  const components = Array.isArray(item?.components) ? item.components : [];
  const rawObjects = rawElements(item?.raw).map((element, index) => ({ index: components.length + index, kind: "raw", data: element }));
  return [...components, ...rawObjects];
}

function componentText(component) {
  if (!component || typeof component !== "object") return "";
  const data = component.data || {};
  const raw = data.data && typeof data.data === "object" ? data.data : data;
  if (!raw || typeof raw !== "object") return "";
  return String(
      raw.text ??
      raw.content ??
      raw.message ??
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

function renderComponentInlineHtml(component) {
  if (!component || typeof component !== "object") return "";
  const data = component.data || {};
  const raw = data.data && typeof data.data === "object" ? data.data : data;
  const kind = String(component.kind || raw.type || "").toLowerCase();
  const typeHint = Number(raw.type ?? component.type);
  const elementTypeHint = Number(raw.elementType ?? component.elementType);
  if (raw.picElement || raw.imageElement) return renderPicElementHtml(raw.picElement || raw.imageElement);
  if (raw.faceElement) return renderFaceHtml(raw.faceElement);
  if (raw.marketFaceElement) return renderMarketFaceHtml(raw.marketFaceElement);
  if (raw.fileElement) return renderFileElementHtml(raw.fileElement);
  if (raw.pttElement || raw.voiceElement) return renderPttElementHtml(raw.pttElement || raw.voiceElement);
  if (raw.videoElement) return renderVideoElementHtml(raw.videoElement);
  if (raw.multiForwardMsgElement) return renderForwardElementHtml(raw.multiForwardMsgElement);
  if (raw.arkElement) return renderArkElementHtml(raw.arkElement);
  if (raw.replyElement || raw.grayTipElement) return "";
  if (raw.textElement?.content) return highlightText(raw.textElement.content, state.q);
  if (raw.text) return highlightText(raw.text, state.q);
  if (raw.content) return highlightText(raw.content, state.q);
  if (typeHint === 2 || elementTypeHint === 2) return renderPicElementHtml(raw);
  if (typeHint === 3 || elementTypeHint === 6) return renderFaceHtml(raw);
  if (typeHint === 6 || elementTypeHint === 3) return renderFileElementHtml(raw);
  if (elementTypeHint === 4) return renderPttElementHtml(raw);
  if (elementTypeHint === 5) return renderVideoElementHtml(raw);
  if (elementTypeHint === 16) return renderForwardElementHtml(raw);
  if (elementTypeHint === 10) return renderArkElementHtml(raw);
  if (kind.includes("image") || kind.includes("pic")) return renderPicElementHtml(raw);
  if (kind.includes("face")) return renderFaceHtml(raw);
  if (kind.includes("file")) return renderFileElementHtml(raw);
  if (kind.includes("record") || kind.includes("audio") || kind.includes("ptt")) return renderPttElementHtml(raw);
  if (kind.includes("video")) return renderVideoElementHtml(raw);
  if (kind.includes("text") || kind.includes("plain")) return highlightText(componentText(component), state.q);
  return "";
}

function renderFaceHtml(face) {
  const id = face?.faceIndex ?? face?.faceId ?? face?.id ?? "";
  const label = face?.faceText || face?.name || (id !== "" ? `[表情${id}]` : "[表情]");
  return `<span class="inline-face" title="${escapeAttr(label)}">${escapeHtml(label)}</span>`;
}

function renderMarketFaceHtml(face) {
  const emojiId = String(face?.emojiId || "").trim();
  const faceName = face?.faceName || face?.name || "表情包";
  if (!emojiId) return `<span class="inline-face market">${escapeHtml(`[${faceName}]`)}</span>`;
  const sizes = Array.isArray(face?.supportSize) ? face.supportSize : [];
  const size = sizes[0] || {};
  const width = Math.min(Number(size.width || 120), 180);
  const height = Math.min(Number(size.height || 120), 180);
  const dir = emojiId.slice(0, 2);
  const rawUrl = `https://gxh.vip.qq.com/club/item/parcel/item/${dir}/${emojiId}/raw${Math.min(width || 120, 300)}.gif`;
  const proxyUrl = pluginApiUrl(`image-proxy?url=${encodeURIComponent(rawUrl)}`);
  return `<span class="market-face-shell"><img class="inline-market-face" loading="lazy" src="${escapeAttr(proxyUrl)}" alt="${escapeAttr(faceName)}" title="${escapeAttr(faceName)}" style="max-width:${width}px;max-height:${height}px" /><em>${escapeHtml(`[${faceName}]`)}</em></span>`;
}

function renderPicElementHtml(pic) {
  const source = normalizeQpicSource(pic?.source || pic?.url || pic?.picUrl || pic?.originImageUrl || pic?.thumbUrl || pic?.filePath || pic?.path || "");
  const displayUrl = mediaSourceDisplayUrl({ kind: "image", source });
  const label = pic?.summary || pic?.fileName || pic?.name || "图片";
  if (!displayUrl) return `<span class="inline-face">${escapeHtml(`[${label}]`)}</span>`;
  return `<button class="inline-image-preview" type="button" data-inline-image="${escapeAttr(displayUrl)}" aria-label="预览图片"><img loading="lazy" src="${escapeAttr(displayUrl)}" alt="${escapeAttr(label)}" /></button>`;
}

function renderFileElementHtml(file) {
  const name = file?.fileName || file?.name || file?.file_name || "文件";
  const size = file?.fileSize ?? file?.size ?? file?.file_size;
  return `
    <span class="inline-rich-card file-element">
      <span class="rich-card-icon">文</span>
      <span class="rich-card-main">
        <strong>${escapeHtml(name)}</strong>
        <small>${size ? escapeHtml(fmtBytes(size)) : "文件消息"}</small>
      </span>
    </span>
  `;
}

function renderPttElementHtml(ptt) {
  const duration = Number(ptt?.duration || ptt?.fileTime || 0);
  const width = Math.min(220, Math.max(96, 96 + duration * 4));
  const text = ptt?.text || ptt?.transcribedText || "";
  return `
    <span class="voice-element">
      <span class="voice-bar" style="width:${width}px">
        <span class="voice-play">音</span>
        <span class="voice-wave" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>
        <span class="voice-duration">${escapeHtml(formatDuration(duration))}</span>
      </span>
      ${text ? `<span class="voice-text">${highlightText(text, state.q)}</span>` : ""}
    </span>
  `;
}

function renderVideoElementHtml(video) {
  const thumb = firstMapValue(video?.thumbPath) || video?.thumbUrl || video?.thumb || video?.coverUrl || "";
  const duration = Number(video?.fileTime || video?.duration || 0);
  const name = video?.fileName || video?.name || "视频";
  const thumbUrl = thumb ? mediaSourceDisplayUrl({ kind: "image", source: thumb }) : "";
  return `
    <span class="inline-rich-card video-element">
      <span class="video-cover">${thumbUrl ? `<img loading="lazy" src="${escapeAttr(thumbUrl)}" alt="${escapeAttr(name)}" />` : `<span>影</span>`}<b>▶</b></span>
      <span class="rich-card-main">
        <strong>${escapeHtml(name)}</strong>
        <small>${escapeHtml(duration ? formatDuration(duration) : "视频消息")}</small>
      </span>
    </span>
  `;
}

function renderForwardElementHtml(forward) {
  const parsed = parseForwardXml(forward?.xmlContent || forward?.xml || "");
  const title = parsed.title || forward?.title || "[聊天记录]";
  const previews = parsed.previews.slice(0, 3);
  const summary = parsed.summary || forward?.summary || "合并转发";
  return renderForwardCardHtml(title, previews, summary);
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
    );
  }
  const prompt = data?.prompt || ark?.prompt || "[卡片消息]";
  return `<span class="inline-rich-card ark-element"><span class="rich-card-icon">卡</span><span class="rich-card-main"><strong>${escapeHtml(prompt)}</strong><small>Ark 卡片</small></span></span>`;
}

function renderForwardCardHtml(title, previews, summary) {
  return `
    <span class="forward-card">
      <strong>${escapeHtml(title || "[聊天记录]")}</strong>
      ${previews.map((preview) => `<span>${escapeHtml(preview)}</span>`).join("")}
      <small>${escapeHtml(summary || "合并转发")}</small>
    </span>
  `;
}

function parseForwardXml(xml) {
  const text = String(xml || "");
  if (!text) return { title: "", previews: [], summary: "" };
  const title = stripHtml(matchFirst(text, /<title[^>]*color=["']#000000["'][^>]*>(.*?)<\/title>/i) || matchFirst(text, /brief=["']([^"']+)["']/i) || "[聊天记录]");
  const previews = [...text.matchAll(/<title[^>]*color=["']#777777["'][^>]*>(.*?)<\/title>/gi)].map((match) => stripHtml(match[1])).filter(Boolean);
  const summary = stripHtml(matchFirst(text, /<summary[^>]*>(.*?)<\/summary>/i) || "");
  return { title, previews, summary };
}

function matchFirst(value, pattern) {
  return String(value || "").match(pattern)?.[1] || "";
}

function firstMapValue(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value[0] || "";
  if (typeof value === "object") return Object.values(value)[0] || "";
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
  const source = String(item?.source || item?.url || item?.path || "").trim();
  if (!source) return "";
  if (source.startsWith("media/")) return pluginApiUrl(`file-proxy?path=${encodeURIComponent(source)}`);
  if (/^https?:\/\//i.test(source) && normalizeMediaKind(item.kind) === "image") return pluginApiUrl(`image-proxy?url=${encodeURIComponent(source)}`);
  return "";
}

function normalizeQpicSource(source) {
  const value = String(source || "").trim();
  if (!value) return "";
  if (value.startsWith("//")) return `https:${value}`;
  if (value.startsWith("/")) return `https://gchat.qpic.cn${value}`;
  return value;
}

function textFromRawElements(raw) {
  return rawElements(raw).map((element) => rawElementText(element)).filter(Boolean).join("");
}

function rawElementText(element) {
  if (!element || typeof element !== "object") return "";
  if (element.textElement?.content) return String(element.textElement.content);
  if (element.textElement?.text) return String(element.textElement.text);
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
  if (typeHint === 2 || elementTypeHint === 2) return "[图片]";
  if (typeHint === 3 || elementTypeHint === 6) return "[表情]";
  if (typeHint === 6 || elementTypeHint === 3) return "[文件]";
  if (elementTypeHint === 4) return "[语音]";
  if (elementTypeHint === 5) return "[视频]";
  if (elementTypeHint === 16) return "[聊天记录]";
  if (elementTypeHint === 10) return "[卡片消息]";
  return "";
}

function rawElements(raw) {
  if (!raw || typeof raw !== "object") return [];
  if (Array.isArray(raw.elements)) return raw.elements;
  if (Array.isArray(raw.message)) return raw.message;
  if (Array.isArray(raw.msgElements)) return raw.msgElements;
  return [];
}

function systemTipText(item) {
  const elements = [...rawElements(item?.raw), ...componentRawObjects(item?.components)];
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
      const text = Array.isArray(parsed.items) ? parsed.items.map((item) => item.txt || item.text || "").join("") : "";
      if (text) return stripHtml(text);
    } catch {
      return "";
    }
  }
  const xml = grayTip.xmlElement?.content || grayTip.content || grayTip.text || grayTip.recentAbstract;
  if (xml) return stripHtml(String(xml));
  return "";
}

function stripHtml(value) {
  return String(value || "").replace(/<[^>]+>/g, "").trim();
}

function componentRawObjects(components) {
  if (!Array.isArray(components)) return [];
  return components
    .map((component) => {
      const data = component?.data || {};
      return data.data && typeof data.data === "object" ? data.data : data;
    })
    .filter((item) => item && typeof item === "object");
}

function isRecalledMessage(item) {
  const raw = item?.raw || {};
  if (raw.recallTime && String(raw.recallTime) !== "0") return true;
  if (raw.msgStatus === "recalled" || raw.status === "recalled") return true;
  return [...rawElements(raw), ...componentRawObjects(item?.components)].some((element) => Boolean(element?.grayTipElement?.revokeElement || element?.revokeElement));
}

function replyInfo(item) {
  const all = [...rawElements(item?.raw), ...componentRawObjects(item?.components)];
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
  const values = Array.isArray(raw.emojiLikesList)
    ? raw.emojiLikesList
    : Array.isArray(raw.reactions)
      ? raw.reactions
      : Array.isArray(item?.reactions)
        ? item.reactions
        : [];
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
  return `<span class="reaction-chip ${reaction.clicked ? "active" : ""}" title="表情回应">${escapeHtml(label)}${count ? `<b>${escapeHtml(count)}</b>` : ""}</span>`;
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

function renderAvatarHtml(item, sender, self, group) {
  if (self || !group.showAvatar) return `<div class="avatar-spacer"></div>`;
  const avatarUrl = qqAvatarUrl(item);
  if (avatarUrl) {
    return `<div class="avatar image-avatar" style="--avatar-bg:${avatarColor(sender)}"><img loading="lazy" src="${escapeAttr(avatarUrl)}" alt="${escapeAttr(sender)}" /><span>${escapeHtml(initials(sender))}</span></div>`;
  }
  return `<div class="avatar" style="--avatar-bg:${avatarColor(sender)}">${escapeHtml(initials(sender))}</div>`;
}

function qqAvatarUrl(item) {
  const raw = item?.raw || {};
  const uin = String(raw.senderUin || raw.sender_uin || raw.uin || "").trim();
  if (!uin || !/^\d{5,}$/.test(uin)) return "";
  const rawUrl = `https://q1.qlogo.cn/g?b=qq&nk=${encodeURIComponent(uin)}&s=100`;
  return pluginApiUrl(`image-proxy?url=${encodeURIComponent(rawUrl)}`);
}

function senderBadges(item) {
  const raw = item?.raw || {};
  const badges = [];
  const attrs = raw.msgAttrs || raw.msg_attrs || {};
  const honor = attrs?.["2"]?.groupHonor || attrs?.[2]?.groupHonor || raw.groupHonor || {};
  if (honor.level) badges.push({ label: `Lv.${honor.level}`, tone: "level" });
  const title = honor.uniqueTitle || raw.memberTitle || raw.specialTitle;
  if (title) badges.push({ label: title, tone: "title" });
  const role = String(raw.memberRole || raw.role || "").toLowerCase();
  if (role === "owner") badges.push({ label: "群主", tone: "owner" });
  if (role === "admin" || role === "administrator") badges.push({ label: "管理员", tone: "admin" });
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
  });
  document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
      event.preventDefault();
      els.searchInput.focus();
      els.searchInput.select();
    }
    if (event.key === "Escape") {
      hideContextMenu();
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
              local_path: "demo",
              source: "demo",
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
