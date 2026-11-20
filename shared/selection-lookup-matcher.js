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
  function buildIndex(profile, schema, markdown = "") {
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
    const markdownItems = markdownIndex(markdown);
    // Retain both representations when their source/value differ; suppress exact duplicates only.
    const seen = new Set(items.map((item) => `${item.section}\0${item.sourceName}\0${item.copyValue}`));
    for (const item of markdownItems) {
      const signature = `${item.section}\0${item.sourceName}\0${item.copyValue}`;
      if (!seen.has(signature)) { items.push(item); seen.add(signature); }
    }
    return items;
  }
  function match(index, selectedText, context = "") {
    const query = normalize(selectedText), rule = ruleFor(query);
    if (!query) return [];
    if (rule) {
      const sections = rule.sections || scopeFor(selectedText) || scopeFor(context) || EXPERIENCE_SECTIONS;
      return index.filter((item) => sections.includes(item.section) && rule.keys.includes(item.key));
    }
    return index.filter((item) => normalize(item.label) === query);
  }
  function search(index, text) {
    const query = normalize(text);
    return index.filter((item) => !query || normalize(`${item.sourceName}\n${item.copyValue}`).includes(query));
  }

  // Only parse explicit headings, key:value fields and tables. Never ask AI or
  // convert/save Markdown into the structured profile in this read-only feature.
  function markdownIndex(markdown) {
    const result = [], stack = [];
    const labels = { school: "学校名称", degree: "学历层次", name: "项目名称", description: "项目描述",
      startDate: "开始时间", endDate: "结束时间", selfEvaluation: "自我评价", summary: "个人简介" };
    let section = "markdown", record = {}, heading = "Markdown 资料", sequence = 0, pending = null;
    function flushField() {
      if (pending) { record[pending.key] = pending.value.join("\n"); pending = null; }
    }
    function flushRecord() {
      flushField();
      const source = sourceName(section, record, sequence, heading);
      // Time fields are deliberately adjacent, and never combine date ranges.
      const keys = Object.keys(record).filter((key) => !["startDate", "endDate"].includes(key));
      keys.push("startDate", "endDate");
      for (const key of keys) {
        const item = candidate({ id: `md:${sequence}:${key}`, section, key, label: labels[key] || key,
          source, value: record[key], format: "Markdown" });
        if (item) result.push(item);
      }
      record = {}; sequence++;
    }
    function fieldKey(label) {
      const rule = ruleFor(label);
      if (/^(自我评价|自我评估|selfevaluation)$/.test(normalize(label))) return "selfEvaluation";
      if (rule?.keys.length === 1) return rule.keys[0];
      if (/^(描述|内容|说明)$/.test(normalize(label))) return "description";
      return null;
    }
    const lines = String(markdown || "").replace(/\r\n/g, "\n").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i], title = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (title) {
        flushRecord();
        stack[Number(title[1].length) - 1] = title[2]; stack.length = title[1].length;
        heading = title[2]; section = scopeFor(stack.filter(Boolean).slice().reverse().join(" "))?.[0] || "markdown";
        // A descriptive heading names a verbatim text block for manual search.
        if (/自我评价/.test(heading)) { section = "additional"; pending = { key: "selfEvaluation", value: [] }; }
        else if (/个人简介|自我介绍/.test(heading)) { section = "personal"; pending = { key: "summary", value: [] }; }
        else {
          const rule = ruleFor(heading);
          if (rule?.keys.length === 1 && rule.keys[0] === "description") {
            if (rule.sections?.length === 1) section = rule.sections[0];
            pending = { key: "description", value: [] };
          }
        }
        continue;
      }
      if (line.includes("|") && /^\s*\|?\s*:?-{3}/.test(lines[i + 1] || "")) {
        flushRecord();
        const cells = (row) => row.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|"));
        const headers = cells(line);
        const tableScope = headers.map(ruleFor).find((rule) => rule?.sections?.length === 1)?.sections[0];
        if (tableScope) section = tableScope;
        i++;
        while ((lines[i + 1] || "").includes("|")) {
          const row = cells(lines[++i]);
          headers.forEach((label, n) => { const key = fieldKey(label); if (key) record[key] = row[n] || ""; });
          flushRecord();
        }
        continue;
      }
      const pair = line.match(/^\s*(?:[-+*]\s+)?(?:\*\*)?([^:：\n]{1,30}?)(?:\*\*)?\s*[:：]\s*(.*)$/);
      if (pair) {
        const label = pair[1].replace(/\*\*/g, ""), rule = ruleFor(label), key = fieldKey(label);
        if (key) {
          flushField();
          const nextSection = key === "selfEvaluation" ? "additional" : rule?.sections?.length === 1 ? rule.sections[0] : section;
          if (Object.hasOwn(record, key) || nextSection !== section) flushRecord();
          section = nextSection;
          if (["startDate", "endDate"].includes(key)) record[key] = pair[2];
          else pending = { key, value: [pair[2]] };
          continue;
        }
        if (rule?.keys.length === 2) {
          flushField();
          const range = pair[2].match(/^(\d{4}(?:[-/.年]\d{1,2})(?:月|(?:[-/.]\d{1,2}))?)\s*(?:至|到|~|～|—|–|-)\s*(至今|\d{4}(?:[-/.年]\d{1,2})(?:月|(?:[-/.]\d{1,2}))?)$/);
          if (range) {
            if (rule.sections && rule.sections[0] !== section) { flushRecord(); section = rule.sections[0]; }
            record.startDate = range[1]; record.endDate = range[2];
          }
          continue;
        }
      }
      if (pending) pending.value.push(line);
      else if (line.trim()) {
        const item = candidate({ id: `md:raw:${i}`, section: "markdown", key: "原文", label: "原文", source: heading, value: line, format: "Markdown" });
        if (item) result.push(item);
      }
    }
    flushRecord();
    return result;
  }
  return Object.freeze({ normalize, ruleFor, buildIndex, match, search, markdownIndex });
});
