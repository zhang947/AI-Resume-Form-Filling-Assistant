(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.ResumeLookupOverlay = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  function position(anchor, size, viewport) {
    const margin = 8, gap = 8;
    const width = Math.min(size.width, Math.max(0, viewport.width - margin * 2));
    const height = Math.min(size.height, Math.max(0, viewport.height - margin * 2));
    const clamp = (value, min, max) => Math.max(min, Math.min(value, Math.max(min, max)));
    const above = anchor.top - height - gap;
    return {
      left: clamp(anchor.left + (anchor.width || anchor.right - anchor.left) / 2 - width / 2, margin, viewport.width - width - margin),
      top: clamp(above >= margin ? above : anchor.bottom + gap, margin, viewport.height - height - margin),
      width,
    };
  }
  function create({ document: doc = document, window: win = window, clipboard, onClose = () => {} } = {}) {
    const host = doc.createElement("div");
    host.style.cssText = "all:initial;position:fixed!important;z-index:2147483647!important;display:none;";
    // The website cannot query resume values from an open shadowRoot.
    const shadow = host.attachShadow({ mode: "closed" });
    const style = doc.createElement("style");
    style.textContent = `
      :host{font-family:system-ui,-apple-system,'Microsoft YaHei',sans-serif;color:#17233a;font-size:13px;text-align:left;line-height:1.5}
      *{box-sizing:border-box}button,input{font:inherit}button{cursor:pointer}
      .panel{font:13px/1.5 system-ui,-apple-system,'Microsoft YaHei',sans-serif;background:#fff;border:1px solid #ccd6e5;border-radius:12px;box-shadow:0 8px 32px #152d4d33;max-height:min(440px,calc(100vh - 16px));overflow:auto;overscroll-behavior:contain;padding:12px;color:#17233a}
      .header,.actions{display:flex;align-items:center;justify-content:space-between;gap:8px}.title{font-weight:650;overflow-wrap:anywhere}
      .muted{color:#64748b;margin:6px 0;overflow-wrap:anywhere}.close,.search-toggle,.expand{border:0;border-radius:5px;padding:4px 6px;color:#245bc3;background:#f1f5fc}
      .search{width:100%;padding:8px;margin:6px 0;border:1px solid #bccbe0;border-radius:6px;outline-offset:2px}
      .row{border:1px solid #e1e7f0;border-radius:8px;margin:8px 0;overflow:hidden}.candidate{border:0;background:#fff;color:inherit;width:100%;text-align:left;padding:9px;display:block}.candidate:hover{background:#f4f7fd}.candidate:focus-visible{outline:2px solid #4277dc;outline-offset:-2px}.candidate:disabled{cursor:wait}
      .source{display:block;font-weight:600}.preview{display:block;white-space:pre-wrap;overflow-wrap:anywhere;margin-top:4px;max-height:100px;overflow:hidden}.preview.expanded{max-height:none}
      .copy-status{display:block;color:#245bc3;font-size:12px;margin-top:5px}.row-actions{padding:0 9px 7px;text-align:right}.empty{padding:12px 0;color:#64748b}.footer{font-size:12px;color:#64748b;margin:8px 0 0}
    `;
    shadow.appendChild(style);
    const panel = doc.createElement("section"); panel.className = "panel"; panel.setAttribute("role", "dialog"); panel.setAttribute("aria-label", "简历相关资料");
    const header = doc.createElement("div"); header.className = "header";
    const title = doc.createElement("span"); title.className = "title";
    const closeBtn = doc.createElement("button"); closeBtn.type = "button"; closeBtn.className = "close"; closeBtn.textContent = "关闭";
    header.append(title, closeBtn);
    const selected = doc.createElement("p"); selected.className = "muted";
    const searchToggle = doc.createElement("button"); searchToggle.type = "button"; searchToggle.className = "search-toggle"; searchToggle.textContent = "搜索简历资料";
    const input = doc.createElement("input"); input.type = "search"; input.className = "search"; input.placeholder = "搜索名称、字段或资料内容"; input.setAttribute("aria-label", "搜索简历资料"); input.hidden = true;
    const list = doc.createElement("div"), footer = doc.createElement("p"); footer.className = "footer";
    panel.append(header, selected, searchToggle, input, list, footer); shadow.appendChild(panel);
    let snapshot = null, anchor = null, session = 0;
    const timers = new Set();
    function clearTimers() { for (const timer of timers) win.clearTimeout(timer); timers.clear(); }
    function containsEvent(event) { return event.composedPath?.().includes(host) || host === event.target; }
    function reposition(rect = anchor) {
      if (!snapshot || !rect) return;
      anchor = { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, width: rect.width };
      const width = Math.min(380, Math.max(0, win.innerWidth - 16));
      host.style.width = `${width}px`;
      const size = panel.getBoundingClientRect();
      const point = position(anchor, { width, height: size.height }, { width: win.innerWidth, height: win.innerHeight });
      host.style.left = `${point.left}px`; host.style.top = `${point.top}px`;
    }
    function render(candidates, searching = false) {
      clearTimers(); const token = ++session;
      list.replaceChildren();
      if (!candidates.length) {
        const empty = doc.createElement("p"); empty.className = "empty";
        empty.textContent = snapshot.error || "未找到相关内容"; list.appendChild(empty);
      }
      for (const candidate of candidates.slice(0, 100)) {
        const row = doc.createElement("div"); row.className = "row";
        const button = doc.createElement("button"); button.type = "button"; button.className = "candidate";
        const source = doc.createElement("span"); source.className = "source"; source.textContent = `${candidate.sourceName} · ${candidate.format}`;
        const preview = doc.createElement("span"); preview.className = "preview"; preview.textContent = candidate.preview;
        const status = doc.createElement("span"); status.className = "copy-status"; status.setAttribute("role", "status"); status.textContent = "点击复制";
        button.append(source, preview, status); row.appendChild(button);
        button.addEventListener("click", async () => {
          button.disabled = true; status.textContent = "正在复制…";
          let copied = false;
          try { copied = await clipboard.copy(candidate.copyValue, { document: doc, navigator: win.navigator, container: shadow }); } catch (_) { /* show retry */ }
          if (token !== session || !snapshot) return;
          button.disabled = false; status.textContent = copied ? "已复制" : "复制失败，点击重试";
          if (copied) {
            const timer = win.setTimeout(() => { timers.delete(timer); if (token === session) status.textContent = "点击复制"; }, 1600);
            timers.add(timer);
          }
        });
        if (candidate.copyValue.length > 80 || candidate.copyValue.split("\n").length > 3) {
          const actions = doc.createElement("div"); actions.className = "row-actions";
          const expand = doc.createElement("button"); expand.type = "button"; expand.className = "expand"; expand.textContent = "展开查看"; expand.setAttribute("aria-expanded", "false");
          expand.addEventListener("click", () => {
            const expanded = expand.getAttribute("aria-expanded") !== "true";
            expand.setAttribute("aria-expanded", String(expanded)); expand.textContent = expanded ? "收起" : "展开查看";
            preview.textContent = expanded ? candidate.copyValue : candidate.preview; preview.className = expanded ? "preview expanded" : "preview";
            reposition();
          });
          actions.appendChild(expand); row.appendChild(actions);
        }
        list.appendChild(row);
      }
      footer.textContent = `${searching ? "搜索结果" : "相关资料"} ${candidates.length} 条${candidates.length > 100 ? "，仅展示前 100 条，请缩小搜索范围" : ""} · 仅复制，由你自行粘贴`;
      reposition();
    }
    function hide() {
      snapshot = null; anchor = null; session++; clearTimers(); host.style.display = "none";
      input.value = ""; input.hidden = true; list.replaceChildren(); host.remove();
    }
    function close() { hide(); onClose(); }
    closeBtn.addEventListener("click", close);
    panel.addEventListener("mousedown", (event) => { if (event.target.closest?.("button")) event.preventDefault(); });
    searchToggle.addEventListener("click", () => {
      input.hidden = false; input.value = ""; input.focus(); render(snapshot.search(""), true);
    });
    input.addEventListener("input", () => { if (snapshot) render(snapshot.search(input.value), true); });
    return {
      show({ text, rect, candidates, templateName, search, error = "" }) {
        if (!host.isConnected) (doc.body || doc.documentElement).appendChild(host);
        snapshot = { text, candidates: candidates.slice(), search, error };
        anchor = { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, width: rect.width };
        title.textContent = `简历资料 · ${templateName || "当前模板"}`; selected.textContent = `选中：${text}`;
        input.value = ""; input.hidden = true;
        host.style.display = "block"; render(snapshot.candidates);
      },
      hide, containsEvent, reposition,
      isOpen: () => Boolean(snapshot),
      destroy() { hide(); host.remove(); },
    };
  }
  return Object.freeze({ create, position });
});
