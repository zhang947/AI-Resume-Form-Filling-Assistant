(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.ResumeLookupClipboard = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  async function copy(value, { navigator: nav = globalThis.navigator, document: doc = globalThis.document, container } = {}) {
    if (typeof value !== "string" || !value.trim()) return false;
    try {
      if (nav?.clipboard?.writeText) { await nav.clipboard.writeText(value); return true; }
    } catch (_) { /* HTTP pages and older browsers may need the extension fallback. */ }
    if (!doc?.execCommand || !container || (container.host && !container.host.isConnected)) return false;
    const selection = doc.getSelection?.(), ranges = [];
    for (let i = 0; i < (selection?.rangeCount || 0); i++) ranges.push(selection.getRangeAt(i).cloneRange());
    const active = doc.activeElement;
    const start = active?.selectionStart, end = active?.selectionEnd, direction = active?.selectionDirection;
    const input = doc.createElement("textarea");
    input.value = value; input.readOnly = true; input.tabIndex = -1;
    input.style.cssText = "position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none";
    try {
      // Keep the temporary value inside the closed overlay shadow root.
      container.appendChild(input); input.focus({ preventScroll: true }); input.select();
      return doc.execCommand("copy") === true;
    } catch (_) { return false; }
    finally {
      input.remove();
      try {
        active?.focus?.({ preventScroll: true });
        if (typeof start === "number") active.setSelectionRange?.(start, end, direction);
        selection?.removeAllRanges(); for (const range of ranges) selection?.addRange(range);
      } catch (_) { /* The original selected node may have been replaced. */ }
    }
  }
  return Object.freeze({ copy });
});
