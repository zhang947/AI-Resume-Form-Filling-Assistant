(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.ResumeLookupMatcher = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
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
  function buildIndex(profile, schema) {
    return Array.from(schema?.getFieldCatalog?.({ profile }) || []).flatMap((field) => {
      const inferred = ruleFor(field.label);
      const roleKey = field.role === "start" ? "startDate" : field.role === "end" ? "endDate" : null;
      const aliasDates = new Set((field.aliases || []).flatMap((alias) => {
        const keys = ruleFor(alias)?.keys || [];
        return keys.length === 1 && ["startDate", "endDate"].includes(keys[0]) ? keys : [];
      }));
      const aliasDateKey = field.input === "date" && aliasDates.size === 1 ? [...aliasDates][0] : null;
      const item = candidate({ id: `field:${field.path}`, section: scopeFor(field.sectionLabel)?.[0] || "customFields",
        key: roleKey || (inferred?.keys.length === 1 ? inferred.keys[0] : aliasDateKey || field.label), label: field.label,
        source: [field.sectionLabel, field.itemLabel].filter(Boolean).join(" · "), value: schema.getValueByPath(profile, field.path) });
      return item ? [{ ...item, aliases: field.aliases, role: field.role }] : [];
    });
  }
  function uniqueCandidates(items) {
    const seen = new Set();
    return items.filter((item) => {
      // Scope by stable group/item IDs, not display names. Compare the full
      // value, and keep start/end dates separate even when both dates agree.
      const fieldOffset = item.id.indexOf(".fields.");
      if (fieldOffset < 0) return true;
      const dateRole = ["startDate", "endDate"].includes(item.key) ? item.key : "";
      const identity = JSON.stringify([item.id.slice(0, fieldOffset), dateRole, item.copyValue.replace(/\r\n?/g, "\n")]);
      if (seen.has(identity)) return false;
      seen.add(identity);
      return true;
    });
  }
  function match(index, selectedText, context = "") {
    const query = normalize(selectedText), rule = ruleFor(query);
    if (!query) return [];
    const sections = rule?.sections || scopeFor(selectedText) || scopeFor(context);
    const found = index.filter((item) => {
      const exact = [item.label, ...(item.aliases || [])].some((alias) => normalize(alias) === query);
      if (rule && ["startDate", "endDate"].some((v) => rule.keys.includes(v))) {
        if (!rule.keys.includes(item.key)) return false;
        return !sections || sections.includes(item.section) || (item.section === "customFields" && exact);
      }
      return exact || Boolean(rule && (!sections || sections.includes(item.section) || item.section === "customFields") && rule.keys.includes(item.key));
    });
    if (rule?.keys.includes("startDate") && rule.keys.includes("endDate")) {
      const itemId = (entry) => entry.id.split(".fields.")[0];
      found.sort((a, b) => itemId(a) === itemId(b) ? (a.key === "startDate" ? 0 : 1) - (b.key === "startDate" ? 0 : 1) : 0);
    }
    return uniqueCandidates(found);
  }
  function search(index, text) {
    const query = normalize(text);
    return uniqueCandidates(index.filter((item) => !query || normalize(`${item.sourceName}\n${(item.aliases || []).join(" ")}\n${item.copyValue}`).includes(query)));
  }

  return Object.freeze({ normalize, ruleFor, buildIndex, match, search });
});
