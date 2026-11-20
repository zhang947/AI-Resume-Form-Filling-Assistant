(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.ResumeLookupOwnership = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const OWNER_ID = "ai-resume-selection-lookup-owner";
  const HOST_ID = "ai-resume-selection-lookup-overlay";
  function removeOverlays(doc, except) {
    for (const host of doc.querySelectorAll(`[data-resume-lookup-overlay],#${HOST_ID}`)) {
      if (host !== except) host.remove();
    }
  }
  function acquire(doc) {
    // The DOM is shared across isolated extension contexts, unlike window globals.
    // Compare the node itself so an obsolete context cannot release a new owner's lease.
    doc.getElementById(OWNER_ID)?.remove();
    removeOverlays(doc);
    const marker = doc.createElement("div");
    marker.id = OWNER_ID; marker.hidden = true;
    marker.style.cssText = "display:none!important";
    (doc.documentElement || doc.body).appendChild(marker);
    return {
      isOwner: () => marker.isConnected && doc.getElementById(OWNER_ID) === marker,
      release() { marker.remove(); },
    };
  }
  function isContextInvalidated(error) {
    return /extension context invalidated|context (?:was )?invalidated|extension (?:has been |was )?(?:unloaded|disabled)|扩展上下文.*失效/i.test(String(error?.message || error || ""));
  }
  return Object.freeze({ OWNER_ID, HOST_ID, removeOverlays, acquire, isContextInvalidated });
});
