const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const matcher = require("../shared/selection-lookup-matcher.js");
const clipboard = require("../shared/selection-lookup-clipboard.js");
const overlayModule = require("../shared/selection-lookup-overlay.js");
const listenerModule = require("../shared/selection-lookup-listener.js");
const registration = require("../shared/selection-lookup-registration.js");
const schemaContext = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../shared/resume-schema.js"), "utf8"), schemaContext);
const schema = schemaContext.window.ResumeSchema;
const description = "第一行：分析用户反馈。\n\n第二行：复核数据。\n" + "项目长描述".repeat(60);
const profile = {
  personal: { fullName: "Alice", summary: "保存的个人简介" },
  educations: [
    { school: "XX大学", degree: "硕士", startDate: "2023-09", endDate: "2026-06" },
    { school: "YY大学", degree: "本科", startDate: "2019-09", endDate: "2023-06" },
    { school: "ZZ学校", startDate: "", endDate: "" },
  ],
  projects: [
    { name: "项目 A", startDate: "2025-01", endDate: "至今", description },
    { name: "项目 B", startDate: "2024-03", endDate: "2024-08", description: "项目 B 的完整描述" },
    { name: "项目 C", isCurrent: "是" },
  ],
  internships: [{ company: "公司 A", startDate: "2025-07", endDate: "2025-09", description: "实习内容" }],
  additional: { selfEvaluation: "保存的自我评价\n保持换行。" },
};
const index = matcher.buildIndex(profile, schema);

test("selection aliases clean required markers and pair each education's start/end as separate values", () => {
  const found = matcher.match(index, "  * 就读年月：（必填） ");
  assert.deepEqual(found.map((item) => item.copyValue), ["2023-09", "2026-06", "2019-09", "2023-06"]);
  assert.deepEqual(found.map((item) => item.sourceName), ["XX大学 · 硕士 · 开始时间", "XX大学 · 硕士 · 结束时间", "YY大学 · 本科 · 开始时间", "YY大学 · 本科 · 结束时间"]);
  assert.equal(new Set(found.map((item) => item.id)).size, 4);
});

test("generic start/end labels never mix dates; recorded 至今 is retained and absent dates are skipped", () => {
  assert.ok(matcher.match(index, "开始时间").every((item) => item.key === "startDate"));
  const ends = matcher.match(index, "结束时间");
  assert.ok(ends.every((item) => item.key === "endDate"));
  assert.ok(ends.some((item) => item.copyValue === "至今"));
  assert.equal(ends.some((item) => item.sourceName.includes("项目 C")), false);
  assert.deepEqual(matcher.match(index, "入学时间").map((item) => item.copyValue), ["2023-09", "2019-09"]);
  assert.deepEqual(matcher.match(index, "开始时间", "教育经历").map((item) => item.copyValue), ["2023-09", "2019-09"]);
  assert.deepEqual(matcher.match(index, "项目时间").map((item) => item.copyValue), ["2025-01", "至今", "2024-03", "2024-08"]);
});

test("project names/descriptions remain distinguishable and copy the full exact text with newlines", () => {
  const found = matcher.match(index, "项目描述");
  assert.equal(found.length, 2);
  assert.equal(found[0].sourceName, "项目 A · 项目说明");
  assert.equal(found[0].copyValue, description);
  assert.ok(found[0].preview.length < found[0].copyValue.length);
  assert.equal(found[1].sourceName, "项目 B · 项目说明");
  assert.deepEqual(matcher.match(index, "毕业院校").map((item) => item.copyValue), ["XX大学", "YY大学", "ZZ学校"]);
  assert.deepEqual(matcher.match(index, "自我评价").map((item) => item.copyValue), [profile.personal.summary, profile.additional.selfEvaluation]);
  assert.deepEqual(matcher.match(index, "不存在的字段"), []);
  assert.equal(matcher.search(index, "项目 B").some((item) => item.copyValue === "项目 B 的完整描述"), true);
});

