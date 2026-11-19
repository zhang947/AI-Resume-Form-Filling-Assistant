const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const { parseJsonFromAiText } = require("../shared/form-plan.js");
const popupParser = parseJsonFromAiText, editorParser = parseJsonFromAiText;

for (const [name, parseJsonFromAiText] of [
  ["popup", popupParser],
  ["resume-editor", editorParser],
]) {
  test(`${name} parser accepts JSON with trailing commas`, () => {
    const parsed = parseJsonFromAiText('{ "name": "陈嘉昊", "skills": ["React", "Node.js",], }');

    assert.equal(parsed.name, "陈嘉昊");
    assert.deepEqual(Array.from(parsed.skills), ["React", "Node.js"]);
  });

  test(`${name} parser extracts JSON before prose that contains braces`, () => {
    const parsed = parseJsonFromAiText(
      [
        "下面是整理后的 JSON：",
        '{ "name": "陈嘉昊", "city": "上海" }',
        "说明：字段 {additional.notes} 因原文缺失已留空。",
      ].join("\n")
    );

    assert.equal(parsed.name, "陈嘉昊");
    assert.equal(parsed.city, "上海");
  });
}
