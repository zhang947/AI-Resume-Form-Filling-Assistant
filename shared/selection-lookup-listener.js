(function (root, factory) {
  const api = factory(typeof module === "object" && module.exports ? require("./selection-lookup-ownership.js") : root.ResumeLookupOwnership);
  if (typeof module === "object" && module.exports) module.exports = api;
  root.ResumeLookupListener = api;
  if (root.document && root.chrome?.storage && root.ResumeLookupOverlay) {
    const current = root.__RESUME_LOOKUP_CONTROLLER__;
    if (current?.version === api.VERSION && current.isAlive()) return;
    try { current?.dispose?.(); } catch (_) { /* legacy invalidated storage listener */ }
    root.__RESUME_LOOKUP_CONTROLLER__ = api.create({ window: root, document: root.document, storage: root.chrome.storage,
      matcher: root.ResumeLookupMatcher, schema: root.ResumeSchema, overlayFactory: root.ResumeLookupOverlay.create,
      clipboard: root.ResumeLookupClipboard,
      isContextValid: () => { try { return Boolean(root.chrome.runtime?.id); } catch (_) { return false; } } });
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (ownership) {
  "use strict";
  const VERSION = "selection-lookup-library-candidates-v8";
  const SETTINGS_KEY = "resumeSelectionLookupEnabled";
  const DATA_KEYS = ["resumeLibraryVersion", "resumeTemplates", "activeResumeTemplateId"];
  async function readSnapshot(storage) {
    const data = await storage.local.get(DATA_KEYS);
    const templates = data.resumeLibraryVersion === 1 ? data.resumeTemplates : null;
    const activeId = data.activeResumeTemplateId;
    if (templates && typeof templates === "object") {
      const entries = Object.entries(templates).filter(([, item]) => item && typeof item === "object");
      const [, template] = entries.find(([key, item]) => key === activeId || item.id === activeId) || entries[0] || [];
      if (template) return { profile: template.profile || {}, templateName: template.name || "当前模板" };
      return { profile: {}, templateName: "当前模板" };
    }
    return { profile: { groups: [] }, templateName: "默认简历" };
  }

  function create({ window: win, document: doc, storage, matcher, schema, overlayFactory, clipboard, isContextValid = () => true }) {
    let enabled = false, selection = null, down = null, generation = 0, disposed = false, settingsVersion = 0;
    const lease = isContextValid() ? ownership.acquire(doc) : null;
    const overlay = overlayFactory({ window: win, document: doc, clipboard, isOwner: () => !disposed && Boolean(lease?.isOwner()),
      onClose: () => { generation++; selection = null; } });
    function usable() {
      if (disposed) return false;
      if (!isContextValid() || !lease?.isOwner()) { dispose(); return false; }
      return true;
    }
    const rectOf = (range) => {
      const rect = range.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, width: rect.width, height: rect.height };
    };
    function close() { generation++; selection = null; overlay.hide(); }
    function contextOf(range) {
      const node = range.startContainer?.parentElement;
      // Use only the nearest explicit section title to disambiguate generic dates.
      const section = node?.closest?.('fieldset,section,article,[role="group"]');
      const heading = section?.querySelector?.('legend,h1,h2,h3,h4,h5,h6,[role="heading"]');
      return String(heading?.textContent || "").slice(0, 100);
    }
    function onMouseDown(event) {
      if (!usable()) return;
      if (event.isTrusted === false) return;
      if (!enabled || doc.getElementById?.("ai-resume-fill-selection-overlay")) return;
      if (overlay.containsEvent(event)) { down = null; return; }
      if (event.button !== 0) { down = null; close(); return; }
      const current = doc.getSelection?.();
      down = { x: event.clientX, y: event.clientY, text: String(current?.toString() || "") };
      close();
    }
    async function onMouseUp(event) {
      if (!usable()) return;
      if (event.isTrusted === false) return;
      if (!enabled || disposed || event.button !== 0 || overlay.containsEvent(event) || !down) return;
      const started = down; down = null;
      if (doc.getElementById?.("ai-resume-fill-selection-overlay")) return;
      const picked = doc.getSelection?.();
      if (!picked || picked.isCollapsed || !picked.rangeCount) return;
      const raw = picked.toString(), text = raw.trim();
      if (!text || text.length > 200 || !matcher.normalize(text)) return;
      if (raw === started.text && Math.hypot(event.clientX - started.x, event.clientY - started.y) < 3) return;
      const range = picked.getRangeAt(0).cloneRange();
      const target = range.startContainer?.parentElement;
      if (target?.closest?.('input[type="password"],[data-resume-lookup-ignore]')) return;
      const token = ++generation;
      selection = { text, range };
      try {
        const data = await readSnapshot(storage);
        if (!usable() || token !== generation || !enabled || range.startContainer?.isConnected === false) return;
        const index = matcher.buildIndex(data.profile, schema);
        overlay.show({ text, rect: rectOf(range), templateName: data.templateName,
          candidates: matcher.match(index, text, contextOf(range)), search: (query) => matcher.search(index, query) });
      } catch (_) {
        // Reloaded/uninstalled extensions leave listeners whose storage API throws.
        // Retire those listeners instead of displaying a second error popup.
        if (ownership.isContextInvalidated(_) || !usable()) { dispose(); return; }
        if (token === generation && enabled && !disposed) {
          try { overlay.show({ text, rect: rectOf(range), candidates: [], templateName: "当前模板", search: () => [], error: "简历资料读取失败，请重新选词重试" }); }
          catch (_) { close(); }
        }
      }
    }
    function onKeyDown(event) { if (usable() && event.key === "Escape") { down = null; close(); } }
    function onViewport() {
      if (!usable()) return;
      if (!selection || !overlay.isOpen()) return;
      try {
        if (selection.range.startContainer?.isConnected === false) { close(); return; }
        overlay.reposition(rectOf(selection.range));
      } catch (_) { close(); }
    }
    function onStorage(changes, area) {
      if (!usable()) return;
      if (area !== "local" && area !== "sync") return;
      if (area === "local" && changes[SETTINGS_KEY]) {
        settingsVersion++; enabled = changes[SETTINGS_KEY].newValue === true; down = null; close();
      } else if (DATA_KEYS.some((key) => changes[key])) { down = null; close(); }
    }
    doc.addEventListener("mousedown", onMouseDown, true);
    doc.addEventListener("mouseup", onMouseUp, true);
    doc.addEventListener("keydown", onKeyDown, true);
    win.addEventListener("resize", onViewport);
    win.addEventListener("scroll", onViewport, true);
    storage.onChanged.addListener(onStorage);
    const ready = Promise.resolve().then(() => storage.local.get(SETTINGS_KEY)).then((data) => {
      if (usable() && settingsVersion === 0) enabled = data[SETTINGS_KEY] === true;
    }).catch((error) => { if (ownership.isContextInvalidated(error) || !isContextValid()) dispose(); });
    function dispose() {
      if (disposed) return;
      disposed = true; enabled = false; down = null; close(); overlay.destroy(); lease?.release();
      doc.removeEventListener("mousedown", onMouseDown, true); doc.removeEventListener("mouseup", onMouseUp, true); doc.removeEventListener("keydown", onKeyDown, true);
      win.removeEventListener("resize", onViewport); win.removeEventListener("scroll", onViewport, true);
      // An invalidated chrome.storage context may throw even while removing listeners.
      try { storage.onChanged.removeListener(onStorage); } catch (_) { /* context already gone */ }
    }
    return { version: VERSION, ready, close, isEnabled: () => enabled, isAlive: usable, dispose };
  }
  return Object.freeze({ VERSION, SETTINGS_KEY, readSnapshot, create });
});
