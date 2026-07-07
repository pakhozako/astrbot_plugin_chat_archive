const PLUGIN = "astrbot_plugin_chat_archive";
const bridge = window.AstrBotPluginPage;
const bridgeAvailable = Boolean(bridge && window.parent !== window);

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
  const cleanPath = endpoint(path)
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `/api/v1/plugins/extensions/${encodeURIComponent(PLUGIN)}/${cleanPath}`;
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
  if (!bridgeAvailable || !bridge?.download) {
    window.open(mediaUrl(item), "_blank", "noopener");
    return;
  }
  await bridge.download(endpoint(`media/${item.id}`), {}, item.name || "媒体文件.bin");
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
  state.loading = true;
  state.error = "";
  els.loadMoreBtn.disabled = true;
  if (!append && !state.messages.length) renderTimeline();
  try {
    const before =
      append && state.messages.length
        ? Math.min(...state.messages.map((item) => Number(item.created_at || 0)).filter(Boolean))
        : 0;
    const data = await apiGet("/messages", {
      umo: state.currentUmo,
      q: state.q,
      before,
      limit: 100,
      sender: state.filters.sender,
      message_type: state.filters.messageType,
      media_kind: state.filters.mediaKind,
      start_ts: state.filters.startTs || "",
      end_ts: state.filters.endTs || "",
    });
    state.hasMore = Boolean(data.has_more);
    state.messages = append ? dedupeMessages([...(data.items || []), ...state.messages]) : data.items || [];
    state.activeMatchIndex = -1;
    renderTimeline({ preserveTop: append, stickToBottom });
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
  const fragment = document.createDocumentFragment();
  for (const item of items) {
    fragment.appendChild(renderTimelineItem(item));
  }
  els.timeline.replaceChildren(fragment);
  if (options.preserveTop) {
    els.timeline.scrollTop = oldTop + Math.max(0, els.timeline.scrollHeight - oldHeight);
  } else if (options.stickToBottom) {
    scrollTimelineToBottom();
  }
  updateSearchUi();
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

function renderMessage(item, group, active = false) {
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

  const text = item.text || textFromComponents(item.components);
  const sender = item.sender_name || item.sender_id || "未知用户";
  const media = Array.isArray(item.media) ? item.media : [];
  const platform = item.platform || "";
  const tags = Array.isArray(item.tags) ? item.tags : [];
  const avatar = !self && group.showAvatar ? `<div class="avatar" style="--avatar-bg:${avatarColor(sender)}">${escapeHtml(initials(sender))}</div>` : `<div class="avatar-spacer"></div>`;
  const name = !self && group.showName ? `<div class="sender">${escapeHtml(sender)}</div>` : "";
  node.innerHTML = `
    ${avatar}
    <div class="bubble-shell">
      <div class="bubble">
        ${name}
        ${text ? `<div class="message-text">${highlightText(text, state.q)}</div>` : ""}
        ${tags.length ? `<div class="tag-row">${tags.map(renderTagChipHtml).join("")}</div>` : ""}
        <div class="media-grid"></div>
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

  node.addEventListener("click", (event) => {
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

function renderMedia(item) {
  const card = document.createElement("div");
  const hasLocal = Boolean(item.local_path);
  const kind = normalizeMediaKind(item.kind);
  card.className = `media-card ${kind}`;
  if (hasLocal && kind === "image") {
    const button = document.createElement("button");
    button.className = "media-thumb";
    button.type = "button";
    button.setAttribute("aria-label", `预览 ${item.name || "图片"}`);
    button.innerHTML = `<img loading="lazy" src="${escapeAttr(mediaUrl(item))}" alt="${escapeAttr(item.name || "图片")}" />`;
    button.addEventListener("click", () => openMediaViewer(item));
    card.appendChild(button);
  } else if (hasLocal && kind === "video") {
    const video = document.createElement("video");
    video.controls = true;
    video.preload = "metadata";
    video.src = mediaUrl(item);
    card.appendChild(video);
  } else if (hasLocal && kind === "audio") {
    const audio = document.createElement("audio");
    audio.controls = true;
    audio.preload = "metadata";
    audio.src = mediaUrl(item);
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
    ${hasLocal ? `<button class="media-download" type="button" aria-label="下载媒体">下载</button>` : `<span class="media-meta">仅来源</span>`}
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
  els.contextMenu.innerHTML = `
    <button type="button" data-action="favorite">${item.favorite ? "取消收藏" : "收藏消息"}</button>
    <button type="button" data-action="tag">编辑标签</button>
    <button type="button" data-action="copy">复制文本</button>
    <button type="button" data-action="raw">查看 JSON</button>
    <button type="button" data-action="copy-json">复制 JSON</button>
    ${media.length ? `<button type="button" data-action="open-media">打开媒体</button>` : ""}
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
      const first = media.find((mediaItem) => mediaItem.local_path);
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
  state.mediaItems = state.messages.flatMap((msg) => (Array.isArray(msg.media) ? msg.media : [])).filter((m) => m.local_path);
  state.mediaIndex = Math.max(0, state.mediaItems.findIndex((m) => String(m.id) === String(item.id)));
  renderMediaViewer();
  els.mediaViewer.hidden = false;
}

function renderMediaViewer() {
  const item = state.mediaItems[state.mediaIndex];
  if (!item) return;
  els.mediaViewerBody.replaceChildren();
  const kind = normalizeMediaKind(item.kind);
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
  if ("src" in node) {
    node.src = mediaUrl(item);
  }
  els.mediaViewerBody.appendChild(node);
  els.mediaViewerCaption.textContent = `${item.name || mediaKindLabel(kind)} / ${state.mediaIndex + 1}/${state.mediaItems.length}`;
  els.prevMediaBtn.disabled = state.mediaIndex <= 0;
  els.nextMediaBtn.disabled = state.mediaIndex >= state.mediaItems.length - 1;
  els.downloadViewerBtn.disabled = !item.local_path;
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
    .map((item, index) => ({ item, index, text: `${item.text || textFromComponents(item.components)} ${item.sender_name || ""}`.toLocaleLowerCase() }))
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
    .map((item) => item?.data?.data?.text || item?.data?.text || "")
    .filter(Boolean)
    .join("");
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
      items = items.filter((item) => `${item.text} ${item.sender_name}`.toLocaleLowerCase().includes(q));
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
    return {
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
  });
}
