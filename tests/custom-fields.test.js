const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const editorModule = require("../shared/custom-fields-editor.js");
const matcher = require("../shared/selection-lookup-matcher.js");
const source = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8").replace(/\r\n/g, "\n");
const plain = (value) => JSON.parse(JSON.stringify(value));
function loadSchema() { const context = { window: {} }; vm.runInNewContext(source("shared/resume-schema.js"), context); return context.window.ResumeSchema; }
const schema = loadSchema();
const longValue = "第一段：已确认的经历。\n\n第二段：保持换行。\n" + "完整内容".repeat(80) + "\n";
const customs = [
  { id: "cf-bank", name: "苏州银行应聘理由", group: "银行求职", aliases: ["应聘理由", "求职动机"], type: "textarea", value: longValue },
  { id: "cf-energy", name: "深圳燃气应聘理由", group: "能源求职", aliases: ["应聘理由"], type: "textarea", value: "保存的另一条应聘理由" },
  { id: "cf-date", name: "可到岗日期", group: "求职偏好", aliases: ["到岗时间"], type: "date", value: "2027-07" },
];

test("custom fields survive normalization and an old profile defaults to an empty custom library", () => {
  const normalized = schema.normalizeResumeProfile({ personal: { fullName: "Alice" }, customFields: customs });
  assert.equal(normalized.personal.fullName, "Alice");
  assert.deepEqual(plain(normalized.customFields), customs);
  assert.deepEqual(plain(schema.normalizeResumeProfile(normalized).customFields), customs);
  assert.deepEqual(plain(schema.normalizeResumeProfile({}).customFields), []);
  const metadataOnly = schema.normalizeResumeProfile({ customFields: [{ ...customs[0], value: "" }] });
  assert.equal(schema.hasAnyFilledField(metadataOnly), false);
});

test("custom IDs are stable through rename/reorder, and value paths cannot change metadata or create unknown fields", () => {
  const profile = schema.normalizeResumeProfile({ customFields: customs });
  const originalPath = "customFields.cf-bank.value";
  profile.customFields.reverse(); profile.customFields.find((field) => field.id === "cf-bank").name = "重命名后的信息";
  assert.equal(schema.getValueByPath(profile, originalPath), longValue);
  schema.setValueByPath(profile, originalPath, "编辑后的内容\n完整保存");
  assert.equal(profile.customFields.find((field) => field.id === "cf-bank").value, "编辑后的内容\n完整保存");
  schema.setValueByPath(profile, "customFields.cf-bank.name", "不能经填表路径改名");
  schema.setValueByPath(profile, "customFields.__proto__.value", "invalid");
  schema.setValueByPath(profile, "customFields.cf-missing.value", "invalid");
  assert.equal(profile.customFields.find((field) => field.id === "cf-bank").name, "重命名后的信息");
  assert.equal(profile.customFields.length, 3);
  assert.equal(schema.getValueByPath(profile, "customFields.__proto__.value"), "");
  profile.customFields = profile.customFields.filter((field) => field.id !== "cf-bank");
  assert.equal(schema.getValueByPath(profile, originalPath), "");
});

test("invalid or duplicate imported IDs are repaired deterministically without dropping content", () => {
  const fields = schema.normalizeCustomFields([{ ...customs[0], id: "__proto__" }, { ...customs[1], id: "cf-bank" }, { ...customs[2], id: "cf-bank" }]);
  assert.equal(new Set(fields.map((field) => field.id)).size, 3);
  assert.ok(fields.every((field) => /^cf-[a-z0-9-]+$/.test(field.id)));
  assert.deepEqual(plain(schema.normalizeCustomFields(fields)), plain(fields));
  assert.equal(fields[0].value, longValue);
  const aliases = schema.normalizeCustomFields([{ ...customs[0], aliases: " 应聘理由，求职动机\n应聘理由；个人优势 " }])[0].aliases;
  assert.deepEqual(plain(aliases), ["应聘理由", "求职动机", "个人优势"]);
});

