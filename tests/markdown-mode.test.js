const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const plan = require("../shared/form-plan.js");
const markdownStorage = require("../shared/markdown-storage.js");
const runner = require("../shared/markdown-fill.js");
const controlModule = require("../shared/markdown-controls.js");

function loadStructuredStorage() {
  const context = { window: {}, console };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../shared/resume-storage.js"), "utf8"), context);
  return context.window.ResumeStorage;
}
function memoryStorage(data = {}) {
  const state = structuredClone(data), writes = [];
  return { state, writes, local: {
    async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((key) => key in state).map((key) => [key, structuredClone(state[key])])); },
    async set(values) { writes.push(structuredClone(values)); Object.assign(state, structuredClone(values)); },
    async remove(keys) { for (const key of keys) delete state[key]; },
  } };
}
function element(value = "") {
  const listeners = new Map();
  return { value, isConnected: true,
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    dispatchEvent(event) { for (const fn of listeners.get(event.type) || []) fn(event); },
    getAttribute() { return null; },
    userEdit(value) { this.value = value; this.dispatchEvent({ type: "input", isTrusted: true }); },
    listenerCount() { return [...listeners.values()].reduce((sum, set) => sum + set.size, 0); },
  };
}
const answer = (fieldId, value, evidence, source = "extracted") => ({ fieldId, value, source, evidence: [evidence], reason: "依据资料" });
function basicControls(events = []) {
  return { elements: (runtime) => [runtime.el], hasValue: (runtime) => Boolean(runtime?.el.value),
    async fill(runtime, value) { events.push(`fill:${runtime.fieldId}`); runtime.el.value = value; return { filled: true }; },
    verify: (runtime, value) => runtime.el.value === value };
}
function scan(fields, els = fields.map(() => element())) {
  return { fields, runtime: fields.map((field, index) => ({ ...field, el: els[index] })) };
}

test("default mode keeps the original profile schema, editor, JSON and selection entry points", () => {
  const html = fs.readFileSync(path.join(__dirname, "../popup.html"), "utf8");
  const popup = fs.readFileSync(path.join(__dirname, "../popup.js"), "utf8");
  assert.match(html, /value="fields" selected/);
  for (const id of ["startSelectionFillBtn", "importResumeJsonBtn", "exportResumeJsonBtn", "newTemplateBtn", "openResumeEditorBtn"]) assert.ok(html.includes(`id="${id}"`));
  assert.match(popup, /markdownMode \? \{ fillMethod: "markdown", markdown: markdownSnapshot \} : \{ resumeProfile \}/);
  assert.match(popup, /shared\/markdown-fill\.js/);
  const schema = fs.readFileSync(path.join(__dirname, "../shared/resume-schema.js"), "utf8");
  assert.match(schema, /createImportTemplateString/);
});

test("Markdown saves never modify structured templates or legacy data; field saves never modify Markdown", async () => {
  const structured = loadStructuredStorage();
  const storage = memoryStorage({ resumeTemplates: { a: { id: "a", name: "原简历", profile: { personal: { fullName: "Alice" } }, rawText: "原始文本" } }, activeResumeTemplateId: "a", resumeProfile: { retained: true } });
  const before = structuredClone(storage.state);
  assert.equal(await markdownStorage.load("a", storage), "");
  assert.deepEqual(storage.state, before); // No automatic conversion, cleanup or migration.
  await markdownStorage.save("a", "# Alice\nMarkdown 资料", storage);
  await markdownStorage.save("b", "# Bob", storage);
  for (const key of Object.keys(before)) assert.deepEqual(storage.state[key], before[key]);
  assert.ok(storage.writes.every((write) => Object.keys(write).join() === markdownStorage.KEY));
  await structured.saveTemplateContent("a", { profile: { personal: { fullName: "Updated" } } }, storage);
  assert.equal(await markdownStorage.load("a", storage), "# Alice\nMarkdown 资料");
  assert.equal(await markdownStorage.load("b", storage), "# Bob");
  const exported = await structured.exportActiveTemplateData(storage);
  assert.equal(exported.kind, "resume-profile");
  assert.equal(exported.profile.personal.fullName, "Updated");
  assert.equal("markdown" in exported, false);
});

