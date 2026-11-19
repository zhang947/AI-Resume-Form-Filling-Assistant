const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
test("Markdown content flow does not read or persist old mapping caches",()=>{
 const content=fs.readFileSync("content.js","utf8");
 assert.doesNotMatch(content,/chrome\.storage|resumePath|resumeProfile|loadMappingCacheEntry/);
});
