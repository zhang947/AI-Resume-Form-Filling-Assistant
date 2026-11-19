(function (root) {
  "use strict";
  function create({ onLog = () => {}, onChange = () => {} } = {}) {
    const storage = root.ResumeStorage;
    const byId = (id) => document.getElementById(id);
    const input = byId("markdownEditor");
    const status = byId("documentStatus");
    let templates = [], activeId = null, dirty = false, busy = false, loading = false, mutating = false;
    let mode = "create", actionRunning = false, pendingReload = false;
    input.disabled = true;
    function log(type, message) {
      if (status) { status.textContent = message; status.dataset.type = type; }
      onLog(type, message);
    }
    function refresh() {
      const unavailable = busy || loading || actionRunning;
      for (const selector of [byId("resumeTemplateSelect"), byId("fillTemplateSelect")].filter(Boolean)) {
        selector.replaceChildren(...templates.map((item) => {
          const option = document.createElement("option"); option.value = item.id; option.textContent = item.name; return option;
        }));
        selector.value = activeId;
      }
      for (const id of ["resumeTemplateSelect", "fillTemplateSelect", "newTemplateBtn", "duplicateTemplateBtn", "renameTemplateBtn", "deleteTemplateBtn", "importTemplatesBtn", "importResumeJsonBtn", "uploadPdfBtn", "reloadResumeBtn", "insertOutlineBtn"]) {
        if (byId(id)) byId(id).disabled = unavailable;
      }
      input.disabled = unavailable;
      byId("saveResumeBtn").disabled = unavailable || !dirty;
      const summary = byId("resumeSummaryGrid");
      if (summary) summary.textContent = `${input.value.length} 字符${dirty ? " · 尚未保存" : " · 已保存"}。资料会在填写时发送至你配置的模型接口。`;
      onChange();
    }
    async function load() {
      if (loading) return;
      loading = true;
      try {
        const state = await storage.loadTemplateState();
        templates = state.templates; activeId = state.activeTemplateId;
        input.value = templates.find((item) => item.id === activeId)?.markdown || "";
        dirty = false; refresh();
        log("info", "Markdown 资料已加载；未记载的信息不会默认解释为“没有”。");
      } finally { loading = false; refresh(); }
    }
    async function save() {
      if (!dirty) return;
      const targetId = activeId, markdown = input.value;
      mutating = true;
      try {
        await storage.saveTemplateContent(targetId, { markdown });
        const target = templates.find((item) => item.id === targetId);
        if (target) target.markdown = markdown;
        if (activeId === targetId && input.value === markdown) dirty = false;
        refresh(); log("success", dirty ? "已保存快照，仍有新的未保存修改" : "Markdown 资料已保存");
      } finally { mutating = false; }
    }
    function action(fn) {
      return async (event) => {
        if (busy || loading || actionRunning) return;
        actionRunning = true;
        input.disabled = true;
        onChange();
        try { await fn(event); } catch (error) { log("error", error.message || String(error)); }
        finally {
          actionRunning = false; refresh();
          if (pendingReload && !dirty && !busy) {
            pendingReload = false;
            try { await load(); } catch (error) { log("error", error.message); }
          }
        }
      };
    }
    function bind(id, fn, event = "click") { byId(id)?.addEventListener(event, action(fn)); }
    async function mutation(fn) {
      mutating = true;
      try { await fn(); await load(); } finally { mutating = false; }
    }
    function download(content, name, type) {
      const url = URL.createObjectURL(new Blob([content], { type }));
      const anchor = document.createElement("a"); anchor.href = url; anchor.download = name.replace(/[\\/:*?"<>|]/g, "_");
      anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    input.addEventListener("input", () => { dirty = true; refresh(); });
    bind("saveResumeBtn", save);
    bind("reloadResumeBtn", async () => { if (!dirty || root.confirm("重新加载将放弃未保存的修改，继续吗？")) await load(); });
    for (const id of ["resumeTemplateSelect", "fillTemplateSelect"]) bind(id, async (event) => {
      const nextId = event.target.value;
      try { await save(); await mutation(() => storage.setActiveTemplateId(nextId)); }
      finally { refresh(); }
    }, "change");
    function openName(nextMode) {
      mode = nextMode;
      byId("templateNameInput").value = mode === "rename" ? templates.find((item) => item.id === activeId)?.name || "" : "";
      byId("templateNameModalTitle").textContent = mode === "rename" ? "重命名资料" : "新建资料";
      byId("templateNameStatus").textContent = "";
      byId("templateNameModal").classList.add("open"); byId("templateNameInput").focus();
    }
    bind("newTemplateBtn", () => openName("create"));
    bind("renameTemplateBtn", () => openName("rename"));
    for (const id of ["closeTemplateNameBtn", "closeTemplateNameBackdrop"]) bind(id, () => byId("templateNameModal").classList.remove("open"));
    async function saveName() {
      const name = byId("templateNameInput").value.trim();
      if (!name) { byId("templateNameStatus").textContent = "名称不能为空"; return; }
      await save();
      await mutation(async () => {
        if (mode === "rename") await storage.renameTemplate(activeId, name);
        else { const item = await storage.createTemplate(name); await storage.setActiveTemplateId(item.id); }
      });
      byId("templateNameModal").classList.remove("open");
    }
    bind("saveTemplateNameBtn", saveName);
    bind("templateNameInput", async (event) => { if (event.key === "Enter") { event.preventDefault(); await saveName(); } }, "keydown");
    bind("duplicateTemplateBtn", async () => { await save(); await mutation(async () => {
      const item = await storage.duplicateTemplate(activeId); await storage.setActiveTemplateId(item.id);
    }); });
    bind("deleteTemplateBtn", async () => {
      if (!root.confirm("删除当前资料及其未保存修改，继续吗？")) return;
      await mutation(() => storage.deleteTemplate(activeId));
    });
    bind("exportTemplatesBtn", async () => {
      await save(); download(JSON.stringify(await storage.exportTemplateData(), null, 2), "资料备份.json", "application/json");
    });
    bind("exportMigrationBackupBtn", async () => {
      download(JSON.stringify(await storage.exportMigrationBackup(), null, 2), "迁移前原始资料备份.json", "application/json");
    });
    bind("exportResumeJsonBtn", async () => {
      await save(); download(input.value, `${templates.find((item) => item.id === activeId)?.name || "资料"}.md`, "text/markdown;charset=utf-8");
    });
    bind("importTemplatesBtn", () => { byId("importTemplatesFile").value = ""; byId("importTemplatesFile").click(); });
    bind("importTemplatesFile", async (event) => {
      const file = event.target.files?.[0]; if (!file) return;
      const data = JSON.parse(await file.text());
      if (!root.confirm("导入将替换全部资料；插件会备份当前已保存的资料。继续吗？")) return;
      await save(); await mutation(() => storage.importTemplateData(data));
    }, "change");
    bind("importResumeJsonBtn", () => { byId("importResumeJsonFile").value = ""; byId("importResumeJsonFile").click(); });
    bind("importResumeJsonFile", async (event) => {
      const file = event.target.files?.[0]; if (!file) return;
      const text = (await file.text()).replace(/^\uFEFF/, "");
      let markdown = text;
      if (/\.json$/i.test(file.name)) {
        const data = JSON.parse(text); const source = data.template || data;
        if (typeof source.markdown !== "string" && !source.profile) throw new Error("JSON 缺少 Markdown 或旧简历 profile");
        markdown = typeof source.markdown === "string" ? source.markdown : storage.profileToMarkdown(source.profile, source.rawText || "");
      }
      if (input.value.trim() && !root.confirm("导入将替换编辑区内容，保存后生效。继续吗？")) return;
      input.value = markdown; dirty = true; refresh(); log("info", "资料已导入编辑区，请检查并保存");
    }, "change");
    bind("insertOutlineBtn", () => {
      const outline = "# 个人资料\n\n## 基本信息\n\n## 教育经历\n\n## 工作与实习\n\n## 项目经历\n\n## 技能与证书\n\n## 求职偏好\n\n## 其他信息\n";
      input.value += `${input.value ? "\n\n" : ""}${outline}`; dirty = true; refresh();
    });
    bind("uploadPdfBtn", () => { byId("resumePdfFile").value = ""; byId("resumePdfFile").click(); });
    bind("resumePdfFile", async (event) => {
      const file = event.target.files?.[0]; if (!file) return;
      const targetId = activeId;
      busy = true; refresh(); log("info", "正在提取 PDF 文字…");
      try {
        const library = root.pdfjsLib;
        if (!library?.getDocument) throw new Error("PDF 模块未加载");
        library.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("libs/pdfjs/pdf.worker.min.js");
        const pdf = await library.getDocument({ data: await file.arrayBuffer() }).promise;
        let text = "";
        try {
          for (let page = 1; page <= pdf.numPages; page++) {
            const content = await (await pdf.getPage(page)).getTextContent();
            text += content.items.map((item) => item.str + (item.hasEOL ? "\n" : " ")).join("") + "\n\n";
          }
        } finally { await pdf.destroy(); }
        if (!text.trim()) throw new Error("未提取到文字，扫描版 PDF 请先 OCR");
        if (activeId !== targetId) throw new Error("资料已切换，请重新导入");
        input.value += `${input.value ? "\n\n" : ""}## 导入的 PDF 原文\n\n${text.trim()}`;
        dirty = true; log("success", "PDF 原文已追加，请检查并保存");
      } finally { busy = false; refresh(); }
    }, "change");
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || (!changes[storage.keys.templates] && !changes[storage.keys.activeTemplateId])) return;
      if (loading || mutating) return;
      if (busy || actionRunning) { pendingReload = true; return; }
      if (dirty) { log("warning", "其他窗口修改了资料；此处有未保存内容，请核对后保存或重新加载。"); return; }
      load().catch((error) => log("error", error.message));
    });
    root.addEventListener("beforeunload", (event) => { if (dirty) { event.preventDefault(); event.returnValue = ""; } });
    return { ready: load(), save, reload: load, getMarkdown: () => input.value, getActiveId: () => activeId,
      isBusy: () => busy || loading || actionRunning,
      setBusy(value) {
        busy = value; refresh();
        if (!busy && pendingReload && !dirty) { pendingReload = false; load().catch((error) => log("error", error.message)); }
      } };
  }
  root.ResumeDocumentEditor = Object.freeze({ create });
})(window);