test("the entire plan is requested and normalized before any dropdown search or fill", async () => {
  const events = [];
  const fields = [{ fieldId: "name", kind: "text", label: "Name" }, { fieldId: "school", kind: "combobox", label: "学校", dynamicOptions: true }];
  const controls = basicControls(events);
  controls.fill = async (runtime, value) => { events.push(runtime.kind === "combobox" ? "search" : "write"); runtime.el.value = value; return { filled: true }; };
  const result = await runner.run({ markdown: "Alice\n武汉大学", scan: scan(fields), controls,
    callAI: async (_id, payload, mode) => {
      assert.equal(mode, "field_values"); assert.equal(JSON.parse(payload).fields.length, 2);
      assert.deepEqual(events, []); events.push("plan");
      return JSON.stringify({ answers: [answer("name", "Alice", "Alice"), answer("school", "武汉大学", "武汉大学")] });
    } });
  assert.deepEqual(events, ["plan", "write", "search"]);
  assert.equal(result.filledCount, 2);
});

test("missing facts, intentions, fabricated evidence and generated factual answers remain missing", () => {
  const fields = [{ fieldId: "salary", label: "期望薪资", kind: "text" }, { fieldId: "intent", label: "是否接受调剂", kind: "radio_group", options: ["是", "否"] }, { fieldId: "name", label: "Name", kind: "text" }];
  const normalized = plan.normalizeAnswers([
    answer("salary", "20000", "硕士", "generated"),
    answer("intent", "是", "硕士"),
    answer("name", "Alice", "伪造原文"),
  ], fields, "硕士");
  assert.ok(normalized.every((item) => item.source === "missing" && item.value === null));
  assert.equal(plan.normalizeAnswers([], fields, "硕士").length, 3);
});

test("description generation uses evidence, rejects invented numbers, and respects page constraints", () => {
  const field = { fieldId: "bio", kind: "textarea", label: "自我评价", maxLength: 40 };
  assert.equal(plan.normalizeAnswers([answer("bio", "有基金运营经验，做事严谨。", "基金运营", "generated")], [field], "基金运营")[0].source, "generated");
  assert.equal(plan.normalizeAnswers([answer("bio", "负责100个项目", "基金运营", "generated")], [field], "基金运营")[0].source, "missing");
  assert.ok(plan.validateValue({ kind: "text", inputType: "date" }, "2024-02"));
  assert.ok(plan.validateValue({ kind: "text", inputType: "date" }, "2024-99-99"));
  assert.ok(plan.validateValue({ kind: "text", inputType: "date" }, "2023-02-29"));
  assert.equal(plan.validateValue({ kind: "text", inputType: "date" }, "2024-02-29"), "");
  assert.ok(plan.validateValue({ kind: "text", maxLength: 2 }, "Alice"));
  assert.ok(plan.validateValue({ kind: "text", pattern: "[0-9]{3}" }, "abc"));
  assert.throws(() => plan.buildPayload([], "x".repeat(100001)), /10 万/);
});

test("incremental fill protects initial values, AI-wait edits, and edits that are later cleared", async () => {
  const fields = ["existing", "edited", "cleared", "empty"].map((fieldId) => ({ fieldId, kind: "text", label: "Name" }));
  const els = [element("Original"), element(), element(), element()];
  const result = await runner.run({ markdown: "Alice", fillMode: "incremental", scan: scan(fields, els), controls: basicControls(),
    callAI: async () => {
      els[1].userEdit("Manual"); els[2].userEdit("Manual"); els[2].userEdit("");
      return JSON.stringify({ answers: fields.map((field) => answer(field.fieldId, "Alice", "Alice")) });
    } });
  assert.deepEqual(els.map((el) => el.value), ["Original", "Manual", "", "Alice"]);
  assert.deepEqual(result.report.map((item) => item.status), ["skipped", "skipped", "skipped", "filled"]);
  assert.ok(els.every((el) => el.listenerCount() === 0));
});

test("AI failures remove edit listeners and do not fill anything", async () => {
  const el = element(), controls = basicControls();
  await assert.rejects(runner.run({ markdown: "Alice", scan: scan([{ fieldId: "f", kind: "text" }], [el]), controls, callAI: async () => { throw new Error("offline"); } }), /offline/);
  assert.equal(el.value, ""); assert.equal(el.listenerCount(), 0);
});

