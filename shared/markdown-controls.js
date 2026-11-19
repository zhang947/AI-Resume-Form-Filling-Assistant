(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.ResumeMarkdownControls = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const text = (value) => String(value ?? "").trim();
  const equal = (left, right) => text(left).normalize("NFKC") === text(right).normalize("NFKC");
  function elements(runtime) {
    return runtime?.options ? runtime.options.map((option) => option.el) :
      runtime?.el ? [...new Set([runtime.el, runtime.trigger].filter(Boolean))] : [];
  }
  function create({ hasExistingFieldValue, fillOne, setNativeValue, clickLikeUser,
    safeCheck, setValueWithEvents, isVisible, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), timeout = 2400 }) {
    function hasValue(runtime) {
      if (runtime?.pendingSearch !== undefined && equal(runtime.el?.value, runtime.pendingSearch)) return false;
      if (runtime?.kind === "combobox") {
        const el = runtime.el;
        return Boolean(text(el.value) || text(el.getAttribute?.("aria-valuetext")) ||
          (!el.matches?.("input,textarea") && text(el.textContent)));
      }
      return hasExistingFieldValue(runtime);
    }
    function valid(runtime) {
      return runtime && elements(runtime).length && elements(runtime).every((el) =>
        el?.isConnected !== false && !el.disabled && el.getAttribute?.("aria-disabled") !== "true");
    }
    function panels(runtime) {
      const el = runtime.el, doc = el.ownerDocument;
      const trigger = runtime.trigger || el;
      const ids = [...new Set([el, trigger].flatMap((node) =>
        text(`${node.getAttribute("aria-controls") || ""} ${node.getAttribute("aria-owns") || ""}`).split(/\s+/).filter(Boolean)))];
      return ids.map((id) => doc.getElementById(id)).filter(Boolean);
    }
    function ownsEvent(runtime, event) {
      const nodes = elements(runtime);
      if (runtime.kind === "combobox") nodes.push(...panels(runtime));
      return nodes.some((node) => node === event.target || node.contains?.(event.target));
    }
    function options(runtime) {
      if (runtime.kind === "select") return Array.from(runtime.el.options || []);
      // Associate the list explicitly; never pick a candidate from an unrelated dropdown.
      return panels(runtime).flatMap((panel) => Array.from(panel.querySelectorAll('[role="option"]')));
    }
    function optionLabel(option) { return text(option.label || option.textContent); }
    async function waitForOption(runtime, value, canWrite) {
      const attempts = Math.ceil(timeout / 80);
      for (let index = 0; index < attempts; index++) {
        if (!canWrite() || !valid(runtime)) return null;
        const matches = options(runtime).filter((option) => !option.disabled &&
          !option.parentElement?.disabled && option.getAttribute?.("aria-disabled") !== "true" &&
          (runtime.kind === "select" || isVisible(option)) && equal(optionLabel(option), value));
        if (matches.length === 1) return matches[0];
        await sleep(80);
      }
      return null;
    }
    function verify(runtime, value) {
      if (!valid(runtime)) return false;
      if (runtime.kind === "select") {
        const selected = Array.from(runtime.el.options || []).filter((option) => option.selected);
        return selected.length === 1 && equal(optionLabel(selected[0]), value) && !selected[0].disabled;
      }
      if (runtime.kind === "radio_group" || runtime.kind === "checkbox_group") {
        const wanted = Array.isArray(value) ? value : [value];
        const selected = runtime.options.filter((option) => option.el.checked).map((option) => text(option.label || option.value));
        return wanted.length === selected.length && wanted.every((item) => selected.some((label) => equal(label, item)));
      }
      const el = runtime.el;
      if (runtime.kind === "combobox") {
        if (!runtime.committedOption || el.getAttribute("aria-expanded") === "true" || runtime.trigger?.getAttribute("aria-expanded") === "true") return false;
        return equal(el.value || el.getAttribute("aria-valuetext") || el.textContent, value);
      }
      return equal(runtime.kind === "contenteditable" ? el.textContent : el.value, value) &&
        (typeof el.checkValidity !== "function" || el.checkValidity());
    }
    async function fill(runtime, value, { canWrite, incremental, userEdited }) {
      if (!valid(runtime)) return { filled: false, message: "控件已变化或不可用，请重新扫描" };
      if (!canWrite()) return { skipped: true };
      if (runtime.kind === "file") return { filled: false, message: "请手动上传文件" };
      if (["select", "combobox"].includes(runtime.kind)) {
        const el = runtime.el, original = el.value;
        let option;
        try {
          if (runtime.kind === "combobox") {
            runtime.committedOption = false;
            clickLikeUser(runtime.trigger || el);
            if (!canWrite()) return { skipped: true };
            if (el.matches?.("input:not([readonly]),textarea:not([readonly])")) {
              runtime.pendingSearch = String(value);
              setNativeValue(el, String(value));
              el.dispatchEvent(new Event("input", { bubbles: true }));
            }
          }
          option = await waitForOption(runtime, value, canWrite);
          if (!canWrite()) return { skipped: true };
          if (!option) return { filled: false, message: "未找到唯一可用的精确候选，请手动补充或选择" };
          if (runtime.kind === "select") {
            el.value = option.value;
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
          } else {
            clickLikeUser(option); runtime.committedOption = true;
          }
          await sleep(80);
          return { filled: verify(runtime, value) };
        } finally {
          // A failed search is not a filled answer. Restore only our own query.
          if (runtime.pendingSearch !== undefined && !runtime.committedOption && canWrite() && equal(el.value, runtime.pendingSearch)) {
            setNativeValue(el, original || "");
            el.dispatchEvent(new Event("input", { bubbles: true }));
          }
          delete runtime.pendingSearch;
        }
      }
      if (["checkbox_group", "radio_group"].includes(runtime.kind)) {
        const wanted = Array.isArray(value) ? value : [value];
        if (wanted.some((item) => runtime.options.filter((option) => equal(option.label || option.value, item)).length !== 1)) {
          return { filled: false, message: "选项已变化或不唯一，请手动选择" };
        }
        for (const option of runtime.options) {
          // hasValue will become true after our first checkbox; only trusted edits
          // must cancel the remaining checkboxes in the same operation.
          if (userEdited?.()) return { skipped: true };
          await safeCheck(option.el, wanted.some((item) => equal(option.label || option.value, item)));
        }
        return { filled: verify(runtime, value) };
      }
      // Do not inherit the legacy writer's date/salary fallback rules in this mode.
      if (runtime.el?.cloneNode && runtime.kind !== "contenteditable") {
        const probe = runtime.el.cloneNode(false);
        probe.removeAttribute("readonly"); probe.value = String(value);
        if (!equal(probe.value, value) || (probe.checkValidity && !probe.checkValidity())) {
          return { filled: false, message: "目标值不符合页面格式或范围，请核对" };
        }
      }
      if (runtime.kind === "contenteditable") return fillOne(runtime, value, { overwrite: !incremental });
      return { filled: await setValueWithEvents(runtime.el, String(value), runtime) };
    }
    return { elements, hasValue, fill, verify, ownsEvent };
  }
  return Object.freeze({ create, elements });
});