test("explicit Markdown fields and tables are searchable without converting or mutating the saved profile", () => {
  const before = JSON.stringify(profile);
  const markdown = "## 教育经历\n### 硕士\n- 学校名称：甲大学\n- 学历：硕士\n- 开始时间：2023-09\n- 结束时间：2026-06\n## 项目经历\n### 工具项目\n项目名称：工具 A\n项目描述：第一行\n第二行\n## 自我评价\n严谨负责\n保持学习";
  const result = matcher.buildIndex(profile, schema, markdown);
  assert.equal(JSON.stringify(profile), before);
  assert.deepEqual(matcher.match(result, "就读年月").slice(-2).map((item) => item.copyValue), ["2023-09", "2026-06"]);
  assert.ok(matcher.match(result, "项目描述").some((item) => item.copyValue === "第一行\n第二行"));
  assert.ok(matcher.match(result, "自我评价").some((item) => item.copyValue === "严谨负责\n保持学习"));
  const table = matcher.buildIndex({}, schema, "## 教育经历\n| 学校名称 | 学历 | 开始时间 | 结束时间 |\n| --- | --- | --- | --- |\n| 甲大学 | 硕士 | 2023-09 | 2026-06 |\n| 乙大学 | 本科 | 2019-09 | 2023-06 |");
  assert.deepEqual(matcher.match(table, "在校时间").map((item) => item.copyValue), ["2023-09", "2026-06", "2019-09", "2023-06"]);
  assert.equal(matcher.search(matcher.buildIndex({}, schema, "## 其他\n未结构化但可手动搜索的原文"), "手动搜索").length, 1);
  const range = matcher.buildIndex({}, schema, "## 教育经历\n### 甲大学\n就读年月：2023-09-2026-06");
  assert.deepEqual(matcher.match(range, "就读年月").map((item) => item.copyValue), ["2023-09", "2026-06"]);
});

test("explicit Markdown labels retain their own sections even without category headings", () => {
  const found = matcher.buildIndex({}, schema, "# 个人资料\n姓名：Alice\n学校名称：甲大学\n学历：硕士\n开始时间：2023-09\n结束时间：2026-06\n项目名称：项目 A\n项目描述：第一行\n第二行\n自我评价：严谨负责");
  assert.equal(matcher.match(found, "姓名")[0].copyValue, "Alice");
  assert.deepEqual(matcher.match(found, "就读年月").map((item) => item.copyValue), ["2023-09", "2026-06"]);
  assert.equal(matcher.match(found, "项目描述")[0].copyValue, "第一行\n第二行");
  assert.equal(matcher.match(found, "自我评价")[0].copyValue, "严谨负责");
});

test("saved snapshot reads only the active template and never performs storage migrations or writes", async () => {
  const state = { resumeTemplates: { a: { id: "a", name: "模板 A", profile }, b: { id: "b", profile: { personal: { fullName: "Bob" } } } },
    activeResumeTemplateId: "a", resumeMarkdownDocumentsV1: { a: "A markdown", b: "B markdown" }, resumeProfile: { old: "retained" } };
  const before = JSON.stringify(state);
  const snapshot = await listenerModule.readSnapshot({ local: { get: async () => state, set() { throw new Error("unexpected write"); }, remove() { throw new Error("unexpected cleanup"); } } });
  assert.equal(snapshot.templateName, "模板 A"); assert.equal(snapshot.markdown, "A markdown");
  assert.equal(snapshot.profile.personal.fullName, "Alice"); assert.equal(JSON.stringify(state), before);
});

test("clipboard writes only the candidate value and preserves exact long text", async () => {
  const written = [];
  assert.equal(await clipboard.copy("2023-09", { navigator: { clipboard: { writeText: async (value) => written.push(value) } } }), true);
  assert.equal(await clipboard.copy(description, { navigator: { clipboard: { writeText: async (value) => written.push(value) } } }), true);
  assert.deepEqual(written, ["2023-09", description]);
  assert.equal(await clipboard.copy("x", { navigator: {}, document: {} }), false);
});

