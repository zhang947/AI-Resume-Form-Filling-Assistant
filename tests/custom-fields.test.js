const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { loadSchema, profileFor, plain } = require("./library-fixture.cjs");
const editorModule = require("../shared/custom-fields-editor.js");
const importer = require("../shared/library-import.js");
const aliasTools = require("../shared/alias-enrichment.js");
const matcher = require("../shared/selection-lookup-matcher.js");
const schema = loadSchema();
const source = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8").replace(/\r\n/g, "\n");
const longValue = "第一段：已确认经历。\n\n第二段：保留完整换行。\n" + "实际内容".repeat(90) + "\n";
const info = () => profileFor([{ name: "应聘理由", aliases: ["求职动机"], type: "textarea", value: longValue }], { group: "银行求职", item: "某银行" });
function extract(text, start, next) {
  const from = text.indexOf(start), until = text.indexOf(next, from + start.length);
  assert.ok(from >= 0 && until > from, start); return text.slice(from, until);
}
function contentHelpers() {
  const content = source("content.js");
  const context = { window: {}, schema, URL, location: { origin: "https://example.test", host: "example.test", pathname: "/form", href: "https://example.test/form" }, document: { title: "Form" } };
  vm.createContext(context);
  vm.runInContext(extract(content, "function buildFieldMappingPayload(fields, resumeProfile) {", "function normalizeTransform(transform) {") +
    extract(content, "function normalizeTransform(transform) {", "function deriveFillValue(rawValue, transform, runtime) {") +
    extract(content, "function createMappingCacheSignature(fields) {", "async function loadMappingCacheEntry(cacheKey, meta = {})"), context);
  return context;
}
test("AI mapping receives dynamic group/item/field names and aliases; only actual saved value paths are accepted", () => {
  const helpers = contentHelpers(), profile = info(), fields = [{ fieldId: "f", kind: "textarea", label: "求职动机" }];
  const payload = helpers.buildFieldMappingPayload(fields, profile), field = payload.resumeFields[0];
  assert.equal(field.label, "应聘理由"); assert.equal(field.itemLabel, "某银行"); assert.equal(field.sectionLabel, "银行求职");
  assert.deepEqual(plain(field.aliases), ["求职动机"]);
  assert.equal(helpers.normalizeMappings([{ fieldId: "f", resumePath: field.path }], fields, profile)[0].resumePath, field.path);
  for (const invalid of [field.path.replace(/value$/, "name"), "personal.email", "groups.__proto__.items.i-x.fields.f-x.value", field.path.replace("f-import-0-0-0", "f-missing")]) {
    assert.equal(helpers.normalizeMappings([{ fieldId: "f", resumePath: invalid }], fields, profile)[0].resumePath, "");
  }
});
test("editing any library metadata/content or changing order invalidates the mapping cache", () => {
  const helpers = contentHelpers(), fields = [{ kind: "textarea", label: "应聘理由" }], profile = info();
  const baseline = helpers.createMappingCacheKey(fields, profile);
  for (const property of ["name", "aliases", "value", "type", "role"]) {
    const edited = plain(profile), field = edited.groups[0].items[0].fields[0];
    field[property] = property === "aliases" ? ["新别名"] : property === "type" ? "text" : property === "role" ? "start" : "changed";
    assert.notEqual(helpers.createMappingCacheKey(fields, edited), baseline);
  }
  const edited = plain(profile); edited.groups[0].name = "能源"; assert.notEqual(helpers.createMappingCacheKey(fields, edited), baseline);
});
class Node {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.attrs = {}; this.listeners = new Map(); this.value = ""; }
  appendChild(node) { this.children.push(node); node.parentNode = this; return node; }
  append(...nodes) { nodes.forEach((node) => this.appendChild(node)); }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((node) => node !== this); }
  setAttribute(key, value) { this.attrs[key] = value; }
  addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(fn); }
  async emit(type) { for (const fn of this.listeners.get(type) || []) await fn({ target: this }); }
  scrollIntoView() {}
}
const walk = (node) => [node, ...node.children.flatMap(walk)];
test("alias preview lets users deselect proposals, cancel without writes and retry a failed save without executing field text", async () => {
  const profile = info(), field = schema.getFieldCatalog({ profile })[0];
  const plan = aliasTools.prepare(schema, profile, [{ path: field.path, aliases: ['另一种字段叫法', '<img onerror=bad()>'] }]);
  const host = new Node('div'), document = { createElement: (tag) => new Node(tag), createTextNode: (text) => Object.assign(new Node('span'), { textContent: text }) };
  let writes = 0, fail = true;
  const panel = aliasTools.preview({ document, host, plan, onApply: async (selected) => { if (fail) throw new Error('save failed'); writes++; assert.equal(selected.length, 1); } });
  const checkbox = walk(panel).find((n) => n.tagName === 'INPUT'), save = walk(panel).find((n) => n.textContent === '保存所选别名');
  assert.equal(walk(panel).some((n) => n.tagName === 'IMG'), false);
  checkbox.checked = false; await checkbox.emit('change'); assert.equal(save.disabled, true);
  checkbox.checked = true; await checkbox.emit('change'); await save.emit('click'); assert.equal(save.disabled, false); assert.equal(writes, 0);
  fail = false; await save.emit('click'); assert.equal(writes, 1); assert.equal(host.children.length, 0);
  const cancelled = aliasTools.preview({ document, host, plan, onApply: async () => writes++ });
  await walk(cancelled).find((n) => n.textContent === '取消').emit('click'); assert.equal(writes, 1); assert.equal(host.children.length, 0);
});
function editorHarness() {
  const host = new Node("div"), nav = new Node("aside"), document = { createElement: (tag) => new Node(tag) };
  let changes = 0;
  const editor = editorModule.create({ document, host, nav, schema, onChange: () => changes++ });
  const namedControl = (label) => walk(host).filter((node) => node.tagName === "LABEL").find((node) => node.children[0].textContent === label)?.children[1];
  return { host, nav, editor, namedControl, changes: () => changes };
}
test("empty editor can manually build groups, items and fields, preserve newlines and reopen saved data", async () => {
  const h = editorHarness(); h.editor.render([]);
  const gid = h.editor.addGroup(); assert.match(h.editor.validate(), /分组名称/);
  const set = async (label, value, event = "input") => { const c = h.namedControl(label); c.value = value; await c.emit(event); };
  await set("分组名称", "自主资料"); const iid = h.editor.addItem(gid);
  await set("条目名称", "某条经历"); h.editor.addField(gid, iid);
  await set("字段名称", "完整描述"); await set("匹配别名（逗号或换行分隔）", "项目内容，项目描述");
  await set("内容类型", "textarea", "change"); await set("内容", longValue);
  assert.equal(h.editor.validate(), ""); assert.ok(h.changes() >= 8);
  const saved = plain(h.editor.collect()); const next = editorHarness(); next.editor.render(saved); next.editor.selectGroup(saved[0].id);
  assert.deepEqual(plain(next.editor.collect()), saved); assert.equal(next.namedControl("内容").value, longValue);
});
test("rename/reorder/duplicate/delete/undo at each level keep stable IDs and independent copies", () => {
  const h = editorHarness(); h.editor.render(info().groups);
  const g = h.editor.collect()[0], i = g.items[0], f = i.fields[0];
  h.editor.mutate("duplicate", f.id, g.id, i.id); let fields = h.editor.collect()[0].items[0].fields;
  assert.equal(fields.length, 2); assert.notEqual(fields[0].id, fields[1].id); assert.equal(fields[1].value, longValue);
  h.editor.mutate("move", f.id, g.id, i.id, 1); assert.equal(h.editor.collect()[0].items[0].fields[1].id, f.id);
  h.editor.mutate("remove", f.id, g.id, i.id); h.editor.undo(); assert.equal(h.editor.collect()[0].items[0].fields[1].id, f.id);
  h.editor.mutate("duplicate", i.id, g.id); assert.notEqual(h.editor.collect()[0].items[0].fields[0].id, h.editor.collect()[0].items[1].fields[0].id);
  h.editor.mutate("duplicate", g.id); assert.notEqual(h.editor.collect()[0].items[0].id, h.editor.collect()[1].items[0].id);
  h.editor.mutate("remove", g.id); h.editor.undo(); assert.equal(h.editor.collect()[0].id, g.id);
});
test("names, aliases and values render as text with no HTML execution", () => {
  const h = editorHarness(), profile = profileFor([{ name: "<img onerror=bad()>", aliases: ["<script>bad()</script>"], value: "<script>bad()</script>\n原文", type: "textarea" }]);
  h.editor.render(profile.groups); h.editor.selectGroup(profile.groups[0].id);
  assert.equal(walk(h.host).some((node) => ["IMG", "SCRIPT"].includes(node.tagName)), false);
  assert.equal(h.namedControl("内容").value, "<script>bad()</script>\n原文");
});
test("groups start collapsed and selecting a nav entry lazily shows only that group's information", async () => {
  const h = editorHarness(), a = info().groups[0], b = profileFor([{ name: "第二字段", value: "第二组正文" }], { group: "第二组" }).groups[0];
  b.id = "g-second"; h.editor.render([a, b]);
  assert.equal(walk(h.host).filter((n) => n.className === "library-group-toggle").length, 2);
  assert.equal(h.namedControl("内容"), undefined);
  assert.ok(walk(h.host).filter((n) => n.className === "library-group-body").every((n) => n.hidden));
  await h.nav.children[0].emit("click"); assert.equal(h.namedControl("内容").value, longValue);
  const value = h.namedControl("内容"); value.value = "未保存的新内容\n完整保留"; await value.emit("input");
  await h.nav.children[1].emit("click"); assert.equal(h.namedControl("内容").value, "第二组正文");
  assert.equal(walk(h.host).filter((n) => n.className === "library-group-body" && !n.hidden).length, 1);
  await h.nav.children[0].emit("click"); assert.equal(h.namedControl("内容").value, "未保存的新内容\n完整保留");
  assert.equal(h.nav.children[0].attrs["aria-expanded"], "true");
  const toggle = walk(h.host).find((n) => n.className === "library-group-toggle");
  await toggle.emit("click"); assert.equal(h.namedControl("内容"), undefined);
  assert.equal(h.nav.children[0].attrs["aria-expanded"], "false");
});
test("an invalid field in a collapsed group is automatically revealed for correction", () => {
  const h = editorHarness(), profile = info(); profile.groups[0].items[0].fields[0].name = "";
  h.editor.render(profile.groups); assert.equal(h.namedControl("字段名称"), undefined);
  assert.match(h.editor.validate(), /名称/); assert.ok(h.namedControl("字段名称"));
  assert.equal(h.nav.children[0].attrs["aria-expanded"], "true");
});
function extracted(value, extra = {}) {
  return { groups: [{ name: "银行求职", items: [{ name: "某银行", fields: [{ name: "应聘理由", type: "textarea", value, evidence: value, ...extra }] }] }] };
}
test("AI parses arbitrary nontraditional content into dynamic fields while preserving full source text", () => {
  const plan = importer.prepare(schema, { groups: [] }, extracted(longValue), "# 资料\n" + longValue);
  const profile = importer.apply(schema, plan);
  assert.equal(schema.getCatalogWithValues(profile)[0].value, longValue); assert.equal(plan.changes.length, 1);
  assert.equal(matcher.match(matcher.buildIndex(profile, schema), "应聘理由")[0].copyValue, longValue);
});
test("time aliases work in freely named groups, sort each pair start/end, and never mix start with end", () => {
  const profile = profileFor([
    { name: "时间二", type: "date", role: "end", aliases: ["就读年月", "开始时间"], value: "至今" },
    { name: "时间一", type: "date", role: "start", aliases: ["就读年月", "入学时间"], value: "2023-09" },
  ], { group: "自主命名的分组", item: "自主命名的经历" });
  const index = matcher.buildIndex(profile, schema);
  assert.deepEqual(matcher.match(index, "就读年月").map((v) => v.copyValue), ["2023-09", "至今"]);
  assert.deepEqual(matcher.match(index, "开始时间").map((v) => v.copyValue), ["2023-09"]);
  assert.deepEqual(matcher.match(index, "入学时间").map((v) => v.copyValue), ["2023-09"]);
  assert.deepEqual(matcher.match(index, "结束时间").map((v) => v.copyValue), ["至今"]);
});
test("duplicates are ignored and conflicts preserve saved manual values unless explicitly selected", () => {
  const before = info();
  const duplicate = importer.prepare(schema, before, extracted(longValue), longValue);
  assert.equal(duplicate.duplicates, 1); assert.equal(duplicate.changes.length, 0);
  const conflict = importer.prepare(schema, before, extracted("新的原文值"), "新的原文值");
  assert.equal(conflict.conflicts.length, 1); assert.equal(conflict.changes.length, 0);
  assert.equal(schema.getCatalogWithValues(importer.apply(schema, conflict))[0].value, longValue);
  assert.equal(schema.getCatalogWithValues(importer.apply(schema, conflict, conflict.conflicts))[0].value, "新的原文值");
  assert.equal(schema.getFieldCatalog({ profile: importer.apply(schema, conflict, conflict.conflicts) })[0].path, schema.getFieldCatalog({ profile: before })[0].path);
});
test("invented facts, missing evidence, malformed responses and invalid dates are rejected before saving", () => {
  assert.throws(() => importer.prepare(schema, {}, {}, "原文"), /groups/);
  assert.throws(() => importer.prepare(schema, {}, extracted("原文", { evidence: "" }), "原文"), /原文/);
  assert.throws(() => importer.prepare(schema, {}, extracted("编造事实", { evidence: "原文" }), "原文"), /原文不符/);
  assert.throws(() => importer.prepare(schema, {}, extracted("2099-99", { type: "date" }), "2099-99"), /有效日期/);
});
test("AI date reformatting preserves precision and keeps 至今 literal, never inventing a month or day", () => {
  for (const [evidence, value] of [["2027/7", "2027-07"], ["2027", "2027"], ["至今", "至今"]]) {
    const plan = importer.prepare(schema, {}, extracted(value, { type: "date", evidence, role: "end" }), evidence);
    assert.equal(schema.getCatalogWithValues(importer.apply(schema, plan))[0].value, value);
  }
  assert.throws(() => importer.prepare(schema, {}, extracted("2027-01-01", { type: "date", evidence: "2027" }), "2027"), /原文不符/);
});
test("preview defaults conflict checkboxes off, preserves all text, and leaves a failed save retryable", async () => {
  const plan = importer.prepare(schema, info(), extracted("冲突原文"), "冲突原文"), host = new Node("div");
  const document = { createElement: (tag) => new Node(tag), createTextNode: (text) => Object.assign(new Node("span"), { textContent: text }) };
  let selected, fail = true;
  const panel = importer.preview({ document, host, plan, onApply: async (items) => { if (fail) throw new Error("资料已修改"); selected = items; } });
  const checkbox = walk(panel).find((n) => n.tagName === "INPUT"), save = walk(panel).find((n) => n.textContent === "保存所选信息");
  assert.equal(checkbox.checked, false); assert.ok(walk(panel).some((n) => n.textContent === `原值：${longValue}`));
  await save.emit("click"); assert.equal(save.disabled, false); assert.ok(host.children.includes(panel));
  checkbox.checked = true; fail = false; await save.emit("click"); assert.equal(selected.length, 1); assert.equal(host.children.length, 0);
});
for (const file of ["popup.js", "resume-editor.js"]) {
  test(`${file} saves only dynamic data and blocks invalid manual edits`, async () => {
    const writes = [], profile = info(), text = source(file);
    const context = { schema, resumeProfile: profile, customFieldsEditor: { collect: () => profile.groups, validate: () => "" },
      activeTemplateId: "a", resumeStorage: { saveTemplateContent: async (id, value) => writes.push({ id, value }) },
      saveResumeBtn: {}, resumeImportTextEl: { value: "" }, isResumeDirty: true, document: {},
      updatePageStatus() {}, updateStartFillAvailability() {}, addLog() {} };
    vm.createContext(context);
    vm.runInContext(extract(text, "function collectResumeProfileFromForm() {", "function syncResumeProfileFromForm() {") +
      extract(text, "async function persistResumeProfile({ silent = false } = {}) {", 'saveResumeBtn.addEventListener("click"'), context);
    await context.persistResumeProfile({ silent: true }); assert.deepEqual(plain(writes[0].value.profile), profile);
    context.customFieldsEditor.validate = () => "名称缺失";
    assert.equal(await context.persistResumeProfile({ silent: true }), false); assert.equal(writes.length, 1);
  });
  test(`${file} AI extraction previews before saving and protects edits/template switches during the request or review`, async () => {
    const text = source(file), before = info(), logs = [], writes = [];
    let preview, aiCalls = 0;
    const state = { activeTemplateId: "a", templates: [{ id: "a", profile: before }] };
    const context = { schema, activeTemplateId: "a", isResumeDirty: false, isImporting: false, isClearingResume: false, isEnrichingAliases: false,
      importResumeBtn: {}, uploadPdfBtn: {}, resumeFormHost: { parentElement: {} }, document: {},
      resumeStorage: { loadTemplateState: async () => plain(state), saveTemplateContent: async (id, value) => writes.push({ id, value }) },
      getActiveModel: async () => ({ id: "model" }), isModelConfigured: () => true,
      resumePrompts: { buildResumeImportPrompt: (_schema, raw) => raw }, parseJsonFromAiText: JSON.parse,
      aiClient: { callAI: async () => { aiCalls++; return JSON.stringify(extracted("新内容")); } },
      window: { ResumeLibraryImport: { ...importer, preview: (args) => preview = args } },
      addLog: (...args) => logs.push(args), updatePageStatus: (...args) => logs.push(args), loadResumeProfile: async () => {} };
    vm.createContext(context); vm.runInContext(extract(text, "async function importResumeToSchema(rawText) {", "function limitTextForPrompt("), context);
    await context.importResumeToSchema("新内容"); assert.equal(aiCalls, 1); assert.equal(writes.length, 0); assert.equal(preview.plan.conflicts.length, 1);
    context.isResumeDirty = true; await assert.rejects(preview.onApply([]), /已修改/);
    context.isResumeDirty = false; state.activeTemplateId = "b"; await assert.rejects(preview.onApply([]), /已修改/);
    state.activeTemplateId = "a"; state.templates[0].profile.groups[0].name = "外部修改"; await assert.rejects(preview.onApply([]), /已修改/);
    state.templates[0].profile = plain(before); // before is independent from the returned storage snapshot.
    // Recreate the immutable original because the fixture was intentionally mutated.
    state.templates[0].profile = info();
    state.templates[0].updatedAt = "cleared-in-another-window";
    await assert.rejects(preview.onApply([]), /已修改/);
    delete state.templates[0].updatedAt;
    await preview.onApply(preview.plan.conflicts); assert.equal(writes.length, 1);
    assert.equal(schema.getCatalogWithValues(writes[0].value.profile)[0].value, "新内容");
  });
}
