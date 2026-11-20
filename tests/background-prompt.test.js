const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("field mapping prompt uses saved dynamic paths and conservative mapping constraints", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../background.js"),
    "utf8"
  );

  assert.match(source, /groups\.\*/);
  assert.doesNotMatch(source, /internships\.\*|campusExperiences\.\*|educations\.\*/);
  assert.match(source, /不得假定固定分类或路径/);
  assert.match(source, /没有实习经历/);
  assert.match(source, /hasValue=true/);
  assert.match(source, /sectionLabel/);
  assert.match(source, /nearbyLabels/);
});