test("clipboard fallback restores selection/focus on both success and failure", async () => {
  const events = [], range = { cloneRange() { return this; } };
  const selection = { rangeCount: 1, getRangeAt: () => range, removeAllRanges: () => events.push("clear"), addRange: (item) => { assert.equal(item, range); events.push("restore"); } };
  const input = { style: {}, focus() {}, select() {}, remove: () => events.push("remove") };
  const doc = { getSelection: () => selection, activeElement: { focus: () => events.push("focus"), selectionStart: 2, selectionEnd: 5, setSelectionRange: (start, end) => { assert.equal(start, 2); assert.equal(end, 5); } },
    createElement: () => input, execCommand: () => true };
  const container = { appendChild: (item) => { assert.equal(item, input); } };
  const nav = { clipboard: { writeText: async () => { throw new Error("denied"); } } };
  assert.equal(await clipboard.copy(description, { navigator: nav, document: doc, container }), true);
  assert.equal(input.value, description); assert.deepEqual(events, ["remove", "focus", "clear", "restore"]);
  doc.execCommand = () => { throw new Error("denied"); };
  assert.equal(await clipboard.copy("2023-09", { navigator: nav, document: doc, container }), false);
  assert.equal(events.filter((item) => item === "restore").length, 2);
  let fallbackCalled = false;
  doc.execCommand = () => { fallbackCalled = true; return true; };
  assert.equal(await clipboard.copy("2023-09", { navigator: nav, document: doc, container: { host: { isConnected: false } } }), false);
  assert.equal(fallbackCalled, false);
});

class FakeNode {
  constructor(tag = "div") { this.tagName = tag.toUpperCase(); this.children = []; this.style = {}; this.attrs = {}; this.listeners = new Map(); this.value = ""; this.isConnected = false; }
  appendChild(child) { this.children.push(child); child.parentNode = this; child.isConnected = this.isConnected; return child; }
  append(...children) { children.forEach((child) => this.appendChild(child)); }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  remove() { this.isConnected = false; if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((child) => child !== this); }
  setAttribute(name, value) { this.attrs[name] = value; }
  getAttribute(name) { return this.attrs[name] ?? null; }
  addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  async emit(type, args = {}) { for (const fn of this.listeners.get(type) || []) await fn({ target: this, preventDefault() {}, ...args }); }
  focus() { this.focused = true; }
  getBoundingClientRect() { return { width: 380, height: 300 }; }
  contains(target) { return target === this || this.children.some((child) => child.contains(target)); }
}
function walk(node) { return [node, ...node.children.flatMap(walk)]; }
function overlayHarness(copyResults = [true]) {
  const roots = [], copies = [], timers = new Map(); let nextTimer = 0;
  const body = new FakeNode("body"); body.isConnected = true;
  const doc = { body, createElement(tag) {
    const node = new FakeNode(tag);
    node.attachShadow = (options) => { assert.equal(options.mode, "closed"); const root = new FakeNode("shadow"); roots.push(root); return root; };
    return node;
  } };
  const win = { innerWidth: 1000, innerHeight: 800, navigator: {}, setTimeout: (fn) => { timers.set(++nextTimer, fn); return nextTimer; }, clearTimeout: (id) => timers.delete(id) };
  const overlay = overlayModule.create({ document: doc, window: win, clipboard: { copy: async (value) => { copies.push(value); return copyResults.shift() ?? true; } } });
  const all = () => roots.flatMap(walk), find = (className) => all().filter((node) => node.className === className);
  const show = (candidates = matcher.match(index, "项目描述")) => overlay.show({ text: "项目描述", rect: { top: 600, bottom: 620, left: 300, right: 380, width: 80 }, candidates, templateName: "模板 A", search: (query) => matcher.search(index, query) });
  return { overlay, copies, timers, body, find, all, show, win };
}

test("candidate overlay keeps its snapshot open after copy, preserves full text, and allows another copy", async () => {
  const h = overlayHarness(); h.show();
  assert.equal(h.find("candidate").length, 2);
  await h.find("candidate")[0].emit("click");
  assert.deepEqual(h.copies, [description]); assert.equal(h.overlay.isOpen(), true);
  assert.equal(h.find("copy-status")[0].textContent, "已复制");
  await h.find("candidate")[1].emit("click");
  assert.equal(h.copies[1], "项目 B 的完整描述"); assert.equal(h.overlay.isOpen(), true);
  await h.find("expand")[0].emit("click");
  assert.ok(h.all().some((node) => node.className === "preview expanded" && node.textContent === description));
  h.show(matcher.match(index, "就读年月"));
  assert.equal(h.find("candidate").length, 4);
  await h.find("candidate")[0].emit("click"); assert.equal(h.copies.at(-1), "2023-09");
  h.overlay.hide(); assert.equal(h.overlay.isOpen(), false); assert.equal(h.body.children.length, 0);
});

