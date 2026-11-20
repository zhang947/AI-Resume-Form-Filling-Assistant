(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.ResumeCustomFieldsEditor = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  function create({ document: doc = document, host, nav, schema, onChange = () => {} }) {
    let fields = [], section = null, body = null, status = null, navButton = null, undoButton = null, deleted = null;
    const controls = new Map();
    const make = (tag, className, text) => {
      const node = doc.createElement(tag); if (className) node.className = className;
      if (text !== undefined) node.textContent = text; return node;
    };
    function button(text, action, className = "btn btn-outline btn-sm") {
      const node = make("button", className, text); node.type = "button";
      node.addEventListener("click", action); return node;
    }
    function refreshNav() {
      if (!navButton) return;
      const filled = fields.filter((field) => field.name.trim() && field.value.trim()).length;
      navButton.textContent = `自定义信息 ${filled}/${fields.length}`;
      navButton.className = `resume-nav-btn${filled ? " has-value" : ""}`;
    }
    function changed() { if (status) { status.textContent = ""; status.hidden = true; } refreshNav(); onChange(); }
    function collect() { return schema.normalizeCustomFields(fields); }
    function add() {
      const field = schema.createCustomField(); fields.push(field); paint(); changed(); controls.get(field.id)?.name.focus?.(); return field.id;
    }
    function duplicate(id) {
      const index = fields.findIndex((field) => field.id === id); if (index < 0) return;
      const copy = schema.createCustomField({ ...fields[index], name: fields[index].name ? `${fields[index].name} 副本` : "" });
      fields.splice(index + 1, 0, copy); paint(); changed(); return copy.id;
    }
    function remove(id) {
      const index = fields.findIndex((field) => field.id === id); if (index < 0) return;
      deleted = { field: fields[index], index }; fields.splice(index, 1); paint(); changed();
    }
    function undo() {
      if (!deleted) return;
      fields.splice(Math.min(deleted.index, fields.length), 0, deleted.field); deleted = null; paint(); changed();
    }
    function move(id, offset) {
      const index = fields.findIndex((field) => field.id === id), next = index + offset;
      if (index < 0 || next < 0 || next >= fields.length) return;
      const [field] = fields.splice(index, 1); fields.splice(next, 0, field); paint(); changed();
    }
    function labelControl(label, control) {
      const wrapper = make("label", "custom-field-control"), title = make("span", "resume-field-label", label);
      wrapper.append(title, control); return wrapper;
    }
    function paint() {
      if (!body) return;
      controls.clear(); body.replaceChildren(); undoButton.hidden = !deleted;
      if (!fields.length) body.appendChild(make("p", "tip", "还没有自定义信息。点击“新增信息”，保存名称、内容及匹配别名。"));
      fields.forEach((field, index) => {
        const card = make("article", "custom-field-card"); card.dataset.customFieldId = field.id;
        const head = make("div", "custom-field-head"), heading = make("strong", "custom-field-title");
        const refreshHeading = () => { heading.textContent = `${field.group.trim() || "未分组"} · ${field.name.trim() || "未命名信息"}`; };
        refreshHeading();
        const actions = make("div", "custom-field-actions");
        const up = button("上移", () => move(field.id, -1)), down = button("下移", () => move(field.id, 1));
        up.disabled = index === 0; down.disabled = index === fields.length - 1;
        actions.append(up, down, button("复制条目", () => duplicate(field.id)), button("删除", () => remove(field.id)));
        head.append(heading, actions); card.appendChild(head);
        const metadata = make("div", "custom-field-metadata"), refs = {};
        for (const [key, label, placeholder] of [["name", "信息名称", "例如：苏州银行应聘理由"], ["group", "所属分组（可选）", "例如：银行求职"], ["aliases", "匹配别名（可选）", "多个别名用逗号、分号或换行分隔"]]) {
          const input = make(key === "aliases" ? "textarea" : "input", key === "aliases" ? "resume-textarea" : "resume-input");
          if (key === "aliases") input.rows = 2; else input.type = "text";
          input.placeholder = placeholder;
          input.value = key === "aliases" ? (Array.isArray(field.aliases) ? field.aliases.join("，") : field.aliases) : field[key];
          input.dataset.customProperty = key; input.required = key === "name";
          input.addEventListener("input", () => { field[key] = input.value; refreshHeading(); changed(); });
          metadata.appendChild(labelControl(label, input)); refs[key] = input;
        }
        const type = make("select", "resume-select"); type.dataset.customProperty = "type";
        for (const [value, label] of [["text", "单行文本"], ["textarea", "多行文本"], ["date", "日期"]]) {
          const option = make("option", "", label); option.value = value; type.appendChild(option);
        }
        type.value = field.type;
        type.addEventListener("change", () => { field.type = type.value; paint(); changed(); });
        metadata.appendChild(labelControl("内容类型", type)); refs.type = type;
        card.appendChild(metadata);
        // Use a textarea for imported multiline data even if its type needs correcting;
        // never silently strip line breaks by assigning it to a single-line input.
        const multiline = field.type === "textarea" || /[\r\n]/.test(field.value);
        const value = make(multiline ? "textarea" : "input", multiline ? "resume-textarea" : "resume-input");
        if (multiline) value.rows = 6; else value.type = "text";
        value.dataset.customProperty = "value"; value.value = field.value;
        value.placeholder = field.type === "date" ? "YYYY、YYYY-MM、YYYY-MM-DD 或至今，每条信息仅保存一个日期" : "填写已确认的资料；候选只复制这里的内容";
        value.addEventListener("input", () => { field.value = value.value; changed(); });
        card.appendChild(labelControl("信息内容", value)); refs.value = value;
        controls.set(field.id, refs); body.appendChild(card);
      });
      refreshNav();
    }
    function render(value) {
      fields = schema.normalizeCustomFields(value); deleted = null;
      section?.remove(); navButton?.remove();
      section = make("section", "resume-section custom-fields-section"); section.id = "resume-section-customFields"; section.dataset.sectionKey = "customFields";
      const head = make("div", "custom-field-head");
      const actions = make("div", "custom-field-actions"); undoButton = button("撤销删除", undo); undoButton.hidden = true;
      actions.append(button("新增信息", add, "btn btn-primary btn-sm"), undoButton);
      head.append(make("h2", "resume-section-title", "自定义信息"), actions);
      const note = make("p", "tip", "名称和别名用于匹配；分组用于区分用途。内容随当前简历模板保存，点击顶部“保存标准简历”后生效。");
      status = make("p", "tip custom-fields-error"); status.setAttribute("role", "alert"); status.hidden = true;
      body = make("div", "custom-fields-body");
      section.append(head, note, status, body); host.appendChild(section);
      if (nav) { navButton = button("自定义信息", () => section.scrollIntoView?.({ behavior: "smooth", block: "start" }), "resume-nav-btn"); navButton.dataset.resumeNav = "customFields"; nav.appendChild(navButton); }
      paint();
    }
    function validate() {
      const error = schema.validateCustomFields(fields);
      if (status) { status.textContent = error; status.hidden = !error; }
      if (error) {
        section?.scrollIntoView?.({ behavior: "smooth", block: "start" });
        const empty = fields.find((field) => !field.name.trim()); if (empty) controls.get(empty.id)?.name.focus?.();
      }
      return error;
    }
    return { render, collect, validate, add, duplicate, remove, undo, move };
  }
  return Object.freeze({ create });
});