test("custom field validation enforces a name, multiline type and one valid date without inventing precision", () => {
  assert.match(schema.validateCustomFields([{ ...customs[0], name: " " }]), /名称/);
  assert.match(schema.validateCustomFields([{ ...customs[0], type: "text" }]), /多行文本/);
  for (const value of ["2027", "2027/7", "2027-07-01", "至今"]) assert.equal(schema.validateCustomFields([{ ...customs[2], value }]), "");
  for (const value of ["2027-02-30", "2027-99", "2027-07 至 2028-07"]) assert.ok(schema.validateCustomFields([{ ...customs[2], value }]));
  assert.equal(schema.normalizeCustomFields([{ ...customs[2], value: "2027/7" }])[0].value, "2027-07");
});

test("selection lookup combines fixed fields and named custom aliases without overwriting same-keyword variants", () => {
  const profile = schema.normalizeResumeProfile({ personal: { summary: "固定字段简介" }, customFields: [...customs, { ...customs[0], id: "cf-self", name: "岗位自我评价", aliases: ["自我评价"], value: "保存的岗位自评" }, { ...customs[0], id: "cf-empty", name: "空内容", value: "" }] });
  const index = matcher.buildIndex(profile, schema);
  const found = matcher.match(index, "* 应聘理由：（必填）");
  assert.equal(found.length, 2);
  assert.deepEqual(found.map((item) => item.sourceName), ["银行求职 · 苏州银行应聘理由", "能源求职 · 深圳燃气应聘理由"]);
  assert.equal(found[0].copyValue, longValue); assert.ok(found[0].preview.length < longValue.length);
  assert.deepEqual(matcher.match(index, "自我评价").map((item) => item.copyValue), ["固定字段简介", "保存的岗位自评"]);
  assert.equal(matcher.match(index, "空内容").length, 0);
  assert.equal(matcher.search(index, "求职动机").length, 1); // aliases participate in manual search
  assert.equal(matcher.match(index, "到岗时间")[0].copyValue, "2027-07");
});

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

test("AI mapping receives custom names, groups, aliases and existing values, and only accepts actual custom paths", () => {
  const helpers = contentHelpers(), profile = schema.normalizeResumeProfile({ customFields: customs });
  const fields = [{ fieldId: "f", kind: "textarea", label: "求职动机" }];
  const payload = helpers.buildFieldMappingPayload(fields, profile);
  const field = payload.resumeFields.find((item) => item.path === "customFields.cf-bank.value");
  assert.equal(field.label, "苏州银行应聘理由"); assert.equal(field.itemLabel, "银行求职");
  assert.deepEqual(plain(field.aliases), ["应聘理由", "求职动机"]); assert.equal(field.hasValue, true);
  const mapped = helpers.normalizeMappings([{ fieldId: "f", resumePath: field.path }], fields, profile);
  assert.equal(mapped[0].resumePath, field.path); assert.equal(schema.getValueByPath(profile, mapped[0].resumePath), longValue);
  for (const invalid of ["customFields.cf-bank.name", "customFields.cf-missing.value", "customFields.__proto__.value"]) {
    assert.equal(helpers.normalizeMappings([{ fieldId: "f", resumePath: invalid }], fields, profile)[0].resumePath, "");
  }
});