test("copy failure displays retry state and the same candidate can be retried", async () => {
  const h = overlayHarness([false, true]); h.show();
  const button = h.find("candidate")[0];
  await button.emit("click"); assert.equal(h.find("copy-status")[0].textContent, "复制失败，点击重试");
  assert.equal(button.disabled, false); assert.equal(h.overlay.isOpen(), true);
  await button.emit("click"); assert.equal(h.find("copy-status")[0].textContent, "已复制");
  assert.deepEqual(h.copies, [description, description]);
});

test("no-match overlay provides manual search and does not render resume text as HTML", async () => {
  const h = overlayHarness(); h.show([]);
  assert.equal(h.find("empty")[0].textContent, "未找到相关内容");
  await h.find("search-toggle")[0].emit("click");
  const input = h.find("search")[0]; assert.equal(input.hidden, false);
  input.value = "项目 B"; await input.emit("input");
  assert.ok(h.find("candidate").length > 0);
  h.show([{ id: "unsafe", sourceName: "<img onerror=bad()>", preview: "<script>bad()</script>", copyValue: "<script>bad()</script>", format: "字段" }]);
  assert.equal(h.find("source")[0].textContent, "<img onerror=bad()> · 字段");
  assert.equal(h.all().some((node) => ["SCRIPT", "IMG"].includes(node.tagName)), false);
});

test("positioning prefers above the selection and clamps top/bottom/side viewport edges", () => {
  assert.deepEqual(overlayModule.position({ left: 300, right: 380, top: 600, bottom: 620 }, { width: 380, height: 300 }, { width: 1000, height: 800 }), { left: 150, top: 292, width: 380 });
  const top = overlayModule.position({ left: 0, right: 20, top: 4, bottom: 24 }, { width: 380, height: 300 }, { width: 320, height: 400 });
  assert.equal(top.left, 8); assert.equal(top.top, 32); assert.equal(top.width, 304);
  const tiny = overlayModule.position({ left: 900, right: 990, top: 10, bottom: 40 }, { width: 380, height: 440 }, { width: 500, height: 200 });
  assert.equal(tiny.left, 112); assert.equal(tiny.top, 8);
});

function signal() {
  const listeners = new Set();
  return { addListener: (fn) => listeners.add(fn), removeListener: (fn) => listeners.delete(fn),
    emit: (...args) => Promise.all([...listeners].map((fn) => fn(...args))), listeners };
}
function listenerHarness(initialEnabled = true) {
  const doc = new FakeNode("document"), win = new FakeNode("window"), onChanged = signal();
  let selected = "", collapsed = false, section = "", dataReads = 0;
  const data = { resumeTemplates: { a: { id: "a", name: "模板 A", profile } }, activeResumeTemplateId: "a" };
  const getData = { current: async () => data };
  const storage = { onChanged, local: { get: async (keys) => {
    if (keys === listenerModule.SETTINGS_KEY) return { [keys]: initialEnabled };
    dataReads++; return getData.current();
  } } };
  const range = { startContainer: { isConnected: true, parentElement: { closest: (selector) => selector.startsWith("fieldset") ? { querySelector: () => ({ textContent: section }) } : null } },
    cloneRange() { return this; }, getBoundingClientRect: () => ({ top: 200, bottom: 220, left: 400, right: 480, width: 80, height: 20 }) };
  doc.getSelection = () => ({ isCollapsed: collapsed, rangeCount: 1, toString: () => selected, getRangeAt: () => range });
  const shown = [], moved = [], view = { open: false, show(args) { this.open = true; shown.push(args); }, hide() { this.open = false; },
    containsEvent: (event) => event.inOverlay === true, reposition: (rect) => moved.push(rect), isOpen() { return this.open; }, destroy() {} };
  const controller = listenerModule.create({ window: win, document: doc, storage, matcher, schema, clipboard,
    overlayFactory: () => view });
  async function select(text, context = "") {
    await doc.emit("mousedown", { button: 0, clientX: 0, clientY: 0 });
    selected = text; section = context;
    await doc.emit("mouseup", { button: 0, clientX: 100, clientY: 0 });
  }
  return { controller, doc, win, storage, shown, moved, view, select, getData, dataReads: () => dataReads,
    setSelected: (value) => { selected = value; }, setCollapsed: (value) => { collapsed = value; } };
}