function controlsWith(overrides = {}) {
  return controlModule.create({ hasExistingFieldValue: (runtime) => Boolean(runtime?.el.value),
    fillOne: async () => ({ filled: true }), setValueWithEvents: async (el, value) => { el.value = value; return true; },
    setNativeValue: (el, value) => { el.value = value; }, clickLikeUser: (el) => el.click?.(),
    safeCheck: async (el, checked) => { el.checked = checked; return true; }, isVisible: () => true,
    sleep: async () => {}, timeout: 320, ...overrides });
}
function nativeSelect() {
  const el = element(); let value = "";
  el.options = [];
  Object.defineProperty(el, "value", { get: () => value, set: (next) => { value = next; el.options.forEach((option) => { option.selected = option.value === next; }); } });
  return el;
}

test("native selects wait for asynchronous exact options and never choose a fuzzy sibling", async () => {
  const el = nativeSelect(), runtime = { kind: "select", el };
  el.options = [{ textContent: "武汉大学（其他）", value: "other" }];
  let polls = 0;
  const controls = controlsWith({ sleep: async () => { if (++polls === 2) el.options.push({ textContent: "武汉大学", value: "target" }); } });
  const result = await controls.fill(runtime, "武汉大学", { canWrite: () => true });
  assert.equal(result.filled, true); assert.equal(el.value, "target"); assert.ok(polls >= 2);
  assert.equal(controls.verify(runtime, "武汉大学"), true);
});

test("ambiguous candidates and reactive rejection are failures, not successful fills", async () => {
  const el = nativeSelect(), runtime = { kind: "select", el };
  el.options = [{ textContent: "武汉大学", value: "a" }, { textContent: "武汉大学", value: "b" }];
  const controls = controlsWith();
  assert.equal((await controls.fill(runtime, "武汉大学", { canWrite: () => true })).filled, false);
  assert.equal(el.value, "");
  el.options.pop(); el.addEventListener("change", () => { el.value = ""; });
  assert.equal((await controls.fill(runtime, "武汉大学", { canWrite: () => true })).filled, false);
});

test("combobox search uses the planned target and its associated list; user edits during candidate wait are protected", async () => {
  const el = element(), unrelated = { textContent: "武汉大学", click() { throw new Error("unrelated candidate clicked"); } };
  let options = [], clicked = 0, polls = 0;
  el.matches = () => true;
  el.getAttribute = (name) => name === "aria-controls" ? "school-list" : null;
  el.ownerDocument = { getElementById: (id) => id === "school-list" ? { querySelectorAll: () => options } : null, querySelectorAll: () => [unrelated] };
  const runtime = { kind: "combobox", el };
  const controls = controlsWith({ sleep: async () => {
    if (++polls === 2) options = [{ textContent: "武汉大学", getAttribute() { return null; }, click() { clicked++; el.value = "武汉大学"; } }];
  } });
  assert.equal((await controls.fill(runtime, "武汉大学", { canWrite: () => !controls.hasValue(runtime) })).filled, true);
  assert.equal(clicked, 1);

  el.value = ""; delete runtime.committedOption; options = []; polls = 0;
  const protectedControls = controlsWith({ sleep: async () => { polls++; el.userEdit("手动学校"); } });
  const result = await protectedControls.fill(runtime, "武汉大学", { canWrite: () => !protectedControls.hasValue(runtime) });
  assert.equal(result.skipped, true); assert.equal(el.value, "手动学校"); assert.equal(clicked, 1);
});

test("incremental runner also protects a cleared edit while asynchronous candidates load", async () => {
  const el = nativeSelect(), field = { fieldId: "school", kind: "select", label: "学校", dynamicOptions: true };
  let ticks = 0;
  const controls = controlsWith({ sleep: async () => {
    if (++ticks === 1) { el.userEdit("manual"); el.userEdit(""); }
    el.options.push({ textContent: "武汉大学", value: "target" });
  } });
  const result = await runner.run({ markdown: "武汉大学", fillMode: "incremental", scan: scan([field], [el]), controls,
    callAI: async () => JSON.stringify({ answers: [answer("school", "武汉大学", "武汉大学")] }) });
  assert.equal(result.report[0].status, "skipped"); assert.equal(el.value, "");
});