test("custom edits invalidate the actual mapping cache key while profiles without custom fields retain the original key", () => {
  const helpers = contentHelpers(), fields = [{ kind: "textarea", label: "应聘理由" }];
  const profile = schema.normalizeResumeProfile({ customFields: customs });
  const baseline = helpers.createMappingCacheKey(fields, profile);
  for (const property of ["name", "group", "aliases", "value", "type"]) {
    const edited = plain(profile); edited.customFields[0][property] = property === "aliases" ? ["新别名"] : property === "type" ? "text" : "changed";
    assert.notEqual(helpers.createMappingCacheKey(fields, edited), baseline);
  }
  const moved = plain(profile); moved.customFields.reverse(); assert.notEqual(helpers.createMappingCacheKey(fields, moved), baseline);
  const removed = plain(profile); removed.customFields.pop(); assert.notEqual(helpers.createMappingCacheKey(fields, removed), baseline);
  assert.equal(helpers.createMappingCacheKey(fields, schema.createEmptyResumeProfile()), helpers.createMappingCacheKey(fields));
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
  focus() { this.focused = true; }
  scrollIntoView() {}
}
const walk = (node) => [node, ...node.children.flatMap(walk)];
function editorHarness() {
  const host = new Node("div"), nav = new Node("aside"), document = { createElement: (tag) => new Node(tag) };
  let changes = 0;
  const editor = editorModule.create({ document, host, nav, schema, onChange: () => changes++ });
  const control = (id, property) => walk(host).find((node) => node.dataset.customFieldId === id)?.children.flatMap(walk).find((node) => node.dataset.customProperty === property);
  return { host, nav, editor, control, changes: () => changes };
}

test("editor adds and edits custom information, preserves line breaks, validates names and restores saved state", async () => {
  const h = editorHarness(); h.editor.render([]);
  await walk(h.host).find((node) => node.textContent === "新增信息").emit("click");
  const id = h.editor.collect()[0].id;
  assert.match(h.editor.validate(), /名称/);
  for (const [property, value] of [["name", "自定义信息"], ["group", "银行求职"], ["aliases", "应聘理由\n求职动机"]]) {
    h.control(id, property).value = value; await h.control(id, property).emit("input");
  }
  h.control(id, "type").value = "textarea"; await h.control(id, "type").emit("change");
  h.control(id, "value").value = longValue; await h.control(id, "value").emit("input");
  assert.equal(h.editor.validate(), ""); assert.ok(h.changes() >= 5);
  const saved = schema.normalizeResumeProfile({ customFields: h.editor.collect() });
  const reopened = editorHarness(); reopened.editor.render(saved.customFields);
  assert.deepEqual(plain(reopened.editor.collect()), plain(saved.customFields));
  assert.equal(reopened.control(id, "value").value, longValue);
});

test("editor rename/reorder/copy/delete/undo keep stable IDs and do not modify unrelated data", async () => {
  const h = editorHarness(); h.editor.render(customs);
  h.control("cf-bank", "name").value = "重命名"; await h.control("cf-bank", "name").emit("input");
  h.editor.move("cf-bank", 1); assert.equal(h.editor.collect()[1].id, "cf-bank");
  const copyId = h.editor.duplicate("cf-bank"); assert.notEqual(copyId, "cf-bank");
  assert.equal(h.editor.collect().find((field) => field.id === copyId).value, longValue);
  h.editor.remove("cf-bank"); assert.equal(h.editor.collect().some((field) => field.id === "cf-bank"), false);
  h.editor.undo(); assert.equal(h.editor.collect().find((field) => field.id === "cf-bank").name, "重命名");
  assert.equal(h.editor.collect().find((field) => field.id === "cf-energy").value, customs[1].value);
  assert.equal(customs[0].name, "苏州银行应聘理由");
  assert.equal(walk(h.nav).filter((node) => node.dataset.resumeNav === "customFields").length, 1);
});

test("custom names, aliases, groups and values are rendered as text rather than executable HTML", () => {
  const h = editorHarness();
  h.editor.render([{ ...customs[0], name: "<img onerror=bad()>", group: "<script>bad()</script>", aliases: ["</textarea><script>bad()</script>"], value: "<script>bad()</script>\n保留原文" }]);
  assert.equal(walk(h.host).some((node) => ["IMG", "SCRIPT"].includes(node.tagName)), false);
  assert.equal(h.editor.collect()[0].value, "<script>bad()</script>\n保留原文");
});

function memoryStorage(initial = {}) {
  const state = structuredClone(initial), writes = [];
  function area() { return {
    get: async (keys) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((key) => Object.hasOwn(state, key)).map((key) => [key, structuredClone(state[key])])),
    set: async (update) => { writes.push(update); Object.assign(state, structuredClone(update)); },
    remove: async (keys) => { keys.forEach((key) => delete state[key]); },
  }; }
  return { state, writes, local: area() };
}
function loadStorage() { const context = { window: {}, console }; vm.runInNewContext(source("shared/resume-storage.js"), context); return context.window.ResumeStorage; }