test("selection updates candidates; overlay interactions retain selection snapshot; outside click and Esc close it", async () => {
  const h = listenerHarness(); await h.controller.ready;
  await h.select("就读年月"); assert.equal(h.shown.at(-1).candidates.length, 4);
  h.setSelected("");
  await h.doc.emit("mousedown", { button: 0, inOverlay: true });
  await h.doc.emit("mouseup", { button: 0, inOverlay: true });
  assert.equal(h.view.open, true); assert.equal(h.shown.at(-1).text, "就读年月");
  await h.select("项目描述"); assert.equal(h.shown.at(-1).candidates.length, 2);
  await h.win.emit("scroll"); assert.equal(h.moved.length, 1);
  await h.doc.emit("keydown", { key: "Escape" }); assert.equal(h.view.open, false);
  await h.select("开始时间", "教育经历"); assert.equal(h.shown.at(-1).candidates.length, 2);
  await h.doc.emit("mousedown", { button: 0, clientX: 50, clientY: 50 }); assert.equal(h.view.open, false);
  h.controller.dispose();
  assert.equal(h.storage.onChanged.listeners.size, 0);
});

test("default-off lookup does not read resume data; enabling/disabling is live and invalidates in-flight results", async () => {
  const h = listenerHarness(false); await h.controller.ready;
  await h.select("就读年月"); assert.equal(h.dataReads(), 0); assert.equal(h.view.open, false);
  await h.storage.onChanged.emit({ [listenerModule.SETTINGS_KEY]: { newValue: true } }, "local");
  await h.select("就读年月"); assert.equal(h.shown.length, 1);
  let resolve;
  h.getData.current = () => new Promise((done) => { resolve = done; });
  const pending = h.select("项目描述"); await new Promise((done) => setImmediate(done));
  await h.storage.onChanged.emit({ [listenerModule.SETTINGS_KEY]: { newValue: false } }, "local");
  resolve({}); await pending;
  assert.equal(h.view.open, false); assert.equal(h.shown.length, 1);
});

test("late old selection results cannot replace the newest selection, and template changes close stale candidates", async () => {
  const h = listenerHarness(); await h.controller.ready;
  let release;
  h.getData.current = () => new Promise((resolve) => { release = resolve; });
  const first = h.select("就读年月"); await new Promise((done) => setImmediate(done));
  h.getData.current = async () => ({ resumeTemplates: { a: { profile } }, activeResumeTemplateId: "a" });
  await h.select("项目描述");
  release({ resumeTemplates: { a: { profile } }, activeResumeTemplateId: "a" }); await first;
  assert.equal(h.shown.length, 1); assert.equal(h.shown[0].text, "项目描述");
  await h.storage.onChanged.emit({ activeResumeTemplateId: { newValue: "b" } }, "local");
  assert.equal(h.view.open, false);
});

test("webpage-generated synthetic selection gestures do not read resume data", async () => {
  const h = listenerHarness(); await h.controller.ready;
  await h.doc.emit("mousedown", { button: 0, clientX: 0, clientY: 0, isTrusted: false });
  h.setSelected("自我评价");
  await h.doc.emit("mouseup", { button: 0, clientX: 100, clientY: 0, isTrusted: false });
  assert.equal(h.dataReads(), 0); assert.equal(h.view.open, false);
});

test("registered script bundle boots idempotently alongside the original content-script globals", async () => {
  const roots = [], storageChanges = signal(), doc = new FakeNode("document"), win = new FakeNode("window");
  doc.body = new FakeNode("body"); doc.body.isConnected = true;
  doc.createElement = (tag) => {
    const node = new FakeNode(tag); node.attachShadow = () => { const shadow = new FakeNode("shadow"); roots.push(shadow); return shadow; }; return node;
  };
  const context = { document: doc, console, navigator: {}, __AI_RESUME_AUTOFILL_LOADED__: true,
    addEventListener: win.addEventListener.bind(win), removeEventListener: win.removeEventListener.bind(win),
    chrome: { storage: { onChanged: storageChanges, local: { get: async () => ({}) } } } };
  context.window = context; vm.createContext(context);
  for (const file of registration.FILES) vm.runInContext(fs.readFileSync(path.join(__dirname, "..", file), "utf8"), context);
  const controller = context.__RESUME_LOOKUP_CONTROLLER__; await controller.ready;
  assert.equal(controller.isEnabled(), false); assert.equal(doc.children.length, 0);
  assert.equal(storageChanges.listeners.size, 1);
  for (const file of registration.FILES) vm.runInContext(fs.readFileSync(path.join(__dirname, "..", file), "utf8"), context);
  assert.equal(context.__RESUME_LOOKUP_CONTROLLER__, controller);
  assert.equal(storageChanges.listeners.size, 1); assert.equal(roots.length, 1);
  assert.equal(context.__AI_RESUME_AUTOFILL_LOADED__, true);
  controller.dispose();
});

