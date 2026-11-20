(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.ResumeCustomFieldsEditor = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  function create({ document: doc, host, nav, schema, onChange = () => {} }) {
    let profile = schema.createEmptyResumeProfile(), section, body, status, deleted, activeGroupId = null, activeItemId = null;
    const groupToggles = new Map(), itemToggles = new Map(), expandedItems = new Set();
    const make = (tag, cls, text) => { const el = doc.createElement(tag); if (cls) el.className = cls; if (text !== undefined) el.textContent = text; return el; };
    const button = (text, action, cls = "btn btn-outline btn-sm") => { const el = make("button", cls, text); el.type = "button"; el.addEventListener("click", action); return el; };
    function groupSummary(g) {
      const filled = g.items.flatMap((i) => i.fields).filter((f) => f.value.trim()).length;
      return `${g.name || "未命名分组"} · ${filled} 项`;
    }
    const itemKey = (gid, iid) => `${gid}/${iid}`;
    const itemSummary = (i) => `${i.name || "未命名条目"}（${i.fields.length} 个字段）`;
    function scrollTo(id) { doc.getElementById?.(id)?.scrollIntoView?.({ behavior: "smooth", block: "start" }); }
    function changed() {
      if (status) { status.textContent = ""; status.hidden = true; }
      for (const g of profile.groups) {
        const toggle = groupToggles.get(g.id);
        if (toggle) toggle.textContent = `${activeGroupId === g.id ? "▾" : "▸"} ${groupSummary(g)}`;
        for (const i of g.items) {
          const key = itemKey(g.id, i.id), itemToggle = itemToggles.get(key);
          if (itemToggle) itemToggle.textContent = `${expandedItems.has(key) ? "▾" : "▸"} ${itemSummary(i)}`;
        }
      }
      paintNav(); onChange();
    }
    function group(id) { return profile.groups.find((g) => g.id === id); }
    function item(gid, iid) { return group(gid)?.items.find((i) => i.id === iid); }
    function selectGroup(id) { if (id !== null && !group(id)) return; activeGroupId = id; activeItemId = null; paint(); }
    function selectItem(gid, iid, { scrollIntoView = false } = {}) {
      if (!item(gid, iid)) return;
      activeGroupId = gid; activeItemId = iid; expandedItems.add(itemKey(gid, iid)); paint();
      if (scrollIntoView) scrollTo(`library-item-${iid}`);
    }
    function toggleItem(gid, iid) {
      const key = itemKey(gid, iid);
      if (!expandedItems.has(key)) { selectItem(gid, iid); return; }
      expandedItems.delete(key); if (activeItemId === iid) activeItemId = null; paint();
    }
    function addGroup() { const g = schema.createGroup(); profile.groups.push(g); activeGroupId = g.id; activeItemId = null; paint(); changed(); return g.id; }
    function addItem(gid) {
      const g = group(gid); if (!g) return;
      const i = schema.createItem(); g.items.push(i); selectItem(gid, i.id, { scrollIntoView: true }); changed(); return i.id;
    }
    function addField(gid, iid) {
      const target = item(gid, iid); if (!target) return;
      const f = schema.createField(); target.fields.push(f); selectItem(gid, iid); changed(); return f.id;
    }
    function listFor(gid, iid) { return iid ? item(gid, iid)?.fields : gid ? group(gid)?.items : profile.groups; }
    function mutate(action, id, gid, iid, offset) {
      const list = listFor(gid, iid), index = list?.findIndex((v) => v.id === id);
      if (!(index >= 0)) return;
      if (action === "remove") {
        deleted = { list, index, value: list[index], groupId: gid || id, itemId: gid ? iid || id : null }; list.splice(index, 1);
        if (!gid && activeGroupId === id) { activeGroupId = null; activeItemId = null; }
        if (gid && !iid && activeItemId === id) activeItemId = null;
      }
      if (action === "duplicate") {
        const source = list[index], create = iid ? schema.createField : gid ? schema.createItem : schema.createGroup;
        const copy = create({ ...source, name: `${source.name} 副本` });
        list.splice(index + 1, 0, copy);
        activeGroupId = gid || copy.id;
        activeItemId = gid ? iid || copy.id : null;
        if (activeItemId) expandedItems.add(itemKey(activeGroupId, activeItemId));
      }
      if (action === "move") {
        const next = index + offset; if (next < 0 || next >= list.length) return;
        const [value] = list.splice(index, 1); list.splice(next, 0, value);
      }
      paint(); changed();
    }
    function undo() {
      if (!deleted) return;
      deleted.list.splice(deleted.index, 0, deleted.value); activeGroupId = deleted.groupId; activeItemId = deleted.itemId;
      if (activeItemId) expandedItems.add(itemKey(activeGroupId, activeItemId));
      deleted = null; paint(); changed();
    }
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
        const expanded = activeGroupId === g.id;
        const branch = make("div", "library-nav-group"), row = make("div", "library-nav-group-row");
        const toggle = button(expanded ? "▾" : "▸", () => selectGroup(expanded ? null : g.id), "library-nav-toggle");
        toggle.setAttribute("aria-label", `${expanded ? "收起" : "展开"}${g.name || "未命名分组"}`);
        toggle.setAttribute("aria-expanded", String(expanded)); toggle.setAttribute("aria-controls", `library-nav-items-${g.id}`);
        const entry = button(groupSummary(g), () => {
          selectGroup(g.id);
          scrollTo(`library-${g.id}`);
        }, `resume-nav-btn${expanded && !activeItemId ? " is-active" : ""}`);
        entry.setAttribute("aria-expanded", String(expanded));
        entry.setAttribute("aria-controls", `library-body-${g.id}`);
        row.append(toggle, entry);
        const children = make("div", "library-nav-items"); children.id = `library-nav-items-${g.id}`; children.hidden = !expanded;
        for (const i of g.items) {
          const selected = expanded && activeItemId === i.id;
          const child = button(itemSummary(i), () => selectItem(g.id, i.id, { scrollIntoView: true }), `resume-nav-btn library-nav-item${selected ? " is-active" : ""}`);
          child.setAttribute("aria-expanded", String(expanded && expandedItems.has(itemKey(g.id, i.id))));
          child.setAttribute("aria-controls", `library-item-body-${i.id}`);
          if (selected) child.setAttribute("aria-current", "true");
          children.append(child);
        }
        branch.append(row, children); nav.append(branch);
      }
    }
    function paint() {
      if (!body) return; body.replaceChildren(); groupToggles.clear(); itemToggles.clear();
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
          const itemEl = make("article", "library-item custom-field-card"); itemEl.id = `library-item-${i.id}`;
          const key = itemKey(g.id, i.id), itemExpanded = expandedItems.has(key);
          const itemToggle = button(`${itemExpanded ? "▾" : "▸"} ${itemSummary(i)}`, () => toggleItem(g.id, i.id), "library-item-toggle");
          itemToggle.setAttribute("aria-expanded", String(itemExpanded)); itemToggle.setAttribute("aria-controls", `library-item-body-${i.id}`);
          itemToggles.set(key, itemToggle);
          const itemBody = make("div", "library-item-body"); itemBody.id = `library-item-body-${i.id}`; itemBody.hidden = !itemExpanded;
          itemEl.append(itemToggle, itemBody); content.append(itemEl);
          if (!itemExpanded) continue;
          itemBody.append(control("条目名称", i.name, (value) => i.name = value), actions(i, g.items, g.id));
          for (const f of i.fields) {
            const fieldEl = make("div", "library-field custom-field-card"), metadata = make("div", "custom-field-metadata");
            metadata.append(control("字段名称", f.name, (value) => f.name = value),
              control("匹配别名（逗号或换行分隔）", Array.isArray(f.aliases) ? f.aliases.join("，") : f.aliases, (value) => f.aliases = value),
              select("内容类型", f.type, [["text", "单行文本"], ["textarea", "多行文本"], ["date", "日期"]], (value) => f.type = value),
              select("时间含义", f.role, [["", "普通字段"], ["start", "开始时间"], ["end", "结束时间"]], (value) => f.role = value));
            fieldEl.append(metadata, control("内容", f.value, (value) => f.value = value, {
              multiline: f.type === "textarea" || /[\r\n]/.test(f.value),
              placeholder: f.type === "date" ? "YYYY、YYYY-MM、YYYY-MM-DD 或至今；每项只保存一个日期" : "填写已确认的信息",
            }), actions(f, i.fields, g.id, i.id)); itemBody.append(fieldEl);
          }
          itemBody.append(button("新增字段", () => addField(g.id, i.id), "btn btn-primary btn-sm"));
        }
        content.append(button("新增条目", () => addItem(g.id), "btn btn-primary btn-sm"));
      }
      if (deleted) body.append(button("撤销最近一次删除", undo));
      paintNav();
    }
    function render(groups, { preserveState = false } = {}) {
      profile = schema.normalizeResumeProfile({ groups }); deleted = null;
      if (!preserveState) { activeGroupId = null; activeItemId = null; expandedItems.clear(); }
      else {
        const valid = new Set(profile.groups.flatMap((g) => g.items.map((i) => itemKey(g.id, i.id))));
        for (const key of expandedItems) if (!valid.has(key)) expandedItems.delete(key);
        if (!group(activeGroupId)) activeGroupId = null;
        if (!item(activeGroupId, activeItemId)) activeItemId = null;
      }
      section?.remove();
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
        if (invalid) {
          const invalidItem = invalid.name.trim() && invalid.items.find((i) => schema.validateProfile({ groups: [{ ...invalid, items: [i] }] }));
          if (invalidItem) selectItem(invalid.id, invalidItem.id, { scrollIntoView: true });
          else selectGroup(invalid.id);
        }
      }
      if (status) { status.textContent = error; status.hidden = !error; }
      if (error) section?.scrollIntoView?.({ behavior: "smooth", block: "start" });
      return error;
    }
    return { render, collect, validate, addGroup, addItem, addField, mutate, undo, selectGroup, selectItem };
  }
  return Object.freeze({ create });
});
