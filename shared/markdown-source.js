(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.ResumeMarkdownSource = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  // Read-only source for the popup. Configuration lives in resume-editor.html.
  function create({ storage, changes, onChange = () => {}, onError = () => {} }) {
    let activeId = null, markdown = "", loading = false, generation = 0;
    async function load(id) {
      const token = ++generation;
      activeId = id; markdown = ""; loading = true; onChange();
      try {
        const value = id ? await storage.load(id) : "";
        if (token === generation) markdown = value;
        return value;
      } finally {
        if (token === generation) { loading = false; onChange(); }
      }
    }
    function onStorageChanged(update, area) {
      if (area === "local" && update[storage.KEY] && activeId) load(activeId).catch(onError);
    }
    changes?.addListener(onStorageChanged);
    return { load, getMarkdown: () => markdown, isBusy: () => loading,
      dispose() { generation++; changes?.removeListener?.(onStorageChanged); } };
  }
  return Object.freeze({ create });
});