test("templates clone custom data independently and both JSON formats round-trip it; old JSON remains importable", async () => {
  const storage = loadStorage(), memory = memoryStorage(), initial = await storage.loadTemplateState(memory);
  const profile = schema.normalizeResumeProfile({ personal: { fullName: "Alice" }, customFields: customs });
  await storage.saveTemplateContent(initial.activeTemplateId, { profile }, memory);
  const copy = await storage.duplicateTemplate(initial.activeTemplateId, memory);
  const edited = plain(copy.profile); edited.customFields[0].value = "副本中的修改";
  await storage.saveTemplateContent(copy.id, { profile: edited }, memory);
  assert.equal(memory.state.resumeTemplates[initial.activeTemplateId].profile.customFields[0].value, longValue);
  const single = JSON.parse(JSON.stringify(await storage.exportActiveTemplateData(memory)));
  await storage.setActiveTemplateId(copy.id, memory); await storage.importActiveTemplateData(single, memory);
  assert.deepEqual(memory.state.resumeTemplates[copy.id].profile.customFields, customs);
  const backup = JSON.parse(JSON.stringify(await storage.exportTemplateData(memory)));
  const restored = memoryStorage(); await storage.importTemplateData(backup, restored);
  const state = await storage.loadTemplateState(restored);
  assert.ok(state.templates.every((template) => JSON.stringify(schema.normalizeResumeProfile(template.profile).customFields) === JSON.stringify(customs)));
  await storage.importActiveTemplateData({ profile: { personal: { fullName: "Legacy" } } }, restored);
  const legacy = await storage.exportActiveTemplateData(restored);
  assert.equal(schema.normalizeResumeProfile(legacy.profile).personal.fullName, "Legacy");
  assert.deepEqual(plain(schema.normalizeResumeProfile(legacy.profile).customFields), []);
});

