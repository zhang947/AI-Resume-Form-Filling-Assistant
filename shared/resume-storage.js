(function initResumeStorage(root) {
  "use strict";
  const keys = Object.freeze({ templates: "resumeDocumentsV1", activeTemplateId: "activeResumeDocumentId",
    migrationBackup: "resumeMarkdownMigrationBackupV1", profile: "resumeProfile", rawText: "resumeImportRawText" });
  const DEFAULT_TEMPLATE_ID = "tpl-default";
  const legacyKeys = ["resumeTemplates", "activeResumeTemplateId", "resumeProfile", "resumeSchemaVersion", "resumeImportRawText", "resumeStructured", "resumeRawText"];
  const now = () => new Date().toISOString();
  const own = (v, k) => Object.prototype.hasOwnProperty.call(v || {}, k);
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const makeId = () => `tpl-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const hasValue = (v) => v != null && (typeof v === "object" ? Object.values(v).some(hasValue) : String(v).trim() !== "");
  function getStorage(override) {
    const storage = override || root.chrome?.storage;
    if (!storage?.local?.get || !storage?.local?.set) throw new Error("扩展本地存储不可用");
    return storage;
  }
  // Only migration uses schema labels; unknown keys and unlimited list items survive.
  function profileToMarkdown(profile, rawText = "") {
    const sections = root.ResumeSchema?.sections || [];
    function render(value, definition, depth = 0) {
      if (value == null || value === "") return [];
      if (Array.isArray(value)) return value.flatMap((item, index) => {
        const lines = render(item, definition, depth + 1);
        return lines.length ? [`${"  ".repeat(depth)}- 第 ${index + 1} 项`, ...lines] : [];
      });
      if (typeof value === "object") return Object.entries(value).flatMap(([key, item]) => {
        const field = definition?.fields?.find((entry) => entry.key === key);
        if (item == null || item === "") return [];
        if (typeof item === "object") {
          const lines = render(item, field, depth + 1);
          return lines.length ? [`${"  ".repeat(depth)}- ${field?.label || key}：`, ...lines] : [];
        }
        return [`${"  ".repeat(depth)}- ${field?.label || key}：${String(item)}`];
      });
      return [`${"  ".repeat(depth)}- ${String(value)}`];
    }
    const parts = [];
    for (const [key, value] of Object.entries(profile || {})) {
      const section = sections.find((entry) => entry.key === key);
      const lines = render(value, section);
      if (lines.length) parts.push(`## ${section?.label || key}\n\n${lines.join("\n")}`);
    }
    if (String(rawText).trim()) parts.push(`## 历史原始简历（待核对）\n\n以下保留导入原文，可能与上方后来修改的信息冲突；冲突内容请核对，不能自动采用。\n\n${rawText}`);
    return parts.join("\n\n");
  }
  function normalizeTemplate(value, fallbackId) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    if (typeof value.markdown !== "string" && typeof value.rawText !== "string" &&
      (!value.profile || typeof value.profile !== "object" || Array.isArray(value.profile))) return null;
    return { id: String(value.id || fallbackId || makeId()), name: String(value.name || "默认资料").trim() || "默认资料",
      markdown: typeof value.markdown === "string" ? value.markdown : profileToMarkdown(value.profile || {}, value.rawText || ""),
      createdAt: value.createdAt || now(), updatedAt: value.updatedAt || now() };
  }
  function normalizeTemplates(value) {
    if (!value || typeof value !== "object") return [];
    const entries = Array.isArray(value) ? value.map((item, index) => [String(index), item]) : Object.entries(value);
    const seen = new Set();
    return entries.map(([key, item]) => normalizeTemplate(item, key)).filter((item) => {
      if (!item || seen.has(item.id)) return false;
      seen.add(item.id); return true;
    });
  }
  async function persist(storage, templates, activeTemplateId) {
    const map = Object.create(null);
    for (const template of templates) map[template.id] = template;
    await storage.local.set({ [keys.templates]: map, [keys.activeTemplateId]: activeTemplateId });
  }
  async function loadTemplateState(override) {
    const storage = getStorage(override);
    const local = await storage.local.get([keys.templates, keys.activeTemplateId, keys.migrationBackup, ...legacyKeys]);
    let templates = normalizeTemplates(local[keys.templates]);
    let activeTemplateId = local[keys.activeTemplateId];
    let changed = !templates.length;
    if (!own(local, keys.templates)) {
      const sync = storage.sync?.get ? await storage.sync.get(legacyKeys) : {};
      const legacy = { ...sync, ...local };
      templates = normalizeTemplates(local.resumeTemplates);
      if (!templates.length) templates = normalizeTemplates(sync.resumeTemplates);
      if (!templates.length) {
        const meaningful = (v) => v && typeof v === "object" && hasValue(v);
        const profile = [local.resumeProfile, local.resumeStructured, sync.resumeProfile, sync.resumeStructured].find(meaningful) || {};
        templates = [normalizeTemplate({ id: DEFAULT_TEMPLATE_ID, profile,
          rawText: local.resumeImportRawText ?? local.resumeRawText ?? sync.resumeImportRawText ?? sync.resumeRawText ?? "" })];
      }
      activeTemplateId = legacy.activeResumeTemplateId;
      // Persist a recovery copy before committing or removing any legacy records.
      if (!own(local, keys.migrationBackup)) {
        const pick = (data) => Object.fromEntries(legacyKeys.filter((key) => own(data, key)).map((key) => [key, data[key]]));
        await storage.local.set({ [keys.migrationBackup]: { version: 1, createdAt: now(), local: pick(local), sync: pick(sync) } });
      }
      changed = true;
    }
    if (!templates.length) templates = [normalizeTemplate({ id: DEFAULT_TEMPLATE_ID, markdown: "" })];
    if (!templates.some((item) => item.id === activeTemplateId)) { activeTemplateId = templates[0].id; changed = true; }
    if (changed) await persist(storage, templates, activeTemplateId);
    for (const area of [storage.local, storage.sync]) {
      try { await area?.remove?.(legacyKeys); } catch (error) { console.warn("旧资料清理失败", error); }
    }
    return { templates, activeTemplateId };
  }
  async function saveTemplateContent(targetId, content, override) {
    const storage = getStorage(override);
    const state = await loadTemplateState(storage);
    const target = state.templates.find((item) => item.id === targetId);
    if (!target) throw new Error("资料不存在，请重新加载");
    if (typeof content?.markdown !== "string") throw new Error("资料必须是 Markdown 文本");
    target.markdown = content.markdown; target.updatedAt = now();
    await persist(storage, state.templates, state.activeTemplateId); return target;
  }
  async function createTemplate(name, override) {
    const storage = getStorage(override); const state = await loadTemplateState(storage);
    const template = normalizeTemplate({ id: makeId(), name: name || "新资料", markdown: "" });
    await persist(storage, [...state.templates, template], state.activeTemplateId); return template;
  }
  async function duplicateTemplate(targetId, override) {
    const storage = getStorage(override); const state = await loadTemplateState(storage);
    const source = state.templates.find((item) => item.id === targetId);
    if (!source) throw new Error("要复制的资料不存在");
    const template = normalizeTemplate({ id: makeId(), name: `${source.name} 副本`, markdown: source.markdown });
    await persist(storage, [...state.templates, template], state.activeTemplateId); return template;
  }
  async function renameTemplate(targetId, name, override) {
    if (!String(name).trim()) throw new Error("名称不能为空");
    const storage = getStorage(override); const state = await loadTemplateState(storage);
    const template = state.templates.find((item) => item.id === targetId);
    if (!template) throw new Error("资料不存在");
    template.name = String(name).trim(); template.updatedAt = now();
    await persist(storage, state.templates, state.activeTemplateId); return template;
  }
  async function deleteTemplate(targetId, override) {
    const storage = getStorage(override); const state = await loadTemplateState(storage);
    let templates = state.templates.filter((item) => item.id !== targetId);
    if (!templates.length) templates = [normalizeTemplate({ id: DEFAULT_TEMPLATE_ID, markdown: "" })];
    const active = templates.some((item) => item.id === state.activeTemplateId) ? state.activeTemplateId : templates[0].id;
    await persist(storage, templates, active); return active;
  }
  async function setActiveTemplateId(targetId, override) {
    const storage = getStorage(override); const state = await loadTemplateState(storage);
    if (!state.templates.some((item) => item.id === targetId)) throw new Error("资料不存在");
    await storage.local.set({ [keys.activeTemplateId]: targetId }); return targetId;
  }
  async function exportTemplateData(override) {
    return { app: "ai-resume-form-filling-assistant", kind: "resume-documents", version: 2,
      exportedAt: now(), ...await loadTemplateState(override) };
  }
  async function exportMigrationBackup(override) {
    const data = await getStorage(override).local.get([keys.migrationBackup]);
    const backup = data[keys.migrationBackup];
    if (!backup || (!Object.keys(backup.local || {}).length && !Object.keys(backup.sync || {}).length)) {
      throw new Error("没有需要导出的旧版资料备份");
    }
    const legacy = { ...(backup.sync || {}), ...(backup.local || {}) };
    const templates = [backup.local?.resumeTemplates, backup.sync?.resumeTemplates].find((value) => normalizeTemplates(value).length)
      || [{ id: DEFAULT_TEMPLATE_ID, name: "迁移前资料",
      profile: [backup.local?.resumeProfile, backup.local?.resumeStructured,
        backup.sync?.resumeProfile, backup.sync?.resumeStructured].find(hasValue) || {},
      rawText: legacy.resumeImportRawText ?? legacy.resumeRawText ?? "" }];
    return { ...clone(backup), kind: "resume-migration-backup", templates: clone(templates),
      activeTemplateId: legacy.activeResumeTemplateId || DEFAULT_TEMPLATE_ID };
  }
  async function importTemplateData(data, override) {
    if (!data?.templates || typeof data.templates !== "object") throw new Error("导入文件格式不正确：缺少 templates");
    const templates = normalizeTemplates(data.templates);
    if (!templates.length) throw new Error("导入文件中没有有效资料");
    const storage = getStorage(override); const previous = await loadTemplateState(storage);
    await storage.local.set({ resumeDocumentsImportBackupV1: clone(previous) });
    const activeTemplateId = templates.some((item) => item.id === data.activeTemplateId) ? data.activeTemplateId : templates[0].id;
    await persist(storage, templates, activeTemplateId); return { templates, activeTemplateId };
  }
  async function exportActiveTemplateData(override) {
    const state = await loadTemplateState(override);
    return clone(state.templates.find((item) => item.id === state.activeTemplateId));
  }
  async function importActiveTemplateData(data, override) {
    const source = data?.template || data;
    if (!source || (typeof source.markdown !== "string" && (!source.profile || typeof source.profile !== "object"))) throw new Error("导入文件缺少 Markdown 或旧版简历内容");
    const state = await loadTemplateState(override);
    return saveTemplateContent(state.activeTemplateId, { markdown: normalizeTemplate(source).markdown }, override);
  }
  // Web Locks serialize read-modify-write operations across the side panel and editor tabs.
  const locked = (fn) => (...args) => root.navigator?.locks?.request
    ? root.navigator.locks.request("resume-documents-v1", () => fn(...args)) : fn(...args);
  const operations = { loadTemplateState, saveTemplateContent, createTemplate, duplicateTemplate,
    renameTemplate, deleteTemplate, setActiveTemplateId, exportTemplateData, importTemplateData,
    exportActiveTemplateData, importActiveTemplateData, exportMigrationBackup };
  root.ResumeStorage = Object.freeze({ keys, DEFAULT_TEMPLATE_ID, profileToMarkdown,
    ...Object.fromEntries(Object.entries(operations).map(([name, fn]) => [name, locked(fn)])) });
})(typeof window !== "undefined" ? window : globalThis);