test("report counts only verified writes; omitted answers and missing facts never touch controls", async () => {
  let fills = 0;
  const controls = basicControls(); controls.fill = async () => { fills++; return { filled: true }; }; controls.verify = () => false;
  const result = await runner.run({ markdown: "Alice", scan: scan([{ fieldId: "a", kind: "text" }, { fieldId: "b", kind: "text" }]), controls,
    callAI: async () => JSON.stringify({ answers: [answer("a", "Alice", "Alice")] }) });
  assert.equal(fills, 1); assert.equal(result.filledCount, 0);
  assert.deepEqual(result.report.map((item) => item.status), ["failed", "missing"]);
});

test("final full-form verification catches a later control resetting an earlier answer", async () => {
  const els = [element(), element()];
  const controls = basicControls();
  controls.fill = async (runtime, value) => {
    runtime.el.value = value;
    if (runtime.fieldId === "b") els[0].value = "";
    return { filled: true };
  };
  const result = await runner.run({ markdown: "Alice", scan: scan(["a", "b"].map((fieldId) => ({ fieldId, kind: "text" })), els), controls,
    callAI: async () => JSON.stringify({ answers: [answer("a", "Alice", "Alice"), answer("b", "Alice", "Alice")] }) });
  assert.equal(result.filledCount, 1);
  assert.deepEqual(result.report.map((item) => item.status), ["failed", "filled"]);
});

function editorHarness() {
  const nodes = new Map(), downloads = [], errors = [], changes = [];
  function node(id) {
    if (nodes.has(id)) return nodes.get(id);
    const listeners = new Map();
    const el = { value: "", hidden: true, disabled: false, files: [],
      addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(fn); },
      async emit(type) { for (const fn of listeners.get(type) || []) await fn({ target: el }); },
      async click() { if (!el.disabled) await el.emit("click"); },
    };
    nodes.set(id, el); return el;
  }
  const data = { a: "# Alice", b: "# Bob" }, writes = [];
  const context = { console, Blob,
    document: { getElementById: node, createElement: () => ({ click() { downloads.push(this.download); } }) },
    URL: { createObjectURL: () => "blob:test", revokeObjectURL() {} }, setTimeout: (fn) => fn(),
    ResumeFormPlan: plan,
    ResumeMarkdownStorage: { KEY: "markdown", load: async (id) => data[id] || "", save: async (id, value) => { writes.push([id, value]); data[id] = value; } },
    chrome: { storage: { onChanged: { addListener: (fn) => changes.push(fn) } } },
    addEventListener() {}, confirm: () => true,
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../shared/markdown-editor.js"), "utf8"), context);
  return { context, node, data, writes, downloads, errors };
}

test("Markdown editor retains separate template drafts, imports and exports without touching saved data until Save", async () => {
  const harness = editorHarness(), { node, data, writes, downloads, context } = harness;
  const editor = context.ResumeMarkdownEditor.create({ onConvert: () => {}, onLog: (_type, message) => harness.errors.push(message) });
  await editor.load("a");
  node("markdownEditor").value = "A draft"; await node("markdownEditor").emit("input");
  await editor.load("b"); assert.equal(editor.getMarkdown(), "# Bob");
  await editor.load("a"); assert.equal(editor.getMarkdown(), "A draft");
  node("importMarkdownFile").files = [{ text: async () => "\uFEFF# Imported" }];
  await node("importMarkdownFile").emit("change");
  assert.equal(editor.getMarkdown(), "# Imported"); assert.equal(writes.length, 0);
  await node("exportMarkdownBtn").click(); assert.equal(downloads.length, 1); assert.equal(writes.length, 0);
  await node("saveMarkdownBtn").click(); assert.deepEqual(writes, [["a", "# Imported"]]);
  assert.equal(data.b, "# Bob"); assert.deepEqual(harness.errors, []);
});

