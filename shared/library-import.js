(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.ResumeLibraryImport = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const key = (value) => String(value || "").normalize("NFKC").trim().toLowerCase();
  // Only split at paragraph/heading boundaries. Never cut a JSON response or a
  // sentence in half and guess the missing text. Joining chunks reproduces the
  // original source, including line breaks and the final paragraph.
  function splitSource(source, maxChars = 2400) {
    source = String(source || "");
    const boundaries = new Set([0, source.length]);
    for (const match of source.matchAll(/(?:\r?\n){2,}|^#{1,6}[ \t]+/gm)) {
      boundaries.add(match[0].startsWith("#") ? match.index : match.index + match[0].length);
    }
    const points = [...boundaries].sort((a, b) => a - b), chunks = [];
    let start = 0, end = 0;
    for (let i = 1; i < points.length; i++) {
      if (end > start && points[i] - start > maxChars) {
        chunks.push({ start, end, source: source.slice(start, end) }); start = end;
      }
      end = points[i];
    }
    if (end > start) chunks.push({ start, end, source: source.slice(start, end) });
    return chunks;
  }
  function sourceContext(source, start) {
    const headings = [];
    for (const match of source.slice(0, start).matchAll(/^(#{1,6})[ \t]+(.+)$/gm)) {
      headings.length = match[1].length - 1; headings[match[1].length - 1] = match[2];
    }
    return [headings.filter(Boolean).join(" / "), source.slice(Math.max(0, start - 600), start)].filter(Boolean).join("\n");
  }
  async function extract({ schema, source, callAI, buildPrompt, parse, isCurrent = () => true, onProgress = () => {} }) {
    const original = String(source || ""), queue = splitSource(original), groups = [];
    let completed = 0, requests = 0;
    while (queue.length) {
      if (!isCurrent()) throw new Error("资料或模板已修改，请重新解析");
      if (++requests > 64) throw new Error("资料分段过多，请将资料分批导入；本次未保存任何解析结果");
      const chunk = queue.shift();
      onProgress({ completed, total: completed + queue.length + 1 });
      const context = sourceContext(original, chunk.start);
      const prompt = [context ? `以下为分段的标题/邻近原文，仅用于判断归属，不要重复提取。沿用原文分组及条目名称，不添加“第几部分”等分组：\n${context}\n分段正文如下：` : "",
        buildPrompt(schema, chunk.source)].filter(Boolean).join("\n\n");
      let response;
      try { response = await callAI(prompt); }
      catch (error) {
        if (!isCurrent()) throw new Error("资料或模板已修改，请重新解析");
        if (error.code !== "AI_OUTPUT_TRUNCATED") throw error;
        const smaller = splitSource(chunk.source, Math.max(1, Math.floor(chunk.source.length / 2)));
        if (smaller.length < 2) throw new Error("单个资料段落的 AI 输出仍超过长度上限，请将该段落拆成几个完整段落后重试；本次未保存任何解析结果");
        queue.unshift(...smaller.map((part) => ({ ...part, start: chunk.start + part.start, end: chunk.start + part.end })));
        continue;
      }
      if (!isCurrent()) throw new Error("资料或模板已修改，请重新解析");
      const parsed = parse(response);
      // Validate each complete chunk, then expose one aggregate preview only
      // when every chunk succeeds. No partial result can be saved on failure.
      prepare(schema, { groups: [] }, parsed, original);
      groups.push(...parsed.groups); completed++;
    }
    onProgress({ completed, total: completed });
    return { groups };
  }
  function prepare(schema, before, parsed, source) {
    if (!parsed || !Array.isArray(parsed.groups)) throw new Error("AI 结果缺少 groups，请重新解析");
    const incoming = schema.normalizeResumeProfile(parsed), error = schema.validateProfile(incoming);
    if (error) throw new Error(error);
    const original = String(source || "").replace(/\r\n/g, "\n");
    const unindent = (text) => text.replace(/^[ \t]+/gm, "");
    const containsQuote = (container, quote) => container.includes(quote) || unindent(container).includes(unindent(quote));
    // Require literal source evidence for every saved value. Dates alone may be
    // reformatted, without adding missing month/day precision.
    parsed.groups.forEach((group) => (group.items || []).forEach((item) => (item.fields || []).forEach((field) => {
      const evidence = String(field.evidence ?? field.value ?? "").replace(/\r\n/g, "\n");
      const value = String(field.value ?? "").replace(/\r\n/g, "\n");
      if (!value.trim()) return;
      if (!evidence.trim() || !containsQuote(original, evidence)) throw new Error(`“${field.name}”缺少可核对的原文，请重新解析`);
      if (!containsQuote(evidence, value) && !(field.type === "date" && schema.normalizeDateValue(evidence) === schema.normalizeDateValue(value))) {
        throw new Error(`“${field.name}”的值与原文不符，请重新解析`);
      }
    })));
    const profile = schema.normalizeResumeProfile(before), changes = [], conflicts = [];
    let duplicates = 0;
    for (const group of incoming.groups) {
      for (const item of group.items) {
        for (const field of item.fields.filter((f) => f.value.trim())) {
          const existingGroup = profile.groups.find((g) => key(g.name) === key(group.name));
          const existingItem = existingGroup?.items.find((i) => key(i.name) === key(item.name));
          const existing = existingItem?.fields.find((f) => key(f.name) === key(field.name));
          const label = `${group.name} · ${item.name} · ${field.name}`;
          if (existing && existing.value === field.value) { duplicates++; continue; }
          const change = { groupName: group.name, itemName: item.name, field, label, existingId: existing?.id, previous: existing?.value || "" };
          if (existing?.value.trim()) conflicts.push(change); else changes.push(change);
          // Track this response too: duplicate/conflicting fields in one AI result
          // must not silently overwrite the first proposed value.
          let g = existingGroup;
          if (!g) { g = schema.createGroup({ name: group.name }); profile.groups.push(g); }
          let i = existingItem;
          if (!i) { i = schema.createItem({ name: item.name }); g.items.push(i); }
          if (!existing) i.fields.push(schema.createField(field));
          else if (!existing.value.trim()) Object.assign(existing, field, { id: existing.id });
        }
      }
    }
    return { before: schema.normalizeResumeProfile(before), changes, conflicts, duplicates };
  }
  function apply(schema, plan, selected = plan.changes) {
    const next = schema.normalizeResumeProfile(plan.before);
    for (const change of selected) {
      let group = next.groups.find((g) => key(g.name) === key(change.groupName));
      if (!group) { group = schema.createGroup({ name: change.groupName }); next.groups.push(group); }
      let item = group.items.find((i) => key(i.name) === key(change.itemName));
      if (!item) { item = schema.createItem({ name: change.itemName }); group.items.push(item); }
      const existing = item.fields.find((f) => key(f.name) === key(change.field.name));
      if (existing) Object.assign(existing, change.field, { id: existing.id });
      else item.fields.push(schema.createField(change.field));
    }
    return next;
  }
  function preview({ document: doc, host, plan, onApply }) {
    host.querySelector?.(".library-import-preview")?.remove();
    const panel = doc.createElement("section"); panel.className = "library-import-preview resume-section";
    const heading = doc.createElement("h3"); heading.textContent = "AI 解析预览";
    const note = doc.createElement("p"); note.className = "tip";
    note.textContent = `新增/补全 ${plan.changes.length} 项，重复 ${plan.duplicates} 项，冲突 ${plan.conflicts.length} 项。核对后批量保存；冲突项默认不覆盖。`;
    panel.append(heading, note);
    const checks = [];
    for (const change of [...plan.changes, ...plan.conflicts]) {
      const card = doc.createElement("article"); card.className = "custom-field-card";
      const label = doc.createElement("label"), checkbox = doc.createElement("input"); checkbox.type = "checkbox";
      checkbox.checked = !plan.conflicts.includes(change); label.append(checkbox, doc.createTextNode(` ${change.label}${plan.conflicts.includes(change) ? "（冲突：勾选将替换原值）" : ""}`));
      card.append(label);
      if (plan.conflicts.includes(change)) { const previous = doc.createElement("pre"); previous.textContent = `原值：${change.previous}`; card.append(previous); }
      const value = doc.createElement("pre"); value.textContent = change.field.value; card.append(value); panel.append(card);
      checks.push({ checkbox, change });
    }
    const status = doc.createElement("p"); status.setAttribute("role", "status");
    const save = doc.createElement("button"); save.type = "button"; save.className = "btn btn-primary"; save.textContent = "保存所选信息";
    const cancel = doc.createElement("button"); cancel.type = "button"; cancel.className = "btn btn-outline"; cancel.textContent = "取消";
    cancel.addEventListener("click", () => panel.remove());
    save.addEventListener("click", async () => {
      save.disabled = true;
      try { await onApply(checks.filter((entry) => entry.checkbox.checked).map((entry) => entry.change)); panel.remove(); }
      catch (error) { status.textContent = error.message; save.disabled = false; }
    });
    panel.append(status, save, cancel); host.append(panel); panel.scrollIntoView?.({ behavior: "smooth", block: "start" });
    return panel;
  }
  return Object.freeze({ prepare, apply, preview, splitSource, extract });
});
