(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.ResumeAliasEnrichment = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const normalized = (text) => String(text || "").normalize("NFKC").toLowerCase().replace(/[\s*＊:：]/g, "");
  const list = (value) => Array.isArray(value) ? value : String(value || "").split(/[,，;；、\n]/).map((v) => v.trim()).filter(Boolean);
  function direction(field) {
    if (["start", "end"].includes(field.role)) return field.role;
    const name = normalized(field.name || field.label);
    if (/开始.*结束|起始.*截止|起止/.test(name)) return "";
    if (!/时间|日期|年月|date|time/.test(name) && !["开始", "结束", "起始", "截止", "入学", "毕业", "入职", "离职"].includes(name) && (field.type || field.input) !== "date") return "";
    const start = /开始|起始|入学|入职|startdate|starttime/.test(name);
    const end = /结束|截止|毕业|离职|enddate|endtime/.test(name);
    return start !== end ? (start ? "start" : "end") : "";
  }
  function sanitizeAliases(field, proposed) {
    if (!Array.isArray(proposed)) return [];
    const seen = new Set([normalized(field.name || field.label)]), result = [], role = direction(field);
    for (const raw of proposed) {
      if (typeof raw !== "string") continue;
      const alias = raw.trim(), key = normalized(alias);
      if (alias.length < 2 || alias.length > 40 || /[\x00-\x1f\x7f]/.test(alias) || !key || seen.has(key)) continue;
      if (key === normalized(field.value)) continue;
      const aliasRole = direction({ name: alias });
      if (role && aliasRole && role !== aliasRole) continue;
      if (!role && (field.type || field.input) === "date" && aliasRole) continue;
      seen.add(key); result.push(alias);
      if (result.length === 12) break;
    }
    return result;
  }
  function resolve(profile, path) {
    const p = String(path).split(".");
    if (p.length !== 7 || p[0] !== "groups" || p[2] !== "items" || p[4] !== "fields" || p[6] !== "value") return null;
    return profile.groups.find((g) => g.id === p[1])?.items.find((i) => i.id === p[3])?.fields.find((f) => f.id === p[5]) || null;
  }
  function prepare(schema, before, suggestions) {
    const profile = JSON.parse(JSON.stringify(before)), catalog = schema.getFieldCatalog({ profile });
    const byPath = new Map(catalog.map((f) => [f.path, f])), changes = [], proposed = new Map();
    if (!Array.isArray(suggestions)) throw new Error("别名结果格式不正确");
    for (const suggestion of suggestions) {
      if (!byPath.has(suggestion?.path) || !Array.isArray(suggestion.aliases)) throw new Error("AI 返回了未知字段或无效别名数组，请重新生成");
      proposed.set(suggestion.path, [...(proposed.get(suggestion.path) || []), ...suggestion.aliases]);
    }
    for (const [path, aliases] of proposed) {
      const descriptor = byPath.get(path), field = resolve(profile, path);
      const existingAliases = Array.from(schema.normalizeAliases(field.aliases, field.name));
      const existing = new Set([field.name, ...existingAliases].map(normalized));
      const added = sanitizeAliases(field, aliases).filter((alias) => !existing.has(normalized(alias)));
      if (added.length) changes.push({ path, label: `${descriptor.sectionLabel} · ${descriptor.itemLabel} · ${field.name}`, before: existingAliases, added });
    }
    return { before: profile, changes };
  }
  function apply(schema, plan, selected = plan.changes) {
    const profile = JSON.parse(JSON.stringify(plan.before));
    for (const change of selected) {
      // Only apply entries constructed by prepare; the AI cannot supply values
      // or metadata mutations through a forged change object.
      if (!plan.changes.includes(change)) throw new Error("别名预览已失效，请重新生成");
      const field = resolve(profile, change.path);
      field.aliases = Array.from(schema.normalizeAliases([...list(field.aliases), ...change.added], field.name));
    }
    return profile;
  }
  async function generate({ schema, profile, buildPrompt, callAI, parse, isCurrent = () => true, onProgress = () => {} }) {
    const catalog = schema.getFieldCatalog({ profile }).filter((f) => f.label.trim());
    const metadata = catalog.map((f) => ({ path: f.path, group: f.sectionLabel, item: f.itemLabel, name: f.label, type: f.input, role: f.role, aliases: f.aliases }));
    const queue = []; for (let i = 0; i < metadata.length; i += 24) queue.push(metadata.slice(i, i + 24));
    const suggestions = []; let completed = 0;
    while (queue.length) {
      if (!isCurrent()) throw new Error("资料或模板已修改，请重新补充别名");
      const batch = queue.shift(); onProgress({ completed, total: completed + queue.length + 1 });
      let raw;
      try { raw = await callAI(buildPrompt(batch)); }
      catch (error) {
        if (error.code !== "AI_OUTPUT_TRUNCATED" || batch.length < 2) throw error;
        const mid = Math.ceil(batch.length / 2); queue.unshift(batch.slice(0, mid), batch.slice(mid)); continue;
      }
      if (!isCurrent()) throw new Error("资料或模板已修改，请重新补充别名");
      const parsed = parse(raw), allowed = new Set(batch.map((f) => f.path));
      if (!Array.isArray(parsed?.fields) || parsed.fields.some((f) => !allowed.has(f?.path) || !Array.isArray(f.aliases))) throw new Error("AI 别名结果包含未知字段或格式错误");
      suggestions.push(...parsed.fields); completed++;
    }
    return prepare(schema, profile, suggestions);
  }
  function preview({ document: doc, host, plan, onApply }) {
    host.querySelector?.(".alias-preview")?.remove();
    const make = (tag, text, cls) => { const el = doc.createElement(tag); if (text !== undefined) el.textContent = text; if (cls) el.className = cls; return el; };
    const panel = make("section", undefined, "alias-preview library-import-preview resume-section");
    panel.append(make("h3", "AI 别名补充预览"), make("p", plan.changes.length ? `共 ${plan.changes.length} 个字段可补充别名。核对后保存，已有别名和字段内容保留。` : "没有可添加的新别名。", "tip"));
    const checks = [];
    for (const change of plan.changes) {
      const card = make("article", undefined, "custom-field-card"), label = make("label"), checkbox = make("input");
      checkbox.type = "checkbox"; checkbox.checked = true;
      label.append(checkbox, doc.createTextNode(` ${change.label}`));
      card.append(label, make("p", `已有：${change.before.join("、") || "无"}`), make("p", `新增：${change.added.join("、")}`));
      panel.append(card); checks.push({ checkbox, change });
    }
    const status = make("p"); status.setAttribute("role", "status");
    const actions = make("div", undefined, "alias-preview-actions"), save = make("button", "保存所选别名", "btn btn-primary btn-sm"), cancel = make("button", "取消", "btn btn-outline btn-sm");
    save.type = cancel.type = "button"; save.disabled = !checks.length;
    const refresh = () => save.disabled = !checks.some((c) => c.checkbox.checked);
    for (const c of checks) c.checkbox.addEventListener("change", refresh);
    cancel.addEventListener("click", () => panel.remove());
    save.addEventListener("click", async () => {
      save.disabled = true; cancel.disabled = true;
      try { await onApply(checks.filter((c) => c.checkbox.checked).map((c) => c.change)); panel.remove(); }
      catch (error) { status.textContent = error.message; cancel.disabled = false; refresh(); }
    });
    actions.append(save, cancel); panel.append(status, actions); host.append(panel); panel.scrollIntoView?.({ behavior: "smooth", block: "start" });
    return panel;
  }
  return Object.freeze({ sanitizeAliases, prepare, apply, generate, preview });
});
