(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.ResumeLookupRegistration = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const SETTINGS_KEY = "resumeSelectionLookupEnabled", SCRIPT_ID = "resume-selection-lookup-v1";
  const FILES = ["shared/resume-schema.js", "shared/selection-lookup-matcher.js", "shared/selection-lookup-clipboard.js",
    "shared/selection-lookup-overlay.js", "shared/selection-lookup-listener.js"];
  function install(chrome) {
    if (!chrome.storage?.local || !chrome.scripting?.registerContentScripts) return null;
    let queue = Promise.resolve();
    function sync(inject = true) {
      const task = queue.then(async () => {
        const enabled = (await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY] === true;
        const registered = await chrome.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] });
        if (enabled && !registered.length) await chrome.scripting.registerContentScripts([{
          id: SCRIPT_ID, matches: ["http://*/*", "https://*/*"], js: FILES, runAt: "document_idle", persistAcrossSessions: true,
        }]);
        if (!enabled && registered.length) await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
        if (enabled && inject) {
          const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
          await Promise.allSettled(tabs.filter((tab) => tab.id && /^https?:\/\//i.test(tab.url || ""))
            .map((tab) => chrome.scripting.executeScript({ target: { tabId: tab.id }, files: FILES })));
        }
        return enabled;
      });
      queue = task.catch(() => {}); return task;
    }
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes[SETTINGS_KEY]) sync().catch(() => {});
    });
    chrome.runtime.onInstalled.addListener(() => { sync().catch(() => {}); });
    chrome.runtime.onStartup?.addListener(() => { sync().catch(() => {}); });
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      if (request?.action !== "setSelectionLookupEnabled") return;
      if (sender?.id !== chrome.runtime.id || typeof request.enabled !== "boolean") return;
      (async () => {
        const before = (await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY] === true;
        try {
          await chrome.storage.local.set({ [SETTINGS_KEY]: request.enabled });
          const enabled = await sync(); sendResponse({ success: true, enabled });
        } catch (_) {
          await chrome.storage.local.set({ [SETTINGS_KEY]: before });
          sendResponse({ success: false, error: "选词查简历设置失败，请重新加载插件后重试" });
        }
      })().catch(() => sendResponse({ success: false, error: "无法保存选词查简历设置" }));
      return true;
    });
    sync(false).catch(() => {});
    return { sync };
  }
  return Object.freeze({ SETTINGS_KEY, SCRIPT_ID, FILES, install });
});
