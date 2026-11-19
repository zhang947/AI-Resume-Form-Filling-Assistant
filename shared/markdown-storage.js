(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.ResumeMarkdownStorage = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  // Paired with the existing template ID, never stored in or migrated from profiles.
  const KEY = "resumeMarkdownDocumentsV1";
  function area(storage) {
    return (storage || globalThis.chrome.storage).local;
  }
  async function load(id, storage) {
    const data = await area(storage).get(KEY);
    const value = data[KEY]?.[id];
    return typeof value === "string" ? value : "";
  }
  async function save(id, markdown, storage) {
    if (!id || typeof markdown !== "string") throw new Error("Markdown 资料无效");
    const local = area(storage);
    const data = await local.get(KEY);
    await local.set({ [KEY]: { ...data[KEY], [id]: markdown } });
  }
  return Object.freeze({ KEY, load, save });
});
