(function (root) {
  "use strict";
  if (root.ResumeSchema?.version >= 7) return;
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const text = (value) => String(value ?? "").trim();
  function makeId(prefix) {
    return `${prefix}-${root.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`;
  }
  function aliases(value, name = "") {
    const key = (value) => text(value).normalize("NFKC").toLowerCase().replace(/[\s*＊:：]/g, "");
    const seen = new Set([key(name)]), result = [];
    for (const alias of (Array.isArray(value) ? value : String(value || "").split(/[,，;；、\n]/)).map(text)) {
      const normalized = key(alias);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized); result.push(alias);
    }
    return result;
  }
  function normalizeDateValue(value) {
    const raw = text(value), match = raw.match(/^(\d{4})(?:[-/.年](\d{1,2})(?:[-/.月](\d{1,2})日?)?月?)?$/);
    if (!match) return raw;
    return [match[1], ...match.slice(2).filter(Boolean).map((part) => part.padStart(2, "0"))].join("-");
  }
  function normalizeResumeProfile(value) {
    const seen = new Set();
    function id(raw, prefix, fallback) {
      let next = new RegExp(`^${prefix}-[a-z0-9-]+$`).test(raw) && !seen.has(raw) ? raw : `${prefix}-import-${fallback}`;
      while (seen.has(next)) next += "-copy";
      seen.add(next); return next;
    }
    const groups = Array.isArray(value?.groups) ? value.groups : [];
    return { groups: groups.filter((v) => v && typeof v === "object").map((group, g) => ({
      id: id(group.id, "g", `${g}`), name: text(group.name),
      items: (Array.isArray(group.items) ? group.items : []).filter((v) => v && typeof v === "object").map((item, i) => ({
        id: id(item.id, "i", `${g}-${i}`), name: text(item.name),
        fields: (Array.isArray(item.fields) ? item.fields : []).filter((v) => v && typeof v === "object").map((field, f) => {
          const type = ["text", "textarea", "date"].includes(field.type) ? field.type : "text";
          return { id: id(field.id, "f", `${g}-${i}-${f}`), name: text(field.name), aliases: aliases(field.aliases, field.name), type,
            value: type === "date" ? normalizeDateValue(field.value) : String(field.value ?? ""),
            role: ["start", "end"].includes(field.role) ? field.role : "" };
        }),
      })),
    })) };
  }
  function createField(value = {}) { return normalizeResumeProfile({ groups: [{ items: [{ fields: [{ ...value, id: makeId("f") }] }] }] }).groups[0].items[0].fields[0]; }
  function createItem(value = {}) { return { id: makeId("i"), name: text(value.name), fields: (value.fields || []).map(createField) }; }
  function createGroup(value = {}) { return { id: makeId("g"), name: text(value.name), items: (value.items || []).map(createItem) }; }
  function resolveField(profile, path) {
    const parts = String(path || "").split(".");
    if (parts.length !== 7 || parts[0] !== "groups" || parts[2] !== "items" || parts[4] !== "fields" || parts[6] !== "value") return null;
    return profile?.groups?.find((g) => g.id === parts[1])?.items?.find((i) => i.id === parts[3])?.fields?.find((f) => f.id === parts[5]) || null;
  }
  function getValueByPath(profile, path) { return resolveField(profile, path)?.value ?? ""; }
  function setValueByPath(profile, path, value) { const field = resolveField(profile, path); if (field) field.value = String(value ?? ""); }
  function getFieldCatalog(options = {}) {
    const profile = options.profile || (Array.isArray(options.groups) ? options : null);
    return (profile?.groups || []).flatMap((group) => (group.items || []).flatMap((item) => (item.fields || []).map((field) => ({
      path: `groups.${group.id}.items.${item.id}.fields.${field.id}.value`,
      sectionKey: group.id, sectionLabel: group.name, itemLabel: item.name, label: field.name,
      aliases: aliases(field.aliases, field.name), input: field.type, role: field.role || "", options: [], placeholder: "",
    }))));
  }
  function getCatalogWithValues(profile) {
    return getFieldCatalog({ profile }).map((field) => {
      const value = getValueByPath(profile, field.path);
      return { ...field, value, hasValue: Boolean(text(value)), valuePreview: String(value).slice(0, 160) };
    });
  }
  function validateProfile(profile) {
    for (const group of profile?.groups || []) {
      if (!text(group.name)) return "请填写分组名称";
      for (const item of group.items || []) {
        if (!text(item.name)) return `“${group.name}”中有条目缺少名称`;
        for (const field of item.fields || []) {
          if (!text(field.name)) return `“${item.name}”中有字段缺少名称`;
          if (field.type !== "textarea" && /[\r\n]/.test(field.value)) return `“${field.name}”包含换行，请选择多行文本`;
          if (field.type === "date" && text(field.value)) {
            const date = normalizeDateValue(field.value), match = date.match(/^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/);
            if (date === "至今") continue;
            if (!match || Number(match[1]) < 1 || (match[2] && (+match[2] < 1 || +match[2] > 12)) ||
              (match[3] && (+match[3] < 1 || +match[3] > new Date(+match[1], +match[2], 0).getDate()))) return `“${field.name}”请输入一个有效日期：YYYY、YYYY-MM、YYYY-MM-DD 或至今`;
          }
        }
      }
    }
    return "";
  }
  root.ResumeSchema = Object.freeze({ version: 7, sections: Object.freeze([]),
    createEmptyResumeProfile: () => ({ groups: [] }), normalizeResumeProfile, createGroup, createItem, createField,
    getFieldCatalog, getCatalogWithValues, getValueByPath, setValueByPath, validateProfile, normalizeDateValue, normalizeAliases: aliases,
    hasAnyFilledField: (profile) => getCatalogWithValues(profile).some((field) => field.hasValue),
    getCustomFieldsFingerprint: (profile) => JSON.stringify(normalizeResumeProfile(profile)),
    createImportTemplateString: () => JSON.stringify({ groups: [] }, null, 2),
    getSectionDefinition: () => null, createEmptyListItem: () => ({}), clone,
  });
})(typeof window !== "undefined" ? window : globalThis);
