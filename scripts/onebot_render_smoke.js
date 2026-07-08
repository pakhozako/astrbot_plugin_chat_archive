const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const util = require("node:util");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const appSource = fs.readFileSync(path.join(root, "pages/timeline/app.js"), "utf8");

function makeStubElement() {
  return {
    hidden: false,
    value: "",
    textContent: "",
    innerHTML: "",
    className: "",
    dataset: {},
    style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {},
    removeEventListener() {},
    appendChild() {},
    append() {},
    replaceChildren() {},
    remove() {},
    querySelector() { return makeStubElement(); },
    querySelectorAll() { return []; },
    setAttribute() {},
    closest() { return null; },
    scrollIntoView() {},
    getBoundingClientRect() { return { width: 0, height: 0 }; },
  };
}

function loadApp() {
  const context = {
    console,
    Map,
    Set,
    Date,
    JSON,
    Math,
    Number,
    String,
    Boolean,
    Array,
    URL,
    URLSearchParams,
    RegExp,
    TextDecoder: util.TextDecoder,
    Uint8Array,
    atob: globalThis.atob,
    navigator: { clipboard: null },
    parent: {},
    document: {
      body: makeStubElement(),
      getElementById() { return makeStubElement(); },
      createElement() { return makeStubElement(); },
      execCommand() { return true; },
      addEventListener() {},
      removeEventListener() {},
    },
    CSS: {
      escape(value) {
        return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
      },
    },
    setTimeout() { return 0; },
    clearTimeout() {},
    setInterval() { return 0; },
    clearInterval() {},
    requestAnimationFrame(callback) {
      if (typeof callback === "function") callback();
    },
  };
  context.window = {
    AstrBotPluginPage: null,
    parent: context.parent,
    location: { href: "http://localhost/" },
    document: context.document,
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(appSource, context, { filename: "app.js" });
  return context;
}

const app = loadApp();

function message(raw, extra = {}) {
  return { text: "", media: [], components: [], raw, ...extra };
}

const replyRaw = {
  status: "ok",
  retcode: 0,
  data: {
    message_type: "group",
    message_id: -1891733802,
    message_seq: 370005,
    group_id: 972752812,
    user_id: 3959955822,
    message: [
      { type: "reply", data: { id: "1589819895" } },
      { type: "at", data: { qq: "2240573001" } },
      { type: "text", data: { text: " 有些是因为通配符的原因" } },
    ],
  },
};

const announcementPayload = {
  app: "com.tencent.mannounce",
  meta: {
    mannounce: {
      title: Buffer.from("群公告", "utf8").toString("base64"),
      text: Buffer.from("群规\n一、禁止刷屏", "utf8").toString("base64"),
    },
  },
  prompt: "[群公告]**群规**一、禁止刷屏",
};
const announcementRaw = {
  status: "ok",
  data: {
    message: [{ type: "json", data: { data: JSON.stringify(announcementPayload) } }],
  },
};

const forwardId = "2fz1pK0FJwlrHNU9DLEskChlmbh7EjVjfnd38qf//7gjf8Gc30qY/bmY4K5zYsXK";
const forwardRaw = {
  status: "ok",
  data: {
    message: [{ type: "forward", data: { id: forwardId } }],
  },
};

const tempGif = "C:/Users/Claude/.astrbot/data/temp/media_image_de552006cf0548e6a4e6301878850191.gif";
const sticker = message(
  { message: [{ type: "image", data: { file: tempGif, url: tempGif, path: tempGif } }] },
  {
    text: "FD76FDDEEC456A17ECADB5C42557C6BE.jpg FD76FDDEEC456A17ECADB5C42557C6BE.jpg 下载",
    media: [
      {
        id: 22,
        kind: "image",
        name: "FD76FDDEEC456A17ECADB5C42557C6BE.jpg",
        source: tempGif,
        local_path: "D:/GITHUB/piugin/data/media/2026/07/FD76FDDEEC456A17ECADB5C42557C6BE.jpg",
        relative_path: "2026/07/FD76FDDEEC456A17ECADB5C42557C6BE.jpg",
        hash: "hash-fd",
      },
    ],
    components: [{ kind: "image", index: 0, data: { file: tempGif, url: tempGif, path: tempGif } }],
  },
);

const replyHtml = app.messageBodyHtml(message(replyRaw));
assert.match(replyHtml, /@2240573001/);
assert.match(replyHtml, /通配符/);
const reply = app.replyInfo(message(replyRaw));
assert.equal(reply.msgId, "1589819895");
assert.equal(reply.msgSeq, "");
assert.equal(reply.sender, "");
assert.equal(reply.text, "引用消息 #1589819895");

const announcementHtml = app.messageBodyHtml(message(announcementRaw));
assert.match(announcementHtml, /群公告/);
assert.match(announcementHtml, /禁止刷屏/);
assert.match(app.messagePlainText(message(announcementRaw)), /\[群公告\]/);

const forwardHtml = app.messageBodyHtml(message(forwardRaw));
assert.match(forwardHtml, /合并转发/);
assert.match(forwardHtml, /OneBot 合并转发/);
assert.equal(app.messagePlainText(message(forwardRaw)), `[合并转发] ${forwardId}`);

assert.equal(app.messageBodyHtml(sticker), "");
assert.equal(app.mediaForGrid(sticker).length, 1);

const commonSegments = message({
  message: [
    { type: "share", data: { title: "链接标题", url: "https://example.com" } },
    { type: "music", data: { type: "qq", title: "歌曲名" } },
    { type: "poke", data: { qq: "12345" } },
    { type: "location", data: { title: "位置名", lat: "1.23", lon: "4.56" } },
  ],
});
const commonHtml = app.messageBodyHtml(commonSegments);
assert.match(commonHtml, /链接标题/);
assert.match(commonHtml, /歌曲名/);
assert.match(commonHtml, /戳一戳/);
assert.match(commonHtml, /位置名/);

console.log("onebot render smoke OK");