for (const file of ["popup.js", "resume-editor.js"]) {
  test(`${file} saves custom fields with fixed fields and blocks invalid custom data`, async () => {
    const writes = [], context = { schema, resumeProfile: schema.normalizeResumeProfile({ customFields: customs }),
      customFieldsEditor: { collect: () => customs, validate: () => "" },
      resumeFormHost: { querySelectorAll: () => [{ dataset: { resumePath: "personal.fullName" }, value: "Alice" }] },
      activeTemplateId: "a", resumeStorage: { saveTemplateContent: async (id, value) => writes.push({ id, value }) },
      saveResumeBtn: {}, resumeImportTextEl: { value: "" }, isResumeDirty: true, document: {},
      updatePageStatus() {}, updateStartFillAvailability() {}, addLog() {},
    };
    vm.createContext(context);
    const text = source(file);
    vm.runInContext(extract(text, "function collectResumeProfileFromForm() {", "function syncResumeProfileFromForm() {") +
      extract(text, "async function persistResumeProfile({ silent = false } = {}) {", 'saveResumeBtn.addEventListener("click"'), context);
    await context.persistResumeProfile({ silent: true });
    assert.equal(writes[0].value.profile.personal.fullName, "Alice");
    assert.deepEqual(plain(writes[0].value.profile.customFields), customs);
    context.customFieldsEditor.validate = () => "名称缺失";
    assert.equal(await context.persistResumeProfile({ silent: true }), false); assert.equal(writes.length, 1);
    let exported = false;
    context.isResumeDirty = true;
    context.resumeStorage.exportTemplateData = async () => { exported = true; };
    vm.runInContext(extract(text, "async function handleExportTemplates() {", "async function handleImportTemplates() {"), context);
    await context.handleExportTemplates(); assert.equal(exported, false);
    let switched = false, restoredSelectors = false;
    context.resumeStorage.setActiveTemplateId = async () => { switched = true; };
    context.renderTemplateSelectors = () => { restoredSelectors = true; };
    vm.runInContext(extract(text, "async function switchActiveTemplate(id) {", "function openTemplateNameModal(mode) {"), context);
    await context.switchActiveTemplate("b");
    assert.equal(switched, false); assert.equal(restoredSelectors, true); assert.equal(context.activeTemplateId, "a");
  });

  test(`${file} AI resume imports preserve manually maintained custom data and reject invented custom fields`, async () => {
    const writes = [], messages = [], draft = plain(customs);
    const context = { schema, isImporting: false, isResumeDirty: false, activeTemplateId: "a", resumeProfile: schema.normalizeResumeProfile({ customFields: customs }),
      customFieldsEditor: { collect: () => draft }, getActiveModel: async () => ({ id: "model" }), isModelConfigured: () => true,
      aiClient: { callAI: async () => { draft[0].value = "等待期间手动编辑的内容"; return JSON.stringify({ personal: { fullName: "Imported" }, customFields: [{ ...customs[0], id: "cf-invented", value: "AI invented" }] }); } },
      resumePrompts: { buildResumeImportPrompt: () => "prompt" }, limitTextForPrompt: (text) => text, parseJsonFromAiText: JSON.parse,
      resumeStorage: { saveTemplateContent: async (id, data) => writes.push({ id, data }) },
      importResumeBtn: {}, uploadPdfBtn: {}, saveResumeBtn: {}, resetCollapsedResumeSections() {}, renderResumeEditor() {}, updateStartFillAvailability() {}, openModal() {},
      updatePageStatus: (...args) => messages.push(args), updateStatus: (...args) => messages.push(args), addLog: (...args) => messages.push(args),
    };
    vm.createContext(context);
    vm.runInContext(extract(source(file), "async function importResumeToSchema(rawText) {", "function limitTextForPrompt(text) {"), context);
    await context.importResumeToSchema("原始简历");
    assert.equal(writes.length, 1, JSON.stringify(messages));
    assert.equal(writes[0].data.profile.personal.fullName, "Imported");
    assert.deepEqual(plain(writes[0].data.profile.customFields), draft);
    context.aiClient.callAI = async () => { context.activeTemplateId = "b"; return '{"personal":{"fullName":"Wrong template"}}'; };
    await context.importResumeToSchema("另一次导入");
    assert.equal(writes.length, 1); assert.ok(messages.some((message) => String(message[1]).includes("模板已切换")));
  });
}

test("Markdown-to-fields preview keeps existing custom information and does not accept AI-created custom entries", async () => {
  const before = schema.normalizeResumeProfile({ personal: { fullName: "Before" }, customFields: customs });
  const context = { schema, isResumeDirty: false, activeTemplateId: "a", markdownConversion: null,
    getActiveModel: async () => ({ id: "model" }), isModelConfigured: () => true,
    resumeStorage: { loadTemplateState: async () => ({ templates: [{ id: "a", profile: before }] }) },
    aiClient: { callAI: async () => JSON.stringify({ personal: { fullName: "Imported" }, customFields: [{ ...customs[0], id: "cf-ai", value: "AI invented" }] }) },
    resumePrompts: { buildResumeImportPrompt: () => "prompt" }, parseJsonFromAiText: JSON.parse,
    document: { getElementById: () => ({}) }, addLog() {}, openModal() {},
  };
  const text = source("popup.js"), from = text.indexOf("async onConvert(markdown, id) {"), until = text.indexOf("\n    },\n  });", from);
  assert.ok(from >= 0 && until > from);
  vm.createContext(context);
  const convert = vm.runInContext(`({${text.slice(from, until)}\n}}).onConvert`, context);
  await convert("Markdown 资料", "a");
  assert.deepEqual(plain(context.markdownConversion.profile.customFields), customs);
  assert.deepEqual(plain(before.customFields), customs);
});