test("Markdown-to-fields runs only on the conversion button and persists only after explicit preview confirmation", async () => {
  const harness = editorHarness(), { context, node, writes } = harness;
  let aiCalls = 0, fieldWrites = 0;
  const templates = [{ id: "a", profile: { personal: { fullName: "Before" } } }];
  Object.assign(context, {
    markdownEditor: null, markdownConversion: null, activeTemplateId: "a", isResumeDirty: false, isFilling: false,
    schema: { version: 1, normalizeResumeProfile: (value) => value },
    resumeStorage: {
      loadTemplateState: async () => ({ templates }),
      saveTemplateContent: async (id, content) => { fieldWrites++; assert.equal(id, "a"); templates[0].profile = content.profile; },
    },
    aiClient: { callAI: async (_id, _prompt, mode) => { aiCalls++; assert.equal(mode, "resume_import"); return '{"personal":{"fullName":"Alice"}}'; } },
    resumePrompts: { buildResumeImportPrompt: (_schema, markdown) => markdown },
    getActiveModel: async () => ({ id: "model" }), isModelConfigured: () => true,
    parseJsonFromAiText: JSON.parse, addLog: (_type, message) => { if (_type === "error") harness.errors.push(message); },
    updateStartFillAvailability() {}, openModal() {}, loadResumeProfile: async () => {},
  });
  node("fillMethod").value = "fields";
  const popup = fs.readFileSync(path.join(__dirname, "../popup.js"), "utf8");
  vm.runInContext(popup.slice(popup.indexOf("function getFillMethod()")), context);
  context.initMarkdownMode(); await context.markdownEditor.load("a");
  assert.equal(context.getFillMethod(), "fields"); assert.equal(aiCalls, 0); assert.equal(fieldWrites, 0);
  await node("convertMarkdownBtn").click();
  assert.equal(aiCalls, 1); assert.equal(fieldWrites, 0); assert.equal(writes.length, 0);
  assert.equal(node("markdownConversion").hidden, false);
  assert.match(node("markdownFieldsPreview").value, /Alice/);
  await node("applyMarkdownFieldsBtn").click();
  assert.equal(fieldWrites, 1); assert.equal(templates[0].profile.personal.fullName, "Alice");
  assert.equal(writes.length, 0); assert.deepEqual(harness.errors, []);

  await node("convertMarkdownBtn").click();
  templates[0].profile.personal.fullName = "Changed in another editor";
  await node("applyMarkdownFieldsBtn").click();
  assert.equal(fieldWrites, 1); assert.equal(harness.errors.length, 1);
});

test("the original AI gateway supports all existing modes alongside the Markdown plan", async () => {
  const requests = [];
  const context = { URL, AbortController, setTimeout, clearTimeout, console,
    chrome: { runtime: { onMessage: { addListener() {} }, onInstalled: { addListener() {} } }, action: { onClicked: { addListener() {} } } },
    fetch: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ choices: [{ message: { content: "{}" } }] }) };
    },
  };
  context.importScripts = () => {
    context.ResumeModelStorage = { getModelConfig: async () => ({ baseUrl: "https://example.test/v1", apiKey: "test-only", model: "test-model" }) };
    context.ResumeFormPlan = plan;
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../background.js"), "utf8"), context);
  for (const mode of ["resume_import", "field_mapping", "field_values"]) await context.callAI("test", "test prompt", mode);
  assert.equal(requests.length, 3);
  assert.ok(requests.every((request) => request.model === "test-model"));
  assert.match(requests[1].messages[0].content, /resumePath/);
  assert.equal(requests[2].messages[0].content, plan.SYSTEM_PROMPT);
});

test("Markdown expansion and candidate activation cannot click implicit submit buttons or navigation links", () => {
  const source = fs.readFileSync(path.join(__dirname, "../content.js"), "utf8");
  const start = source.indexOf("    const safeClick = (el) =>");
  const end = source.indexOf("    await triggerExpandableSections(null", start);
  const safeClick = vm.runInNewContext(`(() => { ${source.slice(start, end)}; return safeClick; })()`);
  const submit = { type: "submit" };
  assert.equal(safeClick({ closest: (selector) => selector.startsWith("button") ? submit : null }), false);
  assert.equal(safeClick({ closest: (selector) => selector.startsWith("button") ? { type: "button" } : null }), true);
  assert.equal(safeClick({ closest: (selector) => selector === "a[href]" ? { getAttribute: () => "/send-form" } : null }), false);
  assert.equal(safeClick({ closest: () => null }), true);
});
