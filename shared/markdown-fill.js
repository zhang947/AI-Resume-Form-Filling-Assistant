(function (root, factory) {
  const api = factory(typeof module === "object" && module.exports ? require("./form-plan.js") : root.ResumeFormPlan);
  if (typeof module === "object" && module.exports) module.exports = api;
  root.ResumeMarkdownFill = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (plan) {
  "use strict";

  // No storage writes here. Complete the whole plan before touching any controls.
  async function run({ modelId, markdown, fillMode, scan, callAI, controls, page, onProgress = () => {} }) {
    const payload = plan.buildPayload(scan.fields, markdown, page);
    const incremental = fillMode === "incremental";
    const runtimes = new Map(scan.runtime.map((runtime) => [runtime.fieldId, runtime]));
    const protectedIds = new Set();
    const edited = new Set();
    const listeners = [];
    for (const runtime of scan.runtime) {
      if (incremental && controls.hasValue(runtime)) protectedIds.add(runtime.fieldId);
      const nodes = new Set(controls.elements(runtime));
      const doc = runtime.el?.ownerDocument;
      if (controls.ownsEvent && doc) nodes.add(doc);
      for (const el of nodes) {
        const listener = (event) => {
          if (event.isTrusted && (el !== doc || controls.ownsEvent(runtime, event))) edited.add(runtime.fieldId);
        };
        for (const type of ["input", "change", "click", "keydown"]) el.addEventListener?.(type, listener, true);
        listeners.push([el, listener]);
      }
    }
    const report = [];
    try {
      const aiText = await callAI(modelId, JSON.stringify(payload), "field_values");
      const parsed = plan.parseJsonFromAiText(aiText);
      if (!Array.isArray(parsed?.answers)) throw new Error("AI 返回格式错误：缺少 answers 数组");
      const answers = plan.normalizeAnswers(parsed.answers, scan.fields, markdown);
      // All answers are generated and validated before the first search or write.
      const canWrite = (fieldId, runtime) => !incremental ||
        (!protectedIds.has(fieldId) && !edited.has(fieldId) && !controls.hasValue(runtime));
      for (let index = 0; index < scan.fields.length; index++) {
        const field = scan.fields[index], answer = answers[index];
        const runtime = runtimes.get(field.fieldId);
        const item = { ...answer, label: field.label, sectionLabel: field.sectionLabel, status: "missing" };
        if (!canWrite(field.fieldId, runtime)) {
          item.status = "skipped"; item.value = null; item.evidence = [];
          item.reason = "已有内容或本轮期间手动修改，增量模式保护";
        } else if (answer.source !== "missing") {
          try {
            const result = await controls.fill(runtime, answer.value, {
              // Async controls must recheck this immediately before committing.
              canWrite: () => canWrite(field.fieldId, runtime), incremental,
              userEdited: () => incremental && edited.has(field.fieldId),
            });
            if (result.skipped) { item.status = "skipped"; item.reason = "等待期间已手动修改，已保护"; }
            else if (result.filled && await controls.verify(runtime, answer.value)) {
              item.status = answer.source === "generated" ? "generated" : "filled";
            } else { item.status = "failed"; item.reason = result.message || "验证未通过，请手动检查"; }
          } catch (_) { item.status = "failed"; item.reason = "控件操作失败，请手动检查"; }
        }
        report.push(item);
        onProgress(item, report);
      }
      // A later dependency may reset an earlier field; verify the final full form.
      for (const item of report) {
        if (!["filled", "generated"].includes(item.status)) continue;
        const runtime = runtimes.get(item.fieldId);
        if (incremental && edited.has(item.fieldId)) {
          item.status = "skipped"; item.value = null; item.evidence = [];
          item.reason = "填写期间手动修改，保留当前内容";
        } else {
          let verified = false;
          try { verified = await controls.verify(runtime, item.value); } catch (_) { /* detached control */ }
          if (!verified) { item.status = "failed"; item.reason = "整表复核未通过，字段可能被联动重置，请手动检查"; }
        }
      }
      return { success: true, fieldCount: scan.fields.length,
        mappedCount: answers.filter((answer) => answer.source !== "missing").length,
        filledCount: report.filter((item) => ["filled", "generated"].includes(item.status)).length,
        cacheHit: false, report };
    } finally {
      for (const [el, listener] of listeners) {
        for (const type of ["input", "change", "click", "keydown"]) el.removeEventListener?.(type, listener, true);
      }
    }
  }
  return Object.freeze({ run });
});
