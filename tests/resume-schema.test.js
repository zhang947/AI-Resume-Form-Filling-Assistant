const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { loadSchema, plain, profileFor } = require("./library-fixture.cjs");
const schema = loadSchema();
test("the library starts with zero predefined groups, records or fields; legacy data is not normalized back in", () => {
  assert.deepEqual(plain(schema.createEmptyResumeProfile()), { groups: [] });
  assert.deepEqual(plain(schema.sections), []);
  assert.equal(schema.getFieldCatalog().length, 0);
  assert.deepEqual(plain(schema.normalizeResumeProfile({ personal: { fullName: "Legacy" }, customFields: [{ name: "old", value: "old" }] })), { groups: [] });
});
test("arbitrary content, aliases and multiline values survive normalization with stable IDs", () => {
  const profile = profileFor([{ name: "任意信息", aliases: " 网页别名，网页别名；第二别名 ", value: "第一行\n\n第三行\n", type: "textarea" }]);
  assert.deepEqual(plain(schema.normalizeResumeProfile(profile)), profile);
  assert.deepEqual(profile.groups[0].items[0].fields[0].aliases, ["网页别名", "第二别名"]);
  assert.equal(schema.getCatalogWithValues(profile)[0].value, "第一行\n\n第三行\n");
  profile.groups[0].items[0].fields[0].value = "";
  assert.equal(schema.hasAnyFilledField(profile), false);
});
test("date precision and explicit 至今 are preserved; ranges and invalid dates fail validation", () => {
  for (const value of ["2027", "2027/7", "2027-07-01", "至今"]) assert.equal(schema.validateProfile(profileFor([{ name: "日期", type: "date", value }])), "");
  for (const value of ["2027-02-30", "2027-99", "2027-07 至 2028-07"]) assert.ok(schema.validateProfile(profileFor([{ name: "日期", type: "date", value }])));
  assert.equal(profileFor([{ name: "日期", type: "date", value: "2027/7" }]).groups[0].items[0].fields[0].value, "2027-07");
  assert.equal(schema.getCatalogWithValues(profileFor([{ name: "日期", type: "date", value: "2027" }]))[0].value, "2027");
});
test("stable value paths survive rename/reorder; metadata, prototype and unknown paths cannot be written", () => {
  const profile = profileFor([{ name: "信息 A", value: "A" }, { name: "信息 B", value: "B" }]);
  const field = schema.getFieldCatalog({ profile })[0], original = field.path;
  profile.groups[0].name = "新分组"; profile.groups[0].items[0].fields.reverse();
  assert.equal(schema.getValueByPath(profile, original), "A");
  schema.setValueByPath(profile, original, "edited");
  assert.equal(schema.getValueByPath(profile, original), "edited");
  for (const path of [original.replace(/value$/, "name"), original.replace(/f-import-0-0-0/, "__proto__"), original.replace(/f-import-0-0-0/, "f-unknown"), "personal.email"]) {
    schema.setValueByPath(profile, path, "bad"); assert.equal(schema.getValueByPath(profile, path), "");
  }
  assert.equal(profile.groups[0].items[0].fields[1].name, "信息 A");
});
test("duplicate imported IDs are repaired without losing any content", () => {
  const profile = profileFor([{ id: "f-same", name: "a", value: "one" }, { id: "f-same", name: "b", value: "two" }, { id: "__proto__", name: "c", value: "three" }]);
  const fields = profile.groups[0].items[0].fields;
  assert.equal(new Set(fields.map((f) => f.id)).size, 3);
  assert.ok(fields.every((f) => /^f-[a-z0-9-]+$/.test(f.id)));
  assert.deepEqual(fields.map((f) => f.value), ["one", "two", "three"]);
});
