(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.ResumeCustomFieldsEditor = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  function create({ document: doc, host, nav, schema, onChange = () => {} }) {
    let profile = schema.createEmptyResumeProfile(), section, body, status, deleted, activeGroupId = null;
    const groupToggles = new Map();
    const make = (tag, cls, text) => { const el = doc.createElement(tag); if (cls) el.className = cls; if (text !== undefined) el.textContent = text; return el; };
    const button = (text, action, cls = "btn btn-outline btn-sm") => { const el = make("button", cls, text); el.type = "button"; el.addEventListener("click", action); return el; };
    function groupSummary(g) {
      const filled = g.items.flatMap((i) => i.fields).filter((f) => f.value.trim()).length;
      return `${g.name || "未命名分组"} · ${filled} 项`;
    }
    function changed() {
      if (status) { status.textContent = ""; status.hidden = true; }
      for (const g of profile.groups) {
        const toggle = groupToggles.get(g.id);
        if (toggle) toggle.textContent = `${activeGroupId === g.id ? "▾" : "▸"} ${groupSummary(g)}`;
      }
      paintNav(); onChange();
    }
    function group(id) { return profile.groups.find((g) => g.id === id); }
    function item(gid, iid) { return group(gid)?.items.find((i) => i.id === iid); }
    function selectGroup(id) { if (id !== null && !group(id)) return; activeGroupId = id; paint(); }
    function addGroup() { const g = schema.createGroup(); profile.groups.push(g); activeGroupId = g.id; paint(); changed(); return g.id; }
    function addItem(gid) { const i = schema.createItem(); group(gid)?.items.push(i); activeGroupId = gid; paint(); changed(); return i.id; }
    function addField(gid, iid) { const f = schema.createField(); item(gid, iid)?.fields.push(f); activeGroupId = gid; paint(); changed(); return f.id; }
    function listFor(gid, iid) { return iid ? item(gid, iid)?.fields : gid ? group(gid)?.items : profile.groups; }
    function mutate(action, id, gid, iid, offset) {
      const list = listFor(gid, iid), index = list?.findIndex((v) => v.id === id);
      if (!(index >= 0)) return;
      if (action === "remove") {
        deleted = { list, index, value: list[index], groupId: gid || id }; list.splice(index, 1);
        if (!gid && activeGroupId === id) activeGroupId = null;
      }
      if (action === "duplicate") {
        const source = list[index], create = iid ? schema.createField : gid ? schema.createItem : schema.createGroup;
        const copy = create({ ...source, name: `${source.name} 副本` });
        list.splice(index + 1, 0, copy);
        activeGroupId = gid || copy.id;
      }
      if (action === "move") {
        const next = index + offset; if (next < 0 || next >= list.length) return;
        const [value] = list.splice(index, 1); list.splice(next, 0, value);
      }
      paint(); changed();
    }
    function undo() { if (!deleted) return; deleted.list.splice(deleted.index, 0, deleted.value); activeGroupId = deleted.groupId; deleted = null; paint(); changed(); }
    function collect() { return schema.normalizeResumeProfile(profile).groups; }
    function control(label, value, onInput, { multiline = false, placeholder = "" } = {}) {
      const wrap = make("label", "custom-field-control"), title = make("span", "resume-field-label", label);
      const el = make(multiline ? "textarea" : "input", multiline ? "resume-textarea" : "resume-input");
      if (multiline) el.rows = 4; else el.type = "text";
      el.value = value; el.placeholder = placeholder;
      el.addEventListener("input", () => { onInput(el.value); changed(); }); wrap.append(title, el); return wrap;
    }
    function select(label, value, options, onChangeValue) {
      const wrap = make("label", "custom-field-control"), el = make("select", "resume-select");
      for (const [val, title] of options) { const option = make("option", "", title); option.value = val; el.append(option); }
      el.value = value; el.addEventListener("change", () => { onChangeValue(el.value); paint(); changed(); });
      wrap.append(make("span", "resume-field-label", label), el); return wrap;
    }
    function actions(value, list, gid, iid) {
      const el = make("div", "custom-field-actions"), index = list.indexOf(value);
      const up = button("上移", () => mutate("move", value.id, gid, iid, -1)), down = button("下移", () => mutate("move", value.id, gid, iid, 1));
      up.disabled = index === 0; down.disabled = index === list.length - 1;
      el.append(up, down, button("复制", () => mutate("duplicate", value.id, gid, iid)), button("删除", () => mutate("remove", value.id, gid, iid)));
      return el;
    }
    function paintNav() {
      if (!nav) return; nav.replaceChildren();
      for (const g of profile.groups) {
        const entry = button(groupSummary(g), () => {
          selectGroup(g.id);
          doc.getElementById?.(`library-${g.id}`)?.scrollIntoView?.({ behavior: "smooth", block: "start" });
        }, `resume-nav-btn${activeGroupId === g.id ? " is-active" : ""}`);
        entry.setAttribute("aria-expanded", String(activeGroupId === g.id));
        entry.setAttribute("aria-controls", `library-body-${g.id}`);
        nav.append(entry);
      }
    }
    function paint() {
      if (!body) return; body.replaceChildren(); groupToggles.clear();
      if (!profile.groups.length) body.append(make("p", "tip", "资料库为空。点击“新增分组”手动添加，或在下方粘贴 Markdown，用 AI 解析后批量保存。"));
      for (const g of profile.groups) {
        const groupEl = make("section", "library-group custom-field-card"); groupEl.id = `library-${g.id}`;
        const expanded = activeGroupId === g.id;
        const toggle = button(`${expanded ? "▾" : "▸"} ${groupSummary(g)}`, () => selectGroup(expanded ? null : g.id), "library-group-toggle");
        toggle.setAttribute("aria-expanded", String(expanded)); toggle.setAttribute("aria-controls", `library-body-${g.id}`);
        groupToggles.set(g.id, toggle);
        const content = make("div", "library-group-body"); content.id = `library-body-${g.id}`; content.hidden = !expanded;
        groupEl.append(toggle, content); body.append(groupEl);
        // Build controls for the selected group only; drafts live in profile so
        // moving between groups never discards unsaved values.
        if (!expanded) continue;
        content.append(control("分组名称", g.name, (value) => g.name = value), actions(g, profile.groups));
        for (const i of g.items) {
          const itemEl = make("article", "library-item custom-field-card");
          itemEl.append(control("条目名称", i.name, (value) => i.name = value), actions(i, g.items, g.id));
          for (const f of i.fields) {
            const fieldEl = make("div", "library-field custom-field-card"), metadata = make("div", "custom-field-metadata");
            metadata.append(control("字段名称", f.name, (value) => f.name = value),
              control("匹配别名（逗号或换行分隔）", Array.isArray(f.aliases) ? f.aliases.join("，") : f.aliases, (value) => f.aliases = value),
              select("内容类型", f.type, [["text", "单行文本"], ["textarea", "多行文本"], ["date", "日期"]], (value) => f.type = value),
              select("时间含义", f.role, [["", "普通字段"], ["start", "开始时间"], ["end", "结束时间"]], (value) => f.role = value));
            fieldEl.append(metadata, control("内容", f.value, (value) => f.value = value, {
              multiline: f.type === "textarea" || /[\r\n]/.test(f.value),
              placeholder: f.type === "date" ? "YYYY、YYYY-MM、YYYY-MM-DD 或至今；每项只保存一个日期" : "填写已确认的信息",
            }), actions(f, i.fields, g.id, i.id)); itemEl.append(fieldEl);
          }
          itemEl.append(button("新增字段", () => addField(g.id, i.id), "btn btn-primary btn-sm")); content.append(itemEl);
        }
        content.append(button("新增条目", () => addItem(g.id), "btn btn-primary btn-sm"));
      }
      if (deleted) body.append(button("撤销最近一次删除", undo));
      paintNav();
    }
    function render(groups) {
      profile = schema.normalizeResumeProfile({ groups }); deleted = null; activeGroupId = null; section?.remove();
      section = make("section", "resume-section custom-fields-section");
      const head = make("div", "custom-field-head");
      head.append(make("h2", "resume-section-title", "我的资料库"), button("新增分组", addGroup, "btn btn-primary btn-sm"));
      status = make("p", "tip custom-fields-error"); status.setAttribute("role", "alert"); status.hidden = true;
      body = make("div", "custom-fields-body");
      section.append(head, status, body);
      host.append(section); paint();
    }
    function validate() {
      const error = schema.validateProfile(schema.normalizeResumeProfile(profile));
      if (error) {
        const invalid = profile.groups.find((g) => schema.validateProfile({ groups: [g] }));
        if (invalid) selectGroup(invalid.id);
      }
      if (status) { status.textContent = error; status.hidden = !error; }
      if (error) section?.scrollIntoView?.({ behavior: "smooth", block: "start" });
      return error;
    }
    return { render, collect, validate, addGroup, addItem, addField, mutate, undo, selectGroup };
  }
  return Object.freeze({ create });
});