test("registration is opt-in, persists for future pages, handles current tabs, and unregisters on disable", async () => {
  const onChanged = signal(), onMessage = signal(), onInstalled = signal(), onStartup = signal();
  const values = {}, registered = [], injections = [];
  const chrome = { storage: { onChanged, local: {
    get: async (key) => ({ [key]: values[key] }),
    set: async (update) => { Object.assign(values, update); for (const [key, value] of Object.entries(update)) onChanged.emit({ [key]: { newValue: value } }, "local"); },
  } }, runtime: { id: "extension", onMessage, onInstalled, onStartup }, tabs: { query: async () => [{ id: 1, url: "https://example.test" }, { id: 2, url: "chrome://extensions" }] },
    scripting: { getRegisteredContentScripts: async () => registered.slice(), registerContentScripts: async (items) => registered.push(...items),
      unregisterContentScripts: async () => { registered.length = 0; }, executeScript: async (args) => injections.push(args) } };
  const manager = registration.install(chrome); await manager.sync(false);
  assert.equal(registered.length, 0); assert.equal(injections.length, 0);
  const request = (enabled) => new Promise((resolve) => [...onMessage.listeners][0]({ action: "setSelectionLookupEnabled", enabled }, { id: "extension" }, resolve));
  assert.equal((await request(true)).success, true);
  assert.equal(registered.length, 1); assert.equal(registered[0].persistAcrossSessions, true);
  assert.deepEqual(registered[0].js, registration.FILES);
  assert.ok(injections.length > 0); assert.ok(injections.every((args) => args.target.tabId === 1));
  assert.equal((await request(false)).enabled, false); assert.equal(registered.length, 0);
  assert.equal(registration.SETTINGS_KEY, listenerModule.SETTINGS_KEY);
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "../manifest.json"), "utf8"));
  assert.ok(manifest.permissions.includes("clipboardWrite"));
  assert.equal("content_scripts" in manifest, false);
});

test("failed registration rolls back the opt-in setting and reports failure to the settings UI", async () => {
  const onChanged = signal(), onMessage = signal(), onInstalled = signal();
  const values = {};
  const chrome = { storage: { onChanged, local: { get: async (key) => ({ [key]: values[key] }), set: async (update) => Object.assign(values, update) } },
    runtime: { id: "extension", onMessage, onInstalled },
    scripting: { getRegisteredContentScripts: async () => [], registerContentScripts: async () => { throw new Error("permission denied"); } } };
  const manager = registration.install(chrome); await manager.sync(false);
  const response = await new Promise((resolve) => [...onMessage.listeners][0]({ action: "setSelectionLookupEnabled", enabled: true }, { id: "extension" }, resolve));
  assert.equal(response.success, false); assert.equal(values[registration.SETTINGS_KEY], false);
});

test("settings checkbox defaults off, persists an explicit opt-in, and recovers after a failed change", async () => {
  const toggle = new FakeNode("input"), status = new FakeNode("p"), changes = signal();
  let response = { success: true, enabled: true }, state = false;
  const requests = [];
  const context = { window: { ResumeLookupRegistration: registration }, document: { getElementById: (id) => id === "selectionLookupEnabled" ? toggle : status },
    chrome: { storage: { onChanged: changes, local: { get: async (key) => ({ [key]: state }) } }, runtime: { sendMessage: async (request) => { requests.push(request); if (response.success) state = response.enabled; return response; } } } };
  vm.createContext(context);
  const source = fs.readFileSync(path.join(__dirname, "../popup.js"), "utf8");
  vm.runInContext(source.slice(source.indexOf("async function initSelectionLookupSetting()")), context);
  await context.initSelectionLookupSetting(); assert.equal(toggle.checked, false);
  toggle.checked = true; await toggle.emit("change");
  assert.equal(toggle.checked, true); assert.equal(requests[0].enabled, true);
  response = { success: false, error: "test failure" }; toggle.checked = false;
  await toggle.emit("change"); assert.equal(toggle.checked, true); assert.equal(status.textContent, "test failure");
});
