(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.ResumeLookupMatcher = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const EXPERIENCE_SECTIONS = ["educations", "internships", "workExperiences", "projects", "campusExperiences"];
  const RULES = [
    { aliases: ["学校名称", "毕业院校", "就读学校", "院校名称", "学校", "school", "university"], sections: ["educations"], keys: ["school"] },
    { aliases: ["就读年月", "在校时间", "就读时间", "教育时间", "教育经历时间"], sections: ["educations"], keys: ["startDate", "endDate"] },
    { aliases: ["项目时间", "项目起止时间"], sections: ["projects"], keys: ["startDate", "endDate"] },
    { aliases: ["实习时间", "实习起止时间"], sections: ["internships"], keys: ["startDate", "endDate"] },
    { aliases: ["工作时间", "任职时间", "在职时间"], sections: ["workExperiences"], keys: ["startDate", "endDate"] },
    { aliases: ["入学时间", "入学日期", "入学年月"], sections: ["educations"], keys: ["startDate"] },
    { aliases: ["毕业时间", "毕业日期", "毕业年月"], sections: ["educations"], keys: ["endDate"] },
    { aliases: ["开始时间", "开始日期", "起始日期", "起始时间", "起始年月", "开始年月", "startdate", "starttime"], keys: ["startDate"] },
    { aliases: ["结束时间", "结束日期", "截止时间", "截止日期", "结束年月", "enddate", "endtime"], keys: ["endDate"] },
    { aliases: ["起止时间", "起止日期", "起止年月", "时间范围"], keys: ["startDate", "endDate"] },
    { aliases: ["项目名称", "项目名"], sections: ["projects"], keys: ["name"] },
    { aliases: ["项目内容", "项目描述", "项目介绍", "项目说明", "项目简介"], sections: ["projects"], keys: ["description"] },
    { aliases: ["实习内容", "实习描述", "实习职责"], sections: ["internships"], keys: ["description"] },
    { aliases: ["工作内容", "工作描述", "岗位职责"], sections: ["workExperiences", "internships"], keys: ["description"] },
    { aliases: ["自我评价", "自我评估", "selfevaluation"], sections: ["personal", "additional"], keys: ["summary", "selfEvaluation"] },
    { aliases: ["自我介绍", "个人简介"], sections: ["personal"], keys: ["summary"] },
    { aliases: ["姓名", "真实姓名", "中文姓名", "fullname"], sections: ["personal"], keys: ["fullName"] },
    { aliases: ["联系电话", "手机号码", "手机号", "移动电话"], sections: ["personal"], keys: ["phoneNumber"] },
    { aliases: ["电子邮箱", "电子邮件", "邮箱", "email"], sections: ["personal"], keys: ["email"] },
    { aliases: ["学历", "学位", "学历层次"], sections: ["educations"], keys: ["degree"] },
    { aliases: ["所学专业", "专业名称", "专业"], sections: ["educations"], keys: ["major"] },
  ];
  function normalize(text) {
    return String(text ?? "").normalize("NFKC").toLowerCase()
      .replace(/\(?必填\)?|\(?required\)?/gi, "")
      .replace(/[\s*＊✱✳※:：]/g, "").replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, "");
  }
  function scopeFor(text) {
    if (/项目|project/i.test(text)) return ["projects"];
    if (/实习|internship/i.test(text)) return ["internships"];
    if (/教育|就读|在校|入学|毕业|院校|学校|education/i.test(text)) return ["educations"];
    if (/校园|社团|学生组织|志愿|campus/i.test(text)) return ["campusExperiences"];
    if (/工作经历|任职|工作时间|employment|work experience/i.test(text)) return ["workExperiences"];
    return null;
  }
  const SORTED_ALIASES = RULES.flatMap((rule) => rule.aliases.map((alias) => ({ rule, alias: normalize(alias) })))
    .sort((a, b) => b.alias.length - a.alias.length);
  function ruleFor(text) {
    const query = normalize(text);
    if (!query) return null;
    if (/开始.*结束|起始.*截止/.test(query)) return { keys: ["startDate", "endDate"] };
    return SORTED_ALIASES.find(({ alias }) => query === alias)?.rule ||
      SORTED_ALIASES.find(({ alias }) => alias.length >= 4 && query.length <= alias.length + 6 && query.includes(alias))?.rule || null;
  }
  function valueText(value) {
    if (typeof value === "string") return value;
    if (typeof value === "number") return String(value);
    if (typeof value === "boolean") return value ? "是" : "否";
    if (Array.isArray(value)) return value.map(valueText).filter(Boolean).join("\n");
    return "";
  }
  function candidate({ id, section, key, label, source, value, format = "字段" }) {
    let copyValue = valueText(value);
    if (!copyValue.trim()) return null;
    if (["startDate", "endDate"].includes(key)) copyValue = copyValue.trim();
    return { id, section, key, label, sourceName: `${source} · ${label}`, format,
      preview: copyValue.length > 160 ? `${copyValue.slice(0, 160)}…` : copyValue, copyValue };
  }
  function sourceName(section, item, index, fallback) {
    if (section === "educations") return [item.school, item.degree].filter(Boolean).join(" · ") || `${fallback} ${index + 1}`;
    return item.name || item.company || item.organization || `${fallback} ${index + 1}`;
  }
  function buildIndex(profile, schema) {
    const items = [];
    for (const section of schema?.sections || []) {
      const records = section.type === "list" ? (Array.isArray(profile?.[section.key]) ? profile[section.key] : []) : [profile?.[section.key]];
      records.forEach((record, index) => {
        if (!record || typeof record !== "object") return;
        const source = section.type === "list" ? sourceName(section.key, record, index, section.label) : section.label;
        for (const field of section.fields) {
          const item = candidate({ id: `field:${section.key}:${index}:${field.key}`, section: section.key, key: field.key,
            label: field.label, source, value: record[field.key] });
          if (item) items.push(item);
        }
      });
    }
    for (const section of ["personal", "additional"]) {
      if (profile?.[section]?.selfEvaluation) {
        const item = candidate({ id: `field:${section}:selfEvaluation`, section, key: "selfEvaluation", label: "自我评价",
          source: section === "personal" ? "个人信息" : "补充信息", value: profile[section].selfEvaluation });
        if (item) items.push(item);
      }
    }
    for (const field of schema?.getCustomFieldCatalog?.(profile) || []) {
      const item = candidate({ id: `field:${field.path}`, section: "customFields", key: field.customId,
        label: field.label, source: field.group || "自定义信息", value: schema.getValueByPath(profile, field.path) });
      if (item) items.push({ ...item, aliases: field.aliases });
    }
    return items;
  }
  function match(index, selectedText, context = "") {
    const query = normalize(selectedText), rule = ruleFor(query);
    if (!query) return [];
    const sections = rule ? rule.sections || scopeFor(selectedText) || scopeFor(context) || EXPERIENCE_SECTIONS : [];
    return index.filter((item) => {
      if (item.section === "customFields") return [item.label, ...(item.aliases || [])].some((alias) => normalize(alias) === query);
      return rule ? sections.includes(item.section) && rule.keys.includes(item.key) : normalize(item.label) === query;
    });
  }
  function search(index, text) {
    const query = normalize(text);
    return index.filter((item) => !query || normalize(`${item.sourceName}\n${(item.aliases || []).join(" ")}\n${item.copyValue}`).includes(query));
  }

  return Object.freeze({ normalize, ruleFor, buildIndex, match, search });
});
