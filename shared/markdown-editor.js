(function (root) {
  "use strict";
  function create({ onChange = () => {}, onConvert, onLog = () => {}, getFallbackMarkdown = () => "" }) {
    const storage = root.ResumeMarkdownStorage;
    const byId = (id) => document.getElementById(id);
    const input = byId("markdownEditor");
    const drafts = new Map();
    let activeId = null, dirty = false, busy = false, loading = false, generation = 0, pendingReload = false;
    const status = (message) => { byId("markdownStatus").textContent = message; };
    function refresh() {
      input.disabled = busy || loading || !activeId;
      for (const id of ["saveMarkdownBtn", "reloadMarkdownBtn", "importMarkdownBtn", "exportMarkdownBtn", "convertMarkdownBtn"]) {
        byId(id).disabled = busy || loading || !activeId;
      }
      status(loading ? "正在加载…" : `${input.value.length} 字符 · ${dirty ? "尚未保存" : "已保存"}`);
      onChange();
    }
    async function load(id, force = false) {
      if (!force && activeId === id) return;
      if (activeId && dirty) drafts.set(activeId, input.value);
      activeId = id;
      input.value = ""; dirty = false;
      const token = ++generation;
      loading = true; refresh();
      try {
        const saved = storage.loadDocument ? await storage.loadDocument(id) : { exists: true, markdown: await storage.load(id) };
        if (token !== generation) return;
        const draft = force ? undefined : drafts.get(id);
        const fallback = saved.exists ? "" : String(getFallbackMarkdown(id) || "");
        input.value = draft ?? (saved.exists ? saved.markdown : fallback);
        dirty = draft !== undefined || Boolean(fallback);
        if (force) drafts.delete(id);
      } catch (error) {
        if (token === generation) { activeId = null; input.value = ""; dirty = false; }
        throw error;
      } finally { if (token === generation) { loading = false; refresh(); } }
    }
    async function save() {
      const id = activeId, snapshot = input.value;
      await storage.save(id, snapshot);
      if (activeId === id && input.value === snapshot) { dirty = false; drafts.delete(id); }
      refresh();
    }
    function finishBusy() {
      busy = false; refresh();
      if (!pendingReload) return;
      pendingReload = false;
      if (dirty) status("其他窗口修改了 Markdown；请保存或重新加载后核对。");
      else load(activeId, true).catch((error) => onLog("error", error.message));
    }
    function bind(id, fn, event = "click") {
      byId(id).addEventListener(event, async (ev) => {
        if (busy || loading) return;
        busy = true; refresh();
        try { await fn(ev); }
        catch (error) { onLog("error", error.message); status(error.message); }
        finally { finishBusy(); }
      });
    }
    function download(content) {
      const url = URL.createObjectURL(new Blob([content], { type: "text/markdown;charset=utf-8" }));
      const anchor = document.createElement("a"); anchor.href = url; anchor.download = "简历资料.md"; anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    input.addEventListener("input", () => { dirty = true; refresh(); });
    bind("saveMarkdownBtn", save);
    bind("reloadMarkdownBtn", async () => {
      if (dirty && !root.confirm("重新加载会放弃当前未保存的 Markdown 修改，继续吗？")) return;
      await load(activeId, true);
    });
    bind("exportMarkdownBtn", () => download(input.value));
    bind("importMarkdownBtn", () => { byId("importMarkdownFile").value = ""; byId("importMarkdownFile").click(); });
    bind("importMarkdownFile", async (event) => {
      const file = event.target.files?.[0]; if (!file) return;
      const id = activeId, text = (await file.text()).replace(/^\uFEFF/, "");
      if (id !== activeId) throw new Error("模板已切换，请重新导入");
      if (input.value && !root.confirm("导入将替换当前 Markdown 编辑内容，保存后生效，继续吗？")) return;
      input.value = text; dirty = true;
    }, "change");
    bind("convertMarkdownBtn", async () => {
      if (!input.value.trim()) throw new Error("请先填写 Markdown 资料");
      const id = activeId;
      await onConvert(input.value, id);
    });
    root.addEventListener("beforeunload", (event) => {
      if (dirty || drafts.size) { event.preventDefault(); event.returnValue = ""; }
    });
    root.chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !changes[storage.KEY] || !activeId) return;
      if (busy) { pendingReload = true; return; }
      if (dirty) { status("其他窗口修改了 Markdown；请先保存或重新加载。"); return; }
      load(activeId, true).catch((error) => onLog("error", error.message));
    });
    refresh();
    return { load, save, getMarkdown: () => input.value, isBusy: () => busy || loading,
      setMarkdown(value) { input.value = String(value || ""); dirty = true; refresh(); },
      setBusy(value) {
        if (!value) finishBusy();
        else { busy = true; refresh(); }
      } };
  }
  root.ResumeMarkdownEditor = Object.freeze({ create });
})(window);
