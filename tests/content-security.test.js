const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const plan = require("../shared/form-plan.js");

test("page URLs sent to the model exclude query and hash",()=>{
  const source = fs.readFileSync("content.js","utf8");
  const snippet = source.slice(source.indexOf("  function sanitizePageUrl("),source.indexOf("  function normalizeCheckboxCandidates("));
  const context={URL}; vm.createContext(context); vm.runInContext(snippet,context);
  assert.equal(context.sanitizePageUrl("https://example.com/app?token=secret#section"),"https://example.com/app");
});

test("only scanned field IDs survive and duplicate answers require attention",()=>{
  const result = plan.normalizeAnswers([
    {fieldId:"outside",source:"extracted",value:"A",evidence:["A"]},
    {fieldId:"f1",source:"extracted",value:"A",evidence:["A"]},
    {fieldId:"f1",source:"extracted",value:"B",evidence:["B"]},
  ],[{fieldId:"f1",kind:"text"},{fieldId:"f2",kind:"text"}],"AB");
  assert.equal(result.length,2); assert.ok(result.every((r)=>r.source === "missing"));
});

test("fabricated citations and mislabeled factual values are rejected",()=>{
  const fields=[{fieldId:"f1",kind:"text",label:"身份证"}];
  for (const answer of [
    {source:"generated",value:"123",evidence:["姓名张三"]},
    {source:"extracted",value:"123",evidence:["不存在的引用"]},
    {source:"extracted",value:"123",evidence:["姓名张三"]},
    {source:"derived",value:"123",evidence:["姓名张三"]}
  ]) assert.equal(plan.normalizeAnswers([{fieldId:"f1",...answer}],fields,"姓名张三")[0].source,"missing");
});
